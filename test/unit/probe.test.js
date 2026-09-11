// Polling a process that has not bound its port yet. Against real servers and real sockets, because what is
// being asserted is how node's http client and net socket behave on the edges, and a mock would assert only
// what this test already believes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJson, pollEndpoint, pollUnixSocket, tailFile, untraceWith } from '../../src/probe.js';
import { withTempDir } from '../support/sandbox.js';

/**
 * An http server on a loopback port for the test's duration.
 *
 * @param {import('node:http').RequestListener} handler @param {(base: string) => Promise<any>} run
 */
async function withServer(handler, run) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const { port } = /** @type {any} */ (server.address());
	try {
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
}

test('parseJson answers null for everything that is not JSON, and never throws', () => {
	assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
	for (const body of [null, '', 'not json', '<html>503</html>', '{"a":'])
		assert.equal(parseJson(body), null, String(body));
});

test('a body is returned once something answers', () =>
	withServer(
		(_request, response) => response.end('{"pid":42}'),
		async (base) => {
			assert.equal(await pollEndpoint({ url: `${base}/debug/vars`, timeoutMs: 2000 }), '{"pid":42}');
		}
	));

// An agent that is up but serving an error page is not an agent this node can use, and a 404 body parsed as a
// verdict would read as one that answered.
test('NEGATIVE: a non-2xx answer is not an answer', () =>
	withServer(
		(_request, response) => {
			response.statusCode = 404;
			response.end('not here');
		},
		async (base) => {
			assert.equal(await pollEndpoint({ url: `${base}/nope`, timeoutMs: 300, intervalMs: 50 }), null);
		}
	));

test('nothing listening reads as null rather than throwing', async () => {
	// Port 1 on loopback: refused immediately and never bindable by an unprivileged test.
	assert.equal(await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 300, intervalMs: 50 }), null);
});

// The giveUp is how a dead process stops the poll early: nothing it binds will ever answer, and the caller
// would otherwise spend its whole deadline asking.
test('giveUp stops the poll before the deadline', async () => {
	const started = Date.now();
	assert.equal(
		await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 10_000, intervalMs: 50, giveUp: () => true }),
		null
	);
	assert.ok(Date.now() - started < 5000, `the poll ran for ${Date.now() - started}ms despite giveUp`);
});

// Asked only after a probe has failed, so a target that answered and then died still reports what it said.
test('giveUp is not asked before the first probe', () =>
	withServer(
		(_request, response) => response.end('answered'),
		async (base) => {
			let asked = 0;
			const body = await pollEndpoint({
				url: `${base}/`,
				timeoutMs: 2000,
				giveUp: () => {
					asked++;
					return true;
				},
			});
			assert.equal(body, 'answered');
			assert.equal(asked, 0, 'a target that answers must not be abandoned for a giveUp that was true');
		}
	));

// A response that starts and then stalls never trips the socket's own inactivity timeout, and the whole poll
// hangs behind it.
test('NEGATIVE: a stalled response is abandoned on the deadline', () =>
	withServer(
		(_request, response) => {
			response.writeHead(200);
			response.write('half');
			// Never ended: the request completes and the body never finishes arriving.
		},
		async (base) => {
			// Raced against a timer rather than merely timed, because the failure mode is a promise that never
			// settles: a test that only measured the elapsed time would hang instead of failing.
			const answer = await Promise.race([
				pollEndpoint({ url: `${base}/`, timeoutMs: 2500, intervalMs: 100 }),
				new Promise((resolve) => setTimeout(() => resolve('HUNG'), 8000).unref?.()),
			]);
			assert.equal(answer, null, 'the poll never came back: nothing bounds a response that stalls mid-body');
		}
	));

test('a unix socket that accepts is an answer', () =>
	withTempDir('probe-sock-', async (dir) => {
		const path = join(dir, 'probe.sock');
		const server = createSocketServer((socket) => socket.end());
		await new Promise((resolve) => server.listen(path, () => resolve(undefined)));
		try {
			assert.equal(await pollUnixSocket({ path, timeoutMs: 2000 }), true);
		} finally {
			await new Promise((resolve) => server.close(() => resolve(undefined)));
		}
	}));

test('NEGATIVE: a missing socket, and a path that is a plain file, both read as false', () =>
	withTempDir('probe-nosock-', async (dir) => {
		assert.equal(await pollUnixSocket({ path: join(dir, 'absent.sock'), timeoutMs: 250, intervalMs: 50 }), false);
		const file = join(dir, 'plain');
		writeFileSync(file, 'not a socket');
		assert.equal(await pollUnixSocket({ path: file, timeoutMs: 250, intervalMs: 50 }), false);
	}));

// The reason this hook exists: without it every failed connect during a startup poll becomes an errored client
// span on the host application's own service.
test('the wrapper is what every probe runs inside', async () => {
	let inside = 0;
	untraceWith((run) => {
		inside++;
		return run();
	});
	try {
		await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 200, intervalMs: 50 });
		const afterHttp = inside;
		assert.ok(afterHttp > 0, 'the HTTP probe was made outside the wrapper');
		await pollUnixSocket({ path: '/nonexistent/probe.sock', timeoutMs: 200, intervalMs: 50 });
		assert.ok(inside > afterHttp, 'the socket probe was made outside the wrapper');
	} finally {
		untraceWith((run) => run());
	}
});

// A consumer's wrapper reaches into a tracer's private path, and the never-throws contract has to hold when
// that path moves.
test('NEGATIVE: a wrapper that throws does not break the never-throws contract', async () => {
	untraceWith(() => {
		throw new Error('the private path moved');
	});
	try {
		assert.equal(await pollEndpoint({ url: 'http://127.0.0.1:1/vars', timeoutMs: 200, intervalMs: 50 }), null);
	} finally {
		untraceWith((run) => run());
	}
});

test('tailFile returns the end of the file, bounded', () =>
	withTempDir('probe-tail-', async (dir) => {
		const file = join(dir, 'agent.log');
		writeFileSync(file, '');
		for (let line = 0; line < 500; line++) appendFileSync(file, `line ${line} padded out to some width\n`);
		const tail = tailFile(file, 1024);
		assert.ok(tail !== null);
		assert.ok(tail.length <= 1024, `read ${tail.length} bytes for a 1024 budget`);
		assert.match(tail, /line 499/, 'the end of the file is the part worth reading');
		assert.doesNotMatch(tail, /line 0 /, 'the whole file was read despite the budget');
	}));

// These files roll at megabytes and a status read cannot afford the whole of one, so the budget has to hold
// even when the file is far bigger than it.
test('tailFile reads no more than the budget from a file much larger than it', () =>
	withTempDir('probe-big-', async (dir) => {
		const file = join(dir, 'big.log');
		writeFileSync(file, 'x'.repeat(200_000));
		assert.equal(tailFile(file, 4096)?.length, 4096);
	}));

test('a file smaller than the budget comes back whole', () =>
	withTempDir('probe-small-', async (dir) => {
		const file = join(dir, 'small.log');
		writeFileSync(file, 'short');
		assert.equal(tailFile(file, 4096), 'short');
	}));

test('NEGATIVE: a file that cannot be read at all is null, not an empty tail', () =>
	withTempDir('probe-none-', async (dir) => {
		assert.equal(tailFile(join(dir, 'absent.log')), null);
		assert.equal(tailFile(dir), null, 'a directory is not a log');
	}));
