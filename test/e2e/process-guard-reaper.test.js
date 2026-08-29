// The only code that escalates to SIGKILL, so the tests that matter prove what it will NOT signal.
// Its rule is weaker than the sweep's on purpose: with no identification it falls back to the pid it watched start, never one read from a file, or macOS would leak a process on every stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { importDist, makeTempDir, withTempDir } from '../support/harness.js';

const { collectTargets, parseArgs, reapTarget, run } = await importDist('reaper.js');
const { isAlive, identificationCanAuthoriseSignal } = await importDist('identity.js');
const { writeGuardDescriptor, guardDescriptorPath } = await importDist('registry.js');

/** A live child running this node binary, so it is identifiable as process.execPath. */
function spawnOwn() {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
	child.unref();
	return child;
}

/** A live child that ignores SIGTERM, for the escalation path; touches `readyFile` once the handler holds. */
function spawnStubborn(readyFile) {
	const script =
		"process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], ''); " +
		'setInterval(() => {}, 1 << 30)';
	const child = spawn(process.execPath, ['-e', script, readyFile], { stdio: 'ignore' });
	child.unref();
	return child;
}

/** Polls `check` true within ~5s; failing beats proceeding on a premise that never held. */
async function until(check, message) {
	for (let i = 0; i < 500; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.fail(message);
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
		writeGuardDescriptor(dir, { name: 'agent', pidFile, pid: child.pid, binaryPath: process.execPath });
		await reapTarget(opts(), { pidFile, pid: child.pid, binaryPath: process.execPath });
		assert.equal(isAlive(child.pid), false, 'the child outlived its reaping');
		// Removed BEFORE the signal: a file naming a dying process is worse than no file,
		// because a worker that reads it adopts a corpse and never retries.
		assert.equal(fs.existsSync(pidFile), false);
		assert.equal(fs.existsSync(guardDescriptorPath(dir, 'agent')), false, 'the descriptor must go with the lock');
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
	const readyFile = path.join(dir, 'stubborn-ready');
	const child = spawnStubborn(readyFile);
	try {
		// Not merely alive: the SIGTERM handler must hold first, or a still-booting child dies
		// to the SIGTERM and the escalation goes untested whenever that race lands wrong.
		await until(() => fs.existsSync(readyFile), 'the stubborn child never installed its handler');
		const pidFile = path.join(dir, 'agent.pid');
		fs.writeFileSync(pidFile, `${child.pid}\n1`);
		await reapTarget(opts(), { pidFile, pid: child.pid, binaryPath: process.execPath });
		// Polled, not asserted flat: SIGKILL delivery is asynchronous, and the held handler
		// means only the escalation can be the cause of death.
		await until(() => !isAlive(child.pid), 'the SIGKILL escalation did not land');
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
		writeGuardDescriptor(dir, { name: 'agent', pidFile, pid: child.pid, binaryPath: process.execPath });
		// `harper restart` forks a replacement and exits the old main. Stopping the children
		// there would drop whatever they were carrying, on every restart.
		fs.writeFileSync(hdbPidFile, String(replacement.pid));

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile, pid: child.pid, binaryPath: process.execPath }],
			pidDir: dir,
			hdbPidFile,
			restartGraceMs: 3000,
		});
		process.kill(watched.pid, 'SIGKILL');
		await done;

		assert.equal(isAlive(child.pid), true, 'the child was reaped despite a replacement taking over');
		assert.equal(fs.existsSync(pidFile), true, 'and its lock must survive for the adoption');
		assert.equal(
			fs.existsSync(guardDescriptorPath(dir, 'agent')),
			true,
			"and so must its descriptor, or the replacement's reaper starts blind"
		);
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

