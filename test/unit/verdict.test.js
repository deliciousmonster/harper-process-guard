// When a consumer's own proof stops being about the running process.
//
// The supervisor rewrites `pid` and `restarts` on the same state object for the life of the node, so a verdict
// taken at boot outlives the process it was taken against. It was published as current anyway until this was
// read at the endpoint instead of stamped at startup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentVerdict, neverStarted, retakeVerdict, takeVerdictAgainst } from '../../src/verdict.js';

/** A state shaped the way the supervisor leaves one. */
const running = (overrides = {}) => ({
	name: 'datadog-agent',
	started: true,
	exited: false,
	restarts: 0,
	pid: 100,
	verified: true,
	verifyDetail: 'it serves expvar on 127.0.0.1:5000',
	verifiedPid: 100,
	...overrides,
});

test('the pid a verdict is about is recorded before the proof runs', () => {
	const state = { pid: 42 };
	takeVerdictAgainst(state);
	assert.equal(/** @type {any} */ (state).verifiedPid, 42);
});

// A state with no pid at all: a verdict against nothing cannot go stale, because it never named a process.
test('a state with no pid records null rather than undefined', () => {
	const state = {};
	takeVerdictAgainst(state);
	assert.equal(/** @type {any} */ (state).verifiedPid, null);
	assert.equal(currentVerdict({ ...state, pid: 999 }).verified, undefined, 'null never reads as stale');
});

test('a verdict taken against the running pid is returned untouched', () => {
	const state = running();
	assert.equal(currentVerdict(state), state, 'a healthy read must cost nothing, not even a copy');
});

// The bug: one chaos restart and the endpoint claimed the dead pid's proof for the live process.
test('NEGATIVE: a verdict taken against a replaced pid is not reported as current', () => {
	const verdict = currentVerdict(running({ pid: 200, restarts: 1, verifiedPid: 100 }));
	assert.equal(verdict.verified, null, 'true here is the dead process vouching for the live one');
	assert.match(verdict.verifyDetail, /taken against pid 100/);
	assert.match(verdict.verifyDetail, /restarted 1 time\(s\) as pid 200/);
	assert.match(verdict.verifyDetail, /what the dead one proved was: it serves expvar/);
});

// `restarts` is this package's own field and a host supervising natively need not keep one. The sentence used
// to interpolate it unguarded, so such a host published "restarted undefined time(s)" to an operator, which
// says nothing except that something here is broken. Staleness is decided by verifiedPid alone, so this is
// reachable without any count at all.
test('a stale verdict reads correctly on a host that keeps no restart count', () => {
	const noCount = running({ pid: 200, verifiedPid: 100 });
	delete noCount.restarts;
	assert.ok(!('restarts' in noCount), 'the state under test must carry no count at all');
	const verdict = currentVerdict(noCount);
	assert.equal(verdict.verified, null, 'the verdict is still stale without a count');
	assert.doesNotMatch(verdict.verifyDetail, /undefined/, 'an absent count must not reach an operator');
	assert.match(verdict.verifyDetail, /which this node has since restarted as pid 200/);
	assert.match(verdict.verifyDetail, /taken against pid 100/);
});

// Written back onto the supervisor's own object rather than onto a copy. A copy looked right and was not: the
// next reader re-derives staleness from that same object, and a retake it cannot see is one it does again.
// The fixture's old verdict is the opposite of the new one, so a write to a copy is visible here.
test('a stale verdict is retaken against the process now running, on the shared state', async () => {
	const state = running({
		pid: 200,
		restarts: 1,
		verifiedPid: 100,
		verified: false,
		verifyDetail: 'the dead one failed',
	});
	/** @type {number[]} */
	const asked = [];
	const verdict = await retakeVerdict(state, async (s) => {
		asked.push(s.pid);
		return { ok: true, detail: `it serves expvar as pid ${s.pid}` };
	});
	assert.deepEqual(asked, [200], 'the proof must be handed the pid the node runs now');
	assert.equal(verdict.verified, true);
	assert.match(verdict.verifyDetail, /as pid 200/);
	assert.equal(state.verified, true, "the retaken verdict went to a copy, not the supervisor's own object");
	assert.match(state.verifyDetail, /as pid 200/);
	assert.equal(verdict, state, 'the caller and the supervisor must be looking at one object');
});

