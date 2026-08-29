# harper-process-guard

Process supervision for Harper components that spawn long-lived child processes. One
`bootstrap()` call runs the lifecycle: it sweeps stale PID locks once per node behind a barrier,
writes config files atomically, starts each process from a descriptor list through Harper's
PID-file singleton (keyed by the mandatory spawn `name`), launches a reaper to stop the children
when the node goes away, and then verifies each child by polling an endpoint. It imports `node:`
builtins and nothing else.

## The two problems it solves

Harper hands every component that spawns a long-lived process the same two problems, and solves
neither.

**Worker threads with no primitive between them.** Harper runs worker threads sharing one OS
process, and every thread evaluates every component. A module-level `let done = false` is
per-thread and therefore useless, so "do this once for the node" has no obvious implementation.
A file is the only thing all the threads can see.

**A PID lock that adopts whatever holds a number.** Harper's `spawn` records a bare pid, and on
a later start treats the lock as valid when `process.kill(pid, 0)` says something holds it.
Nothing checks that the process is the one the lock names. A lock that outlives its writer is
adopted by whoever inherits its pid, the process it names is never started again, and the
component reports success the whole time.

Any component that starts an agent, an exporter, a tunnel or a connection to something remote
inherits both. The durable fix belongs upstream in Harper; this package is the part a component
can do for itself.

## Using it

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

In order: it proves the spawn really is Harper's, resolves each binary, sweeps stale locks once
per node behind a barrier, writes the config files atomically, starts each process through
Harper's lock, launches the reaper, and only then runs each `verify`, so a node killed during a
30-second probe cannot orphan the children. The returned status carries the sweep report, one
state per process with the verify verdicts attached, and the reaper's.

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

## Two rules it will not break

**Nothing is signalled without a positive identification.** "Not ours" and "cannot tell" are
different answers and only one permits a signal. On Linux identification reads
`/proc/<pid>/exe`, which the kernel fills in. On macOS `ps -o comm=` reports argv[0], which the
examined process chooses: spawning `/bin/sleep` with `argv0` set to a copy named after your
agent makes identification answer `match`. So macOS may never authorise a signal, and
`identificationCanAuthoriseSignal()` says so.

**Stopping a process is opt-in.** `stopOrphans` defaults to false. Removing a stale lock is what
fixes the adopt-a-stranger defect and it signals nothing, while a signal sent on a wrong
identification cannot be taken back. Leaving an orphan is not leaving it unhandled either,
because Harper's own lock replaces a process whose version no longer matches. The difference is
that Harper does it without checking what it is signalling.

## Before it ships

`package.json` carries `"private": true`, and publish.yml refuses a release tag while the flag
stands. It comes off when this list is empty, not before.

- [ ] An integration test against a real node. The suite needs loopback aliases
      `127.0.0.2`-`127.0.0.33`, which Linux routes to `lo` natively and macOS requires be bound
      explicitly, so it belongs on the ubuntu CI runner.
