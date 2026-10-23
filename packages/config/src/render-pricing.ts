// @studio/config — render pricing & range derivation (BUILD_PLAN §M8,
// DECISIONS D-2/D-12, PRODUCT_ARCHITECTURE §10.2 render seconds × rate).
//
// ONE formula, three uses: `estimateRenderCostUc` is the credit ESTIMATE the
// render dialog shows, the RESERVE the gateway holds when queuing, and the
// COMMIT amount charged on completion — there is no second formula, so the
// three can never drift (the M6 reserve → commit → refund ledger semantics,
// D-20, consume this integer directly).
//
// Binding rulings encoded here:
// - D-2  v1 render formats are MP4 (H.264) + PNG sequence only; ProRes, GIF
//        and WAV stay declared but disabled. They are still PRICED below for
//        completeness — the D-2 gate (`isRenderFormatEnabled` in plans.ts)
//        refuses them at queue time; pricing and gating are separate seams.
// - D-12 all money math is INTEGER microcredits. Multipliers are exact
//        rational numbers (num/den), never floats: the µc amount is multiplied
//        by the numerators first, then divided ONCE at the very end with
//        round-half-up. No intermediate division ever truncates.
//
// EXACT ORDER OF OPERATIONS (the deterministic contract):
//  1. Validate every input (typed `VALIDATION_FAILED`; messages state the
//     rule, never echo the raw value).
//  2. `outputMs = round(outputSeconds × 1000)` — validated millisecond
//     granularity; this is the ONLY place seconds become an integer.
//  3. `numerator   = RENDER_BASE_RATE_UC[format] × outputMs × resNum × qualNum`
//     (all integers — exact up to 2^53, guaranteed by the caps below).
//  4. `denominator = 1000 × resDen × qualDen` (integer).
//  5. `raw = floor((2 × numerator + denominator) / (2 × denominator))`
//     — round-half-up, applied ONCE, at the end.
//  6. `result = max(raw, RENDER_MIN_CHARGE_UC)` — the minimum-charge clamp.
//
// With the v1 constant set every per-millisecond rate is a whole µc and step 5
// divides exactly; the round-half-up step is exactness insurance that keeps
// working if a future price table stops dividing cleanly.

import { StudioError } from "./errors.js";
import { RENDER_FORMATS, type RenderFormatId } from "./plans.js";

// ───────────────────────────────────────────────────────────────────────────
// Quality ids (mirror of @studio/contracts RENDER_QUALITY_SCHEMA)
// ───────────────────────────────────────────────────────────────────────────

const RENDER_QUALITY_ID_UNION = ["draft", "good", "best"] as const;

/** Render quality levels — mirror of `@studio/contracts` RENDER_QUALITY_SCHEMA. */
export type RenderQualityId = (typeof RENDER_QUALITY_ID_UNION)[number];

/** Every declared quality id, in picker order. Frozen. */
export const RENDER_QUALITY_IDS: readonly RenderQualityId[] = Object.freeze([
  ...RENDER_QUALITY_ID_UNION,
]);

/** Type guard: narrows external strings to {@link RenderQualityId}. */
export function isRenderQualityId(value: string): value is RenderQualityId {
  return (RENDER_QUALITY_IDS as readonly string[]).includes(value);
}

// ───────────────────────────────────────────────────────────────────────────
// The price table (integer µc per OUTPUT second)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Base rate per OUTPUT second in integer µc (D-12), keyed by declared format.
 * BUSINESS-PENDING numbers (BUILD_PLAN §M8): mp4 0.1 credit/s, png-seq 0.05,
 * and the D-2 reserved formats priced for completeness (prores 0.4, gif 0.15,
 * wav 0.01 credits/s) — the D-2 gate still refuses the reserved ones at
 * queue time.
 */
export const RENDER_BASE_RATE_UC: Readonly<Record<RenderFormatId, number>> = deepFreeze({
  mp4: 100_000,
  "png-seq": 50_000,
  prores: 400_000,
  gif: 150_000,
  wav: 10_000,
} as const satisfies Readonly<Record<RenderFormatId, number>>);

/**
 * `true` iff the id is a DECLARED render format (enabled or D-2 reserved).
 * Unknown ids are `false` — the pricing table refuses them with a typed error.
 */
export function isRenderFormatDeclared(id: string): boolean {
  return RENDER_FORMATS.some((format) => format.id === id);
}

// ───────────────────────────────────────────────────────────────────────────
// Multipliers (exact rationals — num/den, never floats)
// ───────────────────────────────────────────────────────────────────────────

/** An exact rational multiplier; `num/den` is the value, both integers. */
export interface RenderMultiplier {
  readonly num: number;
  readonly den: number;
}

/**
 * Resolution multiplier tiers by LONG EDGE px. The first tier whose
 * `maxLongEdgePx` is ≥ the requested long edge applies; above 3840 px the
 * input is refused upstream of pricing (see {@link RENDER_MAX_LONG_EDGE_PX}).
 * D-7 note: the 1280 tier exists for RENDERS smaller than HD; browser
 * PREVIEWS cap at 1280 px long edge, but final renders may exceed it.
 */
