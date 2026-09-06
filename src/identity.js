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
// Every thread of a host probes the same lock at once and PowerShell does not start eight times in
// parallel: 400ms alone, 2.9-3.6s apiece for eight at once, measured on a 2-vCPU windows-latest runner.
const CIM_TIMEOUT_MS = 10_000;
/** The longest one inspect() can take ON THIS HOST. lock.js holds its gate across an identify, so a waiter
 * that gives up sooner breaks a gate a live thread is still inside, and both then decide one lock at once. */
export const IDENTIFY_BUDGET_MS = process.platform === 'win32' ? CIM_TIMEOUT_MS : PS_TIMEOUT_MS;
/** The two answers the win32 probe may print, so the script that writes them and the reader below are one protocol. */
const LIVE = 'live';
const GONE = 'gone';

/** @param {unknown} error @returns {string | undefined} */
export function errnoCode(error) {
	return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** @param {unknown} error @returns {string} */
export function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The win32 probe's answer, or null when it printed neither. 'gone' is "no such process"; 'live' with
 * nothing after it is a process that exists and would not say what it is, which stays "cannot tell".
 *
 * @param {string} stdout
 * @returns {{ alive: boolean, argv: string[] | null } | null}
 */
export function parseCimAnswer(stdout) {
	// PowerShell may put a BOM in front of redirected output; the marker still has to start the answer.
	const text = stdout.replace(/^\uFEFF/, '').trim();
	if (text === GONE) return { alive: false, argv: null };
	if (text !== LIVE && !text.startsWith(`${LIVE} `)) return null;
	const commandLine = text.slice(LIVE.length).trim();
	return { alive: true, argv: commandLine === '' ? null : [commandLine] };
}

/**
 * One argument as libuv writes it into a Windows command line (src/win/process.c, quote_cmd_arg). Windows
 * keeps no argv, so the recorded vector has to be quoted the way it was to compare against what it kept.
 *
 * @param {string} argument
 * @returns {string}
 */
function quoteForWindows(argument) {
	if (argument.length === 0) return '""';
	if (!/[ \t"]/.test(argument)) return argument;
	if (!/["\\]/.test(argument)) return `"${argument}"`;
	let escaped = '';
	let backslashes = 0;
	for (const character of argument) {
		if (character === '\\') {
			backslashes += 1;
			continue;
		}
		// A run of backslashes is doubled only where it meets a quote, the closing one below included.
		escaped += character === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${character}`;
		backslashes = 0;
	}
	return `"${escaped}${'\\'.repeat(backslashes * 2)}"`;
}

/** The command line Windows reports for a process node spawned with `argv`. @param {readonly string[]} argv @returns {string} */
export function windowsCommandLine(argv) {
	return argv.map(quoteForWindows).join(' ');
}

/**
 * One look at a pid: whether it still runs, and what its command line is. Where one read answers both it
 * does, because on darwin a separate liveness question would cost a second `ps` on every poll.
 *
 * A zombie holds its pid and answers kill(pid, 0), but runs nothing and never will again, so it counts
 * as gone. Only 0 and negatives are refused outright: kill(2) reads those as process GROUPS, whereas
 * pid 1 is a process, and inside a container it is the host this guard watches.
 *
 * @param {number} pid
 * @param {boolean} [withCommandLine] False asks liveness alone. It changes nothing on linux or darwin,
 *   where one read answers both, and skips a PowerShell on win32, where kill(pid, 0) settles liveness.
 * @returns {{ alive: boolean, argv: string[] | null }} argv null is "cannot tell", never "no arguments".
 */
function inspect(pid, withCommandLine = true) {
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
		if (process.platform === 'win32') {
			// Liveness never reaches the probe: libuv's kill(pid, 0) reads GetExitCodeProcess and
			// WaitForSingleObject, so a terminated pid an open handle still names read ESRCH above.
			if (!withCommandLine) return { alive: true, argv: null };
			// PowerShell CIM, because `wmic` is absent from recent Windows and `tasklist` has no command
			// line. 400ms a call measured against 3.5ms for `ps`, which is why nothing polls it.
			const script =
				`[Console]::OutputEncoding=[Text.Encoding]::UTF8;` +
				`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop;` +
				`if($null -eq $p){'${GONE}'}else{'${LIVE} '+$p.CommandLine}`;
			const stdout = execSync(`powershell.exe -NoProfile -NonInteractive -Command "${script}"`, {
				encoding: 'utf-8',
				timeout: CIM_TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			return parseCimAnswer(stdout) ?? { alive: true, argv: null };
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
	// A process cannot be a zombie to itself, and the command line is not part of this question.
	return pid === process.pid || inspect(pid, false).alive;
}

/** Cadence for a wait measured in seconds: each pass costs a `ps` on darwin, so a tighter one buys nothing and forks hundreds of times. */
export const STOP_POLL_MS = 50;

/** Poll until `pid` is gone or `deadline` passes, whichever comes first. Shared so a caller's grace period is one loop, not one per caller. @param {number} pid @param {number} deadline @param {number} pollMs */
export async function waitWhileAlive(pid, deadline, pollMs) {
	while (Date.now() < deadline && isAlive(pid)) await delay(pollMs);
}

/**
 * On darwin and win32 this is the whole command line in ONE element, because that is all either OS reports.
 * Never an expectation for identify(): win32 re-quotes what it is handed, and a joined line does not survive it.
 *
 * @param {number} pid @returns {string[] | null}
 */
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
	if (process.platform === 'darwin' || process.platform === 'win32') {
		// Joined, because both report one string and re-splitting reads a spaced argument as two. The
		// trailing space is what keeps `--conf` from matching a prefix of `--config`.
		const head = actual.join(' ');
		const want = process.platform === 'win32' ? windowsCommandLine(expected) : expected.join(' ');
		return head === want || head.startsWith(`${want} `) ? 'match' : 'differs';
	}
	return expected.every((argument, index) => actual[index] === argument) ? 'match' : 'differs';
}

/** @param {number} pid @param {readonly string[]} expected @returns {Verdict} */
export function identify(pid, expected) {
	const { alive, argv } = inspect(pid);
	return alive ? compareArgv(argv, expected) : 'differs';
}
