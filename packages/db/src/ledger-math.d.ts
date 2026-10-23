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
export declare function computeReserveAmount(estimatedCredits: number): number;
export declare function foldBalance(entries: readonly {
    amount: number;
}[]): number;
/** Outstanding (un-consumed) hold for a run, clamped at 0. */
export declare function outstandingReserve(entries: readonly {
    kind: LedgerKind;
    amount: number;
}[]): number;
/**
 * Split an actual cost against a run's outstanding hold. The commit is
 * capped by the hold; the FULL hold is refunded so the run nets −commit
 * (see the header: balance = SUM, the reserve already deducted).
 */
export declare function planSettlement(outstanding: number, actualCost: number): {
    commit: number;
    refund: number;
};
/** Idempotency keys are global (schema UNIQUE); derive deterministic sub-keys. */
export declare function deriveIdempotencyKey(...parts: (string | number)[]): string;
