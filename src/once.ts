// Worker threads share no primitive but the filesystem, and losers must block until the work FINISHES, not merely dedupe it.
// Staleness is judged by process identity, not age: the marker outlives the container on a persistent volume, and a restart reuses the same small pid.
import { openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';

import { errnoCode } from './errors.js';
import { processStartToken } from './identity.js';

/** How often a waiting thread re-reads the marker. */
const POLL_INTERVAL_MS = 25;

/** Sibling threads derive startedAt microseconds apart; a previous boot differs by a whole restart. Wide on purpose: an exact comparison splits one process into two. */
const SAME_PROCESS_TOLERANCE_MS = 5000;

/** Identity of the Harper process, agreed by every one of its threads without coordination. */
export interface ProcessIdentity {
	readonly pid: number;
	/** The OS's recorded start, when the platform has one. Compared for exact equality. */
	readonly token?: string | null;
	/** Derived fallback, only consulted when `token` is absent on both sides. */
	readonly startedAt: number;
}

export function currentProcess(): ProcessIdentity {
	return {
		pid: process.pid,
		token: processStartToken(),
		startedAt: Math.round(Date.now() - process.uptime() * 1000),
	};
}

/** Token compared exactly (OS-recorded, clock-immune). startedAt only when no token: a clock step past the tolerance splits one process, a restart inside it merges two. */
function isSameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
	if (a.pid !== b.pid) return false;
	if (a.token != null && b.token != null) return a.token === b.token;
	return Math.abs(a.startedAt - b.startedAt) < SAME_PROCESS_TOLERANCE_MS;
}

interface Marker extends ProcessIdentity {
	/** Set by the winner only after the work has returned. */
	readonly done: boolean;
	/** Thread that claimed it, for the report. Never used for a decision. */
	readonly thread: number;
}

function readMarker(path: string): Marker | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
		if (typeof parsed !== 'object' || parsed === null) return null;
		if (!('pid' in parsed) || typeof parsed.pid !== 'number') return null;
		if (!('startedAt' in parsed) || typeof parsed.startedAt !== 'number') return null;
		// Field by field rather than one cast, because `done` is what releases waiters: it has
		// to mean boolean true, never whatever truthy value a mangled file happens to carry.
		return {
			pid: parsed.pid,
			startedAt: parsed.startedAt,
			token: 'token' in parsed && typeof parsed.token === 'string' ? parsed.token : null,
			done: 'done' in parsed && parsed.done === true,
			thread: 'thread' in parsed && typeof parsed.thread === 'number' ? parsed.thread : -1,
		};
	} catch {
		// Absent, unreadable, half-written or not JSON. All mean "no usable claim", and a
		// half-written marker is possible because the winner writes it in two steps.
		return null;
	}
}

/** Publish a marker so no reader can observe a partial write. */
function writeMarker(path: string, marker: Marker): void {
	const temp = `${path}.${marker.pid}.${marker.thread}.tmp`;
	writeFileSync(temp, JSON.stringify(marker));
	renameSync(temp, path);
}

export type OnceOutcome<T = unknown> =
	/** This thread ran the work. */
	| { ran: true; result: T }
	/** Another thread of this process ran it, and it has finished. */
	| { ran: false; waited: true }
	/** Nobody ran it here. The caller must decide whether its precondition holds. */
	| { ran: false; waited: false; reason: 'timed-out' | 'failed-elsewhere' };

/** Run `work` once per process, blocking siblings until it finishes. timeoutMs must cover the work (an early giver-up rejoins the race); `identity` closes platforms with no start token; a thrown `work` unlinks the marker so the next thread retries. */
export async function oncePerProcess<T>(
	dir: string,
	key: string,
	work: () => Promise<T>,
	{ timeoutMs = 60_000, identity }: { timeoutMs?: number; identity?: ProcessIdentity | undefined } = {}
): Promise<OnceOutcome<T>> {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `.${key}.once`);
	const me = identity ?? currentProcess();
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		// Atomic create-if-absent. The only primitive here that is a true test-and-set.
		try {
			closeSync(openSync(path, 'wx'));
		} catch (error) {
			if (errnoCode(error) !== 'EEXIST') throw error;

			const marker = readMarker(path);
			if (marker && isSameProcess(marker, me) && marker.done) return { ran: false, waited: true };

			// Above the branch dispatch so every arm is bounded: a marker in an unwritable directory must time out, not spin without yielding.
			if (Date.now() >= deadline) return { ran: false, waited: false, reason: 'timed-out' };

			if (marker && isSameProcess(marker, me)) {
				await delay(POLL_INTERVAL_MS);
				continue;
			}

			if (marker === null) {
				// Wait a poll, then re-read: the second read is the compare half of a CAS unlinkSync
				// lacks, so a winner's just-created empty file is not stolen.
				await delay(POLL_INTERVAL_MS);
				if (readMarker(path) === null) tryUnlink(path);
				continue;
			}

			// Another process's marker is a previous boot, not a peer: Harper refuses to start
			// beside a live hdb.pid. A failed unlink is terminal; retrying EACCES/EROFS is what wedged a thread.
			if (!tryUnlink(path)) return { ran: false, waited: false, reason: 'failed-elsewhere' };
			await delay(POLL_INTERVAL_MS);
			continue;
		}

		// Won. Publish the claim before doing the work, so waiters see a claim rather than an
		// empty file, then publish completion only after the work has actually returned.
		const claim: Marker = { ...me, done: false, thread: threadId };
		writeMarker(path, claim);
		try {
			const result = await work();
			writeMarker(path, { ...claim, done: true });
			return { ran: true, result };
		} catch (error) {
			// Unlink on throw, or every sibling waits out the deadline against a claim nobody will complete.
			tryUnlink(path);
			throw error;
		}
	}
}

/** True when the marker is gone (ENOENT counts as success); false so callers report instead of spinning. */
function tryUnlink(path: string): boolean {
	try {
		unlinkSync(path);
		return true;
	} catch (error) {
		return errnoCode(error) === 'ENOENT';
	}
}
