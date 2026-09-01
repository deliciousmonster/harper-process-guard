// What survives of a managed process outside the thread that launched it: a descriptor beside its PID lock, read by the reaper at reap time. Argv reaches only the reaper that wins its lock; these files reach the one that is running.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

/** `.guard.json`, not `.pid`: the pids/ directory is shared with Harper's own locks, and the suffix is what separates this package's records from them. */
export const GUARD_DESCRIPTOR_SUFFIX = '.guard.json';

/** One managed process as recorded on disk. The same fields as a reap target, plus the name that keys the file. */
export interface GuardDescriptor {
	/** Harper's spawn `name`, which is also the descriptor filename without the suffix. */
	readonly name: string;
	/** The lock file naming this process. */
	readonly pidFile: string;
	/** The pid recorded by the thread that watched the spawn, or joined it through the lock. */
	readonly pid: number;
	/** Absolute path of the binary, so the process can be identified before it is signalled. */
	readonly binaryPath: string;
	/** The leading arguments it was started with; without them every `node <script>` process on this node identifies as the same one. Absent from a record written before this field existed. */
	readonly args?: readonly string[] | undefined;
}

export function guardDescriptorPath(pidDir: string, name: string): string {
	return join(pidDir, `${name}${GUARD_DESCRIPTOR_SUFFIX}`);
}

/** The descriptor beside a lock, by spelling alone: `<name>.pid` and `<name>.guard.json` share a directory and a stem. */
export function guardDescriptorPathForLock(pidFile: string): string {
	return pidFile.replace(/\.pid$/, '') + GUARD_DESCRIPTOR_SUFFIX;
}

/** Published via temp-and-rename so no reader ever meets a torn descriptor. */
export function writeGuardDescriptor(pidDir: string, descriptor: GuardDescriptor): void {
	mkdirSync(pidDir, { recursive: true });
	const path = guardDescriptorPath(pidDir, descriptor.name);
	const temp = `${path}.${process.pid}.${threadId}.tmp`;
	writeFileSync(temp, JSON.stringify(descriptor), 'utf-8');
	renameSync(temp, path);
}

/** Every readable descriptor under `pidDir`; one that cannot be read names nothing a caller may act on. */
export function readGuardDescriptors(pidDir: string): GuardDescriptor[] {
	let entries: string[];
	try {
		entries = readdirSync(pidDir);
	} catch {
		return [];
	}
	const descriptors: GuardDescriptor[] = [];
	for (const entry of entries.filter((name) => name.endsWith(GUARD_DESCRIPTOR_SUFFIX))) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(pidDir, entry), 'utf-8'));
			if (typeof parsed !== 'object' || parsed === null) continue;
			const { name, pidFile, pid, binaryPath, ...rest } = parsed as Record<string, unknown>;
			if (typeof name !== 'string' || typeof pidFile !== 'string') continue;
			if (typeof pid !== 'number' || !Number.isInteger(pid)) continue;
			// Absent rather than empty when nothing was recorded, so a descriptor written before this
			// field existed reads back as the record it is.
			const args =
				Array.isArray(rest.args) && rest.args.every((a: unknown) => typeof a === 'string') ? rest.args : null;
			descriptors.push({
				name,
				pidFile,
				pid,
				binaryPath: typeof binaryPath === 'string' ? binaryPath : '',
				...(args && args.length > 0 ? { args } : {}),
			});
		} catch {
			// Absent, half-written or not JSON: dropped rather than guessed at.
		}
	}
	return descriptors;
}
