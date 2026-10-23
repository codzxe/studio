/**
 * Plan display data for the billing page (M6-F), DERIVED from
 * `@studio/config` `PLAN_CATALOG` (W5-03) — the catalog of record (M6-A:
 * names, monthlyPriceCents, seats, allowances). The previous version pinned
 * the display rows locally ($12/$39/$99 + "2 seats"/"500 credits/mo") while
 * claiming apps/web could not import the catalog; that stopped being true
 * when the Turbopack shim (src/vendor/studio-config.ts) grew the plans
 * re-export — /pricing (PricingCards) and onboarding (TrialStep) already
 * derive from it. A local second copy is exactly the price drift the stub
 * audit killed (W4-KILL), so this file now derives everything.
 *
 * What stays local: the D-4 shape decisions (exactly starter/pro/studio in
 * the strip; trial renders "Included during the trial", never a price) and
 * `GET /v1/billing/state`'s role as the ONE read for the CURRENT plan's
 * live entitlements — every entitlement the page renders for the current
 * plan still comes from the billing state (never this file).
 *
 * BUSINESS-PENDING: the catalog's monthlyPriceCents are the documented
 * placeholders ($12/$39/$99, packages/config/src/plans.ts); real Stripe
 * pricing supersedes them there and every surface updates together.
 */

import { MICROCREDITS_PER_CREDIT, PLAN_CATALOG, type PaidPlanId } from "@studio/config";
import type { PlanId } from "@studio/contracts";

import { formatCount } from "./page-format";
import type { UpgradePlanOption } from "./upgrade-cta";

// ---------------------------------------------------------------------------
// The D-4 pricing list (exactly starter/pro/studio — trial is a state)
// ---------------------------------------------------------------------------

/** The D-4 display order (the purchasable tiers; PRICING_PAGE_PLANS order). */
const PAID_PLAN_ORDER: readonly PaidPlanId[] = ["starter", "pro", "studio"];

/** "2 seats" / "500 credits/mo" — derived so a catalog change can never drift. */
function planHighlights(id: PaidPlanId): readonly string[] {
  const plan = PLAN_CATALOG[id];
  return [
    `${formatCount(plan.seats)} seats`,
    `${formatCount(plan.monthlyCreditAllowance / MICROCREDITS_PER_CREDIT)} credits/mo`,
  ];
}

/** Display name/price/highlights for the three paid tiers, in D-4 order. */
export const BILLING_PLAN_DISPLAY: readonly UpgradePlanOption[] = PAID_PLAN_ORDER.map((id) => {
  const plan = PLAN_CATALOG[id];
  return {
    planId: id,
    name: plan.name,
    priceCents: plan.monthlyPriceCents,
    highlights: planHighlights(id),
  };
});

// ---------------------------------------------------------------------------
// Current-plan display (adds the trial state row, D-4)
// ---------------------------------------------------------------------------

export interface CurrentPlanDisplay {
  readonly name: string;
  /** Monthly cents; `null` → the trial never renders a price. */
  readonly priceCents: number | null;
}

/**
 * Display name/price for the EFFECTIVE plan (`BillingState.plan`). Paid rows
 * derive from the catalog; the trial row is the D-4 state copy (no price).
 */
export const CURRENT_PLAN_DISPLAY: Readonly<Record<PlanId, CurrentPlanDisplay>> = {
  // D-4: trial is a subscription state — "Included during the trial" copy.
  trial: { name: "Trial", priceCents: null },
  starter: {
    name: PLAN_CATALOG.starter.name,
    priceCents: PLAN_CATALOG.starter.monthlyPriceCents,
  },
  pro: { name: PLAN_CATALOG.pro.name, priceCents: PLAN_CATALOG.pro.monthlyPriceCents },
  studio: {
    name: PLAN_CATALOG.studio.name,
    priceCents: PLAN_CATALOG.studio.monthlyPriceCents,
  },
};
