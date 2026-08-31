// The death nobody owns: after a node restart its sidecars survive, so every thread of the new node
// joins them and no thread holds the ChildProcess whose exit would restart one. Harper's lock arbitrates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, makeTempDir } from '../support/harness.js';

const { startProcess } = await importDist('spawn.js');

/** A child that outlives the test that started it, so only a signal ends it. */
const FOREVER = 'setInterval(() => {}, 1 << 30)';
const NAME = 'agent';
const VERSION = 7;
const PROC = { name: NAME, title: 'test agent', binaryPath: process.execPath, args: ['-e', FOREVER] };

/** Harper's own lock validation: a bare kill(pid, 0), which a dead-but-unreaped process still answers. */
function holdsPid(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The adoption wrapper as released Harper builds it: no spawnargs, and unref() kills its liveness poll, so no 'exit' can ever arrive. */
function adoptionWrapper(pid) {
	const wrapper = new EventEmitter();
	wrapper.pid = pid;
	wrapper.unref = () => {};
	return wrapper;
}

/**
 * One Harper node: a pid directory, the constrained spawn's lock semantics from
 * security/jsLoader.ts (exclusive create, adopt a live lock, replace a stale one, unlink from the
 * owner's exit), and the threads that call into it.
 */
function openNode(id) {
	const dir = makeTempDir(`ownerless-${id}-`);
	const pidDir = path.join(dir, 'pids');
	fs.mkdirSync(pidDir, { recursive: true });
	const lockPath = path.join(pidDir, `${NAME}.pid`);
	const children = [];
	const pids = new Set();
	let closed = false;

	const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	function recordingLog() {
		const lines = { info: [], warn: [], error: [] };
		return {
			lines,
			info: (message) => lines.info.push(message),
			warn: (message) => lines.warn.push(message),
			error: (message) => lines.error.push(message),
		};
	}

	const node = {
		id,
		dir,
		pidDir,
		lockPath,
		hold,
		spawns: 0,
		async until(check, what, deadlineMs = 8000) {
			const deadline = Date.now() + deadlineMs;
			while (Date.now() < deadline) {
				if (check()) return;
				await hold(10);
			}
			assert.fail(`${id}: ${what} (nothing within ${deadlineMs}ms)`);
		},
		/** The constrained spawn. Its `wx` create is the cross-thread arbiter this design leans on. */
		spawn(command, args, options) {
			// A cell that fails mid-backoff leaves a timer armed; a child started after teardown is one
			// nothing kills, and it pins the runner's loop instead of failing red.
			if (closed) return adoptionWrapper(process.pid);
			const lock = path.join(pidDir, `${options.name}.pid`);
			let fd;
			try {
				fd = fs.openSync(lock, 'wx');
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
				const recorded = Number.parseInt(fs.readFileSync(lock, 'utf-8').split('\n')[0], 10);
				if (Number.isInteger(recorded) && holdsPid(recorded)) return adoptionWrapper(recorded);
				fs.rmSync(lock, { force: true });
				return node.spawn(command, args, options);
			}
			fs.closeSync(fd);
			node.spawns += 1;
			const child = nodeSpawn(command, args, { stdio: 'ignore' });
			fs.writeFileSync(lock, `${child.pid}\n${options.version ?? 0}`);
			children.push(child);
			pids.add(child.pid);
			// Harper unlinks the lock from the exit of the ChildProcess it handed out, which is why an
			// owner-present death leaves no lock and an ownerless one leaves it standing.
			child.on('exit', () => {
				try {
					fs.unlinkSync(lock);
				} catch {
					// Another thread removed it first, which is what a reclaim does.
				}
			});
			return child;
		},
		/** A sidecar that outlived the node that started it: running, locked, and owned by no thread here. */
		survivor() {
			const child = nodeSpawn(process.execPath, ['-e', FOREVER], { stdio: 'ignore' });
			children.push(child);
			pids.add(child.pid);
			fs.writeFileSync(lockPath, `${child.pid}\n${VERSION}`);
			return child.pid;
		},
		/** A pid whose parent execs over itself and never wait()s, so killing it leaves a corpse holding the number. */
		async corpseInWaiting() {
			const parent = nodeSpawn('sh', ['-c', 'sleep 600 & echo $!; exec sleep 3600'], {
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			children.push(parent);
			pids.add(parent.pid);
			const printed = await new Promise((resolve, reject) => {
				let out = '';
				const timer = setTimeout(() => reject(new Error(`${id}: the foster parent printed no pid`)), 5000);
				parent.on('error', reject);
				parent.stdout.on('data', (chunk) => {
					out += chunk;
					if (!out.includes('\n')) return;
					clearTimeout(timer);
					resolve(out.trim());
				});
			});
			const pid = Number.parseInt(printed, 10);
			assert.ok(Number.isInteger(pid) && pid > 0, `${id}: sh reported no background pid`);
			pids.add(pid);
			fs.writeFileSync(lockPath, `${pid}\n${VERSION}`);
			return pid;
		},
		/** One thread's call into startProcess, with its own log and its own state. */
		thread(adoptedPollMs) {
			const log = recordingLog();
			const state = startProcess(node.spawn, PROC, { version: VERSION, log, pidDir, adoptedPollMs });
			return { state, log };
		},
		/** Several threads joining what is already running, the way every thread of a node evaluates the component. */
		threads(count, adoptedPollMs) {
			return Array.from({ length: count }, () => node.thread(adoptedPollMs));
		},
		lockedPid() {
			if (!fs.existsSync(lockPath)) return null;
			return Number.parseInt(fs.readFileSync(lockPath, 'utf-8').split('\n')[0], 10);
		},
		close() {
			// Detached first: the teardown SIGKILL below reads to a supervisor as a crash, and a restart
			// started here spawns a child nothing kills.
			closed = true;
			for (const child of children) child.removeAllListeners('exit');
			for (const pid of pids) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// Already gone, which is what most of these cases arranged.
				}
			}
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
	return node;
}

test('a death nobody on this node owns is restarted exactly once, whatever the thread count', async () => {
	const node = openNode('ownerless');
	try {
		const survivor = node.survivor();
		const threads = node.threads(4, 20);
		for (const { state } of threads) {
			assert.equal(state.adopted, true, 'a thread that met a live lock must join, not start');
			assert.equal(state.pid, survivor, 'a joined thread must carry the pid it joined');
		}
		assert.equal(node.spawns, 0, 'joining a running process started one');

		const killedAt = Date.now();
		process.kill(survivor, 'SIGKILL');
		await node.until(
			() => node.spawns === 1,
			'the ownerless death stayed dead: every thread saw it, none took the lock, and the stale lock stands'
		);
		// Held past the slowest thread's backoff, which is where a second restart would appear.
		await node.hold(700);
		assert.equal(node.spawns, 1, 'one death produced more than one restart');
		assert.ok(Date.now() - killedAt >= 900, 'the restart skipped the backoff the owner path waits out');

		const replacement = node.lockedPid();
		assert.notEqual(replacement, survivor, 'the lock still names the dead process');
		assert.ok(holdsPid(replacement), 'the replacement is not running');
		assert.equal(
			threads.filter(({ state }) => state.adopted === false).length,
			1,
			'the lock must hand ownership of the replacement to exactly one thread'
		);
		for (const { state } of threads) {
			assert.equal(state.pid, replacement, 'a thread was left describing the process that died');
			assert.ok(!state.exited, 'a thread reads as dead beside a running replacement');
			assert.equal(
				state.respawnAttempts,
				1,
				'a thread that lost the lock must spend the attempt too, or the cap multiplies by thread count'
			);
		}
	} finally {
		node.close();
	}
});

test(
	'an ownerless death that leaves a corpse is replaced rather than joined',
	{
		skip: process.platform === 'win32' ? 'win32 has no zombie state to read' : undefined,
	},
	async () => {
		const node = openNode('corpse');
		try {
			const doomed = await node.corpseInWaiting();
			const threads = node.threads(2, 50);
			for (const { state } of threads) assert.equal(state.adopted, true, 'a live lock must be joined');

			process.kill(doomed, 'SIGKILL');
			await node.until(
				() => node.spawns === 1,
				'the corpse was joined instead of replaced: Harper validates a lock with kill(pid, 0), which a zombie answers',
				12_000
			);
			// The blind spot this closes: the pid is still held, so Harper's own validation says the lock is live.
			assert.doesNotThrow(() => process.kill(doomed, 0), 'not a corpse: the pid was fully released');
			await node.hold(700);
			assert.equal(node.spawns, 1, 'one death produced more than one restart');
			assert.notEqual(node.lockedPid(), doomed, "the corpse's lock survived its replacement");
		} finally {
			node.close();
		}
	}
);

test('a death the owner sees is still restarted only by the owner', async () => {
	const node = openNode('owned');
	try {
		const owner = node.thread(20);
		assert.equal(owner.state.adopted, false, 'the first thread must take the lock');
		// A slower poll than the owner's exit event on purpose: the owner hears the death at once and a
		// joiner waits out an interval, which is the head start that keeps the restart with the owner.
		const joiners = node.threads(3, 300);
		for (const { state } of joiners) assert.equal(state.adopted, true, 'a thread that met a live lock must join');

		process.kill(owner.state.pid, 'SIGKILL');
		await node.until(() => node.spawns === 2, 'the owner did not restart the process it started');
		await node.hold(700);
		assert.equal(node.spawns, 2, 'a thread that only joined restarted a process the owner had already replaced');
		assert.equal(owner.state.respawnAttempts, 1, 'the owner must count its own restart');

		for (const { state, log } of joiners) {
			assert.equal(state.respawnAttempts, 0, 'a joined thread reached for a lock the owner was holding');
			assert.ok(
				log.lines.info.some((line) => /lock at .* is already gone/.test(line)),
				'a joined thread that stands down must say what told it to'
			);
		}
	} finally {
		node.close();
	}
});

test('a stop the owner honours is not undone by the threads that joined', async () => {
	const node = openNode('stopped');
	try {
		const owner = node.thread(20);
		const joiners = node.threads(3, 300);

		// The distinguisher: the owner reads SIGTERM off its own ChildProcess and leaves it stopped. A
		// joiner never sees a signal, only a pid that stopped answering, so the removed lock is its tell.
		process.kill(owner.state.pid, 'SIGTERM');
		await node.until(
			() => joiners.every(({ state }) => state.exited === true),
			'the joined threads never noticed the stop'
		);
		assert.ok(
			owner.log.lines.warn.some((line) => /terminated by SIGTERM/.test(line)),
			'the owner must read a stop signal as a stop'
		);
		// Past the backoff a crash would have restarted in.
		await node.hold(1500);
		assert.equal(node.spawns, 1, 'a thread that only joined restarted a process someone had stopped on purpose');
		assert.equal(node.lockedPid(), null, 'a stopped process left its lock behind');
	} finally {
		node.close();
	}
});
