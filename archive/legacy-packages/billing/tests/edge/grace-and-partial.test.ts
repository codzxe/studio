// Grace + partial-charge edges (§24.4 retry_grace, §14.2 rule 4 clamps, §14.2
// rules 3-5 refund bounds, §12.2 sum invariants) — the §19 Phase 4 "billing
// edge cases" that must hold before money is charged. Pure in-memory store,
// table-driven, deterministic, no network (AGENTS.md test rules).
//
// Spec anchors:
//   §24.4        — provider 500s on all retries → release; one-click retry is a
//                  new run, free for the FIRST provider-failure retry
//                  (policy constant retry_grace: 1); the next one is charged
//   §14.2 rule 4 — failure after partial progress charges at most HALF the base
//                  (floored customer-ward); the rest is released
//   §14.2 rules 3/5 — clean cancel and our-bug failures release in full
//   §5.2         — budget stop: a commit never charges above the hold (clamped)
//   §12.2        — balance ≡ Σ deltas; grants/packs are credits-in; per-run
//                  nets are {0, −charged} once terminal

import { PARTIAL_FAILURE_CHARGE_FRACTION, type RunTierId } from "@studio/config";
import type { Failure, Result } from "@studio/config";
import { describe, expect, it } from "vitest";

import {
  RETRY_GRACE,
  type RefundCause,
  type RefundPolicy,
  classifyRefund,
  commitReservation,
  creditsForRun,
  isFreeRetry,
  maxPartialFailureCharge,
  releaseReservation,
  reservationStatus,
  reserveCredits,
} from "../../src/index.js";
import { InMemoryLedgerStore, seedCredits } from "../fakes.js";

const ORG = "org-edge";

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

function rejectionMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// ---------------------------------------------------------------------------
// §24.4 — retry_grace: 1
// ---------------------------------------------------------------------------

