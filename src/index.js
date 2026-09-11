// @ts-check
// One call for the lifecycle of the long-lived processes a host owns: take the lock, start or join,
// keep watching, and leave behind something that stops them when the host goes.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { errorMessage } from './identity.js';
import { claimLock, commitLock, lockPath, readLock, releaseLock, safeLockWrite } from './lock.js';
import { DEFAULT_TUNING, describeHandedBackPid, startFailure, superviseProcess } from './supervise.js';

/** @typedef {import('./supervise.js').GuardLog} GuardLog */
/** @typedef {import('./supervise.js').ProcessState} ProcessState */
/** @typedef {import('./supervise.js').Spawn} Spawn */

/**
 * @typedef {object} GuardedProcess
 * @property {string} name Lock filename stem under `pidDir`, and how a host names the spawn.
 * @property {string} binaryPath Absolute path of the binary. Resolve it before calling.
 * @property {readonly string[]} [args]
 * @property {string} [title] How messages name it. Defaults to `name`.
 * @property {string} [exitHint] Appended to the non-zero-exit report, for the caller's domain knowledge.
 * @property {import('node:child_process').SpawnOptions} [spawnOptions] Merged over the guard's own, for whatever the caller's spawn requires.
 * @property {(state: ProcessState) => Promise<{ ok: boolean; detail?: string }>} [verify] Proves it does its job; the verdict lands on the state.
 */

/**
 * @typedef {object} ReaperConfig
 * @property {string} [name] The reaper's own lock filename stem.
 * @property {string} [logFile]
 * @property {number} [graceMs] How long the reaper waits for a replacement host before stopping anything.
 * @property {string} [replacementPidFile] Where a replacement host records its pid, so a restart keeps the processes.
 * @property {import('node:child_process').SpawnOptions} [spawnOptions]
 */

/**
 * @typedef {object} ReaperState
 * @property {string} name
 * @property {boolean} started
 * @property {boolean} adopted True when this thread lost the reaper's own lock race and joined the winner's.
 * @property {number | undefined} [pid]
 * @property {string | undefined} [command]
 * @property {string} [error]
 */

/**
 * @typedef {object} GuardResult
 * @property {string[]} report One line per thing the lock adjudication decided, for a host that logs into its own sink.
 * @property {number} version
 * @property {ProcessState[]} processes One state per declared process, in declaration order.
 * @property {ReaperState} [reaper]
 * @property {() => void} stop Halt supervision. Signals nothing and releases no lock, so nothing starts a duplicate.
 */

/** @type {GuardLog} */
// A log that says nothing, for a caller that passed none. A caller with a partial logger wants
// normaliseLog instead, which fills the missing levels rather than discarding every message.
const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

const DEFAULT_REAPER_NAME = 'process-guard-reaper';
const REAPER_SCRIPT = fileURLToPath(new URL('./reaper.js', import.meta.url));

export { argvOf, identify } from './identity.js';
export { normaliseLog } from './log.js';
export { createHandleApplication, watchForNeverCalled } from './lifecycle.js';

/** Fingerprint of whatever forces replacement of a running process, as a number inside 2^31 so a host that parseInt()s it agrees. @param {...unknown} parts */
export function fingerprint(...parts) {
	return createHash('sha256').update(parts.map(String).join('\0')).digest().readUInt32BE(0) >>> 1;
}

/**
 * Start the reaper, or say why it was not. Never fatal: without one the processes merely outlive the host.
 *
 * @param {import('./supervise.js').Context} ctx @param {ReaperConfig} config
 * @returns {Promise<ReaperState>}
 */
