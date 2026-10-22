// Trial gates (W9-B): one-time 30-credit grant rules (§14.1), trial run-tier
// caps (§5.2: ≤ standard, complex/premium/max rejected), trial asset caps
// (§1.5 rule 5) and the trial runtime ladder. Table-driven, pure, no seams.

import { describe, expect, it } from "vitest";
import {
  RUN_TIER_IDS,
  TRIAL_CREDITS,
  planLimits,
  type RunTierId,
} from "@studio/config";
import { creditsForRun } from "../../policy.js";
import {
  TRIAL_ALLOWED_RUN_TIERS,
  TRIAL_GRANT_RULES,
  TRIAL_MAX_ASSETS,
  TRIAL_MAX_RUN_CREDITS,
  TRIAL_PLAN_LIMITS,
  checkTrialAssetCount,
  checkTrialRunTier,
  isTrialRunTierAllowed,
  trialEligibility,
} from "../trial-rules.js";
import { expectErr } from "./fakes.js";

// ---------------------------------------------------------------------------
// Grant rules (§14.1)
// ---------------------------------------------------------------------------

describe("trial grant rules (§14.1)", () => {
  it("pins the one-time 30-credit grant: no card, one per account", () => {
    expect(TRIAL_GRANT_RULES.credits).toBe(30);
    expect(TRIAL_GRANT_RULES.credits).toBe(TRIAL_CREDITS); // config owns the number
    expect(TRIAL_GRANT_RULES.oneTime).toBe(true);
    expect(TRIAL_GRANT_RULES.requiresCard).toBe(false);
  });

  const eligibility = [
    { alreadyGranted: false, expected: "ok" },
    { alreadyGranted: true, expected: "conflict" },
  ];
  for (const row of eligibility) {
    it(`alreadyGranted=${String(row.alreadyGranted)} → ${row.expected}`, () => {
      const result = trialEligibility({ alreadyGranted: row.alreadyGranted });
      if (row.expected === "ok") {
        expect(result.ok).toBe(true);
      } else {
        const failure = expectErr(result);
        expect(failure.code).toBe(row.expected);
        expect(failure.retryable).toBe(false);
        expect(failure.hint).toContain("one per account");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Trial run-tier caps (§5.2)
// ---------------------------------------------------------------------------

describe("trial run-tier gates (§5.2)", () => {
  const table: ReadonlyArray<{ tier: RunTierId; allowed: boolean }> = [
    { tier: "quick", allowed: true },
    { tier: "standard", allowed: true },
    { tier: "image_gen", allowed: true },
    { tier: "image_gen_hd", allowed: true },
    { tier: "complex", allowed: false },
    { tier: "premium", allowed: false },
    { tier: "max", allowed: false },
  ];

  for (const row of table) {
    it(`${row.tier} is ${row.allowed ? "allowed" : "rejected"} on a trial`, () => {
      const result = checkTrialRunTier(row.tier);
      expect(result.ok).toBe(row.allowed);
      expect(isTrialRunTierAllowed(row.tier)).toBe(row.allowed);
      if (!row.allowed) {
        const failure = expectErr(result);
        expect(failure.code).toBe("plan_limit");
        expect(failure.retryable).toBe(false);
        expect(failure.hint).toContain("Upgrade");
      }
    });
  }

  it("covers every tier in @studio/config exactly once", () => {
    expect([...TRIAL_ALLOWED_RUN_TIERS].sort()).toEqual(
      [...RUN_TIER_IDS].filter((tier) => isTrialRunTierAllowed(tier)).sort(),
    );
  });

  it("matches the credit ladder (§5.2/§14.4): allowed tiers cost ≤ 2 credits", () => {
    // Cross-check against the billing policy table so the allowlist and the
    // prices cannot drift apart when tiers change.
    for (const tier of RUN_TIER_IDS) {
      expect(isTrialRunTierAllowed(tier)).toBe(creditsForRun(tier) <= TRIAL_MAX_RUN_CREDITS);
    }
  });
});

// ---------------------------------------------------------------------------
// Trial asset caps (§1.5 rule 5)
// ---------------------------------------------------------------------------

describe("trial asset caps (§1.5 rule 5)", () => {
  const table: ReadonlyArray<{ count: number; code: string | null }> = [
    { count: 0, code: null },
    { count: 24, code: null },
    { count: TRIAL_MAX_ASSETS, code: null }, // at the cap: allowed
    { count: TRIAL_MAX_ASSETS + 1, code: "plan_limit" },
    { count: -1, code: "validation_failed" },
    { count: 2.5, code: "validation_failed" },
  ];

  for (const row of table) {
    it(`count ${row.count} → ${row.code ?? "ok"}`, () => {
      const result = checkTrialAssetCount(row.count);
      if (row.code === null) {
        expect(result.ok).toBe(true);
      } else {
        const failure = expectErr(result);
        expect(failure.code).toBe(row.code);
        expect(failure.retryable).toBe(false);
      }
    });
  }

  it("hints at deleting assets or upgrading when full", () => {
    const failure = expectErr(checkTrialAssetCount(TRIAL_MAX_ASSETS + 1));
    expect(failure.hint).toContain(`${TRIAL_MAX_ASSETS} assets`);
    expect(failure.hint).toContain("Delete");
  });
});

// ---------------------------------------------------------------------------
// Trial runtime ladder (policy: starter ladder)
// ---------------------------------------------------------------------------

describe("trial runtime ladder (policy)", () => {
  it("runs on the starter ladder (§14.1)", () => {
    expect(TRIAL_PLAN_LIMITS).toEqual(planLimits("starter"));
  });
});
