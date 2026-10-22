// Plans + trial tests (§1.4, §14.1, §14.2 rule 7).
//
// Pricing numbers themselves are owned by @studio/config (Zod-validated at
// import); these tests pin the billing-domain behaviour built on top of them:
// the catalog view, plan gating, the daily-cap policy and the one-time trial.

import type { Failure, Result, RunTierId } from "@studio/config";
import { describe, expect, it } from "vitest";

import {
  PLAN_CATALOG,
  canRunTier,
  dailySpendPolicy,
  seatPlanLimits,
  trialGrant,
  trialGrantKey,
} from "../src/index.js";
import { InMemoryLedgerStore } from "./fakes.js";

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result.value;
}

function expectErr<T>(result: Result<T>): Failure {
  if (result.ok) {
    throw new Error(`expected failure, got ok: ${JSON.stringify(result.value)}`);
  }
  return result;
}

describe("plan catalog (§14.1)", () => {
  it("joins price, credits, seat price and runtime limits per plan", () => {
    expect(PLAN_CATALOG).toEqual([
      {
        code: "starter",
        monthlyPriceUsdCents: 3000, // $30/mo
        monthlyCredits: 100,
        extraSeatPriceUsdCents: 800, // +$8 seat
        seats: 1,
        concurrentRuns: 1,
        concurrentSessions: 1,
        maxCanvasMegapixels: 32,
        dailySpendCapCredits: 200, // §14.2 rule 7: 2× monthly
      },
      {
        code: "pro",
        monthlyPriceUsdCents: 6000, // $60/mo
        monthlyCredits: 250,
        extraSeatPriceUsdCents: 800,
        seats: 3,
        concurrentRuns: 3,
        concurrentSessions: 3,
        maxCanvasMegapixels: 64,
        dailySpendCapCredits: 500,
      },
      {
        code: "business",
        monthlyPriceUsdCents: 12000, // $120/mo
        monthlyCredits: 600,
        extraSeatPriceUsdCents: 800,
        seats: 10,
        concurrentRuns: 6,
        concurrentSessions: 6,
        maxCanvasMegapixels: 128,
        dailySpendCapCredits: 1200,
      },
    ]);
  });
});

describe("seatPlanLimits (§14.1 plan gates)", () => {
  it.each([
    ["starter", 1, 1, 1, 32],
    ["pro", 3, 3, 3, 64],
    ["business", 10, 6, 6, 128],
  ])(
    "%s: seats %d, concurrent runs %d, sessions %d, canvas %d MP",
    (code, seats, runs, sessions, mp) => {
      const limits = expectOk(seatPlanLimits(code));
      expect(limits).toEqual({
        seats,
        concurrentRuns: runs,
        concurrentSessions: sessions,
        maxCanvasMegapixels: mp,
      });
    },
  );

  it("rejects unknown plan codes (subscriptions keep free-text codes)", () => {
    for (const code of ["max", "free", "", "starter "]) {
      const failure = expectErr(seatPlanLimits(code));
      expect(failure.code).toBe("validation_failed");
      expect(failure.hint).toContain("starter");
    }
  });
});

describe("canRunTier (§14.2 rule 1 pre-check)", () => {
  const cases: ReadonlyArray<readonly [number, RunTierId, boolean]> = [
    [0, "quick", false],
    [1, "quick", true],
    [1, "standard", false],
    [2, "standard", true],
    [2, "image_gen_hd", true],
    [4, "complex", false],
    [5, "complex", true],
    [4, "premium", true],
    [8, "max", true],
    [7, "max", false],
    [-1, "quick", false],
  ];
  it.each(cases)("balance %d → %s: %s", (balance, tier, expected) => {
    expect(canRunTier(balance, tier)).toBe(expected);
  });

  it("rejects non-integer balances defensively", () => {
    expect(canRunTier(Number.NaN, "quick")).toBe(false);
    expect(canRunTier(2.5, "quick")).toBe(false);
  });
});

describe("trialGrant (§1.4 one-time, §14.1: 30 credits)", () => {
  it("grants 30 credits once and never again", async () => {
    const store = new InMemoryLedgerStore();

    const first = expectOk(await trialGrant("org-a", store));
    expect(first).toEqual({
      organizationId: "org-a",
      granted: true,
      credits: 30,
      duplicate: false,
    });
    expect(await store.balanceAfter("org-a")).toBe(30);

    // Replay (double-clicked signup, retried webhook) — one-time enforced by
    // the ledger's unique (idempotencyKey, kind) pair.
    const second = expectOk(await trialGrant("org-a", store));
    expect(second).toEqual({
      organizationId: "org-a",
      granted: false,
      credits: 0,
      duplicate: true,
    });
    expect(await store.balanceAfter("org-a")).toBe(30);

    const rows = store.entriesFor("org-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "grant",
      delta: 30,
      idempotencyKey: trialGrantKey("org-a"),
    });
  });

  it("each workspace gets its own one-time grant", async () => {
    const store = new InMemoryLedgerStore();
    expectOk(await trialGrant("org-a", store));
    expectOk(await trialGrant("org-b", store));
    expect(await store.balanceAfter("org-a")).toBe(30);
    expect(await store.balanceAfter("org-b")).toBe(30);
  });

  it("rejects empty organization ids", async () => {
    const store = new InMemoryLedgerStore();
    const failure = expectErr(await trialGrant("", store));
    expect(failure.code).toBe("validation_failed");
    expect(store.size()).toBe(0);
  });
});

describe("dailySpendPolicy (§14.2 rule 7)", () => {
  it.each([
    ["starter", 200, 160],
    ["pro", 500, 400],
    ["business", 1200, 960],
  ])("%s: cap %d, alert at %d (80%)", (code, cap, alertAt) => {
    expect(expectOk(dailySpendPolicy(code))).toEqual({ capCredits: cap, alertAtCredits: alertAt });
  });

  it("rejects unknown plan codes", () => {
    expect(expectErr(dailySpendPolicy("enterprise")).code).toBe("validation_failed");
  });
});
