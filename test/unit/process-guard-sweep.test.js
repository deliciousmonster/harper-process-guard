/**
 * The stale-lock sweep.
 *
 * The property that matters most is negative: nothing may be signalled that has not been
 * positively identified. Getting that wrong reproduces the upstream defect with a SIGTERM
 * attached, which is worse than the silent adoption it replaces. So the safety cases spawn
 * real processes that are deliberately not ours, point a lock at them, and assert they live.
 *
 * The second property is that every destructive step revalidates. Between reading a lock and
 * acting on it the recorded process can exit and its pid be reused, or a sibling can write a
 * new lock. `removeIfStill` is exported so that guard can be tested directly rather than by
 * trying to time an interleaving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { importDist, makeTempDir, withTempDir } from '../support/harness.js';

const { sweepStaleLocks, describeSweep, removeIfStill } = await importDist('sweep.js');
const { isAlive, identify, readLock, identificationCanAuthoriseSignal } = await importDist('identity.js');

/** A live child running THIS node binary, so it identifies as `process.execPath`. */
function spawnOwnBinary() {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
	child.unref();
	return child;
}

/** A live child that is emphatically not our binary. */
function spawnForeign() {
	const child = spawn('sleep', ['600'], { stdio: 'ignore' });
	child.unref();
	return child;
}

async function settle(pid) {
	for (let i = 0; i < 200 && !isAlive(pid); i++) await new Promise((r) => setTimeout(r, 10));
}

function writeLock(pidDir, name, pid, version = 12345) {
	fs.mkdirSync(pidDir, { recursive: true });
	fs.writeFileSync(path.join(pidDir, `${name}.pid`), `${pid}\n${version}`);
}

const target = (binaryPath) => [{ name: 'agent', binaryPath }];

/** A pid high enough that nothing holds it, for the "recorded process is gone" case. */
const DEAD_PID = 2147483646;

test('a lock naming a pid nothing holds is removed', () =>
	withTempDir('sweep-dead-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', DEAD_PID);
		const actions = await sweepStaleLocks({ pidDir, targets: target('/nonexistent/agent') });
		assert.deepEqual(actions, [{ name: 'agent', pid: DEAD_PID, action: 'removed-dead' }]);
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), false);
	}));

