// @ts-check
// One winner per node. The lock is only ever REPLACED by rename, never removed then recreated: check-then-delete
// is two steps, so a second thread can delete the winner's fresh file and both believe they hold it.
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';

import { errnoCode, errorMessage, identify, isAlive, waitWhileAlive } from './identity.js';

const POLL_MS = 2;
/** The gate is held across a read and a rename and nothing else, so a live holder is never in it long. */
const GATE_RETRY_MS = 1;
const GATE_WAIT_MS = 2000;
const STOP_GRACE_MS = 5000;
const GATE_SUFFIX = '.claiming';

/**
 * @typedef {object} Lock
 * @property {number} pid The guarded process, or 0 while the claimant has not started one yet.
 * @property {number} version Fingerprint of the configuration that started it.
 * @property {string} token The claimant's own mark; nothing may overwrite a lock carrying another's.
 * @property {number} host Pid of the process holding the claim, so a waiter can tell a dead claimant.
 * @property {readonly string[]} argv What was spawned, so a later reader can identify the pid before acting.
 */

/**
 * @typedef {{ outcome: 'won', token: string, notes: string[] }
 *   | { outcome: 'adopted', pid: number, notes: string[] }} Claim
 */

let serial = 0;

/** @param {string} pidDir @param {string} name @returns {string} */
export function lockPath(pidDir, name) {
	return join(pidDir, `${name}.pid`);
}

/** @param {string} path */
export function unlinkQuietly(path) {
	try {
		unlinkSync(path);
	} catch {
		// Absent is the outcome asked for.
	}
}

/** @param {Lock} lock @returns {string} */
function serialise(lock) {
	const record = { token: lock.token, host: lock.host, argv: lock.argv };
	return `${lock.pid}\n${lock.version}\n${JSON.stringify(record)}\n`;
}

/**
 * pid on line 1 and version on line 2, so a host reading only those two still reads this file. Line 3
 * is this guard's own record, and its absence marks a lock the guard did not write.
 *
 * @param {string} path
 * @returns {Lock | null}
 */
export function readLock(path) {
	/** @type {string[]} */
	let lines;
	try {
		lines = readFileSync(path, 'utf-8').split('\n');
	} catch {
		return null;
	}
	const pid = Number.parseInt(lines[0] ?? '', 10);
	if (!Number.isInteger(pid)) return null;
	const version = Number.parseInt(lines[1] ?? '', 10);
	/** @type {Lock} */
	const lock = { pid, version: Number.isInteger(version) ? version : 0, token: '', host: 0, argv: [] };
	try {
		const record = /** @type {unknown} */ (JSON.parse(lines[2] ?? ''));
		if (typeof record !== 'object' || record === null) return lock;
		const { token, host, argv } = /** @type {{ token?: unknown; host?: unknown; argv?: unknown }} */ (record);
		if (typeof token === 'string') lock.token = token;
		if (typeof host === 'number' && Number.isInteger(host)) lock.host = host;
		if (Array.isArray(argv) && argv.every((/** @type {unknown} */ a) => typeof a === 'string')) {
			lock.argv = /** @type {string[]} */ (argv);
		}
	} catch {
		// Absent, half-written, or written by something that is not this guard. Either way, no record.
	}
	return lock;
}

/** Replace the lock where it stands. rename(2) is atomic, so a reader meets the old one or the new one. @param {string} path @param {Lock} lock */
function publish(path, lock) {
	const temp = `${path}.${lock.token}.tmp`;
	writeFileSync(temp, serialise(lock), 'utf-8');
	renameSync(temp, path);
}

/**
 * A lock on the lock: while it is held, one thread and no other decides what happens to `path`. That
 * exclusion is what turns a read followed by a write into one step.
 *
 * @param {string} path @param {boolean} expired Whether the caller's whole budget has run out.
 */
