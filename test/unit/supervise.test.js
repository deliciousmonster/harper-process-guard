// @ts-check
// The four defects green unit suites missed: a joiner that supervises nothing, a death nothing
// restarts, a joiner reporting a dead process as healthy, and a process nobody stops.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { argvOf, isAlive } from '../../src/identity.js';
import { lockPath, readLock } from '../../src/lock.js';
import { superviseProcess, watchPid } from '../../src/supervise.js';
import { context, fixture, pidOf, seedLock, waitFor, withSpawn, withTempDir } from '../support/harness.js';

/** @param {string} name @param {string} script @param {string[]} [args] @returns {import('../../src/supervise.js').Descriptor} */
function descriptorFor(name, script, args = []) {
	const binaryPath = process.execPath;
	const all = [fixture(script), ...args];
	return { name, title: name, binaryPath, args: all, argv: [binaryPath, ...all], spawnOptions: { stdio: 'ignore' } };
}

/**
 * A process running outside supervision, with a lock naming it, which is what a thread that lost the
 * race meets: something already running that it did not start.
 *
 * @param {string} dir @param {import('../../src/supervise.js').Spawn} spawn @param {ReturnType<typeof descriptorFor>} descriptor
 */
async function alreadyRunning(dir, spawn, descriptor) {
	const child = spawn(descriptor.binaryPath, [...descriptor.args], { stdio: 'ignore' });
	await waitFor(() => argvOf(pidOf(child)) !== null, 'the running process to appear in the process table');
	seedLock(lockPath(dir, descriptor.name), { pid: pidOf(child), version: 1, argv: descriptor.argv });
	return child;
}

