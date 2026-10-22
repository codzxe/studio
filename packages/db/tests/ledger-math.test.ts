import { describe, expect, it } from "vitest";

import {
  computeReserveAmount,
  deriveIdempotencyKey,
  foldBalance,
  outstandingReserve,
  planSettlement,
} from "../src/ledger-math.js";
import type { LedgerKind } from "../src/schema.js";

/** §8.8: reserve = estimated × 1.2, minimum 1. */
describe("computeReserveAmount (§8.8)", () => {
  it("adds 20% and rounds up", () => {
    expect(computeReserveAmount(10)).toBe(12);
    expect(computeReserveAmount(1)).toBe(2); // ceil(1.2)
    expect(computeReserveAmount(100)).toBe(120);
    expect(computeReserveAmount(83)).toBe(100); // ceil(99.6)
  });

  it("has a minimum of 1 — never start a run with a zero hold", () => {
    expect(computeReserveAmount(0)).toBe(1);
    expect(computeReserveAmount(0.1)).toBe(1);
  });

  it("rejects invalid estimates", () => {
    expect(() => computeReserveAmount(Number.NaN)).toThrowError();
    expect(() => computeReserveAmount(-1)).toThrowError();
  });
});

describe("foldBalance", () => {
  it("sums signed amounts over the append-only ledger", () => {
    expect(foldBalance([])).toBe(0);
    expect(foldBalance([{ amount: 1000 }, { amount: -12 }, { amount: 5 }])).toBe(993);
  });
});

describe("outstandingReserve", () => {
  it("reserves add holds; refunds and commits consume them", () => {
    const entries: { kind: LedgerKind; amount: number }[] = [
      { kind: "grant", amount: 1000 },
      { kind: "reserve", amount: -24 },
    ];
    expect(outstandingReserve(entries)).toBe(24);
    entries.push({ kind: "commit", amount: -20 });
    expect(outstandingReserve(entries)).toBe(4);
    entries.push({ kind: "refund", amount: 4 });
    expect(outstandingReserve(entries)).toBe(0);
  });

  it("clamps at zero — cannot over-refund a settled run", () => {
    expect(
      outstandingReserve([
        { kind: "reserve", amount: -10 },
        { kind: "commit", amount: -10 },
        { kind: "refund", amount: 10 },
      ]),
    ).toBe(0);
  });

  it("failure path: full reserve refund returns the hold to zero", () => {
    expect(
      outstandingReserve([
        { kind: "reserve", amount: -24 },
        { kind: "refund", amount: 24 },
      ]),
    ).toBe(0);
  });
});

describe("planSettlement", () => {
  it("success under estimate: commit actual, release the full hold (§8.8 — run nets −actual)", () => {
    expect(planSettlement(24, 18)).toEqual({ commit: 18, refund: 24 });
  });

  it("success at exactly the reserve: commit the hold, release the hold (nets −hold)", () => {
    expect(planSettlement(24, 24)).toEqual({ commit: 24, refund: 24 });
  });

  it("overage is capped by the hold (billing reconciles the rest via adjust)", () => {
    expect(planSettlement(24, 40)).toEqual({ commit: 24, refund: 24 });
  });

  it("zero cost after reserve: everything is refunded", () => {
    expect(planSettlement(24, 0)).toEqual({ commit: 0, refund: 24 });
  });

  it("rejects invalid inputs", () => {
    expect(() => planSettlement(-1, 5)).toThrowError();
    expect(() => planSettlement(10, -1)).toThrowError();
  });
});

describe("deriveIdempotencyKey", () => {
  it("is deterministic and order-sensitive", () => {
    expect(deriveIdempotencyKey("run_1", "settle")).toBe("run_1:settle");
    expect(deriveIdempotencyKey("run_1", "settle")).toBe(deriveIdempotencyKey("run_1", "settle"));
    expect(deriveIdempotencyKey("run_1", "settle")).not.toBe(
      deriveIdempotencyKey("settle", "run_1"),
    );
  });

  it("escapes separator characters so keys are collision-free", () => {
    // "a:b" + "c" must not collide with "a" + "b:c"
    expect(deriveIdempotencyKey("a:b", "c")).not.toBe(deriveIdempotencyKey("a", "b:c"));
    expect(deriveIdempotencyKey("a:b", "c")).toBe("a%3Ab:c");
  });
});
