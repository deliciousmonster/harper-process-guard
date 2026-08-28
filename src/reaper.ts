/**
 * Stops a component's child processes when the Harper that owns them goes away.
 *
 * This is the other end of the lifetime `bootstrap()` opens. The sweep repairs what a previous
 * boot left behind; this exists so there is less to repair, by stopping the children while
 * something still knows what they are.
 *
 * It runs as its own detached OS process, and has to. Harper's own shutdown cannot do this: a
 * worker thread has no hook that fires on node shutdown, `harper stop` sends one SIGTERM to the
 * main process and sweeps nothing under `pids/`, and a SIGKILL fires no handler at all. A
 * process outside the node is the only thing that can watch it die.
 *
 * SPAWNED, NEVER IMPORTED. A component runs it as
 * `node <package>/dist/reaper.js --...`. That is why it lives in the
 * package rather than being copied into each component: a copy per component drifts, and the
 * copy that drifted here reaped on liveness alone. It reaches its siblings by relative path,
 * which works because it is spawned from inside dist/; a bare specifier would not resolve from
 * a detached script.
 *
 * WHAT IT WILL NOT DO. It signals only a process it has grounds to believe is the one it was
 * given. Where the platform can identify a process it requires that identification. Where it
 * cannot, it falls back to the one pid it has first-hand knowledge of, the pid it watched
 * start, and never to a pid read from a file that anything could have rewritten. The rule is
 * deliberately weaker than the sweep's, because requiring identification everywhere would make
 * this refuse to act on macOS and leak a process on every stop, which is worse than the reuse
 * it would avoid.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { identificationCanAuthoriseSignal, identify, isAlive } from './identity.js';

/** How often the watched process is checked. */
const POLL_INTERVAL_MS = 1000;

/** How long a child gets after SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 5000;

export interface ReapTarget {
	/** The lock file naming this child, removed before it is signalled. */
	pidFile: string;
	/** The pid this reaper watched start. First-hand, unlike anything read from a file. */
	pid: number;
	/** Absolute path of the binary, so the child can be identified before it is signalled. */
	binaryPath: string;
}

export interface ReaperOptions {
	/** The process to watch. When it goes, the targets are stopped. */
	harperPid: number;
	targets: ReapTarget[];
	/**
	 * Where a replacement writes its pid. `harper restart` forks a new main process and exits
	 * the old one, which is a path on which the children should be KEPT for the replacement to
	 * adopt, so this waits for one before reaping.
	 */
	hdbPidFile?: string;
	/** How long to wait for that replacement. */
	restartGraceMs: number;
	/** This process's own lock, removed on the way out so a replacement can take one. */
	selfPidFile?: string;
	logFile?: string;
}

function log(options: ReaperOptions, message: string): void {
	const line = `${new Date().toISOString()} [reaper ${process.pid}] ${message}\n`;
	if (!options.logFile) return;
	try {
		const fd = openSync(options.logFile, 'a');
		try {
			writeSync(fd, line);
		} finally {
			// Closed by hand rather than left to exit: this process is killed, not returned from.
			closeSync(fd);
		}
	} catch {
		// A log that cannot be written must not stop the reaping, which is the job.
	}
}

function readPidFile(path: string): number | null {
	try {
		const pid = Number.parseInt(readFileSync(path, 'utf-8').trim().split('\n')[0], 10);
		return Number.isInteger(pid) ? pid : null;
	} catch {
		return null;
	}
}

function removeQuietly(path: string | undefined): void {
	if (!path) return;
	try {
		unlinkSync(path);
	} catch {
		// Absent is the outcome asked for.
	}
}

/**
 * Which candidates this may signal.
 *
 * Two sources, and they are not equally trustworthy. `pid` is what this process watched start
 * and has supervised since. `recorded` is whatever the lock file says now, which anything could
 * have written; a container's pid namespace restarts at 1 and a component's children land on
 * the same small numbers every boot, so a stale file naming a reused pid is routine rather than
 * theoretical.
 */
function targetsFor(options: ReaperOptions, target: ReapTarget, recorded: number | null): number[] {
	const candidates = [...new Set([recorded, target.pid])].filter(
		(candidate): candidate is number => candidate !== null && isAlive(candidate)
	);

	return candidates.filter((candidate) => {
		if (identificationCanAuthoriseSignal()) {
			const verdict = identify(candidate, target.binaryPath);
			if (verdict === 'match') return true;
			log(options, `${target.pidFile}: pid ${candidate} is not this process (${verdict}); left alone`);
			return false;
		}
		// No identification here. The watched pid is first-hand knowledge and the file is not.
		if (candidate === target.pid) return true;
		log(options, `${target.pidFile}: pid ${candidate} came from the file and cannot be identified here; left alone`);
		return false;
	});
}

/**
 * Stop one child.
 *
 * The lock is removed first, on purpose: a file naming a process that is being killed is worse
 * than no file, because a worker that reads it adopts a corpse and never retries, while a
 * worker that finds nothing spawns a replacement.
 */
