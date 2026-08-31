// Spawn orchestration; the constrained spawn comes FROM THE CALLER, because Harper substitutes it per module graph.
import { accessSync, constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { errorMessage } from './errors.js';
import { isAlive, readLock } from './identity.js';
import { writeGuardDescriptor } from './registry.js';
import { removeIfStill } from './sweep.js';

/** The caller's logger. Nothing here writes to a console nobody reads. */
export interface GuardLog {
	readonly info: (message: string) => void;
	readonly warn: (message: string) => void;
	readonly error: (message: string) => void;
}

/** Harper's constrained spawn, as the component receives it. */
export type ConstrainedSpawn = (
	command: string,
	args: string[],
	options: {
		name: string;
		version?: number | undefined;
		/** Passed through to child_process.spawn: its own process group, so a signal to this node's group misses it. */
		detached?: boolean | undefined;
		stdio: ['ignore', 'ignore', 'ignore'];
		env: NodeJS.ProcessEnv;
	}
) => SpawnedChild;

/** What Harper's spawn returns: a real ChildProcess, or an ExistingProcessWrapper for losers. */
export interface SpawnedChild {
	pid?: number | undefined;
	spawnargs?: readonly string[] | undefined;
	on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	unref(): void;
}

export interface ManagedProcess {
	/** Harper's spawn `name`, which is also the PID-lock filename. */
	readonly name: string;
	/** How messages name it. Defaults to `name`. */
	readonly title?: string | undefined;
	/** Absolute path of the binary. Resolve it before calling; an empty string is reported, not spawned. */
	readonly binaryPath: string;
	readonly args: readonly string[];
	/** Appended to the non-zero-exit report, for the caller's domain knowledge ("port in use" and the like). */
	readonly exitHint?: string | undefined;
}

export interface ProcessState {
	name: string;
	title: string;
	binaryPath: string;
	started: boolean;
	/** True when this thread lost the PID-file race and joined an existing process. */
	adopted?: boolean;
	/** Undefined is an assigned value on the three fields below: a respawn clears them through this type. */
	pid?: number | undefined;
	exited?: boolean | undefined;
	error?: string | undefined;
	respawnAttempts?: number;
	/** Set by bootstrap() from the caller's verify(): whether the process proved it does its job. */
	verified?: boolean;
	verifyDetail?: string | undefined;
}

const RESPAWN_MAX_ATTEMPTS = 5;
const RESPAWN_BASE_MS = 1000;
const RESPAWN_CAP_MS = 30_000;
// Liveness cadence for a joined process. Not sub-second: isAlive() runs a `ps` per call on darwin,
// once per joined process per thread, and this only has to report a death rather than react to one.
const ADOPTED_POLL_MS = 2000;

/** One schedule for both paths: a restart from a thread that only joined must not outrun the owner's. */
function backoffMs(attempt: number): number {
	return Math.min(RESPAWN_BASE_MS * 2 ** attempt, RESPAWN_CAP_MS);
}

/** Fingerprint of what forces replacement of a running process; a NUMBER inside 2^31, because Harper parseInt()s it. */
export function fingerprint(...parts: unknown[]): number {
	return createHash('sha256').update(parts.map(String).join('\0')).digest().readUInt32BE(0) >>> 1;
}

/** Refuse a binary Harper cannot start: a spaced path no allowlist entry can match, or a file that is not there. */
export function preflightBinary(title: string, binaryPath: string): void {
	if (binaryPath.includes(' ')) {
		throw new Error(
			`The ${title} binary path contains a space: ${binaryPath}. Harper matches the ` +
				`allowlist with command.split(" ")[0], so no applications.allowedSpawnCommands ` +
				`entry can ever match this path. Install the component somewhere without spaces.`
		);
	}
	if (!existsSync(binaryPath)) {
		throw new Error(
			`The ${title} binary is missing at ${binaryPath}. Not spawning it: Harper would ` +
				`create the PID lock file, get a child with pid === undefined, and throw a ` +
				`TypeError while writing that PID.`
		);
	}
	accessSync(binaryPath, constants.X_OK);
}

/** A command that must not exist, so permitting it proves the spawn is not constrained. */
const PROBE_COMMAND = 'harper-process-guard-spawn-probe-must-not-exist';

/** Prove the spawn is Harper's constrained one; only Harper's wrapper throws synchronously from spawn(). */
export function assertConstrainedSpawn(
	spawn: ConstrainedSpawn,
	log: GuardLog,
	hint?: string | { readonly notInterceptedHint?: string | undefined }
): { intercepted: boolean; detail: string } {
	const notInterceptedHint = typeof hint === 'string' ? hint : hint?.notInterceptedHint;
	let child: SpawnedChild;
	try {
		child = spawn(PROBE_COMMAND, [], {
			name: 'guard-spawn-probe',
			stdio: ['ignore', 'ignore', 'ignore'],
			env: process.env,
		});
	} catch (error) {
		const message = errorMessage(error);
		if (/is not allowed/.test(message)) {
			log.info(
				`process guard: Harper's constrained child_process is active (probe rejected with ` +
					`"${message}"). Spawns are deduped by the PID-file lock under <rootPath>/pids/, so ` +
					`this node runs exactly one of each named process no matter how many worker ` +
					`threads load the component.`
			);
			return { intercepted: true, detail: message };
		}
		log.warn(
			`process guard: spawn probe threw an unexpected error: ${message}. Treating ` +
				`interception as active, but verify the Harper version.`
		);
		return { intercepted: true, detail: message };
	}

	// The probe's ENOENT arrives later as an 'error' event, which unhandled kills the worker thread.
	child.on('error', () => {});
	child.unref();
	log.error(
		`process guard: HARPER'S SPAWN INTERCEPTION IS NOT ACTIVE. Spawning "${PROBE_COMMAND}" ` +
			`was permitted, which means the caller handed over Node's real child_process. There is ` +
			`no PID-file singleton: every worker thread will start its own copy of each process, ` +
			`all but one will fail to bind their ports, and none of that is reported anywhere. ` +
			`Causes, in order of likelihood: the calling module was not reached by a RELATIVE ` +
			`import from the component entry (a bare npm specifier is loaded natively unless the ` +
			`package depends on harper); child_process was pulled in with require() instead of ` +
			`import (Harper's CJS require does not apply the substitution); or ` +
			`applications.moduleLoader is set to "native", which disables the application loader.` +
			(notInterceptedHint ? ` ${notInterceptedHint}` : '')
	);
	return { intercepted: false, detail: 'spawn of a bogus command was permitted' };
}

/** What a joined death is reported as. The mechanism around it is the same for a process and for a reaper. */
interface AdoptedReport {
	/** Logged when the join hands over no pid, so there is nothing to poll. */
	readonly unsupervisable: string;
	/** One line for a death: what is gone, how that was learned, and what follows from it. */
	readonly gone: (pid: number, cause: string) => string;
	/** One level for every death; without it the cause grades one, so a clean exit is info and a crash is error. */
	readonly deathLevel?: 'info' | 'warn' | 'error' | undefined;
	/** Run for a death that grades as a crash. A stop delivered through the wrapper never reaches it. */
	readonly onCrash?: ((pid: number, cause: string) => void) | undefined;
}

/**
 * Watch a process this thread joined rather than started. Harper's released wrappers implement
 * unref() as clearInterval on their liveness poll, so their 'exit' cannot fire once unref runs.
 */
function superviseAdopted(
	child: SpawnedChild,
	/** Written, never read: both ProcessState and ReaperState carry `exited` for a status surface to show. */
	state: { exited?: boolean | undefined },
	log: GuardLog,
	pollMs: number,
	report: AdoptedReport
): void {
	const joined = child.pid;
	if (typeof joined !== 'number' || !Number.isInteger(joined) || joined <= 0) {
		// Harper hands the wrapper the pid from the lock file, so this is a Harper that read a lock it could not parse.
		log.warn(report.unsupervisable);
		child.unref();
		return;
	}
	// Declared a number rather than left as the narrowed union, which the closures below do not inherit.
	const pid: number = joined;

	let settled = false;
	// One death however it reaches here: a Harper whose unref() leaves the wrapper polling still emits 'exit'.
	function settle(level: 'info' | 'warn' | 'error', cause: string): void {
		if (settled) return;
		settled = true;
		clearInterval(poll);
		state.exited = true;
		log[report.deathLevel ?? level](report.gone(pid, cause));
		// The grade carries the intent: code 0 and the stop signals are someone shutting it down.
		// deathLevel changes how a death reads, never what it was, so the hook reads `level`.
		if (level === 'error') report.onCrash?.(pid, cause);
	}

	// Started before the listener and the unref below, so neither can reach `poll` before it exists.
	const poll = setInterval(() => {
		if (!isAlive(pid)) settle('error', 'a liveness poll found the pid dead');
	}, pollMs);
	// A node shutting down must not wait on supervision; outliving the node is the reaper's job.
	poll.unref?.();

	child.on('exit', (code, signal) => {
		if (signal) {
			settle(signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP' ? 'warn' : 'error', `signal ${signal}`);
			return;
		}
		settle(code === 0 ? 'info' : 'error', `exit code ${code}`);
	});
	// The wrapper polls on a setInterval it never unref'd; unref is what clears it, which is why the poll above exists.
	child.unref();
}

/** Start one process through Harper's lock and keep it started; synchronous because Harper's spawn is. */
export function startProcess(
	spawn: ConstrainedSpawn,
	descriptor: ManagedProcess,
	{
		version,
		log,
		logDirHint,
		pidDir,
		adoptedPollMs = ADOPTED_POLL_MS,
	}: {
		version?: number | undefined;
		log: GuardLog;
		logDirHint?: string | undefined;
		/** Where Harper's PID locks live. Without it a thread that joined cannot tell a death nobody owns from one another thread has already answered, and reports either. */
		pidDir?: string | undefined;
		/** How often a joined process is checked for liveness. */
		adoptedPollMs?: number | undefined;
	},
	existingState: ProcessState | null = null,
	attempt = 0
): ProcessState {
	const title = descriptor.title ?? descriptor.name;
	// A respawn reuses the caller's state object, so a status endpoint holding it keeps describing what runs.
	const state: ProcessState = existingState ?? {
		name: descriptor.name,
		title,
		binaryPath: descriptor.binaryPath,
		started: false,
	};
	state.respawnAttempts = attempt;
	// Clear the last incarnation's death, or one early exit reads as a dead process beside a live pid forever.
	state.exited = undefined;
	state.error = undefined;

	try {
		if (!descriptor.binaryPath) throw new Error('its path could not be resolved');
		preflightBinary(title, descriptor.binaryPath);
	} catch (error) {
		state.error = errorMessage(error);
		log.error(`process guard: cannot start the ${title}: ${state.error}`);
		return state;
	}

	let child: SpawnedChild;
	try {
		// Copied because the descriptor's args are readonly and Harper's spawn takes a mutable array.
		child = spawn(descriptor.binaryPath, [...descriptor.args], {
			name: descriptor.name,
			version,
			// Never piped: a pipe ties the child to the winning thread, which harper dev recycles on every save.
			stdio: ['ignore', 'ignore', 'ignore'],
			env: process.env,
		});
	} catch (error) {
		state.error = errorMessage(error);
		log.error(
			`process guard: Harper refused to spawn the ${title}: ${state.error}. If this says ` +
				`"is not allowed", add this exact absolute path to applications.allowedSpawnCommands ` +
				`and restart Harper (the allowlist is read once at module load, so editing it ` +
				`without a restart changes nothing): ${descriptor.binaryPath}`
		);
		return state;
	}

	state.pid = child.pid;
	state.started = true;

	// Attached before anything else: an unhandled 'error' on a ChildProcess kills the worker thread on the next tick.
	child.on('error', (error) => {
		// ENOEXEC is the one failure preflight cannot see: X_OK passes for a binary built for another architecture.
		const detail =
			error.code === 'ENOEXEC'
				? `${descriptor.binaryPath} is not executable code for this machine (ENOEXEC). A ` +
					`platform package filled from another architecture produces exactly this; check ` +
					`with \`file ${descriptor.binaryPath}\`.`
				: error.message;
		log.error(`process guard: the ${title} failed to execute: ${detail}`);
	});

	/** True once this thread may not restart again. The cap is spent per death seen, not per restart won, so threads that lost the lock deplete alongside the one that took it. */
	function restartsExhausted(reason: string): boolean {
		if (attempt + 1 <= RESPAWN_MAX_ATTEMPTS) return false;
		log.error(
			`process guard: the ${title} has died ${attempt} times (${reason}); not ` +
				`restarting it again. What it provided is now missing until the component reloads.`
		);
		return true;
	}

	/** Arm the restart. Unref'd: a node shutting down must not wait on one, and must not be restarted into either. */
	function armRestart(delay: number, gate?: () => boolean): void {
		const timer = setTimeout(() => {
			if (gate && !gate()) return;
			startProcess(spawn, descriptor, { version, log, logDirHint, pidDir, adoptedPollMs }, state, attempt + 1);
		}, delay);
		timer.unref?.();
	}

	/** Answer a death this thread watched but never owned. Harper's spawn is the arbiter: its exclusive create hands the restart to one thread, and every other thread joins whatever that one starts. */
	function reclaim(pid: number, cause: string): void {
		if (!pidDir) {
			log.warn(
				`process guard: no pid directory was named, so this thread cannot tell whether anything ` +
					`still owns the ${title} (pid ${pid}); not starting a replacement. Pass pidDir, or ` +
					`rootPath to bootstrap(), and a death nobody owns is restarted rather than only reported.`
			);
			return;
		}
		const lockPath = join(pidDir, `${descriptor.name}.pid`);
		// Harper removes the lock from the exit of the ChildProcess it handed out, so a lock outliving
		// its process is the ownerless case: no thread here saw the exit, and nothing else will act on it.
		if (!existsSync(lockPath)) {
			log.info(
				`process guard: the ${title} lock at ${lockPath} is already gone, so whichever thread ` +
					`held it has answered this death; a thread that only joined is not starting a replacement.`
			);
			return;
		}
		if (restartsExhausted(cause)) return;
		const delay = backoffMs(attempt);
		log.warn(
			`process guard: nothing on this node holds the ${title} lock at ${lockPath}, so its death ` +
				`is nobody's to repair. Going back through Harper's spawn in ${delay}ms: this thread ` +
				`restarts it if the lock is still stale by then, and joins it if another thread got ` +
				`there first (attempt ${attempt + 1} of ${RESPAWN_MAX_ATTEMPTS}).`
		);
		armRestart(delay, () => {
			// Existence, not contents: Harper's lock is empty between its exclusive create and its pid
			// write, and a thread reading that gap as gone would abandon a process that is starting.
			if (!existsSync(lockPath)) {
				log.info(
					`process guard: the ${title} lock went away while this thread waited to take it, so ` +
						`another thread has answered the death; not starting a replacement.`
				);
				return false;
			}
			// Harper validates a lock with a bare kill(pid, 0), which a corpse answers, so its spawn
			// would hand back the corpse. Removed only while the lock still names this dead pid.
			if (readLock(lockPath)?.pid === pid && !isAlive(pid)) removeIfStill(lockPath, pid);
			return true;
		});
	}

	// The adoption wrapper lacks `spawnargs`; stdout is not a tell, since an ignored-stdio winner also has none.
	state.adopted = !Array.isArray(child.spawnargs);
	if (state.adopted) {
		log.info(
			`process guard: the ${title} is already running on this node (pid ${child.pid}); ` +
				`this thread joined it instead of starting a second one.`
		);
		superviseAdopted(child, state, log, adoptedPollMs, {
			unsupervisable:
				`process guard: the ${title} was joined without a pid, so this thread cannot tell whether ` +
				`it is still running. Its death will go unreported here.`,
			gone: (pid, cause) =>
				`process guard: the ${title} this thread joined (pid ${pid}) is gone (${cause}). What it ` +
				`provided is missing from this node until something replaces it.`,
			onCrash: reclaim,
		});
		return state;
	}

	log.info(
		`process guard: started the ${title} (pid ${child.pid}): ${descriptor.binaryPath} ` +
			`${descriptor.args.join(' ')}.${logDirHint ? ` It logs to ${logDirHint}.` : ''}`
	);

	/** Restart with backoff after a death nothing else recovers from. This thread holds the lock, so no sibling is racing it here. */
	function respawn(reason: string): void {
		if (restartsExhausted(reason)) return;
		const delay = backoffMs(attempt);
		log.warn(
			`process guard: restarting the ${title} in ${delay}ms after ${reason} ` +
				`(attempt ${attempt + 1} of ${RESPAWN_MAX_ATTEMPTS}).`
		);
		armRestart(delay);
	}

	child.on('exit', (code, signal) => {
		state.exited = true;
		if (signal) {
			const stopped = `process guard: the ${title} was terminated by ${signal}.`;
			// A stop signal is someone shutting it down; SIGKILL and the rest are crashes nothing else recovers from.
			if (signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') {
				log.warn(stopped);
			} else {
				log.error(`${stopped} That is a crash or an OOM kill rather than a shutdown.`);
				respawn(`signal ${signal}`);
			}
			return;
		}
		if (code === 0) {
			log.info(`process guard: the ${title} exited cleanly.`);
			return;
		}
		log.error(
			`process guard: the ${title} exited with code ${code}. Harper has removed its PID ` +
				`file, so the next worker to load this component will try again.` +
				(descriptor.exitHint ? ` ${descriptor.exitHint}` : '')
		);
		respawn(`exit code ${code}`);
	});

	return state;
}

/** What launchReaper reports. `adopted` is what separates launching a reaper from joining one. */
export interface ReaperState {
	name: string;
	started: boolean;
	/** True when this thread lost the reaper's own PID-file race and joined the winner's. */
	adopted?: boolean;
	pid?: number | undefined;
	/** True once this thread has seen the reaper end, so a status surface holding this state stops reading healthy. */
	exited?: boolean | undefined;
	command?: string;
	error?: string;
}

/** The reaper's default Harper spawn name, which is also its lock filename; bootstrap() reports it when no reaper can launch. */
export const DEFAULT_REAPER_NAME = 'harper-process-guard-reaper';

/** Start the guard's reaper, or say why it was not; never fatal, since without one the processes merely outlive the node. */
export function launchReaper(
	spawn: ConstrainedSpawn,
	{
		reaperScript,
		rootPath,
		pidDir = join(rootPath, 'pids'),
		processes,
		version,
		log,
		logFile,
		name = DEFAULT_REAPER_NAME,
		restartGraceMs = 8000,
		startedHint,
		outliveHint,
		adoptedPollMs = ADOPTED_POLL_MS,
	}: {
		/** Absolute path of this package's dist/reaper.js, resolved by the caller through the package. */
		reaperScript: string;
		rootPath: string;
		/** Where the PID locks live. Defaults to `<rootPath>/pids`. */
		pidDir?: string | undefined;
		processes: readonly ProcessState[];
		version?: number | undefined;
		log: GuardLog;
		logFile?: string | undefined;
		/** Harper spawn name for the reaper itself, which is also ITS lock filename. */
		name?: string | undefined;
		restartGraceMs?: number | undefined;
		/** Appended to the started log, naming what the reaper stops in the caller's terms. */
		startedHint?: string | undefined;
		/** Appended wherever a missing or dead reaper means the processes outlive the node. */
		outliveHint?: string | undefined;
		/** How often a joined reaper is checked for liveness. */
		adoptedPollMs?: number | undefined;
	}
): ReaperState {
	const state: ReaperState = {
		name,
		started: false,
	};

	const running = processes.filter((p): p is ProcessState & { pid: number } => p.started && typeof p.pid === 'number');
	if (running.length === 0) {
		state.error = 'no process started, so there is nothing to stop';
		return state;
	}

	// Recorded BEFORE the launch, and regardless of how it ends: when this thread loses the
	// reaper's lock and joins an existing one, these files are how that reaper learns of its processes.
	for (const p of running) {
		try {
			writeGuardDescriptor(pidDir, {
				name: p.name,
				pidFile: join(pidDir, `${p.name}.pid`),
				pid: p.pid,
				binaryPath: p.binaryPath ?? '',
			});
		} catch (error) {
			log.warn(
				`process guard: could not record the ${p.title ?? p.name} for the reaper ` +
					`(${errorMessage(error)}); a reaper launched by another caller will not know to stop it.`
			);
		}
	}

	if (!existsSync(reaperScript)) {
		state.error = `${reaperScript} is missing`;
		log.error(
			`process guard: cannot start the reaper: ${reaperScript} is missing. It ships inside ` +
				`this package, so this means the package is installed without its build output. ` +
				`Without it the processes keep running after this node stops.` +
				(outliveHint ? ` ${outliveHint}` : '')
		);
		return state;
	}

	const args = [
		reaperScript,
		// A worker thread's process.pid IS the main Harper process: threads share a process.
		'--harper-pid',
		String(process.pid),
		'--hdb-pid-file',
		join(rootPath, 'hdb.pid'),
		'--restart-grace-ms',
		String(restartGraceMs),
		'--self-pid-file',
		join(pidDir, `${name}.pid`),
		// The reaper re-enumerates this directory's descriptors at reap time; an older reaper
		// binary ignores the flag and reaps from the argv targets below, as before.
		'--pid-dir',
		pidDir,
		...(logFile ? ['--log', logFile] : []),
		// Base64 JSON per target: the fields are absolute paths, which a colon-split spelling breaks.
		...running.flatMap((p) => [
			'--target',
			Buffer.from(
				JSON.stringify({ pidFile: join(pidDir, `${p.name}.pid`), pid: p.pid, binaryPath: p.binaryPath ?? '' })
			).toString('base64'),
		]),
	];

	// process.execPath first because PATH cannot shadow it; bare `node` is in Harper's default allowlist.
	let child: SpawnedChild | undefined;
	const refusals: string[] = [];
	for (const command of [process.execPath, 'node']) {
		try {
			child = spawn(command, args, {
				name,
				version,
				// Its own process group. A signal sent to this node's group (GNU `timeout` sends one)
				// otherwise takes the reaper down alongside everything it exists to outlive.
				detached: true,
				stdio: ['ignore', 'ignore', 'ignore'],
				env: process.env,
			});
			state.command = command;
			break;
		} catch (error) {
			refusals.push(`${command}: ${errorMessage(error)}`);
		}
	}

	if (!child) {
		state.error = refusals.join('; ');
		log.warn(
			`process guard: Harper refused to start the reaper (${state.error}). Add \`node\` ` +
				`back to applications.allowedSpawnCommands, or add ${process.execPath}. Without it ` +
				`the processes keep running after \`harper stop\`.` +
				(outliveHint ? ` ${outliveHint}` : '')
		);
		return state;
	}

	child.on('error', (error) => log.error(`process guard: the reaper failed to execute: ${error.message}`));
	state.pid = child.pid;
	state.started = true;

	// Must return before the started line, or every losing thread logs "reaper started" for one reaper.
	state.adopted = !Array.isArray(child.spawnargs);
	if (state.adopted) {
		log.info(
			`process guard: the ${name} is already running on this node (pid ${child.pid}); this ` +
				`thread joined it instead of starting a second one.`
		);
		// Every death warns whatever its cause: a joining thread cannot tell a deliberate stop from a
		// crash, and the processes outlive this node either way.
		superviseAdopted(child, state, log, adoptedPollMs, {
			deathLevel: 'warn',
			unsupervisable:
				`process guard: the ${name} was joined without a pid, so this thread cannot tell whether ` +
				`it is still running. Its death, and the processes then outliving this node, go unreported here.` +
				(outliveHint ? ` ${outliveHint}` : ''),
			gone: (pid, cause) =>
				`process guard: the ${name} this thread joined (pid ${pid}) is gone (${cause}). The ` +
				`processes it watched will now outlive this node; \`harper stop\` leaves them running. No ` +
				`thread relaunches a reaper mid-node, the one that launched it included, so this is a ` +
				`report: the next load of the component launches one once Harper's lock is gone.` +
				(outliveHint ? ` ${outliveHint}` : ''),
		});
		return state;
	}

	log.info(
		`process guard: reaper started (pid ${child.pid}), watching ${running.length} ` +
			`process(es).${startedHint ? ` ${startedHint}` : ''}`
	);
	// A crashed reaper must say so in the log of the node it watched; a signal or code 0 is someone stopping it.
	child.on('exit', (code, signal) => {
		state.exited = true;
		if (signal || code === 0) return;
		log.warn(
			`process guard: the ${name} exited with code ${code}. The processes it watched will ` +
				`now outlive this node; \`harper stop\` leaves them running.` +
				(outliveHint ? ` ${outliveHint}` : '')
		);
	});
	// Detached and unref'd: the reaper must outlive this node, so nothing about it may hold the
	// node open. stdio is already ignored, so no stream ties it back either.
	child.unref();
	return state;
}
