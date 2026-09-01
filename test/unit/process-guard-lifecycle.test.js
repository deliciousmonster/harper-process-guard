// The one-call lifecycle: sweep, config writes, spawns, reaper, verify, against a stub of Harper's spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, importDist, withTempDir } from '../support/harness.js';

const { bootstrap } = await importDist('index.js');
const { fingerprint } = await importDist('spawn.js');

const DEAD_PID = 2147483646;
const REAPER_NAME = 'harper-process-guard-reaper';

function recordingLog() {
	const lines = { info: [], warn: [], error: [] };
	return {
		lines,
		info: (m) => lines.info.push(m),
		warn: (m) => lines.warn.push(m),
		error: (m) => lines.error.push(m),
	};
}

function wonChild(pid = 4321) {
	const child = new EventEmitter();
	child.pid = pid;
	child.spawnargs = ['stub'];
	child.unref = () => {
		child.unrefed = true;
	};
	return child;
}

/** A constrained-spawn stub: rejects the interception probe, records every other call, returns winners. */
function stubSpawn(events = []) {
	const calls = [];
	const spawn = (command, args, options) => {
		if (options.name === 'guard-spawn-probe') throw new Error(`Command ${command} is not allowed`);
		calls.push({ command, args, options });
		events.push(`spawn:${options.name}`);
		return wonChild(1000 + calls.length);
	};
	spawn.calls = calls;
	return spawn;
}

function writeLock(pidDir, name, pid = DEAD_PID) {
	fs.mkdirSync(pidDir, { recursive: true });
	fs.writeFileSync(path.join(pidDir, `${name}.pid`), `${pid}\n12345`);
}

test('the full lifecycle in one call: sweep, configs, ordered spawns, reaper, verify', () =>
	withTempDir('lifecycle-happy-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'alpha');
		const configTarget = path.join(dir, 'datadog', 'conf.d', 'datadog.yaml');
		const events = [];
		const spawn = stubSpawn(events);
		const log = recordingLog();

		const result = await bootstrap({
			spawn,
			log,
			rootPath: dir,
			fingerprintParts: ['cfg', 'key'],
			configFiles: { [configTarget]: 'apm_config:\n  enabled: true\n' },
			processes: [
				{
					name: 'alpha',
					title: 'trace agent',
					resolve: () => process.execPath,
					args: ['run', '-c', 'cfg'],
					verify: async () => {
						events.push('verify');
						return { ok: true, detail: 'the receiver advertises /traces' };
					},
				},
				{ name: 'beta', title: 'core agent', binaryPath: process.execPath, args: ['run'] },
			],
			reaper: { logFile: path.join(dir, 'reaper.log') },
		});

		assert.equal(result.intercepted, true);
		assert.equal(result.swept, true);
		assert.deepEqual(
			result.actions.map((a) => a.action),
			['removed-dead']
		);

		// The config landed atomically: readable, no temp file left beside it, parent directories created.
		assert.equal(fs.readFileSync(configTarget, 'utf-8'), 'apm_config:\n  enabled: true\n');
		assert.deepEqual(fs.readdirSync(path.dirname(configTarget)), ['datadog.yaml']);

		// Spawns in declaration order, every one carrying the computed version.
		const version = fingerprint('cfg', 'key');
		assert.equal(result.version, version);
		assert.deepEqual(
			spawn.calls.map((call) => call.options.name),
			['alpha', 'beta', REAPER_NAME]
		);
		for (const call of spawn.calls) assert.equal(call.options.version, version);
		assert.deepEqual(spawn.calls[0].args, ['run', '-c', 'cfg']);

		// The reaper runs the guard's own dist/reaper.js, resolved from inside the built package.
		assert.equal(spawn.calls[2].args[0], path.join(REPO_ROOT, 'dist', 'reaper.js'));
		assert.ok(spawn.calls[2].args.includes('--log'));
		assert.equal(result.reaper.started, true);

		assert.equal(result.processes.length, 2);
		assert.equal(result.processes[0].started, true);
		assert.equal(result.processes[0].verified, true);
		assert.equal(result.processes[0].verifyDetail, 'the receiver advertises /traces');
		assert.equal(result.processes[1].started, true);
		assert.ok(log.lines.info.some((line) => line.includes('the receiver advertises /traces')));
	}));

