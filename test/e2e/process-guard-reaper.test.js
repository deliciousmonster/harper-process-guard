/**
 * The reaper the guard owns, against real processes.
 *
 * It closes the lifetime `bootstrap()` opens, and it is the most dangerous thing in the module:
 * it is the only part that escalates to SIGKILL. So the tests that matter are the ones proving
 * what it will NOT signal.
 *
 * Its rule is deliberately weaker than the sweep's, and that is the point of the fallback test
 * below. Requiring positive identification everywhere would make it refuse to act on macOS and
 * leak a process on every stop, which is worse than the reuse it would avoid. So where the
 * platform cannot identify a process it falls back to the one pid it has first-hand knowledge
 * of, the pid it watched start, and never to a pid read from a file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { importDist, makeTempDir, withTempDir } from '../support/harness.js';

const { parseArgs, reapTarget, run } = await importDist('reaper.js');
const { isAlive, identificationCanAuthoriseSignal } = await importDist('identity.js');

/** A live child running this node binary, so it is identifiable as process.execPath. */
function spawnOwn() {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
	child.unref();
	return child;
}

/** A live child that ignores SIGTERM, for the escalation path. */
function spawnStubborn() {
	const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30)"], {
		stdio: 'ignore',
	});
	child.unref();
	return child;
}

function spawnForeign() {
	const child = spawn('sleep', ['600'], { stdio: 'ignore' });
	child.unref();
	return child;
}

async function settle(pid) {
	for (let i = 0; i < 200 && !isAlive(pid); i++) await new Promise((r) => setTimeout(r, 10));
}

const opts = (over = {}) => ({ harperPid: process.pid, targets: [], restartGraceMs: 50, ...over });

