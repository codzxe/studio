import { DbError } from "./errors-lite.js";
import type { LedgerKind } from "./schema.js";

/**
 * Ledger math — pure, unit-tested. Semantics (§8.8, §10.2, documented in
 * schema.ts Section 7):
 *
 *   grant   +N     reserve −N     commit −M     refund +R     adjust ±N
 *
 * - `balance = SUM(amount)` over the workspace ledger.
 * - Reserves deduct pessimistically; `commit` realizes the actual cost ON
 *   TOP of the hold, so a successful settle must release the FULL hold:
 *   refund = outstanding. The run then nets exactly −actual_cost:
 *
 *       −N (reserve) − M (commit) + N (refund) = −M
 *
 *   (Writing refund = N − M double-charges by M: the reserve already
 *   deducted N, and the commit deducts M again — the 2026-10-23 finding
 *   pinned by services/gateway/tests/chat-loop.test.ts.)
 * - Per run:  outstanding = Σ|reserve| − Σrefund − Σ|commit|  (≥ 0).
 *   On success the run nets −actual_cost; on failure/cancel it nets 0
 *   (full refund) — the doc's "refund the difference on success" is the
 *   NET effect (N − M released); the ledger entries realize it by releasing
 *   the full hold while committing the actual cost.
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
    // ROUND-12 (12-w7-r1 BUG-1 fix): commits are NOT subtracted. settle()
    // always refunds the FULL outstanding hold while charging −M on top, so
    // a commit never "consumes" a hold — counting it left a −M ghost after
    // every settle, and the NEXT reserve on the same scope inherited a
    // short refund (1 credit overcharged per multi-turn run; the turn
    // loop settles per turn on one run scope). For the single-settle-per-
    // run world the results are identical (the ghost clamped to 0 either
    // way); for the multi-turn world Σ(reserve−refund) stays exactly 0
    // between turns, so each settle refunds precisely its own hold.
  }
  return Math.max(0, outstanding);
}

/**
 * Split an actual cost against a run's outstanding hold. The commit is
 * capped by the hold; the FULL hold is refunded so the run nets −commit
 * (see the header: balance = SUM, the reserve already deducted).
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
  const refund = outstanding;
  return { commit, refund };
}

/** Idempotency keys are global (schema UNIQUE); derive deterministic sub-keys. */
export function deriveIdempotencyKey(...parts: (string | number)[]): string {
  return parts.map((part) => String(part).replaceAll(":", "%3A")).join(":");
}
