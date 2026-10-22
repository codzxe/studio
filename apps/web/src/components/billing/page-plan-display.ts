/**
 * Plan display data for the billing page (M6-F).
 *
 * THE GAP (noted in the M6-F worklog): `@studio/config`'s `plans.ts` is the
 * catalog of record (M6-A: names, monthlyPriceCents BUSINESS-PENDING
 * placeholders, seats, allowances) but apps/web CANNOT import it today — the
 * tsconfig `@studio/config` path routes to `src/vendor/studio-config.ts`,
 * which re-exports the brand module ONLY (plans.ts pulls `./errors.js`, a
 * NodeNext `.js`-suffixed import Turbopack cannot resolve, per the shim's
 * header). And `GET /v1/billing/state` — the ONE read — carries the current
 * plan's ENTITLEMENTS but no display names, no price cents and no pricing
 * list for the three paid tiers.
 *
 * Until config becomes importable (or the wire grows a pricing surface), the
 * display layer carries the M6-A catalog values as a LOCAL PIN — the same
 * convention the billing kit already shipped for the pack catalog
 * (`DEFAULT_TOP_UP_PACKS` in topup-flow.tsx: pinned locally, type-checked
 * against the wire). Nothing here gates anything server-side; every
 * entitlement the page renders for the CURRENT plan still comes from the
 * billing state (never this file).
 *
 * BUSINESS-PENDING: the price cents are the M6-A placeholders ($12/$39/$99);
 * real Stripe pricing supersedes them when the pricing wave lands.
 */

import type { PlanId } from "@studio/contracts";

import type { UpgradePlanOption } from "./upgrade-cta";

// ---------------------------------------------------------------------------
// The D-4 pricing list (exactly starter/pro/studio — trial is a state)
// ---------------------------------------------------------------------------

/** Display names per UI_DESIGN_SYSTEM §14 ("Starter", "Pro", "Studio"). */
export const BILLING_PLAN_DISPLAY: readonly UpgradePlanOption[] = [
  {
    planId: "starter",
    name: "Starter",
    // BUSINESS-PENDING: M6-A catalog placeholder ($12/mo).
    priceCents: 1200,
    highlights: ["2 seats", "500 credits/mo"],
  },
  {
    planId: "pro",
    name: "Pro",
    // BUSINESS-PENDING: M6-A catalog placeholder ($39/mo).
    priceCents: 3900,
    highlights: ["5 seats", "2,000 credits/mo"],
  },
  {
    planId: "studio",
    name: "Studio",
    // BUSINESS-PENDING: M6-A catalog placeholder ($99/mo).
    priceCents: 9900,
    highlights: ["15 seats", "10,000 credits/mo"],
  },
] as const satisfies readonly UpgradePlanOption[];

// ---------------------------------------------------------------------------
// Current-plan display (adds the trial state row, D-4)
// ---------------------------------------------------------------------------

export interface CurrentPlanDisplay {
  readonly name: string;
  /** Monthly cents; `null` → the trial never renders a price. */
  readonly priceCents: number | null;
}

/** Display name/price for the EFFECTIVE plan (`BillingState.plan`). */
export const CURRENT_PLAN_DISPLAY: Readonly<Record<PlanId, CurrentPlanDisplay>> = {
  // D-4: trial is a subscription state — "Included during the trial" copy.
  trial: { name: "Trial", priceCents: null },
  starter: { name: "Starter", priceCents: 1200 },
  pro: { name: "Pro", priceCents: 3900 },
  studio: { name: "Studio", priceCents: 9900 },
} as const;

/** Plan-rank for upgrade/downgrade copy decisions (trial is lowest). */
export const PLAN_DISPLAY_RANK: Readonly<Record<PlanId, number>> = {
  trial: -1,
  starter: 0,
  pro: 1,
  studio: 2,
} as const;