function takeGate(path, expired) {
	const gate = `${path}${GATE_SUFFIX}`;
	const temp = `${gate}.${process.pid}.${threadId}.${++serial}`;
	try {
		// Written before it is linked, so the gate names its holder the instant it exists. A gate that were
		// empty for even a moment would read as abandoned to whoever looked inside that moment.
		writeFileSync(temp, String(process.pid), 'utf-8');
		linkSync(temp, gate);
		return true;
	} catch (error) {
		if (errnoCode(error) !== 'EEXIST') throw error;
	} finally {
		unlinkQuietly(temp);
	}

	let holder = 0;
	try {
		holder = Number.parseInt(readFileSync(gate, 'utf-8'), 10);
	} catch {
		// It went while being read, which is the outcome asked for.
	}
	// A gate whose holding process is gone, or one that outlived the caller's whole budget, is not a gate.
	if (expired || !isAlive(holder)) unlinkQuietly(gate);
	return false;
}

/**
 * Hold the gate for `decide`, which must not await: the gate blocks every other thread's view of this
 * lock, so anything slow belongs outside it. null means the gate was not free.
 *
 * @template T
 * @param {string} path @param {boolean} expired @param {() => T} decide @returns {T | null}
 */
function underGate(path, expired, decide) {
	if (!takeGate(path, expired)) return null;
	try {
		return decide();
	} finally {
		unlinkQuietly(`${path}${GATE_SUFFIX}`);
	}
}

/** @param {readonly string[]} a @param {readonly string[]} b */
function sameArgv(a, b) {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * SIGTERM and then report what happened. No SIGKILL: by the deadline the pid may name something else.
 *
 * @param {number} pid @param {string} name @param {Set<string>} notes
 */
async function stopOrphan(pid, name, notes) {
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		// ESRCH: it went between the identification and the signal, which is the outcome asked for.
	}
	await waitWhileAlive(pid, Date.now() + STOP_GRACE_MS, POLL_MS);
	notes.add(
		isAlive(pid)
			? `${name}: pid ${pid} did not exit after SIGTERM, so it may still hold what its replacement needs.`
			: `${name}: stopped pid ${pid}, an orphan left by an earlier configuration.`
	);
}

/**
 * What to do about the lock as it stands. Reads the world and changes none of it, so the gate is held
 * for a read and a rename rather than for a signal and its grace period.
 *
 * @param {Lock | null} held
 * @param {{ name: string, version: number, argv: readonly string[], stopOrphans: boolean, expired: boolean, notes: Set<string> }} against
 * @returns {{ act: 'take' | 'wait' } | { act: 'adopt' | 'stop', pid: number }}
 */
export function adjudicate(held, { name, version, argv, stopOrphans, expired, notes }) {
	if (!held) return { act: 'take' };

	if (held.pid === 0) {
		// A claim another thread has not finished. Wait for it to name its process rather than race it; a
		// claimant whose process is gone, or one that never finished, has left a lock nobody will complete.
		if (isAlive(held.host) && !expired) return { act: 'wait' };
		notes.add(`${name}: took over an unfinished claim from pid ${held.host}.`);
		return { act: 'take' };
	}

	if (!isAlive(held.pid)) {
		notes.add(`${name}: reclaimed the lock from pid ${held.pid}, which nothing holds.`);
		return { act: 'take' };
	}

	const running = identify(held.pid, held.argv);
	if (running !== 'match') {
		notes.add(
			`${name}: the lock named live pid ${held.pid}, which ` +
				`${running === 'differs' ? 'is running something else' : 'could not be identified here'}. ` +
				`Taking the lock and signalling nothing.`
		);
		return { act: 'take' };
	}

	if (held.version === version && sameArgv(held.argv, argv)) {
		notes.add(`${name}: joined the running pid ${held.pid} rather than starting a second one.`);
		return { act: 'adopt', pid: held.pid };
	}

	// Ours by command line, under a configuration this node no longer runs.
	if (stopOrphans) return { act: 'stop', pid: held.pid };
	const drift =
		held.version === version
			? `a command line this node no longer uses (${held.argv.join(' ')})`
			: `version ${held.version}, not ${version}`;
	notes.add(
		`${name}: pid ${held.pid} is an orphan of an earlier configuration (${drift}). stopOrphans is off, ` +
			`so it was left running and may still hold what its replacement needs.`
	);
	return { act: 'take' };
}

