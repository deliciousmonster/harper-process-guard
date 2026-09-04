// @ts-check
// The rules that stop being true silently: a build step creeping back, a dependency arriving, a bare
// import that only resolves because node_modules happens to hold it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from '../support/harness.js';

const SRC = path.join(REPO_ROOT, 'src');
const sources = fs.readdirSync(SRC).filter((file) => file.endsWith('.js'));
/** @type {{ scripts: Record<string, string>, dependencies?: object, exports: Record<string, string>, files: string[] }} */
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

test('what is written is what ships: no build step, and the entry points at the source', () => {
	assert.equal(manifest.exports['.'], './src/index.js');
	assert.deepEqual(manifest.files, ['src/', 'README.md']);
	for (const name of ['build', 'prepare', 'prepublishOnly']) {
		assert.equal(manifest.scripts[name], undefined, `a "${name}" script would compile what is published`);
	}
	assert.equal(fs.existsSync(path.join(REPO_ROOT, 'dist')), false);
	assert.match(manifest.scripts.typecheck ?? '', /--noEmit/);
});

test('no runtime dependencies', () => {
	assert.equal(manifest.dependencies, undefined);
});

test('every source file is typechecked', () => {
	assert.ok(sources.length > 0, 'no sources were found, so this asserted nothing');
	for (const file of sources) {
		const first = fs.readFileSync(path.join(SRC, file), 'utf-8').split('\n')[0];
		assert.equal(first, '// @ts-check', `src/${file} opts out of the typecheck`);
	}
});

test('the source imports node: builtins and its own files, and nothing else', () => {
	for (const file of sources) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
		for (const [, specifier = ''] of text.matchAll(/^import [^']*'([^']+)'/gm)) {
			assert.ok(
				specifier.startsWith('node:') || specifier.startsWith('./'),
				`src/${file} imports "${specifier}", which is neither a builtin nor a sibling`
			);
		}
	}
});

test('the source knows nothing about any particular consumer', () => {
	// It is a process guard that a Datadog plugin happens to use, not a piece of that plugin.
	for (const file of sources) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
		assert.doesNotMatch(text, /datadog|dd-trace|dd_/i, `src/${file} names a consumer`);
	}
});

test('the public surface is the two things a consumer calls', async () => {
	const surface = Object.keys(await import('../../src/index.js')).sort();
	// Everything else is an implementation detail, and a narrow surface is what keeps it small enough
	// to hold in one head.
	assert.deepEqual(surface, ['fingerprint', 'guard']);
});
