import { DbError } from "./errors-lite.js";
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
export function computeReserveAmount(estimatedCredits) {
    if (!Number.isFinite(estimatedCredits) || estimatedCredits < 0) {
        throw DbError.validation("estimatedCredits must be a finite number ≥ 0");
    }
    return Math.max(1, Math.ceil(estimatedCredits * 1.2));
}
export function foldBalance(entries) {
    let balance = 0;
    for (const entry of entries)
        balance += entry.amount;
    return balance;
}
/** Outstanding (un-consumed) hold for a run, clamped at 0. */
export function outstandingReserve(entries) {
    let outstanding = 0;
    for (const entry of entries) {
        if (entry.kind === "reserve")
            outstanding -= entry.amount; // amount is −N
        else if (entry.kind === "refund")
            outstanding -= entry.amount;
        else if (entry.kind === "commit")
            outstanding += entry.amount; // amount is −M
    }
    return Math.max(0, outstanding);
}
/**
 * Split an actual cost against a run's outstanding hold. The commit is
 * capped by the hold; the FULL hold is refunded so the run nets −commit
 * (see the header: balance = SUM, the reserve already deducted).
 */
export function planSettlement(outstanding, actualCost) {
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
export function deriveIdempotencyKey(...parts) {
    return parts.map((part) => String(part).replaceAll(":", "%3A")).join(":");
}
//# sourceMappingURL=ledger-math.js.map