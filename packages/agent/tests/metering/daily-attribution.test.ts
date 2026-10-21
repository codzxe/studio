// W9-C — metering daily attribution: pure (workspace, UTC-day) bucketing for the
// §22 cost dashboards. UTC day boundaries match the W4-M usage service
// convention (see daily-attribution.ts header) — the tests pin UTC semantics.
import { describe, expect, it } from "vitest";
import { MeteringError } from "../../src/metering/cost-model.js";
import {
  type RunCostRecord,
  type WorkspaceDayCostRow,
  attributeDailyCosts,
  utcDayOf,
} from "../../src/metering/daily-attribution.js";

// Deterministic instants (built from Date.UTC — no local timezone anywhere).
const OCT_31_2359_999 = Date.UTC(2026, 9, 31, 23, 59, 59, 999); // 2026-10-31T23:59:59.999Z
const NOV_01_0000_000 = Date.UTC(2026, 10, 1); // 2026-11-01T00:00:00.000Z
const OCT_30_NOON = Date.UTC(2026, 9, 30, 12); // 2026-10-30T12:00:00Z

describe("W9-C daily attribution: UTC day boundaries", () => {
  it("utcDayOf formats UTC calendar days as YYYY-MM-DD", () => {
    expect(utcDayOf(OCT_30_NOON)).toBe("2026-10-30");
    expect(utcDayOf(OCT_31_2359_999)).toBe("2026-10-31");
    expect(utcDayOf(NOV_01_0000_000)).toBe("2026-11-01");
    // Leap day sanity + single-digit month padding.
    expect(utcDayOf(Date.UTC(2028, 1, 29, 1))).toBe("2028-02-29");
    expect(utcDayOf(Date.UTC(2026, 0, 5))).toBe("2026-01-05");
  });

  it("a millisecond separates two attribution buckets (UTC, not local)", () => {
    expect(utcDayOf(OCT_31_2359_999)).not.toBe(utcDayOf(NOV_01_0000_000));
  });

  it("refuses non-safe-integer instants", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => utcDayOf(bad)).toThrowError(MeteringError);
    }
  });
});

