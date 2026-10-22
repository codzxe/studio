// Plan×limit matrix for PlanLimitsService (W9-B) — §14.1 ladder: seats 1/3/10,
// concurrent runs 1/3/6, concurrent sessions 1/3/6, canvas 32/64/128 MP,
// plus upload ceilings (§20.2), the trial ladder, the 'max' catalog alias,
// extra seats (§14.1 +$8), and fail-closed/fail-soft behaviour.

import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MEGAPIXELS,
  type RunTierId,
} from "@studio/config";
import { expectErr, makeService } from "./fakes.js";

interface MatrixRow {
  readonly label: string;
  readonly planCode: string | null;
  readonly plan: "trial" | "starter" | "pro" | "business";
  readonly seats: number;
  readonly sessions: number;
  readonly runs: number;
  readonly canvasMP: number;
}

// §14.1 ladder. The 'max' row pins the catalog alias (db billing.ts comments
// name the top plan 'max'; @studio/config names it 'business').
const MATRIX: readonly MatrixRow[] = [
  {
    label: "trial (no subscription)",
    planCode: null,
    plan: "trial",
    seats: 1,
    sessions: 1,
    runs: 1,
    canvasMP: 32,
  },
  {
    label: "starter",
    planCode: "starter",
    plan: "starter",
    seats: 1,
    sessions: 1,
    runs: 1,
    canvasMP: 32,
  },
  {
    label: "pro",
    planCode: "pro",
    plan: "pro",
    seats: 3,
    sessions: 3,
    runs: 3,
    canvasMP: 64,
  },
  {
    label: "business",
    planCode: "business",
    plan: "business",
    seats: 10,
    sessions: 6,
    runs: 6,
    canvasMP: 128,
  },
  {
    label: "max (top-plan catalog alias)",
    planCode: "max",
    plan: "business",
    seats: 10,
    sessions: 6,
    runs: 6,
    canvasMP: 128,
  },
];

describe("PlanLimitsService plan×limit matrix (§14.1)", () => {
  for (const row of MATRIX) {
    describe(row.label, () => {
      it("reports the canvas ceiling", async () => {
        const { service } = makeService({ planCode: row.planCode });
        const ceiling = await service.canvasCeiling("org-1");
        expect(ceiling.ok).toBe(true);
        if (ceiling.ok) {
          expect(ceiling.value).toBe(row.canvasMP);
        }
      });

      it("admits seats below the ladder and blocks at the cap", async () => {
        const below = makeService({ planCode: row.planCode, seats: row.seats - 1 });
        expect((await below.service.canInvite("org-1")).ok).toBe(true);
        expect(below.seams.lastOrgId).toBe("org-1");

        const atCap = makeService({ planCode: row.planCode, seats: row.seats });
        const failure = expectErr(await atCap.service.canInvite("org-1"));
        expect(failure.code).toBe("plan_limit");
        expect(failure.retryable).toBe(false);
      });

      it("admits sessions below the ladder, blocks at the cap with an eviction hint", async () => {
        const below = makeService({ planCode: row.planCode, sessions: row.sessions - 1 });
        expect((await below.service.canAllocateSession("org-1")).ok).toBe(true);

        const atCap = makeService({ planCode: row.planCode, sessions: row.sessions });
        const failure = expectErr(await atCap.service.canAllocateSession("org-1"));
        expect(failure.code).toBe("plan_limit");
        expect(failure.retryable).toBe(true);
        expect(failure.hint).toContain("evicted");
      });

      it("admits runs below the ladder and blocks at the cap (active vs cap in hint)", async () => {
        const below = makeService({ planCode: row.planCode, activeRuns: row.runs - 1 });
        expect((await below.service.canStartRun("org-1", "standard")).ok).toBe(true);

        const atCap = makeService({ planCode: row.planCode, activeRuns: row.runs });
        const failure = expectErr(await atCap.service.canStartRun("org-1", "standard"));
        expect(failure.code).toBe("plan_limit");
        expect(failure.retryable).toBe(true);
        expect(failure.hint).toContain(`${row.runs} concurrent`);
      });

      it("reports the upload ceiling (§20.2: 25 MB / 60 MP for every workspace)", async () => {
        const { service } = makeService({ planCode: row.planCode });
        const ceiling = await service.uploadCeiling("org-1");
        expect(ceiling.ok).toBe(true);
        if (ceiling.ok) {
          expect(ceiling.value).toEqual({
            maxBytes: MAX_UPLOAD_BYTES,
            maxMegaPixels: MAX_UPLOAD_MEGAPIXELS,
          });
        }
      });
    });
  }
});

