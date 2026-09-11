// The Harper boundary: everything a component has to deal with because it is a plugin rather than a program.
//
// Four things, and a consumer wrote every one of them for itself before this file existed. Harper's Logger
// declares every method optional. Harper calls the plugin once per worker thread, and for an auto-scanned
// component directory it never calls it at all. Harper exposes neither its root path nor its port overrides,
// so a component reads the same chain Harper reads for itself. And config files are written by every thread
// at once, so they are replaced rather than rewritten.
//
// A component that guesses its root puts the PID locks under each worker's own cwd, and two workers that
// disagree each start their own processes. That is the shape of every failure here: the host does not say,
// the component assumes, and the assumption differs per thread.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { threadId } from 'node:worker_threads';

// -- What the host gives you ---------------------------------------------------------------------------------

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

// -- When it calls you, and when it does not ------------------------------------------------------------------

// 60s because handleApplication runs behind scope.ready and waitForDeployCompletion, then behind a
// per-plugin lock whose own wait is Harper's plugin timeout plus 5s: 35s at the 30s default. A shorter
// window libels a slow node.
const START_DEADLINE_MS = 60_000;

/**
 * Watch for Harper never calling the plugin at all, which is what an auto-scanned component directory
 * gets: Harper imports the module for its resources, calls no plugin, and discards it. Module evaluation
 * is the only vantage point left, because nothing inside the plugin ever runs.
 *
 * @param {object} options
 * @param {Log} options.log
 * @param {string} options.label What this component calls itself in a log line, so this file names no
 *   consumer and can move to the guard unchanged.
 * @param {string} options.configEntry The root-config line an operator has to add, already rendered.
 * @param {number} [options.deadlineMs]
 * @returns {{ seen(): void }} Call `seen` the moment the plugin is entered.
 */
export function watchForNeverCalled({ log, label, configEntry, deadlineMs = START_DEADLINE_MS }) {
	const timer = setTimeout(() => {
		log.error(
			`${label}: Harper has not called handleApplication ${deadlineMs / 1000}s after this ` +
				`module loaded, so no agent started and nothing on this node is supervising one. The likeliest ` +
				`cause is a component Harper loaded by scanning componentsRoot: it calls the plugin only for a ` +
				`component the root harper-config.yaml names, and the module it imports for a scanned directory ` +
				`is discarded.`
		);
		log.error(
			`${label}: add this to the node's harper-config.yaml (the file settings_path names in ` +
				`~/.harperdb/hdb_boot_properties.file), keyed by this directory's name, then restart Harper: ${configEntry}`
		);
	}, deadlineMs);
	// A diagnostic must not be the reason a worker thread stays up.
	timer.unref?.();
	return { seen: () => clearTimeout(timer) };
}

/**
 * The plugin entry Harper calls once per worker thread.
 *
 * Two rules, and both are load-bearing. A deploy pre-flight loads the component against a live node just to
 * validate it, and starting there re-enters the sweep and spawn path on every `harper deploy`. And a second
 * call joins the first promise rather than starting again, which is the single-start guarantee the whole
 * PID lock exists to make good on.
 *
 * @param {object} options
 * @param {(scope?: any) => Promise<object>} options.start
 * @param {{ seen(): void }} options.deadline
 * @param {{ get(): Promise<object> | undefined, set(p: Promise<object>): void }} options.slot Where the
 *   started promise lives, so the read path can see the same one.
 */
export function createHandleApplication({ start, deadline, slot }) {
	return function handleApplication(/** @type {any} */ scope) {
		// Being called at all is what the deadline waits for; a validation load counts, since Harper
		// reached the plugin either way.
		deadline.seen();
		if (scope?.isTransientValidation) return;
		if (!slot.get()) slot.set(start(scope));
	};
}

// -- What it will not tell you --------------------------------------------------------------------------------

/** Rejects `rootPath: null`, which Harper's own defaultConfig.yaml ships, and anything relative. */
const absolute = (/** @type {string | undefined | null} */ value) => (value && isAbsolute(value) ? value : null);

/** Harper's own chain: the boot properties name the settings file, and the settings file names the root. */
function readBootProperties() {
	try {
		const boot = readFileSync(join(homedir(), '.harperdb', 'hdb_boot_properties.file'), 'utf-8');
		// Java-style properties, and Harper indents every line after the first, so the whitespace class matters.
		const settingsPath = boot.match(/^[ \t]*settings_path[ \t]*=[ \t]*(.+?)[ \t]*$/m)?.[1];
		if (!settingsPath) return null;
		// rootPath is top level in harper-config.yaml: the one key readable off a single line without a parser.
		const rootPath = readFileSync(settingsPath, 'utf-8')
			.match(/^rootPath[ \t]*:[ \t]*(.+?)[ \t]*(?:#.*)?$/m)?.[1]
			?.replace(/^(['"])(.*)\1$/, '$2');
		return absolute(rootPath);
	} catch {
		return null;
	}
}

/**
 * Harper's root path, or null. ROOTPATH is the harper-pro image's own spelling and wins where it is usable.
 *
 * @param {Log} log @param {string} [label] How the consumer names itself in a warning.
 * @returns {string | null}
 */
export function hostRoot(log, label = 'process guard') {
	const spelled = process.env.ROOTPATH;
	if (spelled && !absolute(spelled))
		log.warn(
			`${label}: ROOTPATH="${spelled}" is not an absolute path, so it is ignored. A relative one resolves ` +
				`against each worker's own cwd, and two workers that disagree take different PID locks and each ` +
				`start their own processes.`
		);
	return absolute(spelled) ?? readBootProperties();
}

/**
 * A port from the environment, or the fallback, never a number nobody wrote.
 *
 * parseInt reads "8126tcp" as 8126, so this matches the whole string instead. `0` is kept rather than
 * rejected because it is how every process here spells "serve no endpoint".
 *
 * @param {string} name @param {number} fallback @param {Log} log @param {string} [label]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePort(name, fallback, log, label = 'process guard', env = process.env) {
	const raw = env[name];
	if (!raw) return fallback;
	const trimmed = raw.trim();
	if (trimmed === '0') return 0;
	const parsed = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (parsed >= 1 && parsed <= 65535) return parsed;
	log.warn(`${label}: ${name}="${raw}" is not a port in 1-65535. Using ${fallback}.`);
	return fallback;
}

/**
 * Write every file, replacing whatever was there.
 *
 * Temp-and-rename, because every worker thread writes these on startup and a process rereading one must see
 * the old contents or the new, never half of each. Named per thread so two writing at once cannot share a
 * scratch file. A failure is logged and the rest are still written: one unwritable path is not a reason to
 * leave a process with no config at all.
 *
 * @param {Record<string, string>} files @param {Log} log @param {string} [label]
 */
export function writeFiles(files, log, label = 'process guard') {
	for (const [target, contents] of Object.entries(files)) {
		try {
			mkdirSync(dirname(target), { recursive: true });
			const temp = `${target}.${process.pid}.${threadId}.tmp`;
			writeFileSync(temp, contents, 'utf-8');
			renameSync(temp, target);
		} catch (error) {
			log.error(`${label}: could not write ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
