#!/usr/bin/env node
// @ts-check
// Run the Test workflow's test job locally, with steps EXTRACTED from test.yml so the two cannot drift; --full adds npm ci.
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'test.yml');

/** Steps whose work cannot be reproduced locally, with the reason shown in the report. */
export const NOT_LOCAL = new Map([
	['Checkout', 'the working tree is already here'],
	['Setup Node.js', `this run uses the node on PATH (${process.version})`],
	['Install dependencies', 'pass --full to run npm ci'],
]);

// Every step of the `test` job, in order, as `{ name, run }`; a real YAML parse, so legal
// reformatting of test.yml (indent width, comments between steps) cannot break extraction.
export function testJobSteps() {
	/** @type {{ jobs?: Record<string, { steps?: { name?: unknown; run?: unknown }[] }> }} */
	const workflow = parse(readFileSync(WORKFLOW, 'utf-8'));
	const declared = workflow?.jobs?.test;
	if (!declared) throw new Error('test.yml: no `test:` job');

	const steps = (declared.steps ?? [])
		.filter((step) => typeof step.name === 'string')
		.map((step) => ({
			name: /** @type {string} */ (step.name),
			run: typeof step.run === 'string' ? step.run.trimEnd() : null,
		}));

	// A workflow rename must not leave this runner reporting success having checked nothing.
	if (!steps.some((step) => step.run)) throw new Error('test.yml: extracted no runnable steps from the test job');
	return steps;
}

// Only when invoked directly: an import must not run CI as a side effect, which would recurse via `npm test`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

function main() {
	const full = process.argv.includes('--full');
	const steps = testJobSteps();
	let failed = 0;
	let skipped = 0;

	console.log(`Running the Test workflow's ${steps.length} steps from ${WORKFLOW.replace(REPO_ROOT + '/', '')}\n`);

	for (const step of steps) {
		const reason = NOT_LOCAL.get(step.name);
		if (reason && !(full && step.name === 'Install dependencies')) {
			console.log(`  ~ ${step.name}\n      skipped: ${reason}`);
			if (step.run) skipped++;
			continue;
		}
		if (!step.run) {
			console.log(`  ~ ${step.name}\n      skipped: no run: body`);
			continue;
		}
		try {
			execFileSync('bash', ['-c', step.run], { cwd: REPO_ROOT, stdio: 'pipe' });
			console.log(`  ✓ ${step.name}`);
		} catch (error) {
			failed++;
			console.log(`  ✗ ${step.name}`);
			// execFileSync's throw carries the child's captured streams; nothing else lands here.
			const failure = /** @type {{ stdout?: Buffer | string, stderr?: Buffer | string }} */ (error);
			const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trimEnd();
			console.log(
				output
					.split('\n')
					.slice(-15)
					.map((line) => `      ${line}`)
					.join('\n')
			);
		}
	}

	// Skips are named, not just counted, so a run that skipped the thing you cared about says so.
	console.log(
		`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${steps.length - failed - skipped} ran, ${failed} failed, ${skipped} skipped.` +
			(skipped && !full ? ' Re-run with --full to include npm ci.' : '')
	);
	console.log(
		'This is not a substitute for CI. It runs one platform on one Node, not the\n' +
			"two-by-two matrix, and publish.yml's guards are not exercised here."
	);
	process.exit(failed === 0 ? 0 : 1);
}
