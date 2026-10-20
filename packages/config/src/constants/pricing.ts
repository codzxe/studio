// @studio/config — credits, plans and pricing, spec §14 (exact numbers).
// Money is kept in integer US cents to avoid float drift on money paths (§12 ledgers).
import { z } from 'zod';

/** 1 credit = $0.10 of list price (§14.1). */
export const CREDIT_PRICE_USD_CENTS = 10;

export function creditsToUsdCents(credits: number): number {
  return Math.round(credits * CREDIT_PRICE_USD_CENTS);
}

export function creditsToUsd(credits: number): number {
  return Math.round(creditsToUsdCents(credits)) / 100;
}

export const PLAN_IDS = ['starter', 'pro', 'business'] as const satisfies readonly string[];
export type PlanId = (typeof PLAN_IDS)[number];

export const PLAN_ID_SCHEMA = z.enum(PLAN_IDS);

const planConfigSchema = z
  .object({
    id: PLAN_ID_SCHEMA,
    monthlyPriceUsdCents: z.number().int().min(0),
    monthlyCredits: z.number().int().min(0),
    // Extra seat +$8 on every plan (§14.1).
    extraSeatPriceUsdCents: z.number().int().min(0),
  })
  .strict();

export type PlanConfig = z.infer<typeof planConfigSchema>;

// §14.1: $30/mo → 100 credits, $60/mo → 250 credits, $120/mo → 600 credits.
const PLANS_TABLE: Record<PlanId, PlanConfig> = {
  starter: {
    id: 'starter',
    monthlyPriceUsdCents: 3000, // $30
    monthlyCredits: 100,
    extraSeatPriceUsdCents: 800, // +$8
  },
  pro: {
    id: 'pro',
    monthlyPriceUsdCents: 6000, // $60
    monthlyCredits: 250,
    extraSeatPriceUsdCents: 800,
  },
  business: {
    id: 'business',
    monthlyPriceUsdCents: 12000, // $120
    monthlyCredits: 600,
    extraSeatPriceUsdCents: 800,
  },
};

export const PLANS_SCHEMA = z
  .object({
    starter: planConfigSchema,
    pro: planConfigSchema,
    business: planConfigSchema,
  })
  .strict();

/** Subscription plans, validated by Zod at import time (fail fast on drift). */
export const PLANS: Record<PlanId, PlanConfig> = PLANS_SCHEMA.parse(PLANS_TABLE);

export function planById(id: PlanId): PlanConfig {
  const plan: PlanConfig | undefined = PLANS[id];
  if (plan === undefined) {
    // Defence for untyped (JS) callers — the type system prevents this in TS.
    throw new Error(`[config] unknown plan: ${id}`);
  }
  return plan;
}

/** Credit packs: $10 per 100 credits, never expiring while subscribed (§14.1). */
export const CREDIT_PACK = {
  credits: 100,
  priceUsdCents: 1000, // $10
} as const;

/** Trial: one-time 30 credits, no card required, one per account (§14.1). */
export const TRIAL_CREDITS = 30;

/** Refund window: 7 days (task §W1-B; aligns with §14.3 payment-grace period). */
export const REFUND_WINDOW_DAYS = 7;

/** §24.4: first retry after OUR provider failure is free — policy constant `retry_grace: 1`. */
export const RETRY_GRACE = 1;

/** §14.2 rule 4: failure after partial progress charges at most HALF the base. */
export const PARTIAL_FAILURE_CHARGE_FRACTION = 0.5;

/** §14.2 rule 7: daily workspace cap defaults to 2× the plan's monthly credits. */
export const DAILY_SPEND_CAP_MULTIPLIER = 2;

/** §14.2 rule 7: alert when daily usage reaches 80% of the cap. */
export const DAILY_CAP_ALERT_FRACTION = 0.8;

export function dailySpendCapCredits(plan: PlanId): number {
  return planById(plan).monthlyCredits * DAILY_SPEND_CAP_MULTIPLIER;
}

/** §14.3: failed payments get a 7-day grace period. */
export const FAILED_PAYMENT_GRACE_DAYS = 7;
/** §14.3: workspace becomes read-only after day 3 of a failed payment. */
export const FAILED_PAYMENT_READONLY_AFTER_DAYS = 3;
/** §14.3: after grace, downgrade to a 15-credit holding state (documents read-only). */
export const FAILED_PAYMENT_HOLDING_CREDITS = 15;
/** §14.3: never delete customer documents for non-payment without 90-day notice. */
export const NONPAYMENT_DELETION_NOTICE_DAYS = 90;
