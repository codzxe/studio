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
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * §M7 task 3: at most 20 members may wait for the edit lease of one project;
 * the 21st distinct requester is told the queue is full (typed QUOTA_EXCEEDED
 * upstream — the cap protects the holder from an unbounded takeover list).
 */
export const LEASE_REQUEST_QUEUE_CAP = 20;

export interface LeaseState {
  readonly userId: string;
  readonly expiresAt: Date;
}

/** One queued edit request (§M7 task 3 "request edit"). */
export interface LeaseRequestEntry {
  readonly userId: string;
  readonly queuedAt: Date;
}

export type LeaseDecision =
  | { readonly action: "acquire" }
  | { readonly action: "refuse"; readonly reason: "held-by-other"; readonly state: LeaseState };

export function leaseDecision(
  existing: LeaseState | null,
  requesterId: string,
  now: Date,
): LeaseDecision {
  if (existing === null) return { action: "acquire" };
  const held = existing.expiresAt.getTime() > now.getTime();
  if (held && existing.userId !== requesterId) {
    return { action: "refuse", reason: "held-by-other", state: existing };
  }
  // free, expired, or already ours (re-acquire/extend)
  return { action: "acquire" };
}

export function isLeaseHeld(existing: LeaseState | null, now: Date): boolean {
  return existing !== null && existing.expiresAt.getTime() > now.getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// M7 lease UX — edit-request queue (§M7 task 3), pure half
// ─────────────────────────────────────────────────────────────────────────────

/** A queue-join decision: dedupe per user first, then the cap. */
export type LeaseQueueDecision =
  | {
      readonly action: "queued";
      readonly entry: LeaseRequestEntry;
      /** 1-based position; 1 = next to be elected (oldest). */
      readonly position: number;
      readonly queueLength: number;
    }
  | {
      readonly action: "duplicate";
      readonly entry: LeaseRequestEntry;
      /** The requester's EXISTING position — re-joining never jumps the line. */
      readonly position: number;
      readonly queueLength: number;
    }
  | { readonly action: "full"; readonly cap: number };

/**
 * Classify a join request against the project's ordered queue (oldest
 * first). Dedupe: the same user re-requesting keeps their original position
 * and queuedAt. Cap: a NEW user beyond `cap` distinct waiters is refused.
 */
export function queueRequestDecision(
  entries: readonly LeaseRequestEntry[],
  userId: string,
  now: Date,
  cap: number = LEASE_REQUEST_QUEUE_CAP,
): LeaseQueueDecision {
  const existingIndex = entries.findIndex((entry) => entry.userId === userId);
  if (existingIndex !== -1) {
    return {
      action: "duplicate",
      entry: entries[existingIndex] as LeaseRequestEntry,
      position: existingIndex + 1,
      queueLength: entries.length,
    };
  }
  if (entries.length >= cap) {
    return { action: "full", cap };
  }
  const entry: LeaseRequestEntry = { userId, queuedAt: now };
  return {
    action: "queued",
    entry,
    position: entries.length + 1,
    queueLength: entries.length + 1,
  };
}

/**
 * The next holder after a release/expiry: the OLDEST queued requester
 * (§M7 task 3 takeover). The caller pops the returned entry from the queue —
 * they are the notified next holder; the acquire itself stays the atomic
 * upsert in repos/leases.ts (fairness is UX, single-writer is the invariant).
 */
export function nextHolderOf(
  entries: readonly LeaseRequestEntry[],
): LeaseRequestEntry | null {
  return entries[0] ?? null;
}