test('the thread that wins starts the process and records its pid on the lock', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptorFor('one', 'idle.js'));
				assert.equal(state.started, true);
				assert.equal(state.adopted, false);
				assert.equal(calls.length, 1);
				assert.equal(readLock(lockPath(dir, 'one'))?.pid, state.pid);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a second thread joins that process instead of starting a second one', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			try {
				const owner = await superviseProcess(ctx, descriptorFor('one', 'idle.js'));
				const joiner = await superviseProcess(ctx, descriptorFor('one', 'idle.js'));
				// One process on this node, however many threads reached the call.
				assert.equal(calls.length, 1);
				assert.equal(joiner.adopted, true);
				assert.equal(joiner.started, true);
				assert.equal(joiner.pid, owner.pid);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('an owner and a joiner watching one crash between them start one replacement, not two', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			try {
				const owner = await superviseProcess(ctx, descriptorFor('shared', 'idle.js'));
				const joiner = await superviseProcess(ctx, descriptorFor('shared', 'idle.js'));
				assert.equal(calls.length, 1);

				process.kill(/** @type {number} */ (owner.pid), 'SIGKILL');
				await waitFor(() => calls.length > 1, 'a replacement to be started');
				await new Promise((resolve) => setTimeout(resolve, 250));

				// Both threads answer the same death, and the lock is what keeps that to one process.
				assert.equal(calls.length, 2, `${calls.length} starts answered one death`);
				assert.equal(joiner.pid, owner.pid, 'the two threads ended up on different processes');
				assert.equal(isAlive(/** @type {number} */ (owner.pid)), true);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a thread that only joined still sees the death, so it stops reporting a corpse as healthy', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const ctx = context(dir, spawn);
			const descriptor = descriptorFor('joined', 'idle.js');
			try {
				const running = await alreadyRunning(dir, spawn, descriptor);
				const state = await superviseProcess(ctx, descriptor);
				assert.equal(state.adopted, true);
				assert.equal(state.exited, false);

				running.kill('SIGKILL');
				await waitFor(() => state.exited, 'the joiner to notice the death it did not cause');
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a death nobody owns is restarted by whichever thread saw it', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			const descriptor = descriptorFor('ownerless', 'idle.js');
			try {
				// The lock outlives its process and no thread here started it, so nothing else will answer.
				const running = await alreadyRunning(dir, spawn, descriptor);
				const state = await superviseProcess(ctx, descriptor);
				const before = calls.length;

				running.kill('SIGKILL');
				await waitFor(() => calls.length > before, 'a replacement to be started');
				await waitFor(() => state.started && state.pid !== pidOf(running), 'the state to name the replacement');
				assert.equal(isAlive(/** @type {number} */ (state.pid)), true);
				assert.equal(readLock(lockPath(dir, 'ownerless'))?.pid, state.pid);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a death whose lock is already gone was answered by someone else, so no replacement is started', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			const descriptor = descriptorFor('answered', 'idle.js');
			try {
				const running = await alreadyRunning(dir, spawn, descriptor);
				const state = await superviseProcess(ctx, descriptor);
				const before = calls.length;

				// The lock goes first: that is how a thread that only joined tells a death someone has
				// already dealt with from one nothing on this node owns.
				fs.unlinkSync(lockPath(dir, 'answered'));
				running.kill('SIGKILL');
				await waitFor(() => state.exited, 'the joiner to notice the death');
				await new Promise((resolve) => setTimeout(resolve, 150));

				assert.equal(calls.length, before, 'a joiner started a replacement for a death already answered');
				assert.match(ctx.log.lines.info.join('\n'), /its lock with it/);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a process that crashes while the host keeps running is restarted', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptorFor('crashy', 'quits.js', ['3', '30']));
				await waitFor(() => calls.length >= 3, 'the crash to be answered more than once');
				assert.ok(state.restarts >= 2, `restarts stalled at ${state.restarts}`);
				assert.match(ctx.log.lines.warn.join('\n'), /exit code 3/);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a clean exit is a shutdown, so it is not restarted and the lock goes', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptorFor('clean', 'quits.js', ['0', '20']));
				await waitFor(() => state.exited, 'the clean exit');
				await new Promise((resolve) => setTimeout(resolve, 150));

				assert.equal(calls.length, 1, 'a deliberate shutdown was restarted');
				assert.equal(fs.existsSync(lockPath(dir, 'clean')), false, 'the lock outlived a deliberate shutdown');
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a lock-write failure while answering a deliberate exit is reported, never an unhandled rejection', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const ctx = context(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptorFor('locked-out', 'quits.js', ['0', '50']));
				assert.equal(state.started, true);

				// Write-proofed only once the start's own commit has already landed: it is releaseLock's gate
				// write, made when the process answers its exit, that this test needs to fail.
				fs.chmodSync(dir, 0o500);
				try {
					await waitFor(() => state.error !== undefined, 'the release failure to be reported on the state');
					assert.match(state.error ?? '', /the locked-out lock could not be released after a deliberate stop/);
					assert.match(ctx.log.lines.error.join('\n'), /could not be released after a deliberate stop/);
				} finally {
					fs.chmodSync(dir, 0o700);
				}
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a stop signal is a shutdown too, and is not fought', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			try {
				const state = await superviseProcess(ctx, descriptorFor('stopped', 'idle.js'));
				process.kill(/** @type {number} */ (state.pid), 'SIGTERM');
				await waitFor(() => state.exited, 'the SIGTERM to land');
				await new Promise((resolve) => setTimeout(resolve, 150));

				assert.equal(calls.length, 1);
				assert.equal(fs.existsSync(lockPath(dir, 'stopped')), false);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a child this thread spawned records its exit code and signal on the state', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// restartMax: 0 so the state is read before a replacement's own exit could overwrite it.
			const ctx = context(dir, spawn, {
				tuning: { deathPollMs: 20, restartMax: 0, restartBaseMs: 5 },
			});
			try {
				const state = await superviseProcess(ctx, descriptorFor('signalled', 'idle.js'));
				process.kill(/** @type {number} */ (state.pid), 'SIGKILL');
				await waitFor(() => state.exited, 'the SIGKILL to land');

				assert.equal(state.signal, 'SIGKILL');
				assert.equal(state.code, undefined);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('restarts are capped, and the report says what is missing from the node', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn, {
				tuning: { deathPollMs: 20, restartMax: 2, restartBaseMs: 5 },
			});
			try {
				const state = await superviseProcess(ctx, descriptorFor('doomed', 'quits.js', ['9', '10']));
				await waitFor(() => state.error !== undefined, 'the cap to be reached');
				assert.match(state.error ?? '', /died 3 times \(exit code 9\); not restarting it again/);
				await new Promise((resolve) => setTimeout(resolve, 150));
				assert.equal(calls.length, 3, `the cap let ${calls.length} starts through`);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a binary that is not there is reported and its lock is not left behind', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn);
			const descriptor = { ...descriptorFor('absent', 'idle.js'), binaryPath: `${dir}/not-a-binary` };
			const state = await superviseProcess(ctx, { ...descriptor, argv: [descriptor.binaryPath] });

			assert.equal(state.started, false);
			assert.match(state.error ?? '', /not-a-binary is missing/);
			assert.equal(calls.length, 0);
			assert.equal(fs.existsSync(lockPath(dir, 'absent')), false, 'a lock was left for a process that never started');
		})
	));

test('a spawn that fails after preflight passed is answered, not reported as a start', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn }) => {
			// Present and executable, so preflight passes, and unrunnable, so spawn fails the only way it can
			// once it has returned: asynchronously, which is also how ENOEXEC and EAGAIN arrive.
			const wrapper = path.join(dir, 'unrunnable.sh');
			fs.writeFileSync(wrapper, '#!/nonexistent/interpreter\necho started\n', 'utf-8');
			fs.chmodSync(wrapper, 0o755);
			const ctx = context(dir, spawn);
			try {
				const state = await superviseProcess(ctx, {
					name: 'unrunnable',
					title: 'unrunnable thing',
					binaryPath: wrapper,
					args: [],
					argv: [wrapper],
					spawnOptions: { stdio: 'ignore' },
				});

				assert.equal(state.started, false, 'a spawn that never ran was reported as started');
				assert.equal(state.pid, undefined);
				assert.match(state.error ?? '', /the unrunnable thing failed to start: spawn .*unrunnable\.sh ENOENT/);
				assert.deepEqual(ctx.report, [state.error], 'the caller was told nothing on the first attempt');
				assert.equal(ctx.log.lines.error.length, 1, `one failure was logged as ${ctx.log.lines.error.length} lines`);
				assert.equal(
					fs.existsSync(lockPath(dir, 'unrunnable')),
					false,
					'the claim was left behind, pinning the lock at pid 0 under a live host'
				);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

// A host's wrapper is not a ChildProcess and owes this package no 'error' event, so awaiting one is a
// promise only a real child keeps. Both shapes below hung or threw out of a startup path holding a claim.
test(
	'a spawn return with no pid that reports no error is answered rather than waited on forever',
	{ timeout: 10_000 },
	() =>
		withTempDir('guard-sup-', (dir) =>
			withSpawn(async () => {
				const ctx = context(dir, () => /** @type {never} */ ({ on() {}, once() {} }));
				try {
					const state = await superviseProcess(ctx, descriptorFor('silent-wrapper', 'idle.js'));
					assert.equal(state.started, false, 'a spawn that never ran was reported as started');
					assert.match(state.error ?? '', /failed to start: it returned no pid, and reported no error within \d+ms/);
					assert.equal(
						fs.existsSync(lockPath(dir, 'silent-wrapper')),
						false,
						'the claim was left behind, pinning the lock at pid 0 under a live host'
					);
				} finally {
					ctx.run.stopping = true;
				}
			})
		)
);

test('a spawn return with no pid and no once() is answered, not thrown out of the call', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async () => {
			const ctx = context(dir, () => /** @type {never} */ ({ on() {} }));
			try {
				const state = await superviseProcess(ctx, descriptorFor('bare-wrapper', 'idle.js'));
				assert.equal(state.started, false);
				assert.match(state.error ?? '', /failed to start: it returned no pid, and it reports no errors/);
				assert.equal(fs.existsSync(lockPath(dir, 'bare-wrapper')), false);
			} finally {
				ctx.run.stopping = true;
			}
		})
	));

test('a start this node cannot make signals no orphan, because the lock is where the signal happens', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const descriptor = descriptorFor('deployed', 'idle.js');
			const running = await alreadyRunning(dir, spawn, descriptor);
			// The binary this node would spawn is gone under it, which is what a deploy over a live node does.
			const missing = path.join(dir, 'not-a-binary');
			const ctx = context(dir, spawn, { version: 2, stopOrphans: true });
			const state = await superviseProcess(ctx, { ...descriptor, binaryPath: missing, argv: [missing] });

			assert.equal(state.started, false);
			assert.match(state.error ?? '', /not-a-binary is missing/);
			assert.equal(
				readLock(lockPath(dir, 'deployed'))?.pid,
				pidOf(running),
				'the lock naming the running process was taken and dropped for a replacement that never started'
			);
			assert.equal(
				isAlive(pidOf(running)),
				true,
				'a healthy process was stopped for a replacement that could not start'
			);
		})
	));

