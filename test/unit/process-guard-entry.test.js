/**
 * The bootstrap entry point, which is the two primitives composed.
 *
 * The composition is where a caller's guarantee is either delivered or quietly lost, so these
 * tests are about what `bootstrap()` PROMISES rather than about the sweep or the barrier,
 * which have their own suites. Chiefly: a thread that did not establish the precondition must
 * say so, because a caller that cannot distinguish "checked, nothing wrong" from "not checked"
 * is back to the silence this whole module exists to remove.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, importDist, makeTempDir, withTempDir } from '../support/harness.js';

const { bootstrap } = await importDist('index.js');
const { currentProcess } = await importDist('once.js');
const ENTRY_URL = pathToFileURL(path.join(REPO_ROOT, 'dist', 'index.js')).href;

const DEAD_PID = 2147483646;

function writeLock(pidDir, name, pid) {
	fs.mkdirSync(pidDir, { recursive: true });
	fs.writeFileSync(path.join(pidDir, `${name}.pid`), `${pid}\n12345`);
}

test('a stale lock is cleared and reported in one call', () =>
	withTempDir('boot-basic-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', DEAD_PID);

		const result = await bootstrap({ pidDir, processes: [{ name: 'agent', binaryPath: '/nonexistent' }] });

		assert.equal(result.swept, true);
		assert.equal(result.actions.length, 1);
		assert.match(result.report[0], /removed the stale agent lock/);
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), false);
	}));

test('a clean directory reports nothing rather than inventing reassurance', () =>
	withTempDir('boot-clean-', async (dir) => {
		const result = await bootstrap({ pidDir: path.join(dir, 'pids'), processes: [] });
		assert.deepEqual(result, { swept: true, actions: [], report: [] });
	}));

test('CRITICAL: a thread that could not establish the precondition says so', () =>
	withTempDir('boot-timeout-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		fs.mkdirSync(pidDir, { recursive: true });
		// A claim from this process that never completes, which is what a winner killed
		// mid-sweep leaves behind. Every later thread waits, then has to report.
		// The marker filename is namespaced per caller now, so the fixture has to name the same
		// key the call will derive. Passing `namespace` explicitly keeps the two in step.
		fs.writeFileSync(
			path.join(pidDir, '.harper-process-guard.probe.once'),
			JSON.stringify({ ...currentProcess(), done: false, thread: 99 })
		);

		const result = await bootstrap({ pidDir, processes: [], timeoutMs: 150, namespace: 'probe' });

		assert.equal(result.swept, false);
		// The failure mode being guarded: returning {swept:false, report:[]} here would be
		// indistinguishable from a healthy thread that waited on a sibling.
		assert.equal(result.report.length, 1, 'an unchecked lock directory must produce a line');
		assert.match(result.report[0], /did not complete/);
		assert.match(result.report[0], /timed-out/);
		assert.match(result.report[0], new RegExp(pidDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	}));

test('eight threads: one sweeps, the rest wait and report nothing of their own', () =>
	withTempDir('boot-threads-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', DEAD_PID);

		const script = `
			import { parentPort, workerData } from 'node:worker_threads';
			const { bootstrap } = await import(workerData.entryUrl);
			const result = await bootstrap({
				pidDir: workerData.pidDir,
				processes: [{ name: 'agent', binaryPath: '/nonexistent' }],
			});
			parentPort.postMessage({ swept: result.swept, actions: result.actions.length, lockGone: true });
		`;
		const results = await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise((resolve, reject) => {
						const worker = new Worker(script, { eval: true, workerData: { pidDir, entryUrl: ENTRY_URL } });
						worker.once('message', resolve);
						worker.once('error', reject);
					})
			)
		);

		assert.equal(results.filter((r) => r.swept).length, 1, 'exactly one thread may sweep');
		// A waiter reporting the winner's actions would make eight threads log the same repair
		// eight times into hdb.log.
		for (const result of results.filter((r) => !r.swept)) assert.equal(result.actions, 0);
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), false, 'the stale lock is gone for all of them');
	}));

test('the default timeout scales with how many processes might need stopping', () =>
	withTempDir('boot-budget-', async (dir) => {
		// Not asserted through the clock, which would be slow and flaky. The property is that
		// a caller with more processes gets more room, because each orphan is stopped in turn
		// and a fixed budget would time out on a list long enough.
		const pidDir = path.join(dir, 'pids');
		const many = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, binaryPath: '/nonexistent' }));
		const result = await bootstrap({ pidDir, processes: many });
		assert.equal(result.swept, true);
	}));

test('the report is per-action and names what was done, for a caller to log', () =>
	withTempDir('boot-report-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'one', DEAD_PID);
		writeLock(pidDir, 'two', DEAD_PID);
		const result = await bootstrap({
			pidDir,
			processes: [
				{ name: 'one', binaryPath: '/nonexistent' },
				{ name: 'two', binaryPath: '/nonexistent' },
			],
		});
		assert.equal(result.report.length, 2);
		assert.match(result.report[0], /\bone\b/);
		assert.match(result.report[1], /\btwo\b/);
	}));
