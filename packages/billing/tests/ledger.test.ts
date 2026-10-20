// Ledger domain tests — reserve → commit | refund (§14.2 exact semantics).
// Pure in-memory LedgerStore; table-driven; deterministic; no network.

import type { Failure, Result } from "@studio/config";
import type { RunTierId } from "@studio/config";
import { describe, expect, it } from "vitest";

import {
  commitKey,
  commitReservation,
  refundKey,
  releaseReservation,
  reservationStatus,
  reserveCredits,
  reserveKey,
} from "../src/index.js";
import { InMemoryLedgerStore, seedCredits } from "./fakes.js";

const ORG = "org-1";
const OTHER_ORG = "org-2";

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

// §5.2 tier costs — the exact table the ledger must settle against.
const TIER_COSTS: ReadonlyArray<readonly [RunTierId, number]> = [
  ["quick", 1],
  ["standard", 2],
  ["complex", 5],
  ["premium", 4],
  ["max", 8],
  ["image_gen", 1],
  ["image_gen_hd", 2],
];

describe("reserve → commit happy path (§14.2 rules 1-2)", () => {
  it.each(TIER_COSTS)("tier %s: holds and charges exactly %d credit(s)", async (tier, cost) => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    const runId = `run-${tier}`;

    const reserved = expectOk(
      await reserveCredits(store, { organizationId: ORG, runId, amount: cost }),
    );
    expect(reserved.duplicate).toBe(false);
    expect(await store.balanceAfter(ORG)).toBe(10 - cost);
    expect(await reservationStatus(store, runId)).toBe("held");

    const committed = expectOk(
      await commitReservation(store, { organizationId: ORG, runId, amount: cost }),
    );
    expect(committed.amountCharged).toBe(cost);
    expect(committed.duplicate).toBe(false);

    // Net: exactly one charge of the tier cost — never double (§3.4).
    expect(await store.balanceAfter(ORG)).toBe(10 - cost);
    expect(await reservationStatus(store, runId)).toBe("committed");

    const rows = store.entriesForRun(runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "reserve",
      delta: -cost,
      idempotencyKey: reserveKey(runId),
    });
    // Settlement row: releases the hold, applies the charge → delta 0 on a full charge.
    expect(rows[1]).toMatchObject({ kind: "commit", delta: 0, idempotencyKey: commitKey(runId) });
  });
});

describe("idempotency — retries never double-charge (§14.2 rule 6, §3.4)", () => {
  it("a double reserve with the same key is a no-op holding once", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);

    const first = expectOk(
      await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 5 }),
    );
    expect(first.duplicate).toBe(false);
    const second = expectOk(
      await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 5 }),
    );
    expect(second.duplicate).toBe(true);

    expect(await store.balanceAfter(ORG)).toBe(5);
    expect(store.entriesForRun("run-a")).toHaveLength(1);
  });

  it("a double commit is a no-op charging once", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    expectOk(await commitReservation(store, { organizationId: ORG, runId: "run-a", amount: 2 }));

    const again = expectOk(
      await commitReservation(store, { organizationId: ORG, runId: "run-a", amount: 2 }),
    );
    expect(again.duplicate).toBe(true);
    expect(again.amountCharged).toBe(2);

    expect(await store.balanceAfter(ORG)).toBe(8);
    expect(store.entriesForRun("run-a")).toHaveLength(2);
  });

  it("a double release is a no-op refunding once", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 3 }));
    expectOk(await releaseReservation(store, { organizationId: ORG, runId: "run-a", amount: 3 }));

    const again = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId: "run-a", amount: 3 }),
    );
    expect(again.duplicate).toBe(true);

    expect(await store.balanceAfter(ORG)).toBe(10);
    expect(store.entriesForRun("run-a")).toHaveLength(2);
  });
});

describe("refund after failure (§14.2 rule 3, §3.3 step 7)", () => {
  it("a clean failure releases the full reservation — net zero", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 5 }));
    expect(await store.balanceAfter(ORG)).toBe(5);

    const released = expectOk(
      await releaseReservation(store, { organizationId: ORG, runId: "run-a", amount: 5 }),
    );
    expect(released.amountCharged).toBe(0);
    expect(released.amountRefunded).toBe(5);

    expect(await store.balanceAfter(ORG)).toBe(10);
    expect(await reservationStatus(store, "run-a")).toBe("released");

    const rows = store.entriesForRun("run-a");
    expect(rows[1]).toMatchObject({ kind: "refund", delta: 5, idempotencyKey: refundKey("run-a") });
  });

  it("a §24.4 grace retry is free: commit settles a zero charge", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);

    // Attempt 0: provider failure → full release.
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-0", amount: 2 }));
    expectOk(await releaseReservation(store, { organizationId: ORG, runId: "run-0", amount: 2 }));

    // Attempt 1 (the retry): runs, succeeds, and commits a zero charge.
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-1", amount: 2 }));
    const committed = expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "run-1",
        amount: 2,
        amountCharged: 0,
      }),
    );
    expect(committed.amountCharged).toBe(0);

    expect(await store.balanceAfter(ORG)).toBe(10); // the retry cost nothing
    expect(await reservationStatus(store, "run-1")).toBe("committed");
  });
});

