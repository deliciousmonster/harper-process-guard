// @ts-check
// What guard() composes: one state per declared process, the report, and an ordering that decides
// whether a host killed mid-verify leaves its processes behind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { fingerprint, guard } from '../../src/index.js';
import { isAlive } from '../../src/identity.js';
import { lockPath, readLock } from '../../src/lock.js';
import { captureLog, countRunning, fixture, REPO_ROOT, waitFor, withSpawn, withTempDir } from '../support/harness.js';

/** The reaper this package spawns, so a stub can refuse it by name without touching the guarded processes. */
const REAPER_SCRIPT = path.join(REPO_ROOT, 'src', 'reaper.js');

/** @param {string} tag @param {string} [name] */
const declare = (tag, name = 'agent') => ({ name, binaryPath: process.execPath, args: [fixture('idle.js'), tag] });

/** @param {import('../../src/index.js').ReaperState | undefined} reaper */
function stopReaper(reaper) {
	if (typeof reaper?.pid !== 'number') return;
	try {
		process.kill(reaper.pid, 'SIGKILL');
	} catch {
		// Already gone, which is the outcome asked for.
	}
}

test('a fingerprint is a number a host can parseInt, and it moves when its inputs do', () => {
	const first = fingerprint('config', 'key');
	assert.equal(Number.isInteger(first), true);
	assert.ok(first >= 0 && first < 2 ** 31, `${first} is outside the range a host will parse`);
	assert.equal(first, fingerprint('config', 'key'));
	assert.notEqual(first, fingerprint('config', 'other'));
	// Joined with a separator, so two parts cannot collide with one longer one.
	assert.notEqual(fingerprint('ab', 'c'), fingerprint('a', 'bc'));
});

test('one state per declared process, in declaration order', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `call-order-${process.pid}`;
			const result = await guard({
				pidDir: dir,
				spawn,
				processes: [declare(`${tag}-a`, 'first'), declare(`${tag}-b`, 'second')],
			});
			try {
				assert.deepEqual(
					result.processes.map((state) => state.name),
					['first', 'second']
				);
				assert.equal(
					result.processes.every((state) => state.started),
					true
				);
				assert.equal(result.reaper, undefined, 'a reaper was launched without being asked for');
			} finally {
				result.stop();
			}
		})
	));

test("a caller's verify verdict lands on the state and in the log", () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const log = captureLog();
			const result = await guard({
				pidDir: dir,
				spawn,
				log,
				processes: [
					{ ...declare(`verify-ok-${process.pid}`, 'good'), verify: async () => ({ ok: true, detail: 'answered' }) },
					{
						...declare(`verify-bad-${process.pid}`, 'bad'),
						verify: async () => {
							throw new Error('the probe never answered');
						},
					},
				],
			});
			try {
				assert.equal(result.processes[0]?.verified, true);
				assert.equal(result.processes[0]?.verifyDetail, 'answered');
				assert.equal(result.processes[1]?.verified, false);
				assert.equal(result.processes[1]?.verifyDetail, 'the probe never answered');
				assert.match(log.lines.error.join('\n'), /the bad failed verification: the probe never answered/);
			} finally {
				result.stop();
			}
		})
	));

test('the reaper is launched before any verify, so a host killed inside a probe leaves nothing behind', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// A probe can wait 30 seconds. Verifying first would leave that whole window with processes
			// running and nothing outside the host able to stop them.
			let reaperWasUp = false;
			const result = await guard({
				pidDir: dir,
				spawn,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [
					{
						...declare(`ordering-${process.pid}`),
						verify: async () => {
							reaperWasUp = fs.existsSync(lockPath(dir, 'reaper'));
							return { ok: true };
						},
					},
				],
			});
			try {
				assert.equal(result.reaper?.started, true, `the reaper did not start: ${result.reaper?.error}`);
				assert.equal(reaperWasUp, true, 'verify ran before the reaper was up');
			} finally {
				result.stop();
				stopReaper(result.reaper);
			}
		})
	));

