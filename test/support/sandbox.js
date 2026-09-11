// Scratch space and console capture for tests that touch the filesystem or a log.
//
// Came from @deliciousmonster/datadog-agent-binary with the supervision tests that needed them. Kept small
// on purpose: a helper that grows becomes a second thing to understand before reading a test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A temp directory for `run`'s duration, removed however it ends. @param {string} prefix @param {(dir: string) => any} run */
export async function withTempDir(prefix, run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Whatever `run` wrote to console.warn and console.error, as lines.
 *
 * Both channels into one list, because a caller asserting on a message should not have to know which
 * level the code chose; the level is asserted separately where it matters.
 *
 * @param {() => any} run
 * @returns {Promise<string[]>}
 */
export async function captureLogs(run) {
	/** @type {string[]} */
	const lines = [];
	const real = { warn: console.warn, error: console.error };
	console.warn = (/** @type {any[]} */ ...args) => lines.push(args.join(' '));
	console.error = (/** @type {any[]} */ ...args) => lines.push(args.join(' '));
	try {
		await run();
	} finally {
		Object.assign(console, real);
	}
	return lines;
}
