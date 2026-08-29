// How Harper names its own root path, read the way Harper reads it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Root path from ~/.harperdb/hdb_boot_properties.file -> settings_path -> rootPath; absolute or null, never throws. */
export function readHarperRootPath(): string | null {
	try {
		const boot = readFileSync(join(homedir(), '.harperdb', 'hdb_boot_properties.file'), 'utf-8');
		// Java-style properties, and Harper indents every line after the first, so the leading whitespace class matters.
		const settingsPath = boot.match(/^[ \t]*settings_path[ \t]*=[ \t]*(.+?)[ \t]*$/m)?.[1];
		if (!settingsPath) return null;
		// rootPath is top level in harper-config.yaml: the one key readable off a single line without a YAML parser.
		const settings = readFileSync(settingsPath, 'utf-8');
		const rootPath = settings.match(/^rootPath[ \t]*:[ \t]*(.+?)[ \t]*(?:#.*)?$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2');
		// Rejects `rootPath: null`, which Harper's own defaultConfig.yaml ships, and anything relative.
		return rootPath && isAbsolute(rootPath) ? rootPath : null;
	} catch {
		return null;
	}
}
