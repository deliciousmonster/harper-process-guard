/**
 * The spawn orchestrator, against a stub of Harper's constrained spawn.
 *
 * A stub is the honest fixture here, not a shortcut: the orchestrator's contract is entirely
 * "what it does with whatever spawn the caller hands it", and Harper's spawn has exactly three
 * behaviours - throw synchronously, return a real ChildProcess, or return an adoption wrapper
 * distinguishable only by the absence of spawnargs. All three are cheap to fake and impossible
 * to produce on demand from a real Harper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, makeTempDir, withTempDir } from '../support/harness.js';

const { assertConstrainedSpawn, fingerprint, launchReaper, preflightBinary, startProcess } =
	await importDist('spawn.js');

/** A logger that records instead of printing. */
function recordingLog() {
	const lines = { info: [], warn: [], error: [] };
	return {
		lines,
		info: (m) => lines.info.push(m),
		warn: (m) => lines.warn.push(m),
		error: (m) => lines.error.push(m),
	};
}

/** A real-ChildProcess-shaped stub: has spawnargs, so the orchestrator reads it as a win. */
function wonChild(pid = 4321) {
	const child = new EventEmitter();
	child.pid = pid;
	child.spawnargs = ['stub'];
	child.unref = () => {
		child.unrefed = true;
	};
	return child;
}

/** The adoption wrapper: no spawnargs, which is the only reliable tell. */
function adoptedChild(pid = 4321) {
	const child = new EventEmitter();
	child.pid = pid;
	child.unref = () => {
		child.unrefed = true;
	};
	return child;
}

const PROC = (binaryPath) => ({ name: 'agent', title: 'test agent', binaryPath, args: ['run'] });

test('fingerprint is a number inside 2^31, stable, and moved by any input', () => {
	const a = fingerprint('cfg', 'key');
	assert.equal(typeof a, 'number');
	assert.ok(Number.isInteger(a) && a >= 0 && a < 2 ** 31, 'must round-trip through parseInt unchanged');
	assert.equal(a, fingerprint('cfg', 'key'));
	assert.notEqual(a, fingerprint('cfg', 'rotated-key'), 'a rotated credential must move it');
});

test('preflight refuses a path with a space, naming why no allowlist entry can help', () => {
	assert.throws(() => preflightBinary('agent', '/has a space/agent'), /split\(" "\)\[0\]/);
	assert.throws(() => preflightBinary('agent', '/nonexistent/agent'), /missing/);
});

test('a winning spawn: started, not adopted, and the error listener is attached before return', () => {
	const child = wonChild();
	const log = recordingLog();
	const state = startProcess(() => child, PROC(process.execPath), { version: 1, log });

	assert.equal(state.started, true);
	assert.equal(state.adopted, false);
	assert.equal(state.pid, 4321);
	// An unhandled 'error' on a ChildProcess is an uncaught exception that takes the worker
	// thread with it, and the event is asynchronous, so the listener must exist already.
	assert.ok(child.listenerCount('error') >= 1, 'no error listener: the next tick can kill the thread');
	child.emit('error', Object.assign(new Error('Exec format error'), { code: 'ENOEXEC' }));
	assert.match(log.lines.error[0] ?? '', /not executable code for this machine/);
});

test('a lost race: adopted, unref called so the wrapper interval cannot pin the event loop', () => {
	const child = adoptedChild(999);
	const state = startProcess(() => child, PROC(process.execPath), { version: 1, log: recordingLog() });
	assert.equal(state.adopted, true);
	assert.equal(child.unrefed, true, 'the wrapper polls on a never-unref-d interval; unref is what clears it');
});

test('an allowlist refusal is reported with the exact path to allowlist', () => {
	const log = recordingLog();
	const state = startProcess(
		() => {
			throw new Error(`Command ${process.execPath} is not allowed`);
		},
		PROC(process.execPath),
		{ version: 1, log }
	);
	assert.equal(state.started, false);
	assert.match(log.lines.error[0], /allowedSpawnCommands/);
	assert.ok(log.lines.error[0].includes(process.execPath), 'the operator needs the verbatim path');
});

