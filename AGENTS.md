# AGENTS.md

What to know before changing this repository. `README.md` is the documentation for people using
the package; this file is for whoever is editing it.

## What the package is

Process supervision for Harper components that spawn long-lived child processes. Harper adopts
whatever holds a recycled pid, and gives its worker threads no primitive to agree on who does
setup; any component that starts an agent, an exporter, a tunnel or a connection to something
remote inherits both problems. The durable fix belongs upstream in Harper, and this package is
the part a component can do for itself.

## The rules that are load-bearing

None of these are style, and README.md explains each at length:

- Nothing is signalled without positive identification, and "cannot tell" never reads as "not
  ours". macOS identification is argv-spoofable, so it may never authorise a signal.
- The kill path (`stopOrphans`) is opt-in and off by default. Removing a stale lock signals
  nothing and fixes the defect; a signal sent on a wrong identification cannot be taken back.
- Process identity is read from the OS (`/proc/<pid>/stat` start time, `ps -o lstart=`), never
  derived from wall-minus-monotonic clocks, which a clock step moves.
- The reaper is spawned by path, never imported, and its rule is deliberately weaker than the
  sweep's: where identification is unavailable it may signal only the pid it watched start.
- The barrier holds every thread until the work finishes. Releasing losers early protects only
  the winner.

A green suite is not a review here. Each property above can be broken in ways the whole suite
still passes, so a change to the semantics of once.ts, sweep.ts, or reaper.ts gets an
adversarial review before merging.

## Layout and commands

Sources under `src/`, compiled flat to `dist/` (rootDir is `src`, so `src/reaper.ts` emits as
`dist/reaper.js`), tests under `test/`. `spawn.ts` is the orchestrator (spawn, adoption
detection, respawn, reaper launch) and its one structural rule is that the constrained spawn
comes FROM THE CALLER, because Harper grants it only to modules reached by relative import from
the component entry and this package is loaded natively. Do not import child_process here for
anything a component runs. `index.ts` composes it all into the one-call `bootstrap()`, whose
ordering is load-bearing: resolve before the sweep (the sweep needs binary paths to adjudicate
locks), configs after the barrier, the reaper before any verify (a probe can wait 30 seconds,
and a node killed inside that window must not orphan the children). The lifecycle suite has a
MUTATION test on each ordering. `bootstrap()` resolves its own `dist/reaper.js` through
`import.meta.url`, so index.js and reaper.js must stay siblings in `dist/`. `npm test` builds
first. `test/support/harness.js` is scaffolding shared by the suites.

The e2e suite spawns real processes and real worker threads on purpose; a version that mocks
them proves nothing about the interleavings this exists for. It runs on darwin and Linux, and
several cases assert different outcomes per platform. That divergence is the design, not flake.

## Publishing

Not yet. `package.json` carries `"private": true` under the name
`@deliciousmonster/harper-process-guard`, and README.md ends with what has to be true before
the private flag comes off.

The path exists ahead of the decision. `publish.yml` fires only on a hand-pushed `v*` tag, runs
the full test matrix first, and then refuses in two cases: while the private flag stands, and
when the tag disagrees with the manifest version. The first guard is the point, because the
flag is load-bearing and a tag pushed out of habit must bounce off it rather than ship.

`npm run ci:local` executes the test job's own steps, extracted from `test.yml` at run time, so
the local gate and CI cannot drift apart; `test/unit/ci-local.test.js` pins the extraction and
the excuse list.
