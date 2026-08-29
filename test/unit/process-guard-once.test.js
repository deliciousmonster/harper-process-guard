/**
 * The once-per-process barrier, tested against real worker threads.
 *
 * Harper's concurrency is eight threads inside one OS process, so a test that calls the
 * barrier eight times in a loop proves nothing about the case it exists for: the calls would
 * be sequential and every interesting interleaving impossible. These tests start actual
 * `node:worker_threads` in this process, which reproduces the exact shape, including that all
 * of them share `process.pid` and `process.uptime()`.
 *
 * The property under test is not "one thread ran it". It is "no thread returned before the
 * work finished": a barrier that releases the losers early protects only the winner, and the
 * other seven race ahead into the state the work is still repairing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, importDist, makeTempDir, withTempDir } from '../support/harness.js';

const { oncePerProcess, currentProcess } = await importDist('once.js');
const ONCE_URL = pathToFileURL(path.join(REPO_ROOT, 'dist', 'once.js')).href;

/**
 * Run the barrier in `count` real worker threads at once.
 *
 * Each worker reports when it entered, whether it ran the work, when the work finished, and
 * when its own call returned. The ordering between those is the assertion.
 */
function race(dir, { count = 8, workMs = 300, key = 'sweep' } = {}) {
	const script = `
		import { parentPort, workerData } from 'node:worker_threads';
		import { writeFileSync } from 'node:fs';
		import { join } from 'node:path';
		const { oncePerProcess } = await import(workerData.onceUrl);
		const outcome = await oncePerProcess(workerData.dir, workerData.key, async () => {
			// A marker file, written only by the winner, timestamped when the work ENDS.
			await new Promise((r) => setTimeout(r, workerData.workMs));
			writeFileSync(join(workerData.dir, 'work-finished-at'), String(Date.now()));
			return 'done';
		}, { timeoutMs: 20000 });
		parentPort.postMessage({ outcome, returnedAt: Date.now() });
	`;
	const workers = Array.from(
		{ length: count },
		() =>
			new Promise((resolve, reject) => {
				const worker = new Worker(script, {
					eval: true,
					workerData: { dir, key, workMs, onceUrl: ONCE_URL },
				});
				worker.once('message', resolve);
				worker.once('error', reject);
			})
	);
	return Promise.all(workers);
}

test('exactly one thread of eight runs the work', () =>
	withTempDir('once-one-', async (dir) => {
		const results = await race(dir);
		const ran = results.filter((r) => r.outcome.ran);
		assert.equal(ran.length, 1, `${ran.length} threads ran the work; it must be exactly one`);
	}));

test('NO thread returns before the work has finished', () =>
	withTempDir('once-barrier-', async (dir) => {
		const results = await race(dir, { workMs: 400 });
		const finishedAt = Number(fs.readFileSync(path.join(dir, 'work-finished-at'), 'utf-8'));

		// Losers released early would spawn against the state the winner is still repairing.
		for (const [index, result] of results.entries()) {
			assert.ok(
				result.returnedAt >= finishedAt,
				`thread ${index} returned ${finishedAt - result.returnedAt}ms before the work finished`
			);
		}
	}));

test('every thread that did not run reports that it waited, not that it failed', () =>
	withTempDir('once-waited-', async (dir) => {
		const results = await race(dir);
		for (const result of results) {
			if (result.outcome.ran) continue;
			assert.equal(result.outcome.waited, true, 'a thread that returned without waiting has no precondition');
		}
	}));

test('a second call in the same process does not re-run the work', () =>
	withTempDir('once-memo-', async (dir) => {
		let runs = 0;
		const first = await oncePerProcess(dir, 'k', async () => ++runs);
		const second = await oncePerProcess(dir, 'k', async () => ++runs);
		assert.equal(first.ran, true);
		assert.deepEqual(second, { ran: false, waited: true });
		assert.equal(runs, 1);
	}));

