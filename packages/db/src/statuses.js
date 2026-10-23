import { DbError } from "./errors-lite.js";
/**
 * Status state machines for agent runs and renders (§7.4, §8.9).
 * Transitions are enforced in the repository layer; every violation is a
 * typed CONFLICT (never a silent overwrite).
 */
const RUN_TRANSITIONS = {
    // "failed" is legal from queued: a refused credit hold or a pre-stream
    // validation failure must never orphan the row as queued (M6-J F-J5 — the
    // run never streamed, so failed is the honest terminal state).
    queued: ["running", "failed", "cancelled"],
    running: ["awaiting_approval", "completed", "failed", "cancelled"],
    awaiting_approval: ["running", "completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
};
const RENDER_TRANSITIONS = {
    queued: ["running", "cancelled"],
    // M8-A: running → queued is the crash-recovery REQUEUE — legal ONLY from
    // `RendersRepo.requeueStale`, which guards it with (attempts < maxAttempts)
    // and a stale heartbeat_at. It is NEVER a public transition: no route or
    // run-of-the-mill repo method may walk a render back to queued, and every
    // other caller gets the typed CONFLICT below as usual.
    running: ["completed", "failed", "cancelled", "queued"],
    completed: [],
    failed: [],
    cancelled: [],
};
export function assertRunTransition(from, to) {
    if (from === to)
        return;
    if (!RUN_TRANSITIONS[from].includes(to)) {
        throw DbError.conflict(`Illegal run transition: ${from} → ${to}`);
    }
}
export function isTerminalRunStatus(status) {
    return RUN_TRANSITIONS[status].length === 0;
}
export function assertRenderTransition(from, to) {
    if (from === to)
        return;
    if (!RENDER_TRANSITIONS[from].includes(to)) {
        throw DbError.conflict(`Illegal render transition: ${from} → ${to}`);
    }
}
export function isTerminalRenderStatus(status) {
    return RENDER_TRANSITIONS[status].length === 0;
}
//# sourceMappingURL=statuses.js.map