test('MUTATION: verify runs only after the reaper launch', () =>
	withTempDir('lifecycle-order-', async (dir) => {
		const events = [];
		const spawn = stubSpawn(events);
		await bootstrap({
			spawn,
			rootPath: dir,
			processes: [
				{
					name: 'alpha',
					binaryPath: process.execPath,
					verify: async () => {
						events.push('verify');
						return { ok: true };
					},
				},
			],
		});
		const reaperAt = events.indexOf(`spawn:${REAPER_NAME}`);
		const verifyAt = events.indexOf('verify');
		assert.ok(reaperAt !== -1 && verifyAt !== -1, 'both must happen');
		// A verify may wait 30s; a node killed inside that window must already have a reaper watching.
		assert.ok(reaperAt < verifyAt, 'verify ran before the reaper existed');
	}));

test('MUTATION: resolve runs before the sweep, which needs the path to adjudicate the lock', () =>
	withTempDir('lifecycle-resolve-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'alpha');
		let lockSeenByResolve = false;
		const result = await bootstrap({
			spawn: stubSpawn(),
			rootPath: dir,
			processes: [
				{
					name: 'alpha',
					resolve: () => {
						lockSeenByResolve = fs.existsSync(path.join(pidDir, 'alpha.pid'));
						return process.execPath;
					},
				},
			],
		});
		assert.equal(lockSeenByResolve, true, 'the sweep ran first');
		// A sweep fed an unresolved path reports skipped-unresolved and leaves the stale lock in place.
		assert.deepEqual(
			result.actions.map((a) => a.action),
			['removed-dead']
		);
		assert.equal(fs.existsSync(path.join(pidDir, 'alpha.pid')), false);
	}));

test('a resolve() that throws disables its process and nothing else', () =>
	withTempDir('lifecycle-badresolve-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'bad');
		const log = recordingLog();
		const result = await bootstrap({
			spawn: stubSpawn(),
			log,
			rootPath: dir,
			processes: [
				{
					name: 'bad',
					resolve: () => {
						throw new Error('no binary for this platform');
					},
				},
				{ name: 'good', binaryPath: process.execPath },
			],
		});
		assert.equal(result.processes[0].started, false);
		assert.equal(result.processes[0].error, 'no binary for this platform');
		assert.equal(result.processes[1].started, true, 'the sibling must start anyway');
		// The unresolvable lock is skipped rather than removed on the strength of a question never asked.
		assert.deepEqual(
			result.actions.map((a) => a.action),
			['skipped-unresolved']
		);
		assert.ok(log.lines.error.some((line) => line.includes('no binary for this platform')));
	}));

test('a failing verify is recorded and logged verbatim, never thrown', () =>
	withTempDir('lifecycle-verifyfail-', async (dir) => {
		const log = recordingLog();
		const result = await bootstrap({
			spawn: stubSpawn(),
			log,
			rootPath: dir,
			processes: [
				{
					name: 'alpha',
					binaryPath: process.execPath,
					verify: async () => ({ ok: false, detail: 'nothing answered 127.0.0.1:8126' }),
				},
				{
					name: 'beta',
					binaryPath: process.execPath,
					verify: async () => {
						throw new Error('probe exploded');
					},
				},
			],
		});
		assert.equal(result.processes[0].verified, false);
		assert.equal(result.processes[0].verifyDetail, 'nothing answered 127.0.0.1:8126');
		assert.ok(log.lines.error.some((line) => line.includes('nothing answered 127.0.0.1:8126')));
		// A verify that throws is a failed verification, not a failed bootstrap.
		assert.equal(result.processes[1].verified, false);
		assert.equal(result.processes[1].verifyDetail, 'probe exploded');
	}));

test('configFiles creates missing parent directories', () =>
	withTempDir('lifecycle-mkdirs-', async (dir) => {
		const target = path.join(dir, 'deep', 'nested', 'tree', 'conf.yaml');
		await bootstrap({ pidDir: path.join(dir, 'pids'), processes: [], configFiles: { [target]: 'ok\n' } });
		assert.equal(fs.readFileSync(target, 'utf-8'), 'ok\n');
	}));

test('a sweep-only call returns exactly the shape it always did', () =>
	withTempDir('lifecycle-sweeponly-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent');
		const result = await bootstrap({ pidDir, processes: [{ name: 'agent', binaryPath: '/nonexistent' }] });
		// New keys on a sweep-only result would break callers that deep-compare it.
		assert.deepEqual(Object.keys(result).sort(), ['actions', 'report', 'swept']);
		assert.equal(result.swept, true);
	}));

test('fingerprintParts beside a per-process version is refused as a contradiction', () =>
	withTempDir('lifecycle-exclusive-', async (dir) => {
		await assert.rejects(
			bootstrap({
				pidDir: path.join(dir, 'pids'),
				fingerprintParts: ['cfg'],
				processes: [{ name: 'agent', binaryPath: '/nonexistent', version: 7 }],
			}),
			/mutually exclusive/
		);
	}));