describe("insufficient credits (§14.2 rule 1)", () => {
  it("rejects with insufficient_credits + top-up hint and appends nothing", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 1);

    const failure = expectErr(
      await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 2 }),
    );
    expect(failure.code).toBe("insufficient_credits");
    expect(failure.message).toContain("2");
    expect(failure.hint).toContain("Top up");

    expect(await store.balanceAfter(ORG)).toBe(1);
    expect(store.entriesForRun("run-a")).toHaveLength(0); // the run never starts
  });

  it("a balance exactly equal to the hold is sufficient (lands on zero, never negative)", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 2);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    expect(await store.balanceAfter(ORG)).toBe(0);
  });

  it("open holds reduce the available balance for concurrent runs (no over-commit)", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 3);

    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    expectErr(await reserveCredits(store, { organizationId: ORG, runId: "run-b", amount: 2 }));

    // Releasing the first hold frees the credits for the second run.
    expectOk(await releaseReservation(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-b", amount: 2 }));
    expect(await store.balanceAfter(ORG)).toBe(1);
  });
});

describe("partial charges (§5.2 budget stop, §14.2 rule 4)", () => {
  it("a budget-stop commit charges the smaller amount and returns the rest", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 5 }));

    const committed = expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "run-a",
        amount: 5,
        amountCharged: 2,
      }),
    );
    expect(committed.amountCharged).toBe(2);
    expect(await store.balanceAfter(ORG)).toBe(8); // paid 2, not 5

    const rows = store.entriesForRun("run-a");
    expect(rows[1]).toMatchObject({ kind: "commit", delta: 3 }); // +5 hold release, −2 charge
  });

  it("a commit never charges more than the hold (clamped)", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 5 }));

    const committed = expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: "run-a",
        amount: 5,
        amountCharged: 9,
      }),
    );
    expect(committed.amountCharged).toBe(5);
    expect(await store.balanceAfter(ORG)).toBe(5);
  });

  const partialReleaseCases: ReadonlyArray<readonly [string, number, number, number]> = [
    ["reserved 5, asks 2 → 2", 5, 2, 2],
    ["reserved 5, asks 4 → clamped to 2 (half the base)", 5, 4, 2],
    ["reserved 2, asks 1 → 1", 2, 1, 1],
    ["reserved 1, asks 1 → clamped to 0 (floor of half)", 1, 1, 0],
    ["reserved 8, asks 4 → 4", 8, 4, 4],
    ["reserved 10, asks 5 → 5", 10, 5, 5],
  ];
  it.each(partialReleaseCases)(
    "partial failure release: %s",
    async (_label, reserved, asked, applied) => {
      const store = new InMemoryLedgerStore();
      await seedCredits(store, ORG, 10);
      expectOk(
        await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: reserved }),
      );

      const released = expectOk(
        await releaseReservation(store, {
          organizationId: ORG,
          runId: "run-a",
          amount: reserved,
          amountCharged: asked,
        }),
      );
      expect(released.amountCharged).toBe(applied);
      expect(released.amountRefunded).toBe(reserved - applied);
      expect(await store.balanceAfter(ORG)).toBe(10 - applied);
      expect(await reservationStatus(store, "run-a")).toBe("released");
    },
  );
});

describe("lifecycle conflicts (terminals are mutually exclusive)", () => {
  it("committing a released run is a conflict", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    expectOk(await releaseReservation(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    const before = store.size();

    const failure = expectErr(
      await commitReservation(store, { organizationId: ORG, runId: "run-a", amount: 2 }),
    );
    expect(failure.code).toBe("conflict");
    expect(store.size()).toBe(before);
  });

  it("releasing a committed run is a conflict", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    expectOk(await commitReservation(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    const before = store.size();

    const failure = expectErr(
      await releaseReservation(store, { organizationId: ORG, runId: "run-a", amount: 2 }),
    );
    expect(failure.code).toBe("conflict");
    expect(store.size()).toBe(before);
  });

  it("committing or releasing a run that never reserved is a conflict", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);

    expect(
      (await commitReservation(store, { organizationId: ORG, runId: "ghost", amount: 2 })).ok,
    ).toBe(false);
    expect(
      (await releaseReservation(store, { organizationId: ORG, runId: "ghost", amount: 2 })).ok,
    ).toBe(false);
    expect(store.size()).toBe(1); // only the seed grant
  });
});

describe("request validation (Zod at the boundary)", () => {
  it("rejects non-positive or non-integer amounts with validation_failed", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);

    for (const amount of [0, -1, 1.5, Number.NaN]) {
      const failure = expectErr(
        await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount }),
      );
      expect(failure.code).toBe("validation_failed");
    }
    expectErr(await reserveCredits(store, { organizationId: "", runId: "run-a", amount: 1 }));
    expect(store.size()).toBe(1);
  });
});

describe("tenancy isolation (§12.2)", () => {
  it("balances and holds are scoped per organization", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    await seedCredits(store, OTHER_ORG, 3);

    expectOk(await reserveCredits(store, { organizationId: ORG, runId: "run-a", amount: 2 }));
    expectOk(await reserveCredits(store, { organizationId: OTHER_ORG, runId: "run-b", amount: 2 }));

    expect(await store.balanceAfter(ORG)).toBe(8);
    expect(await store.balanceAfter(OTHER_ORG)).toBe(1);
    expectErr(
      await reserveCredits(store, { organizationId: OTHER_ORG, runId: "run-c", amount: 2 }),
    );
    expect(store.entriesFor(ORG).every((row) => row.organizationId === ORG)).toBe(true);
  });
});
