import { DbError } from "./errors-lite.js";
import type { LedgerKind } from "./schema.js";

/**
 * Ledger math — pure, unit-tested. Semantics (§8.8, §10.2, documented in
 * schema.ts Section 7):
 *
 *   grant   +N     reserve −N     commit −M     refund +R     adjust ±N
 *
 * - `balance = SUM(amount)` over the workspace ledger.
 * - Reserves deduct pessimistically; `commit` realizes the actual cost;
 *   `refund` releases the unspent remainder of a hold.
 * - Per run:  outstanding = Σ|reserve| − Σrefund − Σ|commit|  (≥ 0).
 *   On success the run nets −actual_cost (commit M + refund N−M against a
 *   reserve of N); on failure/cancel it nets 0 (full refund) — exactly the
 *   doc's "refund the difference on success; refund the full reserve on
 *   failure/cancel".
 */

/** §8.8: reserve = ceil(estimated × 1.2), minimum 1. */
export function computeReserveAmount(estimatedCredits: number): number {
  if (!Number.isFinite(estimatedCredits) || estimatedCredits < 0) {
    throw DbError.validation("estimatedCredits must be a finite number ≥ 0");
  }
  return Math.max(1, Math.ceil(estimatedCredits * 1.2));
}

export function foldBalance(entries: readonly { amount: number }[]): number {
  let balance = 0;
  for (const entry of entries) balance += entry.amount;
  return balance;
}

/** Outstanding (un-consumed) hold for a run, clamped at 0. */
export function outstandingReserve(
  entries: readonly { kind: LedgerKind; amount: number }[],
): number {
  let outstanding = 0;
  for (const entry of entries) {
    if (entry.kind === "reserve")
      outstanding -= entry.amount; // amount is −N
    else if (entry.kind === "refund") outstanding -= entry.amount;
    else if (entry.kind === "commit") outstanding += entry.amount; // amount is −M
  }
  return Math.max(0, outstanding);
}

/**
 * Split an actual cost against a run's outstanding hold:
 * commit is capped by the hold; the remainder is refunded.
 */
export function planSettlement(
  outstanding: number,
  actualCost: number,
): {
  commit: number;
  refund: number;
} {
  if (!Number.isFinite(outstanding) || outstanding < 0) {
    throw DbError.validation("outstanding must be ≥ 0");
  }
  if (!Number.isFinite(actualCost) || actualCost < 0) {
    throw DbError.validation("actualCost must be ≥ 0");
  }
  const commit = Math.min(Math.ceil(actualCost), outstanding);
  const refund = Math.max(0, outstanding - commit);
  return { commit, refund };
}

/** Idempotency keys are global (schema UNIQUE); derive deterministic sub-keys. */
export function deriveIdempotencyKey(...parts: (string | number)[]): string {
  return parts.map((part) => String(part).replaceAll(":", "%3A")).join(":");
}