test('an unresolved binary path is an error state, and spawn is never called', () => {
	let called = 0;
	const state = startProcess(
		() => {
			called++;
			return wonChild();
		},
		PROC(''),
		{ version: 1, log: recordingLog() }
	);
	assert.equal(state.started, false);
	assert.equal(called, 0);
});

test('a crash signal respawns with backoff; a shutdown signal does not', async () => {
	const spawns = [];
	const spawn = () => {
		const child = wonChild();
		spawns.push(child);
		return child;
	};
	startProcess(spawn, PROC(process.execPath), { version: 1, log: recordingLog() });
	assert.equal(spawns.length, 1);

	// SIGTERM is someone asking it to stop; restarting into that would fight the shutdown.
	spawns[0].emit('exit', null, 'SIGTERM');
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(spawns.length, 1, 'a SIGTERM was respawned');

	// SIGKILL is the OOM killer or a crash: the case nothing else recovers from.
	const again = [];
	const spawn2 = () => {
		const child = wonChild();
		again.push(child);
		return child;
	};
	startProcess(spawn2, PROC(process.execPath), { version: 1, log: recordingLog() });
	again[0].emit('exit', null, 'SIGKILL');
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(again.length, 2, 'a SIGKILL must produce one respawn');
});

test('the interception probe reads a synchronous throw as constrained, and a returned child as stock Node', () => {
	const log = recordingLog();
	const yes = assertConstrainedSpawn(() => {
		throw new Error('Command x is not allowed');
	}, log);
	assert.equal(yes.intercepted, true);

	const probe = wonChild();
	const no = assertConstrainedSpawn(() => probe, log);
	assert.equal(no.intercepted, false);
	// The probe command does not exist; its ENOENT arrives later as an 'error' event, which
	// unhandled would kill the worker thread.
	assert.ok(probe.listenerCount('error') >= 1);
	assert.equal(probe.unrefed, true);
	assert.match(log.lines.error[0], /NOT ACTIVE/);
});

test('the reaper launch carries base64 targets with binary paths, and skips when nothing started', () =>
	withTempDir('orch-reaper-', (dir) => {
		const script = path.join(dir, 'reaper.js');
		fs.writeFileSync(script, '// stub');
		const calls = [];
		const spawn = (command, args) => {
			calls.push({ command, args });
			return wonChild(777);
		};
		const running = [
			{ name: 'a', started: true, pid: 11, binaryPath: '/bin/a', title: 'a' },
			{ name: 'b', started: false, title: 'b', binaryPath: '/bin/b' },
		];
		const state = launchReaper(spawn, {
			reaperScript: script,
			rootPath: dir,
			processes: running,
			version: 7,
			log: recordingLog(),
		});
		assert.equal(state.started, true);
		const targets = calls[0].args
			.filter((arg, i) => calls[0].args[i - 1] === '--target')
			.map((b) => JSON.parse(Buffer.from(b, 'base64').toString('utf-8')));
		// Only the started process is a target, and it carries the binary path the reaper
		// needs to identify it before signalling.
		assert.deepEqual(targets, [{ pidFile: path.join(dir, 'pids', 'a.pid'), pid: 11, binaryPath: '/bin/a' }]);

		const none = launchReaper(spawn, {
			reaperScript: script,
			rootPath: dir,
			processes: [{ name: 'a', started: false }],
			version: 7,
			log: recordingLog(),
		});
		assert.equal(none.started, false);
		assert.match(none.error, /nothing to stop/);
	}));

test('the reaper falls back from execPath to node when the first command is refused', () =>
	withTempDir('orch-fallback-', (dir) => {
		const script = path.join(dir, 'reaper.js');
		fs.writeFileSync(script, '// stub');
		const tried = [];
		const spawn = (command) => {
			tried.push(command);
			if (command === process.execPath) throw new Error(`Command ${command} is not allowed`);
			return wonChild(778);
		};
		const state = launchReaper(spawn, {
			reaperScript: script,
			rootPath: dir,
			processes: [{ name: 'a', started: true, pid: 11, binaryPath: '/bin/a' }],
			version: 7,
			log: recordingLog(),
		});
		assert.deepEqual(tried, [process.execPath, 'node']);
		assert.equal(state.command, 'node');
		assert.equal(state.started, true);
	}));
