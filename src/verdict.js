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
 * How long a refuted verdict stands before the read path asks again. A retake costs the consumer a probe, and
 * an agent that is genuinely down would otherwise make every status request pay one.
 */
export const RETAKE_INTERVAL_MS = 10_000;

/**
 * Why the verdict on `state` is being retaken, or null when it stands as it is.
 *
 * @param {Record<string, any>} state @param {number} now @param {number} intervalMs
 * @returns {'restarted' | 'untaken' | 'refuted' | null}
 */
function retakeReason(state, now, intervalMs) {
	// A process this thread never started has no proof to retake; anything answering its port is a stranger.
	if (state?.started === false) return null;
	if (staleVerdict(state)) return 'restarted';
	// A thread whose own spawn was refused carries the node's process and no verdict, and publishing
	// "unverified" for that is the refusal masquerading as health.
	if (state?.started === true && state?.verified === undefined) return 'untaken';
	// A proof of health outlives the request that took it: the process proved itself and still holds the pid
	// it proved itself under. A proof of failure does not, because the thing it proves is usually a boot race
	// rather than a property of the process. The security-agent's socket is created by system-probe seconds
	// after the security-agent's own process starts, and on 2026-09-15 three of nine Harper workers polled
	// before it existed: each of those three reported a healthy agent broken for the twelve minutes the
	// container went on living, while the other six reported it up, because nothing here would ask again.
	const asked = state?.verifiedAt;
	if (state?.verified === false && (typeof asked !== 'number' || now - asked >= intervalMs)) return 'refuted';
	return null;
}

/**
 * Retake a verdict that no longer describes the running process rather than reporting none: currentVerdict
 * alone answers `verified: null` for the life of the node, so one chaos restart left a status saying nothing
 * had verified a healthy agent. `reason` reaches the proof, which is the only party that knows what a probe
 * costs: a boot poll can wait 30 s for a process that has just been spawned, and a read-path retake is
 * holding a status request open while it waits.
 *
 * @param {Record<string, any>} state
 * @param {(state: any, context?: {reason: string}) => Promise<{ok: boolean, detail: string}>} [verify]
 * @param {{now?: () => number, intervalMs?: number}} [options]
 */
export async function retakeVerdict(state, verify, { now = Date.now, intervalMs = RETAKE_INTERVAL_MS } = {}) {
	const reason = retakeReason(state, now(), intervalMs);
	if (!verify || reason === null) return currentVerdict(state);
	// Onto the supervisor's own object, the way the first verdict is. A copy served the previous detail beside
	// the new pid, one read in three on 2026-09-09.
	try {
		const { ok, detail } = await verify(state, { reason });
		state.verified = ok;
		state.verifyDetail = detail;
	} catch (error) {
		state.verified = false;
		state.verifyDetail = `retaking the verdict against pid ${state.pid} threw: ${error instanceof Error ? error.message : String(error)}`;
	}
	// After the proof, not before: the interval is between answers, and a proof that waits out its own budget
	// would otherwise be re-entered by every request that arrived while it ran.
	state.verifiedAt = now();
	return state;
}
