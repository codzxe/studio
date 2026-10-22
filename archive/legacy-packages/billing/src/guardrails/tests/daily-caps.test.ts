// Daily spend caps + workspace kill switch (§18.4/§14.2 r7/§22): the caps
// table and its §18.4 derivation, UTC reset windows, the DailySpendGuard over
// in-memory seams (ordering, hints, fail-open), and the 80% alert hook.
// Table-driven where pure (AGENTS.md).

import {
  CREDIT_PRICE_USD_CENTS,
  DAILY_SPEND_CAP_MULTIPLIER,
  PLANS,
  PLAN_IDS,
  TRIAL_CREDITS,
} from "@studio/config";
import { describe, expect, it } from "vitest";
import {
  type DailyCapFacts,
  DailySpendGuard,
  EXPECTED_COGS_SHARE,
  PLAN_DAILY_SPEND_CAP_USD_CENTS,
  TRIAL_DAILY_SPEND_CAP_USD_CENTS,
  dailySpendAlertThresholdUsdCents,
  dailySpendCapUsdCents,
  deriveDailyCapUsdCents,
  isDailySpendAlertDue,
  nextUtcMidnightIso,
  utcDayKey,
} from "../daily-caps.js";
import { DEMO_ORG_ID, GUARDRAIL_ERROR_CODES, guardrailCodeToErrorCode } from "../index.js";
import { InMemoryDailySpendSeams, atUtc, expectErr, expectOk } from "./fakes.js";

const ORG = "org_1";
const CAP = PLAN_DAILY_SPEND_CAP_USD_CENTS.starter; // 600 = $6.00/day

function makeGuard(init: { spend?: number; disabled?: boolean } = {}): {
  guard: DailySpendGuard;
  seams: InMemoryDailySpendSeams;
} {
  const seams = new InMemoryDailySpendSeams(atUtc("2027-03-14"));
  if (init.spend !== undefined) {
    seams.spend.set(ORG, init.spend);
  }
  if (init.disabled) {
    seams.disabled.add(ORG);
  }
  return { guard: new DailySpendGuard(seams), seams };
}

// ---------------------------------------------------------------------------
// The caps table + §18.4 derivation
// ---------------------------------------------------------------------------

