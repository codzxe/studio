/**
 * Display-helper tests for the billing page (D-12 µc→credits at the UI
 * boundary, §14 number/date formats, deterministic UTC rendering). The
 * credit/byte math DELEGATES to the billing kit's shared helpers
 * (ledger-table/usage-meters — their own tests pin the math); these tests
 * pin the page-side wiring and the date/day helpers owned here.
 */

import { describe, expect, it } from "vitest";
import {
  daysUntil,
  formatCount,
  formatCredits,
  formatDate,
  formatMonthlyPrice,
  formatStorage,
} from "./page-format";

/** A pinned "today" — 2026-10-21T12:00:00Z (all day math is UTC). */
const NOW = new Date("2026-10-21T12:00:00Z");

describe("formatCredits (D-12: µc → credits via the kit's shared math)", () => {
  it("converts microcredits to credits with exactly two decimals (kit style)", () => {
    expect(formatCredits(500_000_000)).toBe("500.00");
    expect(formatCredits(50_000_000)).toBe("50.00");
    expect(formatCredits(10_000_000_000)).toBe("10,000.00");
    expect(formatCredits(12_345_678)).toBe("12.35");
    expect(formatCredits(1_234_567_890)).toBe("1,234.57");
    expect(formatCredits(250_000)).toBe("0.25");
    expect(formatCredits(0)).toBe("0.00");
  });

  it("degrades hostile input to an em dash, never a crash", () => {
    expect(formatCredits(Number.NaN)).toBe("—");
    expect(formatCredits(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCredits(Number.NEGATIVE_INFINITY)).toBe("—");
  });
});

describe("formatCount (§14: comma-grouped whole counts)", () => {
  it("formats seats and minutes, and defends bad input", () => {
    expect(formatCount(5)).toBe("5");
    expect(formatCount(2_000)).toBe("2,000");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(-3)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
  });
});

describe("formatMonthlyPrice (§14)", () => {
  it("renders the display catalog's BUSINESS-PENDING placeholders exactly", () => {
    expect(formatMonthlyPrice(1200)).toBe("$12/mo");
    expect(formatMonthlyPrice(3900)).toBe("$39/mo");
    expect(formatMonthlyPrice(9900)).toBe("$99/mo");
  });

  it("keeps cents and defends bad input", () => {
    expect(formatMonthlyPrice(2999)).toBe("$29.99/mo");
    expect(formatMonthlyPrice(0)).toBe("$0/mo");
    expect(formatMonthlyPrice(-5)).toBe("$0/mo");
  });
});

describe("formatDate (§14: `Oct 21, 2026`, UTC-deterministic)", () => {
  it("formats ISO instants", () => {
    expect(formatDate("2026-10-21T00:00:00Z")).toBe("Oct 21, 2026");
    expect(formatDate("2026-11-05T23:59:59Z")).toBe("Nov 5, 2026");
  });

  it("renders an em dash for missing or unparseable values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });
});

describe("daysUntil (pure; caller pins the clock)", () => {
  it("floors partial days and clamps at zero", () => {
    expect(daysUntil("2026-10-24T12:00:00Z", NOW)).toBe(3);
    expect(daysUntil("2026-10-24T11:59:00Z", NOW)).toBe(2); // 2d 23h → 2
    expect(daysUntil("2026-10-21T11:00:00Z", NOW)).toBe(0); // already past
    expect(daysUntil("2026-10-21T12:00:00Z", NOW)).toBe(0); // exactly now
  });

  it("returns 0 for missing or unparseable instants", () => {
    expect(daysUntil(null, NOW)).toBe(0);
    expect(daysUntil("nope", NOW)).toBe(0);
  });
});

describe("formatStorage (delegates to the kit's §14 byte display)", () => {
  it("renders the state's storage quotas", () => {
    expect(formatStorage(1024 ** 3)).toBe("1 GB");
    expect(formatStorage(20 * 1024 ** 3)).toBe("20 GB");
    expect(formatStorage(200 * 1024 ** 3)).toBe("200 GB");
    expect(formatStorage(1024 ** 4)).toBe("1 TB");
    expect(formatStorage(0)).toBe("0 B");
  });
});
