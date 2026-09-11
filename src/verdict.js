// @ts-check
// When a proof stops describing the process that is running.
//
// A verdict is a consumer's own proof that its process does its job, and this package neither takes one nor
// knows what one proves. What it does own is the moment one goes stale: the supervisor rewrites `pid` and
// `restarts` on the same state object for the life of the node, so a verdict taken at boot describes a
// process a chaos restart replaced half an hour ago. Published as current, that reads as a passing health
// check, which is the same shape as the defect this whole package exists for.

/** True once the process a verdict describes has been replaced. One taken against no pid cannot go stale. */
const staleVerdict = (/** @type {any} */ state) =>
	typeof state?.verifiedPid === 'number' && state.verifiedPid !== state.pid;

/**
 * Record which pid the verdict about to be taken is about. Called before the proof runs, because the proof
 * polls and the pid can be replaced while it does.
 *
 * @param {Record<string, any>} state
 */
export function takeVerdictAgainst(state) {
	state.verifiedPid = state.pid ?? null;
	return state;
}

/**
 * The verdict for a process this thread never started, or null when it did start one.
 *
 * Without this a consumer's proof polls on and reads whatever else holds the port. Strictly false, because a
 * supervisor that reports no `started` field at all does have a process.
 *
 * @param {Record<string, any>} state
 */
export const neverStarted = (state) =>
	state?.started === false
		? {
				ok: false,
				detail:
					`this node never started it${state.error ? `: ${state.error}` : ''}, so nothing was polled and ` +
					`anything answering its port belongs to another process`,
			}
		: null;

/**
 * The verdict as it stands now, read at the endpoint rather than stamped at boot.
 *
 * @param {Record<string, any>} state
 */
export const currentVerdict = (state) =>
	staleVerdict(state)
		? {
				...state,
				verified: null,
				verifyDetail:
					`the last verdict was taken against pid ${state.verifiedPid}, which this node has since ` +
					`restarted ${state.restarts} time(s) as pid ${state.pid}. Nothing has verified the process now ` +
					`running; what the dead one proved was: ${state.verifyDetail}`,
			}
		: state;

/**
 * Retake a stale verdict instead of reporting none.
 *
 * currentVerdict alone answers `verified: null` for the life of the node once a process has been replaced, so
 * a single chaos restart left a status saying nothing had verified the running agent thirty minutes later,
 * which is worse than the truth: this thread can still poll the process it now supervises. The verdict stays
 * per-thread; only its staleness is repaired. A verdict already taken against the running pid is returned
 * untouched, so a healthy read costs nothing.
 *
 * @param {Record<string, any>} state @param {(state: any) => Promise<{ok: boolean, detail: string}>} [verify]
 */
export async function retakeVerdict(state, verify) {
	// Stale, or never taken at all: a thread whose own spawn was refused carries the node's process and no
	// verdict of its own, and publishing "unverified" for that is the refusal masquerading as health.
	const untaken = state?.started === true && state?.verified === undefined;
	if (!verify || state?.started === false || (!staleVerdict(state) && !untaken)) return currentVerdict(state);
	// Written back onto the supervisor's own object, the way the first verdict is. A copy looked right and was
	// not: the pid is stamped on the shared state before the proof polls, so the next read saw a verdict that
	// was no longer stale and served the previous detail beside the new pid. Observed on 2026-09-09, one read
	// in three naming the killed pid.
	try {
		const { ok, detail } = await verify(state);
		state.verified = ok;
		state.verifyDetail = detail;
	} catch (error) {
		state.verified = false;
		state.verifyDetail = `retaking the verdict against pid ${state.pid} threw: ${error instanceof Error ? error.message : String(error)}`;
	}
	return state;
}
