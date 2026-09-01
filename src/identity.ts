// process.kill(pid, 0) answers "is this number in use"; measured on Linux even a worker thread's tid answers yes, so liveness alone adopts strangers.
// "Not ours" and "cannot tell" stay distinct: only the first permits a signal.
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import { errnoCode } from './errors.js';

/** The state field of /proc/<pid>/stat, or null. comm is parenthesised and may itself contain spaces and parens, so the state is the token after the LAST ')'. */
export function parseProcStatState(stat: string): string | null {
	const commEnd = stat.lastIndexOf(')');
	if (commEnd === -1) return null;
	const [state] = stat
		.slice(commEnd + 1)
		.trim()
		.split(/\s+/, 1);
	return state || null;
}

/** A zombie still holds its pid but runs nothing and never will again; kill(pid, 0) cannot see that. */
function isZombie(pid: number): boolean {
	try {
		if (process.platform === 'linux') {
			return parseProcStatState(readFileSync(`/proc/${pid}/stat`, 'utf-8')) === 'Z';
		}
		if (process.platform === 'darwin') {
			const state = execFileSync('ps', ['-p', String(pid), '-o', 'state='], {
				encoding: 'utf-8',
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim();
			return state.startsWith('Z');
		}
	} catch {
		// An unreadable state says nothing; liveness was already answered by kill(pid, 0).
	}
	return false;
}

/** True if some process holds this pid AND still runs: a dead-but-unreaped zombie answers kill(pid, 0), and reading it as alive adopts a corpse. EPERM counts: it exists, owned by another user. */
export function isAlive(pid: number): boolean {
	// Non-positive values are process-GROUP selectors to kill(2), not pids: 0 is the caller's
	// own group and a negative is group -n. Asking about either answers a different question.
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (errnoCode(error) !== 'EPERM') return false;
	}
	return !isZombie(pid);
}

/** Executable behind a pid: absolute on Linux, as-invoked (possibly bare) on macOS; null means "cannot tell", never "not ours". */
export function executableOf(pid: number): string | null {
	if (!isAlive(pid)) return null;
	try {
		if (process.platform === 'linux') {
			// /proc/<pid>/exe is kernel-set (argv cannot rewrite it); a replaced binary reads
			// "/path (deleted)", which fails the match as 'differs'.
			return realpathSync(readlinkSync(`/proc/${pid}/exe`));
		}
		if (process.platform === 'darwin') {
			// `comm` is the path as invoked, so a PATH-spawned process reports a bare name. Returned
			// raw: realpath of a bare name throws and would turn identifiable into "cannot tell".
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

/** The argument vector behind a pid, argv[0] excluded; null is "cannot tell", never "no arguments". Unlike /proc/<pid>/exe this is the process's OWN memory, so it can rewrite it: see identify(). */
export function argumentsOf(pid: number): string[] | null {
	if (!isAlive(pid)) return null;
	try {
		if (process.platform === 'linux') {
			// NUL-separated with a trailing NUL. Empty for a kernel thread and for a process whose
			// argv area is unreadable, which is "cannot tell" rather than "no arguments".
			const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
			if (raw === '') return null;
			return raw.replace(/\0$/, '').split('\0').slice(1);
		}
		if (process.platform === 'darwin') {
			// `ps` has already joined the vector with single spaces, so an argument containing a
			// space is indistinguishable from two arguments; identifyArguments() compares joined.
			const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
				encoding: 'utf-8',
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim();
			return out === '' ? null : out.split(/\s+/).slice(1);
		}
		// Windows and anything else, same as executableOf: a caller that cannot see must do nothing.
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

/** The argv half of identify(), and its own function so the unreadable case is testable without a process whose argv cannot be read. `expected` must be a LEADING RUN of `actual`, so a caller pins as much of the command as it knows is stable. */
export function identifyArguments(actual: readonly string[] | null, expected: readonly string[]): Identification {
	if (expected.length === 0) return 'match';
	if (actual === null) return 'unknown';
	if (process.platform === 'darwin') {
		// Compared as joined text, because `ps` joined it already and re-splitting reads one
		// spaced argument as two; the boundary check keeps `--conf` from matching `--config`.
		const head = actual.join(' ');
		const want = expected.join(' ');
		return head === want || head.startsWith(`${want} `) ? 'match' : 'differs';
	}
	return expected.every((argument, index) => actual[index] === argument) ? 'match' : 'differs';
}

/** 'match' requires full-path equality of the executable, and `expectedArgs` as a leading run of the process's own arguments. A bare-name mismatch still proves 'differs', but a bare-name match proves nothing (two binaries share a basename) and yields 'unknown'. */
export function identify(pid: number, binaryPath: string, expectedArgs: readonly string[] = []): Identification {
	const executable = identifyExecutable(pid, binaryPath);
	// An interpreter is the same executable for every script it runs, so `node a.js` and `node b.js`
	// are one identity until argv separates them. Nothing expected (a native binary): unchanged.
	if (executable !== 'match' || expectedArgs.length === 0) return executable;
	// argv lives in the examined process's own memory and it may rewrite it, where /proc/<pid>/exe is
	// kernel-set. It raises confidence against pid reuse and a stale lock, and forges nothing away.
	return identifyArguments(argumentsOf(pid), expectedArgs);
}

/** The executable half, which is all identification was until scripts made one executable serve every consumer. */
function identifyExecutable(pid: number, binaryPath: string): Identification {
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

/** Harper PID lock: pid on line 1, version on line 2, parsed with Harper's own tolerance so this never disagrees with what the lock says. */
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

/** Linux only: /proc/<pid>/exe is kernel-set. macOS `comm` is argv[0], which the examined process chooses (measured: an argv0 spoof prints verbatim), so a darwin 'match' justifies inaction, never a signal. */
export function identificationCanAuthoriseSignal(): boolean {
	return process.platform === 'linux';
}

/** Opaque, equality-only start token: Linux starttime plus boot id, darwin lstart. Read from the OS, never derived; Date.now() - uptime() mixes clocks, so a step splits threads of one process. */
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

/** Identity from hdb.pid, written once per start: every thread reads the same bytes, immune to the clock steps that split the derived fallback. Null unless the file names this pid. */
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
