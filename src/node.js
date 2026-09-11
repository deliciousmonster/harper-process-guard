// The node, where every consumer of this package is one thread of many.
//
// Harper runs a worker thread per core and loads every component into each of them, so anything a component
// does on a timer it does N times, and anything it remembers in module memory it remembers N times over with
// no two threads agreeing. The lock files already arbitrate the processes. These are the same answer for the
// two other things a component needs the node to have rather than the thread: one writer for periodic work,
// and a value every thread can read.
//
// What the supervised processes cost is here for the same reason. A thread measures pids the node runs, not
// pids it started, so the reader has to work from a number rather than from its own memory of a spawn.
//
// And the second half of the file is that same question asked of the processes themselves: a thread's own
// memory of a spawn is not the node's state, so what it reports is read back off the locks rather than
// remembered. A thread whose spawn was refused still has to say whether the node is running the process.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

import { argvOf, identify as identifyPid } from './identity.js';
import { readLock } from './lock.js';

/** Bytes per /proc kB field. */
const KB = 1024;

/** A filename component from an arbitrary key. */
const safe = (/** @type {string} */ key) => key.replace(/[^\w.-]+/g, '_');

/**
 * A value every thread on the node can read, one small file per key beside the guard's own locks.
 *
 * Harper answers a request on whichever worker thread is free, so a mark kept in module memory is private to
 * one thread and stale by however long since that thread last ran. Measured on 2026-09-09 against a live node
 * under steady load: 6 of 20 reads four seconds apart came back with no mark at all and the rest scattered
 * from 4 to 61 seconds, because each read landed on a different thread. A 60-second window cannot be tracked
 * that way at all.
 *
 * Numbers only, because that is what a mark is: a timestamp, a count, a version. Written under a per-thread
 * name and renamed, so a reader never sees half of one.
 *
 * @param {string | undefined} dir @param {string} kind Distinguishes one consumer's marks from another's.
 * @returns {{ get: (key: string) => number | undefined, set: (key: string, value: number) => void }}
 */
export function sharedMarks(dir, kind) {
	if (!dir) {
		// No directory, so nothing can be shared. This thread's own memory is what is left, and it is what a
		// single-threaded caller needs anyway.
		/** @type {Map<string, number>} */
		const own = new Map();
		return { get: (key) => own.get(key), set: (key, value) => void own.set(key, value) };
	}
	const path = (/** @type {string} */ key) => join(dir, `${safe(kind)}-${safe(key)}.mark`);
	return {
		get(key) {
			try {
				const value = Number(readFileSync(path(key), 'utf-8').trim());
				return Number.isFinite(value) && value > 0 ? value : undefined;
			} catch {
				// No mark yet, or an unreadable one. Either way this read has nothing behind it.
				return undefined;
			}
		},
		set(key, value) {
			const target = path(key);
			const scratch = `${target}.${process.pid}.${threadId}`;
			try {
				writeFileSync(scratch, String(value));
				renameSync(scratch, target);
			} catch {
				// A read-only or missing directory costs the recall, not the caller.
				try {
					unlinkSync(scratch);
				} catch {}
			}
		},
	};
}

/**
 * Which thread does the work, for work the node wants done once.
 *
 * An ungated timer in a component runs once per worker thread, so a series it sends is multiplied by the
 * thread count and every gauge in it reads high. This is the claim that stops that.
 *
 * A claim is a file holding `<holder> <timestamp>`. The holder refreshes it on every tick, which is what makes
 * takeover automatic: a thread that dies stops refreshing, and after `staleMs` the next tick from any other
 * thread takes it. There is no unlock path for that reason.
 *
 * @param {object} options
 * @param {string} options.dir @param {string} options.file Name of the claim, so two kinds of work do not share one.
 * @param {string} options.holder @param {number} options.staleMs
 * @param {number} [options.now] @param {typeof readFileSync} [options.read] @param {typeof writeFileSync} [options.write]
 * @returns {boolean} whether the caller may do the work this tick
 */
