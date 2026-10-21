// @studio/billing — trial workspace rules (W9-B).
//
// Spec anchors:
//   §1.4/§1.5-5  no free tier: the trial is the only free surface, and it is
//                small — trial credits only, run caps, upload caps
//   §14.1        trial = one-time 30 credits, no card, one per account
//                (email + payment-fingerprint dedupe, enforced upstream)
//   §5.2/§14.4   run tiers and credit costs — trials stop at standard (≤ 2 cr)
//   §20.2        per-file upload caps (25 MB / 60 MP), shared by all workspaces
//
// This module owns the POLICY; the grant MECHANICS (idempotent ledger append,
// duplicate suppression) live in ../plans.js (trialGrant). Pure functions only
// — no seams, no IO — so every rule is table-testable.

import {
  TRIAL_CREDITS,
  err,
  ok,
  type PlanLimits,
  type Result,
  type RunTierId,
} from "@studio/config";

// ---------------------------------------------------------------------------
// Grant rules (§14.1)
// ---------------------------------------------------------------------------

/** The one-time trial grant (§14.1: 30 credits, no card, one per account). */
export const TRIAL_GRANT_RULES = {
  /** Credits granted once, at trial start; @studio/config is the source of truth. */
  credits: TRIAL_CREDITS,
  /** One per account — email + payment-fingerprint dedupe (§14.1). */
  oneTime: true,
  /** No card required (§14.1). */
  requiresCard: false,
} as const;

/**
 * Can this account still start a trial? Pre-gate for the signup flow; the
 * idempotent grant itself (and its duplicate suppression) lives in ../plans.js.
 */
export function trialEligibility(input: { readonly alreadyGranted: boolean }): Result<void> {
  if (input.alreadyGranted) {
    return err("conflict", "This account has already used its trial.", {
      hint: "Trials are limited to one per account.",
      retryable: false,
    });
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Trial runtime ladder (policy: the starter ladder, §14.1)
// ---------------------------------------------------------------------------

/**
 * Trial runtime caps (policy): trials run on the starter plan's ladder. The
 * spec fixes no separate trial ladder and §1.5 rule 5 wants the abuse surface
 * small — solo seat, one run, one session, 32 MP canvas.
 */
export const TRIAL_PLAN_LIMITS: PlanLimits = {
  seats: 1,
  concurrentRuns: 1,
  concurrentSessions: 1,
  maxCanvasMegapixels: 32,
};

// ---------------------------------------------------------------------------
// Trial run-tier caps (§5.2)
// ---------------------------------------------------------------------------

/**
 * Highest per-run credit cost a trial may reserve: a standard run (§5.2).
 * §14.4 prices the blocked tiers well above it: complex 5, premium 4, max 8.
 */
export const TRIAL_MAX_RUN_CREDITS = 2;

/**
 * Run tiers a trial workspace may use (§5.2): quick (1 cr), standard (2 cr)
 * and the two image tiers (1/2 cr). complex/premium/max are paid features —
 * rejected with an upgrade hint.
 */
export const TRIAL_ALLOWED_RUN_TIERS = [
  "quick",
  "standard",
  "image_gen",
  "image_gen_hd",
] as const satisfies readonly RunTierId[];

const TRIAL_ALLOWED_RUN_TIER_SET: ReadonlySet<string> = new Set(TRIAL_ALLOWED_RUN_TIERS);

/** Is `tier` available on a trial workspace? */
export function isTrialRunTierAllowed(tier: RunTierId): boolean {
  return TRIAL_ALLOWED_RUN_TIER_SET.has(tier);
}

/** Trial tier gate: paid tiers are rejected with an upgrade hint (§5.2). */
export function checkTrialRunTier(tier: RunTierId): Result<void> {
  if (isTrialRunTierAllowed(tier)) {
    return ok(undefined);
  }
  return err("plan_limit", "This run tier is not available on the trial.", {
    hint: "Trials include quick and standard runs (up to 2 credits). Upgrade to unlock complex, premium and max tiers.",
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// Trial asset caps (§1.5 rule 5)
// ---------------------------------------------------------------------------

/**
 * Trial asset-library cap (policy): the spec fixes per-file caps only
 * (§20.2: 25 MB / 60 MP); the trial additionally caps the NUMBER of assets so
 * a trial workspace cannot become free storage (§1.5 rule 5).
 */
export const TRIAL_MAX_ASSETS = 25;

/**
 * Trial asset-count gate. `countAfterUpload` = assets the library will hold
 * once this upload registers (current + batch), so bulk uploads are checked
 * against the same ceiling as single ones.
 */
export function checkTrialAssetCount(countAfterUpload: number): Result<void> {
  if (!Number.isSafeInteger(countAfterUpload) || countAfterUpload < 0) {
    return err("validation_failed", "Invalid asset count.", {
      hint: "The asset count must be a non-negative integer.",
      retryable: false,
    });
  }
  if (countAfterUpload > TRIAL_MAX_ASSETS) {
    return err("plan_limit", "Trial asset library is full.", {
      hint: `Trials hold up to ${TRIAL_MAX_ASSETS} assets. Delete assets you no longer need or upgrade.`,
      retryable: false,
    });
  }
  return ok(undefined);
}
