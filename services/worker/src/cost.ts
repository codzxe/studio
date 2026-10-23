// @studio/worker — ACTUAL cost of a completed render (D-12 integer µc).
//
// ONE formula, no drift (packages/config/src/render-pricing.ts): the estimate
// the dialog showed, the amount the gateway RESERVED at queue time, and the
// ACTUAL cost the worker commits on completion all come from
// `estimateRenderCostUc`. The worker's only job is deriving honest inputs:
//   outputSeconds = framesTotal / effectiveFps   (CLI-observed frames are the
//                      primary source; the rendered range is the fallback for
//                      a render so fast it never emitted a progress line)
//   longEdgePx   = the effective output long edge (settings target, else the
//                      comp's native long edge)
//   quality      = effective quality (settings, else `good`)
// `settle` (D-20) then commits min(actual, hold) and releases the FULL hold.

import { type RenderQualityId, estimateRenderCostUc } from "@studio/config";

export interface ActualCostInput {
  readonly format: "mp4" | "png-seq";
  /** Frames the CLI reported (row frames_total); 0 = none observed. */
  readonly framesTotal: number;
  readonly fps: number;
  /** Fallback when no progress line was observed: the rendered range. */
  readonly rangeSeconds: number;
  readonly longEdgePx: number;
  readonly quality: RenderQualityId;
}

export interface ActualCost {
  /** Integer microcredits — the `settle` actualCost input. */
  readonly totalUc: number;
  readonly outputSeconds: number;
}

export function actualCostUc(input: ActualCostInput): ActualCost {
  const fps = input.fps > 0 ? input.fps : 1;
  const rawSeconds =
    input.framesTotal > 0 ? input.framesTotal / fps : Math.max(input.rangeSeconds, 0.001);
  // The pricing contract validates MILLISECOND granularity (its round-trip
  // epsilon rejects 300/29.97-style floats) — quantize exactly as documented.
  const outputSeconds = Math.max(1, Math.round(rawSeconds * 1000)) / 1000;
  const totalUc = estimateRenderCostUc({
    format: input.format,
    outputSeconds,
    longEdgePx: input.longEdgePx,
    quality: input.quality,
  });
  return { totalUc, outputSeconds };
}
