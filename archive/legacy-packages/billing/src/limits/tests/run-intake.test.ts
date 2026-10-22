// Composite intake for POST /v1/documents/:id/runs (§13.1; §3.3 step-2
// ordering): one service call = trial tier gate → canvas gate → concurrent-run
// gate, before the §14.2 credit reservation (402 path) and enqueue.

import { describe, expect, it } from "vitest";
import type { RunTierId } from "@studio/config";
import { expectErr, expectOk, makeService } from "./fakes.js";

describe("checkRunIntake — composite gates (§13/§3.3)", () => {
  it("rejects a 200 MP canvas on starter before counting runs", async () => {
    const { service, seams } = makeService({ planCode: "starter" });
    const verdict = await service.checkRunIntake("org-1", { canvasMP: 200, tier: "standard" });
    const failure = expectErr(verdict);
    expect(failure.code).toBe("plan_limit");
    expect(failure.retryable).toBe(false);
    expect(failure.hint).toContain("32 MP");
    expect(failure.hint).toContain("200");
    // Static gate short-circuits: the run counter is never consulted.
    expect(seams.calls.countActiveRuns).toBe(0);
  });

  it("accepts a 128 MP canvas on the max plan (top ladder, at the cap)", async () => {
    const { service } = makeService({ planCode: "max", activeRuns: 5 });
    const facts = expectOk(
      await service.checkRunIntake("org-1", { canvasMP: 128, tier: "standard" }),
    );
    expect(facts).toEqual({
      plan: "business",
      canvasCapMegapixels: 128,
      concurrentRunsCap: 6,
    });
  });

  it("rejects 129 MP on the top plan (the cap is inclusive)", async () => {
    const { service } = makeService({ planCode: "business" });
    const verdict = await service.checkRunIntake("org-1", { canvasMP: 129, tier: "standard" });
    expect(expectErr(verdict).code).toBe("plan_limit");
  });

  it("handles fractional megapixels (64.5 rejected / 63.9 admitted on pro)", async () => {
    const { service } = makeService({ planCode: "pro" });
    const tooBig = await service.checkRunIntake("org-1", { canvasMP: 64.5, tier: "standard" });
    expect(expectErr(tooBig).code).toBe("plan_limit");
    const fits = await service.checkRunIntake("org-1", { canvasMP: 63.9, tier: "standard" });
    expect(fits.ok).toBe(true);
  });

  it("accepts a 32 MP standard run on trial and echoes trial facts", async () => {
    const { service } = makeService({ planCode: null });
    const facts = expectOk(
      await service.checkRunIntake("org-1", { canvasMP: 32, tier: "standard" }),
    );
    expect(facts).toEqual({
      plan: "trial",
      canvasCapMegapixels: 32,
      concurrentRunsCap: 1,
    });
  });

  it("rejects complex runs on trial even with free concurrency", async () => {
    const { service } = makeService({ planCode: null });
    const verdict = await service.checkRunIntake("org-1", { canvasMP: 16, tier: "complex" });
    const failure = expectErr(verdict);
    expect(failure.code).toBe("plan_limit");
    expect(failure.hint).toContain("Upgrade");
  });

  it("does not tier-gate paid plans at intake (§14.1)", async () => {
    const { service } = makeService({ planCode: "starter", activeRuns: 0 });
    const verdict = await service.checkRunIntake("org-1", { canvasMP: 16, tier: "max" });
    expect(verdict.ok).toBe(true);
  });

  it("rejects when the concurrent-run ladder is full (hint: active vs cap)", async () => {
    const { service } = makeService({ planCode: "starter", activeRuns: 1 });
    const verdict = await service.checkRunIntake("org-1", { canvasMP: 16, tier: "standard" });
    const failure = expectErr(verdict);
    expect(failure.code).toBe("plan_limit");
    expect(failure.retryable).toBe(true);
    expect(failure.hint).toContain("1 concurrent run");
  });

  it("admits at cap−1 concurrency on the top plan", async () => {
    const { service } = makeService({ planCode: "business", activeRuns: 5 });
    const verdict = await service.checkRunIntake("org-1", { canvasMP: 64, tier: "premium" });
    expect(verdict.ok).toBe(true);
  });

  it("rejects malformed intake as validation_failed before any seam call", async () => {
    const { service, seams } = makeService({ planCode: "pro" });
    const unknownTier = "mega" as string as RunTierId;
    const badTier = await service.checkRunIntake("org-1", { canvasMP: 64, tier: unknownTier });
    expect(expectErr(badTier).code).toBe("validation_failed");
    const negativeMP = await service.checkRunIntake("org-1", { canvasMP: -1, tier: "quick" });
    expect(expectErr(negativeMP).code).toBe("validation_failed");
    const nanMP = await service.checkRunIntake("org-1", {
      canvasMP: Number.NaN,
      tier: "quick",
    });
    expect(expectErr(nanMP).code).toBe("validation_failed");
    expect(seams.calls.getSubscription).toBe(0);
  });

  it("is one call: one subscription read, at most one counter read", async () => {
    const { service, seams } = makeService({ planCode: "pro", activeRuns: 1 });
    await service.checkRunIntake("org-1", { canvasMP: 64, tier: "standard" });
    expect(seams.calls.getSubscription).toBe(1);
    expect(seams.calls.countActiveRuns).toBe(1);
  });
});
