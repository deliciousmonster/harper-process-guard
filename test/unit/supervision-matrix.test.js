// The supervision matrix as one table: every death a guarded process or the reaper can reach, on the
// thread that started it and on a thread that only joined it. Unreachable cells carry the reason.
// What a joined thread does about a death is the other dimension, and it needs a lock to read:
// ownerless-adoption.test.js drives it; the cells here pass no pid directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, makeTempDir } from '../support/harness.js';

const { launchReaper, startProcess } = await importDist('spawn.js');

/** A child that outlives the cell that started it, so only a signal ends it. */
const FOREVER = 'setInterval(() => {}, 1 << 30)';

/** Exits 3 the first time and runs forever after, so the respawn chain stops at one restart. */
const EXIT_ONCE =
	"const fs = require('node:fs'); const flag = process.argv[1]; " +
	'if (fs.existsSync(flag)) setInterval(() => {}, 1 << 30); ' +
	"else { fs.writeFileSync(flag, ''); process.exit(3); }";

const PROC = (args = ['run']) => ({
	name: 'agent',
	title: 'test agent',
	binaryPath: process.execPath,
	args,
	exitHint: 'The receiver port stays bound.',
});

/** A real-ChildProcess-shaped stub: has spawnargs, so the orchestrator reads it as a win. */
function wonChild(pid = 4321) {
	const child = new EventEmitter();
	child.pid = pid;
	child.spawnargs = ['stub'];
	child.unref = () => {
		child.unrefed = true;
	};
	return child;
}

/** The adoption wrapper: no spawnargs, which is the only reliable tell. */
function adoptedChild(pid = 4321) {
	const child = new EventEmitter();
	child.pid = pid;
	child.unref = () => {
		child.unrefed = true;
	};
	return child;
}

