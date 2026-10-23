import { describe, expect, it } from "vitest";
import {
  ENABLED_RENDER_FORMATS,
  RENDER_BASE_RATE_UC,
  RENDER_FORMATS,
  RENDER_MAX_LONG_EDGE_PX,
  RENDER_MAX_OUTPUT_SECONDS,
  RENDER_MIN_CHARGE_UC,
  RENDER_QUALITY_IDS,
  RENDER_QUALITY_MULTIPLIERS,
  RENDER_RESOLUTION_TIERS,
  StudioError,
  estimateRenderCostUc,
  isRenderFormatDeclared,
  isRenderQualityId,
  renderOutputSeconds,
} from "../src/index.js";
import type { RenderCostInput, RenderQualityId, RenderResolutionTier } from "../src/index.js";

/**
 * Shorthand for the estimator with per-test defaults filled. `format` and
 * `quality` are deliberately `string` here: the runtime guards exist for JS
 * boundary callers (the wire), and the tests exercise them exactly like one.
 */
function cost(input: {
  format?: string;
  outputSeconds: number;
  longEdgePx?: number;
  quality?: string;
}): number {
  return estimateRenderCostUc({
    format: (input.format ?? "mp4") as RenderCostInput["format"],
    outputSeconds: input.outputSeconds,
    longEdgePx: input.longEdgePx ?? 1920,
    quality: (input.quality ?? "good") as RenderCostInput["quality"],
  });
}

function expectInvalid(input: {
  format?: string;
  outputSeconds?: number;
  longEdgePx?: number;
  quality?: string;
}): void {
  let thrown: unknown;
  try {
    cost({ outputSeconds: 10, ...input });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StudioError);
  expect((thrown as StudioError).code).toBe("VALIDATION_FAILED");
}

describe("render pricing: constants (D-2 + D-12)", () => {
  it("prices every declared format — enabled ones and D-2 reserved ones", () => {
    expect(RENDER_BASE_RATE_UC).toEqual({
      mp4: 100_000,
      "png-seq": 50_000,
      prores: 400_000,
      gif: 150_000,
      wav: 10_000,
    });
    for (const format of RENDER_FORMATS) {
      expect(Number.isInteger(RENDER_BASE_RATE_UC[format.id])).toBe(true);
      expect(RENDER_BASE_RATE_UC[format.id]).toBeGreaterThan(0);
    }
    // The pricing table covers exactly the declared formats — no more, no less.
    expect(Object.keys(RENDER_BASE_RATE_UC)).toEqual([...RENDER_FORMATS.map((f) => f.id)]);
    expect(ENABLED_RENDER_FORMATS.every((id) => id in RENDER_BASE_RATE_UC)).toBe(true);
  });

  it("declares the resolution tiers as exact rationals in ascending order", () => {
    expect(RENDER_RESOLUTION_TIERS).toEqual([
      { maxLongEdgePx: 1280, multiplier: { num: 1, den: 2 } },
      { maxLongEdgePx: 1920, multiplier: { num: 1, den: 1 } },
      { maxLongEdgePx: 2560, multiplier: { num: 2, den: 1 } },
      { maxLongEdgePx: 3840, multiplier: { num: 4, den: 1 } },
    ] satisfies RenderResolutionTier[]);
    let previous = 0;
    for (const tier of RENDER_RESOLUTION_TIERS) {
      expect(tier.maxLongEdgePx).toBeGreaterThan(previous);
      expect(Number.isInteger(tier.multiplier.num)).toBe(true);
      expect(Number.isInteger(tier.multiplier.den)).toBe(true);
      expect(tier.multiplier.den).toBeGreaterThan(0);
      previous = tier.maxLongEdgePx;
    }
  });

  it("declares the quality multipliers draft 3/5, good 1/1, best 7/5", () => {
    expect(RENDER_QUALITY_MULTIPLIERS).toEqual({
      draft: { num: 3, den: 5 },
      good: { num: 1, den: 1 },
      best: { num: 7, den: 5 },
    });
    expect([...RENDER_QUALITY_IDS]).toEqual(["draft", "good", "best"]);
  });

  it("carries the minimum charge, the px ceiling and the duration cap", () => {
    expect(RENDER_MIN_CHARGE_UC).toBe(250_000);
    expect(RENDER_MAX_LONG_EDGE_PX).toBe(3840);
    expect(RENDER_MAX_LONG_EDGE_PX).toBe(
      RENDER_RESOLUTION_TIERS[RENDER_RESOLUTION_TIERS.length - 1]?.maxLongEdgePx,
    );
    expect(RENDER_MAX_OUTPUT_SECONDS).toBe(86_400);
  });

  it("isRenderFormatDeclared accepts all five ids and fails closed on unknowns", () => {
    for (const format of RENDER_FORMATS) {
      expect(isRenderFormatDeclared(format.id)).toBe(true); // reserved ones too (D-2)
    }
    expect(isRenderFormatDeclared("exe")).toBe(false);
    expect(isRenderFormatDeclared("")).toBe(false);
    expect(isRenderFormatDeclared("MP4")).toBe(false);
  });

  it("isRenderQualityId narrows exactly the three quality ids", () => {
    for (const quality of RENDER_QUALITY_IDS) {
      expect(isRenderQualityId(quality)).toBe(true);
    }
    expect(isRenderQualityId("ultra")).toBe(false);
    expect(isRenderQualityId("")).toBe(false);
    expect(isRenderQualityId("Best")).toBe(false);
  });

  it("the pricing tables are frozen", () => {
    expect(Object.isFrozen(RENDER_BASE_RATE_UC)).toBe(true);
    expect(Object.isFrozen(RENDER_RESOLUTION_TIERS)).toBe(true);
    expect(Object.isFrozen(RENDER_QUALITY_MULTIPLIERS)).toBe(true);
    expect(Object.isFrozen(RENDER_QUALITY_IDS)).toBe(true);
    expect(() => {
      (RENDER_BASE_RATE_UC as Record<string, number>).mp4 = 0;
    }).toThrow();
    expect(() => {
      (RENDER_QUALITY_IDS as unknown as string[]).push("ultra");
    }).toThrow();
  });
});

