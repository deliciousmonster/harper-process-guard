/**
 * Spawn orchestration for the processes a Harper component owns.
 *
 * Everything here was carried out of the Datadog supervisor, where each rule was paid for by a
 * real defect; the comments name them because none of the rules is visible from the code alone.
 *
 * THE SPAWN COMES FROM THE CALLER. Harper substitutes its constrained `child_process` - the
 * mandatory spawn `name`, the allowlist, the PID-file singleton - only for modules its own
 * loader evaluates, which means modules reached by RELATIVE import from the component entry.
 * This package is imported by bare specifier and loaded natively, so a spawn imported here
 * would be stock Node: no lock, no allowlist, one process per worker thread. The caller passes
 * its own constrained spawn in, and `assertConstrainedSpawn` exists to prove it really is one.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** The caller's logger. Nothing here writes to a console nobody reads. */
export interface GuardLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** Harper's constrained spawn, as the component receives it. */
export type ConstrainedSpawn = (
	command: string,
	args: string[],
	options: { name: string; version?: number; stdio: ['ignore', 'ignore', 'ignore']; env: NodeJS.ProcessEnv }
) => SpawnedChild;

/** What Harper's spawn returns: a real ChildProcess, or an ExistingProcessWrapper for losers. */
export interface SpawnedChild {
	pid?: number;
	spawnargs?: string[];
	on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
	on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
	unref(): void;
}

export interface ManagedProcess {
	/** Harper's spawn `name`, which is also the PID-lock filename. */
	name: string;
	/** How messages name it. Defaults to `name`. */
	title?: string;
	/** Absolute path of the binary. Resolve it before calling; an empty string is reported, not spawned. */
	binaryPath: string;
	args: string[];
	/** Appended to the non-zero-exit report, for the caller's domain knowledge ("port in use" and the like). */
	exitHint?: string;
}

export interface ProcessState {
	name: string;
	title: string;
	binaryPath: string;
	started: boolean;
	/** True when this thread lost the PID-file race and joined an existing process. */
	adopted?: boolean;
	pid?: number;
	exited?: boolean;
	error?: string;
	respawnAttempts?: number;
}

const RESPAWN_MAX_ATTEMPTS = 5;
const RESPAWN_BASE_MS = 1000;
const RESPAWN_CAP_MS = 30_000;

/**
 * Numeric fingerprint of everything that should force replacement of a running process.
 *
 * Harper compares this against line 2 of the PID file and, on a mismatch, SIGTERMs the running
 * process and re-acquires the lock. Without it, a process left over from a previous boot is
 * adopted forever - the PID files sit on a persistent volume and outlive the container that
 * created them - and the sweep in this package leaves a matching-version process alone on
 * purpose, because `harper restart` hands children to the replacement through exactly that match.
 *
 * It must be a NUMBER. Harper reads the recorded value with `parseInt()` and compares with
 * `!==`, so a string version never equals its own recorded value and every thread would kill
 * and respawn the process, forever.
 */
export function fingerprint(...parts: unknown[]): number {
	// >>> 1 keeps it inside 2^31 so it round-trips through parseInt() unchanged.
	return createHash('sha256').update(parts.map(String).join('\0')).digest().readUInt32BE(0) >>> 1;
}

/**
 * Refuse a binary Harper cannot start, with the reason an operator can act on.
 *
 * Harper's allowlist test is `ALLOWED_COMMANDS.has(command.split(" ")[0])`, so a path containing
 * a space can never be allowlisted by any configuration, and failing on it explicitly stops the
 * error reading as a plain "not allowed" that sends people to edit a config that cannot help.
 * A missing binary must not reach spawn either: Harper would create the PID lock file, get a
 * child with pid === undefined, and throw a TypeError while writing that PID.
 */
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

/**
 * Prove the spawn the caller handed over really is Harper's constrained one.
 *
 * Only Harper's wrapper throws synchronously from spawn() at all. Node's real spawn accepts the
 * bogus command and reports ENOENT later as an 'error' event, which unhandled becomes an
 * uncaught exception, so the probe child gets a listener and an unref before this returns.
 */
export function assertConstrainedSpawn(
	spawn: ConstrainedSpawn,
	log: GuardLog
): { intercepted: boolean; detail: string } {
	let child: SpawnedChild;
	try {
		child = spawn(PROBE_COMMAND, [], {
			name: 'guard-spawn-probe',
			stdio: ['ignore', 'ignore', 'ignore'],
			env: process.env,
		});
	} catch (error) {
		const message = (error as Error).message;
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
			`applications.moduleLoader is set to "native", which disables the application loader.`
	);
	return { intercepted: false, detail: 'spawn of a bogus command was permitted' };
}

