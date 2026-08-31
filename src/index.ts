// One call for the lifecycle of the child processes a Harper component owns: sweep, configs, spawn, reap, verify.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

import { errorMessage } from './errors.js';
import { harperIdentity } from './identity.js';
import { oncePerProcess, type OnceOutcome, type ProcessIdentity } from './once.js';
import { describeSweep, sweepStaleLocks, type SweepAction, type SweepTarget } from './sweep.js';
import {
	assertConstrainedSpawn,
	DEFAULT_REAPER_NAME,
	fingerprint,
	launchReaper,
	startProcess,
	type ConstrainedSpawn,
	type GuardLog,
	type ProcessState,
	type ReaperState,
} from './spawn.js';

export { currentProcess, oncePerProcess, type OnceOutcome, type ProcessIdentity } from './once.js';
export { describeSweep, sweepStaleLocks, type SweepAction, type SweepTarget } from './sweep.js';
export { executableOf, identify, isAlive, readLock, type Identification } from './identity.js';
export { readHarperRootPath } from './harper-root.js';
export { pollEndpoint } from './poll-endpoint.js';
// The constrained spawn comes FROM THE CALLER; Harper substitutes it per module graph and this package loads natively.
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
// The reaper is SPAWNED, not called; these exports exist so its behaviour can be tested without spawning one.
export {
	collectTargets as collectReapTargets,
	parseArgs as parseReaperArgs,
	reapTarget,
	run as runReaper,
	type ReaperOptions,
	type ReapTarget,
} from './reaper.js';

const NO_LOG: GuardLog = { info: () => {}, warn: () => {}, error: () => {} };

/** One process under the guard's care: the sweep target, plus how to start and prove it when `spawn` is given. */
export interface BootstrapProcess {
	/** Harper's spawn `name`, which is also the PID-lock filename. */
	readonly name: string;
	/** Absolute path of the binary. Give this or `resolve`. */
	readonly binaryPath?: string | undefined;
	/** Per-process spawn version. Mutually exclusive with bootstrap's `fingerprintParts`. */
	readonly version?: number | undefined;
	/** Resolves the binary path; awaited before the sweep, and a throw disables only this process. */
	readonly resolve?: (() => string | Promise<string>) | undefined;
	readonly args?: readonly string[] | undefined;
	/** How messages name it. Defaults to `name`. */
	readonly title?: string | undefined;
	/** Appended to the non-zero-exit report, for the caller's domain knowledge. */
	readonly exitHint?: string | undefined;
	/** Proves the process does its job; awaited after the reaper launch, verdict recorded on the state. */
	readonly verify?: ((state: ProcessState) => Promise<{ ok: boolean; detail?: string }>) | undefined;
}

/** How bootstrap() launches the guard's own reaper. `false` skips it. */
export interface BootstrapReaper {
	/** Harper spawn name for the reaper, which is also ITS lock filename. */
	readonly name?: string | undefined;
	readonly logFile?: string | undefined;
	readonly restartGraceMs?: number | undefined;
	/** Appended to the started log, naming what the reaper stops in the caller's terms. */
	readonly startedHint?: string | undefined;
	/** Appended wherever a missing or dead reaper means the processes outlive the node. */
	readonly outliveHint?: string | undefined;
}

export interface BootstrapOptions {
	/** Where Harper's PID locks live. Defaults to `<rootPath>/pids`; without either, the sweep is reported as skipped. */
	readonly pidDir?: string | undefined;
	readonly processes: readonly BootstrapProcess[];
	/** How long a waiting thread holds before giving up; giving up early releases threads into the race this prevents. */
	readonly timeoutMs?: number | undefined;
	/** Whether an identified orphan may be stopped. Off by default; the kill path is where every serious hazard lives. */
	readonly stopOrphans?: boolean | undefined;
	/** Distinguishes callers sharing one pid directory, so neither reads the other's completed marker as its own. */
	readonly namespace?: string | undefined;
	/** Overrides how this process identifies itself. See oncePerProcess. */
	readonly identity?: ProcessIdentity | undefined;
	/** Harper's root path: identifies this process from hdb.pid, and locates the pids/ directory and the reaper's files. */
	readonly rootPath?: string | undefined;
	/** Harper's constrained spawn, from the caller's own import. Presence enables the full lifecycle. */
	readonly spawn?: ConstrainedSpawn | undefined;
	/** Where the guard's messages land. Defaults to a no-op. */
	readonly log?: GuardLog | undefined;
	/** Inputs to fingerprint(); the computed version drives every spawn. Mutually exclusive with per-process `version`. */
	readonly fingerprintParts?: readonly unknown[] | undefined;
	/** Files written atomically after the sweep, path to contents; a rereading process sees old or new, never torn. */
	readonly configFiles?: Readonly<Record<string, string>> | undefined;
	/** The guard's reaper, launched by default when the lifecycle runs; `false` skips it. */
	readonly reaper?: BootstrapReaper | false | undefined;
	/** Appended to the not-intercepted report, restoring the concrete consequence the generic message cannot name. */
	readonly interceptionHint?: string | undefined;
}

