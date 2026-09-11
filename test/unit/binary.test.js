// Resolving a binary out of the platform packages, and the three failures that read as the same thing if
// nothing separates them: the add-on package was never installed, the installed one predates the binary, or
// the base package is missing entirely. Each wants a different fix from whoever reads the error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createBinaryResolver, resolutionFailure } from '../../src/binary.js';
import { withTempDir } from '../support/sandbox.js';

/** @type {import('../../src/binary.js').PackageVariant} */
const BASE = { suffix: '', optional: false };
/** @type {import('../../src/binary.js').PackageVariant} */
const PROBE = { suffix: '-probe', optional: true, carries: 'It carries system-probe and 42 MB of eBPF objects.' };
const VARIANTS = [BASE, PROBE];

/** A resolver whose packages cannot be installed, so every resolution falls through to the local build. */
const resolver = (/** @type {string} */ root) =>
	createBinaryResolver({
		packageName: '@test/nothing-is-published-under-this-scope',
		packageRoot: root,
		variants: VARIANTS,
		buildCommand: 'npm run build-agent',
	});

/** The build output a dev checkout has. @param {string} root @param {string} platform @param {string} file */
function writeLocalBuild(root, platform, file) {
	const dir = join(root, 'build', platform, 'bin');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, '#!/bin/sh\nexit 0\n');
	chmodSync(path, 0o755);
	return path;
}

test('a dev checkout resolves its own build output', () =>
	withTempDir('binary-local-', async (root) => {
		const resolve = resolver(root);
		const exe = process.platform === 'win32' ? '.exe' : '';
		const expected = writeLocalBuild(root, resolve.platformName(), `trace-agent${exe}`);
		assert.equal(await resolve.resolveBinary({ shipsAs: 'trace-agent', title: 'trace-agent' }), expected);
	}));

// A silent empty string here is a spawn of nothing, which is the failure this whole package exists to remove.
test('NEGATIVE: nothing resolved throws and names every package it asked', () =>
	withTempDir('binary-none-', async (root) => {
		const resolve = resolver(root);
		await assert.rejects(
			() => resolve.resolveBinary({ shipsAs: 'trace-agent', title: 'trace-agent' }),
			(/** @type {any} */ error) => {
				assert.match(error.message, /^no trace-agent binary: /);
				assert.match(error.message, /-probe-/, 'the add-on package must be named among those asked');
				assert.match(error.message, /nor a local build at/);
				assert.ok(error.message.includes(root), 'an operator needs the local path that was checked');
				return true;
			}
		);
	}));

test('a platform with no package at all is refused by name', () => {
	const resolve = createBinaryResolver({
		packageName: '@test/x',
		packageRoot: '/tmp',
		variants: VARIANTS,
		labels: { os: {}, arch: {} },
	});
	assert.throws(() => resolve.platformName(), /unsupported platform: /);
});

test('the platform label is the one the packages are published under', () => {
	const resolve = createBinaryResolver({
		packageName: '@test/x',
		packageRoot: '/tmp',
		variants: VARIANTS,
		labels: { os: { [process.platform]: 'thisos' }, arch: { [process.arch]: 'thisarch' } },
	});
	assert.equal(resolve.platformName(), 'thisos-thisarch');
});

test('an uninstalled package states no directory of its own', async () => {
	const resolve = createBinaryResolver({
		packageName: '@test/nothing-is-published-under-this-scope',
		packageRoot: '/tmp',
		variants: VARIANTS,
	});
	assert.equal(await resolve.resolveDir(PROBE, 'getEbpfDir'), null);
});

// The version that predates a second binary answers every request with the first one, and that path exists.
// Trusting it starts two copies of the wrong process and nothing binds the port the other was for.
test('NEGATIVE: a package that answered with the wrong binary says so, and says to upgrade', () => {
	const asked = [
		{ name: '@x/base-linux-x86_64', optional: false, installed: true, staleMatch: '/pkg/bin/datadog-agent' },
		{ name: '@x/base-probe-linux-x86_64', optional: true, installed: false },
	];
	const message = resolutionFailure(asked, 'trace-agent', '/repo/build/linux-x86_64/bin/trace-agent', 'npm run build');
	assert.match(message, /predates trace-agent support \(it resolved \/pkg\/bin\/datadog-agent instead\)/);
	assert.match(message, /Update @x\/base-linux-x86_64 to a version that ships trace-agent/);
	assert.match(message, /npm run build/);
	assert.doesNotMatch(message, /is not installed/, 'an installed package must not be reported missing');
});

