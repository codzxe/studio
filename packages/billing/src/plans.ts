// @studio/billing — plans, plan gating and the trial grant.
//
// Spec anchors:
//   §1.4   non-goals — NO free tier; new accounts get a one-time trial credit
//           grant (e.g. 30 credits), then it is a paid plan, "no unlimited
//           free users, ever"
//   §14.1  plan catalog — $30/mo → 100 credits, $60/mo → 250, $120/mo → 600;
//           extra seat +$8; plan differences: seats 1/3/10, concurrent runs
//           1/3/6, max canvas 32/64/128 MP
//   §14.2  rule 7 — daily workspace cap (default 2× monthly plan credits),
//           alert at 80%
//
// Pricing numbers live in @studio/config (single source of truth, Zod-validated
// at import); this module adds the billing-domain behaviour on top.
//
// NOTE (contract): the task sketch named the export `PLAN_PRICING` with plans
// starter/pro/max; @studio/config (W1-B) actually exports `PLANS` with plan ids
// `starter` / `pro` / `business` and per-plan `extraSeatPriceUsdCents`.
// `max` is a RUN TIER (§5.2), not a plan. Adjusted accordingly.

import {
  CREDIT_PACK,
  DAILY_CAP_ALERT_FRACTION,
  PLAN_ID_SCHEMA,
  PLAN_IDS,
  PLAN_LIMITS,
  PLANS,
  TRIAL_CREDITS,
  dailySpendCapCredits,
  err,
  ok,
  type PlanId,
  type PlanLimits,
  type Result,
  type RunTierId,
} from "@studio/config";
import { z } from "zod";

import type { LedgerStore } from "./ledger.js";
import { creditsForRun } from "./policy.js";

// Re-exported so billing consumers can import the whole money surface from
// "@studio/billing" alone.
export {
  CREDIT_PACK,
  PLAN_IDS,
  PLAN_LIMITS,
  PLANS,
  TRIAL_CREDITS,
  dailySpendCapCredits,
};
export type { PlanId, PlanLimits };

// ---------------------------------------------------------------------------
// §14.1 plan catalog view (price + limits + daily cap, joined)
// ---------------------------------------------------------------------------

/** Everything the billing pages and the gateway need about one plan. */
export interface PlanView {
  readonly code: PlanId;
  readonly monthlyPriceUsdCents: number;
  readonly monthlyCredits: number;
  readonly extraSeatPriceUsdCents: number;
  readonly seats: number;
  readonly concurrentRuns: number;
  readonly concurrentSessions: number;
  readonly maxCanvasMegapixels: number;
  readonly dailySpendCapCredits: number;
}

/** Joins the pricing table with the runtime limits table (§14.1 + §14.2 r7). */
export function planView(code: PlanId): PlanView {
  const pricing = PLANS[code];
  const limits = PLAN_LIMITS[code];
  return {
    code,
    monthlyPriceUsdCents: pricing.monthlyPriceUsdCents,
    monthlyCredits: pricing.monthlyCredits,
    extraSeatPriceUsdCents: pricing.extraSeatPriceUsdCents,
    seats: limits.seats,
    concurrentRuns: limits.concurrentRuns,
    concurrentSessions: limits.concurrentSessions,
    maxCanvasMegapixels: limits.maxCanvasMegapixels,
    dailySpendCapCredits: dailySpendCapCredits(code),
  };
}

/** The full catalog, in stable §14.1 order. */
export const PLAN_CATALOG: readonly PlanView[] = PLAN_IDS.map((code) => planView(code));

// ---------------------------------------------------------------------------
// Plan gating helpers
// ---------------------------------------------------------------------------

/**
 * Whether the workspace's available balance covers one run of the tier
 * (§14.2 rule 1 pre-check; reserveCredits enforces it authoritatively).
 * `balance` is the available balance — grants minus committed spends minus
 * open holds.
 */
export function canRunTier(balance: number, tier: RunTierId): boolean {
  return Number.isSafeInteger(balance) && balance >= creditsForRun(tier);
}

/**
 * The plan-gated limits for a subscription's plan code (§14.1): seats,
 * concurrent runs/sessions and max canvas. Subscription rows keep the code as
 * free text (packages/db billing.ts), so it is validated here at the boundary.
 */
export function seatPlanLimits(planCode: string): Result<PlanLimits> {
  const parsed = PLAN_ID_SCHEMA.safeParse(planCode);
  if (!parsed.success) {
    return err("validation_failed", `Unknown plan code.`, {
      hint: `Expected one of: ${PLAN_IDS.join(", ")}.`,
    });
  }
  return ok(PLAN_LIMITS[parsed.data]);
}

/**
 * §14.2 rule 7: the daily workspace cap (default 2× the plan's monthly
 * credits) that stops runaway loops, and the 80% alert threshold.
 */
export interface DailySpendPolicy {
  readonly capCredits: number;
  readonly alertAtCredits: number;
}

export function dailySpendPolicy(planCode: string): Result<DailySpendPolicy> {
  const parsed = PLAN_ID_SCHEMA.safeParse(planCode);
  if (!parsed.success) {
    return err("validation_failed", `Unknown plan code.`, {
      hint: `Expected one of: ${PLAN_IDS.join(", ")}.`,
    });
  }
  const capCredits = dailySpendCapCredits(parsed.data);
  return ok({
    capCredits,
    alertAtCredits: Math.floor(capCredits * DAILY_CAP_ALERT_FRACTION),
  });
}

// ---------------------------------------------------------------------------
// §1.4 / §14.1 trial grant — one-time, no free tier
// ---------------------------------------------------------------------------

const trialOrgSchema = z.string().min(1).max(200);

/** §14.2 rule 6: the trial grant's stable idempotency key, one per workspace. */
export function trialGrantKey(organizationId: string): string {
  return `trial-grant:${organizationId}`;
}

export interface TrialGrantOutcome {
  readonly organizationId: string;
  /** False when the trial was already consumed — nothing was granted. */
  readonly granted: boolean;
  /** Credits granted by THIS call (0 on the duplicate path). */
  readonly credits: number;
  readonly duplicate: boolean;
}

/**
 * Grants the one-time trial credits (§1.4: "no free tier … one-time trial
 * credit grant"; §14.1: 30 credits, no card required, one per account).
 *
 * One-time enforcement is the ledger's unique (idempotencyKey, kind) pair: the
 * second call for the same workspace is a no-op that grants nothing, so a
 * double-clicked signup or a replayed webhook can never mint trial credits
 * twice. The caller is expected to also dedupe on email + payment fingerprint
 * at account creation (§14.1); the ledger key is the last line of defence.
 */
export async function trialGrant(
  organizationId: string,
  ledger: LedgerStore,
): Promise<Result<TrialGrantOutcome>> {
  const parsed = trialOrgSchema.safeParse(organizationId);
  if (!parsed.success) {
    return err("validation_failed", "Trial grant needs an organization id.", {
      hint: "organizationId must be a non-empty string.",
    });
  }
  const orgId = parsed.data;
  const key = trialGrantKey(orgId);

  if (await ledger.findByIdempotency(key, "grant")) {
    return ok({ organizationId: orgId, granted: false, credits: 0, duplicate: true });
  }

  await ledger.append({
    organizationId: orgId,
    delta: TRIAL_CREDITS,
    kind: "grant",
    idempotencyKey: key,
    note: "one-time trial grant (§1.4: no free tier)",
  });
  return ok({ organizationId: orgId, granted: true, credits: TRIAL_CREDITS, duplicate: false });
}
