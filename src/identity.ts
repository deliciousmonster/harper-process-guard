/**
 * What a pid refers to, as distinct from whether something holds it.
 *
 * `process.kill(pid, 0)` answers "is this number in use", which is the question Harper's PID
 * lock asks and the reason a stale lock adopts a stranger. It is weaker than it looks:
 * measured on Linux it returns true for a worker THREAD's tid, so on a node whose worker
 * threads occupy tids 956-963 and whose child processes get 964 and 970, a lock left by a
 * previous boot lands inside the thread range and answers yes.
 *
 * The three-way answer is the point. "Not ours" and "cannot tell" are different facts and a
 * caller must be able to act differently on them: the first permits a signal, the second
 * forbids one. Collapsing them into a boolean is how a sweep comes to SIGTERM something it
 * never identified, which is the upstream defect restated rather than fixed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import { errnoCode } from './errors.js';

/** True if some process holds this pid. EPERM counts: it exists, owned by another user. */
export function isAlive(pid: number): boolean {
	// Non-positive values are process-GROUP selectors to kill(2), not pids: 0 is the caller's
	// own group and a negative is group -n. Asking about either answers a different question.
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoCode(error) === 'EPERM';
	}
}

/**
 * What the platform says is running behind a pid, or null when it cannot be established.
 *
 * Absolute on Linux, and on macOS whatever the process was invoked as, which may be a bare
 * name. `identify` handles that difference; this returns the platform's answer unchanged.
 *
 * Null covers a platform this cannot read, a process owned by another user, and a pid that
 * exited while being asked. Callers must not read it as "not ours".
 */
export function executableOf(pid: number): string | null {
	if (!isAlive(pid)) return null;
	try {
		if (process.platform === 'linux') {
			// The kernel's own answer, unlike cmdline, which argv can rewrite. A process whose
			// binary was replaced on disk reads as "/path (deleted)", which will not match a
			// resolved path and correctly yields 'differs' rather than a false match.
			return realpathSync(readlinkSync(`/proc/${pid}/exe`));
		}
		if (process.platform === 'darwin') {
			// macOS `comm` reports the path as invoked, so it is absolute for a process started
			// from an absolute path and a bare name for one found on PATH: measured, a
			// PATH-spawned `sleep` reports "sleep". Returned raw, and resolved by the caller
			// only when it is absolute, because realpath of a bare name throws ENOENT and would
			// turn a perfectly identifiable process into "cannot tell".
			const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
				encoding: 'utf-8',
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim();
			return out === '' ? null : out;
		}
		// Windows and anything else. A sweep that cannot see must do nothing and say why.
		return null;
	} catch {
		return null;
	}
}

export type Identification =
	/** This pid is running that binary. A caller may act on it. */
	| 'match'
	/** This pid is running something else. A caller must not signal it. */
	| 'differs'
	/** Not established. A caller must not signal it, and should say so. */
	| 'unknown';

/**
 * Whether `pid` is running `binaryPath`, with "cannot tell" kept distinct from "no".
 *
 * The asymmetry between the two negative answers is deliberate. A full path that differs
 * proves a different process. A bare name that differs also proves it, because no path ends
 * in a different basename. But a bare name that MATCHES proves nothing: two binaries called
 * `agent` in different directories share it. So a basename match yields 'unknown', never
 * 'match', which keeps the only answer that permits a signal resting on a full path.
 */
export function identify(pid: number, binaryPath: string): Identification {
	if (!binaryPath) return 'unknown';
	if (!isAlive(pid)) return 'differs';
	const actual = executableOf(pid);
	if (actual === null) return 'unknown';

	let expected: string;
	try {
		expected = realpathSync(binaryPath);
	} catch {
		// The binary we expected is not on disk. That says nothing about the process.
		return 'unknown';
	}

	if (isAbsolute(actual)) {
		try {
			return realpathSync(actual) === expected ? 'match' : 'differs';
		} catch {
			// A path that will not resolve, such as Linux's "(deleted)" suffix for a binary
			// replaced under a running process. Different from ours, and not ours to signal.
			return actual === expected ? 'match' : 'differs';
		}
	}
	return basename(actual) === basename(expected) ? 'unknown' : 'differs';
}