test('MUTATION: a spawn Harper is not intercepting starts nothing, and the refusal comes back in the result', () =>
	withTempDir('lifecycle-stock-', async (dir) => {
		const log = recordingLog();
		const names = [];
		// This stub permits the probe, which is exactly what Node's real child_process would do.
		const spawn = (command, args, options) => {
			names.push(options.name);
			return wonChild(2000);
		};
		const result = await bootstrap({
			spawn,
			log,
			rootPath: dir,
			interceptionHint: 'No trace-agent means every span this node produces is discarded.',
			processes: [
				{ name: 'alpha', title: 'trace agent', binaryPath: process.execPath },
				{ name: 'beta', title: 'core agent', binaryPath: process.execPath },
			],
		});

		// Nothing but the probe may reach an unintercepted spawn: each of these would be a copy no lock deduped.
		const spawned = names.filter((name) => name !== 'guard-spawn-probe');
		assert.deepEqual(spawned, [], `bootstrap spawned through an unintercepted child_process: ${spawned.join(', ')}`);
		assert.equal(result.intercepted, false);
		assert.equal('reaper' in result, false);

		// The status endpoint renders the result, so the refusal has to be there and not only in hdb.log.
		assert.match(result.refused.reason, /^Nothing was started: /);
		assert.ok(result.refused.reason.includes('trace agent, core agent'));
		assert.equal(result.refused.detail, 'spawn of a bogus command was permitted');
		assert.deepEqual(result.refused.processes, ['trace agent', 'core agent']);
		assert.equal(result.report.at(-1), result.refused.reason);
		// One state per declared process, in declaration order: a caller zipping these against its own list still can.
		assert.equal(result.processes.length, 2);
		for (const state of result.processes) {
			assert.equal(state.started, false);
			assert.match(state.error, /refused to spawn it/);
		}

		// Once, not twice: the plugin handed the probe to bootstrap to stop double-logging it per thread.
		assert.equal(log.lines.error.length, 1, log.lines.error.join(' | '));
		assert.match(log.lines.error[0], /NOT ACTIVE/);
		assert.ok(log.lines.error[0].includes('trace agent, core agent'));
		assert.ok(log.lines.error[0].includes('every span this node produces is discarded'));
	}));

test('an intercepted spawn is untouched by the refusal path', () =>
	withTempDir('lifecycle-intercepted-', async (dir) => {
		const log = recordingLog();
		const spawn = stubSpawn();
		const result = await bootstrap({
			spawn,
			log,
			rootPath: dir,
			processes: [
				{ name: 'alpha', binaryPath: process.execPath },
				{ name: 'beta', binaryPath: process.execPath, verify: async () => ({ ok: true }) },
			],
		});
		assert.equal(result.intercepted, true);
		assert.equal('refused' in result, false);
		assert.deepEqual(
			spawn.calls.map((call) => call.options.name),
			['alpha', 'beta', REAPER_NAME]
		);
		assert.equal(result.processes[0].started, true);
		assert.equal(result.processes[1].verified, true);
		assert.equal(result.reaper.started, true);
		assert.deepEqual(log.lines.error, []);
	}));

test('reaper: false skips the launch and the result carries no reaper', () =>
	withTempDir('lifecycle-noreaper-', async (dir) => {
		const spawn = stubSpawn();
		const result = await bootstrap({
			spawn,
			rootPath: dir,
			reaper: false,
			processes: [{ name: 'alpha', binaryPath: process.execPath }],
		});
		assert.equal('reaper' in result, false);
		assert.ok(!spawn.calls.some((call) => call.options.name === REAPER_NAME));
	}));

test('reaper options reach the launch, and a missing root path becomes an error state with one warning', () =>
	withTempDir('lifecycle-reaperopts-', async (dir) => {
		const spawn = stubSpawn();
		const named = await bootstrap({
			spawn,
			rootPath: dir,
			reaper: { name: 'datadog-agent-reaper', restartGraceMs: 12000 },
			processes: [{ name: 'alpha', binaryPath: process.execPath }],
		});
		assert.equal(named.reaper.name, 'datadog-agent-reaper');
		const call = spawn.calls.find((c) => c.options.name === 'datadog-agent-reaper');
		assert.ok(call.args.includes('12000'));

		const log = recordingLog();
		const rootless = await bootstrap({
			spawn: stubSpawn(),
			log,
			pidDir: path.join(dir, 'pids'),
			processes: [{ name: 'alpha', binaryPath: process.execPath }],
		});
		assert.equal(rootless.reaper.started, false);
		assert.match(rootless.reaper.error, /root path is unknown/);
		assert.ok(log.lines.warn.some((line) => line.includes('kill them by hand')));
	}));