test('a process a sibling thread stopped is not reported as a shutdown nobody performed', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const descriptor = descriptorFor('handed-over', 'idle.js');
			const victim = context(dir, spawn);
			const stopper = context(dir, spawn, { version: 2, stopOrphans: true });
			try {
				const state = await superviseProcess(victim, descriptor);
				// The sibling runs a version this node has moved to, so it stops what this thread started.
				await superviseProcess(stopper, descriptor);
				await waitFor(() => state.exited, 'the victim to see its process stopped');
				await new Promise((resolve) => setTimeout(resolve, 150));

				assert.match(victim.log.lines.warn.join('\n'), /was stopped \(signal SIGTERM\) by whatever now holds/);
				assert.equal(
					victim.log.lines.info.join('\n').includes('was shut down'),
					false,
					'a stop by a sibling thread was reported as an operator shutdown'
				);
				assert.deepEqual(victim.log.lines.error, [], 'a lock the stopper already holds was reported as a failure');
			} finally {
				victim.run.stopping = true;
				stopper.run.stopping = true;
			}
		})
	));

test('a spawn the host refuses is reported and its lock is not left behind', () =>
	withTempDir('guard-sup-', async (dir) => {
		const ctx = context(dir, () => {
			throw new Error('spawn of /usr/bin/thing is not allowed');
		});
		const state = await superviseProcess(ctx, descriptorFor('refused', 'idle.js'));

		assert.equal(state.started, false);
		assert.match(state.error ?? '', /is not allowed/);
		assert.equal(fs.existsSync(lockPath(dir, 'refused')), false);
	}));

