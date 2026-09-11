// Scratch space and console capture for tests that touch the filesystem or a log.
//
// Came from @deliciousmonster/datadog-agent-binary with the supervision tests that needed them. Kept small
// on purpose: a helper that grows becomes a second thing to understand before reading a test.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
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

/** A 127.0.0.1 port with nothing listening: the momentary listener closes before the port is handed back. */
export function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {any} */ (server.address());
			server.close(() => resolve(port));
		});
	});
}

/**
 * `run` against a server listening on an ephemeral 127.0.0.1 port, closed however `run` ends.
 *
 * @param {import('node:http').Server | import('node:https').Server} server
 * @param {(port: number) => Promise<any>} run
 */
export async function withServer(server, run) {
	const port = await new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve(/** @type {any} */ (server.address()).port))
	);
	try {
		return await run(/** @type {number} */ (port));
	} finally {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
}

/**
 * globalThis.setTimeout replaced by `patch(realSetTimeout)` for `run`'s duration, restored however it ends.
 *
 * The only way to read a backoff schedule without waiting it out: the waits are what is being asserted, and a
 * test that sat through them would take half a minute to prove eight numbers.
 *
 * @param {(real: typeof setTimeout) => any} patch @param {() => Promise<any>} run
 */
export async function withPatchedSetTimeout(patch, run) {
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = patch(realSetTimeout);
	try {
		return await run();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
}