describe("retry_grace: 1 — first provider-failure retry free, then charged (§24.4)", () => {
  it("pins the policy constant", () => {
    expect(RETRY_GRACE).toBe(1); // §24.4: "policy constant retry_grace: 1"
  });

  interface GraceRow {
    readonly cause: RefundCause;
    readonly attempt: number;
    readonly free: boolean;
  }

  const GRACE_TABLE: GraceRow[] = [
    { cause: "provider_failure", attempt: 1, free: true }, // THE free retry
    { cause: "provider_failure", attempt: 2, free: false }, // grace is spent
    { cause: "provider_failure", attempt: 0, free: false }, // the original run, not a retry
    { cause: "provider_failure", attempt: -1, free: false },
    { cause: "provider_failure", attempt: 1.5, free: false },
    { cause: "our_bug", attempt: 1, free: false }, // fixed bug → a normal paid run (§14.2 rule 5 note)
    { cause: "engine_crash", attempt: 1, free: false },
    { cause: "engine_timeout", attempt: 1, free: false },
    { cause: "engine_error", attempt: 1, free: false },
    { cause: "validation_failed", attempt: 1, free: false },
    { cause: "user_cancel", attempt: 1, free: false },
    { cause: "budget_stop", attempt: 1, free: false },
  ];

  it.each(GRACE_TABLE)("isFreeRetry($cause, attempt $attempt) → $free", (row) => {
    expect(isFreeRetry(row.cause, row.attempt)).toBe(row.free);
  });

  interface RefundRow {
    readonly cause: RefundCause;
    readonly policy: RefundPolicy;
  }

  const REFUND_TABLE: RefundRow[] = [
    { cause: "user_cancel", policy: "full_refund" }, // §14.2 rule 3
    { cause: "provider_failure", policy: "full_refund" }, // §24.4 — our provider failed
    { cause: "our_bug", policy: "full_refund" }, // §14.2 rule 5 — even after partial progress
    { cause: "engine_crash", policy: "partial" }, // §14.2 rule 4
    { cause: "engine_timeout", policy: "partial" },
    { cause: "engine_error", policy: "partial" },
    { cause: "validation_failed", policy: "partial" },
    { cause: "budget_stop", policy: "none" }, // §5.2 clean stop, not a failure
  ];

  it.each(REFUND_TABLE)("classifyRefund($cause) → $policy", (row) => {
    expect(classifyRefund(row.cause)).toBe(row.policy);
  });

  it("the §24.4 story end to end: fail → free retry fails again → second retry charged", async () => {
    const store = new InMemoryLedgerStore();
    const STANDARD = 2; // §5.2 standard tier base cost
    await seedCredits(store, ORG, 5);

    // The caller computes the retry charge FROM the §24.4 policy, not ad hoc.
    const chargeFor = (attempt: number): number =>
      isFreeRetry("provider_failure", attempt) ? 0 : creditsForRun("standard");

    // Run A: image provider 500s on all retries → rollback, full release (§24.4).
    await reserveCredits(store, { organizationId: ORG, runId: "A", amount: STANDARD });
    expect(await store.balanceAfter(ORG)).toBe(3);
    const releasedA = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId: "A", amount: STANDARD }),
    );
    expect(releasedA.amountCharged).toBe(0);
    expect(releasedA.amountRefunded).toBe(STANDARD);
    expect(await store.balanceAfter(ORG)).toBe(5);

    // Retry 1 (grace): the provider fails AGAIN — the free retry is still free.
    expect(chargeFor(1)).toBe(0);
    await reserveCredits(store, { organizationId: ORG, runId: "A1", amount: STANDARD });
    const releasedA1 = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId: "A1", amount: STANDARD }),
    );
    expect(releasedA1.amountRefunded).toBe(STANDARD);
    expect(await store.balanceAfter(ORG)).toBe(5);

    // Retry 2: grace is spent — a successful retry now commits the tier cost.
    expect(chargeFor(2)).toBe(STANDARD);
    await reserveCredits(store, { organizationId: ORG, runId: "A2", amount: STANDARD });
    const committedA2 = expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "A2",
        amount: STANDARD,
        amountCharged: chargeFor(2),
      }),
    );
    expect(committedA2.amountCharged).toBe(STANDARD);
    expect(await store.balanceAfter(ORG)).toBe(3);
    expect(await reservationStatus(store, "A2")).toBe("committed");

    // Three run attempts, one provider double-failure: exactly ONE charge.
    expect(store.entriesFor(ORG).filter((entry) => entry.kind === "commit")).toHaveLength(1);
  });

  it("a §24.4 grace retry that SUCCEEDS commits 0 — and the replay never re-grants", async () => {
    const store = new InMemoryLedgerStore();
    const STANDARD = 2;
    await seedCredits(store, ORG, 5);

    await reserveCredits(store, { organizationId: ORG, runId: "G1", amount: STANDARD });
    const grace = expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "G1",
        amount: STANDARD,
        amountCharged: 0, // §24.4: no extra charge for the first provider-failure retry
      }),
    );
    expect(grace.amountCharged).toBe(0);
    expect(grace.duplicate).toBe(false);
    expect(await store.balanceAfter(ORG)).toBe(5); // held, then returned — net 0

    const replay = expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "G1",
        amount: STANDARD,
        amountCharged: 0,
      }),
    );
    expect(replay.duplicate).toBe(true);
    expect(await store.balanceAfter(ORG)).toBe(5); // no second settlement
    expect(store.entriesForRun("G1")).toHaveLength(2); // hold + one commit row
  });
});

// ---------------------------------------------------------------------------
// §14.2 rule 4 — partial charge clamps
// ---------------------------------------------------------------------------

