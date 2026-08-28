/**
 * Two components sharing one Harper node, and therefore one pid directory.
 *
 * Every other suite here exercises a single caller, which is the configuration the module was
 * written against and the one that cannot reveal this class of bug. The marker key is derived
 * per caller precisely so a second component does not read the first one's completed marker as
 * its own and skip its sweep entirely, and until this file existed that derivation had never
 * been exercised by an actual second caller.
 *
 * The scenario is not hypothetical for the package this lives in: a Harper node running the
 * Datadog component alongside anything else that spawns a child gets exactly this layout.
 */
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

		// Sequential and in one process, which is the case a shared marker key breaks: the
		// second call would find the first one's completed marker, read it as its own, and
		// return swept:false having checked nothing.
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
		// Same component, same processes, declared the other way round. A key that depended on
		// order would mint a second marker and sweep again, which is not wrong so much as a
		// sign the key is not identifying what it claims to.
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
