// Policy tests — §5.2 tier costs, §14.2 rules 4-5 refunds, §24.4 retry grace,
// §14.4 unit-economics guardrails. All pure functions: table-driven.

import { describe, expect, it } from "vitest";
import type { RunTierId } from "@studio/config";

import {
  RETRY_GRACE,
  classifyRefund,
  creditsForImages,
  creditsForRun,
  isFreeRetry,
  maxPartialFailureCharge,
  platformCogsAlertBreached,
  runCostIsOutlier,
  workspaceCogsAlertBreached,
  type RefundCause,
} from "../src/index.js";

describe("creditsForRun (§5.2 + §14.4 exact table)", () => {
  const cases: ReadonlyArray<readonly [RunTierId, number]> = [
    ["quick", 1],
    ["standard", 2],
    ["complex", 5],
    ["premium", 4], // standard 2 × 2 (§14.4 pins premium at 4 credits)
    ["max", 8], // standard 2 × 4 (§14.4 pins max at 8 credits)
    ["image_gen", 1],
    ["image_gen_hd", 2],
  ];
  it.each(cases)("%s costs %d credit(s)", (tier, credits) => {
    expect(creditsForRun(tier)).toBe(credits);
  });
});

describe("creditsForImages (§14.1: 1024² = 1, HD = 2, per image)", () => {
  it.each([
    [1, false, 1],
    [3, false, 3],
    [1, true, 2],
    [4, true, 8],
  ])("%d image(s), hd=%s → %d credits", (count, hd, credits) => {
    expect(creditsForImages(count, { hd })).toBe(credits);
  });

  it("rejects non-positive counts", () => {
    expect(() => creditsForImages(0, { hd: false })).toThrowError();
    expect(() => creditsForImages(1.5, { hd: false })).toThrowError();
  });
});

describe("maxPartialFailureCharge (§14.2 rule 4: at most half the base)", () => {
  it.each([
    [1, 0], // floors: a 1-credit hold can never be partially charged
    [2, 1],
    [4, 2],
    [5, 2],
    [8, 4],
    [10, 5],
  ])("reserved %d → max %d", (reserved, max) => {
    expect(maxPartialFailureCharge(reserved)).toBe(max);
  });

  it("rejects invalid reservations", () => {
    expect(() => maxPartialFailureCharge(0)).toThrowError();
    expect(() => maxPartialFailureCharge(-2)).toThrowError();
  });
});

describe("classifyRefund (§14.2 rules 3-5, §24.4, §5.2)", () => {
  const cases: ReadonlyArray<readonly [RefundCause, "full_refund" | "partial" | "none"]> = [
    // Rule 3: cancel before any mutating command → full release.
    ["user_cancel", "full_refund"],
    // §24.4: our provider failed all retries → the attempt refunds fully.
    ["provider_failure", "full_refund"],
    // Rule 5: our bug caused the failure → refund fully, even after progress.
    ["our_bug", "full_refund"],
    // Rule 4: failures after partial progress → charge at most half, release the rest.
    ["engine_crash", "partial"],
    ["engine_timeout", "partial"],
    ["engine_error", "partial"],
    ["validation_failed", "partial"],
    // §5.2: a budget stop is a clean stop, not a failure — nothing to refund.
    ["budget_stop", "none"],
  ];
  it.each(cases)("%s → %s", (cause, expected) => {
    expect(classifyRefund(cause)).toBe(expected);
  });
});

describe("retry grace (§24.4: retry_grace = 1)", () => {
  it("the policy constant is exactly 1", () => {
    expect(RETRY_GRACE).toBe(1);
  });

  const graceCases: ReadonlyArray<readonly [RefundCause, number, boolean]> = [
    ["provider_failure", 1, true], // the first retry after our provider failure is free
    ["provider_failure", 2, false], // only the first one
    ["our_bug", 1, false], // rule 5 refunds the failed run, the retry is a normal paid run
    ["user_cancel", 1, false], // grace never applies to user cancels
    ["engine_error", 1, false],
    ["provider_failure", 0, false], // 0 is the original attempt, not a retry
    ["provider_failure", -1, false],
  ];
  it.each(graceCases)("%s on retry #%s → free: %s", (cause, attempt, expected) => {
    expect(isFreeRetry(cause, attempt)).toBe(expected);
  });
});

describe("§14.4 unit-economics guardrails", () => {
  it("workspace COGS alert at >35% of revenue (integer-cents math)", () => {
    expect(workspaceCogsAlertBreached(3600, 10000)).toBe(true); // 36%
    expect(workspaceCogsAlertBreached(3500, 10000)).toBe(false); // exactly 35% is not "exceeds"
    expect(workspaceCogsAlertBreached(3400, 10000)).toBe(false); // 34%
  });

  it("a run costing >3× its tier average is an outlier", () => {
    expect(runCostIsOutlier(301, 100)).toBe(true);
    expect(runCostIsOutlier(300, 100)).toBe(false); // exactly 3× is fine
    expect(runCostIsOutlier(299, 100)).toBe(false);
  });

  it("platform COGS alert at >25% of MRR", () => {
    expect(platformCogsAlertBreached(2501, 10000)).toBe(true);
    expect(platformCogsAlertBreached(2500, 10000)).toBe(false); // exactly 25% is fine
    expect(platformCogsAlertBreached(2400, 10000)).toBe(false);
  });
});
