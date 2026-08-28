/**
 * A guard for the child processes a Harper component owns.
 *
 * Destined to be its own repository and package, `@deliciousmonster/harper-process-guard`. It
 * lives here because it was found here, and it depends on nothing outside node builtins and its
 * own siblings, so moving it is a move rather than a rewrite. See README.md beside this file for
 * what has to be true first.
 *
 * Named for the job rather than the phase. `bootstrap()` is the start of that job and is
 * currently all of it, but the same set of declared processes is what a liveness check and a
 * reaper act on, and those belong here beside it rather than restated per component.
 *
 * Harper hands every component the same two problems and solves neither. Eight worker threads
 * evaluate the component simultaneously with no primitive between them, so "do this once for
 * the node" has no obvious implementation. And Harper's spawn lock records a bare pid, adopts
 * whatever holds that number on a later start, and never checks identity, so a lock that
 * outlives its writer silently prevents the process it names from ever starting again.
 *
 * Neither is specific to any one component. Anything that starts an agent, an exporter, a
 * tunnel, or a connection to something remote inherits both, which is why this is a general
 * module and not part of the Datadog supervisor that found it.
 *
 * Usage, from inside a component, after the binaries are resolved and before anything spawns:
 *
 *     const { report } = await bootstrap({
 *       pidDir: join(harperRootPath(), 'pids'),
 *       processes: [
 *         { name: 'datadog-trace-agent', binaryPath: tracePath },
 *         { name: 'datadog-agent', binaryPath: corePath },
 *       ],
 *     });
 *     for (const line of report) log.warn(`Datadog supervisor: ${line}`);
 *
 * Then spawn as usual. What this guarantees on return is that no lock under `pidDir` names a
 * process that is not the one it claims, and that no other thread of this Harper reached
 * spawn() while that was being established.
 *
 * What it deliberately does not do is spawn anything. A component must call Harper's own
 * `spawn`, because that is what enforces the binary allowlist and takes the lock, and wrapping
 * it here would put a second opinion between a component and the runtime it is hosted by.
 */
import { harperIdentity } from './identity.js';
import { oncePerProcess, type ProcessIdentity } from './once.js';
import { describeSweep, sweepStaleLocks, type SweepAction, type SweepTarget } from './sweep.js';

export { currentProcess, oncePerProcess, type OnceOutcome, type ProcessIdentity } from './once.js';
export { describeSweep, sweepStaleLocks, type SweepAction, type SweepTarget } from './sweep.js';
export { executableOf, identify, isAlive, readLock, type Identification } from './identity.js';
// Spawn orchestration. The constrained spawn comes FROM THE CALLER, because Harper substitutes
// it only for modules its loader evaluates and this package is loaded natively; see spawn.ts.
export {
	assertConstrainedSpawn,
	fingerprint,
	launchReaper,
	preflightBinary,
	startProcess,
	type ConstrainedSpawn,
	type GuardLog,
	type ManagedProcess,
	type ProcessState,
	type ReaperState,
	type SpawnedChild,
} from './spawn.js';
// The reaper is SPAWNED, not called: a component runs dist/reaper.js as its
// own process. These exports exist so its behaviour can be tested without spawning one.
export {
	parseArgs as parseReaperArgs,
	reapTarget,
	run as runReaper,
	type ReaperOptions,
	type ReapTarget,
} from './reaper.js';

export interface BootstrapResult {
	/** True when this thread ran the sweep. False when a sibling did, or when none could. */
	swept: boolean;
	/** What the sweep did. Empty for a thread that waited, since the work was not its own. */
	actions: SweepAction[];
	/** One line per action, plus a line when the sweep could not be established at all. */
	report: string[];
}

/**
 * Repair stale locks once per Harper process, holding every thread until it is done.
 *
 * @param timeoutMs how long a waiting thread holds before giving up. The default allows for
 *   every process being an orphan that has to be stopped in turn, plus room; a waiter that
 *   gives up early releases threads into the race this exists to prevent, so it is reported
 *   rather than passed over in silence.
 */
