# AGENTS.md

What to know before changing this repository. `README.md` is the documentation for people using
the package; this file is for whoever is editing it.

## What the package is

A safety manager for any Harper plugin that spawns long-running processes. Harper adopts whatever
holds a recycled pid, and gives eight worker threads no primitive to agree on who does setup;
every plugin that starts an agent, an exporter, or a tunnel inherits both problems. This package
is the part a plugin can do for itself while the real fix waits upstream.

Extracted on 2026-08-28 from `../datadog-agent-binary/`, the plugin that found the defect, which
now imports it via `file:../harper-process-guard`. The investigation record behind both is in
`../docs/`; the workspace guide is the `AGENTS.md` one level up.

## The rules that are load-bearing

Three adversarial reviews found this design unsound three times, and the unit tests passed first
every time. What survived is not style, and README.md explains each at length:

- Nothing is signalled without positive identification, and "cannot tell" never reads as "not
  ours". macOS identification is argv-spoofable (measured), so it may never authorise a signal.
- The kill path (`stopOrphans`) is opt-in and off by default. Every serious defect found in this
  module has been in the kill path.
- Process identity is read from the OS (`/proc/<pid>/stat` start time, `ps -o lstart=`), never
  derived from wall-minus-monotonic clocks, which a clock step moves.
- The reaper is spawned by path, never imported, and its rule is deliberately weaker than the
  sweep's: where identification is unavailable it may signal only the pid it watched start.
- The barrier holds every thread until the work finishes. Releasing losers early protects only
  the winner.

Do not let a green suite stand in for a review here. If you change the semantics of once.ts,
sweep.ts, or reaper.ts, run an adversarial review before merging; the suite has never been the
thing that caught the unsoundness.

## Layout and commands

Sources under `src/`, compiled flat to `dist/` (rootDir is `src`, so `src/reaper.ts` emits as `dist/reaper.js`), tests under `test/`. `spawn.ts` is the
orchestrator - spawn, adoption detection, respawn, reaper launch - and its one structural rule is
that the constrained spawn comes FROM THE CALLER, because Harper substitutes it per module graph
and this package is loaded natively. Do not import child_process here for anything a component
runs. `npm test` builds first.
`test/support/harness.js` is shared test scaffolding carried over from the plugin.

The e2e suite spawns real processes and real worker threads on purpose; a version that mocks
them proves nothing about the interleavings this exists for. It runs on darwin and Linux, and
several cases assert different outcomes per platform. That divergence is the design, not flake.

## Publishing

Not yet. `package.json` carries `"private": true` and the name
`@deliciousmonster/harper-process-guard`, which was free on the registry when checked
(2026-08-28). README.md ends with what has to be true before the private flag comes off.
