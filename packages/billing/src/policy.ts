// @studio/billing — cost resolution and failure/refund policy.
//
// Pure functions only: no storage, no IO, no clocks (AGENTS.md test rules).
// Spec anchors:
//   §5.2   run tiers — quick 1, standard 2, complex 5; premium ×2, max ×4
//   §14.1  model multipliers; image 1024² = 1 credit, HD = 2 credits (per image)
//   §14.2  rule 4 — failure after partial progress charges at most HALF the base
//   §14.2  rule 5 — a failure caused by OUR bug refunds fully
//   §14.4  unit-economics guardrails — "business rules in packages/billing,
//          not afterthoughts"
//   §24.4  first retry caused by our provider failure is free (retry_grace: 1)
//
// All credit amounts are safe integers; money is never a float (§12.2).

import {
  PARTIAL_FAILURE_CHARGE_FRACTION,
  RETRY_GRACE,
  type RunTierId,
  resolveTierConfig,
} from "@studio/config";

// ---------------------------------------------------------------------------
// §5.2 / §14.1 cost resolution
// ---------------------------------------------------------------------------

/**
 * Credits charged for one run of a tier (§5.2, exact):
 * quick 1, standard 2, complex 5, premium = standard×2 = 4, max = standard×4 = 8,
 * image generation 1, image HD 2. Premium/max multiply the STANDARD base — §14.4
 * pins them at 4 and 8 credits. Delegated to @studio/config (single source of
 * truth); the exact table is asserted in tests/policy.test.ts.
 */
export function creditsForRun(tier: RunTierId): number {
  return resolveTierConfig(tier).credits;
}

/**
 * Credits for an image-generation run (§14.1/§14.2 rule 2: "charged per image
 * actually produced"): 1024² = 1 credit each, HD = 2 credits each.
 */
export function creditsForImages(imageCount: number, options: { hd: boolean }): number {
  if (!Number.isSafeInteger(imageCount) || imageCount < 1) {
    // Defence for untyped (JS) callers — the type system prevents this in TS.
    throw new Error("[billing] imageCount must be a positive integer");
  }
  return imageCount * (options.hd ? 2 : 1);
}

// ---------------------------------------------------------------------------
// §14.2 rule 4 / §14.1 partial-charge ceiling
// ---------------------------------------------------------------------------

/**
 * Maximum credits chargeable when a run fails after partial progress (§14.2
 * rule 4: "charge at most half the base, release the rest"). Fractional halves
 * floor down (1 credit held → 0 chargeable), erring towards the customer.
 */
export function maxPartialFailureCharge(reservedCredits: number): number {
  if (!Number.isSafeInteger(reservedCredits) || reservedCredits < 1) {
    throw new Error("[billing] reservedCredits must be a positive integer");
  }
  return Math.floor(reservedCredits * PARTIAL_FAILURE_CHARGE_FRACTION);
}

// ---------------------------------------------------------------------------
// §14.2 rules 3-5 / §24.4 failure classification
// ---------------------------------------------------------------------------

/** Why a run reached a non-committed terminal. */
export const REFUND_CAUSES = [
  "user_cancel", // §14.2 rule 3: cancel before any mutating command.
  "provider_failure", // §24.4: OUR model/image provider failed all retries.
  "our_bug", // §14.2 rule 5: our defect caused the failure — refund fully.
  "engine_crash", // §3.4: engine died mid-run and replay/resume failed.
  "engine_timeout", // §3.4: per-tool/per-run/per-session timeout.
  "engine_error", // §1.5 rule 4: an engine command returned an error.
  "validation_failed", // §5.1: plan/validation blocker ended the run.
  "budget_stop", // §5.2: tier budget exhausted — NOT a failure (clean partial commit).
] as const satisfies readonly string[];

export type RefundCause = (typeof REFUND_CAUSES)[number];