/**
 * Marker filename for this caller.
 *
 * Defaults to the process names rather than a constant, because two components bootstrapping
 * against the same pid directory under one key would each read the other's completed marker as
 * their own and skip their sweep entirely. Sorted so the key does not depend on declaration
 * order.
 */
function markerKey(namespace: string | undefined, processes: SweepTarget[]): string {
	const suffix =
		namespace ??
		processes
			.map((target) => target.name)
			.sort()
			.join('+');
	return `harper-process-guard.${suffix}`;
}

export async function bootstrap({
	pidDir,
	processes,
	timeoutMs,
	stopOrphans = false,
	namespace,
	identity,
	rootPath,
}: {
	pidDir: string;
	processes: SweepTarget[];
	timeoutMs?: number;
	/**
	 * Whether an identified orphan may be stopped. Off by default, and the default is the
	 * recommendation: removing a stale lock is what fixes the adopt-a-stranger defect, and it
	 * signals nothing. Stopping a process is where every serious hazard in this module lives.
	 *
	 * Leaving an orphan running is not leaving it unhandled. Harper's own lock kills a process
	 * whose recorded version no longer matches, which is exactly the case an orphan is, so the
	 * runtime does it either way. The difference is that Harper does it without checking what
	 * it is signalling and this module refuses to.
	 */
	stopOrphans?: boolean;
	/**
	 * Distinguishes callers sharing one pid directory. Two components that both bootstrap
	 * against the same directory under one key would each see the other's completed marker and
	 * skip their own sweep entirely.
	 */
	namespace?: string;
	/** Overrides how this process identifies itself. See oncePerProcess. */
	identity?: ProcessIdentity;
	/**
	 * Harper's root path. Used only to identify this process from hdb.pid where the OS exposes
	 * no start token, which today means Windows. Ignored when `identity` is given.
	 */
	rootPath?: string;
}): Promise<BootstrapResult> {
	const budget = timeoutMs ?? Math.max(30_000, processes.length * 10_000);

	// Never throws. A throw here reaches the caller's component body, and a component that
	// throws at load takes its whole application down: the defect this module guards against
	// costs telemetry, while an exception costs the node. The verdict is always a report.
	// Prefer what the caller knows, then Harper's own hdb.pid, then whatever the OS offers.
	// The middle one matters on platforms with no start token: it is a value written once per
	// start and read identically by every thread, which the derived fallback is not.
	const resolved = identity ?? (rootPath ? (harperIdentity(rootPath) ?? undefined) : undefined);

	let outcome;
	try {
		outcome = await oncePerProcess(
			pidDir,
			markerKey(namespace, processes),
			() => sweepStaleLocks({ pidDir, targets: processes, stopOrphans }),
			{ timeoutMs: budget, identity: resolved }
		);
	} catch (error) {
		return {
			swept: false,
			actions: [],
			report: [
				`the startup lock sweep failed (${(error as Error).message}), so the PID locks under ` +
					`${pidDir} have not been checked. A process recorded there by an earlier boot may be ` +
					`adopted instead of started.`,
			],
		};
	}

	if (outcome.ran) {
		const actions = outcome.result as SweepAction[];
		return { swept: true, actions, report: describeSweep(actions) };
	}

	if (outcome.waited) return { swept: false, actions: [], report: [] };

	// Nobody established the precondition. Saying so is the whole value: the caller is about
	// to spawn against locks that may name anything, which is the state this module exists to
	// rule out, and silence here would look identical to success.
	return {
		swept: false,
		actions: [],
		report: [
			`the startup lock sweep did not complete (${outcome.reason}), so the PID locks under ` +
				`${pidDir} have not been checked. A process recorded there by an earlier boot may be ` +
				`adopted instead of started. If a child process does not come up, remove that directory's ` +
				`stale .pid files and restart.`,
		],
	};
}