export interface RenderResolutionTier {
  /** Inclusive upper bound on the long edge for this tier. */
  readonly maxLongEdgePx: number;
  /** Exact multiplier applied to the base rate. */
  readonly multiplier: RenderMultiplier;
}

/** Resolution tiers in ascending order — 0.5×/1×/2×/4× (D-12 rationals). */
export const RENDER_RESOLUTION_TIERS: readonly RenderResolutionTier[] = deepFreeze([
  { maxLongEdgePx: 1280, multiplier: { num: 1, den: 2 } },
  { maxLongEdgePx: 1920, multiplier: { num: 1, den: 1 } },
  { maxLongEdgePx: 2560, multiplier: { num: 2, den: 1 } },
  { maxLongEdgePx: 3840, multiplier: { num: 4, den: 1 } },
] as const satisfies readonly RenderResolutionTier[]);

/** Quality multipliers: draft 0.6× (3/5), good 1× (1/1), best 1.4× (7/5). */
export const RENDER_QUALITY_MULTIPLIERS: Readonly<Record<RenderQualityId, RenderMultiplier>> =
  deepFreeze({
    draft: { num: 3, den: 5 },
    good: { num: 1, den: 1 },
    best: { num: 7, den: 5 },
  } as const satisfies Readonly<Record<RenderQualityId, RenderMultiplier>>);

// ───────────────────────────────────────────────────────────────────────────
// Bounds and the minimum charge
// ───────────────────────────────────────────────────────────────────────────

/**
 * Minimum charge per render in integer µc (0.25 credits) — the floor applied
 * AFTER rounding, so even a short render always books a real job.
 */
export const RENDER_MIN_CHARGE_UC = 250_000 as const;

/**
 * Hard cap on the requested long edge in px. Above this the input is ILLEGAL
 * and must be refused upstream (typed error here; the gateway's Zod layer
 * rejects it first). Matches the top resolution tier exactly.
 */
export const RENDER_MAX_LONG_EDGE_PX = 3840 as const;

/**
 * Hard cap on output duration: 24 h of output in one job. Above this the
 * input is ILLEGAL — no real render exceeds a day, and the cap keeps every
 * intermediate product of the integer formula below 2^53 (exact in doubles).
 */
export const RENDER_MAX_OUTPUT_SECONDS = 86_400 as const;

// ───────────────────────────────────────────────────────────────────────────
// estimateRenderCostUc — the single estimate/reserve/commit formula
// ───────────────────────────────────────────────────────────────────────────

/** Inputs to {@link estimateRenderCostUc}. All four fields are required. */
export interface RenderCostInput {
  /** Declared render format (enabled or D-2 reserved — see the module header). */
  readonly format: RenderFormatId;
  /** Output duration in seconds; > 0, ≤ 24 h, millisecond granularity. */
  readonly outputSeconds: number;
  /** Long edge of the requested output in px; integer 1..3840. */
  readonly longEdgePx: number;
  /** Quality level (mirror of the contracts enum). */
  readonly quality: RenderQualityId;
}

/** Internal result of the single cost computation (never re-derived twice). */
interface ComputedRenderCost {
  /** The exact formula output BEFORE the minimum-charge clamp. */
  readonly rawUc: number;
  /** The clamped, chargeable amount — what estimateRenderCostUc returns. */
  readonly totalUc: number;
}

/** One shared computation behind both exports — the no-drift guarantee. */
function computeRenderCost(input: RenderCostInput): ComputedRenderCost {
  const { format, outputSeconds, longEdgePx, quality } = input;
  if (!isRenderFormatDeclared(format)) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Unknown render format.",
      hint: "Expected one of the declared formats: mp4, png-seq, prores, gif, wav.",
    });
  }
  if (!isRenderQualityId(quality)) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Unknown render quality.",
      hint: "Expected one of: draft, good, best.",
    });
  }
  if (!Number.isInteger(longEdgePx) || longEdgePx < 1 || longEdgePx > RENDER_MAX_LONG_EDGE_PX) {
    throw new StudioError("VALIDATION_FAILED", {
      message: `Render long edge must be a whole number of pixels, 1 to ${RENDER_MAX_LONG_EDGE_PX}.`,
      hint: "Larger outputs are not supported; refuse anything above the cap upstream.",
    });
  }
  const outputMs = Math.round(outputSeconds * 1000);
  if (
    !Number.isFinite(outputSeconds) ||
    outputSeconds <= 0 ||
    outputSeconds > RENDER_MAX_OUTPUT_SECONDS ||
    Math.abs(outputMs / 1000 - outputSeconds) > 1e-9
  ) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Render duration must be positive, at most 24 hours, in whole milliseconds.",
      hint: "Convert the comp range to seconds (millisecond precision) before estimating.",
    });
  }
  const base = RENDER_BASE_RATE_UC[format];
  const resolution = RENDER_RESOLUTION_TIERS.find(
    (tier) => longEdgePx <= tier.maxLongEdgePx,
  )?.multiplier;
  const qualityMultiplier = RENDER_QUALITY_MULTIPLIERS[quality];
  if (resolution === undefined || qualityMultiplier === undefined) {
    // Unreachable with validated inputs; kept so the math below stays total.
    throw new StudioError("VALIDATION_FAILED", {
      message: "Render pricing tables are incomplete for this input.",
      hint: "This is a configuration bug — report it; nothing was charged.",
    });
  }
  // Integer math only (D-12): multiply everything into the numerator first.
  const numerator = base * outputMs * resolution.num * qualityMultiplier.num;
  const denominator = 1000 * resolution.den * qualityMultiplier.den;
  // Round-half-up, ONCE, at the end: floor((2N + D) / (2D)).
  const raw = Math.floor((2 * numerator + denominator) / (2 * denominator));
  return { rawUc: raw, totalUc: Math.max(raw, RENDER_MIN_CHARGE_UC) };
}