export function claimSingleton({
	dir,
	file,
	holder,
	staleMs,
	now = Date.now(),
	read = readFileSync,
	write = writeFileSync,
}) {
	const path = join(dir, file);
	/** @type {string[]} */
	let held;
	try {
		held = String(read(path, 'utf-8')).trim().split(/\s+/);
	} catch {
		// No claim yet, or one this thread cannot read. Either way nobody demonstrably holds it.
		held = [];
	}
	const [heldBy, stamp] = held;
	const at = Number(stamp);
	// A stamp ahead of `now` reads as live, not as expired. Every claimant is a worker thread inside one host
	// process and they share a clock, so the only way to see the future is a clock correction under a living
	// holder; calling that stale would put a second worker on the job while the first still runs. It resolves
	// itself on the holder's next tick, which restamps with the corrected clock.
	const live = Number.isFinite(at) && now - at < staleMs;
	if (live && heldBy !== holder) return false;
	try {
		write(path, `${holder} ${now}\n`);
	} catch {
		// An unwritable pid directory is the guard's own problem to report, and it already does. Proceeding
		// anyway would put every thread on the job, which is the one outcome the claim exists to prevent.
		return false;
	}
	return true;
}

/**
 * How long a claim survives without a refresh: three cadences rather than one, so a holder that misses a tick
 * to a slow read does not hand the work to a second thread and double its output for one interval.
 *
 * @param {number} intervalSeconds
 */
export const claimStaleMs = (intervalSeconds) => intervalSeconds * 3000;

/**
 * What one supervised process costs, or null when this platform cannot say.
 *
 * Linux answers from /proc. macOS and Windows have no equivalent a Node process can read without either
 * spawning `ps`/`Get-CimInstance` on a schedule, which Harper's constrained spawn would make an operator
 * allowlist, or a native addon, which would end this package's "no install scripts" property. Reporting
 * nothing is correct there; reporting a Go process's own `memstats` would not be, because that is heap and not
 * resident memory. Measured 2026-09-09: one agent read 129 MiB resident while publishing `Sys` of 64.
 *
 * @param {number} pid @param {string} [platform] @param {(p: string) => string} [read]
 * @returns {{ rssBytes: number, threads: number } | null}
 */
export function readProcess(pid, platform = process.platform, read = undefined) {
	if (platform !== 'linux') return null;
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const readFile = read ?? ((/** @type {string} */ p) => readFileSync(p, 'utf-8'));
	let status;
	try {
		status = readFile(`/proc/${pid}/status`);
	} catch {
		// The process went away between listing it and reading it, which is ordinary under chaos.
		return null;
	}
	const field = (/** @type {string} */ name) => {
		const found = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status);
		return found ? Number(found[1]) : undefined;
	};
	const rssKb = field('VmRSS');
	if (rssKb === undefined) return null;
	return { rssBytes: rssKb * KB, threads: field('Threads') ?? 0 };
}

/**
 * This process's own cost, which needs no /proc and is the same on every platform.
 *
 * The host is Node, so `process.memoryUsage().rss` is its real resident size. That is why the host is measured
 * everywhere and only the native processes beside it are not.
 *
 * @param {NodeJS.Process} [self]
 */
export function selfProcess(self = process) {
	const { rss } = self.memoryUsage();
	return { rssBytes: rss, threads: 0 };
}

// -- The processes, as the node has them rather than as one thread left them -------------------------------

/** How often a thread checks the reaper is still there, and the longest it waits after a failed relaunch. */
export const REAPER_WATCH_MS = 60_000;
const REAPER_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * A lock naming a real process, or undefined. readLock parses; this adds the one thing a supervisor needs
 * on top of it, which is that pid 0 is the claim-in-flight sentinel and identifies against nothing.
 *
 * @param {string} file
 */
export function heldProcess(file) {
	const lock = readLock(file);
	if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return undefined;
	return lock;
}

