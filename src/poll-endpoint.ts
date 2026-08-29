// Poll a loopback endpoint until it answers, so a caller's verify() can be a one-line predicate.
import { request as httpsRequest } from 'node:https';

const PROBE_TIMEOUT_MS = 1000;

/** GET over https accepting a self-signed certificate. Loopback only: never point this off 127.0.0.1. */
function fetchInsecure(url: string, timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		const call = httpsRequest(url, { rejectUnauthorized: false, timeout: timeoutMs }, (response) => {
			if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
				response.resume();
				resolve(null);
				return;
			}
			let body = '';
			response.setEncoding('utf-8');
			response.on('data', (chunk) => (body += chunk));
			response.on('end', () => resolve(body));
		});
		call.on('timeout', () => call.destroy());
		call.on('error', () => resolve(null));
		call.end();
	});
}

async function probe(url: string, timeoutMs: number, insecureTls: boolean): Promise<string | null> {
	if (insecureTls) return fetchInsecure(url, timeoutMs);
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok ? await response.text() : null;
	} catch {
		return null;
	}
}

/** GET until something answers: the body text, or null on deadline or giveUp(). Never throws. */
export async function pollEndpoint({
	url,
	timeoutMs = 30_000,
	intervalMs = 250,
	giveUp,
	insecureTls = false,
}: {
	url: string;
	timeoutMs?: number;
	intervalMs?: number;
	/** Asked between probes, and only after one has failed, so a target that answered then died still counts. */
	giveUp?: () => boolean;
	/** Accept a self-signed certificate. Loopback-only self-signed endpoints; never point this off 127.0.0.1. */
	insecureTls?: boolean;
}): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const body = await probe(url, Math.min(PROBE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)), insecureTls);
		if (body !== null) return body;
		if (giveUp?.() || Date.now() >= deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