/**
 * Deterministic render cost in INTEGER microcredits (D-12) — the estimate the
 * UI shows, the amount the gateway reserves at queue time and the amount it
 * commits on completion. One formula, no drift.
 *
 * Order of operations is the module-header contract: validate → integer ms →
 * multiply by every numerator → ONE round-half-up division → minimum-charge
 * clamp. Deterministic for identical inputs; never touches floats for money.
 *
 * Throws a typed `StudioError` (`VALIDATION_FAILED`) for undeclared formats,
 * unknown qualities, non-integer or out-of-range long edges (> 3840 px is
 * illegal input), and durations that are non-positive, above 24 h or finer
 * than a millisecond. Error messages state the rule, never the raw value.
 */
export function estimateRenderCostUc(input: RenderCostInput): number {
  return computeRenderCost(input).totalUc;
}

/**
 * Breakdown behind {@link estimateRenderCostUc} for the estimate ROUTE
 * (`POST /v1/renders/estimate` — the M8-C contracts `EstimateResult`):
 * the same single computation, plus the pre-clamp raw amount so the gateway
 * can report `minApplied` WITHOUT re-deriving the formula (which would be
 * the one place drift could creep in). Same typed-error contract.
 */
export interface RenderCostDetail {
  /** The chargeable amount — always `estimateRenderCostUc(input)`. */
  readonly totalUc: number;
  /** The exact formula output BEFORE the minimum-charge clamp. */
  readonly rawUc: number;
  /** `true` iff the platform minimum charge was applied (raw < minimum). */
  readonly minApplied: boolean;
}

/**
 * The estimate-route breakdown: total, raw pre-clamp amount and the
 * `minApplied` flag the wire exposes — one computation, no second formula.
 * Frozen result; same validation errors as {@link estimateRenderCostUc}.
 */
export function estimateRenderCostDetailUc(input: RenderCostInput): RenderCostDetail {
  const { rawUc, totalUc } = computeRenderCost(input);
  return Object.freeze({
    totalUc,
    rawUc,
    minApplied: rawUc < RENDER_MIN_CHARGE_UC,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Range → outputSeconds derivation (pure helper for the gateway)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inputs to {@link renderOutputSeconds}. The gateway owns the comp timeline —
 * values here must already lie inside it; this helper is pure arithmetic.
 */
export interface RenderRangeInput {
  /** Full composition duration in seconds (> 0). */
  readonly durationSeconds: number;
  /** Range start in seconds; defaults to 0. */
  readonly timeFrom?: number;
  /** Range end in seconds; defaults to the full duration. */
  readonly timeTo?: number;
}

/**
 * Output seconds for a render request: `(timeTo ?? durationSeconds) −
 * (timeFrom ?? 0)` — a full-duration render when both bounds are omitted, the
 * in-point to the end when only `timeFrom` is set, and the start to an
 * out-point when only `timeTo` is set (the wire contracts make both bounds
 * optional). The gateway computes range bounds from the comp timeline and
 * feeds the result to {@link estimateRenderCostUc}.
 *
 * Throws a typed `StudioError` (`VALIDATION_FAILED`) when the duration is
 * non-positive, a bound is negative/non-finite, or the range is inverted or
 * empty (a zero-length render is illegal input).
 */
export function renderOutputSeconds(input: RenderRangeInput): number {
  const { durationSeconds, timeFrom, timeTo } = input;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Composition duration must be a positive number of seconds.",
      hint: "Read the duration from the comp timeline before deriving the range.",
    });
  }
  const from = timeFrom ?? 0;
  const to = timeTo ?? durationSeconds;
  if (!Number.isFinite(from) || from < 0 || !Number.isFinite(to) || to < 0 || to < from) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Render range must satisfy 0 ≤ timeFrom ≤ timeTo.",
      hint: "Fix the requested in/out points and try again.",
    });
  }
  const seconds = to - from;
  if (seconds <= 0) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "The render range is empty — nothing to render.",
      hint: "Pick a range with at least one frame of output.",
    });
  }
  return seconds;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