export async function reapTarget(options: ReaperOptions, target: ReapTarget): Promise<void> {
	const recorded = readPidFile(target.pidFile);
	removeQuietly(target.pidFile);

	const targets = targetsFor(options, target, recorded);
	if (targets.length === 0) {
		log(options, `${target.pidFile}: nothing to stop`);
		return;
	}

	for (const pid of targets) {
		try {
			process.kill(pid, 'SIGTERM');
			log(options, `sent SIGTERM to ${pid} (${target.pidFile})`);
		} catch (error) {
			log(options, `could not SIGTERM ${pid}: ${(error as Error).message}`);
		}
	}

	const deadline = Date.now() + TERM_GRACE_MS;
	while (Date.now() < deadline && targets.some(isAlive)) await delay(100);

	// Escalation is confined to processes that were identified above, which is what makes it
	// defensible: SIGKILL on a pid this could not name would be the defect the whole module
	// exists to prevent, with the loudest possible signal attached.
	for (const pid of targets.filter(isAlive)) {
		try {
			process.kill(pid, 'SIGKILL');
			log(options, `${pid} ignored SIGTERM for ${TERM_GRACE_MS}ms; sent SIGKILL`);
		} catch (error) {
			log(options, `could not SIGKILL ${pid}: ${(error as Error).message}`);
		}
	}
}

/** The pid of a replacement node, or null. Never the process this was watching. */
function replacementPid(options: ReaperOptions): number | null {
	if (!options.hdbPidFile || !existsSync(options.hdbPidFile)) return null;
	const pid = readPidFile(options.hdbPidFile);
	if (pid === null || pid === options.harperPid || !isAlive(pid)) return null;
	return pid;
}

/**
 * Watch, then either hand over or reap.
 *
 * Exported so the behaviour can be tested without spawning a process; the module tail runs it
 * when this file is executed directly.
 */
export async function run(options: ReaperOptions): Promise<void> {
	log(
		options,
		`watching pid ${options.harperPid}; will stop ${options.targets.length} process(es) when it goes. ` +
			`Restart grace ${options.restartGraceMs}ms.`
	);

	while (isAlive(options.harperPid)) await delay(POLL_INTERVAL_MS);
	log(options, `pid ${options.harperPid} is gone`);

	// `harper restart` forks a replacement and exits the old main, so the children should be
	// kept for it to adopt rather than stopped and started again.
	const deadline = Date.now() + options.restartGraceMs;
	while (Date.now() < deadline) {
		const replacement = replacementPid(options);
		if (replacement !== null) {
			log(options, `pid ${replacement} took over within the grace window; leaving the processes for it to adopt`);
			removeQuietly(options.selfPidFile);
			return;
		}
		await delay(100);
	}

	for (const target of options.targets) await reapTarget(options, target);
	removeQuietly(options.selfPidFile);
	log(options, 'done.');
}

/**
 * `--target <base64 json>`, repeatable: `{ pidFile, pid, binaryPath }`.
 *
 * Base64 because every field is an absolute path and the previous `pidFile:pid` spelling split
 * on the last colon, which a path containing one breaks.
 */
export function parseArgs(argv: string[]): ReaperOptions {
	const options: ReaperOptions = { harperPid: Number.NaN, targets: [], restartGraceMs: 8000 };
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		switch (argv[i]) {
			case '--harper-pid':
				options.harperPid = Number.parseInt(value, 10);
				i++;
				break;
			case '--hdb-pid-file':
				options.hdbPidFile = value;
				i++;
				break;
			case '--restart-grace-ms':
				options.restartGraceMs = Number.parseInt(value, 10);
				i++;
				break;
			case '--self-pid-file':
				options.selfPidFile = value;
				i++;
				break;
			case '--log':
				options.logFile = value;
				i++;
				break;
			case '--target':
				try {
					const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
					options.targets.push({
						pidFile: String(decoded.pidFile),
						pid: Number.parseInt(decoded.pid, 10),
						binaryPath: String(decoded.binaryPath ?? ''),
					});
				} catch {
					// A descriptor that cannot be read names nothing this may act on, so it is
					// dropped rather than guessed at.
				}
				i++;
				break;
		}
	}
	return options;
}

// Executed directly, which is how a component uses this. Guarded so the exports above stay
// importable by a test without a reaper loop starting as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const options = parseArgs(process.argv.slice(2));
	if (!Number.isInteger(options.harperPid) || options.harperPid <= 0) {
		// Refusing is the right answer: a reaper with nothing to watch would sit forever, and a
		// non-positive pid is a process-GROUP selector to kill(2) rather than a process.
		process.stderr.write('reaper: --harper-pid must be a positive integer\n');
		process.exit(2);
	}
	// Not awaited at top level. A top-level await makes the whole ESM graph async, and
	// index.ts re-exports this file, so require() of the package entry point would throw
	// ERR_REQUIRE_ASYNC_MODULE. test/unit/require-entry.test.js pins that and caught it.
	run(options).catch((error: unknown) => {
		process.stderr.write(`reaper: ${(error as Error).message}\n`);
		process.exit(1);
	});
}