test('CRITICAL: a marker left by a previous boot with THIS pid is not mistaken for ours', () =>
	withTempDir('once-pidreuse-', async (dir) => {
		// The case that defeats a pid-named marker. A container restart hands the entrypoint
		// the same small pid, and the marker is on a persistent volume, so pid alone cannot
		// tell a previous boot from this one. Same pid, start time an hour ago.
		// A previous boot is now faked by changing the OS start TOKEN, not the derived
		// startedAt: identity prefers the token precisely so a clock cannot move it, which
		// means a fixture that only moves the clock no longer describes a different process.
		const stale = { ...currentProcess(), token: 'previous-boot-token', done: false, thread: 1 };
		fs.writeFileSync(path.join(dir, '.k.once'), JSON.stringify(stale));

		let ran = false;
		const outcome = await oncePerProcess(dir, 'k', async () => {
			ran = true;
		});
		assert.equal(ran, true, 'a stale marker with a reused pid blocked the work entirely');
		assert.equal(outcome.ran, true);
	}));

test('a marker from a different pid is taken over rather than waited on', () =>
	withTempDir('once-otherpid-', async (dir) => {
		const stale = { pid: process.pid + 12345, startedAt: Date.now(), done: false, thread: 1 };
		fs.writeFileSync(path.join(dir, '.k.once'), JSON.stringify(stale));
		let ran = false;
		await oncePerProcess(dir, 'k', async () => {
			ran = true;
		});
		assert.equal(ran, true);
	}));

test('a completed marker from a previous boot does not suppress this boot', () =>
	withTempDir('once-prevdone-', async (dir) => {
		const stale = { pid: process.pid, token: 'previous-boot-token', startedAt: 1, done: true, thread: 1 };
		fs.writeFileSync(path.join(dir, '.k.once'), JSON.stringify(stale));
		let ran = false;
		await oncePerProcess(dir, 'k', async () => {
			ran = true;
		});
		assert.equal(ran, true, 'a previous boot reporting success must not stand in for this one');
	}));

test('a thrown work removes the marker so the next thread retries', () =>
	withTempDir('once-throws-', async (dir) => {
		await assert.rejects(
			oncePerProcess(dir, 'k', async () => {
				throw new Error('binary missing');
			}),
			/binary missing/
		);
		// Leaving it would make every other thread wait out the full deadline against a claim
		// nobody will ever complete.
		assert.equal(fs.existsSync(path.join(dir, '.k.once')), false);

		let ran = false;
		await oncePerProcess(dir, 'k', async () => {
			ran = true;
		});
		assert.equal(ran, true);
	}));

test('an unreadable marker is not honoured forever', () =>
	withTempDir('once-garbage-', async (dir) => {
		fs.writeFileSync(path.join(dir, '.k.once'), 'not json');
		let ran = false;
		await oncePerProcess(dir, 'k', async () => {
			ran = true;
		});
		assert.equal(ran, true);
	}));

test('a waiter gives up with a reason rather than hanging', async () => {
	const dir = makeTempDir('once-timeout-');
	try {
		// A claim from this process that never completes, which is what a winner killed
		// mid-work leaves behind.
		fs.writeFileSync(path.join(dir, '.k.once'), JSON.stringify({ ...currentProcess(), done: false, thread: 99 }));
		const outcome = await oncePerProcess(dir, 'k', async () => 'never', { timeoutMs: 200 });
		assert.deepEqual(outcome, { ran: false, waited: false, reason: 'timed-out' });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('every thread of one process agrees on that process identity', () =>
	withTempDir('once-identity-', async () => {
		// The comparison is deliberately tolerant: each thread derives startedAt from two
		// clocks read microseconds apart, so an exact match would make siblings disagree.
		const a = currentProcess();
		await new Promise((r) => setTimeout(r, 30));
		const b = currentProcess();
		assert.equal(a.pid, b.pid);
		assert.ok(
			Math.abs(a.startedAt - b.startedAt) < 50,
			`derived start times drifted by ${a.startedAt - b.startedAt}ms`
		);
	}));
