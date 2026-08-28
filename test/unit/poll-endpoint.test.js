// pollEndpoint against real loopback servers, and readHarperRootPath against real Harper-shaped files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { importDist, withHome, withServer, withTempDir } from '../support/harness.js';

const { pollEndpoint, readHarperRootPath } = await importDist('index.js');

test('a body is returned as text once the endpoint answers', async () => {
	const server = http.createServer((request, response) => {
		if (request.url !== '/info') {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end('{"endpoints":["/v0.4/traces"]}');
	});
	await withServer(server, async (port) => {
		const body = await pollEndpoint({ url: `http://127.0.0.1:${port}/info` });
		assert.equal(body, '{"endpoints":["/v0.4/traces"]}');
	});
});

test('an endpoint that only 404s is null at the deadline, not a throw', async () => {
	const server = http.createServer((request, response) => {
		response.writeHead(404);
		response.end();
	});
	await withServer(server, async (port) => {
		const body = await pollEndpoint({ url: `http://127.0.0.1:${port}/info`, timeoutMs: 300, intervalMs: 50 });
		assert.equal(body, null);
	});
});

test('a server that accepts and never answers is null at the deadline', async () => {
	// The handler holds the socket open, which is what a wedged agent looks like from outside.
	const server = http.createServer(() => {});
	await withServer(server, async (port) => {
		const started = Date.now();
		const body = await pollEndpoint({ url: `http://127.0.0.1:${port}/info`, timeoutMs: 400, intervalMs: 50 });
		assert.equal(body, null);
		assert.ok(Date.now() - started < 5000, 'the deadline must bound the wait');
	});
});

test('giveUp stops the poll long before the deadline', async () => {
	const server = http.createServer((request, response) => {
		response.writeHead(404);
		response.end();
	});
	await withServer(server, async (port) => {
		let asked = 0;
		const started = Date.now();
		const body = await pollEndpoint({
			url: `http://127.0.0.1:${port}/info`,
			timeoutMs: 30_000,
			giveUp: () => ++asked > 0,
		});
		assert.equal(body, null);
		assert.ok(asked >= 1, 'giveUp was never consulted');
		assert.ok(Date.now() - started < 5000, 'the 30s deadline was sat out despite giveUp');
	});
});

test('the poll retries until an endpoint that starts failing comes good', async () => {
	let hits = 0;
	const server = http.createServer((request, response) => {
		hits += 1;
		response.writeHead(hits < 3 ? 503 : 200);
		response.end(hits < 3 ? '' : 'ready');
	});
	await withServer(server, async (port) => {
		const body = await pollEndpoint({ url: `http://127.0.0.1:${port}/info`, timeoutMs: 5000, intervalMs: 25 });
		assert.equal(body, 'ready');
		assert.ok(hits >= 3);
	});
});

test('readHarperRootPath follows boot properties to the settings file and takes an absolute rootPath', () =>
	withTempDir('rootpath-ok-', (home) =>
		withHome(home, async () => {
			const settings = path.join(home, 'harper-config.yaml');
			fs.mkdirSync(path.join(home, '.harperdb'), { recursive: true });
			// Java-style properties with Harper's own indentation, not YAML.
			fs.writeFileSync(
				path.join(home, '.harperdb', 'hdb_boot_properties.file'),
				`#|-- HarperDB --|#\n   settings_path = ${settings}\n`
			);
			fs.writeFileSync(settings, `rootPath: ${path.join(home, 'hdb')}\nlogging:\n  root: log\n`);
			assert.equal(readHarperRootPath(), path.join(home, 'hdb'));
		})
	));

test('readHarperRootPath is null for a missing boot file, a null rootPath, and a relative one', () =>
	withTempDir('rootpath-null-', (home) =>
		withHome(home, async () => {
			assert.equal(readHarperRootPath(), null, 'no boot file');

			const settings = path.join(home, 'harper-config.yaml');
			fs.mkdirSync(path.join(home, '.harperdb'), { recursive: true });
			fs.writeFileSync(path.join(home, '.harperdb', 'hdb_boot_properties.file'), `   settings_path = ${settings}\n`);

			// `rootPath: null` is what Harper's own defaultConfig.yaml ships.
			fs.writeFileSync(settings, 'rootPath: null\n');
			assert.equal(readHarperRootPath(), null, 'a literal null must not become a path');

			fs.writeFileSync(settings, 'rootPath: relative/dir\n');
			assert.equal(readHarperRootPath(), null, 'a relative path is not usable from a worker cwd');
		})
	));