/**
 * Read a Harper PID lock: pid on line 1, version fingerprint on line 2.
 *
 * Parsed with the tolerance Harper reads it with, so this never disagrees with the lock about
 * what the lock says.
 */
export function readLock(path: string): { pid: number; version: number } | null {
	try {
		const lines = readFileSync(path, 'utf-8').trim().split('\n');
		const pid = Number.parseInt(lines[0] ?? '', 10);
		if (!Number.isInteger(pid)) return null;
		return { pid, version: lines.length > 1 ? Number.parseInt(lines[1] ?? '', 10) : 0 };
	} catch {
		return null;
	}
}

/**
 * Whether this platform's identification is trustworthy enough to authorise a signal.
 *
 * False on darwin, and the reason is not conservatism. `ps -o comm=` reports argv[0], which
 * the process being examined chooses: measured, `spawn('/bin/sleep', ['5'], { argv0:
 * '/path/to/datadog-trace-agent' })` makes `comm` print that path verbatim while the binary is
 * still /bin/sleep. So a `match` on darwin means "something claims to be our binary", which is
 * enough to leave a process alone and nowhere near enough to send it a signal. The Linux branch
 * reads /proc/<pid>/exe, which the kernel fills in and argv cannot touch.
 *
 * The asymmetry is the point. A wrong `match` that causes inaction is harmless; a wrong `match`
 * that causes a SIGTERM is the defect this module exists to prevent, arriving from the inside.
 */
export function identificationCanAuthoriseSignal(): boolean {
	return process.platform === 'linux';
}

/**
 * The OS's own record of when a process started, as an opaque string, or null.
 *
 * Read rather than computed, which is the whole point. Deriving a start time as
 * `Date.now() - process.uptime() * 1000` mixes a wall clock with a monotonic one, so every
 * NTP step, VM resume or host time sync moves the answer; two threads of one process that
 * computed it either side of a step disagree about which process they belong to. The kernel's
 * recorded value does not move when the clock does.
 *
 * Opaque because callers only ever compare it for equality. On Linux it is field 22 of
 * /proc/<pid>/stat, starttime in clock ticks since boot, paired with the boot id so it cannot
 * collide across a reboot. On darwin it is the start time `ps` reports, which is captured at
 * exec and not recomputed.
 */
export function processStartToken(pid: number = process.pid): string | null {
	try {
		if (process.platform === 'linux') {
			// Field 22, counting from 1, but comm can contain spaces and parentheses, so the
			// fields are taken from after the last ')' rather than by splitting the whole line.
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
			const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			const starttime = after[19];
			if (!starttime) return null;
			let boot = '';
			try {
				boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
			} catch {
				// Older kernels and some sandboxes. starttime alone still distinguishes two
				// processes within one boot, which is the case that matters here.
			}
			return `${boot}:${starttime}`;
		}
		if (process.platform === 'darwin') {
			const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
				encoding: 'utf-8',
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim();
			return out === '' ? null : out;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Process identity taken from Harper's own `hdb.pid`, for platforms with no start token.
 *
 * Harper writes that file once per start, so its mtime is the start time and every worker
 * thread reads the same bytes from the same file rather than each deriving a value. That is
 * the property the derived fallback lacks: `Date.now() - process.uptime() * 1000` mixes a wall
 * clock with a monotonic one, so a clock step moves it, and two threads either side of a step
 * disagree about which process they belong to.
 *
 * Returns null when the file is absent or does not name this process, which is the honest
 * answer rather than a guess: a caller then falls back to whatever the OS offers.
 */
export function harperIdentity(rootPath: string): { pid: number; token: string; startedAt: number } | null {
	try {
		const file = join(rootPath, 'hdb.pid');
		const recorded = Number.parseInt(readFileSync(file, 'utf-8').trim(), 10);
		// A pid that is not ours means the file belongs to a different Harper, and adopting its
		// identity would make this process claim to be one it is not.
		if (recorded !== process.pid) return null;
		const { mtimeMs, ino } = statSync(file);
		// The inode as well as the time: a file rewritten within the same millisecond is a
		// different file, and on a filesystem with coarse timestamps that is reachable.
		return { pid: process.pid, token: `hdb:${Math.round(mtimeMs)}:${ino}`, startedAt: Math.round(mtimeMs) };
	} catch {
		return null;
	}
}