/**
 * Start one process through Harper's lock, and keep it started.
 *
 * Synchronous by design: Harper's spawn either throws, returns a real ChildProcess, or returns
 * the adoption wrapper, all synchronously, and the caller needs the state before it decides
 * what to verify.
 */
export function startProcess(
	spawn: ConstrainedSpawn,
	descriptor: ManagedProcess,
	{ version, log, logDirHint }: { version: number; log: GuardLog; logDirHint?: string },
	existingState: ProcessState | null = null,
	attempt = 0
): ProcessState {
	const title = descriptor.title ?? descriptor.name;
	const state: ProcessState = existingState ?? {
		name: descriptor.name,
		title,
		binaryPath: descriptor.binaryPath,
		started: false,
	};
	// A respawn reuses the caller's state object rather than returning a new one, so a status
	// endpoint holding references keeps describing the process that is actually running.
	state.respawnAttempts = attempt;

	try {
		if (!descriptor.binaryPath) throw new Error('its path could not be resolved');
		preflightBinary(title, descriptor.binaryPath);
	} catch (error) {
		state.error = (error as Error).message;
		log.error(`process guard: cannot start the ${title}: ${state.error}`);
		return state;
	}

	let child: SpawnedChild;
	try {
		child = spawn(descriptor.binaryPath, descriptor.args, {
			// Required by Harper, and the PID lock filename.
			name: descriptor.name,
			// See fingerprint(): a number, never a string.
			version,
			// Never piped. A pipe ties the process to the worker thread that won the spawn
			// race: when harper dev recycles that thread on a save, the child dies on SIGPIPE
			// at its next write, the PID file survives it, and every later thread adopts the
			// corpse and reports "already running" forever.
			stdio: ['ignore', 'ignore', 'ignore'],
			env: process.env,
		});
	} catch (error) {
		state.error = (error as Error).message;
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

	// Attached before anything else touches the child, and before the early return below.
	// Harper attaches only its own 'exit' listener, and an unhandled 'error' on a ChildProcess
	// becomes an uncaught exception that takes the worker thread with it. The event is
	// asynchronous, so returning from here without this listener is a crash waiting on the
	// next tick.
	child.on('error', (error) => {
		// ENOEXEC is the one spawn failure preflightBinary() cannot see coming: X_OK passes
		// for a binary built for another architecture, and the bare message is "Exec format
		// error".
		const detail =
			error.code === 'ENOEXEC'
				? `${descriptor.binaryPath} is not executable code for this machine (ENOEXEC). A ` +
					`platform package filled from another architecture produces exactly this; check ` +
					`with \`file ${descriptor.binaryPath}\`.`
				: error.message;
		log.error(`process guard: the ${title} failed to execute: ${detail}`);
	});

	// Every loser of the PID-file race gets an ExistingProcessWrapper: an EventEmitter with
	// pid, kill(), unref() and an 'exit' event. Detected by the absence of `spawnargs`, which
	// every real ChildProcess carries and the wrapper does not; stdout is not a safe tell,
	// because a winner spawned with its stdio ignored also has a null stdout.
	state.adopted = !Array.isArray(child.spawnargs);
	if (state.adopted) {
		log.info(
			`process guard: the ${title} is already running on this node (pid ${child.pid}); ` +
				`this thread joined it instead of starting a second one.`
		);
		// The wrapper polls the process once a second on a setInterval it never unref'd,
		// pinning the worker's event loop. unref() is what clears that interval.
		child.unref();
		return state;
	}

	log.info(
		`process guard: started the ${title} (pid ${child.pid}): ${descriptor.binaryPath} ` +
			`${descriptor.args.join(' ')}.${logDirHint ? ` It logs to ${logDirHint}.` : ''}`
	);

	/**
	 * Restart after a death nothing else recovers from. Only the thread that WON the spawn
	 * race reaches here: adopting threads unref() and return before this handler is attached,
	 * so one death produces one restart rather than one per worker.
	 *
	 * The delay backs off so a binary that dies immediately cannot spin, and the PID-file lock
	 * still arbitrates, so a racing worker load during the delay simply wins and this attempt
	 * adopts instead.
	 */
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
			// Deliberately not behind the startup barrier. This fires after startup, for a
			// process THIS thread started and watched die, and Harper's own exit handler has
			// already unlinked its lock. There is no stale lock to adjudicate.
			startProcess(spawn, descriptor, { version, log, logDirHint }, state, attempt + 1);
		}, delay);
		// Never hold the worker's event loop open for a restart: a node shutting down must not
		// wait on this, and the process outliving the node is the reaper's job, not a timer's.
		timer.unref?.();
	}

	child.on('exit', (code, signal) => {
		// Read by callers whose own waits have nothing left to wait for once the process they
		// were watching is gone.
		state.exited = true;
		if (signal) {
			const stopped = `process guard: the ${title} was terminated by ${signal}.`;
			// SIGTERM/SIGINT/SIGHUP are someone asking it to stop - the reaper stopping the
			// node, or an operator - and restarting into that would fight the shutdown. SIGKILL
			// is usually the OOM killer and the rest are crashes; those are the case nothing
			// else recovers from.
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

/**
 * Start the guard's reaper, or say why it was not started.
 *
 * The command has to satisfy Harper's allowlist, an exact string compare against
 * `command.split(' ')[0]`. `process.execPath` is tried first because it names this exact Node
 * and cannot be shadowed by PATH; bare `node` is the fallback and works with no configuration,
 * since it is in Harper's own default allowlist. A refused spawn throws synchronously and
 * creates no PID file, so trying both costs nothing.
 *
 * Never fatal. Without a reaper the processes run exactly as they would have, and outlive the
 * node exactly as they would have; that is worth a warning, not an outage.
 */
export function launchReaper(
	spawn: ConstrainedSpawn,
	{
		reaperScript,
		rootPath,
		processes,
		version,
		log,
		logFile,
		name = 'harper-process-guard-reaper',
		restartGraceMs = 8000,
	}: {
		/** Absolute path of this package's dist/reaper.js, resolved by the caller through the package. */
		reaperScript: string;
		rootPath: string;
		processes: ProcessState[];
		version: number;
		log: GuardLog;
		logFile?: string;
		/** Harper spawn name for the reaper itself, which is also ITS lock filename. */
		name?: string;
		restartGraceMs?: number;
	}
): { name: string; started: boolean; pid?: number; command?: string; error?: string } {
	const state: { name: string; started: boolean; pid?: number; command?: string; error?: string } = {
		name,
		started: false,
	};

	const running = processes.filter((p) => p.started && typeof p.pid === 'number');
	if (running.length === 0) {
		state.error = 'no process started, so there is nothing to stop';
		return state;
	}
	if (!existsSync(reaperScript)) {
		state.error = `${reaperScript} is missing`;
		log.error(
			`process guard: cannot start the reaper: ${reaperScript} is missing. It ships inside ` +
				`this package, so this means the package is installed without its build output. ` +
				`Without it the processes keep running after this node stops.`
		);
		return state;
	}

	const pidDir = join(rootPath, 'pids');
	const args = [
		reaperScript,
		// The worker thread's process.pid IS the main Harper process: threads share a process.
		// That is also the pid `harper stop` signals and the one the reaper becomes a child of.
		'--harper-pid',
		String(process.pid),
		'--hdb-pid-file',
		join(rootPath, 'hdb.pid'),
		'--restart-grace-ms',
		String(restartGraceMs),
		'--self-pid-file',
		join(pidDir, `${name}.pid`),
		...(logFile ? ['--log', logFile] : []),
		// Base64 JSON per target: the fields are absolute paths, and a `pidFile:pid` spelling
		// split on the last colon, which any path containing one breaks. The binary path is
		// what lets the reaper identify a process before signalling it.
		...running.flatMap((p) => [
			'--target',
			Buffer.from(
				JSON.stringify({ pidFile: join(pidDir, `${p.name}.pid`), pid: p.pid, binaryPath: p.binaryPath ?? '' })
			).toString('base64'),
		]),
	];

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
			refusals.push(`${command}: ${(error as Error).message}`);
		}
	}

	if (!child) {
		state.error = refusals.join('; ');
		log.warn(
			`process guard: Harper refused to start the reaper (${state.error}). Add \`node\` ` +
				`back to applications.allowedSpawnCommands, or add ${process.execPath}. Without it ` +
				`the processes keep running after \`harper stop\`.`
		);
		return state;
	}

	child.on('error', (error) => log.error(`process guard: the reaper failed to execute: ${error.message}`));
	// Adoption applies to the reaper too: one per node, whoever won.
	if (!Array.isArray(child.spawnargs)) child.unref();
	state.pid = child.pid;
	state.started = true;
	log.info(`process guard: reaper started (pid ${child.pid}), watching ${running.length} process(es).`);
	return state;
}
