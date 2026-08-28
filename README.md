# harper-process-guard

A safety manager for any Harper plugin that spawns long-running processes.

Harper adopts whatever holds a recycled pid, and gives eight worker threads no way to agree on who
does setup. Every plugin that starts an agent, an exporter, a tunnel or a connection to something
remote inherits both, so this is not a Datadog concern that happened to generalise; it is a Harper
concern that Datadog happened to hit first.

Destined to be its own repository and its own package, `@deliciousmonster/harper-process-guard`.
It lives here for now because it was found here, and because the component that found it is the
only thing that has exercised it against a real failure. Nothing in it is Datadog-specific: it
imports `node:` builtins and its own three siblings, and nothing else.

## What it is for

Harper hands every component that spawns a long-lived process the same two problems, and solves
neither.

**Eight worker threads, no primitive between them.** Harper runs worker threads sharing one OS
process, and every thread evaluates every component. A module-level `let done = false` is
per-thread and therefore useless, so "do this once for the node" has no obvious implementation.
A file is the only thing all eight can see.

**A PID lock that adopts whatever holds a number.** Harper's `spawn` records a bare pid, and on
a later start treats the lock as valid when `process.kill(pid, 0)` says something holds it.
Nothing checks that the process is the one the lock names. A lock that outlives its writer is
adopted by whoever inherits its pid, and the process it names is never started again.

That second one is not theoretical. Measured on a live node: `datadog-agent.pid` and
`datadog-trace-agent.pid` both recording pid 964, one trace-agent answering to both names, no
core agent at all, and the component reporting success. It ran that way for three hours. The
only sign was the trace-agent retrying remote-config against a dead `127.0.0.1:5001`, once a
minute, 421 times.

Any component that starts an agent, an exporter, a tunnel or a connection to something remote
inherits both problems. The fix belongs upstream in Harper, where three lines would protect
every component at once. This is the part a component can do for itself in the meantime.

## Using it

From inside a component, after the binaries are resolved and before anything spawns:

```js
const { report } = await bootstrap({
  pidDir: join(harperRootPath(), 'pids'),
  processes: [
    { name: 'datadog-trace-agent', binaryPath: tracePath, version },
    { name: 'datadog-agent', binaryPath: corePath, version },
  ],
});
for (const line of report) log.warn(`my-component: ${line}`);
```

Then spawn as usual, through Harper's own `spawn`. This never spawns anything: Harper's spawn is
what enforces the binary allowlist and takes the lock, and wrapping it would put a second opinion
between a component and the runtime hosting it.

`version` is the same fingerprint you pass to `spawn`, and it matters. Harper adopts a lock whose
version still matches, which is what `harper restart` relies on to hand running children to a
replacement node. Without it the guard cannot tell a process you are about to inherit from one
nobody owns, and stopping the first drops whatever it was carrying.

Nothing here logs. A component's warnings have to reach `hdb.log`, and a package writing to its
own console reaches nobody, so the verdict comes back as strings for the caller to place.

## Two rules it will not break

**Nothing is signalled without a positive identification.** "Not ours" and "cannot tell" are
different answers and only one permits a signal. On Linux identification reads
`/proc/<pid>/exe`, which the kernel fills in. On macOS `ps -o comm=` reports argv[0], which the
examined process chooses: spawning `/bin/sleep` with `argv0` set to a copy named
`datadog-trace-agent` makes identification answer `match`. So macOS may never authorise a
signal, and `identificationCanAuthoriseSignal()` says so.

**Stopping a process is opt-in.** `stopOrphans` defaults to false. Removing a stale lock is what
fixes the adopt-a-stranger defect and it signals nothing; every serious defect ever found in this
module has been in the kill path. Leaving an orphan is not leaving it unhandled either, because
Harper's own lock replaces a process whose version no longer matches. The difference is that
Harper does it without checking what it is signalling.

## The manifest beside this file

`package.json` describes the package this becomes, not where it currently sits: its `exports`
and `files` are relative to a root where these sources are the top level, which is true after
extraction and not before. Nothing resolves through it today, and the parent's build ignores it,
which was checked rather than assumed.

It carries `"private": true` so that an accidental `npm publish` from this directory refuses
rather than shipping something three reviews have found unsound. Remove that line when the list
below is empty, not before.

## Before it moves out

Extraction is mechanical whenever these are true. It is not blocked on coupling, which is
already zero; it is blocked on being something to hand someone else without caveats.

- [x] The reaper, in `reaper.ts`, so this covers a lifetime and not just a start. Its rule is
      deliberately weaker than the sweep's: requiring positive identification everywhere would
      make it refuse to act on macOS and leak a process on every stop, so where identification
      is unavailable it falls back to the pid it watched start, and never to one read from a
      file. Eight tests on both platforms, and the mismatch case takes a different path on each.
- [x] Identity a caller can supply. The derived fallback mixes a wall clock with a monotonic one
      and is reached only on Windows, since Linux and darwin both expose a start token; where it
      is reached, `harperIdentity()` reads hdb.pid instead, which is written once per start and
      read identically by every thread.
- [x] A second consumer. Five tests, including sixteen threads across two components racing in
      one pid directory. Collapsing the marker key back to a constant fails four of them.
- [ ] The supervisor switched onto this reaper. `example/dd-reaper.js` is still its own copy, so
      the drift this file exists to end is not yet ended. That is the next discrete step.
- [ ] An integration test. The blocker turned out to be macOS-only: the suite needs loopback
      aliases `127.0.0.2`-`127.0.0.33`, which macOS requires be bound explicitly and Linux routes
      to `lo` natively, verified by binding `127.0.0.33` in a container with no aliases
      configured. So CI's ubuntu runner can run it; this laptop cannot.

Three adversarial reviews have found this module unsound three times, and each time the tests
passed first. Whatever is done next, do not let a green suite stand in for a review.