/**
 * The reaper as it is now, rather than as bootstrap left it.
 *
 * The guard builds its ReaperState once and a status endpoint copied it, so a reaper killed at 01:43 was
 * still reported started with its dead pid ten minutes later, and a chaos run recorded a recovery that
 * never happened. Processes already get this treatment through their verdicts; the reaper was the one
 * thing left reporting boot state.
 *
 * @param {Record<string, unknown> | undefined} reaper @param {string | undefined} pidDir
 * @param {string} [defaultName] Used only when the state carries no name of its own. A reaper state
 *   built by guard() always does, so this is the fallback rather than the usual path.
 */
export function currentReaper(reaper, pidDir, defaultName) {
	if (!reaper || !pidDir) return reaper;
	const name = typeof reaper.name === 'string' ? reaper.name : defaultName;
	// Nothing names the lock, so there is nothing to re-read it from. Returned unchanged rather than
	// reported dead: this cannot tell a missing reaper from a missing name.
	if (!name) return reaper;
	const held = heldProcess(join(pidDir, `${name}.pid`));
	if (held && identifyPid(held.pid, held.argv) === 'match') {
		// The pid too: a reaper that died and was replaced by another thread runs under a number this
		// thread's boot state never saw.
		return { ...reaper, started: true, pid: held.pid };
	}
	const why = !held
		? `no lock for ${name} under ${pidDir}`
		: argvOf(held.pid) === null
			? `${name}'s lock names pid ${held.pid}, which nothing holds`
			: `${name}'s lock names pid ${held.pid}, which is running something else`;
	return {
		...reaper,
		started: false,
		pid: undefined,
		error: `${why}. Nothing is reaping this node's processes: if it dies without running its exit handlers, they outlive it.`,
	};
}

/**
 * Harper's own spawn keeps a pid file per process name under <root>/pids and, when the file names a pid
 * that answers kill(pid, 0), returns that pid instead of spawning. After a restart the kernel reissues
 * pids, and a thread of Harper itself answers for one, so the file has to go before the guard asks.
 * Removing it signals nothing. A file naming the real process, or a dead one, is Harper's to keep.
 *
 * @param {string | null} root
 * @param {Array<{ name: string; argv?: readonly string[]; script?: string }>} named
 * @param {import('./host.js').Log} log
 * @param {string} [label] How the component names itself in these lines. Defaults to this package.
 */
export function clearStaleHostPidFiles(root, named, log, label = 'process guard') {
	if (!root) return;
	for (const { name, argv, script } of named) {
		const file = join(root, 'pids', `${name}.pid`);
		let pid;
		try {
			pid = Number.parseInt(readFileSync(file, 'utf-8'), 10);
		} catch {
			continue;
		}
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const running = argvOf(pid);
		if (running === null) continue;
		const ours = argv
			? identifyPid(pid, argv) === 'match'
			: running.some((argument) => argument.endsWith(script ?? ' '));
		if (ours) continue;
		try {
			unlinkSync(file);
			log.warn(
				`${label}: removed ${file}, the host's own pid file for ${name}: it named pid ${pid}, which ` +
					`is running \`${running.join(' ')}\`, and the host would have handed that pid back as the ${name} ` +
					`instead of starting one.`
			);
		} catch (error) {
			log.error(
				`${label}: could not remove ${file}, which names pid ${pid} running something else: ` +
					`${error instanceof Error ? error.message : String(error)}. The host will hand that pid back as the ${name} rather than start one.`
			);
		}
	}
}

/**
 * What the node has, for a thread that has nothing.
 *
 * A constrained spawn hands back a pid it never identified, and the guard refuses one running something
 * else, so a thread can end with `started: false` while the node's process is up and healthy under another
 * thread. The refusal is a diagnostic, not the node's health, and a status endpoint answers "is this
 * running" for the node.
 *
 * A thread that watched its own process die re-reads for the opposite reason. `exited` is documented as
 * "true once this thread has seen it die", and it leaves `started` alone, because a deliberate stop is not
 * a failed start. Reading only `started` therefore published a dead process as running: a SIGTERM takes the
 * deliberate branch, which releases the lock and does not restart, and a status endpoint reported that
 * process started and verified for the five minutes it was gone.
 *
 * The second reading is gated on the guard, because the lock is the guard's record and no other supervisor
 * keeps one. Where the host supervises natively there is nothing to re-read and its answer is the node's.
 *
 * @param {Record<string, any>} state @param {string | undefined} pidDir @param {string} [supervision]
 */
