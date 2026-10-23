// Unit tests — ACTUAL cost derivation (D-12 integer µc, one formula): the
// worker's actualCostUc feeds `ledger.settle` and must equal
// estimateRenderCostUc for the same observed facts (frames/fps/range,
// effective long edge, effective quality) — no drift by construction.

import { describe, expect, it } from "vitest";

import { RENDER_MIN_CHARGE_UC, estimateRenderCostUc } from "@studio/config";

import { actualCostUc } from "../src/cost.js";

describe("actualCostUc — single-formula integration with estimateRenderCostUc", () => {
  it("observed frames are the primary output-seconds source", () => {
    // 90 frames @ 29.97 fps = 3.003 s @ 1080 px long edge, quality good — and a
    // DECOY range (999 s) the frames must beat: 100 000 µc/s × 3.003 × 1.0 →
    // 300 300 µc (above the 250 000 µc minimum, so no clamp masks the match).
    const cost = actualCostUc({
      format: "mp4",
      framesTotal: 90,
      fps: 30000 / 1001,
      rangeSeconds: 999,
      longEdgePx: 1920,
      quality: "good",
    });
    const expected = estimateRenderCostUc({
      format: "mp4",
      outputSeconds: 3.003,
      longEdgePx: 1920,
      quality: "good",
    });
    expect(cost.outputSeconds).toBe(3.003); // the observed frames won over the range decoy
    expect(cost.totalUc).toBe(expected);
    expect(Number.isInteger(cost.totalUc)).toBe(true);
    expect(cost.totalUc).toBe(300_300);
  });

  it("the rendered range is the fallback when no progress line was observed", () => {
    const cost = actualCostUc({
      format: "mp4",
      framesTotal: 0,
      fps: 30,
      rangeSeconds: 10,
      longEdgePx: 1920,
      quality: "best",
    });
    expect(cost.totalUc).toBe(
      estimateRenderCostUc({ format: "mp4", outputSeconds: 10, longEdgePx: 1920, quality: "best" }),
    );
    expect(cost.totalUc).toBe(1_400_000); // the M8-B canonical pin (10s@1080p best)
  });

  it("short renders clamp to the platform minimum charge", () => {
    const cost = actualCostUc({
      format: "png-seq",
      framesTotal: 12,
      fps: 30,
      rangeSeconds: 0.4,
      longEdgePx: 640,
      quality: "draft",
    });
    expect(cost.totalUc).toBe(RENDER_MIN_CHARGE_UC);
  });

  it("matches the formula exactly for png-seq at HD", () => {
    // The worker quantizes observed frames to MILLISECOND granularity
    // (the pricing contract's validator); 300 @ 29.97 fps → 10.01 s exactly.
    const cost = actualCostUc({
      format: "png-seq",
      framesTotal: 300,
      fps: 29.97,
      rangeSeconds: 10.01,
      longEdgePx: 1920,
      quality: "good",
    });
    expect(cost.outputSeconds).toBe(10.01);
    expect(cost.totalUc).toBe(
      estimateRenderCostUc({
        format: "png-seq",
        outputSeconds: 10.01,
        longEdgePx: 1920,
        quality: "good",
      }),
    );
    expect(cost.totalUc).toBe(500_500); // 50 000 µc/s × 10.01 s × 1.0 × 1.0
  });

  it("quality multiplier applies through the shared formula (draft 3/5)", () => {
    const base = actualCostUc({
      format: "mp4",
      framesTotal: 300,
      fps: 30,
      rangeSeconds: 10,
      longEdgePx: 1920,
      quality: "good",
    });
    const draft = actualCostUc({
      format: "mp4",
      framesTotal: 300,
      fps: 30,
      rangeSeconds: 10,
      longEdgePx: 1920,
      quality: "draft",
    });
    expect(base.totalUc).toBe(1_000_000);
    expect(draft.totalUc).toBe(600_000);
  });

  it("degenerate fps falls back to 1 without dividing by zero", () => {
    const cost = actualCostUc({
      format: "mp4",
      framesTotal: 30,
      fps: 0,
      rangeSeconds: 30,
      longEdgePx: 1280,
      quality: "good",
    });
    expect(cost.outputSeconds).toBe(30);
    expect(cost.totalUc).toBe(
      estimateRenderCostUc({ format: "mp4", outputSeconds: 30, longEdgePx: 1280, quality: "good" }),
    );
  });
});