describe("partial charge clamp (§14.2 rule 4: at most half the base, floored customer-ward)", () => {
  it("pins the fraction", () => {
    expect(PARTIAL_FAILURE_CHARGE_FRACTION).toBe(0.5);
  });

  interface TierClampRow {
    readonly tier: RunTierId;
    /** §5.2/§14.1 tier base cost (premium ×2 = 4, max ×4 = 8). */
    readonly credits: number;
    /** ⌊credits/2⌋ — the documented partial-failure ceiling. */
    readonly clamp: number;
  }

  const TIER_CLAMP: TierClampRow[] = [
    { tier: "quick", credits: 1, clamp: 0 }, // fractional half floors to 0
    { tier: "standard", credits: 2, clamp: 1 },
    { tier: "premium", credits: 4, clamp: 2 },
    { tier: "complex", credits: 5, clamp: 2 },
    { tier: "max", credits: 8, clamp: 4 },
    { tier: "image_gen", credits: 1, clamp: 0 },
    { tier: "image_gen_hd", credits: 2, clamp: 1 },
  ];

  it.each(TIER_CLAMP)("$tier ($credits credits): ceiling is half the base ($clamp)", (row) => {
    expect(creditsForRun(row.tier)).toBe(row.credits);
    expect(maxPartialFailureCharge(row.credits)).toBe(row.clamp);
    expect(maxPartialFailureCharge(row.credits)).toBe(
      Math.floor(row.credits * PARTIAL_FAILURE_CHARGE_FRACTION),
    );
  });

  it.each(TIER_CLAMP)(
    "$tier: a release trying to charge the whole hold is clamped to $clamp",
    async (row) => {
      const store = new InMemoryLedgerStore();
      await seedCredits(store, ORG, row.credits * 3);
      const runId = `clamp-${row.tier}`;
      await reserveCredits(store, { organizationId: ORG, runId, amount: row.credits });

      const outcome = expectOk(
        await releaseReservation(store, {
          organizationId: ORG,
          runId,
          amount: row.credits,
          amountCharged: row.credits, // an over-charging caller
        }),
      );
      expect(outcome.amountCharged).toBe(row.clamp);
      expect(outcome.amountRefunded).toBe(row.credits - row.clamp);

      const rows = store.entriesForRun(runId);
      expect(rows[1]).toMatchObject({ kind: "refund", delta: row.credits - row.clamp });
      expect(await store.balanceAfter(ORG)).toBe(row.credits * 3 - row.clamp);
      expect(await reservationStatus(store, runId)).toBe("released");
    },
  );

  it.each(TIER_CLAMP)(
    "$tier: a release asking for exactly the clamp is applied as-is (boundary)",
    async (row) => {
      const store = new InMemoryLedgerStore();
      await seedCredits(store, ORG, row.credits * 3);
      const runId = `boundary-${row.tier}`;
      await reserveCredits(store, { organizationId: ORG, runId, amount: row.credits });

      const outcome = expectOk(
        await releaseReservation(store, {
          organizationId: ORG,
          runId,
          amount: row.credits,
          amountCharged: row.clamp,
        }),
      );
      expect(outcome.amountCharged).toBe(row.clamp);
      expect(outcome.amountRefunded).toBe(row.credits - row.clamp);
      expect(await store.balanceAfter(ORG)).toBe(row.credits * 3 - row.clamp);
    },
  );

  it("the amount sweep [1..8]: the ceiling is ⌊a/2⌋ for every hold size", () => {
    for (let amount = 1; amount <= 8; amount += 1) {
      expect(maxPartialFailureCharge(amount)).toBe(Math.floor(amount / 2));
    }
  });

  it("rejects non-positive hold amounts loudly (defence for untyped callers)", () => {
    expect(() => maxPartialFailureCharge(0)).toThrow();
    expect(() => maxPartialFailureCharge(-1)).toThrow();
  });

  it("§5.2 budget stop: a commit above the hold is clamped to the hold, never exceeded", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    const runId = "clamp-commit";
    await reserveCredits(store, { organizationId: ORG, runId, amount: 2 });

    const outcome = expectOk(
      await commitReservation(store, { organizationId: ORG, runId, amount: 2, amountCharged: 99 }),
    );
    expect(outcome.amountCharged).toBe(2); // clamped to the hold
    expect(store.entriesForRun(runId)[1]).toMatchObject({ kind: "commit", delta: 0 });
    expect(await store.balanceAfter(ORG)).toBe(8);
  });

  it("negative or fractional charges are typed schema failures, never money", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    const runId = "clamp-schema";
    await reserveCredits(store, { organizationId: ORG, runId, amount: 2 });

    const badRelease = expectErr(
      await releaseReservation(store, { organizationId: ORG, runId, amount: 2, amountCharged: -1 }),
    );
    expect(badRelease.code).toBe("validation_failed");

    const badCommit = expectErr(
      await commitReservation(store, { organizationId: ORG, runId, amount: 2, amountCharged: 1.5 }),
    );
    expect(badCommit.code).toBe("validation_failed");

    // Still just the hold — neither call appended money (§14.2 rule 6).
    expect(store.entriesForRun(runId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §14.2 rules 3-4 — refund bounds
// ---------------------------------------------------------------------------

describe("refund never exceeds the reserve (§14.2 rules 3-4)", () => {
  it("a full release returns exactly the held credits — never a credit more", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 7);
    const runId = "refund-full";
    await reserveCredits(store, { organizationId: ORG, runId, amount: 2 });
    expect(await store.balanceAfter(ORG)).toBe(5);

    const outcome = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId, amount: 2 }),
    );
    expect(outcome.amountRefunded).toBe(2);
    expect(store.entriesForRun(runId)[1]).toMatchObject({ kind: "refund", delta: 2 });
    expect(await store.balanceAfter(ORG)).toBe(7); // restored to the pre-run credit
  });

  it("the partial-failure ceiling is half the hold — a release can never consume it all", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    const runId = "refund-ceiling";
    await reserveCredits(store, { organizationId: ORG, runId, amount: 2 });

    const outcome = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId, amount: 2, amountCharged: 2 }),
    );
    // §14.2 rule 4: even the most avaricious release keeps only ⌊2/2⌋ = 1…
    expect(outcome.amountCharged).toBe(1);
    expect(outcome.amountRefunded).toBe(1);
    expect(store.entriesForRun(runId)[1]).toMatchObject({ kind: "refund", delta: 1 });
    // …so a partial-failure release NEVER spends the whole hold: net −1, not −2.
    expect(await store.balanceAfter(ORG)).toBe(9);
    // Only a commit can consume the full hold (§14.2 rule 2, not rule 4).
    expect(await reservationStatus(store, runId)).toBe("released");
  });

  it("two concurrent releases refund exactly once", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    const runId = "refund-race";
    await reserveCredits(store, { organizationId: ORG, runId, amount: 3 });
    expect(await store.balanceAfter(ORG)).toBe(7);

    const settled = await Promise.allSettled([
      releaseReservation(store, { organizationId: ORG, runId, amount: 3 }),
      releaseReservation(store, { organizationId: ORG, runId, amount: 3 }),
    ]);

    const refundRows = store.entriesForRun(runId).filter((entry) => entry.kind === "refund");
    expect(refundRows).toHaveLength(1);
    // Refunded once: 10 → 7 (hold) → 10 (release) — never 13 (§14.2 rule 6).
    expect(await store.balanceAfter(ORG)).toBe(10);

    let fresh = 0;
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        expect(rejectionMessage(outcome.reason)).toMatch(/duplicate append rejected/);
        continue;
      }
      const result = outcome.value;
      if (!result.ok) {
        throw new Error(`unexpected failure: ${result.code}: ${result.message}`);
      }
      if (result.value.duplicate) {
        continue; // the loser's check saw the landed refund — idempotent replay
      }
      fresh += 1;
      expect(result.value.amountRefunded).toBe(3);
    }
    expect(fresh).toBe(1);
  });

  it("a replayed release with different arguments never re-settles (replay-identical-args contract)", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    const runId = "refund-replay";
    await reserveCredits(store, { organizationId: ORG, runId, amount: 4 });
    const first = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId, amount: 4, amountCharged: 2 }),
    );
    expect(first.amountRefunded).toBe(2);

    const replay = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId, amount: 4, amountCharged: 0 }),
    );
    expect(replay.duplicate).toBe(true);

    // The first settlement stands: charged 2, refunded 2 — exactly once.
    expect(store.entriesForRun(runId).filter((entry) => entry.kind === "refund")).toHaveLength(1);
    expect(await store.balanceAfter(ORG)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// §12.2 — ledger sum invariants
// ---------------------------------------------------------------------------

describe("ledger sum invariants (§12.2: balance ≡ Σ deltas)", () => {
  it("a mixed terminal board: Σ deltas + grants ≡ balance; per-run net ∈ {0, −charged}", async () => {
    const store = new InMemoryLedgerStore();
    // Credits in: a plan-style grant plus a pack (§12.1 kinds).
    await seedCredits(store, ORG, 100);
    await store.append({
      organizationId: ORG,
      delta: 10,
      kind: "pack",
      idempotencyKey: "pack:org-edge:1",
      note: "edge-suite pack",
    });

    // Run Q — quick tier, success: 1 credit.
    await reserveCredits(store, { organizationId: ORG, runId: "Q", amount: 1 });
    expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "Q",
        amount: 1,
        amountCharged: 1,
      }),
    );

    // Run S — standard tier, success: 2 credits.
    await reserveCredits(store, { organizationId: ORG, runId: "S", amount: 2 });
    expectOk(await commitReservation(store, { organizationId: ORG, runId: "S", amount: 2 }));

    // Run C1 — complex tier, provider failure: full release (§24.4).
    await reserveCredits(store, { organizationId: ORG, runId: "C1", amount: 5 });
    expectOk(await releaseReservation(store, { organizationId: ORG, runId: "C1", amount: 5 }));

    // Run C2 — §24.4 grace retry of C1's chain: commits 0.
    await reserveCredits(store, { organizationId: ORG, runId: "C2", amount: 5 });
    expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "C2",
        amount: 5,
        amountCharged: 0,
      }),
    );

    // Run P — premium tier, failure after partial progress: clamped to half.
    await reserveCredits(store, { organizationId: ORG, runId: "P", amount: 4 });
    const partial = expectOk(
      await releaseReservation(store, {
        organizationId: ORG,
        runId: "P",
        amount: 4,
        amountCharged: 4,
      }),
    );
    expect(partial.amountCharged).toBe(2); // §14.2 rule 4

    // Run M — max tier, §5.2 budget stop: partial commit below the hold.
    await reserveCredits(store, { organizationId: ORG, runId: "M", amount: 8 });
    expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "M",
        amount: 8,
        amountCharged: 3,
      }),
    );

    // Run U — user cancel before any mutating command: full release (rule 3).
    await reserveCredits(store, { organizationId: ORG, runId: "U", amount: 1 });
    expectOk(await releaseReservation(store, { organizationId: ORG, runId: "U", amount: 1 }));

    // Run X — still in flight: an open hold.
    await reserveCredits(store, { organizationId: ORG, runId: "X", amount: 2 });

    // Per-run nets fold straight off the rows (§12.2 derivation).
    const expectedNets: Record<string, number> = {
      Q: -1,
      S: -2,
      C1: 0,
      C2: 0,
      P: -2,
      M: -3,
      U: 0,
      X: -2,
    };
    const perRunNet = new Map<string, number>();
    for (const row of store.entriesFor(ORG)) {
      if (row.runId === undefined) {
        continue; // grants/packs live outside the run fold
      }
      perRunNet.set(row.runId, (perRunNet.get(row.runId) ?? 0) + row.delta);
    }
    expect(Object.fromEntries(perRunNet)).toEqual(expectedNets);

    // Per-run net ∈ {0, −charged} for every TERMINAL run (§14.2 rules 2-5).
    const charged: Record<string, number> = { Q: 1, S: 2, C1: 0, C2: 0, P: 2, M: 3, U: 0 };
    for (const [runId, amountCharged] of Object.entries(charged)) {
      const net = perRunNet.get(runId);
      expect(net === 0 || net === -amountCharged).toBe(true);
    }
    expect(perRunNet.get("X")).toBe(-2); // open hold: the in-flight net

    // Σ deltas (grants + packs + run rows) ≡ balance — never a second truth.
    const rows = store.entriesFor(ORG);
    const sumOfDeltas = rows.reduce((total, row) => total + row.delta, 0);
    const grantsAndPacks = rows
      .filter((row) => row.kind === "grant" || row.kind === "pack")
      .reduce((total, row) => total + row.delta, 0);
    const runNets = rows
      .filter((row) => row.runId !== undefined)
      .reduce((total, row) => total + row.delta, 0);
    expect(sumOfDeltas).toBe(grantsAndPacks + runNets);
    expect(await store.balanceAfter(ORG)).toBe(sumOfDeltas); // 110 − 10 charged/held

    // Structural invariants: one append per phase, canonical keys, terminals
    // never dip the balance below the hold (§14.2 rules 1/6, ledger.ts header).
    for (const runId of Object.keys(expectedNets)) {
      const runRows = store.entriesForRun(runId);
      expect(runRows.length).toBeLessThanOrEqual(2);
      expect(runRows[0]?.kind).toBe("reserve");
      expect(runRows[0]?.delta).toBeLessThan(0);
      for (const row of runRows.slice(1)) {
        expect(row.delta).toBeGreaterThanOrEqual(0); // terminals are non-negative
      }
    }
  });
});