describe("PlanLimitsService tier gates (§5.2: trials are capped, plans are not)", () => {
  it("trial rejects complex/premium/max with an upgrade hint", async () => {
    for (const tier of ["complex", "premium", "max"] as const) {
      const { service } = makeService({ planCode: null });
      const failure = expectErr(await service.canStartRun("org-1", tier));
      expect(failure.code).toBe("plan_limit");
      expect(failure.retryable).toBe(false);
      expect(failure.hint).toContain("Upgrade");
    }
  });

  it("paid plans are not tier-gated — credits gate them (§14.1/§14.2)", async () => {
    const { service } = makeService({ planCode: "starter", activeRuns: 0 });
    expect((await service.canStartRun("org-1", "complex")).ok).toBe(true);
  });
});

describe("PlanLimitsService extra seats (§14.1: +$8/seat)", () => {
  it("lifts the seat cap by the number of purchased extra seats", async () => {
    const atCap = makeService({ planCode: "pro", seats: 3 });
    expect((await atCap.service.canInvite("org-1")).ok).toBe(false);
    expect((await atCap.service.canInvite("org-1", { extraSeatsPurchased: 1 })).ok).toBe(true);

    const overExtras = makeService({ planCode: "pro", seats: 5 });
    expect((await overExtras.service.canInvite("org-1", { extraSeatsPurchased: 1 })).ok).toBe(false);
  });

  it("rejects invalid or trial extra-seat requests", async () => {
    const paid = makeService({ planCode: "pro", seats: 3 });
    const invalid = await paid.service.canInvite("org-1", { extraSeatsPurchased: -1 });
    expect(expectErr(invalid).code).toBe("validation_failed");

    const trial = makeService({ planCode: null, seats: 1 });
    const trialExtra = await trial.service.canInvite("org-1", { extraSeatsPurchased: 1 });
    expect(expectErr(trialExtra).code).toBe("validation_failed");
  });

  it("mentions the +$8 extra-seat price in the paid hint", async () => {
    const { service } = makeService({ planCode: "pro", seats: 3 });
    const failure = expectErr(await service.canInvite("org-1"));
    expect(failure.hint).toContain("$8");
  });
});

describe("PlanLimitsService fail-closed and fail-soft behaviour", () => {
  it("fails closed on an unknown plan code (no ladder granted)", async () => {
    const { service, seams } = makeService({ planCode: "enterprise" });
    expect(expectErr(await service.canStartRun("org-1", "quick")).code).toBe("validation_failed");
    expect(expectErr(await service.canAllocateSession("org-1")).code).toBe("validation_failed");
    expect(expectErr(await service.canInvite("org-1")).code).toBe("validation_failed");
    expect(expectErr(await service.canvasCeiling("org-1")).code).toBe("validation_failed");
    expect(expectErr(await service.uploadCeiling("org-1")).code).toBe("validation_failed");
    expect(
      expectErr(await service.checkRunIntake("org-1", { canvasMP: 32, tier: "quick" })).code,
    ).toBe("validation_failed");
    // Resolution failed before any counter was consulted.
    expect(seams.calls.countActiveRuns).toBe(0);
    expect(seams.calls.countSessions).toBe(0);
    expect(seams.calls.countSeats).toBe(0);
  });

  it("clamps a broken counter to zero (fail-soft, W4-D precedent)", async () => {
    const nan = makeService({ planCode: "starter", activeRuns: Number.NaN });
    expect((await nan.service.canStartRun("org-1", "quick")).ok).toBe(true);

    const negative = makeService({ planCode: "starter", sessions: -5 });
    expect((await negative.service.canAllocateSession("org-1")).ok).toBe(true);
  });

  it("rejects unknown run tiers as validation_failed", async () => {
    const { service } = makeService({ planCode: "pro" });
    const unknownTier = "mega" as string as RunTierId;
    expect(expectErr(await service.canStartRun("org-1", unknownTier)).code).toBe("validation_failed");
  });

  it("rejects an empty org id as validation_failed", async () => {
    const { service } = makeService({ planCode: "pro" });
    expect(expectErr(await service.canvasCeiling("")).code).toBe("validation_failed");
  });

  it("consults each seam at most once per call", async () => {
    const { service, seams } = makeService({ planCode: "pro", activeRuns: 1 });
    await service.canStartRun("org-1", "standard");
    expect(seams.calls.getSubscription).toBe(1);
    expect(seams.calls.countActiveRuns).toBe(1);
  });
});
