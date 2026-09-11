// What a component reads off the host before it can start anything, and what it writes back.
//
// Harper exposes none of this to a component. Its root path is in a boot properties file, its port overrides
// are in the environment, and a component that wants either has to read the same chain Harper reads for
// itself. So it is read here once rather than invented per consumer: a component that guesses its root puts
// the PID locks under each worker's own cwd, and two workers that disagree each start their own processes.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { threadId } from 'node:worker_threads';

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
 * @param {import('./log.js').Log} log @param {string} [label] How the consumer names itself in a warning.
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
 * @param {string} name @param {number} fallback @param {import('./log.js').Log} log @param {string} [label]
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
 * @param {Record<string, string>} files @param {import('./log.js').Log} log @param {string} [label]
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