// A copy looked right and was not: verifiedPid is stamped on the shared state before the proof polls, so the
// next read saw a verdict that was no longer stale and served the previous detail beside the new pid.
// Observed 2026-09-09, one read in three naming the killed pid.
test('NEGATIVE: a second read after a retake does not serve the previous detail', async () => {
	const state = running({ pid: 200, restarts: 1, verifiedPid: 100 });
	/** @param {any} s */
	const verify = async (s) => {
		takeVerdictAgainst(s);
		return { ok: true, detail: `polled pid ${s.pid}` };
	};
	await retakeVerdict(state, verify);
	const second = await retakeVerdict(state, verify);
	assert.match(second.verifyDetail, /polled pid 200/);
	assert.doesNotMatch(second.verifyDetail, /taken against pid 100/);
});

// A thread whose own spawn was refused carries the node's process and no verdict of its own. Publishing
// "unverified" for that is the refusal masquerading as a health state.
test('a verdict never taken at all is taken now', async () => {
	const adopted = { name: 'datadog-agent', started: true, restarts: 0, pid: 300, verified: undefined };
	const verdict = await retakeVerdict(adopted, async () => ({ ok: true, detail: 'adopted and serving' }));
	assert.equal(verdict.verified, true);
	assert.match(verdict.verifyDetail, /adopted and serving/);
});

test('a fresh verdict is not retaken', async () => {
	let polled = 0;
	const verdict = await retakeVerdict(running(), async () => {
		polled++;
		return { ok: false, detail: 'should never run' };
	});
	assert.equal(polled, 0, 'a healthy read must not poll the process again');
	assert.equal(verdict.verified, true);
});

test('NEGATIVE: nothing is retaken for a process this thread never started', async () => {
	let polled = 0;
	const state = { name: 'x', started: false, error: 'no binary', restarts: 0, verifiedPid: 100, pid: 200 };
	const verdict = await retakeVerdict(state, async () => {
		polled++;
		return { ok: true, detail: 'never' };
	});
	assert.equal(polled, 0);
	assert.equal(verdict.verified, null, 'a stale read of a never-started process is still stale');
});

test('NEGATIVE: a proof that throws is a failed verdict naming the pid, not a thrown status read', async () => {
	const state = running({ pid: 200, verifiedPid: 100, restarts: 1 });
	const verdict = await retakeVerdict(state, async () => {
		throw new Error('connection reset');
	});
	assert.equal(verdict.verified, false);
	assert.match(verdict.verifyDetail, /retaking the verdict against pid 200 threw: connection reset/);
});

// A proof that answers "no" is a verdict, not the absence of one: publishing null for it would read as
// "nothing has checked" when something has, and said the process is not doing its job.
test('a retake that fails is unverified, not unverdicted', async () => {
	const verdict = await retakeVerdict(running({ pid: 200, verifiedPid: 100, restarts: 1 }), async () => ({
		ok: false,
		detail: 'nothing answered the receiver port',
	}));
	assert.equal(verdict.verified, false);
	assert.equal(verdict.verifyDetail, 'nothing answered the receiver port');
});

// The 2026-09-15 defect. A refuted verdict was durable: staleVerdict only fires when the pid changes, and a
// verdict of `false` taken against a pid that is still running is neither stale nor untaken, so the read path
// handed back the same `false` for the life of the node. The security-agent's socket is created by system-probe
// seconds after the security-agent's own process starts, and three of nine Harper workers polled first: those
// three reported a healthy agent broken for twelve minutes while the other six reported it up.
test('a verdict that said no is asked again, because what it proved was a moment and not the process', async () => {
	const state = running({ verified: false, verifyDetail: 'nothing accepted on the socket yet' });
	let polled = 0;
	const verdict = await retakeVerdict(state, async () => {
		polled++;
		return { ok: true, detail: 'the socket accepts connections now' };
	});
	assert.equal(polled, 1, 'the pid never changed, and that is exactly the case that stayed false forever');
	assert.equal(verdict.verified, true);
	assert.match(verdict.verifyDetail, /accepts connections now/);
});