export interface BootstrapResult {
	/** True when this thread ran the sweep. False when a sibling did, or when none could. */
	swept: boolean;
	/** What the sweep did. Empty for a thread that waited, since the work was not its own. */
	actions: SweepAction[];
	/** One line per action, plus a line when the sweep could not be established at all. */
	report: string[];
	/** Whether the spawn proved to be Harper's constrained one. Only set when `spawn` was given. */
	intercepted?: boolean | undefined;
	/** The version computed from fingerprintParts and passed to every spawn. */
	version?: number | undefined;
	/** One state per declared process, in declaration order. */
	processes?: ProcessState[] | undefined;
	reaper?: ReaperState | undefined;
}

/** Marker filename, derived from the process names so two components sharing one pid directory cannot collide. */
function markerKey(namespace: string | undefined, processes: readonly BootstrapProcess[]): string {
	const suffix =
		namespace ??
		processes
			.map((target) => target.name)
			.sort()
			.join('+');
	return `harper-process-guard.${suffix}`;
}

/** Write each file via temp-and-rename; rename within one directory is atomic, so no reader meets a torn file. */
function writeConfigFiles(configFiles: Readonly<Record<string, string>>, log: GuardLog): void {
	for (const [target, contents] of Object.entries(configFiles)) {
		try {
			mkdirSync(dirname(target), { recursive: true });
			const temp = `${target}.${process.pid}.${threadId}.tmp`;
			writeFileSync(temp, contents, 'utf-8');
			renameSync(temp, target);
		} catch (error) {
			log.error(`process guard: could not write ${target}: ${errorMessage(error)}`);
		}
	}
}

