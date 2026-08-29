// A detached OS process, because nothing inside the node survives its death (no worker shutdown hook; SIGKILL fires no handler). Spawned as dist/reaper.js, never imported; siblings resolve by relative path, which only works from inside dist/.
// Signals only an identified process, or the pid it watched start; never a pid read from a file.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { errorMessage } from './errors.js';
import { identificationCanAuthoriseSignal, identify, isAlive } from './identity.js';

/** How often the watched process is checked. */
const POLL_INTERVAL_MS = 1000;

/** How long a child gets after SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 5000;

export interface ReapTarget {
	/** The lock file naming this child, removed before it is signalled. */
	readonly pidFile: string;
	/** The pid this reaper watched start. First-hand, unlike anything read from a file. */
	readonly pid: number;
	/** Absolute path of the binary, so the child can be identified before it is signalled. */
	readonly binaryPath: string;
}

export interface ReaperOptions {
	/** The process to watch. When it goes, the targets are stopped. */
	harperPid: number;
	targets: ReapTarget[];
	/** Where a replacement writes its pid: `harper restart` forks a new main, so the children are KEPT for it to adopt, and reaping waits for one first. */
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
		const pid = Number.parseInt(readFileSync(path, 'utf-8').trim().split('\n')[0] ?? '', 10);
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

/** `pid` is first-hand (watched start); `recorded` is whatever the file says now. Container pid namespaces restart at 1, so a stale file naming a reused pid is routine. */
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

/** The lock is removed BEFORE signalling: a worker that reads a dying pid adopts a corpse and never retries; one that finds nothing spawns a replacement. */
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
			log(options, `could not SIGTERM ${pid}: ${errorMessage(error)}`);
		}
	}

	const deadline = Date.now() + TERM_GRACE_MS;
	while (Date.now() < deadline && targets.some(isAlive)) await delay(100);

	// SIGKILL only reaches pids identified above; killing an unnamed pid would be the module's own defect.
	for (const pid of targets.filter(isAlive)) {
		try {
			process.kill(pid, 'SIGKILL');
			log(options, `${pid} ignored SIGTERM for ${TERM_GRACE_MS}ms; sent SIGKILL`);
		} catch (error) {
			log(options, `could not SIGKILL ${pid}: ${errorMessage(error)}`);
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

/** Exported so a test can drive it without spawning a process; the module tail runs it when executed directly. */
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

/** `--target <base64 json>` ({pidFile, pid, binaryPath}), repeatable. Base64 because the fields are absolute paths and the old colon-split spelling broke on a path containing one. */
export function parseArgs(argv: string[]): ReaperOptions {
	const options: ReaperOptions = { harperPid: Number.NaN, targets: [], restartGraceMs: 8000 };
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		// Every flag takes a value, so a flag arriving as the final token has nothing to
		// consume; without this, `--target` at the end would hand undefined to Buffer.from.
		if (value === undefined) break;
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
					const decoded: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
					// A descriptor that cannot be read names nothing this may act on, so a wrong
					// shape is dropped rather than guessed at, same as the parse failure below.
					if (
						typeof decoded === 'object' &&
						decoded !== null &&
						'pidFile' in decoded &&
						typeof decoded.pidFile === 'string' &&
						'pid' in decoded &&
						(typeof decoded.pid === 'number' || typeof decoded.pid === 'string')
					) {
						options.targets.push({
							pidFile: decoded.pidFile,
							pid: Number(decoded.pid),
							binaryPath: 'binaryPath' in decoded && typeof decoded.binaryPath === 'string' ? decoded.binaryPath : '',
						});
					}
				} catch {
					// Not base64, or not JSON. Dropped, same as a wrong shape above.
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
	// Not awaited: a top-level await makes the whole ESM graph async, and require() of the
	// package entry (which re-exports this file) would throw ERR_REQUIRE_ASYNC_MODULE.
	run(options).catch((error: unknown) => {
		process.stderr.write(`reaper: ${errorMessage(error)}\n`);
		process.exit(1);
	});
}