test('NEGATIVE: a live process that is not our binary is never signalled', async () => {
	const dir = makeTempDir('sweep-foreign-');
	const foreign = spawnForeign();
	try {
		await settle(foreign.pid);
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', foreign.pid);

		const actions = await sweepStaleLocks({ pidDir, targets: target(process.execPath) });

		assert.equal(actions[0].action, 'removed-foreign');
		// The cardinal rule. A sweep that signals here is the upstream defect restated.
		assert.equal(isAlive(foreign.pid), true, 'the sweep signalled a process it had not identified as ours');
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), false, 'the lock is ours and must go');
	} finally {
		try {
			process.kill(foreign.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('an orphan positively identified as ours is stopped and its lock removed', async () => {
	const dir = makeTempDir('sweep-orphan-');
	const orphan = spawnOwnBinary();
	try {
		await settle(orphan.pid);
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', orphan.pid);

		const actions = await sweepStaleLocks({ pidDir, targets: target(process.execPath), stopOrphans: true });

		// Only reachable where the platform's identification cannot be spoofed. On darwin
		// `comm` is argv[0], so the sweep refuses to signal and reports instead.
		const expected = process.platform === 'linux' ? 'stopped-orphan' : 'reported-orphan';
		assert.equal(actions[0].action, expected);
	} finally {
		try {
			process.kill(orphan.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('an unparseable lock is removed rather than left for Harper to guess at', () =>
	withTempDir('sweep-garbage-', async (dir) => {
		const pidDir = path.join(dir, 'pids');
		fs.mkdirSync(pidDir, { recursive: true });
		fs.writeFileSync(path.join(pidDir, 'agent.pid'), 'not a pid');
		const actions = await sweepStaleLocks({ pidDir, targets: target('/nonexistent') });
		assert.deepEqual(actions, [], 'nothing was adjudicated, so nothing is reported');
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), false);
	}));

test('an absent lock produces no action and no error', () =>
	withTempDir('sweep-absent-', async (dir) => {
		const actions = await sweepStaleLocks({ pidDir: path.join(dir, 'pids'), targets: target('/nonexistent') });
		assert.deepEqual(actions, []);
	}));

test('revalidation: a lock rewritten to another pid is left alone', () =>
	withTempDir('sweep-revalidate-', (dir) => {
		const lockPath = path.join(dir, 'agent.pid');
		fs.writeFileSync(lockPath, '111\n1');
		// The sweep adjudicated pid 999; the file now names 111, so something else is managing
		// this name and removing it would delete a live claim.
		assert.equal(removeIfStill(lockPath, 999), false);
		assert.equal(fs.existsSync(lockPath), true, 'a lock that changed under us must survive');
		// The same pid it adjudicated: safe to remove.
		assert.equal(removeIfStill(lockPath, 111), true);
		assert.equal(fs.existsSync(lockPath), false);
	}));

test("'removed-unidentifiable' is not reachable through an unresolved binary any more", async () => {
	const dir = makeTempDir('sweep-unknown-');
	const foreign = spawnForeign();
	try {
		await settle(foreign.pid);
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', foreign.pid);
		// An empty path must be refused, not read as unidentifiable: that reading deletes every live lock on a question never asked.
		const actions = await sweepStaleLocks({ pidDir, targets: target('') });
		assert.equal(actions[0].action, 'skipped-unresolved');
		assert.notEqual(actions[0].action, 'removed-unidentifiable');
		assert.equal(isAlive(foreign.pid), true, 'nothing may be signalled on this path either');
	} finally {
		try {
			process.kill(foreign.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('identify separates ours, not-ours and cannot-tell', () => {
	assert.equal(identify(process.pid, process.execPath), 'match', 'the comparison would be vacuous otherwise');
	assert.equal(identify(process.pid, '/nonexistent/agent'), 'unknown', 'an unresolvable binary tells us nothing');
	assert.equal(identify(DEAD_PID, process.execPath), 'differs', 'a dead pid is not running our binary');
	assert.equal(identify(process.pid, ''), 'unknown');
});

test('isAlive refuses the process-group selectors kill(2) accepts', () => {
	assert.equal(isAlive(0), false, '0 is the caller process group');
	assert.equal(isAlive(-1), false, 'a negative is group -n');
	assert.equal(isAlive(DEAD_PID), false);
	assert.equal(isAlive(process.pid), true);
});

test('readLock reads what Harper writes and rejects what it cannot parse', () =>
	withTempDir('sweep-read-', (dir) => {
		const file = path.join(dir, 'a.pid');
		fs.writeFileSync(file, '964\n834706416');
		assert.deepEqual(readLock(file), { pid: 964, version: 834706416 });
		fs.writeFileSync(file, '964');
		assert.deepEqual(readLock(file), { pid: 964, version: 0 }, 'Harper writes a bare pid when given no version');
		fs.writeFileSync(file, 'garbage');
		assert.equal(readLock(file), null);
		assert.equal(readLock(path.join(dir, 'missing.pid')), null);
	}));

test('every action renders a line naming the pid, and the safe ones say what was not done', () => {
	const lines = describeSweep([
		{ name: 'agent', pid: 1, action: 'removed-dead' },
		{ name: 'agent', pid: 2, action: 'stopped-orphan' },
		{ name: 'agent', pid: 3, action: 'orphan-survived' },
		{ name: 'agent', pid: 4, action: 'removed-foreign' },
		{ name: 'agent', pid: 5, action: 'removed-unidentifiable' },
		{ name: 'agent', pid: 6, action: 'skipped-changed' },
	]);
	assert.equal(lines.length, 6);
	for (const [index, line] of lines.entries()) assert.match(line, new RegExp(`pid ${index + 1}\\b`));
	assert.match(lines[3], /signalled nothing/, 'the foreign case must state what it did NOT do');
	assert.match(lines[4], /signalled nothing/, 'so must the unidentifiable case');
});

/**
 * Four ways a sweep comes to read "orphan" wrongly, grouped because they share a cause:
 * liveness and identity alone cannot distinguish a process this node is about to inherit
 * from one nobody owns.
 */

test('REGRESSION: a live agent whose lock still carries this configuration is kept, not killed', async () => {
	const dir = makeTempDir('sweep-adopt-');
	const running = spawnOwnBinary();
	try {
		await settle(running.pid);
		const pidDir = path.join(dir, 'pids');
		// `harper restart` leaves the old node's children running on purpose so the replacement
		// adopts them, and Harper adopts on a version MATCH. Stopping this process would drop
		// whatever it was carrying, on every restart.
		writeLock(pidDir, 'agent', running.pid, 4242);

		const actions = await sweepStaleLocks({
			pidDir,
			targets: [{ name: 'agent', binaryPath: process.execPath, version: 4242 }],
		});

		assert.equal(actions[0].action, 'kept-for-adoption');
		assert.equal(isAlive(running.pid), true, 'the sweep stopped a process this node was about to adopt');
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), true, 'and its lock must survive for the adoption');
	} finally {
		try {
			process.kill(running.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a live agent whose lock carries a STALE configuration is still stopped', async () => {
	const dir = makeTempDir('sweep-stalecfg-');
	const orphan = spawnOwnBinary();
	try {
		await settle(orphan.pid);
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', orphan.pid, 1111);
		// A different fingerprint means the lock describes a configuration that no longer
		// exists, so Harper would not adopt it either.
		const actions = await sweepStaleLocks({
			pidDir,
			targets: [{ name: 'agent', binaryPath: process.execPath, version: 2222 }],
			stopOrphans: true,
		});
		assert.equal(actions[0].action, process.platform === 'linux' ? 'stopped-orphan' : 'reported-orphan');
	} finally {
		try {
			process.kill(orphan.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('NEGATIVE: an unresolved binary path authorises nothing', async () => {
	const dir = makeTempDir('sweep-unresolved-');
	const foreign = spawnForeign();
	try {
		await settle(foreign.pid);
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', foreign.pid);
		// '' is what a caller passes when resolution failed. Everything would read as
		// unidentifiable and every lock would be removed on the strength of a question that
		// was never asked.
		const actions = await sweepStaleLocks({ pidDir, targets: [{ name: 'agent', binaryPath: '' }] });
		assert.equal(actions[0].action, 'skipped-unresolved');
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), true, 'a lock we could not adjudicate must survive');
		assert.equal(isAlive(foreign.pid), true);
	} finally {
		try {
			process.kill(foreign.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('removeIfStill does not claim a removal that did not happen', () =>
	withTempDir('sweep-unremovable-', (dir) => {
		const sub = path.join(dir, 'ro');
		fs.mkdirSync(sub);
		const lockPath = path.join(sub, 'agent.pid');
		fs.writeFileSync(lockPath, '111\n1');
		fs.chmodSync(sub, 0o555);
		try {
			// Reporting a repair that did not occur is worse than reporting nothing: the caller
			// logs success and the lock is adopted on the next start regardless.
			const claimed = removeIfStill(lockPath, 111);
			if (fs.existsSync(lockPath)) assert.equal(claimed, false, 'a failed unlink was reported as a removal');
		} finally {
			fs.chmodSync(sub, 0o755);
		}
	}));

test('CRITICAL: stopOrphans defaults off, so an orphan is reported and never signalled', async () => {
	const dir = makeTempDir('sweep-noopt-');
	const orphan = spawnOwnBinary();
	try {
		await settle(orphan.pid);
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', orphan.pid, 1111);

		// No stopOrphans. Every serious finding against this module lives in the kill path, so
		// the default must not take it, and Harper's own lock replaces the process anyway on
		// the version mismatch.
		const actions = await sweepStaleLocks({
			pidDir,
			targets: [{ name: 'agent', binaryPath: process.execPath, version: 2222 }],
		});

		assert.equal(actions[0].action, 'reported-orphan');
		assert.equal(isAlive(orphan.pid), true, 'the default signalled a process');
		assert.equal(fs.existsSync(path.join(pidDir, 'agent.pid')), true, 'and left the lock for Harper to resolve');
	} finally {
		try {
			process.kill(orphan.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('NEGATIVE: a platform whose identification is spoofable may not signal even when asked', async () => {
	const dir = makeTempDir('sweep-cap-');
	const orphan = spawnOwnBinary();
	try {
		await settle(orphan.pid);
		const pidDir = path.join(dir, 'pids');
		writeLock(pidDir, 'agent', orphan.pid, 1111);
		const actions = await sweepStaleLocks({
			pidDir,
			targets: [{ name: 'agent', binaryPath: process.execPath, version: 2222 }],
			stopOrphans: true,
		});
		if (identificationCanAuthoriseSignal()) {
			assert.equal(actions[0].action, 'stopped-orphan');
		} else {
			// darwin: `ps -o comm=` is argv[0], so a process can name itself anything. A match
			// is enough to leave something alone and never enough to signal it.
			assert.equal(actions[0].action, 'reported-orphan');
			assert.equal(isAlive(orphan.pid), true);
		}
	} finally {
		try {
			process.kill(orphan.pid, 'SIGKILL');
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test(
	'darwin identification is spoofable, which is why it may not authorise a signal',
	{ skip: process.platform !== 'darwin' },
	async () => {
		// Measured rather than asserted from documentation: argv0 sets what `ps -o comm=` prints.
		// The file has to exist, because identify() resolves the expected path and refuses when
		// it cannot. That is the production case: the agent binary IS on disk, which is exactly
		// the condition under which the spoof works.
		const fake = path.join(makeTempDir('spoof-'), 'datadog-trace-agent');
		fs.copyFileSync('/bin/sleep', fake);
		const child = spawn('/bin/sleep', ['5'], { stdio: 'ignore', argv0: fake });
		child.unref();
		try {
			await settle(child.pid);
			assert.equal(identify(child.pid, fake), 'match', 'this is the spoof: /bin/sleep answering to our name');
			assert.equal(identificationCanAuthoriseSignal(), false, 'so this platform must never signal on a match');
		} finally {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {}
		}
	}
);
