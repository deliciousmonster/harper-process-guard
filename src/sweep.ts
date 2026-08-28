/**
 * Clear the PID locks a previous Harper left behind, before this one spawns anything.
 *
 * Harper's `acquirePidFileLock` treats a lock as valid when `process.kill(pid, 0)` says some
 * process holds the recorded number. Nothing checks that the process is the one the lock
 * names, so a lock that outlived its writer is adopted by whoever inherits its pid and the
 * process it names is never started. Observed shape: two lock files both recording pid 964,
 * one child process answering to both names, the other never started, and the component
 * reporting success.
 *
 * Two rules govern everything here.
 *
 * Nothing is signalled without a positive identification. "Cannot tell" and "not ours" are
 * different answers and only one of them permits a signal. A sweep that guesses is the defect
 * it was written to remove, with a SIGTERM attached.
 *
 * Every destructive step revalidates immediately before acting. The lock is read, a decision
 * is made, and between those two the world can change: the recorded process can exit and its
 * pid be reused, or a sibling can write a new lock. Re-reading and requiring the same pid
 * turns a wide window into a narrow one and makes the failure "skipped" rather than "killed
 * the wrong thing".
 *
 * This must run inside oncePerProcess(), which is what guarantees no thread of this process
 * reaches spawn() while it is running. Without that, a sweep can meet a healthy process a
 * sibling started moments earlier and cannot tell it from an orphan, because it genuinely is
 * our binary and this process genuinely did not record starting it.
 */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { identificationCanAuthoriseSignal, identify, isAlive, readLock } from './identity.js';

/** How long an identified orphan gets to exit after SIGTERM before it is reported as staying. */
const STOP_TIMEOUT_MS = 5000;
const STOP_POLL_MS = 50;

export interface SweepTarget {
	/** Harper's spawn `name`, which is the lock filename without `.pid`. */
	name: string;
	/** Absolute path of the binary, used to identify an orphan. Resolve it before calling. */
	binaryPath: string;
	/**
	 * The `version` this caller is about to pass to Harper's spawn, when it passes one.
	 *
	 * This is what separates an orphan from a handover, and without it the sweep gets that
	 * backwards. `harper restart` deliberately leaves the old node's children running so the
	 * replacement adopts them, and Harper adopts on a version MATCH. So a live process running
	 * our binary under a lock whose version still matches is not an orphan at all; it is the
	 * process this node is about to inherit, and stopping it drops whatever it was carrying.
	 * Only a mismatch means the lock describes a configuration that no longer exists.
	 */
	version?: number;
}

export type SweepAction =
	| { name: string; pid: number; action: 'removed-dead' }
	/** Ours, alive, and still current. Left running for this node to adopt. */
	| { name: string; pid: number; action: 'kept-for-adoption' }
	/** Ours, alive, stale configuration, and not signalled: either not asked for or not permitted. */
	| { name: string; pid: number; action: 'reported-orphan' }
	/** A lock we could not adjudicate, because the binary path never resolved. */
	| { name: string; pid: number; action: 'skipped-unresolved' }
	| { name: string; pid: number; action: 'stopped-orphan' }
	| { name: string; pid: number; action: 'orphan-survived' }
	| { name: string; pid: number; action: 'removed-foreign' }
	| { name: string; pid: number; action: 'removed-unidentifiable' }
	| { name: string; pid: number; action: 'skipped-changed' };

/**
 * Remove stale locks for `targets`, stopping any orphan positively identified as ours.
 *
 * Returns what it did, so the caller logs it into its own sink at its own level. Nothing here
 * logs: a component's warnings have to reach hdb.log, and a package that writes to its own
 * console reaches nobody.
 */
