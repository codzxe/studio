// @studio/web — render dialog derivations (BUILD_PLAN §M8 task 2; D-2/D-7).
//
// D-2 (v1 formats): ONLY enabled formats are offered — MP4 (H.264) + PNG
// sequence. Reserved formats (prores/gif/wav) are NOT shown, not
// shown-disabled; the labels come from `@studio/config` RENDER_FORMATS so the
// picker and the entitlement gate can never drift. The server stays the
// authority on per-plan pixel caps (D-7's 1280 px long-edge cap is for
// PREVIEWS, not finals) — the dialog never guesses a cap client-side; it
// shows the estimate's server-clamped `longEdgePx` back instead.

import { RENDER_FORMATS } from "@studio/config";
import type { RenderFormat, RenderQuality, RenderSettings } from "@studio/contracts";
import type { RenderComp } from "./types";

/**
 * The v1-enabled picker options, derived from the config catalog (D-2).
 * `format` is the wire id; `label` is the honest UI label.
 */
export interface RenderFormatOption {
  readonly id: RenderFormat;
  readonly label: string;
}

/** Enabled-only by construction — reserved formats are absent, never dimmed. */
export const RENDER_FORMAT_OPTIONS: readonly RenderFormatOption[] = RENDER_FORMATS.filter(
  (format) => format.enabled,
).map((format) => ({ id: format.id, label: format.label }));

/** Quality ladder (§9.1 renders.settings.quality; UI_DS §14 wording). */
export const RENDER_QUALITY_OPTIONS: ReadonlyArray<{
  readonly id: RenderQuality;
  readonly label: string;
}> = [
  { id: "draft", label: "Draft" },
  { id: "good", label: "Good" },
  { id: "best", label: "Best" },
];

/**
 * Resolution tiers — a factor of the comp's NATIVE size (the CLI's
 * `--resolution full|half|quarter` mapping, docs/phases/m8-cli-spike.md §2).
 * The exact clamped output size is the server's call; the readout shows the
 * computed request, the estimate shows what the plan allows.
 */
export type RenderResolutionTier = "full" | "half" | "quarter";

export const RENDER_RESOLUTION_OPTIONS: ReadonlyArray<{
  readonly id: RenderResolutionTier;
  readonly label: string;
  readonly factor: number;
}> = [
  { id: "full", label: "Full", factor: 1 },
  { id: "half", label: "Half", factor: 0.5 },
  { id: "quarter", label: "Quarter", factor: 0.25 },
];

/** fps fallback when the comp does not report one (29.97 is the engine's own default). */
export const DEFAULT_FRAME_RATE = 29.97;

/** The comp's work-area in/out, else the full duration, else 0..0 (the server prices the truth). */
export function defaultRange(comp: RenderComp): { readonly from: number; readonly to: number } {
  if (comp.workFrom !== null && comp.workTo !== null && comp.workTo >= comp.workFrom) {
    return { from: comp.workFrom, to: comp.workTo };
  }
  if (comp.durationSeconds !== null && comp.durationSeconds > 0) {
    return { from: 0, to: comp.durationSeconds };
  }
  return { from: 0, to: 0 };
}

/** The native size the tier factors are applied to; null when unknown. */
export function nativeSize(comp: RenderComp): { readonly w: number; readonly h: number } | null {
  if (comp.width === null || comp.height === null) return null;
  return { w: comp.width, h: comp.height };
}

/** Explicit pixel size for a tier (rounded — the wire takes integers). */
export function tierSize(
  comp: RenderComp,
  tier: RenderResolutionTier,
): { readonly width: number; readonly height: number } | null {
  const native = nativeSize(comp);
  if (native === null) return null;
  const factor = RENDER_RESOLUTION_OPTIONS.find((option) => option.id === tier)?.factor ?? 1;
  return {
    width: Math.max(1, Math.round(native.w * factor)),
    height: Math.max(1, Math.round(native.h * factor)),
  };
}

/** Parsed range inputs → the wire settings (never throws; NaN → null fields). */
export function buildRenderSettings(input: {
  readonly comp: RenderComp;
  readonly tier: RenderResolutionTier;
  readonly timeFrom: number;
  readonly timeTo: number;
  readonly frameRate: number;
  readonly quality: RenderQuality;
}): RenderSettings {
  const size = tierSize(input.comp, input.tier);
  return {
    timeFrom: input.timeFrom,
    timeTo: input.timeTo,
    frameRate: input.frameRate,
    quality: input.quality,
    ...(size === null ? {} : { width: size.width, height: size.height }),
  };
}

/**
 * Credits, 2 decimals, always with the unit (D-12: whole-credit DISPLAY
 * numbers on the wire; the UI never re-derives from µc).
 */
export function formatCreditsDisplay(value: number): string {
  return `${value.toFixed(2)} credits`;
}
