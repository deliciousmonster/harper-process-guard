# AGENTS.md

For whoever changes this repository. `README.md` is for whoever uses it.

## Rules that are load-bearing

Each of these was paid for once. `README.md` explains what they protect.

- The lock is decided inside a gate one thread holds at a time and is replaced only by `rename`. Check-then-delete let the second thread's delete take the winner's file: 23 of 300 eight-thread races.
- The exclusion is bounded by the caller's budget and then broken on purpose; nothing else bounds `claimLock`. At the 5000 ms budget the race suite uses, 0 overlaps in 300 rounds; at 10 ms, 272.
- Nothing is signalled without a positive identification, and "cannot tell" never reads as "not ours", for the lock too: an `unknown` verdict waits out the claim rather than taking the lock.
- The kill path is opt-in and off by default: `stopOrphans`, and launching a reaper at all. A signal sent on a wrong identification cannot be taken back.
- Identity is the command line, never the executable, which resolves to the interpreter for every node script.
- Pid 1 is a process. Inside a container it is usually the host.
- The reaper removes a lock before signalling what it names, and is spawned by path, never imported. Because it removes the lock, a joiner whose process died and whose lock is gone must still restart it when the owning host is dead; those two rules contradicted each other until `3b7ca4d`.
- `spawn` comes from the caller. That is what makes the guard testable with a fake and usable by a host that constrains `child_process`.
- A double stands in for an external boundary only. A test that mocks part of `src/` and asserts how the mock was called is not coverage; it has to assert what a real pid, lock or process did.

A green suite is not a review. A change to `lock.js`, `supervise.js` or `reaper.js` gets an adversarial read, and every new or changed test is mutation-checked by hand: revert the production change, see it go red, restore it.

## Layout

Five files under `src/`, ESM with `// @ts-check` and JSDoc, nothing built.

- `identity.js` — one `inspect()` per pid answering liveness and command line together, one branch per platform. The Windows branch costs a PowerShell start, so `isAlive` never asks for the command line.
- `lock.js` — the gate, `adjudicate()` (reads, changes nothing), and the writes: `claimLock`, `commitLock`, `releaseLock`. `safeLockWrite` turns a rejected or superseded write into a message.
- `supervise.js` — start or join, watch, and answer a death by going back through the lock.
- `reaper.js` — the detached script. SIGTERM or SIGINT to it unlinks its own lock first.
- `index.js` — `guard()` and `fingerprint()`, the whole public surface. The reaper is launched before any `verify`: a probe can wait 30 seconds, and a host killed inside that window must not leave its processes behind.

Timings a test needs to wind down live on the context (`tuning`) or in `ReaperOptions`.

## Commands

`npm test` is `node --test`, no build. `npm run typecheck` is `tsc --noEmit`. `test.yml` runs `format:check`, `lint`, `typecheck` and `test` on Linux, macOS and Windows against Node 22 and 24, and `test/unit/package.test.js` reads that workflow so the matrix and the gate cannot drift from what is written here.

Fixtures must not set `process.title`: the command line is the only identity there is. A fixture that has to survive a signal announces itself on stdout first, because it is in the process table before its handler exists.

## Publishing

A hand-pushed `v*` tag runs `publish.yml`: the full matrix, a refusal while `package.json` is private or the tag disagrees with it, a dist-tag derived from the version (the prerelease identifier, or `latest`), then `npm publish` authenticated by the job's OIDC token through the trusted publisher on npmjs.com. No npm token exists on the repository. The tarball is `src/` as written.

## Voice

Comments, commit messages and docs follow `jaxontalk`: no em dashes, no triads, lead with the claim, stop when it lands.