export async function sweepStaleLocks({
	pidDir,
	targets,
	stopOrphans = false,
	stopTimeoutMs = STOP_TIMEOUT_MS,
}: {
	pidDir: string;
	targets: SweepTarget[];
	/** Whether an identified orphan may be signalled. See bootstrap()'s option of the same name. */
	stopOrphans?: boolean;
	stopTimeoutMs?: number;
}): Promise<SweepAction[]> {
	const actions: SweepAction[] = [];

	for (const target of targets) {
		const lockPath = join(pidDir, `${target.name}.pid`);

		// An empty path is what a caller passes when resolution failed. Nothing can be
		// identified against it, so every live process would read as unidentifiable and every
		// lock would be removed on the strength of a question never asked.
		if (!target.binaryPath) {
			const unresolved = readLock(lockPath);
			if (unresolved) actions.push({ ...entry(target, unresolved.pid), action: 'skipped-unresolved' });
			continue;
		}

		const lock = readLock(lockPath);
		if (!lock) {
			// Absent is the ordinary case. An unparseable file is removed so Harper's own
			// stale-file handling never has to guess at it.
			removeIfStill(lockPath, null);
			continue;
		}

		if (!isAlive(lock.pid)) {
			if (removeIfStill(lockPath, lock.pid)) actions.push({ ...entry(target, lock.pid), action: 'removed-dead' });
			else actions.push({ ...entry(target, lock.pid), action: 'skipped-changed' });
			continue;
		}

		const identification = identify(lock.pid, target.binaryPath);

		if (identification === 'differs') {
			// Live, and demonstrably something else. The lock is ours to remove; the process
			// is not ours to touch.
			if (removeIfStill(lockPath, lock.pid)) actions.push({ ...entry(target, lock.pid), action: 'removed-foreign' });
			else actions.push({ ...entry(target, lock.pid), action: 'skipped-changed' });
			continue;
		}

		if (identification === 'unknown') {
			// A platform that cannot see, or a process owned by someone else. Removing the
			// lock lets a replacement start; if the unseen process really was our orphan it
			// still holds the port, and the caller's own liveness check reports that. Better
			// than signalling blind, and better than leaving a lock that will be adopted.
			if (removeIfStill(lockPath, lock.pid))
				actions.push({ ...entry(target, lock.pid), action: 'removed-unidentifiable' });
			else actions.push({ ...entry(target, lock.pid), action: 'skipped-changed' });
			continue;
		}

		// Positively our binary. Whether that makes it an orphan depends on the fingerprint:
		// Harper adopts a lock whose version matches, so a match means this node is about to
		// inherit a healthy process and must leave it exactly where it is. `harper restart`
		// depends on that, and a sweep that stopped it would drop spans on every restart.
		if (target.version !== undefined && lock.version === target.version) {
			actions.push({ ...entry(target, lock.pid), action: 'kept-for-adoption' });
			continue;
		}

		// The fingerprint moved, so the lock describes a configuration that no longer exists:
		// an orphan. Whether it may be signalled is the caller's decision and the platform's.
		if (!stopOrphans || !identificationCanAuthoriseSignal()) {
			// Left running and left locked, on purpose. Harper's own lock kills a process whose
			// recorded version no longer matches, so the runtime resolves this either way; the
			// difference is that it does so without checking what it is signalling.
			actions.push({ ...entry(target, lock.pid), action: 'reported-orphan' });
			continue;
		}

		// Stopping it rather than merely unlocking it is deliberate: it holds the ports a
		// replacement needs, and a replacement that cannot bind reports that it started.
		const current = readLock(lockPath);
		if (current?.pid !== lock.pid) {
			actions.push({ ...entry(target, lock.pid), action: 'skipped-changed' });
			continue;
		}
		try {
			process.kill(lock.pid, 'SIGTERM');
		} catch {
			// ESRCH: it exited between the identification and the signal. A previous boot's
			// reaper is doing the same job concurrently and may have won the race.
		}

		const deadline = Date.now() + stopTimeoutMs;
		while (Date.now() < deadline && isAlive(lock.pid)) await delay(STOP_POLL_MS);

		// Deliberately no escalation to SIGKILL. A process that ignores SIGTERM is a condition
		// to report, not to force: this cannot know what it is in the middle of, and the pid
		// may by now belong to something else entirely.
		const survived = isAlive(lock.pid);
		removeIfStill(lockPath, lock.pid);
		actions.push({ ...entry(target, lock.pid), action: survived ? 'orphan-survived' : 'stopped-orphan' });
	}

	return actions;
}

function entry(target: SweepTarget, pid: number) {
	return { name: target.name, pid };
}

/**
 * Remove the lock only if it still names `pid`, so a lock rewritten in the meantime survives.
 *
 * Returns false when it had changed, which the caller reports rather than retrying: the
 * change means something else is managing this name and a second opinion would be a race.
 *
 * Exported for the hermetic suite: this guard is the difference between a narrow race and a
 * wide one, and it is not otherwise reachable from a test without timing the interleaving.
 */
export function removeIfStill(lockPath: string, pid: number | null): boolean {
	if (pid !== null) {
		const current = readLock(lockPath);
		if (current !== null && current.pid !== pid) return false;
	}
	try {
		unlinkSync(lockPath);
		return true;
	} catch (error) {
		// ENOENT is the outcome asked for. Anything else means the file is still there, and
		// reporting a removal that did not happen is worse than reporting nothing: the caller
		// logs a repair, and the lock is adopted on the next start regardless.
		return (error as NodeJS.ErrnoException).code === 'ENOENT';
	}
}

/** One line per action, for a caller that logs into Harper's own sink. */
export function describeSweep(actions: SweepAction[]): string[] {
	return actions.map((a) => {
		switch (a.action) {
			case 'removed-dead':
				return `removed the stale ${a.name} lock naming pid ${a.pid}, which nothing holds.`;
			case 'stopped-orphan':
				return `stopped an orphaned ${a.name} (pid ${a.pid}) left by a previous Harper, and removed its lock. It held the ports a replacement needs.`;
			case 'orphan-survived':
				return `an orphaned ${a.name} (pid ${a.pid}) did not exit after SIGTERM. Its lock is removed, but it may still hold its ports, in which case the replacement will not bind.`;
			case 'removed-foreign':
				return `the ${a.name} lock named pid ${a.pid}, which is live but is running something else: the lock is from an earlier boot and its pid has been reused. Removed the lock and signalled nothing.`;
			case 'removed-unidentifiable':
				return `the ${a.name} lock named live pid ${a.pid}, which could not be identified on this platform. Removed the lock and signalled nothing; if that process was an orphan it still holds its ports.`;
			case 'reported-orphan':
				return `the running ${a.name} (pid ${a.pid}) carries a configuration this node no longer uses, so it is an orphan. It was not signalled${identificationCanAuthoriseSignal() ? ' (stopOrphans is off)' : ' (this platform cannot identify a process well enough to signal it safely)'}; Harper's own lock will replace it on the version mismatch.`;
			case 'kept-for-adoption':
				return `left the running ${a.name} (pid ${a.pid}) alone: its lock still carries this configuration, so this node adopts it rather than restarting it.`;
			case 'skipped-unresolved':
				return `could not adjudicate the ${a.name} lock naming pid ${a.pid}, because its binary path did not resolve. The lock is untouched and may still be adopted by something that is not that agent.`;
			case 'skipped-changed':
				return `the ${a.name} lock stopped naming pid ${a.pid} while it was being examined, so it was left alone.`;
		}
	});
}