// The cost of the fix, refused. An agent that is genuinely down is the common case for a standing `false`, and
// re-probing it on every request would put a poll on the critical path of every /DatadogStatus/ read, once per
// process, on every Harper worker.
test('NEGATIVE: a verdict that said no is not re-probed by every reader', async () => {
	const state = running({ verified: false, verifyDetail: 'nothing answered' });
	let polled = 0;
	/** @type {() => Promise<{ok: boolean, detail: string}>} */
	const verify = async () => {
		polled++;
		return { ok: false, detail: 'still nothing answered' };
	};
	let clock = 1_000;
	const options = { now: () => clock, intervalMs: 10_000 };
	await retakeVerdict(state, verify, options);
	clock += 9_999;
	await retakeVerdict(state, verify, options);
	await retakeVerdict(state, verify, options);
	assert.equal(polled, 1, 'three reads inside one interval must cost one probe');
	assert.equal(state.verified, false, 'and the verdict they each read is still the refusal');
});

test('once the interval has passed the refusal is re-probed again', async () => {
	const state = running({ verified: false, verifyDetail: 'nothing answered' });
	let polled = 0;
	/** @param {any} _s */
	const verify = async (_s) => {
		polled++;
		return { ok: polled > 1, detail: polled > 1 ? 'answering now' : 'not yet' };
	};
	let clock = 1_000;
	const options = { now: () => clock, intervalMs: 10_000 };
	await retakeVerdict(state, verify, options);
	clock += 10_000;
	const verdict = await retakeVerdict(state, verify, options);
	assert.equal(polled, 2);
	assert.equal(verdict.verified, true, 'an agent that came up late must be able to be seen coming up');
});

// The proof is the only party that knows what a probe costs, and the two cases want different budgets: a boot
// poll waits 30 s for a process spawned a moment ago, while a read-path retake is holding a status request open.
// Handing every case the same call is what made the 30 s boot budget the retake budget too.
// verifiedAt is a wall clock and can therefore read as being in the future: an NTP correction moves Date.now()
// backwards, and a refusal recorded before the jump would then never reach its interval. That restores the very
// bug this rate limit sits inside, so a clock that went backwards costs one extra probe instead.
test('a clock that went backwards does not make the refusal permanent again', async () => {
	const state = running({ verified: false, verifyDetail: 'nothing answered' });
	let polled = 0;
	/** @type {() => Promise<{ok: boolean, detail: string}>} */
	const verify = async () => {
		polled++;
		return { ok: true, detail: 'answering now' };
	};
	let clock = 100_000;
	const options = { now: () => clock, intervalMs: 10_000 };
	await retakeVerdict(state, verify, options);
	state.verified = false;
	clock -= 30_000;
	const verdict = await retakeVerdict(state, verify, options);
	assert.equal(polled, 2, 'a verifiedAt in the future must not read as an interval that has not elapsed');
	assert.equal(verdict.verified, true);
});

test('the proof is told why it is being asked', async () => {
	/** @type {(string | undefined)[]} */
	const reasons = [];
	/** @param {any} _s @param {any} context */
	const verify = async (_s, context) => {
		reasons.push(context?.reason);
		return { ok: true, detail: 'up' };
	};
	await retakeVerdict(running({ verified: false }), verify);
	await retakeVerdict(running({ pid: 200, verifiedPid: 100, restarts: 1 }), verify);
	await retakeVerdict({ name: 'x', started: true, restarts: 0, pid: 300, verified: undefined }, verify);
	assert.deepEqual(reasons, ['refuted', 'restarted', 'untaken']);
});

test('with no proof to run, the verdict is reported as it stands', async () => {
	const verdict = await retakeVerdict(running({ pid: 200, verifiedPid: 100, restarts: 1 }), undefined);
	assert.equal(verdict.verified, null);
});

test('a process this thread never started has a verdict saying so', () => {
	const verdict = neverStarted({ started: false, error: 'no trace-agent binary' });
	assert.equal(verdict?.ok, false);
	assert.match(verdict?.detail ?? '', /this node never started it: no trace-agent binary/);
	assert.match(verdict?.detail ?? '', /anything answering its port belongs to another process/);
});

// Strictly false, because a supervisor that reports no `started` field at all does have a process, and
// refusing to verify it would publish a healthy node as unproven.
test('NEGATIVE: only an explicit started:false is a process that never started', () => {
	assert.equal(neverStarted({ started: true }), null);
	assert.equal(neverStarted({}), null);
	assert.equal(neverStarted(/** @type {any} */ (undefined)), null);
	assert.equal(neverStarted({ started: /** @type {any} */ (0) }), null, 'falsy is not false here');
});
