// The one thing a plaintext stub cannot stand in for: a process that serves its own diagnostics under a
// self-signed certificate, which every probe that reads it dials over https. Without this the TLS half of
// src/probe.js is exercised by nothing, which is how a response that starts and then stalls got as far as a
// release of the package that first carried this code.

import https from 'node:https';

// Self-signed, for 127.0.0.1, valid for a century. It secures nothing and protects nothing: the only thing
// that ever presents it is a stub in this repo's own tests, and every probe that reads one sets
// rejectUnauthorized: false. Committed rather than generated per run so the suite needs no openssl on any of
// the three operating systems CI runs it on.
const TEST_ONLY_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgarF6Z1XpxwYrKQuH
DgtiUrbspwokWGSdFIO6M+5mrFOhRANCAATzNHyopkFHrXBcaMtiUDJOqYAIWFac
ljPVZHXaBSt9fXzsjD3MEN1EBSIUE5IuLKIToD7Mfh4fUe21ZcaFKxgd
-----END PRIVATE KEY-----
`;

const TEST_ONLY_CERT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATagAwIBAgIUReD+SgKEmwJqEEbQmzXEax4D/LUwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDkwNTEwMDA1NloYDzIxMjYwODEy
MTAwMDU2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATzNHyopkFHrXBcaMtiUDJOqYAIWFacljPVZHXaBSt9fXzsjD3MEN1E
BSIUE5IuLKIToD7Mfh4fUe21ZcaFKxgdo2QwYjAdBgNVHQ4EFgQUsLz4ScQWv80y
/0fXhWTW53mgIPYwHwYDVR0jBBgwFoAUsLz4ScQWv80y/0fXhWTW53mgIPYwDwYD
VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0gAMEUC
IQDQ8Wqnm8yKWsthaHLhVEsDuwTo2pH6eYYV1AZdaOilRgIgBRyORaQi05ZZEq/V
v7rIPFIHYNh/n0B/S0CqgRbwszc=
-----END CERTIFICATE-----
`;

const CREDENTIALS = { key: TEST_ONLY_KEY, cert: TEST_ONLY_CERT };

/**
 * An unstarted https server answering `answers` with `body` at 200, and 404 everywhere else. `body` may be a
 * function, so a stub can answer with something known only once the code under test has run: the pid that
 * ended up on the lock, say.
 */
export function createTlsStub({ body = {}, answers = '/debug/vars' } = {}) {
	return https.createServer(CREDENTIALS, (request, response) => {
		const head = { 'content-type': 'application/json' };
		if (request.url !== answers) {
			response.writeHead(404, head);
			response.end('{}');
			return;
		}
		response.writeHead(200, head);
		response.end(JSON.stringify(typeof body === 'function' ? body() : body));
	});
}

/**
 * Headers, part of a body, then nothing, on every request: the socket stays open and idle. A wedged process
 * does this, and it is the one case a request-level timeout cannot see, since the request is long finished.
 * `held` collects the responses so a caller's teardown can end them.
 */
export function createStallingTlsStub(/** @type {any[]} */ held) {
	return https.createServer(CREDENTIALS, (request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.write('{"receiver":');
		held.push(response);
	});
}
