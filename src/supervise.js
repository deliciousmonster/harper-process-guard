// @ts-check
// What a thread does once the lock is settled. A thread that only joined still watches and still
// answers a death, because a joiner that reports success and then supervises nothing is the defect.
import { accessSync, constants, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { errorMessage, isAlive } from './identity.js';
import { claimLock, commitLock, lockPath, releaseLock } from './lock.js';

/** Exits that mean somebody shut it down. Restarting into one of these fights the operator. */
const DELIBERATE = new Set(['exit code 0', 'signal SIGTERM', 'signal SIGINT', 'signal SIGHUP']);

/**
 * @typedef {object} Tuning
 * @property {number} deathPollMs Liveness cadence backing every watch. Not sub-second: this reports a death rather than reacting to one, and on darwin each check forks a `ps`.
 * @property {number} restartMax
 * @property {number} restartBaseMs
 * @property {number} restartCapMs
 */

/** @type {Tuning} */
export const DEFAULT_TUNING = { deathPollMs: 2000, restartMax: 5, restartBaseMs: 1000, restartCapMs: 30_000 };

/** @typedef {import('node:child_process').ChildProcess} SpawnedChild */

/**
 * The caller's spawn, injected rather than imported: that is what makes this testable with a fake and
 * usable by a host that hands out a constrained child_process.
 *
 * @typedef {(command: string, args: string[], options: import('node:child_process').SpawnOptions) => SpawnedChild} Spawn
 */

/**
 * @typedef {object} GuardLog
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 * @property {(message: string) => void} error
 */

/**
 * @typedef {object} Descriptor
 * @property {string} name Lock filename stem.
 * @property {string} title How messages name it.
 * @property {string} binaryPath
 * @property {readonly string[]} args
 * @property {readonly string[]} argv `[binaryPath, ...args]`, which is the process's identity.
 * @property {import('node:child_process').SpawnOptions} spawnOptions
 * @property {string} [exitHint] Appended to the non-zero-exit report, for the caller's domain knowledge.
 */

/**
 * @typedef {object} ProcessState
 * @property {string} name
 * @property {string} title
 * @property {number | undefined} [pid]
 * @property {boolean} started
 * @property {boolean} adopted True when this thread joined a process another thread started.
 * @property {boolean} exited True once this thread has seen it die, so a status surface stops reading healthy.
 * @property {number} restarts
 * @property {string | undefined} [error]
 * @property {boolean} [verified] Set from the caller's verify().
 * @property {string | undefined} [verifyDetail]
 */

/**
 * @typedef {object} Context
 * @property {string} pidDir
 * @property {Spawn} spawn
 * @property {number} version
 * @property {boolean} stopOrphans
 * @property {GuardLog} log
 * @property {number} claimTimeoutMs
 * @property {string[]} report
 * @property {Tuning} tuning
 * @property {{ stopping: boolean }} run Set by the caller's stop(), so no restart outruns a shutdown.
 */

/** Unref'd so nothing here holds the host open; outliving the host is the reaper's job. @param {number} ms */
const backoff = (ms) => delay(ms, undefined, { ref: false });

/** Refuse a binary that is not there or not executable. spawn's own failure arrives asynchronously and names less. @param {string} binaryPath */
function preflight(binaryPath) {
	if (!binaryPath) throw new Error('its path could not be resolved');
	if (!existsSync(binaryPath)) throw new Error(`${binaryPath} is missing`);
	accessSync(binaryPath, constants.X_OK);
}

/** @param {SpawnedChild} child @returns {Promise<string>} */
function watchChild(child) {
	return new Promise((resolve) => {
		child.on('exit', (code, signal) => resolve(signal ? `signal ${signal}` : `exit code ${code}`));
	});
}

/** @param {number} ms @param {string} value @returns {Promise<string>} */
function after(ms, value) {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
}

// A host may return a wrapper rather than a ChildProcess, whose 'exit' fires late or never- the poll backstops but
// yields to the event alone naming an exit code, so reading it first would misread a deliberate shutdown as a crash.
/** @param {SpawnedChild} child @param {number} pid @param {number} pollMs @returns {Promise<string>} */
function watchProcess(child, pid, pollMs) {
	const event = typeof child?.on === 'function' ? watchChild(child) : null;
	if (pid <= 0) {
		if (!event) throw new Error('the spawned process reported neither a pid nor an exit event');
		return event;
	}
	const backstop = watchPid(pid, pollMs).then((reason) =>
		event ? Promise.race([event, after(pollMs, reason)]) : reason
	);
	return event ? Promise.race([event, backstop]) : backstop;
}

/** Liveness is the signal a joined process has, and the backstop for one this thread started. @param {number} pid @param {number} pollMs @returns {Promise<string>} */
function watchPid(pid, pollMs) {
	return new Promise((resolve) => {
		const timer = setInterval(() => {
			if (isAlive(pid)) return;
			clearInterval(timer);
			resolve('a liveness poll found the pid dead');
		}, pollMs);
		timer.unref();
	});
}

/**
 * One turn of the lifecycle: settle the lock, then start or join, then watch. Resolves once the
 * process is running or has been refused; the watch that follows outlives this call.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state @param {number} restarts
 */
async function attempt(ctx, descriptor, state, restarts) {
	state.restarts = restarts;
	state.exited = false;
	state.started = false;
	state.pid = undefined;
	state.error = undefined;

	const path = lockPath(ctx.pidDir, descriptor.name);
	/** @type {import('./lock.js').Claim} */
	let claim;
	try {
		claim = await claimLock({
			pidDir: ctx.pidDir,
			name: descriptor.name,
			version: ctx.version,
			argv: descriptor.argv,
			timeoutMs: ctx.claimTimeoutMs,
			stopOrphans: ctx.stopOrphans,
		});
	} catch (error) {
		state.error = `the ${descriptor.name} lock under ${ctx.pidDir} could not be taken: ${errorMessage(error)}`;
		ctx.log.error(`process guard: ${state.error}`);
		if (restarts === 0) ctx.report.push(state.error);
		return;
	}
	for (const note of claim.notes) {
		ctx.log.warn(`process guard: ${note}`);
		if (restarts === 0) ctx.report.push(note);
	}

	if (claim.outcome === 'adopted') {
		state.pid = claim.pid;
		state.started = true;
		state.adopted = true;
		ctx.log.info(
			`process guard: the ${state.title} already runs on this node (pid ${claim.pid}); this thread joined it.`
		);
		void answerDeath(ctx, descriptor, state, restarts, watchPid(claim.pid, ctx.tuning.deathPollMs), null);
		return;
	}

	try {
		preflight(descriptor.binaryPath);
	} catch (error) {
		state.error = `cannot start the ${state.title}: ${errorMessage(error)}`;
		ctx.log.error(`process guard: ${state.error}`);
		if (restarts === 0) ctx.report.push(state.error);
		await releaseLock(path, claim.token);
		return;
	}

	/** @type {SpawnedChild} */
	let child;
	try {
		child = ctx.spawn(descriptor.binaryPath, [...descriptor.args], descriptor.spawnOptions);
	} catch (error) {
		state.error = `the spawn of the ${state.title} was refused: ${errorMessage(error)}`;
		ctx.log.error(`process guard: ${state.error} (${descriptor.binaryPath})`);
		if (restarts === 0) ctx.report.push(state.error);
		await releaseLock(path, claim.token);
		return;
	}

	// Attached before anything else: an unhandled 'error' on a ChildProcess takes the worker thread down.
	child.on('error', (error) => ctx.log.error(`process guard: the ${state.title} failed to execute: ${error.message}`));
	const death = watchProcess(child, child.pid ?? 0, ctx.tuning.deathPollMs);
	state.pid = child.pid;
	state.started = true;
	state.adopted = false;
	await commitLock(path, claim.token, child.pid ?? 0, ctx.version, descriptor.argv);
	ctx.log.info(`process guard: started the ${state.title} (pid ${child.pid}): ${descriptor.argv.join(' ')}.`);
	void answerDeath(ctx, descriptor, state, restarts, death, claim.token);
}

/**
 * The one path for every death, whichever thread saw it. Going back through the lock is what answers
 * all four cases: this thread restarts a death nobody owns, and joins whatever another thread started.
 *
 * @param {Context} ctx @param {Descriptor} descriptor @param {ProcessState} state @param {number} restarts
 * @param {Promise<string>} death @param {string | null} token The owner's lock token; null when this thread only joined.
 */
async function answerDeath(ctx, descriptor, state, restarts, death, token) {
	const cause = await death;
	if (ctx.run.stopping) return;
	state.exited = true;
	const path = lockPath(ctx.pidDir, descriptor.name);
	const hint = cause.startsWith('exit code') && descriptor.exitHint ? ` ${descriptor.exitHint}` : '';

	if (token !== null && DELIBERATE.has(cause)) {
		// The owner keeps its lock across a crash, so a joiner can tell a death nobody answered from one
		// already in hand. A deliberate stop is the one case where the lock goes.
		await releaseLock(path, token);
		ctx.log.info(`process guard: the ${state.title} (pid ${state.pid}) was shut down (${cause}); not restarting it.`);
		return;
	}
	if (token === null && !existsSync(path)) {
		ctx.log.info(
			`process guard: the ${state.title} (pid ${state.pid}) is gone (${cause}) and its lock with it, so ` +
				`whichever thread held it has answered this death; this thread is not starting a replacement.`
		);
		return;
	}
	if (restarts + 1 > ctx.tuning.restartMax) {
		state.error = `died ${restarts + 1} times (${cause}); not restarting it again`;
		ctx.log.error(
			`process guard: the ${state.title} ${state.error}. What it provided is missing from this node ` +
				`until the component reloads.${hint}`
		);
		return;
	}

	const wait = Math.min(ctx.tuning.restartBaseMs * 2 ** restarts, ctx.tuning.restartCapMs);
	ctx.log.warn(
		`process guard: the ${state.title} (pid ${state.pid}) is gone (${cause}). Going back through the ` +
			`lock in ${wait}ms: this thread restarts it if nothing else has, and joins it if something ` +
			`already did (attempt ${restarts + 1} of ${ctx.tuning.restartMax}).${hint}`
	);
	await backoff(wait);
	if (ctx.run.stopping) return;
	await attempt(ctx, descriptor, state, restarts + 1);
}

/**
 * Start `descriptor` if this thread wins its lock, join it if another thread already holds it, and
 * watch it either way.
 *
 * @param {Context} ctx @param {Descriptor} descriptor
 * @returns {Promise<ProcessState>}
 */
export async function superviseProcess(ctx, descriptor) {
	/** @type {ProcessState} */
	const state = {
		name: descriptor.name,
		title: descriptor.title,
		started: false,
		adopted: false,
		exited: false,
		restarts: 0,
	};
	await attempt(ctx, descriptor, state, 0);
	return state;
}
