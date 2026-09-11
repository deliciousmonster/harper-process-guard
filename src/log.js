// Harper's Logger declares every method optional, and a component that calls `log.info` unguarded on a
// host that only implements `warn` throws from inside a lock it has already committed. Normalised once,
// here, rather than defended at each of the forty call sites.
//
// guard() already takes a `log` and documents every method as optional, which left each consumer writing
// this adapter for itself. It lives here so they stop.

/** @typedef {{ info(m: string): void, warn(m: string): void, error(m: string): void }} Log */

/**
 * A log with all three methods, whatever the host implements.
 *
 * Each level falls back to the next most severe thing the host has, and to console.log if it has nothing,
 * so a message is never dropped for want of a method. Bound to the host, because Harper's logger reads
 * `this`.
 *
 * @param {object} [host] Harper's compartment `logger`, or anything console-shaped.
 * @returns {Log}
 */
export function normaliseLog(host = console) {
	/** @type {Record<string, unknown>} */
	const methods = /** @type {any} */ (host);
	/** @type {(...names: string[]) => (message: string) => void} */
	const channel =
		(...names) =>
		(message) => {
			const write = names.map((name) => methods[name]).find((candidate) => typeof candidate === 'function');
			/** @type {(m: string) => void} */ (write ?? console.log).call(host, message);
		};
	return {
		info: channel('info', 'warn'),
		warn: channel('warn', 'info'),
		error: channel('error', 'warn'),
	};
}
