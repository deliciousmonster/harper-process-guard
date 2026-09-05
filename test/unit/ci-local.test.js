// @ts-check
// The local CI runner fails by being quietly weaker than the workflow it stands in for, so every
// assertion here is against the real test.yml and never a fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { NOT_LOCAL, testJobSteps } from '../../scripts/ci-local.js';
import { REPO_ROOT } from '../support/harness.js';

// Line endings normalised: a Windows checkout rewrites this file to CRLF unless git is told not to, and
// the job header below is found by an exact newline match.
const workflowText = fs
	.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'), 'utf-8')
	.replaceAll('\r\n', '\n');

test('only the environment steps are excused, so a new excuse has to be argued for', () => {
	// Coverage is lost by adding a name to NOT_LOCAL, which must not pass unnoticed.
	assert.deepEqual([...NOT_LOCAL.keys()].sort(), ['Checkout', 'Install dependencies', 'Setup Node.js']);
});

test('the extractor finds every named step the workflow declares in the test job', () => {
	// Counted from the file directly, so a regex that stopped matching cannot agree with itself.
	const jobStart = workflowText.indexOf('\n  test:\n');
	assert.ok(jobStart >= 0, 'test.yml no longer has the job shape this reads');
	const afterHeader = jobStart + '\n  test:\n'.length;
	const nextJob = workflowText.slice(afterHeader).search(/^\s{2}\S+:\s*$/m);
	const jobText = workflowText.slice(jobStart, nextJob === -1 ? workflowText.length : afterHeader + nextJob);
	const declared = jobText.match(/^\s*- name: .+$/gm) ?? [];
	assert.equal(testJobSteps().length, declared.length);
});

test('the steps that actually gate a merge are all extracted with a command', () => {
	const byName = new Map(testJobSteps().map((step) => [step.name, step.run]));
	for (const name of ['Check formatting', 'Lint', 'Type check', 'Run npm test', 'Guard against an empty test glob']) {
		assert.ok(byName.get(name), `"${name}" extracted no command, so the local run would skip the check`);
	}
});

test('a multi-line run: block is extracted whole, not just its first line', () => {
	const guard = testJobSteps().find((step) => step.name === 'Guard against an empty test glob');
	assert.match(guard?.run ?? '', /count=\$\(find test/);
	// Truncating at the first line would drop the exit 1 and turn the guard into an echo.
	assert.match(guard?.run ?? '', /exit 1/);
});

test('NOT_LOCAL only excuses steps the workflow actually has', () => {
	const names = new Set(testJobSteps().map((step) => step.name));
	for (const excused of NOT_LOCAL.keys()) {
		// A stale entry here would silently excuse nothing while looking like coverage.
		assert.ok(names.has(excused), `NOT_LOCAL names "${excused}", which is no longer a step in the test job`);
	}
});
