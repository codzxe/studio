import { describe, expect, it } from "vitest";

import { estimateTokens, formatTokenEstimate } from "./tokens";

describe("estimateTokens", () => {
  it("returns 0 for null, undefined and the empty string", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("")).toBe(0);
  });

  it("floors any non-empty value at 1 token", () => {
    expect(estimateTokens("x")).toBe(1); // '"x"' → 3 chars
    expect(estimateTokens(0)).toBe(1); // '0'
    expect(estimateTokens(false)).toBe(1); // 'false'
    expect(estimateTokens({})).toBe(1); // '{}'
    expect(estimateTokens({ a: 1 })).toBe(1); // '{"a":1}' → 7 chars
  });

  it("measures JSON.stringify length / 4 with floor rounding", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100); // 402 chars → 100.5 → 100
    expect(estimateTokens("b".repeat(404))).toBe(101); // 406 chars → 101.5 → 101
    const value = { text: "c".repeat(400) }; // 1 + 7 + 1 + 402 = 411 chars
    expect(estimateTokens(value)).toBe(Math.floor(JSON.stringify(value).length / 4));
  });

  it("never throws on unserializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateTokens(circular)).toBeGreaterThan(0); // String() fallback
    expect(estimateTokens(() => "fn")).toBeGreaterThan(0);
  });
});

describe("formatTokenEstimate", () => {
  it("labels small estimates with the ~ prefix", () => {
    expect(formatTokenEstimate(0)).toBe("~0 tokens");
    expect(formatTokenEstimate(420)).toBe("~420 tokens");
    expect(formatTokenEstimate(999)).toBe("~999 tokens");
  });

  it("compacts thousands to one decimal", () => {
    expect(formatTokenEstimate(1234)).toBe("~1.2k tokens");
    expect(formatTokenEstimate(15800)).toBe("~15.8k tokens");
  });

  it("clamps negative input to zero", () => {
    expect(formatTokenEstimate(-5)).toBe("~0 tokens");
  });
});