/** The sweep behind the once-per-process barrier; environmental failure is a report line, never a throw. */
async function runSweep({
	pidDir,
	targets,
	namespace,
	timeoutMs,
	stopOrphans,
	identity,
	rootPath,
	processes,
}: {
	pidDir: string;
	targets: readonly SweepTarget[];
	namespace?: string | undefined;
	timeoutMs?: number | undefined;
	stopOrphans: boolean;
	identity?: ProcessIdentity | undefined;
	rootPath?: string | undefined;
	processes: readonly BootstrapProcess[];
}): Promise<Pick<BootstrapResult, 'swept' | 'actions' | 'report'>> {
	// The default allows for every process being an orphan that has to be stopped in turn, plus room.
	const budget = timeoutMs ?? Math.max(30_000, targets.length * 10_000);
	// Prefer what the caller knows, then Harper's own hdb.pid, then whatever the OS offers.
	const resolved = identity ?? (rootPath ? (harperIdentity(rootPath) ?? undefined) : undefined);

	let outcome: OnceOutcome<SweepAction[]>;
	try {
		outcome = await oncePerProcess(
			pidDir,
			markerKey(namespace, processes),
			() => sweepStaleLocks({ pidDir, targets, stopOrphans }),
			{ timeoutMs: budget, identity: resolved }
		);
	} catch (error) {
		return {
			swept: false,
			actions: [],
			report: [
				`the startup lock sweep failed (${errorMessage(error)}), so the PID locks under ` +
					`${pidDir} have not been checked. A process recorded there by an earlier boot may be ` +
					`adopted instead of started.`,
			],
		};
	}

	if (outcome.ran) {
		const actions = outcome.result;
		return { swept: true, actions, report: describeSweep(actions) };
	}

	if (outcome.waited) return { swept: false, actions: [], report: [] };

	// Silence here would look identical to success, and the caller is about to spawn against unchecked locks.
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

/** Sweep stale locks once per Harper process, then (when `spawn` is given) write configs, start, reap, and verify. */
export async function bootstrap({
	pidDir,
	processes,
	timeoutMs,
	stopOrphans = false,
	namespace,
	identity,
	rootPath,
	spawn,
	log = NO_LOG,
	fingerprintParts,
	configFiles,
	reaper: reaperOptions,
	interceptionHint,
}: BootstrapOptions): Promise<BootstrapResult> {
	// Deterministic misuse throws at the first local run; everything the environment decides is a report instead.
	if (fingerprintParts && processes.some((proc) => proc.version !== undefined)) {
		throw new TypeError(
			'fingerprintParts and per-process version are mutually exclusive: one fingerprint must describe every spawn'
		);
	}

	const intercepted = spawn
		? assertConstrainedSpawn(spawn, log, { notInterceptedHint: interceptionHint }).intercepted
		: undefined;

	// Resolved before the sweep, which needs binaryPath to identify a lock's process; one bad binary disables only itself.
	// Each resolution rides beside its process, so nothing downstream lines up parallel arrays by index.
	const prepared = await Promise.all(
		processes.map(async (proc): Promise<{ proc: BootstrapProcess; binaryPath: string; resolveError?: string }> => {
			try {
				return { proc, binaryPath: proc.resolve ? String(await proc.resolve()) : (proc.binaryPath ?? '') };
			} catch (error) {
				const message = errorMessage(error);
				log.error(`process guard: could not resolve the ${proc.title ?? proc.name} binary: ${message}`);
				return { proc, binaryPath: '', resolveError: message };
			}
		})
	);

	const version = fingerprintParts ? fingerprint(...fingerprintParts) : undefined;

	const lockDir = pidDir ?? (rootPath ? join(rootPath, 'pids') : undefined);
	const swept = lockDir
		? await runSweep({
				pidDir: lockDir,
				targets: prepared.map(({ proc, binaryPath }) => ({
					name: proc.name,
					binaryPath,
					version: version ?? proc.version,
				})),
				namespace,
				timeoutMs,
				stopOrphans,
				identity,
				rootPath,
				processes,
			})
		: {
				swept: false,
				actions: [],
				report: [
					`no pid directory was named (neither pidDir nor rootPath), so the PID locks were not ` +
						`checked. A lock recorded by an earlier boot may be adopted instead of started.`,
				],
			};
	for (const line of swept.report) log.warn(`process guard: ${line}`);

	// After the barrier: every thread writes, and the rename keeps concurrent writers and rereading agents safe.
	if (configFiles) writeConfigFiles(configFiles, log);

	if (!spawn) return swept;

	const jobs = prepared.map(({ proc, binaryPath, resolveError }) => {
		const state = startProcess(
			spawn,
			{
				name: proc.name,
				title: proc.title,
				binaryPath,
				args: proc.args ?? [],
				exitHint: proc.exitHint,
			},
			{ version: version ?? proc.version, log, pidDir: lockDir }
		);
		// The resolve error is the actionable one; startProcess only knows the path never arrived.
		if (resolveError) state.error = resolveError;
		return { proc, state };
	});
	const states = jobs.map(({ state }) => state);

	let reaper: ReaperState | undefined;
	if (reaperOptions !== false) {
		if (rootPath) {
			reaper = launchReaper(spawn, {
				// This code IS the package, so its own dist/reaper.js sits beside the compiled index.js.
				reaperScript: fileURLToPath(new URL('./reaper.js', import.meta.url)),
				rootPath,
				pidDir: lockDir,
				processes: states,
				version,
				log,
				...reaperOptions,
			});
		} else {
			reaper = {
				name: reaperOptions?.name ?? DEFAULT_REAPER_NAME,
				started: false,
				error: "Harper's root path is unknown, so the PID files to clean up cannot be located",
			};
			// Only when something actually started; warning about live processes that never existed sends operators hunting.
			if (states.some((state) => state.started)) {
				log.warn(
					`process guard: not starting the reaper: ${reaper.error}. The processes will keep ` +
						`running after this node stops; kill them by hand or pass rootPath.`
				);
			}
		}
	}

	// After the reaper launch: a verify may wait 30s, and a node killed inside that window must not orphan the children.
	for (const { proc, state } of jobs) {
		if (!proc.verify) continue;
		try {
			const { ok, detail } = await proc.verify(state);
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

	const result: BootstrapResult = { ...swept, intercepted, processes: states };
	if (version !== undefined) result.version = version;
	if (reaper) result.reaper = reaper;
	return result;
}