// An operator's own choice, not a defect: they did not install the add-on. The fix is a name to install, and
// the reason it is not a dependency belongs in the same sentence.
test('a missing add-on package is reported as one to install, with why it is separate', () => {
	const asked = [
		{ name: '@x/base-linux-x86_64', optional: false, installed: true },
		{
			name: '@x/base-probe-linux-x86_64',
			optional: true,
			installed: false,
			carries: 'It carries system-probe and 42 MB of eBPF objects.',
		},
	];
	const message = resolutionFailure(asked, 'system-probe', '/repo/build/bin/system-probe', 'npm run build');
	assert.match(message, /@x\/base-probe-linux-x86_64 is not installed/);
	assert.match(message, /It carries system-probe and 42 MB of eBPF objects\./);
	assert.match(message, /npm install @x\/base-probe-linux-x86_64/);
});

// A base package that is not there is a broken install, and telling that operator to `npm install` the add-on
// sends them to the wrong fix entirely.
test('NEGATIVE: a missing base package is not reported as a missing add-on', () => {
	const asked = [
		{ name: '@x/base-linux-x86_64', optional: false, installed: false },
		{ name: '@x/base-probe-linux-x86_64', optional: true, installed: false },
	];
	const message = resolutionFailure(asked, 'trace-agent', '/repo/build/bin/trace-agent', 'npm run build');
	assert.doesNotMatch(message, /npm install @x\/base-probe/);
	assert.match(message, /none of @x\/base-linux-x86_64, @x\/base-probe-linux-x86_64/);
	assert.match(message, /nor a local build at \/repo\/build\/bin\/trace-agent/);
});

// The installed-package path, with the import injected: a test cannot install a platform package, and the
// basename check is the assertion most worth having.
test('an installed package that answers with the right file resolves it', () =>
	withTempDir('binary-installed-', async (root) => {
		const exe = process.platform === 'win32' ? '.exe' : '';
		const real = join(root, `trace-agent${exe}`);
		writeFileSync(real, 'binary');
		const resolve = createBinaryResolver({
			packageName: '@x/base',
			packageRoot: root,
			variants: VARIANTS,
			load: async () => ({ getBinaryPath: () => real }),
		});
		assert.equal(await resolve.resolveBinary({ shipsAs: 'trace-agent' }), real);
	}));

// The defect this check exists for. A package published before the trace-agent shipped answers every request
// with the core agent, and that path exists: trusting it starts two core agents and nothing binds the receiver.
test('NEGATIVE: a package answering with a different binary is refused, not spawned', () =>
	withTempDir('binary-stale-', async (root) => {
		const exe = process.platform === 'win32' ? '.exe' : '';
		const wrong = join(root, 'datadog-agent');
		writeFileSync(wrong, 'the only binary this version ships');
		const resolve = createBinaryResolver({
			packageName: '@x/base',
			packageRoot: root,
			variants: VARIANTS,
			load: async () => ({ getBinaryPath: () => wrong }),
		});
		await assert.rejects(
			() => resolve.resolveBinary({ shipsAs: 'trace-agent', title: 'trace-agent' }),
			(/** @type {any} */ error) => {
				// The filename, suffix and all: on Windows the resolver asks for trace-agent.exe, and a message
				// naming the bare stem would be one an operator cannot match against what is on disk.
				assert.match(error.message, new RegExp(`predates trace-agent${exe} support`));
				assert.ok(error.message.includes(wrong), 'the path it answered with is the evidence');
				return true;
			}
		);
	}));

// X_OK and existsSync disagree on a path a package reports but never wrote, which is what a failed postinstall
// or a partial extract leaves behind.
test('NEGATIVE: a path the package reports but nothing is at is not resolved', () =>
	withTempDir('binary-absent-', async (root) => {
		const resolve = createBinaryResolver({
			packageName: '@x/base',
			packageRoot: root,
			variants: VARIANTS,
			load: async () => ({ getBinaryPath: () => join(root, 'trace-agent') }),
		});
		await assert.rejects(() => resolve.resolveBinary({ shipsAs: 'trace-agent' }), /no trace-agent binary/);
	}));