test('a host that refuses every command it is offered says so instead of failing quietly', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			let allowed = 0;
			const result = await guard({
				pidDir: dir,
				spawn: (command, args, options) => {
					// The processes go through; only the reaper's own command is refused, which is what an
					// allowlist matching on the command string does when neither spelling of node is on it.
					if (++allowed > 1) throw new Error(`spawn of ${command} is not allowed`);
					return spawn(command, args, options);
				},
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(`refused-reaper-${process.pid}`)],
			});
			try {
				assert.equal(result.reaper?.started, false);
				assert.match(result.reaper?.error ?? '', /is not allowed/);
				assert.match(result.report.join('\n'), /will keep running after this host stops/);
				assert.equal(fs.existsSync(lockPath(dir, 'reaper')), false, 'a reaper lock outlived a reaper that never ran');
			} finally {
				result.stop();
			}
		})
	));

test('a host that permits only a bare `node` gets one reaper, not one per caller', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// Harper's allowlist defaults to [npm, node] and matches on command.split(' ')[0], so the
			// absolute interpreter path is refused and the reaper is recorded under a bare `node`. A caller
			// that expected the absolute path would read that as a stranger and start a second one.
			/** @type {import('../../src/supervise.js').Spawn} */
			const onlyNode = (command, args, spawnOptions) => {
				if (command === process.execPath && args[0] === REAPER_SCRIPT)
					throw new Error(`spawn of ${command} is not allowed`);
				return spawn(command, args, spawnOptions);
			};
			const tag = `bare-node-${process.pid}`;
			const first = await guard({
				pidDir: dir,
				spawn: onlyNode,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(tag)],
			});
			const second = await guard({
				pidDir: dir,
				spawn: onlyNode,
				reaper: { name: 'reaper', graceMs: 100 },
				processes: [declare(tag)],
			});
			try {
				assert.equal(first.reaper?.command, 'node', `the fallback was not taken: ${first.reaper?.error}`);
				assert.equal(second.reaper?.adopted, true, 'the second caller started a second reaper');
				assert.equal(second.reaper?.pid, first.reaper?.pid);
			} finally {
				first.stop();
				second.stop();
				stopReaper(first.reaper);
			}
		})
	));

test('a version that has moved makes the running process an orphan rather than something to adopt', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `upgrade-${process.pid}`;
			const before = await guard({ pidDir: dir, spawn, version: 1, processes: [declare(tag)] });
			const old = before.processes[0]?.pid;
			before.stop();

			// The same binary and the same command line, under a fingerprint this node no longer runs. An
			// upgrade must not adopt the previous release's process.
			const after = await guard({ pidDir: dir, spawn, version: 2, processes: [declare(tag)] });
			try {
				assert.equal(after.processes[0]?.adopted, false, 'the upgrade adopted the previous release');
				assert.notEqual(after.processes[0]?.pid, old);
				assert.match(after.report.join('\n'), /orphan of an earlier configuration \(version 1, not 2\)/);
				// Left running, because stopOrphans is off: the guard reports it rather than signalling it.
				assert.equal(isAlive(/** @type {number} */ (old)), true);
				assert.equal(readLock(lockPath(dir, 'agent'))?.version, 2);
			} finally {
				after.stop();
			}
		})
	));

test('stopOrphans stops that same process, and the node is left with one', () =>
	withTempDir('guard-call-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `upgrade-stopped-${process.pid}`;
			const before = await guard({ pidDir: dir, spawn, version: 1, processes: [declare(tag)] });
			const old = before.processes[0]?.pid;
			before.stop();

			const after = await guard({ pidDir: dir, spawn, version: 2, stopOrphans: true, processes: [declare(tag)] });
			try {
				await waitFor(() => !isAlive(/** @type {number} */ (old)), 'the orphan to be stopped');
				assert.match(after.report.join('\n'), new RegExp(`stopped pid ${old}`));
				assert.equal(countRunning([process.execPath, fixture('idle.js'), tag]), 1);
			} finally {
				after.stop();
			}
		})
	));