/** Real processes, a temp dir and a recording logger for one cell, with one cleanup for all of it. */
function openWorld(id) {
	const dir = makeTempDir(`matrix-${id}-`);
	const lines = { info: [], warn: [], error: [] };
	const children = [];
	const pids = new Set();
	const spawns = { count: 0 };
	let closed = false;

	const track = (pid) => {
		if (typeof pid === 'number') pids.add(pid);
	};

	const writeScript = (name, source) => {
		const file = path.join(dir, name);
		fs.writeFileSync(file, source);
		return file;
	};

	const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	async function until(check, what, deadlineMs = 5000) {
		const deadline = Date.now() + deadlineMs;
		while (Date.now() < deadline) {
			if (check()) return;
			await hold(10);
		}
		assert.fail(`${id}: ${what} (nothing within ${deadlineMs}ms)`);
	}

	return {
		id,
		dir,
		lines,
		children,
		spawns,
		hold,
		until,
		script: writeScript,
		log: {
			info: (message) => lines.info.push(message),
			warn: (message) => lines.warn.push(message),
			error: (message) => lines.error.push(message),
		},
		eq: (actual, expected, what) => assert.equal(actual, expected, `${id}: ${what}`),
		ok: (value, what) => assert.ok(value, `${id}: ${what}`),
		match: (value, pattern, what) => assert.match(value ?? '', pattern, `${id}: ${what}`),
		deep: (actual, expected, what) => assert.deepEqual(actual, expected, `${id}: ${what}`),
		/** Node's own spawn behind the ConstrainedSpawn shape: the winner path gets real deaths. */
		realSpawn(command, args, options) {
			// A cell that fails mid-backoff leaves a respawn timer pending; a real child started after
			// teardown is one nothing kills, and it pins the runner's loop instead of failing red.
			if (closed) return wonChild(-1);
			spawns.count += 1;
			const child = nodeSpawn(command, args, options);
			children.push(child);
			track(child.pid);
			return child;
		},
		/** Harper's adoption wrapper cannot be produced on demand, so a joiner is handed a stub. */
		stubSpawn(child) {
			return () => {
				spawns.count += 1;
				children.push(child);
				return child;
			};
		},
		live() {
			const child = nodeSpawn(process.execPath, ['-e', FOREVER], { stdio: 'ignore' });
			child.unref();
			track(child.pid);
			return child.pid;
		},
		/** A pid whose parent execs over itself and never wait()s, so killing it leaves a zombie. */
		async fosterChild() {
			const parent = nodeSpawn('sh', ['-c', 'sleep 600 & echo $!; exec sleep 3600'], {
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			track(parent.pid);
			const printed = await new Promise((resolve, reject) => {
				let out = '';
				const timer = setTimeout(
					() => reject(new Error(`${id}: the foster parent printed no pid within 5000ms`)),
					5000
				);
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
			track(pid);
			return pid;
		},
		reaperOptions({ script, ...over } = {}) {
			return {
				reaperScript: script ?? writeScript('reaper.js', 'process.exit(0)'),
				rootPath: dir,
				processes: [{ name: 'a', started: true, pid: 11, binaryPath: '/bin/a', title: 'a' }],
				version: 7,
				log: this.log,
				adoptedPollMs: 20,
				outliveHint: '127.0.0.1:8126 stays bound.',
				...over,
			};
		},
		close() {
			// Detached first: the teardown SIGKILL below reads to the supervisor as a crash, and a
			// respawn started here spawns a child nothing kills, which pins the runner's event loop.
			closed = true;
			for (const child of children) child.removeAllListeners('exit');
			for (const pid of pids) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// Already gone, which is what most of these cells arranged.
				}
			}
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

const PERMUTATIONS = [
	{
		id: 'g-start-owner-alive',
		supervisor: 'startProcess',
		role: 'owner',
		death: 'never dies',
		expected: 'started and not adopted, an error listener attached before return, and no death reported while it runs',
		async run(w) {
			const state = startProcess(w.realSpawn, PROC(['-e', FOREVER]), { version: 1, log: w.log });
			w.eq(state.started, true, 'a real spawn must read as started');
			w.eq(state.adopted, false, 'a child carrying spawnargs is this thread own');
			w.ok(state.pid > 0, 'the state must carry the pid');
			// An unhandled 'error' on a ChildProcess is an uncaught exception that takes the worker
			// thread with it, and the event is asynchronous, so the listener must exist already.
			w.ok(w.children[0].listenerCount('error') >= 1, 'no error listener: the next tick can kill the thread');
			await w.hold(300);
			w.ok(!state.exited, 'a running process was reported dead');
			w.eq(w.lines.warn.length + w.lines.error.length, 0, 'a healthy start is not a fault');
			w.children[0].emit('error', Object.assign(new Error('Exec format error'), { code: 'ENOEXEC' }));
			w.match(w.lines.error[0], /not executable code for this machine/, 'ENOEXEC must name the architecture');
		},
	},
	{
		id: 'g-start-owner-exit-zero',
		supervisor: 'startProcess',
		role: 'owner',
		death: 'clean exit, code 0',
		expected: 'exited recorded, one info line, and no respawn: a clean exit is someone stopping it',
		async run(w) {
			const state = startProcess(w.realSpawn, PROC(['-e', 'process.exit(0)']), { version: 1, log: w.log });
			await w.until(() => state.exited === true, 'a clean exit went unreported');
			w.match(w.lines.info.at(-1), /exited cleanly/, 'a code 0 death reads as clean');
			w.eq(w.lines.error.length, 0, 'a clean exit is not an error');
			// Held past the 1000ms respawn delay, which is the only window a restart could open in.
			await w.hold(1300);
			w.eq(w.spawns.count, 1, 'a clean exit was respawned');
		},
	},
	{
		id: 'g-start-owner-exit-nonzero',
		supervisor: 'startProcess',
		role: 'owner',
		death: 'non-zero exit code',
		expected: 'one error line carrying the code and the exit hint, then one respawn that clears exited and error',
		async run(w) {
			const flag = path.join(w.dir, 'first-run');
			const state = startProcess(w.realSpawn, PROC(['-e', EXIT_ONCE, flag]), { version: 1, log: w.log });
			// An earlier failure recorded on the reused object, the way a real sequence leaves one.
			state.error = 'left over from an earlier failure';
			await w.until(() => state.exited === true, 'a non-zero exit went unreported');
			w.match(w.lines.error[0], /exited with code 3/, 'the exit code belongs in the report');
			w.match(w.lines.error[0], /The receiver port stays bound\./, 'the caller exit hint was dropped');
			w.match(w.lines.warn.at(-1), /attempt 1 of 5/, 'the restart must name which attempt it is');

			await w.until(() => w.spawns.count === 2, 'exit code 3 produced no respawn', 4000);
			w.eq(state.respawnAttempts, 1, 'the respawn must count itself');
			// Cleared on respawn, or one early death reads as dead for the rest of the node's life.
			w.ok(!state.exited, 'exited survived the respawn');
			w.ok(!state.error, 'error survived the respawn');
			w.eq(state.pid, w.children[1].pid, 'the state must name the live incarnation');
		},
	},
	{
		id: 'g-start-owner-sigterm',
		supervisor: 'startProcess',
		role: 'owner',
		death: 'SIGTERM',
		expected: 'one warn line and no respawn: restarting into a shutdown fights whoever sent the signal',
		async run(w) {
			const state = startProcess(w.realSpawn, PROC(['-e', FOREVER]), { version: 1, log: w.log });
			process.kill(state.pid, 'SIGTERM');
			await w.until(() => state.exited === true, 'a SIGTERM went unreported');
			w.match(w.lines.warn.at(-1), /terminated by SIGTERM/, 'a stop signal reads as a stop');
			w.eq(w.lines.error.length, 0, 'a deliberate stop is not a crash');
			await w.hold(1300);
			w.eq(w.spawns.count, 1, 'a SIGTERM was respawned');
		},
	},
	{
		id: 'g-start-owner-sigkill',
		supervisor: 'startProcess',
		role: 'owner',
		death: 'SIGKILL',
		expected: 'one error line naming the crash, then exactly one respawn from the thread that holds the lock',
		async run(w) {
			const state = startProcess(w.realSpawn, PROC(['-e', FOREVER]), { version: 1, log: w.log });
			process.kill(state.pid, 'SIGKILL');
			await w.until(() => state.exited === true, 'a SIGKILL went unreported');
			w.match(w.lines.error.at(-1), /crash or an OOM kill/, 'SIGKILL is the case nothing else recovers from');
			w.match(w.lines.warn.at(-1), /restarting the test agent in 1000ms/, 'the backoff belongs in the report');

			await w.until(() => w.spawns.count === 2, 'a SIGKILL produced no respawn', 4000);
			w.eq(state.pid, w.children[1].pid, 'the state must name the live incarnation');
			w.eq(state.respawnAttempts, 1, 'the respawn must count itself');
		},
	},
	{
		id: 'g-start-owner-zombie',
		supervisor: 'startProcess',
		role: 'owner',
		death: 'dies into a zombie nothing reaps',
		expected: 'unreachable, and stated rather than faked',
		skip: 'a process this node spawned is its own child, so libuv wait()s it and the exit event fires from the reap',
		run() {},
	},
	{
		id: 'g-start-joined-alive',
		supervisor: 'startProcess',
		role: 'joiner',
		death: 'never dies',
		expected: 'adopted and unref-d, with no death reported across a dozen poll intervals',
		async run(w) {
			const child = adoptedChild(w.live());
			const state = startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 20 });
			w.eq(state.adopted, true, 'a child without spawnargs is a join');
			w.eq(child.unrefed, true, 'the wrapper polls on a never-unref-d interval; unref is what clears it');
			// Twelve poll intervals: a poll that reports unconditionally fails here, not at t=0.
			await w.hold(250);
			w.ok(!state.exited, 'a joined process that is running was reported dead');
			w.eq(w.lines.warn.length + w.lines.error.length, 0, 'joining a live process is not a fault');
		},
	},
	{
		id: 'g-start-joined-poll-death',
		supervisor: 'startProcess',
		role: 'joiner',
		death: 'the pid is released, and no wrapper event arrives',
		expected:
			"the guard's own poll reports it once at error; with no pid directory to read, the thread cannot tell an ownerless death from an answered one and restarts nothing",
		async run(w) {
			const pid = w.live();
			const child = adoptedChild(pid);
			const state = startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 20 });
			w.eq(state.adopted, true, 'a child without spawnargs is a join');
			w.ok(!state.exited, 'a joined process reads as dead before anything died');

			// Harper's wrapper implements unref() as clearInterval on its own poll, so no 'exit' is
			// coming: without this package's poll the death is invisible and the state stays healthy.
			process.kill(pid, 'SIGKILL');
			await w.until(() => state.exited === true, 'the death of a joined process went unnoticed');
			w.eq(w.lines.error.length, 1, 'one death, one report');
			w.match(w.lines.error[0], /is gone \(a liveness poll found the pid dead\)/, 'the report must name the poll');
			w.match(w.lines.warn.at(-1), /no pid directory was named/, 'a thread that cannot read the lock must say so');

			// The lock is the only thing that separates a death nobody owns from one already answered.
			await w.hold(200);
			w.eq(w.spawns.count, 1, 'a joining thread restarted a process without reading a lock');
			w.eq(w.lines.error.length, 1, 'the poll kept reporting a death it had already reported');
		},
	},
	{
		id: 'g-start-joined-zombie',
		supervisor: 'startProcess',
		role: 'joiner',
		death: 'dies into a zombie nothing reaps',
		expected: 'the same one report as a released pid, reached through the zombie rule rather than kill(pid, 0)',
		skip: process.platform === 'win32' ? 'win32 has no zombie state to read, so isZombie is false there' : undefined,
		async run(w) {
			const pid = await w.fosterChild();
			const child = adoptedChild(pid);
			const state = startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 50 });

			process.kill(pid, 'SIGKILL');
			await w.until(() => state.exited === true, 'a joined process that died into a zombie went unnoticed', 10_000);
			// The blind spot this closes: the pid is still held by a corpse, so the bare liveness
			// probe says yes while nothing runs behind it.
			assert.doesNotThrow(() => process.kill(pid, 0), `${w.id}: not a zombie: the pid was fully released`);
			w.eq(w.lines.error.length, 1, 'one death, one report');
			w.match(w.lines.error[0], /a liveness poll found the pid dead/, 'a corpse must read as a death');
		},
	},
	{
		id: 'g-start-joined-wrapper-exit-zero',
		supervisor: 'startProcess',
		role: 'joiner',
		death: "clean exit delivered as a wrapper 'exit' event",
		expected: 'graded info, the one joined death in the matrix that is neither a warning nor an error',
		async run(w) {
			// process.pid never dies, so only the event can settle this one.
			const child = adoptedChild(process.pid);
			const state = startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 20 });
			child.emit('exit', 0, null);
			w.eq(state.exited, true, 'the death must reach the state');
			w.match(w.lines.info.at(-1), /is gone \(exit code 0\)/, 'a clean joined death grades at info');
			w.eq(w.lines.warn.length + w.lines.error.length, 0, 'a clean exit is neither a warning nor an error');
		},
	},
	{
		id: 'g-start-joined-wrapper-exit-nonzero',
		supervisor: 'startProcess',
		role: 'joiner',
		death: "non-zero exit delivered as a wrapper 'exit' event",
		expected: 'one error line naming the code, and a second delivery of the same death changes nothing',
		async run(w) {
			const child = adoptedChild(process.pid);
			const state = startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 20 });

			child.emit('exit', 7, null);
			w.eq(state.exited, true, 'the death must reach the state');
			w.eq(w.lines.error.length, 1, 'one death, one report');
			w.match(w.lines.error[0], /is gone \(exit code 7\)/, 'the report must name the code');

			// A second delivery of the same death, which is what a re-emitting wrapper produces.
			child.emit('exit', 7, null);
			await w.hold(100);
			w.eq(w.lines.error.length, 1, 'one death was reported twice');
		},
	},
	{
		id: 'g-start-joined-wrapper-sigterm',
		supervisor: 'startProcess',
		role: 'joiner',
		death: "SIGTERM delivered as a wrapper 'exit' event",
		expected: 'graded warn rather than error: a stop signal is someone shutting it down',
		run(w) {
			const child = adoptedChild(process.pid);
			startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 20 });
			child.emit('exit', null, 'SIGTERM');
			w.eq(w.lines.error.length, 0, 'a shutdown is not a crash');
			w.match(w.lines.warn[0], /is gone \(signal SIGTERM\)/, 'the report must name the signal');
		},
	},
	{
		id: 'g-start-joined-wrapper-sigkill',
		supervisor: 'startProcess',
		role: 'joiner',
		death: "SIGKILL delivered as a wrapper 'exit' event",
		expected: 'graded error, because a crash signal on the process path is not a shutdown',
		run(w) {
			const child = adoptedChild(process.pid);
			const state = startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 20 });
			child.emit('exit', null, 'SIGKILL');
			w.eq(state.exited, true, 'the death must reach the state');
			w.eq(w.lines.error.length, 1, 'one death, one report');
			w.match(w.lines.error[0], /is gone \(signal SIGKILL\)/, 'a crash signal must not grade as a stop');
		},
	},
	{
		id: 'g-start-joined-no-pid',
		supervisor: 'startProcess',
		role: 'joiner',
		death: 'none: the join hands over no pid, so there is nothing to poll',
		expected: 'reported unsupervisable, still unref-d, and no poll that would invent a death',
		run(w) {
			const child = adoptedChild();
			// A default parameter would restore the pid, so it is cleared after construction.
			child.pid = undefined;
			const state = startProcess(w.stubSpawn(child), PROC(), { version: 1, log: w.log, adoptedPollMs: 20 });
			w.eq(state.adopted, true, 'a child without spawnargs is a join');
			w.eq(child.unrefed, true, 'the wrapper interval pins the event loop until unref');
			// isAlive() reads a non-integer as dead, so polling one reports a death that never happened.
			w.match(w.lines.warn[0], /joined without a pid/, 'an unsupervisable join must say so');
			w.ok(!state.exited, 'a process nobody can watch must not read as dead');
		},
	},
	{
		id: 'g-reaper-owner-alive',
		supervisor: 'launchReaper',
		role: 'owner',
		death: 'never dies',
		expected: 'started and not adopted, the started line carrying the hint, and no death reported while it runs',
		async run(w) {
			const script = w.script('forever.js', FOREVER);
			const state = launchReaper(w.realSpawn, w.reaperOptions({ script, startedHint: 'It stops the trace-agent.' }));
			w.eq(state.started, true, 'a real launch must read as started');
			w.eq(state.adopted, false, 'a child carrying spawnargs is this thread own');
			w.eq(state.command, process.execPath, 'execPath goes first, because PATH cannot shadow it');
			w.match(w.lines.info.at(-1), /reaper started/, 'a launch must log as a start');
			w.ok(w.lines.info.at(-1).includes('It stops the trace-agent.'), `${w.id}: the caller hint was dropped`);
			await w.hold(300);
			w.ok(!state.exited, 'a running reaper was reported dead');
			w.eq(w.lines.warn.length + w.lines.error.length, 0, 'a healthy launch is not a fault');
		},
	},
	{
		id: 'g-reaper-owner-exit-nonzero',
		supervisor: 'launchReaper',
		role: 'owner',
		death: 'non-zero exit',
		expected: 'one warn line saying the watched processes now outlive this node, with the caller hint on it',
		async run(w) {
			const script = w.script('die.js', 'process.exit(1)');
			const state = launchReaper(w.realSpawn, w.reaperOptions({ script }));
			await w.until(() => state.exited === true, 'a reaper death never reached the state');
			w.eq(w.lines.warn.length, 1, 'a crashed reaper must leave exactly one line');
			w.match(w.lines.warn[0], /exited with code 1/, 'the report must name the code');
			w.match(w.lines.warn[0], /outlive this node/, 'the consequence belongs in the report');
			w.ok(w.lines.warn[0].includes('127.0.0.1:8126 stays bound.'), `${w.id}: the caller hint was dropped`);
		},
	},
	{
		id: 'g-reaper-owner-exit-zero-or-signal',
		supervisor: 'launchReaper',
		role: 'owner',
		death: 'clean exit, or any signal including SIGKILL',
		expected: 'exited recorded on the state and nothing logged; the field is the only surface for either',
		async run(w) {
			const clean = launchReaper(w.realSpawn, w.reaperOptions({ script: w.script('clean.js', 'process.exit(0)') }));
			await w.until(() => clean.exited === true, 'a clean reaper exit never reached the state');

			const options = w.reaperOptions({ script: w.script('forever.js', FOREVER), name: 'second-reaper' });
			const killed = launchReaper(w.realSpawn, options);
			process.kill(killed.pid, 'SIGKILL');
			await w.until(() => killed.exited === true, 'a signalled reaper never reached the state');

			// A status surface holding this state read healthy for a reaper that had died an hour
			// earlier, which is why the field exists beside the log line.
			w.eq(w.lines.warn.length, 0, 'a clean exit or a signal is someone stopping it, not a crash');
			w.eq(w.lines.error.length, 0, 'a clean exit or a signal is someone stopping it, not a crash');
		},
	},
	{
		id: 'g-reaper-owner-survives-group-signal',
		supervisor: 'launchReaper',
		role: 'owner',
		death: "must NOT die: the launching node's whole process group is signalled",
		expected:
			'spawned detached into its own group and unref-d; test/e2e/process-guard-reaper.test.js proves the behaviour',
		run(w) {
			const child = wonChild(779);
			const options = [];
			launchReaper((command, args, spawnOptions) => {
				options.push(spawnOptions);
				return child;
			}, w.reaperOptions());
			// Without its own group one signal takes Harper, the agents and the reaper together, and
			// the locks are left with nothing to clean them.
			w.eq(options[0].detached, true, 'the reaper shared the group of the node it must outlive');
			w.deep(options[0].stdio, ['ignore', 'ignore', 'ignore'], 'no stream may tie it to this node');
			w.eq(child.unrefed, true, 'the reaper must not hold this node open');
		},
	},
	{
		id: 'g-reaper-joined-alive',
		supervisor: 'launchReaper',
		role: 'joiner',
		death: 'never dies',
		expected:
			'adopted, logged as a join and not as a start, descriptors still written, no death across the poll intervals',
		async run(w) {
			const child = adoptedChild(w.live());
			const state = launchReaper(w.stubSpawn(child), w.reaperOptions({ startedHint: 'It stops the trace-agent.' }));
			w.eq(state.adopted, true, 'a child without spawnargs is a join');
			w.eq(state.started, true, 'a joined reaper is running, whoever started it');
			w.eq(child.unrefed, true, 'the wrapper interval pins the event loop until unref');
			w.ok(
				w.lines.info.some((line) => /joined it/.test(line)),
				`${w.id}: adoption must log as a join`
			);
			w.ok(
				!w.lines.info.some((line) => /reaper started/.test(line)),
				`${w.id}: eight losing threads must not read in the log as eight reapers`
			);

			// The loser's argv never reaches the running reaper, so the descriptor on disk is the
			// only route by which its process gets stopped.
			const pidDir = path.join(w.dir, 'pids');
			w.deep(
				JSON.parse(fs.readFileSync(path.join(pidDir, 'a.guard.json'), 'utf-8')),
				{ name: 'a', pidFile: path.join(pidDir, 'a.pid'), pid: 11, binaryPath: '/bin/a' },
				'the join dropped the descriptor the running reaper reads'
			);

			await w.hold(250);
			w.ok(!state.exited, 'a joined reaper that is running was reported dead');
			w.eq(w.lines.warn.length + w.lines.error.length, 0, 'joining a live reaper is not a fault');
		},
	},
	{
		id: 'g-reaper-joined-poll-death',
		supervisor: 'launchReaper',
		role: 'joiner',
		death: 'the pid is released, and no wrapper event arrives',
		expected: "the guard's own poll reports it once at warn, with the hint, and no thread relaunches",
		async run(w) {
			const pid = w.live();
			const child = adoptedChild(pid);
			const state = launchReaper(w.stubSpawn(child), w.reaperOptions());
			w.eq(state.adopted, true, 'a child without spawnargs is a join');
			w.ok(!state.exited, 'a joined reaper reads as dead before anything died');

			// Without this package's poll the reaper is gone and every thread still reads healthy.
			process.kill(pid, 'SIGKILL');
			await w.until(() => state.exited === true, 'the death of a joined reaper went unnoticed');
			w.eq(w.lines.warn.length, 1, 'one death, one report');
			w.match(w.lines.warn[0], /is gone \(a liveness poll found the pid dead\)/, 'the report must name the poll');
			w.match(w.lines.warn[0], /outlive this node/, 'the consequence belongs in the report');
			w.ok(w.lines.warn[0].includes('127.0.0.1:8126 stays bound.'), `${w.id}: the caller hint was dropped`);

			// Every thread joined the same reaper and would take the same lock at the same instant.
			await w.hold(200);
			w.eq(w.spawns.count, 1, 'a joining thread relaunched a reaper it never held the lock for');
			w.eq(w.lines.warn.length, 1, 'the poll kept reporting a death it had already reported');
		},
	},
	{
		id: 'g-reaper-joined-zombie',
		supervisor: 'launchReaper',
		role: 'joiner',
		death: 'dies into a zombie nothing reaps',
		expected:
			'the same one warn as a released pid; a reaper reparented to a non-reaping init leaves exactly this corpse',
		skip: process.platform === 'win32' ? 'win32 has no zombie state to read, so isZombie is false there' : undefined,
		async run(w) {
			const pid = await w.fosterChild();
			const child = adoptedChild(pid);
			const state = launchReaper(w.stubSpawn(child), w.reaperOptions({ adoptedPollMs: 50 }));

			process.kill(pid, 'SIGKILL');
			await w.until(() => state.exited === true, 'a joined reaper that died into a zombie went unnoticed', 10_000);
			assert.doesNotThrow(() => process.kill(pid, 0), `${w.id}: not a zombie: the pid was fully released`);
			w.eq(w.lines.warn.length, 1, 'one death, one report');
			w.match(w.lines.warn[0], /a liveness poll found the pid dead/, 'a corpse must read as a death');
		},
	},
	{
		id: 'g-reaper-joined-wrapper-exit-zero',
		supervisor: 'launchReaper',
		role: 'joiner',
		death: "clean exit delivered as a wrapper 'exit' event",
		expected: 'warn, not info: the level override holds, because the processes outlive this node either way',
		run(w) {
			// process.pid never dies, so only the event can settle this one.
			const child = adoptedChild(process.pid);
			const state = launchReaper(w.stubSpawn(child), w.reaperOptions());
			child.emit('exit', 0, null);
			w.eq(state.exited, true, 'the death must reach the state');
			w.eq(w.lines.warn.length, 1, 'a joined reaper death grades warn whatever its cause');
			w.match(w.lines.warn[0], /is gone \(exit code 0\)/, 'the report must name the cause');
			w.ok(
				!w.lines.info.some((line) => /is gone/.test(line)),
				`${w.id}: a joined reaper death must not read as informational`
			);
		},
	},
	{
		id: 'g-reaper-joined-wrapper-signal',
		supervisor: 'launchReaper',
		role: 'joiner',
		death: "SIGKILL delivered as a wrapper 'exit' event",
		expected: 'warn, not error: the same override in the other direction, and a second delivery changes nothing',
		async run(w) {
			const child = adoptedChild(process.pid);
			const state = launchReaper(w.stubSpawn(child), w.reaperOptions());

			child.emit('exit', null, 'SIGKILL');
			w.eq(state.exited, true, 'the death must reach the state');
			w.eq(w.lines.warn.length, 1, 'one death, one report');
			w.match(w.lines.warn[0], /is gone \(signal SIGKILL\)/, 'the report must name the signal');
			w.eq(w.lines.error.length, 0, 'a joining thread cannot tell a deliberate stop from a crash');

			child.emit('exit', null, 'SIGKILL');
			await w.hold(100);
			w.eq(w.lines.warn.length, 1, 'one death was reported twice');
		},
	},
	{
		id: 'g-reaper-joined-no-pid',
		supervisor: 'launchReaper',
		role: 'joiner',
		death: 'none: the join hands over no pid, so there is nothing to poll',
		expected: 'reported unsupervisable with the hint, still unref-d, and no poll that would invent a death',
		run(w) {
			const child = adoptedChild();
			// A default parameter would restore the pid, so it is cleared after construction.
			child.pid = undefined;
			const state = launchReaper(w.stubSpawn(child), w.reaperOptions());
			w.eq(state.adopted, true, 'a child without spawnargs is a join');
			w.eq(child.unrefed, true, 'the wrapper interval pins the event loop until unref');
			w.match(w.lines.warn[0], /joined without a pid/, 'an unsupervisable join must say so');
			w.ok(!state.exited, 'a reaper nobody can watch must not read as dead');
		},
	},
	{
		id: 'g-reaper-death-orphans-processes',
		supervisor: 'launchReaper and dist/reaper.js',
		role: 'either',
		death: 'the reaper dies while the processes it watched keep running',
		expected: 'the processes keep running and the reaper self-lock is left on disk for the next load to replace',
		skip: "the self-lock is written by Harper's constrained spawn, which this table stubs; the cell belongs to the e2e harness",
		run() {},
	},
];

for (const permutation of PERMUTATIONS) {
	const name = `${permutation.id}: ${permutation.supervisor} ${permutation.role}, ${permutation.death}`;
	test(name, { skip: permutation.skip }, async (t) => {
		t.diagnostic(permutation.expected);
		const world = openWorld(permutation.id);
		try {
			await permutation.run(world);
		} finally {
			world.close();
		}
	});
}
