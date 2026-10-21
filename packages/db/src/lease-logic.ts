/**
 * Lease logic — pure decision helper for single-writer leases (§9.3, §11).
 * 2-minute heartbeat, 5-minute expiry (§11); the atomic guard is the
 * conditional upsert in src/repos/leases.ts — this helper only classifies.
 */

/** §11: single-writer lease expires after 5 minutes without renewal. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export interface LeaseState {
  readonly userId: string;
  readonly expiresAt: Date;
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
