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

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

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