test('an identified child is stopped and its lock removed', async () => {
	const dir = makeTempDir('reap-basic-');
	const child = spawnOwn();
	try {
		await settle(child.pid);
		const pidFile = path.join(dir, 'agent.pid');
		fs.writeFileSync(pidFile, `${child.pid}\n1`);
		await reapTarget(opts(), { pidFile, pid: child.pid, binaryPath: process.execPath });
		assert.equal(isAlive(child.pid), false, 'the child outlived its reaping');
		// Removed BEFORE the signal: a file naming a dying process is worse than no file,
		// because a worker that reads it adopts a corpse and never retries.
		assert.equal(fs.existsSync(pidFile), false);
	} finally {
		try {
			process.kill(child.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('NEGATIVE: a pid read from the file that is not the watched one is never signalled', async () => {
	const dir = makeTempDir('reap-file-');
	const foreign = spawnForeign();
	const watched = spawnOwn();
	try {
		await settle(foreign.pid);
		await settle(watched.pid);
		const pidFile = path.join(dir, 'agent.pid');
		// The file names something else entirely, which is what pid reuse produces: a container
		// restarts its pid namespace at 1 and children land on the same small numbers.
		fs.writeFileSync(pidFile, `${foreign.pid}\n1`);

		await reapTarget(opts(), { pidFile, pid: watched.pid, binaryPath: process.execPath });

		assert.equal(isAlive(foreign.pid), true, 'the reaper signalled a process it had no grounds to name');
		assert.equal(isAlive(watched.pid), false, 'and it must still stop the one it watched');
	} finally {
		for (const p of [foreign.pid, watched.pid]) {
			try {
				process.kill(p, 'SIGKILL');
			} catch {}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('NEGATIVE: where the platform can identify, a mismatch is refused even for the watched pid', async () => {
	const dir = makeTempDir('reap-mismatch-');
	const foreign = spawnForeign();
	try {
		await settle(foreign.pid);
		const pidFile = path.join(dir, 'agent.pid');
		fs.writeFileSync(pidFile, `${foreign.pid}\n1`);
		// Watched pid and file agree, and both are wrong: this is not our binary.
		await reapTarget(opts(), { pidFile, pid: foreign.pid, binaryPath: process.execPath });

		if (identificationCanAuthoriseSignal()) {
			assert.equal(isAlive(foreign.pid), true, 'identification was available and the mismatch was signalled anyway');
		} else {
			// macOS cannot identify, so the watched-pid fallback applies and this IS signalled.
			// Stated rather than skipped, because it is the cost of the fallback and worth seeing.
			assert.equal(isAlive(foreign.pid), false);
		}
	} finally {
		try {
			process.kill(foreign.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a child that ignores SIGTERM is escalated to SIGKILL', async () => {
	const dir = makeTempDir('reap-stubborn-');
	const child = spawnStubborn();
	try {
		await settle(child.pid);
		const pidFile = path.join(dir, 'agent.pid');
		fs.writeFileSync(pidFile, `${child.pid}\n1`);
		await reapTarget(opts(), { pidFile, pid: child.pid, binaryPath: process.execPath });
		// Escalation is confined to processes identified above, which is what makes it defensible.
		assert.equal(isAlive(child.pid), false);
	} finally {
		try {
			process.kill(child.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a replacement inside the grace window keeps the children for it to adopt', async () => {
	const dir = makeTempDir('reap-handover-');
	const watched = spawnOwn();
	const child = spawnOwn();
	const replacement = spawnOwn();
	try {
		await settle(watched.pid);
		await settle(child.pid);
		await settle(replacement.pid);
		const pidFile = path.join(dir, 'agent.pid');
		const hdbPidFile = path.join(dir, 'hdb.pid');
		fs.writeFileSync(pidFile, `${child.pid}\n1`);
		// `harper restart` forks a replacement and exits the old main. Stopping the children
		// there would drop whatever they were carrying, on every restart.
		fs.writeFileSync(hdbPidFile, String(replacement.pid));

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile, pid: child.pid, binaryPath: process.execPath }],
			hdbPidFile,
			restartGraceMs: 3000,
		});
		process.kill(watched.pid, 'SIGKILL');
		await done;

		assert.equal(isAlive(child.pid), true, 'the child was reaped despite a replacement taking over');
		assert.equal(fs.existsSync(pidFile), true, 'and its lock must survive for the adoption');
	} finally {
		for (const p of [watched.pid, child.pid, replacement.pid]) {
			try {
				process.kill(p, 'SIGKILL');
			} catch {}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('no replacement inside the window means the children are stopped', async () => {
	const dir = makeTempDir('reap-noreplace-');
	const watched = spawnOwn();
	const child = spawnOwn();
	try {
		await settle(watched.pid);
		await settle(child.pid);
		const pidFile = path.join(dir, 'agent.pid');
		fs.writeFileSync(pidFile, `${child.pid}\n1`);

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile, pid: child.pid, binaryPath: process.execPath }],
			hdbPidFile: path.join(dir, 'hdb.pid'),
			restartGraceMs: 200,
		});
		process.kill(watched.pid, 'SIGKILL');
		await done;

		assert.equal(isAlive(child.pid), false);
	} finally {
		for (const p of [watched.pid, child.pid]) {
			try {
				process.kill(p, 'SIGKILL');
			} catch {}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('the target descriptor survives paths containing a colon', () =>
	withTempDir('reap-args-', (dir) => {
		// The previous spelling was `pidFile:pid` split on the last colon, which any path
		// containing one breaks, and a binary path is now carried too.
		const weird = path.join(dir, 'has:colon', 'agent.pid');
		const encoded = Buffer.from(JSON.stringify({ pidFile: weird, pid: 42, binaryPath: '/x:y/agent' })).toString(
			'base64'
		);
		const parsed = parseArgs(['--harper-pid', '7', '--restart-grace-ms', '900', '--target', encoded]);
		assert.equal(parsed.harperPid, 7);
		assert.equal(parsed.restartGraceMs, 900);
		assert.deepEqual(parsed.targets, [{ pidFile: weird, pid: 42, binaryPath: '/x:y/agent' }]);
	}));

test('a descriptor that cannot be read is dropped rather than guessed at', () => {
	const parsed = parseArgs(['--harper-pid', '7', '--target', 'not-base64-json', '--target', '']);
	assert.deepEqual(parsed.targets, [], 'a target it cannot read names nothing it may act on');
});

/**
 * The liveness misreadings a reaper must not make: firing while the node is alive, accepting
 * a dead pid as a replacement, and reading a containerised Harper as already gone.
 */

test('NEGATIVE: nothing is stopped while the watched process is still alive', async () => {
	const dir = makeTempDir('reap-alive-');
	const watched = spawnOwn();
	const child = spawnOwn();
	try {
		await settle(watched.pid);
		await settle(child.pid);
		const pidFile = path.join(dir, 'agent.pid');
		fs.writeFileSync(pidFile, `${child.pid}\n1`);

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile, pid: child.pid, binaryPath: process.execPath }],
			restartGraceMs: 50,
		});
		// Long enough to have polled several times and reaped if it were going to.
		await new Promise((r) => setTimeout(r, 2500));
		assert.equal(isAlive(child.pid), true, 'the reaper fired while the node it watches was alive');
		assert.equal(fs.existsSync(pidFile), true);

		process.kill(watched.pid, 'SIGKILL');
		await done;
	} finally {
		for (const p of [watched.pid, child.pid]) {
			try {
				process.kill(p, 'SIGKILL');
			} catch {}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a stale hdb.pid does not pass for a replacement', async () => {
	const dir = makeTempDir('reap-stalehdb-');
	const watched = spawnOwn();
	const child = spawnOwn();
	try {
		await settle(watched.pid);
		await settle(child.pid);
		const pidFile = path.join(dir, 'agent.pid');
		const hdbPidFile = path.join(dir, 'hdb.pid');
		fs.writeFileSync(pidFile, `${child.pid}\n1`);
		// A file left by a node that is gone. Reading it as a live replacement would leave the
		// children running with nothing supervising them.
		fs.writeFileSync(hdbPidFile, '2147483646');

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile, pid: child.pid, binaryPath: process.execPath }],
			hdbPidFile,
			restartGraceMs: 200,
		});
		process.kill(watched.pid, 'SIGKILL');
		await done;

		assert.equal(isAlive(child.pid), false, 'a dead pid in hdb.pid was accepted as a replacement');
	} finally {
		for (const p of [watched.pid, child.pid]) {
			try {
				process.kill(p, 'SIGKILL');
			} catch {}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a lock naming a process that is already gone is not an error', async () => {
	const dir = makeTempDir('reap-gone-');
	const watched = spawnOwn();
	try {
		await settle(watched.pid);
		const pidFile = path.join(dir, 'agent.pid');
		fs.writeFileSync(pidFile, '2147483646\n1');

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile, pid: 2147483646, binaryPath: process.execPath }],
			restartGraceMs: 50,
		});
		process.kill(watched.pid, 'SIGKILL');
		await done;

		assert.equal(fs.existsSync(pidFile), false, 'the stale lock was left for the next start to adopt');
	} finally {
		try {
			process.kill(watched.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('NEGATIVE: a Harper running as pid 1 is not read as dead', () => {
	// A containerised Harper IS pid 1; only 0 and negatives are kill(2) group selectors, so a `pid <= 1` guard reaps a containerised node on sight.
	assert.equal(isAlive(1), true, 'pid 1 was read as dead, which reaps a containerised node on sight');
	assert.equal(isAlive(0), false, '0 is the caller process group');
	assert.equal(isAlive(-1), false, 'a negative is group -n');
});
