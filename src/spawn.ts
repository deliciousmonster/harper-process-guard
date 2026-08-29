// Spawn orchestration; the constrained spawn comes FROM THE CALLER, because Harper substitutes it per module graph.
import { accessSync, constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { errorMessage } from './errors.js';
import { writeGuardDescriptor } from './registry.js';

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
	options: { name: string; version?: number | undefined; stdio: ['ignore', 'ignore', 'ignore']; env: NodeJS.ProcessEnv }
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

/** Start one process through Harper's lock and keep it started; synchronous because Harper's spawn is. */
export function startProcess(
	spawn: ConstrainedSpawn,
	descriptor: ManagedProcess,
	{ version, log, logDirHint }: { version?: number | undefined; log: GuardLog; logDirHint?: string | undefined },
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

	// The adoption wrapper lacks `spawnargs`; stdout is not a tell, since an ignored-stdio winner also has none.
	state.adopted = !Array.isArray(child.spawnargs);
	if (state.adopted) {
		log.info(
			`process guard: the ${title} is already running on this node (pid ${child.pid}); ` +
				`this thread joined it instead of starting a second one.`
		);
		// The wrapper polls on a setInterval it never unref'd; unref is what clears it.
		child.unref();
		return state;
	}

	log.info(
		`process guard: started the ${title} (pid ${child.pid}): ${descriptor.binaryPath} ` +
			`${descriptor.args.join(' ')}.${logDirHint ? ` It logs to ${logDirHint}.` : ''}`
	);

	/** Restart with backoff after a death nothing else recovers from; only the winning thread ever gets here. */
	function respawn(reason: string): void {
		if (attempt + 1 > RESPAWN_MAX_ATTEMPTS) {
			log.error(
				`process guard: the ${title} has died ${attempt} times (${reason}); not ` +
					`restarting it again. What it provided is now missing until the component reloads.`
			);
			return;
		}
		const delay = Math.min(RESPAWN_BASE_MS * 2 ** attempt, RESPAWN_CAP_MS);
		log.warn(
			`process guard: restarting the ${title} in ${delay}ms after ${reason} ` +
				`(attempt ${attempt + 1} of ${RESPAWN_MAX_ATTEMPTS}).`
		);
		const timer = setTimeout(() => {
			startProcess(spawn, descriptor, { version, log, logDirHint }, state, attempt + 1);
		}, delay);
		// A node shutting down must not wait on a restart; outliving the node is the reaper's job, not a timer's.
		timer.unref?.();
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
		// The wrapper polls on a setInterval it never unref'd; unref is what clears it.
		child.unref();
		return state;
	}

	log.info(
		`process guard: reaper started (pid ${child.pid}), watching ${running.length} ` +
			`process(es).${startedHint ? ` ${startedHint}` : ''}`
	);
	// A crashed reaper must say so in the log of the node it watched; a signal or code 0 is someone stopping it.
	child.on('exit', (code, signal) => {
		if (signal || code === 0) return;
		log.warn(
			`process guard: the ${name} exited with code ${code}. The processes it watched will ` +
				`now outlive this node; \`harper stop\` leaves them running.` +
				(outliveHint ? ` ${outliveHint}` : '')
		);
	});
	return state;
}
