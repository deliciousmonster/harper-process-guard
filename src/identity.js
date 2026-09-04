// @ts-check
// A process is identified by its command line. /proc/<pid>/exe is kernel-set and unspoofable, and
// useless here: it resolves to the interpreter, so every node script on the box reads identical.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * What is known about a pid. 'unknown' is "not established", which is never "not ours".
 *
 * @typedef {'match' | 'differs' | 'unknown'} Verdict
 */

const PS_TIMEOUT_MS = 2000;

/** @param {unknown} error @returns {string | undefined} */
export function errnoCode(error) {
	return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** @param {unknown} error @returns {string} */
export function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One look at a pid: whether it still runs, and what its command line is. Both answers come from one
 * call, because on darwin each separate question costs a `ps` and these run on every liveness poll.
 *
 * A zombie holds its pid and answers kill(pid, 0), but runs nothing and never will again, so it counts
 * as gone. Only 0 and negatives are refused outright: kill(2) reads those as process GROUPS, whereas
 * pid 1 is a process, and inside a container it is the host this guard watches.
 *
 * @param {number} pid
 * @returns {{ alive: boolean, argv: string[] | null }} argv null is "cannot tell", never "no arguments".
 */
function inspect(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return { alive: false, argv: null };
	try {
		process.kill(pid, 0);
	} catch (error) {
		// EPERM counts as alive: it exists, owned by another user.
		if (errnoCode(error) !== 'EPERM') return { alive: false, argv: null };
	}
	try {
		if (process.platform === 'linux') {
			// comm is parenthesised and may contain spaces and parens, so state is the token after the LAST ')'.
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
			if (
				stat
					.slice(stat.lastIndexOf(')') + 1)
					.trim()
					.startsWith('Z')
			)
				return { alive: false, argv: null };
			// NUL-separated with a trailing NUL. Empty for a kernel thread, and for an unreadable argv area.
			const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
			return { alive: true, argv: raw === '' ? null : raw.replace(/\0$/, '').split('\0') };
		}
		if (process.platform === 'darwin') {
			// execFileSync is absent from Harper's constrained child_process stub; execSync is the only sync
			// option it keeps. Safe as a shell string here only because pid was checked an integer above.
			const [state, ...argv] = execSync(`ps -p ${pid} -o state=,args=`, {
				encoding: 'utf-8',
				timeout: PS_TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
				.trim()
				.split(/\s+/);
			if (state === undefined) return { alive: false, argv: null };
			if (state.startsWith('Z')) return { alive: false, argv: null };
			// `ps` joined the vector with single spaces already, which is why compareArgv compares joined text.
			return { alive: true, argv: argv.length > 0 ? argv : null };
		}
	} catch {
		// The state could not be read. Liveness was already answered by kill(pid, 0), and a command line
		// nothing can read is "cannot tell".
		return { alive: true, argv: null };
	}
	// Anything else. A caller that cannot see must do nothing and say why.
	return { alive: true, argv: null };
}

/** @param {number} pid */
export function isAlive(pid) {
	// A process cannot be a zombie to itself, and asking the OS costs a `ps` on every liveness poll.
	return pid === process.pid || inspect(pid).alive;
}

/** Cadence for a wait measured in seconds: each pass costs a `ps` on darwin, so a tighter one buys nothing and forks hundreds of times. */
export const STOP_POLL_MS = 50;

/** Poll until `pid` is gone or `deadline` passes, whichever comes first. Shared so a caller's grace period is one loop, not one per caller. @param {number} pid @param {number} deadline @param {number} pollMs */
export async function waitWhileAlive(pid, deadline, pollMs) {
	while (Date.now() < deadline && isAlive(pid)) await delay(pollMs);
}

/** @param {number} pid @returns {string[] | null} */
export function argvOf(pid) {
	return inspect(pid).argv;
}

/**
 * `expected` must be a LEADING RUN of the pid's own argv, so pinning more of the command line can only
 * ever narrow a verdict. An empty `expected` describes no process, so it identifies none.
 *
 * @param {readonly string[] | null} actual
 * @param {readonly string[]} expected
 * @returns {Verdict}
 */
export function compareArgv(actual, expected) {
	if (expected.length === 0 || actual === null) return 'unknown';
	if (process.platform === 'darwin') {
		// Joined, because `ps` joined it already and re-splitting reads one spaced argument as two. The
		// trailing space is what keeps `--conf` from matching a prefix of `--config`.
		const head = actual.join(' ');
		const want = expected.join(' ');
		return head === want || head.startsWith(`${want} `) ? 'match' : 'differs';
	}
	return expected.every((argument, index) => actual[index] === argument) ? 'match' : 'differs';
}

/** @param {number} pid @param {readonly string[]} expected @returns {Verdict} */
export function identify(pid, expected) {
	const { alive, argv } = inspect(pid);
	return alive ? compareArgv(argv, expected) : 'differs';
}
