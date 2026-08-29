// The marker key is derived per caller so a second component cannot read the first's completed
// marker as its own and skip its sweep; only an actual second caller exercises that derivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, importDist, withTempDir } from '../support/harness.js';

const { bootstrap } = await importDist('index.js');
const ENTRY_URL = pathToFileURL(path.join(REPO_ROOT, 'dist', 'index.js')).href;

const DEAD_PID = 2147483646;

function writeLock(pidDir, name, pid = DEAD_PID) {
	fs.mkdirSync(pidDir, { recursive: true });
	fs.writeFileSync(path.join(pidDir, `${name}.pid`), `${pid}\n12345`);
}

/** What each component declares. Distinct process names, one shared directory. */
const DATADOG = [
	{ name: 'datadog-agent', binaryPath: '/nonexistent/core' },
	{ name: 'datadog-trace-agent', binaryPath: '/nonexistent/trace' },
];
const EXPORTER = [{ name: 'metrics-exporter', binaryPath: '/nonexistent/exporter' }];

test('CRITICAL: a second component sweeps its own locks rather than inheriting a verdict from the first', () =>
	withTempDir('two-consumers-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'datadog-agent');
		writeLock(pidDir, 'datadog-trace-agent');
		writeLock(pidDir, 'metrics-exporter');

		// Sequential in one process is the case a shared key breaks: the second call would read
		// the first's completed marker as its own and check nothing.
		const first = await bootstrap({ pidDir, processes: DATADOG });
		const second = await bootstrap({ pidDir, processes: EXPORTER });

		assert.equal(first.swept, true);
		assert.equal(second.swept, true, 'the second component skipped its sweep entirely');
		assert.equal(first.actions.length, 2);
		assert.equal(second.actions.length, 1);
		for (const name of ['datadog-agent', 'datadog-trace-agent', 'metrics-exporter']) {
			assert.equal(fs.existsSync(path.join(pidDir, `${name}.pid`)), false, `${name}.pid survived`);
		}
	}));

test('each component leaves its own marker, so neither can be mistaken for the other', () =>
	withTempDir('two-markers-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		await bootstrap({ pidDir, processes: DATADOG });
		await bootstrap({ pidDir, processes: EXPORTER });

		const markers = fs
			.readdirSync(pidDir)
			.filter((f) => f.endsWith('.once'))
			.sort();
		assert.deepEqual(markers, [
			'.harper-process-guard.datadog-agent+datadog-trace-agent.once',
			'.harper-process-guard.metrics-exporter.once',
		]);
	}));

test('the derived key does not depend on declaration order', () =>
	withTempDir('two-order-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		await bootstrap({ pidDir, processes: DATADOG });
		// An order-dependent key would mint a second marker and sweep again, a sign it does not
		// identify what it claims to.
		const again = await bootstrap({ pidDir, processes: [...DATADOG].reverse() });
		assert.equal(again.swept, false, 'the same component swept twice under two keys');
		assert.equal(fs.readdirSync(pidDir).filter((f) => f.endsWith('.once')).length, 1);
	}));

test('an explicit namespace separates two components that declare the same process names', () =>
	withTempDir('two-explicit-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		// Two components can legitimately both spawn something called `agent`. Without a
		// namespace they would share a key and the second would skip.
		const one = await bootstrap({ pidDir, processes: [{ name: 'agent', binaryPath: '/x' }], namespace: 'alpha' });
		const two = await bootstrap({ pidDir, processes: [{ name: 'agent', binaryPath: '/x' }], namespace: 'beta' });
		assert.equal(one.swept, true);
		assert.equal(two.swept, true);
	}));

test('two components racing across sixteen threads each sweep exactly once', () =>
	withTempDir('two-threads-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'datadog-agent');
		writeLock(pidDir, 'metrics-exporter');

		const script = `
			import { parentPort, workerData } from 'node:worker_threads';
			const { bootstrap } = await import(workerData.entryUrl);
			const result = await bootstrap({ pidDir: workerData.pidDir, processes: workerData.processes });
			parentPort.postMessage({ which: workerData.which, swept: result.swept });
		`;
		// Eight threads per component, all at once, which is what a node running both looks like.
		const work = [];
		for (let i = 0; i < 8; i++) {
			for (const [which, processes] of [
				['datadog', [{ name: 'datadog-agent', binaryPath: '/nonexistent/core' }]],
				['exporter', EXPORTER],
			]) {
				work.push(
					new Promise((resolve, reject) => {
						const worker = new Worker(script, {
							eval: true,
							workerData: { pidDir, entryUrl: ENTRY_URL, which, processes },
						});
						worker.once('message', resolve);
						worker.once('error', reject);
					})
				);
			}
		}
		const results = await Promise.all(work);

		for (const which of ['datadog', 'exporter']) {
			const swept = results.filter((r) => r.which === which && r.swept).length;
			assert.equal(swept, 1, `${which}: ${swept} threads swept, and exactly one may`);
		}
	}));