async function launchReaper(ctx, config) {
	const name = config.name ?? DEFAULT_REAPER_NAME;
	/** @type {ReaperState} */
	const state = { name, started: false, adopted: false };
	const args = [
		REAPER_SCRIPT,
		'--host-pid',
		// A worker thread's process.pid IS the host process: threads share one.
		String(process.pid),
		'--pid-dir',
		ctx.pidDir,
		'--grace-ms',
		String(config.graceMs ?? 8000),
		'--self-lock',
		lockPath(ctx.pidDir, name),
		...(config.replacementPidFile ? ['--replacement-pid-file', config.replacementPidFile] : []),
		...(config.logFile ? ['--log', config.logFile] : []),
	];

	// A host that refuses the absolute interpreter path leaves the running reaper recorded under a bare
	// `node`, so expect whatever the lock already says whenever it names this same reaper.
	const held = readLock(lockPath(ctx.pidDir, name));
	const recorded = held?.argv ?? [];
	const sameReaper = recorded.length === args.length + 1 && args.every((arg, index) => recorded[index + 1] === arg);

	/** @type {import('./lock.js').Claim} */
	let claim;
	try {
		claim = await claimLock({
			pidDir: ctx.pidDir,
			name,
			version: ctx.version,
			argv: sameReaper ? recorded : [process.execPath, ...args],
			timeoutMs: ctx.claimTimeoutMs,
			stopOrphans: false,
		});
	} catch (error) {
		state.error = `the ${name} lock under ${ctx.pidDir} could not be taken: ${errorMessage(error)}`;
		ctx.log.error(`process guard: ${state.error}`);
		return state;
	}
	for (const note of claim.notes) ctx.report.push(note);

	if (claim.outcome === 'adopted') {
		state.adopted = true;
		state.started = true;
		state.pid = claim.pid;
		ctx.log.info(`process guard: a ${name} already runs on this node (pid ${claim.pid}); this thread joined it.`);
		return state;
	}

	// process.execPath first because PATH cannot shadow it; a bare `node` is what a host allowlist
	// tends to carry, and a host that matches an allowlist on the command string refuses anything else.
	/** @type {string[]} */
	const refusals = [];
	for (const command of [process.execPath, 'node']) {
		try {
			const child = ctx.spawn(command, args, {
				// Its own process group: a signal to the host's group (GNU `timeout` sends one) would
				// otherwise take down the very thing that has to outlive it.
				detached: true,
				stdio: 'ignore',
				...config.spawnOptions,
				// Last, so a caller's own spawnOptions cannot shadow the identity Harper's spawn gate checks against.
				name,
			});
			// Only a child with a pid is running, so only its 'error' is a signal or a send failing.
			child.on('error', (error) => {
				if (child.pid) ctx.log.error(`process guard: the ${name} failed to execute: ${error.message}`);
			});
			// No pid means the spawn failed asynchronously, which never throws here. Recorded as started it
			// pins the lock at pid 0 and skips the fallback command below, so the host leaves its processes.
			if (!child.pid) {
				refusals.push(`${command}: ${await startFailure(child)}`);
				continue;
			}
			// The same refusal the agents get: a host that reuses processes by name can answer with a pid
			// that is not a reaper, and a reaper that is not one stops nothing when the host goes.
			const handedBack = describeHandedBackPid(child, { argv: [command, ...args], binaryPath: REAPER_SCRIPT });
			if (handedBack) {
				refusals.push(`${command}: ${handedBack}`);
				continue;
			}
			state.started = true;
			state.pid = child.pid;
			state.command = command;
			const commitError = await safeLockWrite(
				commitLock(lockPath(ctx.pidDir, name), claim.token, child.pid, ctx.version, [command, ...args])
			);
			if (commitError) {
				state.error = `the ${name} lock could not be updated with its pid: ${commitError}`;
				ctx.log.error(`process guard: ${state.error}`);
			}
			child.unref();
			ctx.log.info(`process guard: ${name} started (pid ${child.pid}), watching what is locked under ${ctx.pidDir}.`);
			return state;
		} catch (error) {
			refusals.push(`${command}: ${errorMessage(error)}`);
		}
	}

	const releaseError = await safeLockWrite(releaseLock(lockPath(ctx.pidDir, name), claim.token));
	state.error = refusals.join('; ');
	if (releaseError) state.error += `; releasing its lock also failed: ${releaseError}`;
	const line =
		`the ${name} could not be started (${state.error}), so the guarded processes will keep running ` +
		`after this host stops. Permit ${process.execPath} or a bare \`node\` wherever this host filters spawns.`;
	ctx.log.warn(`process guard: ${line}`);
	ctx.report.push(line);
	return state;
}

/**
 * Take one lock per declared process, start what this thread wins and join what it does not, then keep
 * watching. `spawn` is injected rather than imported, which is what lets a host substitute its own.
 *
 * @param {object} options
 * @param {string} options.pidDir Where the locks live. One file per process, `<name>.pid`.
 * @param {readonly GuardedProcess[]} options.processes
 * @param {Spawn} options.spawn
 * @param {number} [options.version] Fingerprint written to the lock; a process under a different one is an orphan, not something to adopt.
 * @param {boolean} [options.stopOrphans] Whether an identified orphan may be signalled. Off by default: a signal sent on a wrong identification cannot be taken back.
 * @param {GuardLog} [options.log]
 * @param {ReaperConfig} [options.reaper] Omitted, no reaper is launched and the processes outlive the host.
 * @param {number} [options.claimTimeoutMs]
 * @returns {Promise<GuardResult>}
 */
export async function guard({
	pidDir,
	processes,
	spawn,
	version = 0,
	stopOrphans = false,
	log = SILENT,
	reaper,
	claimTimeoutMs = 30_000,
}) {
	/** @type {string[]} */
	const report = [];
	const run = { stopping: false };
	/** @type {import('./supervise.js').Context} */
	const ctx = { pidDir, spawn, version, stopOrphans, log, claimTimeoutMs, report, run, tuning: DEFAULT_TUNING };

	/** @type {ProcessState[]} */
	const states = [];
	for (const declared of processes) {
		const args = declared.args ?? [];
		states.push(
			await superviseProcess(ctx, {
				name: declared.name,
				title: declared.title ?? declared.name,
				binaryPath: declared.binaryPath,
				args,
				argv: [declared.binaryPath, ...args],
				spawnOptions: { stdio: 'ignore', ...declared.spawnOptions },
				...(declared.exitHint ? { exitHint: declared.exitHint } : {}),
			})
		);
	}

	// Before any verify: a probe can wait 30 seconds, and a host killed inside that window must not
	// leave the processes behind.
	const reaperState = reaper ? await launchReaper(ctx, reaper) : undefined;

	for (const [index, declared] of processes.entries()) {
		const state = states[index];
		if (!declared.verify || !state) continue;
		try {
			const { ok, detail } = await declared.verify(state);
			state.verified = ok;
			state.verifyDetail = detail;
			const line = `process guard: the ${state.title} ${ok ? 'verified' : 'failed verification'}${detail ? `: ${detail}` : '.'}`;
			if (ok) log.info(line);
			else log.error(line);
		} catch (error) {
			state.verified = false;
			state.verifyDetail = errorMessage(error);
			log.error(`process guard: the ${state.title} failed verification: ${state.verifyDetail}`);
		}
	}

	return {
		report,
		version,
		processes: states,
		...(reaperState ? { reaper: reaperState } : {}),
		stop: () => {
			run.stopping = true;
		},
	};
}
