import { describe, expect, it } from 'vitest';
import {
  CREDIT_PACK,
  CREDIT_PRICE_USD_CENTS,
  DAILY_CAP_ALERT_FRACTION,
  DAILY_SPEND_CAP_MULTIPLIER,
  FAILED_PAYMENT_GRACE_DAYS,
  FAILED_PAYMENT_HOLDING_CREDITS,
  FAILED_PAYMENT_READONLY_AFTER_DAYS,
  NONPAYMENT_DELETION_NOTICE_DAYS,
  PARTIAL_FAILURE_CHARGE_FRACTION,
  PLANS,
  PLAN_IDS,
  REFUND_WINDOW_DAYS,
  RETRY_GRACE,
  TRIAL_CREDITS,
  creditsToUsd,
  creditsToUsdCents,
  dailySpendCapCredits,
  planById,
  type PlanId,
} from '../src/index.js';

// §14.1 exact numbers.
describe('pricing: definitions (§14.1)', () => {
  it('1 credit = $0.10 of list price', () => {
    expect(CREDIT_PRICE_USD_CENTS).toBe(10);
    expect(creditsToUsd(1)).toBeCloseTo(0.1, 10);
    expect(creditsToUsdCents(1)).toBe(10);
  });

  it('credit math stays exact in cents', () => {
    expect(creditsToUsdCents(5)).toBe(50);
    expect(creditsToUsdCents(250)).toBe(2500);
  });
});

describe('pricing: plans (§14.1)', () => {
  it('$30/mo → 100 credits, $60/mo → 250, $120/mo → 600', () => {
    expect(PLANS.starter).toEqual({
      id: 'starter',
      monthlyPriceUsdCents: 3000,
      monthlyCredits: 100,
      extraSeatPriceUsdCents: 800,
    });
    expect(PLANS.pro.monthlyPriceUsdCents).toBe(6000);
    expect(PLANS.pro.monthlyCredits).toBe(250);
    expect(PLANS.business.monthlyPriceUsdCents).toBe(12000);
    expect(PLANS.business.monthlyCredits).toBe(600);
  });

  it('extra seat is +$8 on every plan', () => {
    for (const id of PLAN_IDS) {
      expect(planById(id).extraSeatPriceUsdCents).toBe(800);
    }
  });

  it('planById is total over PLAN_IDS', () => {
    for (const id of PLAN_IDS) {
      expect(planById(id).id).toBe(id);
    }
  });

  it('monthly credits match the plan price ladder exactly', () => {
    const expected: Record<PlanId, number> = { starter: 100, pro: 250, business: 600 };
    for (const id of PLAN_IDS) {
      expect(planById(id).monthlyCredits).toBe(expected[id]);
    }
  });
});

describe('pricing: packs, trial, refunds, grace (§14.1/§14.2/§14.3/§24.4)', () => {
  it('credit pack: $10 per 100 credits', () => {
    expect(CREDIT_PACK).toEqual({ credits: 100, priceUsdCents: 1000 });
  });

  it('trial: one-time 30 credits', () => {
    expect(TRIAL_CREDITS).toBe(30);
  });

  it('refund window is 7 days', () => {
    expect(REFUND_WINDOW_DAYS).toBe(7);
  });

  it('retry_grace is 1 — first provider-failure retry is free (§24.4)', () => {
    expect(RETRY_GRACE).toBe(1);
  });

  it('partial failure charges at most half the base (§14.2 rule 4)', () => {
    expect(PARTIAL_FAILURE_CHARGE_FRACTION).toBe(0.5);
  });

  it('daily workspace cap defaults to 2× monthly plan credits (§14.2 rule 7)', () => {
    expect(DAILY_SPEND_CAP_MULTIPLIER).toBe(2);
    expect(DAILY_CAP_ALERT_FRACTION).toBe(0.8);
    expect(dailySpendCapCredits('starter')).toBe(200);
    expect(dailySpendCapCredits('pro')).toBe(500);
    expect(dailySpendCapCredits('business')).toBe(1200);
  });

  it('failed payment policy: 7-day grace, read-only after day 3, 15-credit holding, 90-day notice', () => {
    expect(FAILED_PAYMENT_GRACE_DAYS).toBe(7);
    expect(FAILED_PAYMENT_READONLY_AFTER_DAYS).toBe(3);
    expect(FAILED_PAYMENT_HOLDING_CREDITS).toBe(15);
    expect(NONPAYMENT_DELETION_NOTICE_DAYS).toBe(90);
  });
});