/** What the ledger owes the customer for this terminal. */
export const REFUND_POLICIES = [
  "full_refund",
  "partial",
  "none",
] as const satisfies readonly string[];

export type RefundPolicy = (typeof REFUND_POLICIES)[number];

/**
 * Maps a failure cause to the refund policy (§14.2 rules 3-5, §5.2):
 *
 * - `full_refund` — the reservation releases with zero charge: user cancel
 *   before any mutating command (rule 3), OUR provider failure (§24.4), or
 *   our own bug (rule 5 — refunds fully even after partial progress).
 * - `partial` — a failure after partial progress: charge at most half the
 *   base, release the rest (rule 4). The caller still passes a partial charge
 *   of 0 when no mutating command ran, which lands on rule 3 semantics.
 * - `none` — nothing to refund: a §5.2 budget stop is a clean stop, not a
 *   failure; the run commits its partial work and the hold settles there.
 */
export function classifyRefund(cause: RefundCause): RefundPolicy {
  switch (cause) {
    case "user_cancel":
    case "provider_failure":
    case "our_bug":
      return "full_refund";
    case "engine_crash":
    case "engine_timeout":
    case "engine_error":
    case "validation_failed":
      return "partial";
    case "budget_stop":
      return "none";
  }
}

// ---------------------------------------------------------------------------
// §24.4 retry grace
// ---------------------------------------------------------------------------

/**
 * Whether a retry of a failed run is free (§24.4: "no extra charge for the
 * first retry caused by our provider failure; policy constant retry_grace: 1").
 *
 * `retryAttempt` counts retries of the original run: 1 is the first retry.
 * Only provider failures on OUR side earn grace — a retry after one of our own
 * bugs (§14.2 rule 5) is a normal paid run once the bug is fixed.
 */
export function isFreeRetry(cause: RefundCause, retryAttempt: number): boolean {
  if (!Number.isSafeInteger(retryAttempt) || retryAttempt < 1) {
    return false;
  }
  return cause === "provider_failure" && retryAttempt <= RETRY_GRACE;
}

/** §24.4 policy constant, re-exported for callers computing grace windows. */
export { RETRY_GRACE };

// ---------------------------------------------------------------------------
// §14.4 unit-economics guardrails (alert thresholds — monitoring consumes these)
// ---------------------------------------------------------------------------

/** Alert when a workspace's AI COGS exceeds 35% of its revenue (§14.4). */
export const WORKSPACE_COGS_ALERT_FRACTION = 0.35;

/** Alert when an individual run's cost exceeds its tier's average by 3× (§14.4). */
export const RUN_COST_OUTLIER_MULTIPLIER = 3;

/** Alert when platform-wide COGS exceeds 25% of MRR (§14.4). */
export const PLATFORM_COGS_MRR_FRACTION = 0.25;

/** Integer-cents comparison: cogs/revenue strictly exceeds 35% (§14.4). */
export function workspaceCogsAlertBreached(cogsUsdCents: number, revenueUsdCents: number): boolean {
  if (revenueUsdCents <= 0) {
    return cogsUsdCents > 0;
  }
  return cogsUsdCents * 100 > revenueUsdCents * 35;
}

/** A single run's cost strictly exceeds 3× its tier's average (§14.4). */
export function runCostIsOutlier(runCostUsdCents: number, tierAverageUsdCents: number): boolean {
  if (tierAverageUsdCents <= 0) {
    return runCostUsdCents > 0;
  }
  return runCostUsdCents > tierAverageUsdCents * RUN_COST_OUTLIER_MULTIPLIER;
}

/** Platform-wide COGS strictly exceeds 25% of MRR (§14.4). */
export function platformCogsAlertBreached(cogsUsdCents: number, mrrUsdCents: number): boolean {
  if (mrrUsdCents <= 0) {
    return cogsUsdCents > 0;
  }
  return cogsUsdCents * 4 > mrrUsdCents;
}
