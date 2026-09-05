# harper-process-guard

[![Test](https://github.com/deliciousmonster/harper-process-guard/actions/workflows/test.yml/badge.svg)](https://github.com/deliciousmonster/harper-process-guard/actions/workflows/test.yml)

One winner per node for a long-lived child process. A host that runs many threads in one OS process,
and evaluates the same component on every one of them, spawns N copies of whatever that component
starts unless something arbitrates. This is that arbiter: a PID lock with a real compare-and-swap
behind it, identification by command line, supervision that survives losing the race, and a reaper
that outlives the host.

It imports `node:` builtins and nothing else, has no dependencies, and is not compiled: what is
written is what ships.

Harper v5 is the host this was built against, and its `runOnMainThread` means "also on main" rather
than "only once", which is the shape of the problem. Nothing in `src/` knows that, and any host with
the same shape can use it.

## Install

```sh
npm install @deliciousmonster/harper-process-guard
```

## Usage

```js
import { spawn } from 'node:child_process';
import { fingerprint, guard } from '@deliciousmonster/harper-process-guard';

const status = await guard({
	pidDir: `${rootPath}/pids`,
	spawn,
	log: logger,
	version: fingerprint(configText, apiKey),
	processes: [
		{
			name: 'trace-agent',
			binaryPath: agentPath,
			args: ['run', '-c', configPath],
			verify: async () => ({ ok: await agentAnswers(), detail: infoUrl }),
		},
	],
	reaper: { name: 'trace-agent-reaper', replacementPidFile: `${rootPath}/hdb.pid` },
});
```

Every thread that reaches this call makes the same call. One of them starts the process; the rest
join it and watch it. `status.processes` carries one state per declared process, `status.report` one
line per thing the lock adjudication decided, and `status.stop()` halts supervision without
signalling anything.

`spawn` is an argument rather than an import. That is what makes the guard testable against a fake
and usable by a host that hands out a constrained `child_process` to modules it reached by relative
import. Anything a particular host's spawn wrapper needs goes through `spawnOptions`, per process.

The whole public surface is `guard` and `fingerprint`.

## What it does

### One winner per node

The lock is `<pidDir>/<name>.pid`: pid on line 1, version fingerprint on line 2, and this guard's own
record on line 3. A host that reads only the first two lines still reads it, and a pid file without
line 3 is not one of these and is never acted on.

Every decision about a lock happens inside a gate that one thread holds at a time, and the lock is
only ever replaced by `rename`, never removed and recreated. That matters because **`unlinkSync` is
not a compare-and-swap**: measured, 23 of 300 eight-thread races over a stale lock produced more than
one winner, every one of them because a second thread's delete took the file the winner had just
created. `test/unit/lock.test.js` runs those 300 races on real worker threads, and what it measures is
the pair: publish the replacement after the gate is released, or make the gate always grant, and it
fails inside two rounds. Swapping `rename` for delete-then-create _inside_ the gate leaves it green,
because holding the gate is what makes those two steps one.

A claim reads pid 0 until the thread that took it names its process, so a thread that arrives in that
window waits rather than racing. A claim whose holding process is gone, or that never finished inside
the caller's budget, is taken over.

A lock naming a dead pid is reclaimed. **Pid 1 reads as alive**, because inside a container the host
this guard watches usually is pid 1; only 0 and negatives are refused, since `kill(2)` reads those as
process groups. A zombie reads as dead: it still answers `kill(pid, 0)` but runs nothing, and a
process reparented to a non-reaping init leaves exactly that.

### Identity by command line

`/proc/<pid>/exe` is kernel-set and unspoofable, and useless here: it resolves to the interpreter, so
every node script on the box reads identical. Two node scripts proved indistinguishable by it and
separable only by argv. So identity is `/proc/<pid>/cmdline` on Linux and `ps -o args=` on darwin,
compared as a leading run of the process's own vector, which means pinning more of the command line
can only ever narrow a verdict. An empty expectation identifies nothing.

The caller supplies the argv, because the guard does not know what its consumer spawns.

Verdicts are `match`, `differs` and `unknown`, and `unknown` never reads as `differs`. Nothing is
signalled without a `match`.

### Adoption, respawn, stopping

A thread that joined a process it did not start still watches it, by polling the pid, because a
joiner that reports success and then supervises nothing is a lie a status endpoint repeats.

Every death goes back through the lock, whichever thread saw it. That one path answers all of it:
the thread restarts a death nothing else has answered, and joins whatever another thread started if
one got there first. The owner keeps its lock across a crash, which is how a joiner tells a death
nobody owns from one already in hand; a deliberate shutdown (exit 0, SIGTERM, SIGINT, SIGHUP) is the
one case where the lock goes and nothing is restarted.

With `stopOrphans` on, this guard is itself a source of SIGTERM, and the process that receives one
cannot tell who sent it. The lock can: a thread that finds another token holding it reports the stop
as the handoff it is, names the holder as the one starting the replacement, and leaves that thread's
lock alone.

Restarts back off and are capped, and the cap is reported as what is now missing from the node.

### The reaper

Nothing in-process runs when a host is killed rather than stopped: there is no worker shutdown hook
and SIGKILL fires no handler. So the reaper is a detached process, spawned by path, that watches the
host and stops what it locked once the host is gone.

It is launched only when `reaper` is passed. **The kill path is opt-in**, here and in `stopOrphans`,
because a guard that kills by default will one day kill something a consumer wanted alive. Without a
reaper the processes outlive the host, and the next start reports them.

The reaper removes a lock before signalling the process it names: a thread that reads a dying pid
adopts a corpse and never retries, where one that finds nothing starts a replacement. It signals only
what it can identify, and it leaves a lock that names no pid exactly where it is: that lock records a
spawn whose pid was never committed, so removing it would discard the only trace of a process that is
probably still running. Given `replacementPidFile`, a new host appearing inside the grace window keeps
the processes for it to adopt, which is what a restart needs.

It is spawned as `process.execPath` first and a bare `node` second. Harper's
`applications.allowedSpawnCommands` defaults to `[npm, node]` and matches on
`command.split(' ')[0]`, so a host that permits neither spelling gets a reaper that did not start,
said so in the report, and left no lock behind.

### Orphans

A live process whose lock carries this configuration is adopted. One whose version fingerprint or
command line has moved is an orphan of an earlier release: the lock is taken, and the process is
reported and left running unless `stopOrphans` is set, in which case the lock is taken and one SIGTERM
sent in the same pass.

Nothing waits for that signal and nothing escalates behind it. An orphan that ignores SIGTERM keeps
running, its replacement fails to start against whatever it still holds, and the restart backoff is
what retries; the note says exactly that rather than reporting a death nobody watched for. Waiting
here would block the caller's whole startup to choose between two log phrasings, and by any deadline
the pid may name something else anyway. Stopping a process properly - signal, grace, `SIGKILL` - is
the reaper's job, and the reaper is the only thing here that does it.

The binary is checked before the lock is claimed, because claiming it is where an orphan gets
signalled: a node that cannot start a replacement must not stop what it has. A spawn the host refuses
cannot be caught that early, so that one case still gives up the claim after the fact.

## What is not here

`pollEndpoint` and `readHarperRootPath` were removed. Polling an HTTP endpoint has nothing to do with
arbitrating a process, and `verify` is a callback the caller writes in a few lines; the one consumer
that needs it keeps its own copy for reasons the guard cannot serve. Knowing how to parse
`hdb_boot_properties.file` made this a Harper package rather than a process guard, and the caller
already derives its own paths.

The spawn-interception probe went with them. It existed because the old design leaned on Harper's
constrained spawn to take the lock, so a spawn that was not Harper's meant no lock at all. This guard
takes its own lock, so the premise is gone, and a probe that spawns a bogus command is a side effect
a generic package should not have.

## Development

```sh
npm test          # node --test, no build
npm run typecheck # tsc --noEmit over JSDoc; it never compiles
npm run lint
npm run ci:local  # the Test workflow's own steps, extracted from test.yml at run time
```

`src/` is plain ESM with `// @ts-check` and JSDoc types. There is no `dist/`, no build step and no
runtime dependency, and `test/unit/package.test.js` fails if any of those three change.

The suites spawn real processes and real worker threads on purpose. The interleavings are the whole
subject, and a version that mocks them proves nothing about any of them.