test('CRITICAL: a caller that joined the reaper gets its processes reaped through descriptors, beside the argv set', async () => {
	const dir = makeTempDir('reap-joined-');
	const watched = spawnOwn();
	const first = spawnOwn();
	const second = spawnOwn();
	try {
		await settle(watched.pid);
		await settle(first.pid);
		await settle(second.pid);
		const firstLock = path.join(dir, 'first.pid');
		const secondLock = path.join(dir, 'second.pid');
		fs.writeFileSync(firstLock, `${first.pid}\n1`);
		fs.writeFileSync(secondLock, `${second.pid}\n1`);
		// The winner's launch seeds argv with ITS processes only. The second caller lost the
		// reaper's PID lock and joined, so its process exists solely as a descriptor on disk.
		writeGuardDescriptor(dir, { name: 'first', pidFile: firstLock, pid: first.pid, binaryPath: process.execPath });
		writeGuardDescriptor(dir, { name: 'second', pidFile: secondLock, pid: second.pid, binaryPath: process.execPath });

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile: firstLock, pid: first.pid, binaryPath: process.execPath }],
			pidDir: dir,
			restartGraceMs: 50,
		});
		process.kill(watched.pid, 'SIGKILL');
		await done;

		assert.equal(isAlive(first.pid), false, "the argv caller's process outlived the reaping");
		assert.equal(
			isAlive(second.pid),
			false,
			"the joined caller's process outlived the reaping: argv was trusted alone"
		);
		for (const [name, lock] of [
			['first', firstLock],
			['second', secondLock],
		]) {
			assert.equal(fs.existsSync(lock), false, `${name}.pid survived`);
			assert.equal(fs.existsSync(guardDescriptorPath(dir, name)), false, `${name}'s descriptor survived`);
		}
	} finally {
		for (const p of [watched.pid, first.pid, second.pid]) {
			try {
				process.kill(p, 'SIGKILL');
			} catch {}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a zombie answers kill(pid, 0) yet reads as dead, so a corpse is neither adopted nor waited on', async () => {
	// sh backgrounds a short sleep and execs a long one over itself; the short one's exit then
	// has no wait()er, which is the definition of a zombie.
	const parent = spawn('sh', ['-c', 'sleep 0.2 & echo $!; exec sleep 600'], {
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	try {
		const zombiePid = Number.parseInt(
			await new Promise((resolve, reject) => {
				let out = '';
				parent.stdout.on('data', (chunk) => {
					out += chunk;
					if (out.includes('\n')) resolve(out);
				});
				parent.on('error', reject);
			}),
			10
		);
		assert.ok(Number.isInteger(zombiePid) && zombiePid > 0, `sh reported no background pid`);
		await until(() => !isAlive(zombiePid), 'the zombie kept reading as alive');
		// The blind spot this closes: the pid is still held (its parent never reaped it), so the
		// bare kill(pid, 0) probe says yes while nothing runs behind it.
		assert.doesNotThrow(() => process.kill(zombiePid, 0), 'not a zombie: the pid was fully released');
	} finally {
		try {
			process.kill(parent.pid, 'SIGKILL');
		} catch {}
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

test('--pid-dir reaches the options, and an argv-only invocation still parses without one', () => {
	const parsed = parseArgs(['--harper-pid', '7', '--pid-dir', '/some/pids']);
	assert.equal(parsed.pidDir, '/some/pids');
	// The pre-descriptor command line, which an updated reaper must go on serving.
	assert.equal(parseArgs(['--harper-pid', '7']).pidDir, undefined);
});

test('targets are collected from descriptors on top of argv, and from argv alone without a pid dir', () =>
	withTempDir('reap-collect-', (dir) => {
		const argvTarget = { pidFile: path.join(dir, 'a.pid'), pid: 10, binaryPath: '/bin/a' };
		// The same lock in argv and on disk: the descriptor wins, being the later record.
		writeGuardDescriptor(dir, { name: 'a', pidFile: argvTarget.pidFile, pid: 11, binaryPath: '/bin/a2' });
		writeGuardDescriptor(dir, { name: 'b', pidFile: path.join(dir, 'b.pid'), pid: 20, binaryPath: '/bin/b' });
		fs.writeFileSync(path.join(dir, 'c.guard.json'), 'torn{', 'utf-8');

		const merged = collectTargets({ harperPid: 1, targets: [argvTarget], restartGraceMs: 50, pidDir: dir });
		assert.deepEqual(
			merged.toSorted((x, y) => x.pidFile.localeCompare(y.pidFile)),
			[
				{ pidFile: argvTarget.pidFile, pid: 11, binaryPath: '/bin/a2' },
				{ pidFile: path.join(dir, 'b.pid'), pid: 20, binaryPath: '/bin/b' },
			]
		);
		// No pidDir is the old launch spelling; the argv seed must keep working verbatim.
		assert.deepEqual(collectTargets({ harperPid: 1, targets: [argvTarget], restartGraceMs: 50 }), [argvTarget]);
	}));

// Liveness misreadings the reaper must not make: firing while the node lives, accepting a dead
// pid as a replacement, reading a containerised Harper as gone.

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
		writeGuardDescriptor(dir, { name: 'agent', pidFile, pid: 2147483646, binaryPath: process.execPath });

		const done = run({
			harperPid: watched.pid,
			targets: [{ pidFile, pid: 2147483646, binaryPath: process.execPath }],
			pidDir: dir,
			restartGraceMs: 50,
		});
		process.kill(watched.pid, 'SIGKILL');
		await done;

		assert.equal(fs.existsSync(pidFile), false, 'the stale lock was left for the next start to adopt');
		assert.equal(
			fs.existsSync(guardDescriptorPath(dir, 'agent')),
			false,
			'nothing-to-stop must still clear the descriptor'
		);
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
