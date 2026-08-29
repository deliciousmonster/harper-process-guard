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

Without `spawn` the call is the sweep alone, and never starts anything: Harper's spawn is what
enforces the binary allowlist and takes the lock, and the caller keeps composing the rest
itself.

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

- `bootstrap(options)` sweeps stale locks once per Harper process, then, when `spawn` is given,
  writes the config files, starts each process, launches the reaper and runs each `verify`.
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
- `isAlive(pid)` says whether some process holds the pid; EPERM counts, since the process
  exists and is merely another user's.
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
- `startProcess(spawn, descriptor, { version, log })` starts one process through Harper's lock,
  detects adoption, and restarts it with backoff after a crash. Returns a `ProcessState` that
  keeps describing what runs.
- `launchReaper(spawn, options)` starts the guard's reaper, or says in the returned
  `ReaperState` why it was not; never fatal, since without one the processes merely outlive the
  node.

Types: `ConstrainedSpawn`, `GuardLog`, `ManagedProcess`, `ProcessState`, `ReaperState`,
`SpawnedChild`.

### The reaper's test surface

The reaper is spawned as `dist/reaper.js`, never called. These exist so its behaviour is
testable without spawning one:

- `parseReaperArgs(argv)` parses the reaper's command line into `ReaperOptions`.
- `reapTarget(options, target)` removes one target's lock, then stops the process.
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
signal, and the sweep there removes locks without stopping anything.

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
SIGKILL fires no handler. So the guard spawns a small detached process instead of registering
one. It polls the node's pid, and when the pid goes away it waits a grace period for a
replacement to write `hdb.pid`, because `harper restart` forks a new main and the children
should be kept for it to adopt. Only then does it stop them: lock removed first so no worker
adopts a dying pid, SIGTERM, SIGKILL after a grace. Its signal rule is deliberately weaker than
the sweep's: where identification is unavailable it may signal the pid it watched start, which
is first-hand knowledge, but never one read from a file. It needs `rootPath` to locate
`hdb.pid` and the pids directory; without one, `bootstrap()` reports that the processes will
outlive the node.

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
the Test workflow's steps from `test.yml` at run time and runs them in order, so the local gate
cannot drift from CI; `--full` adds `npm ci`. CI itself runs the suite on ubuntu and macos, node
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
