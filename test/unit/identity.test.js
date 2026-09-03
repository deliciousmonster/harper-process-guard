// @ts-check
// Identification decides what may be signalled, so every case here is about what the guard is allowed
// to conclude, not about what it happens to read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { argvOf, compareArgv, identify, isAlive } from '../../src/identity.js';
import { deadPid, fixture, pidOf, readyLine, waitFor, withSpawn } from '../support/harness.js';

// Harper's real vm-current-context sandbox substitutes node:child_process with a stub exposing only
// these five names; execFileSync silently isn't one, and a real Harper node refuses to load the
// component that imports it rather than merely doing without it.
const HARPER_CHILD_PROCESS_STUB = new Set(['exec', 'execFile', 'fork', 'spawn', 'execSync']);

test('identity.js imports only what a real Harper node actually gives it from node:child_process', () => {
	const source = fs.readFileSync(new URL('../../src/identity.js', import.meta.url), 'utf-8');
	const imported = source.match(/import \{ ([^}]+) \} from 'node:child_process';/)?.[1];
	assert.ok(imported, 'expected a named import from node:child_process');
	for (const name of imported.split(',').map((n) => n.trim())) {
		assert.ok(HARPER_CHILD_PROCESS_STUB.has(name), `'${name}' is not in Harper's constrained child_process`);
	}
});

test('pid 1 reads as alive, so a containerised host is not reaped on sight', () => {
	// Inside a container the host process IS pid 1. A guard that treats 1 as an invalid pid stops it.
	assert.equal(isAlive(1), true);
});

test('the pids that are not pids read as dead, because kill(2) reads them as process groups', () => {
	assert.equal(isAlive(0), false, 'pid 0 is the caller’s own process group');
	assert.equal(isAlive(-1), false, 'a negative is group -n');
	assert.equal(isAlive(1.5), false);
	assert.equal(isAlive(Number.NaN), false);
});

test('a pid nothing holds reads as dead', async () => {
	assert.equal(isAlive(await deadPid()), false);
});

test('two node scripts are told apart by argv, which is the only thing that separates them', () =>
	withSpawn(async ({ spawn }) => {
		// Both run the same executable: /proc/<pid>/exe resolves to the interpreter for each, so an
		// identification by executable calls these one process. Only the command line separates them.
		const first = [process.execPath, fixture('idle.js'), 'alpha'];
		const second = [process.execPath, fixture('idle.js'), 'beta'];
		const a = spawn(process.execPath, first.slice(1), { stdio: 'ignore' });
		const b = spawn(process.execPath, second.slice(1), { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(a)) !== null && argvOf(pidOf(b)) !== null, 'both children to appear');

		assert.equal(identify(pidOf(a), first), 'match');
		assert.equal(identify(pidOf(b), second), 'match');
		assert.equal(identify(pidOf(a), second), 'differs');
		assert.equal(identify(pidOf(b), first), 'differs');
		// The same executable for both, which is exactly why it identifies nothing.
		assert.equal(argvOf(pidOf(a))?.[0], argvOf(pidOf(b))?.[0]);
	}));

test('a leading run matches, and pinning more of the command line can only narrow the verdict', () =>
	withSpawn(async ({ spawn }) => {
		const argv = [process.execPath, fixture('idle.js'), 'pinned', '--extra'];
		const child = spawn(process.execPath, argv.slice(1), { stdio: 'ignore' });
		await waitFor(() => argvOf(pidOf(child)) !== null, 'the child to appear');

		assert.equal(identify(pidOf(child), argv.slice(0, 2)), 'match', 'a prefix must match');
		assert.equal(identify(pidOf(child), argv), 'match', 'the whole vector must match');
		assert.equal(identify(pidOf(child), [...argv, 'more']), 'differs', 'a longer expectation cannot match');
	}));

test('an empty expectation identifies nothing, so a lock with no recorded argv is never signalled', () => {
	// The reaper reads argv off the lock. Were this 'match', a foreign pid file with no record would
	// name a process the reaper then killed.
	assert.equal(compareArgv(['/bin/anything'], []), 'unknown');
	assert.equal(identify(process.pid, []), 'unknown');
});

test('a command line nothing can read is "cannot tell", never "not ours"', () => {
	assert.equal(compareArgv(null, ['/bin/thing']), 'unknown');
});

test('a matching prefix must end on an argument boundary', () => {
	assert.equal(compareArgv(['/bin/thing', '--config'], ['/bin/thing', '--conf']), 'differs');
	assert.equal(compareArgv(['/bin/thing', '--conf', 'x'], ['/bin/thing', '--conf']), 'match');
});

test('a dead pid identifies as something else, so nothing acts on it as though it were still there', async () => {
	assert.equal(identify(await deadPid(), [process.execPath]), 'differs');
});

test('a zombie is not alive: it holds its pid and answers kill(pid, 0), but runs nothing', async () => {
	// `exec` replaces the shell, so the child it backgrounded is inherited by a process that never
	// waits on it. That corpse is exactly what a non-reaping init leaves behind in a container.
	await withSpawn(async ({ spawn }) => {
		const parent = spawn('/bin/sh', ['-c', 'sleep 0.05 & echo $! ; exec sleep 30'], {
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const printed = await readyLine(parent);
		const zombie = Number(printed);
		assert.ok(Number.isInteger(zombie) && zombie > 0, `the shell printed no pid: ${printed}`);

		await waitFor(() => !isAlive(zombie), 'the backgrounded process to die and stay unreaped');
		// Still a pid nobody has released: kill(pid, 0) succeeds where isAlive() does not.
		let holdsPid = true;
		try {
			process.kill(zombie, 0);
		} catch {
			holdsPid = false;
		}
		assert.equal(holdsPid, true, 'the corpse was reaped before it could be observed');
		assert.equal(isAlive(zombie), false);
	});
});