/**
 * Take `<pidDir>/<name>.pid`, or join whatever already holds it. A caller that wins must call
 * commitLock once it has a pid; until then the lock reads pid 0 and other threads wait on it.
 *
 * @param {object} options
 * @param {string} options.pidDir
 * @param {string} options.name Lock filename stem, and how the notes name this process.
 * @param {number} options.version
 * @param {readonly string[]} options.argv What this node would spawn; also what identifies the pid later.
 * @param {number} [options.timeoutMs] How long to wait on another thread's unfinished claim.
 * @param {boolean} [options.stopOrphans] Whether an identified orphan may be signalled. Off by default.
 * @returns {Promise<Claim>}
 */
export async function claimLock({ pidDir, name, version, argv, timeoutMs = 30_000, stopOrphans = false }) {
	mkdirSync(pidDir, { recursive: true });
	const path = lockPath(pidDir, name);
	const token = `${process.pid}.${threadId}.${++serial}.${Date.now().toString(36)}`;
	// A set, because a thread that loops around the gate re-adjudicates and would say the same thing twice.
	/** @type {Set<string>} */
	const notes = new Set();
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const expired = Date.now() >= deadline;
		const verdict = underGate(path, expired, () => {
			const decision = adjudicate(readLock(path), { name, version, argv, stopOrphans, expired, notes });
			if (decision.act === 'take') publish(path, { pid: 0, version, token, host: process.pid, argv });
			return decision;
		});

		if (verdict === null) await delay(GATE_RETRY_MS);
		else if (verdict.act === 'take') return { outcome: 'won', token, notes: [...notes] };
		else if (verdict.act === 'adopt') return { outcome: 'adopted', pid: verdict.pid, notes: [...notes] };
		// Signalled outside the gate: its grace period must not block every other thread's view of this
		// lock. The pass after it finds a dead pid and reclaims the lock in the ordinary way.
		else if (verdict.act === 'stop') await stopOrphan(verdict.pid, name, notes);
		else await delay(POLL_MS);
	}
}

/**
 * Record the pid this claim started, while the lock is still ours. A claimant that was taken over must
 * not stamp its pid onto the winner's file.
 *
 * @param {string} path @param {string} token @param {number} pid @param {number} version @param {readonly string[]} argv
 * @returns {Promise<boolean>}
 */
export function commitLock(path, token, pid, version, argv) {
	return writeUnderGate(path, (held) => {
		if (held?.token !== token) return false;
		publish(path, { pid, version, token, host: process.pid, argv });
		return true;
	});
}

/**
 * Remove the lock only while it is still ours. This is the one place a lock is removed rather than
 * replaced: the process it named was shut down on purpose, and nothing should adopt it.
 *
 * @param {string} path @param {string} token @returns {Promise<boolean>}
 */
export function releaseLock(path, token) {
	return writeUnderGate(path, (held) => {
		if (held?.token !== token) return false;
		unlinkQuietly(path);
		return true;
	});
}

/**
 * Await a commitLock or releaseLock write that must never throw past this point: every caller sits
 * behind a fire-and-forget death handler or a catch block already reporting a different failure. A
 * resolved `false` is as much a failure as a throw: it means the token this caller held no longer
 * matched what commitLock or releaseLock found on disk, so nothing was written.
 *
 * @param {Promise<boolean>} write @returns {Promise<string | undefined>} The failure message, or undefined.
 */
export async function safeLockWrite(write) {
	try {
		return (await write) ? undefined : 'the lock changed hands before this write landed';
	} catch (error) {
		return errorMessage(error);
	}
}

/** @param {string} path @param {(held: Lock | null) => boolean} write @returns {Promise<boolean>} */
async function writeUnderGate(path, write) {
	// A gate is held for two syscalls, so this waits it out rather than giving up. The budget matters
	// only when the process holding it died mid-decision.
	const deadline = Date.now() + GATE_WAIT_MS;
	for (;;) {
		const done = underGate(path, Date.now() >= deadline, () => write(readLock(path)));
		if (done !== null) return done;
		await delay(GATE_RETRY_MS);
	}
}