describe("W9-C daily attribution: bucketing runs → (workspace, day) rows", () => {
  const base: RunCostRecord = {
    runId: "run-1",
    organizationId: "ws_alpha",
    startedAtMs: OCT_30_NOON,
    costMicroUsd: 46_350n,
    tokensIn: 80_000,
    tokensOut: 5_000,
    cacheHits: 48_000,
    creditsReserved: 2,
    creditsCharged: 2,
  };

  it("buckets by run START day; a run crossing midnight never splits", () => {
    const rows = attributeDailyCosts([
      { ...base, startedAtMs: Date.UTC(2026, 9, 31, 23, 50) }, // crosses into Nov 1
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.day).toBe("2026-10-31");
    expect(rows[0]?.runs).toBe(1);
  });

  it("two runs one millisecond apart land in different day buckets", () => {
    const rows = attributeDailyCosts([
      { ...base, runId: "run-a", startedAtMs: OCT_31_2359_999 },
      { ...base, runId: "run-b", startedAtMs: NOV_01_0000_000 },
    ]);
    expect(rows.map((row) => row.day)).toEqual(["2026-10-31", "2026-11-01"]);
    expect(rows.every((row) => row.runs === 1)).toBe(true);
  });

  it("sums costs (bigint and number inputs mix), tokens, credits per bucket", () => {
    const rows = attributeDailyCosts([
      { ...base, runId: "run-a", costMicroUsd: 46_350n },
      { ...base, runId: "run-b", costMicroUsd: 30_000, creditsReserved: 2, creditsCharged: 1 },
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as WorkspaceDayCostRow;
    expect(row.runs).toBe(2);
    expect(row.costMicroUsd).toBe(76_350);
    expect(row.tokensIn).toBe(160_000);
    expect(row.tokensOut).toBe(10_000);
    expect(row.cacheHits).toBe(96_000);
    expect(row.creditsReserved).toBe(4);
    expect(row.creditsCharged).toBe(3);
  });

  it("separates workspaces; rows sort by (organizationId, day) ascending", () => {
    const rows = attributeDailyCosts([
      { ...base, organizationId: "ws_beta", startedAtMs: NOV_01_0000_000 },
      { ...base, organizationId: "ws_alpha", startedAtMs: NOV_01_0000_000 },
      { ...base, organizationId: "ws_alpha", startedAtMs: OCT_30_NOON },
      { ...base, organizationId: "ws_alpha", startedAtMs: OCT_31_2359_999 },
    ]);
    expect(rows.map((row) => [row.organizationId, row.day])).toEqual([
      ["ws_alpha", "2026-10-30"],
      ["ws_alpha", "2026-10-31"],
      ["ws_alpha", "2026-11-01"],
      ["ws_beta", "2026-11-01"],
    ]);
  });

  it("defaults the §22 optional counters to zero", () => {
    const rows = attributeDailyCosts([
      { runId: "r", organizationId: "w", startedAtMs: OCT_30_NOON, costMicroUsd: 0n },
    ]);
    expect(rows[0]).toEqual({
      organizationId: "w",
      day: "2026-10-30",
      runs: 1,
      costMicroUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheHits: 0,
      creditsReserved: 0,
      creditsCharged: 0,
    });
  });

  it("empty input → empty output (frozen)", () => {
    const rows = attributeDailyCosts([]);
    expect(rows).toEqual([]);
    expect(Object.isFrozen(rows)).toBe(true);
  });

  it("rows are frozen", () => {
    const rows = attributeDailyCosts([{ ...base }]);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });

  it("float micro-USD numbers round to the nearest integer µ$ (wiring tolerance)", () => {
    const down = attributeDailyCosts([{ ...base, costMicroUsd: 1_234.4 }]);
    expect(down[0]?.costMicroUsd).toBe(1_234);
    const up = attributeDailyCosts([{ ...base, costMicroUsd: 1_234.5 }]);
    expect(up[0]?.costMicroUsd).toBe(1_235);
  });
});

describe("W9-C daily attribution: validation and money guards", () => {
  const valid: RunCostRecord = {
    runId: "r",
    organizationId: "w",
    startedAtMs: OCT_30_NOON,
    costMicroUsd: 1n,
  };

  it("refuses blank run ids and blank organization ids (§12.2 tenant column)", () => {
    expect(() => attributeDailyCosts([{ ...valid, runId: "" }])).toThrowError(MeteringError);
    expect(() => attributeDailyCosts([{ ...valid, organizationId: "  " }])).toThrowError(
      MeteringError,
    );
  });

  it("refuses negative / non-integer counters", () => {
    expect(() => attributeDailyCosts([{ ...valid, costMicroUsd: -1n }])).toThrowError(
      MeteringError,
    );
    expect(() => attributeDailyCosts([{ ...valid, costMicroUsd: -1 }])).toThrowError(MeteringError);
    expect(() => attributeDailyCosts([{ ...valid, costMicroUsd: Number.NaN }])).toThrowError(
      MeteringError,
    );
    expect(() => attributeDailyCosts([{ ...valid, tokensIn: -1 }])).toThrowError(MeteringError);
    expect(() => attributeDailyCosts([{ ...valid, tokensIn: 1.5 }])).toThrowError(MeteringError);
    expect(() => attributeDailyCosts([{ ...valid, creditsReserved: -1 }])).toThrowError(
      MeteringError,
    );
  });

  it("bucket sums refuse to wrap through float64 (unsafe_number_conversion)", () => {
    const big = 5_000_000_000_000_000; // 5e15 µ$ — safe as a number, unsafe as a sum
    try {
      const rows = attributeDailyCosts([
        { ...valid, runId: "a", costMicroUsd: big },
        { ...valid, runId: "b", costMicroUsd: big },
      ]);
      void rows; // the throw happens while freezing the row
      expect.unreachable("overflowing bucket sum must throw");
    } catch (error) {
      expect((error as MeteringError).code).toBe("unsafe_number_conversion");
    }
  });
});
