// @ts-check
// When a proof stops describing the process that is running. The supervisor rewrites `pid` on the same state
// object for the life of the node, so a verdict taken at boot outlives what it proved.

/** True once the process a verdict describes has been replaced. One taken against no pid cannot go stale. */
const staleVerdict = (/** @type {any} */ state) =>
	typeof state?.verifiedPid === 'number' && state.verifiedPid !== state.pid;

/**
 * Record which pid the verdict about to be taken is about, before the proof runs: it polls, and the pid can
 * be replaced while it does.
 *
 * @param {Record<string, any>} state
 */
export function takeVerdictAgainst(state) {
	state.verifiedPid = state.pid ?? null;
	return state;
}

/**
 * The verdict for a process this thread never started, or null when it did. Strictly false, because a
 * supervisor reporting no `started` field at all does have a process.
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
 * Retake a stale verdict rather than reporting none: currentVerdict alone answers `verified: null` for the
 * life of the node, so one chaos restart left a status saying nothing had verified a healthy agent.
 *
 * @param {Record<string, any>} state @param {(state: any) => Promise<{ok: boolean, detail: string}>} [verify]
 */
export async function retakeVerdict(state, verify) {
	// Never taken counts too: a thread whose own spawn was refused carries the node's process and no verdict,
	// and publishing "unverified" for that is the refusal masquerading as health.
	const untaken = state?.started === true && state?.verified === undefined;
	if (!verify || state?.started === false || (!staleVerdict(state) && !untaken)) return currentVerdict(state);
	// Onto the supervisor's own object, the way the first verdict is. A copy served the previous detail beside
	// the new pid, one read in three on 2026-09-09.
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
