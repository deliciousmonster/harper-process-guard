#!/usr/bin/env node
// Run the Test workflow's test job locally, with steps EXTRACTED from test.yml so the two cannot drift; --full adds npm ci.
import { execFileSync } from 'node:child_process';
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

// Every step of the `test` job, in order, as `{ name, run }`; stops before the next job so a later job's steps never run here.
export function testJobSteps() {
	const lines = readFileSync(WORKFLOW, 'utf-8').split('\n');
	const start = lines.findIndex((line) => /^\s{2}test:\s*$/.test(line));
	if (start === -1) throw new Error('test.yml: no `test:` job');
	const end = lines.findIndex((line, index) => index > start && /^\s{2}\S+:\s*$/.test(line));
	const body = lines.slice(start, end === -1 ? lines.length : end);

	const steps = [];
	for (let i = 0; i < body.length; i++) {
		const named = body[i].match(/^\s*- name: (.+?)\s*$/);
		if (!named) continue;
		const name = named[1];
		let run = null;
		for (let j = i + 1; j < body.length && !/^\s*- name: /.test(body[j]); j++) {
			const inline = body[j].match(/^\s+run: (?!\|)(.+?)\s*$/);
			if (inline) {
				run = inline[1];
				break;
			}
			if (/^\s+run: \|\s*$/.test(body[j])) {
				const indent = body[j + 1].match(/^(\s*)/)[1].length;
				const block = [];
				for (let k = j + 1; k < body.length; k++) {
					if (body[k].trim() !== '' && body[k].match(/^(\s*)/)[1].length < indent) break;
					block.push(body[k].slice(indent));
				}
				run = block.join('\n').trimEnd();
				break;
			}
		}
		steps.push({ name, run });
	}

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
			const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trimEnd();
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
