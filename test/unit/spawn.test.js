// Harper's spawn has exactly three behaviours (throw synchronously, return a real ChildProcess, or return an
// adoption wrapper distinguishable only by missing spawnargs): all cheap to stub, impossible to produce on demand from a real Harper.
// Death and supervision live next door in supervision-matrix.test.js; what is left here is launch shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, withTempDir } from '../support/harness.js';

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

test('caller hints reach the messages the genericization stripped', () =>
	withTempDir('orch-hints-', (dir) => {
		// The generic not-active report says "fail to bind their ports"; the hint is where the
		// caller restores the concrete consequence the original named.
		const probeLog = recordingLog();
		const probe = wonChild();
		assertConstrainedSpawn(() => probe, probeLog, 'All but one trace-agent will fail to bind 127.0.0.1:8126.');
		assert.ok(probeLog.lines.error[0].includes('fail to bind 127.0.0.1:8126'));

		const script = path.join(dir, 'reaper.js');
		fs.writeFileSync(script, '// stub');
		const processes = [{ name: 'a', started: true, pid: 11, binaryPath: '/bin/a' }];

		const startedLog = recordingLog();
		launchReaper(() => wonChild(557), {
			reaperScript: script,
			rootPath: dir,
			processes,
			version: 7,
			log: startedLog,
			startedHint: 'It stops the trace-agent and the core agent.',
		});
		assert.ok(startedLog.lines.info.some((line) => line.includes('It stops the trace-agent and the core agent.')));

		const missingLog = recordingLog();
		launchReaper(() => wonChild(558), {
			reaperScript: path.join(dir, 'absent.js'),
			rootPath: dir,
			processes,
			version: 7,
			log: missingLog,
			outliveHint: '127.0.0.1:8126 stays bound.',
		});
		assert.ok(missingLog.lines.error[0].includes('127.0.0.1:8126 stays bound.'), 'the hint missed the report');
	}));

test('the reaper launch records each running process in a descriptor and names the pid dir on the command line', () =>
	withTempDir('orch-descriptors-', (dir) => {
		const script = path.join(dir, 'reaper.js');
		fs.writeFileSync(script, '// stub');
		const calls = [];
		launchReaper(
			(command, args) => {
				calls.push(args);
				return wonChild(777);
			},
			{
				reaperScript: script,
				rootPath: dir,
				processes: [
					{ name: 'a', started: true, pid: 11, binaryPath: '/bin/a', title: 'a' },
					{ name: 'b', started: false, title: 'b', binaryPath: '/bin/b' },
				],
				version: 7,
				log: recordingLog(),
			}
		);
		const pidDir = path.join(dir, 'pids');
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pidDir, 'a.guard.json'), 'utf-8')), {
			name: 'a',
			pidFile: path.join(pidDir, 'a.pid'),
			pid: 11,
			binaryPath: '/bin/a',
		});
		assert.equal(fs.existsSync(path.join(pidDir, 'b.guard.json')), false, 'an unstarted process was recorded');
		const flagAt = calls[0].indexOf('--pid-dir');
		assert.notEqual(flagAt, -1, 'the reaper was not told where the descriptors live');
		assert.equal(calls[0][flagAt + 1], pidDir);
	}));
