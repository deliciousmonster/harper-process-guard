# AGENTS.md

What to know before changing this repository. `README.md` documents the package for people using it;
this file is for whoever is editing it.

## What the package is

One winner per node for a long-lived child process, generic over the binary and over the host. A
host that runs many threads in one OS process and evaluates the same component on each of them
spawns N copies of whatever that component starts, and gives those threads no primitive to agree on
who does it. Harper v5 is the host this was built against; nothing under `src/` knows that, and a
test asserts it stays that way.

## The rules that are load-bearing

None of these are style, and README.md explains each:

- The lock is decided inside a gate one thread holds at a time, and is only ever replaced by
  `rename`. Check-then-delete is two steps, and the second thread's delete takes the file the winner
  just created. Measured: 23 of 300 eight-thread races produced multiple winners that way.
- Nothing is signalled without a positive identification, and "cannot tell" never reads as "not
  ours". An empty expectation identifies nothing.
- The kill path is opt-in and off by default: `stopOrphans`, and launching a reaper at all. Removing
  a stale lock signals nothing and fixes the defect; a signal sent on a wrong identification cannot
  be taken back.
- Identity is the command line, never the executable: `/proc/<pid>/exe` resolves to the interpreter,
  so it is identical for every node script on the box.
- Pid 1 is a process. Inside a container it is usually the host, and treating it as an invalid pid
  reaps a containerised host on sight.
- The reaper removes a lock before signalling what it names, and it is spawned by path, never
  imported.
- `spawn` comes from the caller. That is what makes the guard testable with a fake and usable by a
  host that constrains `child_process`.
- A double stands in for an external boundary (`spawn`, the filesystem, a real child process) and
  its calls are checked as evidence of a real contract, never as a stand-in for this package's own
  logic. A test that mocks a piece of `src/` and asserts only how the mock was called is not
  coverage, however many assertions it has - it has to assert what a real pid, lock file, or process
  state actually did. Audited clean against this once (MOD-17); keep it that way.

A green suite is not a review here. Each property above can be broken in ways a partial suite still
passes, so a change to the semantics of `lock.js`, `supervise.js` or `reaper.js` gets an adversarial
review before merging, and each new or changed test gets mutation-checked by hand: revert the
production change the test exists for, confirm the test goes red, restore it, confirm green. No
mutation-testing tool is wired into this repo - `package.json` and `scripts/` carry none - so this is
a manual step on the author, not something CI enforces.

## Layout

Five files under `src/`, plain ESM with `// @ts-check` and JSDoc:

- `identity.js` — one `inspect()` per pid answering liveness and command line together, because on
  darwin each separate question costs a `ps` and these run on every poll.
- `lock.js` — the gate, the adjudication, and the three writes (`claimLock`, `commitLock`,
  `releaseLock`). `adjudicate()` reads the world and changes none of it, so the gate is held for a
  read and a rename rather than for a signal. Stopping an orphan is one SIGTERM sent after the lock
  is taken, with no wait and no escalation: waiting blocked a host's whole startup on a process that
  might never exit, and stopping properly is the reaper's job. `safeLockWrite` wraps every
  `commitLock`/`releaseLock` call outside this file, turning a rejected write and a resolved `false`
  (the token had already changed hands) alike into a message instead of a silent no-op or an
  unhandled rejection.
- `supervise.js` — start or join, then watch, then answer the death by going back through the lock.
- `reaper.js` — the detached script. Executed directly; its exports exist so a test can drive it
  without spawning one. A SIGTERM or SIGINT sent to the reaper's own pid unlinks its self-lock before
  exiting, same as its natural-completion paths do; Node's default handling of either signal would
  otherwise kill it before that cleanup runs.
- `index.js` — `guard()` and `fingerprint()`, which is the whole public surface. The ordering inside
  `guard()` is load-bearing: the reaper is launched before any `verify`, because a probe can wait 30
  seconds and a host killed inside that window must not leave its processes behind. A test in
  `guard.test.js` holds it there, mutation-checked by hand the same way as everything else here.

Timings that a test needs to wind down live on the context (`tuning`) or in `ReaperOptions`, so no
suite has to wait out a production backoff schedule.

## Commands

`npm test` runs `node --test` with no build. `npm run typecheck` is `tsc --noEmit` and never emits;
there is no `dist/`, no build step and no runtime dependency, and `test/unit/package.test.js` fails
if any of those change. `npm run ci:local` executes the test job's own steps, extracted from
`test.yml` at run time, so the local gate and CI cannot drift; `test/unit/ci-local.test.js` pins the
extraction and the excuse list.

The suites spawn real processes and real worker threads. A fixture must not set `process.title`: the
command line is how instances are identified and counted, and rewriting argv erases the only identity
there is. A fixture that has to survive a signal announces itself on stdout first, because a process
appears in the process table the instant it is exec'd, long before the script that handles the signal
has run.

## Publishing

`publish.yml` fires only on a hand-pushed `v*` tag, runs the full test matrix first, and refuses
while `package.json` carries `"private": true` or when the tag disagrees with the manifest version.
The tarball is the source, so there is no build to run before it.
