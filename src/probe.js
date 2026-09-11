// Whether anything is answering yet, and what it said.
//
// A supervised process binds its port some seconds after the spawn returns, so "is it up" cannot be asked
// once. Everything here polls with a doubling backoff, never throws, and treats a dead process as a reason to
// stop early rather than a reason to keep asking. A flat 250ms wait costs ~120 requests over a ~6-7s bind.
//
// Nothing here knows what it is polling. The one thing a consumer supplies is `untraceWith`: a component that
// polls its own processes from inside a traced application turns every failed connect into an errored client
// span on the host's service unless the request is made under its tracer's suppression.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const PROBE_TIMEOUT_MS = 1000;
const MAX_INTERVAL_MS = 5_000;

/** @type {(run: () => any) => any} */
let wrap = (run) => run();

/**
 * Make every probe below run inside `fn`.
 *
 * Module-global, and it models something that is: a tracer's suppression is process-wide, so a second
 * component cannot want a different answer in the same process. Set once at wiring time; a consumer with no
 * tracer sets nothing and the requests are made directly.
 *
 * @param {(run: () => any) => any} fn
 */
export function untraceWith(fn) {
	wrap = fn;
}

/**
 * A probe body as JSON, or null. Never throws: these bodies come off a socket and the pollers' contract is
 * the same.
 *
 * @param {string | null} body
 */
export function parseJson(body) {
	try {
		return body === null ? null : JSON.parse(body);
	} catch {
		return null;
	}
}

/**
 * GET over http or https, accepting a self-signed certificate. Loopback only: never point this off
 * 127.0.0.1. Global fetch cannot stand in for it, because Node exposes no public dispatcher for that
 * certificate.
 *
 * @param {string} url @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
function get(url, timeoutMs) {
	return new Promise((resolve) => {
		/** @type {any} */
		let deadline;
		/** @param {string | null} body */
		const settle = (body) => {
			clearTimeout(deadline);
			resolve(body);
		};
		// node:http ignores rejectUnauthorized, so the scheme is the only difference between the two probes.
		const send = url.startsWith('https:') ? httpsRequest : httpRequest;
		const call = send(url, { rejectUnauthorized: false }, (response) => {
			const status = response.statusCode;
			if (status === undefined || status < 200 || status >= 300) {
				response.resume();
				settle(null);
				return;
			}
			let body = '';
			response.setEncoding('utf-8');
			response.on('data', (chunk) => (body += chunk));
			response.on('end', () => settle(body));
			// The reset a destroy() lands on an open response arrives here, not on the request, and an
			// unheard one leaves this promise pending for the life of the process.
			response.on('error', () => settle(null));
		});
		call.on('error', () => settle(null));
		// One deadline over the whole exchange rather than the socket's own inactivity timeout: a response
		// that starts and then stalls, or drips a byte at a time, never trips that one.
		deadline = setTimeout(() => {
			call.destroy();
			settle(null);
		}, timeoutMs);
		call.end();
	});
}

// Run under the wrapper: the span is created where the request is made, so that is the only place suppression
// cannot be undone by other code in the process.
/** @param {string} url @param {number} timeoutMs @returns {Promise<string | null>} */
async function probe(url, timeoutMs) {
	try {
		// Awaited inside the try rather than returned: the wrapper is a consumer's function and may reach into
		// a tracer's private path, and the never-throws contract has to hold if that path moves.
		return await wrap(() => get(url, timeoutMs));
	} catch {
		return null;
	}
}

/**
 * Whether anything accepts a connection on a unix socket path. Never throws, same contract as `probe`.
 *
 * A connect and an immediate close, with no request written: a process may well speak HTTP over this socket,
 * but what is being asked is whether it is listening, and a bare accept answers that without needing to know
 * a route that could move between versions. An ECONNREFUSED, an ENOENT, or a path that is not a socket all
 * arrive here as false.
 *
 * @param {string} path @param {number} timeoutMs
 */
function probeSocket(path, timeoutMs) {
	return new Promise((resolve) => {
		/** @type {any} */
		let deadline;
		/** @param {boolean} answered */
		const settle = (answered) => {
			clearTimeout(deadline);
			socket.destroy();
			resolve(answered);
		};
		const socket = connect(path);
		socket.on('connect', () => settle(true));
		socket.on('error', () => settle(false));
		deadline = setTimeout(() => settle(false), timeoutMs);
	});
}

/**
 * {@link pollEndpoint} against a unix socket, for a process that serves one instead of a loopback port.
 *
 * @param {{ path: string, timeoutMs?: number, intervalMs?: number, giveUp?: () => boolean }} options
 */
export async function pollUnixSocket({ path, timeoutMs = 30_000, intervalMs = 250, giveUp }) {
	const deadline = Date.now() + timeoutMs;
	let interval = intervalMs;
	for (;;) {
		const budget = Math.min(PROBE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1));
		// Untraced for the same reason the HTTP probes are: a failed connect during startup would otherwise
		// become an errored client span on the host application's own service.
		const answered = await wrap(() => probeSocket(path, budget)).catch(() => false);
		if (answered) return true;
		if (giveUp?.() || Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
		interval = Math.min(interval * 2, MAX_INTERVAL_MS);
	}
}

/**
 * GET until something answers: the body text, or null on deadline or giveUp(). Never throws.
 *
 * @param {{ url: string, timeoutMs?: number, intervalMs?: number, giveUp?: () => boolean }} options
 */
export async function pollEndpoint({ url, timeoutMs = 30_000, intervalMs = 250, giveUp }) {
	const deadline = Date.now() + timeoutMs;
	let interval = intervalMs;
	for (;;) {
		const budget = Math.min(PROBE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1));
		const body = await probe(url, budget);
		if (body !== null) return body;
		// Asked between probes, and only after one has failed, so a target that answered then died still counts.
		if (giveUp?.() || Date.now() >= deadline) return null;
		// Clamped to what is left: backing off must not spend the caller's budget asleep past the deadline.
		await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
		interval = Math.min(interval * 2, MAX_INTERVAL_MS);
	}
}

/**
 * The last bytes of a file, or null when it cannot be read at all.
 *
 * A supervised process's own log is the evidence of last resort: what it says about a failure is often the
 * only thing that says it, and an endpoint counter that reads zero cannot tell a stopped hop from one that
 * never started. Read from the end and bounded, because these files roll at megabytes and a status read
 * cannot afford the whole of one. A partial first line is the cost of reading from an offset; a caller
 * matching whole lines drops it on its own.
 *
 * @param {string} file @param {number} [maxBytes]
 * @returns {string | null}
 */
export function tailFile(file, maxBytes = 64 * 1024) {
	try {
		const { size } = statSync(file);
		const start = Math.max(0, size - maxBytes);
		const handle = openSync(file, 'r');
		try {
			const buffer = Buffer.alloc(Math.min(maxBytes, size - start));
			readSync(handle, buffer, 0, buffer.length, start);
			return buffer.toString('utf-8');
		} finally {
			closeSync(handle);
		}
	} catch {
		return null;
	}
}