export function nodeProcess(state, pidDir, supervision = 'guard') {
	if (!state || !pidDir || !state.name) return state;
	const unstartedHere = state.started === false;
	const diedHere = state.exited === true && supervision === 'guard';
	if (!unstartedHere && !diedHere) return state;
	const held = heldProcess(join(pidDir, `${state.name}.pid`));
	if (!held || identifyPid(held.pid, held.argv) !== 'match')
		// Nothing of this name is running on the node. For a thread that never started one that is already
		// what the state says; for a thread whose own process died it is the correction. The dead pid stays:
		// `started: false` says it is not running, and which pid died is what an operator reads the log for.
		return diedHere ? { ...state, started: false } : state;
	return {
		...state,
		started: true,
		adopted: true,
		exited: false,
		pid: held.pid,
		// No verdict has been taken against this pid by this thread, which is what makes the reader retake
		// one rather than publish the refusal as a health state.
		verified: undefined,
		verifyDetail: undefined,
		verifiedPid: null,
		error: undefined,
		refused: state.error,
	};
}

/**
 * Keep a reaper on the node.
 *
 * Nothing relaunched one before: chaos killed the reaper on a soak at 01:43 and the node ran without orphan
 * cleanup until the next restart forty minutes later, while the status reported it started. The check is a
 * lock read and one identification, so a thread that finds a healthy reaper has done almost nothing; only
 * an absent one reaches `relaunch`, which takes the same lock every thread contends for, so one thread
 * spawns and the rest adopt.
 *
 * @param {object} options
 * @param {string} options.pidDir @param {Record<string, unknown>} options.reaper
 * @param {() => Promise<unknown>} options.relaunch @param {import('./host.js').Log} options.log
 * @param {string} [options.label] @param {string} [options.reaperName]
 * @param {number} [options.everyMs] @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @returns {{ stop: () => void, tick: () => Promise<'present'|'relaunched'|'failed'|'backoff'> }}
 */
export function keepReaperAlive({
	pidDir,
	reaper,
	relaunch,
	log,
	label = 'process guard',
	reaperName = undefined,
	everyMs = REAPER_WATCH_MS,
	setTimer = setInterval,
}) {
	let backoffUntil = 0;
	let wait = everyMs;
	let running = false;

	const tick = async () => {
		// One relaunch at a time per thread: a spawn plus its lock claim can outlast the interval.
		if (running) return 'present';
		if (currentReaper(reaper, pidDir, reaperName)?.started) {
			wait = everyMs;
			return 'present';
		}
		if (Date.now() < backoffUntil) return 'backoff';
		running = true;
		try {
			await relaunch();
			const now = currentReaper(reaper, pidDir, reaperName);
			if (now?.started) {
				wait = everyMs;
				log.warn(`${label}: the reaper was gone and has been relaunched as pid ${now.pid}.`);
				return 'relaunched';
			}
			// It did not come back. Widen the gap rather than spawn every minute against whatever is
			// refusing, and say so once per attempt so the reason reaches a log an operator reads.
			wait = Math.min(wait * 2, REAPER_BACKOFF_MAX_MS);
			backoffUntil = Date.now() + wait;
			log.error(
				`${label}: relaunching the reaper left none running; next attempt in ${Math.round(wait / 1000)}s. ${now?.error ?? ''}`
			);
			return 'failed';
		} catch (error) {
			wait = Math.min(wait * 2, REAPER_BACKOFF_MAX_MS);
			backoffUntil = Date.now() + wait;
			log.error(
				`${label}: relaunching the reaper threw: ${error instanceof Error ? error.message : String(error)}. Next attempt in ${Math.round(wait / 1000)}s`
			);
			return 'failed';
		} finally {
			running = false;
		}
	};

	const timer = setTimer(() => {
		tick().catch(() => {});
	}, everyMs);
	// Never the reason a worker thread stays alive.
	timer?.unref?.();
	return { stop: () => clearInterval(timer), tick };
}
