import { type RenderFormatId } from "./plans.js";
declare const RENDER_QUALITY_ID_UNION: readonly ["draft", "good", "best"];
/** Render quality levels — mirror of `@studio/contracts` RENDER_QUALITY_SCHEMA. */
export type RenderQualityId = (typeof RENDER_QUALITY_ID_UNION)[number];
/** Every declared quality id, in picker order. Frozen. */
export declare const RENDER_QUALITY_IDS: readonly RenderQualityId[];
/** Type guard: narrows external strings to {@link RenderQualityId}. */
export declare function isRenderQualityId(value: string): value is RenderQualityId;
/**
 * Base rate per OUTPUT second in integer µc (D-12), keyed by declared format.
 * BUSINESS-PENDING numbers (BUILD_PLAN §M8): mp4 0.1 credit/s, png-seq 0.05,
 * and the D-2 reserved formats priced for completeness (prores 0.4, gif 0.15,
 * wav 0.01 credits/s) — the D-2 gate still refuses the reserved ones at
 * queue time.
 */
export declare const RENDER_BASE_RATE_UC: Readonly<Record<RenderFormatId, number>>;
/**
 * `true` iff the id is a DECLARED render format (enabled or D-2 reserved).
 * Unknown ids are `false` — the pricing table refuses them with a typed error.
 */
export declare function isRenderFormatDeclared(id: string): boolean;
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
export declare const RENDER_RESOLUTION_TIERS: readonly RenderResolutionTier[];
/** Quality multipliers: draft 0.6× (3/5), good 1× (1/1), best 1.4× (7/5). */
export declare const RENDER_QUALITY_MULTIPLIERS: Readonly<Record<RenderQualityId, RenderMultiplier>>;
/**
 * Minimum charge per render in integer µc (0.25 credits) — the floor applied
 * AFTER rounding, so even a short render always books a real job.
 */
export declare const RENDER_MIN_CHARGE_UC: 250000;
/**
 * Hard cap on the requested long edge in px. Above this the input is ILLEGAL
 * and must be refused upstream (typed error here; the gateway's Zod layer
 * rejects it first). Matches the top resolution tier exactly.
 */
export declare const RENDER_MAX_LONG_EDGE_PX: 3840;
/**
 * Hard cap on output duration: 24 h of output in one job. Above this the
 * input is ILLEGAL — no real render exceeds a day, and the cap keeps every
 * intermediate product of the integer formula below 2^53 (exact in doubles).
 */
export declare const RENDER_MAX_OUTPUT_SECONDS: 86400;
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
export declare function estimateRenderCostUc(input: RenderCostInput): number;
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
export declare function estimateRenderCostDetailUc(input: RenderCostInput): RenderCostDetail;
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
export declare function renderOutputSeconds(input: RenderRangeInput): number;
export {};
