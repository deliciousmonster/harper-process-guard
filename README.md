# harper-process-guard

[![Test](https://github.com/deliciousmonster/harper-process-guard/actions/workflows/test.yml/badge.svg)](https://github.com/deliciousmonster/harper-process-guard/actions/workflows/test.yml)

One winner per node for a long-lived child process. A host that runs many threads in one OS process,
and evaluates the same component on every one of them, starts N copies of whatever that component
spawns unless something arbitrates. This is that arbiter: one pid lock per process, decided under a
file gate and identified by command line, plus a detached reaper for what a killed host leaves behind.
Harper v5 is the host it was built against, whose `runOnMainThread` means "also on main" rather than
"only once"; nothing in `src/` knows that, so any host of the same shape can use it.

It imports `node:` builtins and nothing else, and there is no build step: what is written is what
ships. Node ^22.18 or >=24, on Linux, darwin or Windows. The identification everything here rests on
has one implementation per platform, and Identity below says what that costs and what Windows changes.

## Install

Not on npm yet. Vendor the repository- the one consumer keeps it as a git submodule and imports
`src/index.js` by path, which works because the checkout is the package.

```sh
git submodule add https://github.com/deliciousmonster/harper-process-guard.git guard
```

## Usage

```js
import { spawn } from 'node:child_process';
import { fingerprint, guard } from './guard/src/index.js';

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

Every thread that reaches this call makes the same call. One of them starts the process; the rest join
it and watch it. The call resolves once every declared process is running or has been refused, which a
contended lock can delay by as much as `claimTimeoutMs`.

- `status.processes`: one state per declared process, in declaration order, each mutated in place for
  the life of the node, so a status endpoint can hold on to it.
- `status.report`: what this thread's first attempt decided or refused, one line each. Adjudication
  notes, a start that failed, a reaper that would not launch.
- `status.reaper`: whether one is running, under which pid, and why not if not.
- `status.stop()`: halts supervision, signalling nothing and releasing no lock, so nothing starts a
  duplicate. Call it on reload: it also ends the liveness polls, which nothing else clears.

`spawn` is an argument rather than an import, so a host that hands its modules a constrained
`child_process` can pass its own. The whole public surface is `guard` and `fingerprint`, which hashes
whatever forces a replacement into a positive integer inside 2^31, the number line 2 of the lock
carries.

| `guard({ ... })` | Default  |                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------- |
| `pidDir`         | required | One `<name>.pid` per process. Give the guard a directory of its own; see the reaper.        |
| `processes`      | required | `name`, `binaryPath`, `args`, and optionally `title`, `exitHint`, `spawnOptions`, `verify`. |
| `spawn`          | required | The caller's own, called with `name` in its options for a host that gates spawns on one.    |
| `version`        | `0`      | Line 2 of the lock. A process under a different one is an orphan, not something to adopt.   |
| `stopOrphans`    | `false`  | Whether an identified orphan may be signalled.                                              |
| `log`            | silent   | `info`, `warn`, `error`.                                                                    |
| `claimTimeoutMs` | `30000`  | How long a claim waits on another thread's unfinished one.                                  |
| `reaper`         | none     | `name`, `graceMs` (8000), `replacementPidFile`, `logFile`, `spawnOptions`. None without it. |

`verify` runs once everything is up, the reaper included, and its verdict lands on the state; a throw
is a failed verification rather than a failed start.

## What it does

### One winner per node

The lock is `<pidDir>/<name>.pid`: pid on line 1, version fingerprint on line 2, this guard's own
record on line 3. A host that reads only the first two lines still reads it. A pid file without line 3
was written by something else, so the reaper skips it and nothing here signals the pid it names. The
guard will still take that filename if you hand it that `name`, so give a process a name nothing else
writes.

Every decision about a lock is made inside a `<name>.pid.claiming` gate, and the lock itself is
replaced by `rename`, so a reader outside the gate meets the old file or the new one rather than a
half-written one. A lock is removed rather than replaced only where nothing should adopt what it
named: a deliberate shutdown, a claim handed back after a start that failed, and the reaper.

A claim reads pid 0 until the thread that took it names its process, so a thread that arrives in that
window waits rather than racing. A claim whose holding process is gone, or that never finished inside
the caller's budget, is taken over. A lock naming a dead pid is reclaimed, and a zombie counts as
dead: it still answers `kill(pid, 0)` but runs nothing. **Pid 1 reads as alive**, because inside a
container the host this guard watches usually is pid 1; only 0 and negatives are refused, since
`kill(2)` reads those as process groups.

The exclusion is bounded rather than absolute. A thread whose `claimTimeoutMs` has run out breaks the
gate deliberately: nothing else bounds a claim, and one that never returns takes the caller's whole
startup with it. Two threads can then decide one lock, and the node can end up with two processes.
Measured over 300 rounds of eight worker threads, at the 5000ms budget the race suite uses, no two
were ever inside the gate together; at a 10ms budget that race produces two winners within a few
rounds.

### Identity by command line

`/proc/<pid>/exe` is kernel-set and unspoofable, and useless here: it resolves to the interpreter, so
every node script on the box reads identical. Identity is the command line instead: `/proc/<pid>/cmdline`
on Linux, `ps` on darwin, `Get-CimInstance Win32_Process` on Windows, compared as a leading run of the
process's own vector, so pinning more of it can only ever narrow a verdict. An empty expectation
identifies nothing.

Nothing is signalled without a positive match. On a platform none of those three covers every pid
reads as unidentifiable, so nothing is ever signalled there- and a thread will not join a process it
cannot identify either. It takes the lock and starts its own, which is the double start this package
exists to prevent, so `os` in package.json refuses the install there rather than letting that pass for
a working guard.

### Windows, and what has not been proved about it

The win32 path has never run on Windows. It is written from libuv's `src/win/process.c` and the
`Win32_Process` contract, and the windows-latest leg of the Test workflow is what settles it.

Windows keeps no argv, only the one string libuv built, and libuv quotes any argument holding a space,
a tab or a quote. The recorded vector is quoted the same way before the two are compared, so a process
under `C:\Program Files` still identifies. Quoting it wrong yields `differs`, which starts a second
process rather than signalling a stranger; that direction is deliberate.

Two behaviours differ there whatever CI reports, because the platform has no other answer.
`process.kill(pid, 'SIGTERM')` is `TerminateProcess`, so the target's handler never runs: a reaper
stopped that way leaves its own lock behind, and a process an operator stopped is indistinguishable
from one that crashed, so supervision restarts it up to `restartMax`. One command-line lookup also
costs a PowerShell start rather than the few milliseconds `ps` costs, which is why liveness polling
never goes through it and why only a lock claim and a reap target pay for one.

### Adoption, respawn, stopping

A thread that joined a process it did not start still watches it, by polling the pid every two
seconds, because a joiner that reports success and then supervises nothing is a lie a status endpoint
repeats.

Every death goes back through the lock, whichever thread saw it. That one path answers all of it: the
thread restarts a death nothing else has answered, and joins whatever another thread started if one
got there first. The owner keeps its lock across a crash, which is how a joiner tells a death nobody
owns from one already in hand; an owner that sees a deliberate exit (code 0, SIGTERM, SIGINT, SIGHUP)
releases the lock and starts nothing. Restarts wait a second, then double, and stop after five; the
cap lands on the log and on `state.error` as what is now missing from the node, not in the report,
which only ever carries the first attempt. None of those numbers are options.

With `stopOrphans` on, this guard is itself a source of SIGTERM, and a process that receives one
cannot tell who sent it. The lock can: a thread that finds another token holding it reports the stop as
the handoff it is and leaves that lock alone.

### Orphans

A live process whose lock carries this configuration is adopted. One whose version fingerprint or
command line has moved is an orphan of an earlier release: its lock is taken, and with `stopOrphans`
set it is also sent one SIGTERM, in that same gated pass, ahead of the write that stops the lock
naming it.

Nothing waits for that signal and nothing escalates behind it. An orphan that ignores SIGTERM keeps
running and nothing here chases it; its replacement then starts against whatever it still holds, and
the restart backoff is the only retry. The note says that, rather than reporting a death nobody
watched for.

The binary is checked before the lock is claimed, because claiming it is where an orphan gets
signalled: a node that cannot start a replacement must not stop what it has. A spawn cannot be checked
that early, so a refusal and a return without a pid both give the claim back after the fact.

### The reaper

Nothing in-process runs when a host is killed rather than stopped: there is no worker shutdown hook
and SIGKILL fires no handler. So the reaper is a detached process, spawned by path, that polls the host
pid once a second and stops what the guard locked once the host is gone. One per node; a thread that
loses its lock joins the reaper that won it.

It is launched only when `reaper` is passed. **The kill path is opt-in**, here and in `stopOrphans`,
because a guard that kills by default will one day kill something a consumer wanted alive. Without a
reaper the processes outlive the host, and the next start finds them through their locks.

Once the host is gone it waits `graceMs` for a replacement to record itself in `replacementPidFile`,
and leaves the processes for that host to adopt if one appears, which is what a restart needs.
Otherwise it takes every lock in `pidDir` carrying a guard record, including locks this call never
declared, which is why the directory should be the guard's alone. For each: remove the lock, then
signal the pid only if its command line still matches. Removing first is deliberate, because a thread
that reads a dying pid adopts a corpse and never retries, where one that finds nothing starts a
replacement. A lock that never got past pid 0 goes the same way, and the process it half-recorded is
left running. Whatever was signalled and is still alive five seconds later gets SIGKILL.

It is spawned as `process.execPath` first and a bare `node` second, so a host that filters spawns has
to permit one of those spellings. A host that permits neither gets a reaper that did not start, said
so in the report, and left no lock behind.

## Development

`src/` is plain ESM with `// @ts-check` and JSDoc, and nothing here is built. `npm test` spawns real
processes and real worker threads, and CI runs that suite on six legs: Linux, macOS and Windows
against Node 22 and 24. `AGENTS.md` is what to read before changing any of it.
