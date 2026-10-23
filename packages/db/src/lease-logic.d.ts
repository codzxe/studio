/**
 * Lease logic — pure decision helper for single-writer leases (§9.3, §11).
 * 2-minute heartbeat, 5-minute expiry (§11); the atomic guard is the
 * conditional upsert in src/repos/leases.ts — this helper only classifies.
 *
 * M7 lease UX (BUILD_PLAN §M7 task 3): the same module owns the pure half of
 * the edit-request QUEUE — "Alex is editing; request edit; release on close;
 * expiry". The stateful half lives in src/repos/leases.ts.
 */
/** §11: single-writer lease expires after 5 minutes without renewal. */
export declare const DEFAULT_LEASE_TTL_MS: number;
/**
 * §M7 task 3: at most 20 members may wait for the edit lease of one project;
 * the 21st distinct requester is told the queue is full (typed QUOTA_EXCEEDED
 * upstream — the cap protects the holder from an unbounded takeover list).
 */
export declare const LEASE_REQUEST_QUEUE_CAP = 20;
export interface LeaseState {
    readonly userId: string;
    readonly expiresAt: Date;
}
/** One queued edit request (§M7 task 3 "request edit"). */
export interface LeaseRequestEntry {
    readonly userId: string;
    readonly queuedAt: Date;
}
export type LeaseDecision = {
    readonly action: "acquire";
} | {
    readonly action: "refuse";
    readonly reason: "held-by-other";
    readonly state: LeaseState;
};
export declare function leaseDecision(existing: LeaseState | null, requesterId: string, now: Date): LeaseDecision;
export declare function isLeaseHeld(existing: LeaseState | null, now: Date): boolean;
/** A queue-join decision: dedupe per user first, then the cap. */
export type LeaseQueueDecision = {
    readonly action: "queued";
    readonly entry: LeaseRequestEntry;
    /** 1-based position; 1 = next to be elected (oldest). */
    readonly position: number;
    readonly queueLength: number;
} | {
    readonly action: "duplicate";
    readonly entry: LeaseRequestEntry;
    /** The requester's EXISTING position — re-joining never jumps the line. */
    readonly position: number;
    readonly queueLength: number;
} | {
    readonly action: "full";
    readonly cap: number;
};
/**
 * Classify a join request against the project's ordered queue (oldest
 * first). Dedupe: the same user re-requesting keeps their original position
 * and queuedAt. Cap: a NEW user beyond `cap` distinct waiters is refused.
 */
export declare function queueRequestDecision(entries: readonly LeaseRequestEntry[], userId: string, now: Date, cap?: number): LeaseQueueDecision;
/**
 * The next holder after a release/expiry: the OLDEST queued requester
 * (§M7 task 3 takeover). The caller pops the returned entry from the queue —
 * they are the notified next holder; the acquire itself stays the atomic
 * upsert in repos/leases.ts (fairness is UX, single-writer is the invariant).
 */
export declare function nextHolderOf(entries: readonly LeaseRequestEntry[]): LeaseRequestEntry | null;