test('stopping supervision ends the liveness poll, which nothing else would ever clear', async () => {
	const ctx = context('/nothing-is-written-here', () => {
		throw new Error('nothing is spawned here');
	});
	// A pid that outlives the test, so only stop() can settle this. The interval is unref'd and clears
	// itself on a death alone, so without the check it forks a `ps` every tick for the life of the host.
	const watch = watchPid(ctx, process.pid);
	const raced = (/** @type {string} */ value) =>
		Promise.race([watch, new Promise((resolve) => setTimeout(() => resolve(value), 300))]);

	assert.equal(await raced('still polling'), 'still polling');
	ctx.run.stopping = true;
	assert.equal(await raced('still polling after the stop'), 'supervision stopped');
});

test('stopping supervision keeps a pending restart from firing', () =>
	withTempDir('guard-sup-', (dir) =>
		withSpawn(async ({ spawn, calls }) => {
			const ctx = context(dir, spawn, {
				tuning: { deathPollMs: 20, restartMax: 5, restartBaseMs: 200 },
			});
			await superviseProcess(ctx, descriptorFor('halted', 'quits.js', ['4', '20']));
			ctx.run.stopping = true;
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.equal(calls.length, 1);
		})
	));

// A host may hand back a wrapper rather than a ChildProcess, whose 'exit' fires from its own interval or never-
// unref'ing one silenced an adopted process's death for good before, so the pid is the only field worth depending on.
test('a spawn return that never emits exit is still answered, from the pid alone', () =>
	withTempDir('guard-silent-', (dir) =>
		withSpawn(async ({ spawn }) => {
			const descriptor = descriptorFor('silent', 'idle.js');
			const real = spawn(descriptor.binaryPath, [...descriptor.args], { stdio: 'ignore' });
			const pid = pidOf(real);
			await waitFor(() => argvOf(pid) !== null, 'the process to appear in the process table');

			// Same pid, no exit event, ever.
			const ctx = context(dir, () => /** @type {never} */ ({ pid, on() {} }), {
				tuning: { deathPollMs: 20, restartMax: 0, restartBaseMs: 5 },
			});
			try {
				const state = await superviseProcess(ctx, descriptor);
				assert.equal(state.started, true);
				real.kill('SIGKILL');
				await waitFor(() => state.error !== undefined, 'the death to be answered');
				assert.match(state.error ?? '', /liveness poll/, 'only the poll could have reported this death');
			} finally {
				ctx.run.stopping = true;
				real.kill('SIGKILL');
			}
		})
	));
