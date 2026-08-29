/**
 * Run something exactly once per Harper process, and hold every other worker thread until it
 * has finished.
 *
 * Harper runs worker THREADS sharing one OS process, and every thread evaluates every
 * component. So a component that wants to do one piece of setup for the node has eight
 * threads arriving at it simultaneously with no coordination primitive between them: no
 * cross-thread lock, no leader, and a `let done = false` module variable that is per-thread
 * and therefore useless. A file is the only thing all eight can see.
 *
 * Two properties, and the second is the one that is easy to miss. Exactly one thread runs the
 * work, which merely avoids duplicate effort. And no thread returns before the work has
 * finished, which is a correctness requirement whenever the work establishes a precondition
 * the callers depend on. A barrier that lets losers past immediately protects only the thread
 * that ran it.
 *
 * Staleness is decided on process identity rather than on a timeout, because the marker lives
 * in Harper's data root and that root is a persistent volume: it outlives the container, and a
 * container restart hands the entrypoint the same small pid it had last time. A marker named
 * or keyed by pid alone is therefore indistinguishable from one this process wrote, which is
 * pid reuse defeating a file, the same defect this whole area exists to fix.
 */
import { openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';

import { processStartToken } from './identity.js';

/** How often a waiting thread re-reads the marker. */
const POLL_INTERVAL_MS = 25;

/**
 * Tolerance when comparing process start times.
 *
 * Each thread derives the start time as `Date.now() - process.uptime() * 1000`, which is the
 * same instant computed from two clocks read microseconds apart, so sibling threads differ by
 * well under a millisecond. A previous boot differs by at least the time it took to restart.
 * Anything between is not a case that occurs, so the tolerance is wide on purpose: an exact
 * comparison would make two threads of one process disagree about whose marker it is.
 */
const SAME_PROCESS_TOLERANCE_MS = 5000;

/** Identity of the Harper process, agreed by every one of its threads without coordination. */
export interface ProcessIdentity {
	pid: number;
	/** The OS's recorded start, when the platform has one. Compared for exact equality. */
	token?: string | null;
	/** Derived fallback, only consulted when `token` is absent on both sides. */
	startedAt: number;
}

export function currentProcess(): ProcessIdentity {
	return {
		pid: process.pid,
		token: processStartToken(),
		startedAt: Math.round(Date.now() - process.uptime() * 1000),
	};
}

/**
 * Whether two identities describe the same Harper process.
 *
 * The token is preferred and compared exactly, because the OS records it at exec and never
 * recomputes it: a clock step cannot move it, and there is nothing to tolerate. The derived
 * startedAt remains only for platforms with no token, where the tolerance is unavoidable and
 * its failure mode is known: a wall-clock step larger than the tolerance splits one process
 * into two identities, and a restart faster than the tolerance merges two into one.
 */
function isSameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
	if (a.pid !== b.pid) return false;
	if (a.token != null && b.token != null) return a.token === b.token;
	return Math.abs(a.startedAt - b.startedAt) < SAME_PROCESS_TOLERANCE_MS;
}

interface Marker extends ProcessIdentity {
	/** Set by the winner only after the work has returned. */
	done: boolean;
	/** Thread that claimed it, for the report. Never used for a decision. */
	thread: number;
}

function readMarker(path: string): Marker | null {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Marker;
		return typeof parsed?.pid === 'number' && typeof parsed?.startedAt === 'number' ? parsed : null;
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

export type OnceOutcome =
	/** This thread ran the work. */
	| { ran: true; result: unknown }
	/** Another thread of this process ran it, and it has finished. */
	| { ran: false; waited: true }
	/** Nobody ran it here. The caller must decide whether its precondition holds. */
	| { ran: false; waited: false; reason: 'timed-out' | 'failed-elsewhere' };

/**
 * Run `work` once per Harper process, blocking other threads until it completes.
 *
 * @param timeoutMs how long a waiting thread will hold before giving up and reporting
 *   `timed-out`. Give this a value derived from what the work can actually take; a waiter
 *   that gives up early releases threads into precisely the race the barrier exists to stop.
 * @param identity overrides how this process identifies itself. Worth supplying wherever the
 *   OS exposes no start token, which today means Windows: the derived fallback mixes a wall
 *   clock with a monotonic one, so a clock step larger than the tolerance splits one process
 *   into two identities and a restart faster than it merges two into one. A caller that can
 *   read a value written once per start, and read the same bytes from every thread, closes
 *   that without this module having to learn another platform. `harperIdentity()` does exactly
 *   that from Harper's own hdb.pid.
 *
 * The failure of the winner is deliberately not hidden. If `work` throws, the marker is
 * removed so a later thread retries rather than every thread waiting out the deadline against
 * a claim nobody is honouring, and the exception propagates to the thread that ran it.
 */
export async function oncePerProcess<T>(
	dir: string,
	key: string,
	work: () => Promise<T>,
	{ timeoutMs = 60_000, identity }: { timeoutMs?: number; identity?: ProcessIdentity } = {}
): Promise<OnceOutcome> {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `.${key}.once`);
	const me = identity ?? currentProcess();
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		// Atomic create-if-absent. The only primitive here that is a true test-and-set.
		try {
			closeSync(openSync(path, 'wx'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

			const marker = readMarker(path);
			if (marker && isSameProcess(marker, me) && marker.done) return { ran: false, waited: true };

			// Above the branch dispatch so every arm is bounded: a marker in an unwritable directory must time out, not spin without yielding.
			if (Date.now() >= deadline) return { ran: false, waited: false, reason: 'timed-out' };

			if (marker && isSameProcess(marker, me)) {
				await delay(POLL_INTERVAL_MS);
				continue;
			}

			// Either a marker from a previous boot, or the empty file a winner creates before
			// it publishes its claim. Both resolve by waiting briefly and looking again; only
			// a marker that stays unclaimed is removed, which keeps this from stealing a
			// live claim during the microseconds between the create and the write.
			if (marker === null) {
				// The empty file a winner creates before it publishes its claim, or a truncated
				// write. Waiting and looking again is what keeps this from stealing a live claim
				// during the microseconds between the create and the write; the second read is
				// the compare half of a compare-and-swap that unlinkSync cannot do itself.
				await delay(POLL_INTERVAL_MS);
				if (readMarker(path) === null) tryUnlink(path);
				continue;
			}

			// A different process wrote this. Harper refuses to start while another Harper
			// holds hdb.pid, so this is a previous boot rather than a peer, and its claim is
			// void whether or not its pid happens to be alive again today.
			//
			// A failed removal is terminal rather than retried: no number of attempts fixes
			// EACCES or EROFS, and retrying one is what wedged a thread.
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
			// Leaving the marker would tombstone this key for the life of the process: every
			// other thread would wait out the deadline against a claim that will never be
			// completed. Removing it lets the next thread through retry.
			tryUnlink(path);
			throw error;
		}
	}
}

/**
 * Remove a marker, reporting whether it is actually gone.
 *
 * ENOENT is success: another thread removed it, which is the outcome asked for. Anything else
 * means the file is still there, and a caller that retried on that would spin forever, so the
 * distinction is returned rather than swallowed.
 */
function tryUnlink(path: string): boolean {
	try {
		unlinkSync(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT';
	}
}
