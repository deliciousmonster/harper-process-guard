# harper-process-guard

[![Test](https://github.com/deliciousmonster/harper-process-guard/actions/workflows/test.yml/badge.svg)](https://github.com/deliciousmonster/harper-process-guard/actions/workflows/test.yml)

<!-- Uncomment after the first publish:
[![npm](https://img.shields.io/npm/v/%40deliciousmonster%2Fharper-process-guard)](https://www.npmjs.com/package/@deliciousmonster/harper-process-guard)
-->

Process supervision for Harper components that spawn long-lived child processes. One
`bootstrap()` call runs the lifecycle: it sweeps stale PID locks once per node behind a barrier,
writes config files atomically, starts each process from a descriptor list through Harper's
PID-file singleton (keyed by the mandatory spawn `name`), launches a reaper to stop the children
when the node goes away, and then verifies each child by polling an endpoint. It imports `node:`
builtins and nothing else.

Harper hands every component that spawns a long-lived process the same two problems, and solves
neither: worker threads with no once-per-node primitive between them, and a PID lock that adopts
whatever process happens to hold its number. Any component that starts an agent or a tunnel to
something remote inherits both. The durable fix belongs upstream in Harper; this package is the
part a component can do for itself. [How it works](#how-it-works) has the detail.

## Install

```sh
npm install @deliciousmonster/harper-process-guard
```

The package reaches npm on the first `v*` tag pushed after the
[Before it ships](#before-it-ships) checklist empties; until then, depend on it by git URL or
file path.

## Usage

One call from the component entry runs the whole lifecycle:

```js
import { bootstrap, pollEndpoint, readHarperRootPath } from '@deliciousmonster/harper-process-guard';
import { spawn } from 'node:child_process';

const status = await bootstrap({
	spawn,
	log: logger,
	rootPath: readHarperRootPath() ?? process.env.ROOTPATH,
	fingerprintParts: [configText, apiKey],
	configFiles: { [configPath]: renderedYaml },
	processes: [
		{
			name: 'trace-agent',
			resolve: () => resolveAgentPath(),
			args: ['run', '-c', configPath],
			verify: async () => ({ ok: (await pollEndpoint({ url: infoUrl })) !== null, detail: infoUrl }),
		},
	],
	reaper: { name: 'trace-agent-reaper' },
});
```

The `spawn` you pass must be your own `import { spawn } from 'node:child_process'`. Harper
grants its constrained child_process only to modules reached by relative import from the
component entry, and a package loaded by bare specifier is not one, so the capability has to
arrive as an argument. `bootstrap()` probes what it was handed and says loudly when it got
Node's real spawn instead.

The returned status carries the sweep report, one state per process with the verify verdicts
attached, and the reaper's.

Without `spawn` the call sweeps and writes any `configFiles`, and never starts anything:
Harper's spawn is what enforces the binary allowlist and takes the lock, and the caller keeps
composing the rest itself.

`fingerprintParts` become the `version` on every spawn, and it matters. Harper adopts a lock
whose version still matches, which is what `harper restart` relies on to hand running children
to a replacement node. Without it the guard cannot tell a process you are about to inherit from
one nobody owns, and stopping the first drops whatever it was carrying.

Everything is said through the `log` you pass, which defaults to a no-op: a component's warnings
have to reach `hdb.log`, and a package writing to its own console reaches nobody. The sweep
verdict also comes back as strings for the caller to place.

## API

Everything arrives through the package's single `.` export. The groups below follow the
modules.

### bootstrap

- `bootstrap(options)` sweeps stale locks once per Harper process and writes the config files;
  when `spawn` is given it also starts each process, launches the reaper and runs each `verify`.
  Returns a `Promise<BootstrapResult>`.

Types: `BootstrapOptions`, `BootstrapProcess` (one process under the guard's care: the sweep
target plus how to start and prove it), `BootstrapReaper` (how the guard's reaper launches;
`false` skips it), `BootstrapResult` (the sweep report, one `ProcessState` per declared process,
and the `ReaperState`).

### The barrier

- `oncePerProcess(dir, key, work, { timeoutMs, identity })` runs `work` once per process and
  blocks sibling threads until it finishes; a thrown `work` unlinks the marker so the next
  thread retries. Returns an `OnceOutcome`.
- `currentProcess()` is the running process's `ProcessIdentity`: pid, the OS-recorded start
  token when the platform has one, and a derived fallback timestamp.

Types: `OnceOutcome`, `ProcessIdentity`.

### The sweep

- `sweepStaleLocks({ pidDir, targets, stopOrphans, stopTimeoutMs })` repairs stale PID locks and
  returns `SweepAction[]` instead of logging. Run it inside `oncePerProcess()`: outside the
  barrier, a sibling thread's fresh healthy process is indistinguishable from an orphan.
- `describeSweep(actions)` renders one line per action, for a caller that logs into Harper's own
  sink.

Types: `SweepAction`, `SweepTarget`.

### Identity

- `identify(pid, binaryPath)` answers `'match'`, `'differs'` or `'unknown'`. Only `'match'` can
  ever justify acting on a process, and `'unknown'` never reads as "not ours".
- `executableOf(pid)` is the executable behind a pid: absolute on Linux, as-invoked on macOS,
  `null` for "cannot tell".
- `isAlive(pid)` says whether some process holds the pid and still runs: a zombie answers
  `kill(pid, 0)` but reads as dead here, since it can be neither signalled nor adopted. EPERM
  counts, since the process exists and is merely another user's.
- `readLock(path)` parses Harper's PID lock into `{ pid, version }`, with Harper's own
  tolerance so the two never disagree, or `null`.

Types: `Identification`.

### The spawn layer

- `assertConstrainedSpawn(spawn, log, hint?)` proves the spawn is Harper's constrained one by
  probing with a command that must not exist, and reports loudly when it is not.
- `fingerprint(...parts)` hashes anything stringifiable into a version number inside 2^31,
  because Harper `parseInt()`s it.
- `preflightBinary(title, binaryPath)` throws for a binary Harper cannot start: a spaced path no
  allowlist entry can match, or a file that is not there.
- `startProcess(spawn, descriptor, { version, log, pidDir, adoptedPollMs })` starts one process
  through Harper's lock and restarts it with backoff after a crash. A thread that loses the lock
  joins the running process instead, and watches it with a liveness poll of its own; given
  `pidDir` it also answers a death no thread on the node owns, by going back through that lock.
  Returns a `ProcessState` that keeps describing what runs.
- `launchReaper(spawn, options)` records each running process in a `<name>.guard.json`
  descriptor beside its lock, then starts the guard's reaper, or says in the returned
  `ReaperState` why it was not; never fatal, since without one the processes merely outlive the
  node. A thread that joins a reaper another thread launched watches it with a liveness poll of
  its own, and a death sets `exited` on the state as well as logging it.

Types: `ConstrainedSpawn`, `GuardLog`, `ManagedProcess`, `ProcessState`, `ReaperState`,
`SpawnedChild`.

### The reaper's test surface

The reaper is spawned as `dist/reaper.js`, never called. These exist so its behaviour is
testable without spawning one:

- `parseReaperArgs(argv)` parses the reaper's command line into `ReaperOptions`.
- `collectReapTargets(options)` merges the launch's argv targets with the `.guard.json`
  descriptors under the pid directory, which is the set the reaper acts on.
- `reapTarget(options, target)` removes one target's lock and descriptor, then stops the process.
- `runReaper(options)` is the watch loop: wait out the node, honour the restart grace, reap.

Types: `ReaperOptions`, `ReapTarget`.

### Helpers

- `readHarperRootPath()` reads Harper's root path the way Harper reads it, boot properties file
  to settings file to `rootPath`; absolute or `null`, never a throw.
- `pollEndpoint({ url, timeoutMs, intervalMs, giveUp, insecureTls })` GETs until something
  answers: the body text, or `null` on deadline or `giveUp()`. It never throws, so a `verify`
  can be a one-line predicate.

## How it works

In order, `bootstrap()` proves the spawn really is Harper's, resolves each binary, sweeps stale
locks once per node behind a barrier, writes the config files atomically, starts each process
through Harper's lock, launches the reaper, and only then runs each `verify`. Each piece below
says why.

### The singleton

Harper's spawn takes a mandatory `name` and backs it with a PID-file lock, `<name>.pid` under
`<rootPath>/pids/`: the pid on line one, the spawn's `version` on line two. A thread that spawns
while the lock names a live process joins that process instead of starting a second one, which
is how a node full of worker threads runs exactly one of each named process; on a version
mismatch Harper replaces the process instead. `fingerprintParts` is what feeds the version:
`bootstrap()` hashes the parts into a number carried on every spawn, so a changed configuration
replaces the process, an unchanged one is adopted, and `harper restart` depends on that adoption
to hand running children to a replacement node.

### Joining a running process

A thread that spawns while the lock names a live process gets an `ExistingProcessWrapper` back
rather than a `ChildProcess`, and the wrapper is distinguishable only by its missing
`spawnargs`. It watches the pid on a one-second interval that nothing unrefs, which pins the
event loop of every thread that joined, so the guard unrefs it. On released Harper versions
`unref()` is implemented as `clearInterval` on that very timer, and once it is cleared the
wrapper's `'exit'` can never fire: kill a joined process and no thread notices, while the status
the component reports still says it is running. Measured in a container, where only an
external delivery probe caught it.

So the guard runs its own poll instead of relying on the wrapper's. It is `unref`'d, so it never
holds a node open, and it reads `isAlive()`, which counts a zombie as dead. That matters here
because nothing `wait()`s a joined process: when the thread that started it is gone, the corpse
keeps answering `kill(pid, 0)` indefinitely.

The restart stays with the thread that started the process, while there is one. That thread holds
the `ChildProcess`, hears its exit immediately, and restarts it from its own backoff; a joining
thread learns of the same death a poll interval later, so the two never race for it and nothing
has to coordinate them.

Ownerless is the state that reasoning missed, and it is the ordinary one after a node restarts
while its sidecars survive: every thread of the new node joins through the lock, so a death is
then seen by all of them and repaired by none. Live verification of the Harper port of this code
found exactly that- a SIGKILLed adopted process stayed dead indefinitely, its stale lock intact,
the component still reporting it as verified. So a joining thread now answers a death that grades
as a crash by going back through Harper's spawn, after the same backoff the owner waits out.
Harper's lock arbitrates, as it already must: `acquirePidFileLock` takes it with
`openSync(path, 'wx')`, so one thread creates the file and starts the replacement while every
other gets the adoption wrapper for what that one started and resumes watching it. One death, one
restart, whatever the thread count.

The attempt cap survives the thread count because it is spent per death seen rather than per
restart won. Every thread watching the process sees the same death and spends one attempt on it,
whether it took the lock or joined the winner's replacement, so the counters move in step and the
node stops restarting after the fifth death rather than after the fifth times the thread count.
The delay is the owner's schedule unchanged: 1s, doubling, capped at 30s.

Reclaiming removes the stale lock first, and only while it still names the pid this thread watched
die. Harper validates a lock with a bare `kill(pid, 0)`, which a dead-but-unreaped process answers,
so a spawn against a corpse's lock hands back a wrapper for the corpse; a sidecar reparented to a
non-reaping init is precisely the ownerless case, and it is where that matters.

A deliberate stop still must not be fought, and a joining thread cannot see one directly: on
released Harper the wrapper's `'exit'` is dead by the time the poll starts, so all it has is a pid
that stopped answering. Three things do tell it. An exit status, when a Harper whose `unref()`
leaves the wrapper polling delivers one: code 0, `SIGTERM`, `SIGINT` and `SIGHUP` read as a stop,
graded exactly as the owner grades them, and nothing follows. The node's own shutdown: the restart
rides an unref'd timer, so a node on its way out never fires it. And the lock, which Harper removes
from the exit of the `ChildProcess` it handed out: a lock still standing over a dead pid means no
thread here saw that exit, and a lock already gone means one did and has made its decision. What
that leaves is an operator stopping a joined process by hand on a node where nothing owns it, which
from in here is indistinguishable from a crash and gets replaced. Remove its lock first, or stop
the component, and it stays stopped.

Any of this needs the pid directory: `bootstrap()` passes what it derived from `pidDir` or
`rootPath`, and a direct `startProcess` call takes `pidDir` itself. Without one a joining thread
cannot tell an ownerless death from an answered one, so it reports the death and restarts nothing.
Whichever route reports it, a death is reported once: a Harper whose `unref()` leaves the wrapper
polling still emits `'exit'`, and both routes settle the same state. The reaper's own launch is
joined the same way and gets the same supervision, described under [The reaper](#the-reaper).

### The sweep

Harper validates a lock by liveness alone: `process.kill(pid, 0)` says something holds the
number, so the lock stands. Nothing checks that the process is the one the lock names. A lock
that outlives its writer is adopted by whoever inherits its pid, the process it names is never
started again, and the component reports success the whole time. The sweep repairs this before
anything spawns. A dead pid's lock is removed. A live process positively identified as something
else loses the lock but is never signalled. An unidentifiable process also loses the lock and is
also not signalled; if it was a real orphan it still holds its ports, which the caller's
liveness check reports. An identified process whose version still matches is left for adoption,
and one whose version moved is an orphan.

Two rules bound it. Nothing is signalled without a positive identification: "not ours" and
"cannot tell" are different answers and only one permits a signal. On Linux identification reads
`/proc/<pid>/exe`, which the kernel fills in. On macOS `ps -o comm=` reports argv[0], which the
examined process chooses: spawning `/bin/sleep` with `argv0` set to a copy named after your
agent makes identification answer `match`. So on macOS a `match` justifies inaction, never a
signal; when the sweep there acts, it acts by removing a lock, never by signalling.

And stopping a process is opt-in: `stopOrphans` defaults to false. Removing a stale lock is what
fixes the adopt-a-stranger defect and it signals nothing, while a signal sent on a wrong
identification cannot be taken back. Leaving an orphan is not leaving it unhandled either,
because Harper's own lock replaces a process whose version no longer matches. The difference is
that Harper does it without checking what it is signalling.

### The barrier

Harper runs worker threads sharing one OS process, and every thread evaluates every component. A
module-level `let done = false` is per-thread and therefore useless, so "do this once for the
node" has no obvious implementation. A file is the only thing all the threads can see.
`oncePerProcess()` claims a marker file with an atomic create-if-absent; the winner runs the
work and marks it done, and every other thread blocks until then, because releasing losers early
just re-opens the race the barrier exists to close. Staleness is judged by process identity
rather than age, since a marker outlives a container on a persistent volume and a restarted
process can reuse the same small pid. Identity comes from the OS, or from Harper's own
`hdb.pid` when `rootPath` names it.

### The reaper

Nothing inside a Harper node survives the node's death: there is no worker shutdown hook, and
SIGKILL fires no handler. So the guard spawns a small process instead of registering one, with
`detached: true`, which puts it in a process group of its own. That is not decoration. A signal
sent to the node's process group, which is what GNU `timeout` does when its deadline expires,
otherwise takes the reaper down alongside everything it exists to outlive, and the locks are
left behind with nothing running to clean them. Nothing else ties the reaper to the node that
launched it either: its stdio is ignored, and the launcher unrefs it so it cannot hold that node
open. It polls the node's pid, and when the pid goes away it waits a grace period for a
replacement to write `hdb.pid`, because `harper restart` forks a new main and the children
should be kept for it to adopt. Only then does it stop them: lock removed first so no worker
adopts a dying pid, SIGTERM, SIGKILL after a grace. Its signal rule is deliberately weaker than
the sweep's: where identification is unavailable it may signal the pid it watched start, which
is first-hand knowledge, but never one read from a file. It needs `rootPath` to locate
`hdb.pid` and the pids directory; without one, `bootstrap()` reports that the processes will
outlive the node.

The reaper is a singleton through its own PID lock, so all but one thread join a running reaper
rather than launching one, and a joined reaper carries the blind spot a joined process does: the
wrapper's `'exit'` cannot fire once `unref()` has cleared its timer. A reaper could therefore die
with nothing on the node noticing, which is the orphan the package exists to prevent, since an
ungracefully killed node leaves its children to whatever reaper is still alive. So the joining
thread runs the same unref'd liveness poll a joined process gets. A death it sees sets `exited`
on the `ReaperState` as well as logging a warning, because the state is what a caller's status
endpoint renders, and a status still reporting `started: true` with a pid for a reaper that died
an hour ago is worse than one that says nothing. Every death warns whatever its cause: the
launching thread can read a signal as someone stopping the reaper on purpose, a joining thread
cannot tell that from a crash, and the children outlive the node either way. Nothing relaunches
a reaper mid-node, the thread that launched it included, so a joining thread is not the special
case here that it was for a joined process: the death is reported, and the next load of the
component launches one once Harper's lock is gone.

The reaper's launch used to pin the targets into argv. That was a gap: when a second component's
launch lost the lock and joined the running reaper, the second component's processes were never
watched. Each launch therefore
records every managed process in a `<name>.guard.json` descriptor beside its lock, written
before the reaper spawn so a launch that merely joins still leaves its record, and the reaper
enumerates the descriptors at reap time instead of trusting argv alone. The argv targets stay
as the seed, so an older reaper binary still reaps what it was launched with. Descriptors are
removed with the locks they sit beside: the sweep takes one when it removes a stale lock, and
the reaper once its target is handled.

### Verify

Each `verify` runs after the reaper launch on purpose. A probe may wait 30 seconds, and a node
killed inside that window must not orphan the children. The verdict lands on that process's
state in the returned status.

## Development

The engines range is `^22.18.0 || >=24.0.0`, the two Node lines Harper v5 declares. From a
checkout:

```sh
npm install
npm test
npm run ci:local
```

`npm test` builds with `tsc`, then runs `node --test "test/**/*.test.js"`. Each CI step also has
its own script in `package.json`, but `npm run ci:local` is the one worth knowing: it extracts
the Test workflow's test-job steps from `test.yml` at run time and runs them in order, so that
job cannot drift from CI (the actionlint job runs only in CI); `--full` adds `npm ci`. CI itself runs the suite on ubuntu and macos, node
22 and 24, because several e2e cases assert different outcomes per platform, and that divergence
is the design, not flake.

## Releasing

A hand-pushed `v*` tag is the only trigger; merging alone ships nothing. On the tag,
`publish.yml` runs the whole Test workflow as its gate, then refuses in two cases before
touching npm: while `package.json` still carries `"private": true` (the refusal message points
at the [Before it ships](#before-it-ships) checklist below), and when the tag names a version
the manifest disagrees with. Past both guards it runs `npm publish --provenance --access
public` with the repository's `NPM_TOKEN` secret; provenance records which commit produced the
tarball. So a release is: empty the checklist, drop the private flag, bump the version, and
push the matching `vX.Y.Z` tag.

## Before it ships

`package.json` carries `"private": true`, and publish.yml refuses a release tag while the flag
stands. It comes off when this list is empty, not before.

- [ ] An integration test against a real node. The suite needs loopback aliases
      `127.0.0.2`-`127.0.0.33`, which Linux routes to `lo` natively and macOS requires be bound
      explicitly, so it belongs on the ubuntu CI runner.
- [ ] A LICENSE file. `package.json` declares Apache-2.0, and the tarball ships only `dist/`
      and this README, so the published package would claim a license it carries no text for.
      Add the Apache-2.0 text at the root and name it in `files`.
- [ ] A decision on exporting `identificationCanAuthoriseSignal()`. It answers whether this
      platform's identification can justify a signal; the sweep and the reaper consult it
      internally, but the package entry does not export it, so a caller composing its own sweep
      cannot ask.
