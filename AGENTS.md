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
- That exclusion holds until the caller's budget runs out, and then it is broken on purpose: nothing
  else bounds `claimLock`, which has no deadline exit of its own. Measured with an exclusive-create
  detector inside `underGate` over 300 rounds of 8 worker threads: 0 overlaps at the 5000ms budget the
  race test uses, and 272 at a 10ms budget, where the deliberate break fires 782 times.
- Nothing is signalled without a positive identification, and "cannot tell" never reads as "not
  ours". An empty expectation identifies nothing. Since 623c59c the rule also covers the lock itself:
  an `unknown` verdict waits for the claim's deadline rather than taking the lock, because taking it
  starts a second process for a pid that is most likely the first.
- The kill path is opt-in and off by default: `stopOrphans`, and launching a reaper at all. Removing
  a stale lock signals nothing and fixes the defect; a signal sent on a wrong identification cannot
  be taken back.
- Identity is the command line, never the executable: `/proc/<pid>/exe` resolves to the interpreter,
  so it is identical for every node script on the box.
- Pid 1 is a process. Inside a container it is usually the host, and treating it as an invalid pid
  reaps a containerised host on sight.
- The reaper removes a lock before signalling what it names, and it is spawned by path, never
  imported.
- That removal is why a joiner whose process died and whose lock is gone must still restart it, if the
  host that owned the lock is dead. The two rules were written apart and contradicted each other until
  3b7ca4d: the reaper removes the lock BECAUSE it expects a survivor to replace the process, and the
  survivor declined BECAUSE the lock was gone, so the node supervised nothing with `restarts` at 0 and
  no error set. A joiner whose owner is still alive stands down; that owner answered the death.
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
mutation-testing tool is wired into this repo - `package.json` carries none - so this is
a manual step on the author, not something CI enforces.

## Layout

Five files under `src/`, plain ESM with `// @ts-check` and JSDoc:

- `identity.js` — one `inspect()` per pid answering liveness and command line together, because on
  darwin each separate question costs a `ps` and these run on every poll. Three platform branches:
  `/proc` on linux, `ps` on darwin, and a PowerShell CIM probe on win32 that costs roughly two orders
  of magnitude more, which is why `inspect` takes `withCommandLine` and `isAlive` passes false. `argvOf` has no caller in
  `src/`: it is the seam a test waits on for a pid to appear in the process table with its command
  line, which `isAlive` cannot express and `identify` can only answer against an expectation.
- `lock.js` — the gate, the adjudication, and the three writes (`claimLock`, `commitLock`,
  `releaseLock`). `adjudicate()` reads the world and changes none of it; the caller signals and
  publishes, so the gate is held for a read, at most one signal, and a rename. Stopping an orphan is
  one SIGTERM, sent inside the gate before the claim overwrites the pid it names, with no wait and no
  escalation: waiting blocked a host's whole startup on a process that might never exit. Nothing on
  the node names that orphan afterwards, and the note the caller gets says so. `safeLockWrite` wraps every
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
if any of those change. The local gate is those commands run directly, `format:check`, `lint`,
`typecheck` and `test`, which is what `test.yml` runs too; `package.test.js` reads that workflow so
neither the platform matrix nor the set of gate commands can drift from what is declared here.

The suites spawn real processes and real worker threads. A fixture must not set `process.title`: the
command line is how instances are identified and counted, and rewriting argv erases the only identity
there is. A fixture that has to survive a signal announces itself on stdout first, because a process
appears in the process table the instant it is exec'd, long before the script that handles the signal
has run.

## Publishing

`publish.yml` fires only on a hand-pushed `v*` tag, runs the full test matrix first, and refuses
while `package.json` carries `"private": true` or when the tag disagrees with the manifest version.
The tarball is the source, so there is no build to run before it.