// The ordinary answer from the base package when asked for a binary only the add-on ships. Installed, and
// without this one: that must not be reported as a version to upgrade.
test('a package that throws on a name it does not carry is installed, not stale', () =>
	withTempDir('binary-throws-', async (root) => {
		const resolve = createBinaryResolver({
			packageName: '@x/base',
			packageRoot: root,
			variants: VARIANTS,
			load: async (name) => {
				if (name.includes('-probe-')) throw new Error('not installed');
				return {
					getBinaryPath: () => {
						throw new Error('@x/base does not ship system-probe');
					},
				};
			},
		});
		await assert.rejects(
			() => resolve.resolveBinary({ shipsAs: 'system-probe' }),
			(/** @type {any} */ error) => {
				assert.match(error.message, /-probe-.* is not installed/);
				assert.match(error.message, /It carries system-probe and 42 MB of eBPF objects\./);
				assert.doesNotMatch(error.message, /predates/, 'a package without the binary is not an outdated one');
				return true;
			}
		);
	}));

test('a package states its own directory through the accessor it exports', () =>
	withTempDir('binary-dir-', async (root) => {
		const resolve = createBinaryResolver({
			packageName: '@x/base',
			packageRoot: root,
			variants: VARIANTS,
			load: async () => ({ default: { getEbpfDir: () => root } }),
		});
		assert.equal(await resolve.resolveDir(PROBE, 'getEbpfDir'), root);
		assert.equal(await resolve.resolveDir(PROBE, 'getNothing'), null, 'an accessor it does not export');
	}));

// A computed path goes stale the moment that package's layout changes, and the directory would then silently
// point nowhere: a probe that loads no eBPF object at all and reports a missing toolchain.
test('NEGATIVE: a directory the package names but nothing is at is null', () =>
	withTempDir('binary-nodir-', async (root) => {
		const resolve = createBinaryResolver({
			packageName: '@x/base',
			packageRoot: root,
			variants: VARIANTS,
			load: async () => ({ getEbpfDir: () => join(root, 'moved') }),
		});
		assert.equal(await resolve.resolveDir(PROBE, 'getEbpfDir'), null);
	}));

// A wrong answer outranks an absence: an operator who installs the add-on on that advice still has the same
// broken base package afterwards, and has learnt nothing.
test('a wrong answer is reported ahead of an uninstalled optional package', () => {
	const asked = [
		{ name: '@x/base-linux-x86_64', optional: false, installed: true, staleMatch: '/pkg/bin/datadog-agent' },
		{ name: '@x/base-probe-linux-x86_64', optional: true, installed: false, carries: 'It carries the objects.' },
	];
	const message = resolutionFailure(asked, 'system-probe', '/repo/build/bin/system-probe', 'npm run build');
	assert.match(message, /predates/);
	assert.doesNotMatch(message, /npm install/, 'told the reader to install a package that would not fix this');
});

// Suggesting an install of something already installed is advice that cannot work, and the fallback has to name
// every package that was asked or the reader goes checking the one that was fine.
test('NEGATIVE: an installed add-on is never suggested for installation', () => {
	const asked = [
		{ name: '@x/base-linux-x86_64', optional: false, installed: true },
		{ name: '@x/base-probe-linux-x86_64', optional: true, installed: true, carries: 'It carries the objects.' },
	];
	const message = resolutionFailure(asked, 'security-agent', '/repo/build/bin/security-agent', 'npm run build');
	assert.doesNotMatch(message, /npm install/);
	assert.match(message, /@x\/base-linux-x86_64, @x\/base-probe-linux-x86_64/);
	assert.match(message, /\/repo\/build\/bin\/security-agent/);
});

// A second required package that is missing is a broken install, and "npm install" on it is the wrong fix: it
// is already a dependency, so an install that skipped it will skip it again. Only a variant an operator adds by
// name gets that sentence.
test('NEGATIVE: a missing required variant is never reported as one to install by name', () => {
	const asked = [
		{ name: '@x/base-linux-x86_64', optional: false, installed: true },
		{ name: '@x/extra-linux-x86_64', optional: false, installed: false },
		{ name: '@x/probe-linux-x86_64', optional: true, installed: false, carries: 'It carries the eBPF objects.' },
	];
	const message = resolutionFailure(asked, 'system-probe', '/repo/build/bin/system-probe', 'npm run build');
	assert.doesNotMatch(message, /npm install @x\/extra-linux-x86_64/, 'a dependency is not installed by hand');
	assert.match(message, /npm install @x\/probe-linux-x86_64/);
});