describe("render pricing: the pinned matrix (integer µc, D-12)", () => {
  it("the task's canonical case: 10s @ 1080p best mp4 = 1_400_000 µc", () => {
    expect(cost({ outputSeconds: 10, longEdgePx: 1920, quality: "best" })).toBe(1_400_000);
  });

  it("minimum charge: a 0.5s render clamps to 250_000 µc", () => {
    expect(cost({ outputSeconds: 0.5, longEdgePx: 1920, quality: "best" })).toBe(250_000);
    expect(cost({ outputSeconds: 0.5, longEdgePx: 1920, quality: "good" })).toBe(250_000);
    expect(cost({ outputSeconds: 0.001 })).toBe(250_000);
  });

  it("10s @ 720p draft png-seq clamps to the 250_000 µc minimum", () => {
    // 50_000/s × 0.5 (≤1280) × 0.6 (draft) = 15_000/s → 150_000 → floored.
    expect(cost({ format: "png-seq", outputSeconds: 10, longEdgePx: 1280, quality: "draft" })).toBe(
      250_000,
    );
  });

  it("the minimum-charge boundary is exact: 25s @ 1080p good wav = 250_000", () => {
    // wav = 10_000/s → 25s is exactly the minimum; 24s clamps up, 26s doesn't.
    expect(cost({ format: "wav", outputSeconds: 25, longEdgePx: 1920 })).toBe(250_000);
    expect(cost({ format: "wav", outputSeconds: 24, longEdgePx: 1920 })).toBe(250_000);
    expect(cost({ format: "wav", outputSeconds: 26, longEdgePx: 1920 })).toBe(260_000);
    expect(cost({ format: "wav", outputSeconds: 30, longEdgePx: 1920 })).toBe(300_000);
  });

  it("mp4 quality ladder at 1080p for 10s: draft 600k / good 1M / best 1.4M", () => {
    expect(cost({ outputSeconds: 10, quality: "draft" })).toBe(600_000);
    expect(cost({ outputSeconds: 10, quality: "good" })).toBe(1_000_000);
    expect(cost({ outputSeconds: 10, quality: "best" })).toBe(1_400_000);
  });

  it("png-seq across resolutions for 60s good: 1.5M / 3M / 6M / 12M px tiers", () => {
    expect(cost({ format: "png-seq", outputSeconds: 60, longEdgePx: 1280 })).toBe(1_500_000);
    expect(cost({ format: "png-seq", outputSeconds: 60, longEdgePx: 1920 })).toBe(3_000_000);
    expect(cost({ format: "png-seq", outputSeconds: 60, longEdgePx: 2560 })).toBe(6_000_000);
    expect(cost({ format: "png-seq", outputSeconds: 60, longEdgePx: 3840 })).toBe(12_000_000);
  });

  it("mp4 60s good across the resolution tiers: 3M / 6M / 12M / 24M µc", () => {
    expect(cost({ outputSeconds: 60, longEdgePx: 1280 })).toBe(3_000_000);
    expect(cost({ outputSeconds: 60, longEdgePx: 1920 })).toBe(6_000_000);
    expect(cost({ outputSeconds: 60, longEdgePx: 2560 })).toBe(12_000_000);
    expect(cost({ outputSeconds: 60, longEdgePx: 3840 })).toBe(24_000_000);
  });

  it("30s @ 1080p draft mp4 = 1_800_000 µc", () => {
    expect(cost({ outputSeconds: 30, quality: "draft" })).toBe(1_800_000);
  });

  it("D-2 reserved formats are priced for completeness (gate refuses elsewhere)", () => {
    // prores 400k/s, gif 150k/s at 1080p good for 10s.
    expect(cost({ format: "prores", outputSeconds: 10 })).toBe(4_000_000);
    expect(cost({ format: "gif", outputSeconds: 10 })).toBe(1_500_000);
    // prores best at 1080p for HALF a second clears the minimum: 280_000.
    expect(cost({ format: "prores", outputSeconds: 0.5, quality: "best" })).toBe(280_000);
    // png-seq best at 720p for 10s: 35_000/s.
    expect(cost({ format: "png-seq", outputSeconds: 10, longEdgePx: 1280, quality: "best" })).toBe(
      350_000,
    );
  });

  it("fractional seconds price at millisecond granularity", () => {
    expect(cost({ outputSeconds: 10.5 })).toBe(1_050_000);
    expect(cost({ outputSeconds: 12.345 })).toBe(1_234_500); // 12345 ms × 100 µc/ms
    expect(cost({ outputSeconds: 59.937, quality: "best" })).toBe(8_391_180); // 59937 ms × 140
  });

  it("long-edge tier boundaries round UP to the next tier at +1 px", () => {
    // 10s good mp4: 1280 → 0.5×, 1281..1920 → 1×, 1921..2560 → 2×, 2561..3840 → 4×.
    expect(cost({ outputSeconds: 10, longEdgePx: 1280 })).toBe(500_000);
    expect(cost({ outputSeconds: 10, longEdgePx: 1281 })).toBe(1_000_000);
    expect(cost({ outputSeconds: 10, longEdgePx: 1920 })).toBe(1_000_000);
    expect(cost({ outputSeconds: 10, longEdgePx: 1921 })).toBe(2_000_000);
    expect(cost({ outputSeconds: 10, longEdgePx: 2560 })).toBe(2_000_000);
    expect(cost({ outputSeconds: 10, longEdgePx: 2561 })).toBe(4_000_000);
    expect(cost({ outputSeconds: 10, longEdgePx: 3840 })).toBe(4_000_000);
    // Portrait orientations price by the long edge — 1080×1920 is still 1×.
    expect(cost({ outputSeconds: 10, longEdgePx: 1920 })).toBe(1_000_000);
    // A 1 px long edge is legal input in the lowest tier.
    expect(cost({ outputSeconds: 10, longEdgePx: 1 })).toBe(500_000);
  });

  it("deterministic and integer for the full formats × qualities × tiers × durations grid", () => {
    const durations = [0.5, 1, 10, 59.937, 600];
    let cases = 0;
    for (const format of RENDER_FORMATS) {
      for (const quality of RENDER_QUALITY_IDS) {
        for (const tier of RENDER_RESOLUTION_TIERS) {
          for (const seconds of durations) {
            const result = estimateRenderCostUc({
              format: format.id,
              outputSeconds: seconds,
              longEdgePx: tier.maxLongEdgePx,
              quality,
            });
            expect(Number.isInteger(result), `${format.id} ${quality} must be integer µc`).toBe(
              true,
            );
            expect(result).toBeGreaterThanOrEqual(RENDER_MIN_CHARGE_UC);
            // Independent oracle: the v1 constant set yields a whole µc per
            // millisecond, so rate × ms must equal the function exactly.
            const rate = RENDER_BASE_RATE_UC[format.id];
            const microPerMs =
              (rate * tier.multiplier.num * RENDER_QUALITY_MULTIPLIERS[quality].num) /
              (1000 * tier.multiplier.den * RENDER_QUALITY_MULTIPLIERS[quality].den);
            expect(Number.isInteger(microPerMs)).toBe(true);
            const expected = Math.max(
              RENDER_MIN_CHARGE_UC,
              microPerMs * Math.round(seconds * 1000),
            );
            expect(result).toBe(expected);
            // Determinism: identical inputs, identical integer output.
            expect(
              estimateRenderCostUc({
                format: format.id,
                outputSeconds: seconds,
                longEdgePx: tier.maxLongEdgePx,
                quality,
              }),
            ).toBe(result);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(5 * 3 * 4 * 5); // 300 pinned cells
  });

  it("a full-day output is the cap and still exact integer µc", () => {
    expect(cost({ outputSeconds: 86_400 })).toBe(8_640_000_000); // 8,640 credits
  });
});

describe("render pricing: illegal inputs are refused with typed errors", () => {
  it("refuses unknown formats and qualities", () => {
    expectInvalid({ format: "exe", outputSeconds: 10 });
    expectInvalid({ format: "", outputSeconds: 10 });
    expectInvalid({ quality: "ultra", outputSeconds: 10 });
    expectInvalid({ quality: "", outputSeconds: 10 });
  });

  it("refuses long edges above 3840 px (illegal input) and non-integer/low edges", () => {
    expectInvalid({ outputSeconds: 10, longEdgePx: 3841 });
    expectInvalid({ outputSeconds: 10, longEdgePx: 5000 });
    expectInvalid({ outputSeconds: 10, longEdgePx: 1e9 });
    expectInvalid({ outputSeconds: 10, longEdgePx: 1920.5 });
    expectInvalid({ outputSeconds: 10, longEdgePx: 0 });
    expectInvalid({ outputSeconds: 10, longEdgePx: -1080 });
  });

  it("refuses durations that are non-positive, over 24h, or finer than a millisecond", () => {
    expectInvalid({ outputSeconds: 0 });
    expectInvalid({ outputSeconds: -1 });
    expectInvalid({ outputSeconds: Number.NaN });
    expectInvalid({ outputSeconds: Number.POSITIVE_INFINITY });
    expectInvalid({ outputSeconds: 86_400.001 });
    expectInvalid({ outputSeconds: 100_000 });
    expectInvalid({ outputSeconds: 0.0005 });
    expectInvalid({ outputSeconds: 10.0001 });
  });

  it("typed errors never echo the offending input values", () => {
    let thrown: unknown;
    try {
      cost({ outputSeconds: 10, longEdgePx: 50_000 });
    } catch (error) {
      thrown = error;
    }
    const longEdgeError = thrown as StudioError;
    expect(longEdgeError.code).toBe("VALIDATION_FAILED");
    expect(longEdgeError.message).not.toContain("50000");
    expect(longEdgeError.message).toContain("3840"); // the rule, never the value
    expect(longEdgeError.hint).toContain("upstream");
    let badFormat: unknown;
    try {
      cost({ format: "definitely-not-a-format", outputSeconds: 10 });
    } catch (error) {
      badFormat = error;
    }
    expect((badFormat as StudioError).message).not.toContain("definitely-not-a-format");
  });
});

describe("render pricing: range → outputSeconds derivation", () => {
  it("defaults to the full duration when no range bounds are set", () => {
    expect(renderOutputSeconds({ durationSeconds: 12 })).toBe(12);
    expect(renderOutputSeconds({ durationSeconds: 10.5 })).toBe(10.5);
  });

  it("derives in/out point combinations", () => {
    expect(renderOutputSeconds({ durationSeconds: 12, timeFrom: 2, timeTo: 8 })).toBe(6);
    expect(renderOutputSeconds({ durationSeconds: 12, timeFrom: 2 })).toBe(10); // in → end
    expect(renderOutputSeconds({ durationSeconds: 12, timeTo: 5 })).toBe(5); // start → out
    expect(renderOutputSeconds({ durationSeconds: 12, timeFrom: 0, timeTo: 0.25 })).toBe(0.25);
  });

  it("refuses non-positive durations, negative bounds, inverted and empty ranges", () => {
    const badRanges: Parameters<typeof renderOutputSeconds>[0][] = [
      { durationSeconds: 0 },
      { durationSeconds: -1 },
      { durationSeconds: Number.NaN },
      { durationSeconds: 12, timeFrom: -0.5 },
      { durationSeconds: 12, timeTo: -1 },
      { durationSeconds: 12, timeFrom: 8, timeTo: 3 }, // inverted
      { durationSeconds: 12, timeFrom: 3, timeTo: 3 }, // empty
      { durationSeconds: 12, timeFrom: Number.POSITIVE_INFINITY },
    ];
    for (const input of badRanges) {
      expect(() => renderOutputSeconds(input), JSON.stringify(input)).toThrow(StudioError);
    }
  });

  it("feeds the estimator: a 10s comp rendered from 2s to 7s prices as 5s", () => {
    const seconds = renderOutputSeconds({ durationSeconds: 10, timeFrom: 2, timeTo: 7 });
    expect(seconds).toBe(5);
    expect(
      estimateRenderCostUc({
        format: "mp4",
        outputSeconds: seconds,
        longEdgePx: 1920,
        quality: "good",
      }),
    ).toBe(500_000);
  });

  it("quality ids match the contracts wire enum (no-drift mirror pin)", () => {
    // @studio/contracts RENDER_QUALITY_SCHEMA = z.enum(["draft", "good", "best"]).
    const CONTRACTS_QUALITY_IDS: readonly RenderQualityId[] = ["draft", "good", "best"];
    expect([...RENDER_QUALITY_IDS]).toEqual([...CONTRACTS_QUALITY_IDS]);
  });
});