describe("per-plan daily spend caps table (§18.4)", () => {
  it("pins the table: starter $6.00/day, pro $15.00, business $36.00", () => {
    expect(PLAN_DAILY_SPEND_CAP_USD_CENTS.starter).toBe(600);
    expect(PLAN_DAILY_SPEND_CAP_USD_CENTS.pro).toBe(1500);
    expect(PLAN_DAILY_SPEND_CAP_USD_CENTS.business).toBe(3600);
  });

  it("derives the table from config: monthlyCredits × 2 (r7) × $0.10 (§14.1) × 30% COGS (§14.4), rounded", () => {
    // Fails loudly if @studio/config plan credits drift without the caps
    // table following (the §26.3 "Budget caps set?" derivation).
    for (const plan of PLAN_IDS) {
      const expected = deriveDailyCapUsdCents(PLANS[plan].monthlyCredits);
      expect(PLAN_DAILY_SPEND_CAP_USD_CENTS[plan]).toBe(expected);
      expect(expected).toBe(
        Math.round(
          PLANS[plan].monthlyCredits *
            DAILY_SPEND_CAP_MULTIPLIER *
            CREDIT_PRICE_USD_CENTS *
            EXPECTED_COGS_SHARE,
        ),
      );
    }
  });

  it("starter cap is the $6.00/day equivalent: 100 credits → 2×100 × $0.10 × 30% = $6", () => {
    expect(deriveDailyCapUsdCents(100)).toBe(600);
  });

  it("trial cap uses the same derivation on the one-time 30-credit grant → $1.80/day", () => {
    expect(TRIAL_DAILY_SPEND_CAP_USD_CENTS).toBe(180);
    expect(TRIAL_DAILY_SPEND_CAP_USD_CENTS).toBe(deriveDailyCapUsdCents(TRIAL_CREDITS));
  });

  it("rejects invalid monthlyCredits (defence for untyped callers)", () => {
    expect(() => deriveDailyCapUsdCents(-1)).toThrow();
    expect(() => deriveDailyCapUsdCents(1.5)).toThrow();
  });

  const planCodeRows = [
    { planCode: "starter", expected: 600 },
    { planCode: "pro", expected: 1500 },
    { planCode: "business", expected: 3600 },
    { planCode: "max", expected: 3600 }, // catalog alias (limits-service precedent)
    { planCode: "trial", expected: 180 },
    { planCode: "unknown-plan", expected: "validation_failed" },
    { planCode: "", expected: "validation_failed" },
  ] as const;

  for (const row of planCodeRows) {
    it(`dailySpendCapUsdCents(${JSON.stringify(row.planCode)}) → ${String(row.expected)}`, () => {
      const result = dailySpendCapUsdCents(row.planCode);
      if (row.expected === "validation_failed") {
        expect(expectErr(result).code).toBe("validation_failed");
      } else {
        expect(expectOk(result)).toBe(row.expected);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Reset windows (UTC day boundaries, §12 usage_daily)
// ---------------------------------------------------------------------------

describe("UTC reset windows", () => {
  const rows = [
    { iso: "2027-03-14", time: "T09:41:12.999Z", expected: "2027-03-15T00:00:00.000Z" },
    { iso: "2027-02-28", time: "T23:59:59.999Z", expected: "2027-03-01T00:00:00.000Z" }, // month rollover
    { iso: "2027-12-31", time: "T12:00:00.000Z", expected: "2028-01-01T00:00:00.000Z" }, // year rollover
    { iso: "2027-03-14", time: "T00:00:00.000Z", expected: "2027-03-15T00:00:00.000Z" }, // exact midnight = fresh window
  ];
  for (const row of rows) {
    it(`nextUtcMidnightIso(${row.iso}${row.time}) → ${row.expected}`, () => {
      expect(nextUtcMidnightIso(new Date(row.iso + row.time).getTime())).toBe(row.expected);
    });
  }

  it("utcDayKey returns the §12 rollup day key (YYYY-MM-DD)", () => {
    const late = new Date("2027-03-14T23:59:59.999Z").getTime();
    const early = new Date("2027-03-14T00:00:00.000Z").getTime();
    expect(utcDayKey(late)).toBe("2027-03-14");
    expect(utcDayKey(early)).toBe("2027-03-14");
    expect(utcDayKey(new Date("2027-03-15T00:00:00.000Z").getTime())).toBe("2027-03-15");
  });
});

// ---------------------------------------------------------------------------
// DailySpendGuard.enforceDailyCap
// ---------------------------------------------------------------------------

describe("DailySpendGuard.enforceDailyCap (§18.4 hard cap)", () => {
  it("allows a run under the cap and reports facts for headers/telemetry", async () => {
    const { guard, seams } = makeGuard({ spend: 120 });
    const facts = expectOk(await guard.enforceDailyCap(ORG, { capUsdCents: CAP }));
    expect(facts).toEqual({
      spentUsdCents: 120,
      capUsdCents: 600,
      remainingUsdCents: 480,
      resetAtIso: "2027-03-15T00:00:00.000Z",
    });
    expect(seams.calls.spendToday).toBe(1);
    expect(seams.calls.isDisabled).toBe(1);
  });

  it("blocks at exactly the cap with typed cost_cap_reached + reset-at hint", async () => {
    const { guard } = makeGuard({ spend: CAP });
    const failure = expectErr(await guard.enforceDailyCap(ORG, { capUsdCents: CAP }));
    expect(failure.code).toBe("cost_cap_reached");
    expect(failure.retryable).toBe(true);
    expect(failure.resetAtIso).toBe("2027-03-15T00:00:00.000Z");
    expect(failure.hint).toContain("$6.00");
    expect(failure.hint).toContain("2027-03-15T00:00:00.000Z");
  });

  it("blocks above the cap, and a $0 cap blocks all spend", async () => {
    const over = expectErr(
      await makeGuard({ spend: CAP + 1 }).guard.enforceDailyCap(ORG, { capUsdCents: CAP }),
    );
    expect(over.code).toBe("cost_cap_reached");
    const zero = expectErr(await makeGuard().guard.enforceDailyCap(ORG, { capUsdCents: 0 }));
    expect(zero.code).toBe("cost_cap_reached");
    expect(zero.hint).toContain("$0.00");
  });

  it("rejects invalid inputs before touching any seam", async () => {
    const { guard, seams } = makeGuard();
    for (const bad of ["", "x".repeat(201)]) {
      const failure = expectErr(await guard.enforceDailyCap(bad, { capUsdCents: CAP }));
      expect(failure.code).toBe("validation_failed");
    }
    for (const badCap of [-1, 1.5, Number.NaN]) {
      const failure = expectErr(await guard.enforceDailyCap(ORG, { capUsdCents: badCap }));
      expect(failure.code).toBe("validation_failed");
    }
    expect(seams.calls.spendToday).toBe(0);
    expect(seams.calls.isDisabled).toBe(0);
  });

  it("kill switch is checked FIRST: a disabled workspace never touches the spend counter", async () => {
    const { guard, seams } = makeGuard({ disabled: true, spend: 5 });
    const failure = expectErr(await guard.enforceDailyCap(ORG, { capUsdCents: CAP }));
    expect(failure.code).toBe("disabled_workspace");
    expect(failure.retryable).toBe(false);
    expect(failure.hint).toContain("Contact support");
    expect(seams.calls.spendToday).toBe(0);
    expect(seams.calls.isDisabled).toBe(1);
  });

  it("checkWorkspaceEnabled stands alone for non-run surfaces (exports, uploads)", async () => {
    const { guard } = makeGuard({ disabled: true });
    expect(expectErr(await guard.checkWorkspaceEnabled(ORG)).code).toBe("disabled_workspace");
    expect(expectOk(await makeGuard().guard.checkWorkspaceEnabled(ORG))).toBeUndefined();
  });

  it("fails OPEN when a seam is down: a counter blip is not a site outage (rate-limit precedent)", async () => {
    const spendDown = makeGuard({ spend: CAP });
    spendDown.seams.throwSpend = true;
    const facts = expectOk(await spendDown.guard.enforceDailyCap(ORG, { capUsdCents: CAP }));
    expect(facts.spentUsdCents).toBe(0);

    const flagDown = makeGuard({ disabled: true });
    flagDown.seams.throwDisabled = true;
    const stillOk = expectOk(await flagDown.guard.enforceDailyCap(ORG, { capUsdCents: CAP }));
    expect(stillOk.remainingUsdCents).toBe(CAP);
  });

  it("sanitizes a broken counter to 0 (limits-service sanitizeCount precedent)", async () => {
    const { guard, seams } = makeGuard();
    seams.spend.set(ORG, -42);
    expect(expectOk(await guard.enforceDailyCap(ORG, { capUsdCents: CAP })).spentUsdCents).toBe(0);
    seams.spend.set(ORG, Number.NaN);
    expect(expectOk(await guard.enforceDailyCap(ORG, { capUsdCents: CAP })).spentUsdCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §22 / §14.2 r7 alert hook (80% of the daily cap)
// ---------------------------------------------------------------------------

describe("daily spend alert hook (§22 cost/day > budget; §14.2 r7 alert at 80%)", () => {
  const facts = (spent: number, cap: number): DailyCapFacts => ({
    spentUsdCents: spent,
    capUsdCents: cap,
    remainingUsdCents: cap - spent,
    resetAtIso: "2027-03-15T00:00:00.000Z",
  });

  it("fires at and beyond 80% of the cap, integer math (600-cent cap → 480)", () => {
    expect(isDailySpendAlertDue(facts(479, 600))).toBe(false);
    expect(isDailySpendAlertDue(facts(480, 600))).toBe(true);
    expect(isDailySpendAlertDue(facts(600, 600))).toBe(true);
  });

  it("dailySpendAlertThresholdUsdCents floors the threshold (§14.2 r7)", () => {
    expect(dailySpendAlertThresholdUsdCents(600)).toBe(480);
    expect(dailySpendAlertThresholdUsdCents(1500)).toBe(1200);
    expect(() => dailySpendAlertThresholdUsdCents(-1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Envelope bridge (§13.3) — kept close to the caps it carries
// ---------------------------------------------------------------------------

describe("guardrail envelope bridge to the §13.3 catalog", () => {
  it("every guardrail code maps to an existing config ErrorCode (gateway renders today)", () => {
    for (const code of GUARDRAIL_ERROR_CODES) {
      expect(guardrailCodeToErrorCode(code)).toBeTypeOf("string");
    }
    expect(guardrailCodeToErrorCode("cost_cap_reached")).toBe("quota_exceeded");
    expect(guardrailCodeToErrorCode("disabled_workspace")).toBe("forbidden");
    expect(guardrailCodeToErrorCode("demo_disabled")).toBe("forbidden");
    expect(guardrailCodeToErrorCode("demo_cap_reached")).toBe("quota_exceeded");
    expect(guardrailCodeToErrorCode("providers_disabled")).toBe("provider_unhealthy");
  });

  it("the demo org is not special-cased by the spend guard — caps apply per org", async () => {
    const seams = new InMemoryDailySpendSeams();
    seams.spend.set(DEMO_ORG_ID, CAP);
    const guard = new DailySpendGuard(seams);
    const failure = expectErr(await guard.enforceDailyCap(DEMO_ORG_ID, { capUsdCents: CAP }));
    expect(failure.code).toBe("cost_cap_reached");
  });
});
