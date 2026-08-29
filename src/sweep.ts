// Harper validates a lock by liveness alone, so a stale lock adopts whoever inherits its pid. Two rules: nothing signalled without positive identification, and every destructive step re-reads the lock first.
// Must run inside oncePerProcess(): otherwise a sibling's fresh healthy process is indistinguishable from an orphan.
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { errnoCode } from './errors.js';
import { identificationCanAuthoriseSignal, identify, isAlive, readLock } from './identity.js';
import { guardDescriptorPath } from './registry.js';

/** How long an identified orphan gets to exit after SIGTERM before it is reported as staying. */
const STOP_TIMEOUT_MS = 5000;
const STOP_POLL_MS = 50;

export interface SweepTarget {
	/** Harper's spawn `name`, which is the lock filename without `.pid`. */
	readonly name: string;
	/** Absolute path of the binary, used to identify an orphan. Resolve it before calling. */
	readonly binaryPath: string;
	/** The version this caller will pass to spawn. A live process under a MATCHING lock is a handover `harper restart` depends on, not an orphan; only a mismatch marks a dead configuration. */
	readonly version?: number | undefined;
}

export type SweepAction =
	| { readonly name: string; readonly pid: number; readonly action: 'removed-dead' }
	/** Ours, alive, and still current. Left running for this node to adopt. */
	| { readonly name: string; readonly pid: number; readonly action: 'kept-for-adoption' }
	/** Ours, alive, stale configuration, and not signalled: either not asked for or not permitted. */
	| { readonly name: string; readonly pid: number; readonly action: 'reported-orphan' }
	/** A lock we could not adjudicate, because the binary path never resolved. */
	| { readonly name: string; readonly pid: number; readonly action: 'skipped-unresolved' }
	| { readonly name: string; readonly pid: number; readonly action: 'stopped-orphan' }
	| { readonly name: string; readonly pid: number; readonly action: 'orphan-survived' }
	| { readonly name: string; readonly pid: number; readonly action: 'removed-foreign' }
	| { readonly name: string; readonly pid: number; readonly action: 'removed-unidentifiable' }
	| { readonly name: string; readonly pid: number; readonly action: 'skipped-changed' };

/** Returns actions instead of logging: a component's warnings must reach hdb.log, and a package writing to its own console reaches nobody. */
export async function sweepStaleLocks({
	pidDir,
	targets,
	stopOrphans = false,
	stopTimeoutMs = STOP_TIMEOUT_MS,
}: {
	pidDir: string;
	targets: readonly SweepTarget[];
	/** Whether an identified orphan may be signalled. See bootstrap()'s option of the same name. */
	stopOrphans?: boolean;
	stopTimeoutMs?: number;
}): Promise<SweepAction[]> {
	const actions: SweepAction[] = [];

	for (const target of targets) {
		const lockPath = join(pidDir, `${target.name}.pid`);
		// The reaper's descriptor travels with the lock: wherever the lock is removed as stale,
		// the record beside it is stale for the same reason.
		const descriptorPath = guardDescriptorPath(pidDir, target.name);

		// An empty path means resolution failed: judged against it, every live process reads
		// unidentifiable and every lock is removed on a question never asked.
		if (!target.binaryPath) {
			const unresolved = readLock(lockPath);
			if (unresolved) actions.push({ ...entry(target, unresolved.pid), action: 'skipped-unresolved' });
			continue;
		}

		const lock = readLock(lockPath);
		if (!lock) {
			// Absent is the ordinary case. An unparseable file is removed so Harper's own
			// stale-file handling never has to guess at it.
			if (removeIfStill(lockPath, null)) removeQuietly(descriptorPath);
			continue;
		}

		if (!isAlive(lock.pid)) {
			if (removeIfStill(lockPath, lock.pid)) {
				removeQuietly(descriptorPath);
				actions.push({ ...entry(target, lock.pid), action: 'removed-dead' });
			} else actions.push({ ...entry(target, lock.pid), action: 'skipped-changed' });
			continue;
		}

		const identification = identify(lock.pid, target.binaryPath);

		if (identification === 'differs') {
			// Live, and demonstrably something else. The lock is ours to remove; the process
			// is not ours to touch.
			if (removeIfStill(lockPath, lock.pid)) {
				removeQuietly(descriptorPath);
				actions.push({ ...entry(target, lock.pid), action: 'removed-foreign' });
			} else actions.push({ ...entry(target, lock.pid), action: 'skipped-changed' });
			continue;
		}

		if (identification === 'unknown') {
			// Unidentifiable: remove the lock (left, it would be adopted) but signal nothing; a
			// real orphan still holds its port, which the caller's liveness check reports.
			if (removeIfStill(lockPath, lock.pid)) {
				removeQuietly(descriptorPath);
				actions.push({ ...entry(target, lock.pid), action: 'removed-unidentifiable' });
			} else actions.push({ ...entry(target, lock.pid), action: 'skipped-changed' });
			continue;
		}

		// A version match is the process this node inherits (`harper restart` depends on it);
		// leave it exactly where it is.
		if (target.version !== undefined && lock.version === target.version) {
			actions.push({ ...entry(target, lock.pid), action: 'kept-for-adoption' });
			continue;
		}

		// The fingerprint moved, so the lock describes a configuration that no longer exists:
		// an orphan. Whether it may be signalled is the caller's decision and the platform's.
		if (!stopOrphans || !identificationCanAuthoriseSignal()) {
			// Left running AND locked: Harper's own version-mismatch handling replaces it either
			// way, just without checking what it signals.
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

		// No SIGKILL: a SIGTERM-ignoring process is reported, not forced; by now the pid may
		// belong to something else.
		const survived = isAlive(lock.pid);
		if (removeIfStill(lockPath, lock.pid)) removeQuietly(descriptorPath);
		actions.push({ ...entry(target, lock.pid), action: survived ? 'orphan-survived' : 'stopped-orphan' });
	}

	return actions;
}

/** For the descriptor beside a lock; the lock itself goes through removeIfStill's re-read. */
function removeQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Absent is the outcome asked for.
	}
}

function entry(target: SweepTarget, pid: number): { name: string; pid: number } {
	return { name: target.name, pid };
}

/** Unlink only while the lock still names `pid`; false means it changed hands: report, don't retry. Exported so this guard is testable without timing an interleaving. */
export function removeIfStill(lockPath: string, pid: number | null): boolean {
	if (pid !== null) {
		const current = readLock(lockPath);
		if (current !== null && current.pid !== pid) return false;
	}
	try {
		unlinkSync(lockPath);
		return true;
	} catch (error) {
		// ENOENT is success; anything else must not report a removal that never happened.
		return errnoCode(error) === 'ENOENT';
	}
}

/** One line per action, for a caller that logs into Harper's own sink. */
export function describeSweep(actions: readonly SweepAction[]): string[] {
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
