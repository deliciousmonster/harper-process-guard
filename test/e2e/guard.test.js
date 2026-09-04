// @ts-check
// Real worker threads, real processes, a real kill. The interleavings this package exists for are the
// subject, and a version that mocks them proves nothing about any of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { isAlive } from '../../src/identity.js';
import { lockPath, readLock } from '../../src/lock.js';
import { countRunning, fixture, readyLine, waitFor, withSpawn, withTempDir } from '../support/harness.js';

const THREADS = 8;

test('eight worker threads calling guard() leave one process running on the node', { timeout: 60_000 }, () =>
	withTempDir('guard-e2e-', async (dir) => {
		// Every thread of a host evaluates every component, so every thread reaches this call. Without
		// arbitration that is eight processes, and all but one fail to bind whatever they bind.
		const tag = `e2e-one-winner-${process.pid}`;
		const args = [fixture('idle.js'), tag];
		const argv = [process.execPath, ...args];
		const workers = Array.from(
			{ length: THREADS },
			() =>
				new Worker(path.join(import.meta.dirname, '..', 'support', 'guard-worker.js'), {
					workerData: { pidDir: dir, binaryPath: process.execPath, args },
				})
		);

		try {
			const results = await Promise.all(
				workers.map(
					(worker) =>
						new Promise((resolve, reject) => {
							worker.once('message', resolve);
							worker.once('error', reject);
						})
				)
			);

			assert.equal(countRunning(argv), 1, 'more than one process was started for one declared process');
			const starters = results.filter((r) => r.started && !r.adopted);
			assert.equal(starters.length, 1, `${starters.length} threads believed they started it`);
			assert.equal(new Set(results.map((r) => r.pid)).size, 1, 'the threads disagree about which process is theirs');
			assert.equal(readLock(lockPath(dir, 'shared'))?.pid, results[0].pid);
		} finally {
			await Promise.all(workers.map((worker) => worker.terminate()));
			for (const line of fs.readdirSync(dir)) {
				const lock = readLock(path.join(dir, line));
				if (lock && lock.pid > 0) {
					try {
						process.kill(lock.pid, 'SIGKILL');
					} catch {
						// Already gone.
					}
				}
			}
		}
	})
);

test('a killed host does not leave its process behind', { timeout: 60_000 }, () =>
	withTempDir('guard-e2e-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `e2e-reaped-${process.pid}`;
			const host = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
			const started = JSON.parse(await readyLine(host));

			assert.equal(started.reaper.started, true, `the reaper did not start: ${started.reaper.error}`);
			assert.equal(isAlive(started.guarded), true);
			assert.equal(countRunning([process.execPath, fixture('idle.js'), tag]), 1);

			// SIGKILL, because that is the case nothing in-process can answer: no worker shutdown hook runs
			// and no signal handler fires, so only something outside the host can stop what it started.
			host.kill('SIGKILL');
			await waitFor(() => !isAlive(started.guarded), 'the reaper to stop the process its host left behind', {
				timeoutMs: 30_000,
				intervalMs: 100,
			});
			assert.equal(fs.existsSync(lockPath(dir, 'guarded')), false, 'the reaper left the lock behind');
			await waitFor(() => !fs.existsSync(lockPath(dir, 'reaper')), 'the reaper to remove its own lock');
		})
	)
);

test(
	'a real SIGTERM to the reaper itself removes its own lock, leaving the host and its process alone',
	{ timeout: 30_000 },
	() =>
		withTempDir('guard-e2e-', (dir) =>
			withSpawn(async ({ spawn }) => {
				const tag = `e2e-reaper-sigterm-${process.pid}`;
				const host = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
				const started = JSON.parse(await readyLine(host));

				assert.equal(started.reaper.started, true, `the reaper did not start: ${started.reaper.error}`);
				assert.equal(fs.existsSync(lockPath(dir, 'reaper')), true);

				// The parent sees a pid the instant spawn() returns, well before the child has finished loading
				// its own modules and registered a signal handler; its own first log line is what proves that
				// happened, so a SIGTERM sent any earlier would race Node's own startup, not this test's subject.
				const reaperLog = path.join(dir, 'reaper.log');
				await waitFor(
					() => fs.existsSync(reaperLog) && fs.readFileSync(reaperLog, 'utf-8').includes('watching pid'),
					'the reaper to finish starting up'
				);

				process.kill(started.reaper.pid, 'SIGTERM');
				await waitFor(
					() => !fs.existsSync(lockPath(dir, 'reaper')),
					'the reaper to remove its own lock after SIGTERM',
					{
						timeoutMs: 10_000,
						intervalMs: 50,
					}
				);

				// The reaper was told to stop, not the host: hostPid never went, so nothing here should reap.
				assert.equal(isAlive(host.pid ?? -1), true, 'the host was affected by a signal sent only to its reaper');
				assert.equal(isAlive(started.guarded), true, 'the guarded process was reaped although its host is alive');
				assert.equal(fs.existsSync(lockPath(dir, 'guarded')), true, "the guarded process's lock was removed");
			})
		)
);

test('a second host started beside the first joins its process rather than starting another', { timeout: 60_000 }, () =>
	withTempDir('guard-e2e-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const tag = `e2e-two-hosts-${process.pid}`;
			const first = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
			const one = JSON.parse(await readyLine(first));
			const second = spawn(process.execPath, [fixture('host.js'), dir, tag], { stdio: ['ignore', 'pipe', 'ignore'] });
			const two = JSON.parse(await readyLine(second));

			assert.equal(two.guarded, one.guarded, 'the second host started its own copy');
			assert.equal(countRunning([process.execPath, fixture('idle.js'), tag]), 1);
			// Its reaper watches a different host, so its command line differs and it takes its own turn.
			assert.equal(two.reaper.started, true);

			first.kill('SIGKILL');
			second.kill('SIGKILL');
			await waitFor(() => !isAlive(one.guarded), 'the process to be stopped once both hosts are gone', {
				timeoutMs: 30_000,
				intervalMs: 100,
			});
		})
	)
);
