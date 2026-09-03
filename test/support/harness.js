// @ts-check
// Shared scaffolding: temp directories, real child processes, and a spawn that records what it was asked for.
import { spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** test/support sits two levels below the repo root. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');

/** @param {string} name @returns {string} */
export const fixture = (name) => path.join(FIXTURES, name);

/**
 * mkdtemp pre-resolved: the macOS tmpdir sits behind /var -> /private/var, and these suites compare
 * paths against `ps` output, which is already resolved.
 *
 * @param {string} prefix
 */
export function makeTempDir(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * A temp dir around `run`, removed however it ends. A test must RETURN this call: a fire-and-forget
 * rejection is held by nobody and the test passes.
 *
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T | Promise<T>} run
 * @returns {Promise<Awaited<T>>}
 */
export async function withTempDir(prefix, run) {
	const dir = makeTempDir(prefix);
	try {
		return await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Poll `predicate` until it holds, or throw naming what never happened. Never returns false: a test
 * that silently gave up would read as a pass.
 *
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {string} what
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitFor(predicate, what, { timeoutMs = 10_000, intervalMs = 10 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** A pid nothing holds: a real process, run to completion and reaped, so the number was genuinely issued. */
export async function deadPid() {
	const child = realSpawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
	await once(child, 'exit');
	if (typeof child.pid !== 'number') throw new Error('the throwaway process reported no pid');
	return child.pid;
}

/** Lines by level, so a test can assert what was said rather than that something was. */
export function captureLog() {
	/** @type {{ info: string[], warn: string[], error: string[] }} */
	const lines = { info: [], warn: [], error: [] };
	return {
		lines,
		all: () => [...lines.info, ...lines.warn, ...lines.error],
		info: (/** @type {string} */ m) => lines.info.push(m),
		warn: (/** @type {string} */ m) => lines.warn.push(m),
		error: (/** @type {string} */ m) => lines.error.push(m),
	};
}

/**
 * Real children through a spawn that records its calls, all killed however `run` ends. Real, because
 * a fake child has no pid the identification can read and no argv anything can be counted by.
 *
 * @template T
 * @param {(tools: { spawn: import('../../src/supervise.js').Spawn, calls: { command: string, args: string[] }[], children: import('node:child_process').ChildProcess[] }) => T | Promise<T>} run
 * @returns {Promise<Awaited<T>>}
 */
export async function withSpawn(run) {
	/** @type {import('node:child_process').ChildProcess[]} */
	const children = [];
	/** @type {{ command: string, args: string[] }[]} */
	const calls = [];
	/** @type {import('../../src/supervise.js').Spawn} */
	const spawn = (command, args, options) => {
		const child = realSpawn(command, args, options);
		children.push(child);
		calls.push({ command, args });
		return child;
	};
	try {
		return await run({ spawn, calls, children });
	} finally {
		for (const child of children) {
			try {
				child.kill('SIGKILL');
			} catch {
				// Already gone, which is the outcome asked for.
			}
		}
	}
}

/**
 * A supervise Context with the timings wound down, so a restart test measures the behaviour rather
 * than the backoff schedule.
 *
 * @param {string} pidDir
 * @param {import('../../src/supervise.js').Spawn} spawn
 * @param {Omit<Partial<import('../../src/supervise.js').Context>, 'log'>} [overrides]
 */
export function context(pidDir, spawn, overrides = {}) {
	return {
		pidDir,
		spawn,
		version: 1,
		stopOrphans: false,
		log: captureLog(),
		claimTimeoutMs: 5000,
		report: [],
		run: { stopping: false },
		tuning: { joinedPollMs: 20, restartMax: 5, restartBaseMs: 10, restartCapMs: 40 },
		...overrides,
	};
}

/**
 * A lock as this guard writes it: pid on line 1, version on line 2, the guard's own record on line 3.
 * Written by hand rather than through the module under test, so a broken writer cannot seed a passing test.
 *
 * @param {string} file
 * @param {{ pid: number, version?: number, token?: string, host?: number, argv?: readonly string[] }} lock
 */
export function seedLock(file, { pid, version = 1, token = 'seeded', host = 1, argv = [] }) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${pid}\n${version}\n${JSON.stringify({ token, host, argv })}\n`, 'utf-8');
}

/**
 * How many processes on this machine are running exactly this command line. Counted from the process
 * table rather than from the guard's own bookkeeping, because the bookkeeping is what is under test.
 *
 * @param {readonly string[]} argv
 */
export function countRunning(argv) {
	const wanted = argv.join(' ');
	const table = realSpawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf-8' }).stdout ?? '';
	return table.split('\n').filter((line) => line.trim().replace(/\s+/g, ' ') === wanted).length;
}

/** The first line a fixture writes once it is doing its job, so nothing signals it too early. @param {import('node:child_process').ChildProcess} child */
export function readyLine(child) {
	return new Promise((resolve) => child.stdout?.once('data', (chunk) => resolve(String(chunk).trim())));
}

/** @param {import('node:child_process').ChildProcess} child */
export function pidOf(child) {
	if (typeof child.pid !== 'number') throw new Error('the child reported no pid');
	return child.pid;
}
