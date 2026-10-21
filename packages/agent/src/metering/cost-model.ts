// @studio/agent — metering: AI cost model. Owner: W9-C.
//
// Spec anchors:
//   Appendix C  provider rates (captured October 2026; verify before use)
//   §22         metrics: tokens in/out/cache, AI cost per run/workspace/day, COGS ratio
//   §5.2        image tier credits (standard 1024² = 1 credit, HD = 2 credits)
//   §0          money note: AI usage priced with 60–75% gross margin, 1 credit = $0.10
//
// This module is PURE: no clock, no network, no I/O. The only boundary is the
// zod-validated `MODEL_RATES_JSON` env override, parsed via an injectable env
// reader (wiring resolves it once at boot and injects the table; the static
// default is exactly Appendix C).
//
// ── Precision choice (deliberate, documented) ─────────────────────────────────
// 1. Every rate is an INTEGER number of micro-USD: text rates are micro-USD per
//    1M tokens ($0.75/M input ⇒ 750_000), image rates are micro-USD per image
//    ($0.015 ⇒ 15_000). Appendix C prices carry ≤ 2 decimals in USD, so the
//    dollar→micro conversion is exact; no float ever touches the arithmetic.
// 2. `computeCost` evaluates the whole formula as ONE bigint rational with the
//    cache-read discount folded in:
//
//        micro = ( 10·(tokensIn − cacheHits)·rateIn
//                + cacheHits·rateIn          // cache reads: 10% of input rate
//                + 10·tokensOut·rateOut
//                + 5_000_000 ) div 10_000_000
//
//    The ×10 scaling removes the cache fraction's denominator; the +5e6 over 1e7
//    pair is round-half-up to the nearest micro-USD (max error $0.0000005 per
//    call, and the direction is fixed so sums never drift systematically).
//    bigint is mandatory: a single frontier call reaches ~10^14 in the
//    numerator (200k tokens × $50/M × 10), and per-day workspace rollups must
//    never round through float64. Every bigint→number conversion at row time
//    goes through `microToSafeNumber`, which refuses to exceed
//    Number.MAX_SAFE_INTEGER instead of silently truncating money.
// 3. Cache-read discount: cache-hit input tokens are billed at 10% of the input
//    rate. Appendix C does not publish cache prices, but the budget assumption
//    line ("80k in / 5k out, 60% cache-hit, 20% buffer ⇒ $0.056 Flash, $0.148
//    Sonnet, $0.297 Opus") is only consistent with a 90% cache discount:
//    0.4·in + 0.6·in/10 + out ⇒ $0.04635 / $0.1236 / $0.2472, ×1.2 buffer =
//    $0.0556 / $0.1483 / $0.2966 — the published values to the cent. The test
//    suite pins all three derivations.
import { z } from "zod";

/** 1 credit = $0.10 list price (§0 money note / Appendix D glossary). */
export const CREDIT_LIST_USD = 0.1;

/** §0 money note: AI usage is priced with 60–75% gross margin. */
export const GROSS_MARGIN_TARGET = { min: 0.6, max: 0.75 } as const;

/** Cache-read tokens are billed at 1/10 of the input rate (see header note 3). */
export const CACHE_READ_PRICE_NUMERATOR = 1n;
export const CACHE_READ_PRICE_DENOMINATOR = 10n;

/** Typed error catalog for the metering money path (never a thrown string). */
export type MeteringErrorCode =
  | "model_rate_missing" // model id has no rate row — refusing to silently price $0
  | "model_rates_env_invalid" // MODEL_RATES_JSON failed zod validation (fail fast)
  | "model_kind_mismatch" // text cost requested for an image model or vice versa
  | "image_hd_unsupported" // HD requested from a draft-only image model
  | "invalid_usage" // negative / fractional / non-finite usage counters
  | "unsafe_number_conversion"; // bigint sum exceeds Number.MAX_SAFE_INTEGER

/** Typed error for the money path: code + hint, never a bare string (AGENTS.md). */
export class MeteringError extends Error {
  readonly code: MeteringErrorCode;
  readonly hint: string;

  constructor(code: MeteringErrorCode, message: string, hint: string) {
    super(`[metering] ${message}`);
    this.name = "MeteringError";
    this.code = code;
    this.hint = hint;
  }
}

/** Text model rate: micro-USD per 1M input / 1M output tokens (Appendix C). */
export interface TextModelRate {
  readonly kind: "text";
  readonly inputMicroPerM: bigint;
  readonly outputMicroPerM: bigint;
}

/** Image model rate: micro-USD per image; HD variant is null when absent (Appendix C). */
export interface ImageModelRate {
  readonly kind: "image";
  readonly imageMicroUsd: bigint;
  readonly imageHdMicroUsd: bigint | null;
}

export type ModelRate = TextModelRate | ImageModelRate;

/** Rate table keyed by the canonical §5.3 model ids (src/models.ts convention). */
export type ModelRatesTable = Readonly<Record<string, ModelRate>>;

export type TextModelId =
  | "gemini-3.8-flash"
  | "gemini-3.1-flash-lite"
  | "gemini-2.5-flash-lite"
  | "deepseek-v4.1-flash"
  | "claude-haiku-4.5"
  | "claude-sonnet-5.5"
  | "claude-opus-5.5"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "gpt-6-astra"
  | "groq-gpt-oss-120b";

export type ImageModelId = "flux-2-schnell" | "gemini-3-pro-image" | "gpt-image-1.5";

export type KnownModelId = TextModelId | ImageModelId;

/** $/M → micro-USD per 1M tokens (exact for Appendix C's ≤2-decimal prices). */
function usdPerMToMicroPerM(usdPerM: number): bigint {
  // One-time float→int conversion at the env boundary; Math.round absorbs
  // binary representation error for any realistic rate (≤6 decimals exact).
  return BigInt(Math.round(usdPerM * 1_000_000));
}

/**
 * Appendix C rates, captured October 2026 — verify before use.
 * NOTE: gemini-3.8-flash doubles to $1.50/$7.50 on 2027-01-01 (flip via
 * MODEL_RATES_JSON or edit this table); deepseek-v4.1-flash is off-peak
 * (peak = 2×) — the router's off-peak preference (§5.3) keeps the listed rate.
 */
export const MODEL_RATES: ModelRatesTable & Record<KnownModelId, ModelRate> = Object.freeze({
  "gemini-3.8-flash": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(0.75),
    outputMicroPerM: usdPerMToMicroPerM(3.75),
  },
  "gemini-3.1-flash-lite": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(0.25),
    outputMicroPerM: usdPerMToMicroPerM(1.5),
  },
  "gemini-2.5-flash-lite": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(0.1),
    outputMicroPerM: usdPerMToMicroPerM(0.4),
  },
  "deepseek-v4.1-flash": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(0.15),
    outputMicroPerM: usdPerMToMicroPerM(0.6),
  },
  "claude-haiku-4.5": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(1.0),
    outputMicroPerM: usdPerMToMicroPerM(5.0),
  },
  "claude-sonnet-5.5": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(2.0),
    outputMicroPerM: usdPerMToMicroPerM(10.0),
  },
  "claude-opus-5.5": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(4.0),
    outputMicroPerM: usdPerMToMicroPerM(20.0),
  },
  "gpt-5.6-terra": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(2.0),
    outputMicroPerM: usdPerMToMicroPerM(12.0),
  },
  "gpt-5.6-luna": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(0.2),
    outputMicroPerM: usdPerMToMicroPerM(1.2),
  },
  "gpt-6-astra": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(10.0),
    outputMicroPerM: usdPerMToMicroPerM(50.0),
  },
  "groq-gpt-oss-120b": {
    kind: "text",
    inputMicroPerM: usdPerMToMicroPerM(0.15),
    outputMicroPerM: usdPerMToMicroPerM(0.6),
  },
  // Image models — per-image pricing (Appendix C); §5.2 HD is a tier property.
  "flux-2-schnell": {
    kind: "image",
    imageMicroUsd: usdToMicroExact(0.015),
    imageHdMicroUsd: null, // draft-only model; HD is Gemini/GPT Image class (§5.2)
  },
  "gemini-3-pro-image": {
    kind: "image",
    imageMicroUsd: usdToMicroExact(0.035),
    imageHdMicroUsd: usdToMicroExact(0.07),
  },
  "gpt-image-1.5": {
    kind: "image",
    imageMicroUsd: usdToMicroExact(0.04),
    imageHdMicroUsd: usdToMicroExact(0.08),
  },
} as ModelRatesTable & Record<KnownModelId, ModelRate>);

/** Per-image $ → micro-USD (exact for Appendix C's ≤3-decimal prices). */
function usdToMicroExact(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

// ── MODEL_RATES_JSON env override (zod-validated) ────────────────────────────
// Shape (operations override or add models without a deploy):
//   {"gemini-3.8-flash":{"kind":"text","inputUsdPerM":1.5,"outputUsdPerM":7.5}}
//   {"gpt-image-1.5":{"kind":"image","imageUsd":0.04,"imageHdUsd":0.08}}
const usdPerMSchema = z
  .number()
  .finite("MODEL_RATES_JSON: rates must be finite numbers")
  .nonnegative("MODEL_RATES_JSON: rates must be >= 0");

const rateOverrideSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    inputUsdPerM: usdPerMSchema,
    outputUsdPerM: usdPerMSchema,
  }),
  z.object({
    kind: z.literal("image"),
    imageUsd: usdPerMSchema,
    imageHdUsd: usdPerMSchema.nullish(),
  }),
]);

export const modelRatesEnvSchema = z.record(z.string().min(1), rateOverrideSchema);

export type ModelRatesEnvOverrides = z.infer<typeof modelRatesEnvSchema>;

/** Typed parse envelope for the env override (never throws — callers log it). */
export type ModelRatesParseResult =
  | { readonly ok: true; readonly overrides: ModelRatesEnvOverrides }
  | {
      readonly ok: false;
      readonly code: "model_rates_env_invalid";
      readonly message: string;
      readonly hint: string;
    };

/** Parses the raw `MODEL_RATES_JSON` string into validated override entries. */
export function parseModelRatesEnv(raw: string | undefined): ModelRatesParseResult {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, overrides: {} };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      code: "model_rates_env_invalid",
      message: "MODEL_RATES_JSON is not valid JSON",
      hint: `fix or unset MODEL_RATES_JSON (${(cause as Error).message})`,
    };
  }
  const parsed = modelRatesEnvSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: "model_rates_env_invalid",
      message: "MODEL_RATES_JSON failed schema validation",
      hint: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, overrides: parsed.data };
}

/** Injectable env shape so wiring/tests never mutate process.env. */
export interface ModelRatesEnv {
  readonly MODEL_RATES_JSON?: string | undefined;
}

/**
 * Default rates merged with the `MODEL_RATES_JSON` override. Garbage in the env
 * FAILS FAST (MeteringError): a silently ignored rate would misprice money
 * (AGENTS.md env rule). Overrides may edit known models or ADD new model ids;
 * they can never remove a row.
 */
export function resolveModelRates(env: ModelRatesEnv = process.env): ModelRatesTable {
  const parsed = parseModelRatesEnv(env.MODEL_RATES_JSON);
  if (!parsed.ok) {
    throw new MeteringError(parsed.code, parsed.message, parsed.hint);
  }
  const merged: Record<string, ModelRate> = { ...MODEL_RATES };
  for (const [model, override] of Object.entries(parsed.overrides)) {
    merged[model] =
      override.kind === "text"
        ? {
            kind: "text",
            inputMicroPerM: usdPerMToMicroPerM(override.inputUsdPerM),
            outputMicroPerM: usdPerMToMicroPerM(override.outputUsdPerM),
          }
        : {
            kind: "image",
            imageMicroUsd: usdToMicroExact(override.imageUsd),
            imageHdMicroUsd:
              override.imageHdUsd == null ? null : usdToMicroExact(override.imageHdUsd),
          };
  }
  return Object.freeze(merged);
}

/** True when `model` has a rate row in `rates` (pre-check for telemetry paths). */
export function hasModelRate(model: string, rates: ModelRatesTable = MODEL_RATES): boolean {
  return Object.prototype.hasOwnProperty.call(rates, model);
}

function requireTextRate(model: string, rates: ModelRatesTable): TextModelRate {
  const rate = rates[model];
  if (rate === undefined) {
    throw new MeteringError(
      "model_rate_missing",
      `no rate row for model "${model}"`,
      'add it to MODEL_RATES or the MODEL_RATES_JSON env override — costs are never silently priced $0',
    );
  }
  if (rate.kind !== "text") {
    throw new MeteringError(
      "model_kind_mismatch",
      `model "${model}" is an image model; use imageCost()`,
      "text token pricing requested for a per-image model",
    );
  }
  return rate;
}

/** Asserts the usage counter contract: non-negative safe integers (money path). */
function assertTokenCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MeteringError(
      "invalid_usage",
      `${field} must be a non-negative safe integer, got ${value}`,
      "sanitize provider telemetry before it reaches the money path",
    );
  }
}

/** One provider call's token usage. `cacheHits` are a subset of `tokensIn`. */
export interface CostInput {
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits?: number;
}

/**
 * Exact token cost of one model call, in micro-USD (bigint; see header for the
 * precision contract). Cache-hit input tokens are billed at 10% of the input
 * rate (Appendix C budget-assumption derivation, pinned in tests). Throws a
 * typed MeteringError on unknown models / mismatched kinds / bad counters.
 */
export function computeCost(
  input: CostInput,
  rates: ModelRatesTable = MODEL_RATES,
): bigint {
  const tokensIn = input.tokensIn;
  const tokensOut = input.tokensOut;
  const cacheHits = input.cacheHits ?? 0;
  assertTokenCount(tokensIn, "tokensIn");
  assertTokenCount(tokensOut, "tokensOut");
  assertTokenCount(cacheHits, "cacheHits");
  if (cacheHits > tokensIn) {
    throw new MeteringError(
      "invalid_usage",
      `cacheHits (${cacheHits}) exceed tokensIn (${tokensIn})`,
      "cache hits are a subset of input tokens by definition",
    );
  }
  const rate = requireTextRate(input.model, rates);
  // Single rational over a common denominator — see precision note 2:
  //   numerator   = 10·(in − cache)·rateIn + cache·rateIn + 10·out·rateOut
  //   denominator = 10 × 1e6 = 1e7 (cache fold × micro-per-million), half-up.
  const ten = CACHE_READ_PRICE_DENOMINATOR;
  const numerator =
    ten * BigInt(tokensIn - cacheHits) * rate.inputMicroPerM +
    BigInt(cacheHits) * rate.inputMicroPerM +
    ten * BigInt(tokensOut) * rate.outputMicroPerM;
  const denominator = ten * 1_000_000n;
  return (numerator + denominator / 2n) / denominator;
}

/** Image quality axis from §5.2 (standard 1024² tier vs the HD tier). */
export type ImageQuality = "standard" | "hd";

/** COGS ($ per Appendix C) and the user-facing §5.2 tier price, together. */
export interface ImageCostResult {
  readonly microUsd: bigint;
  /** §5.2 credits charged per image: standard = 1, HD = 2. */
  readonly credits: 1 | 2;
}

/**
 * Per-image COGS (Appendix C dollars → micro-USD) alongside the §5.2 tier
 * credits the image costs the user. `model` is the routed §5.3 image model id
 * ("flux-2-schnell" | "gemini-3-pro-image" | "gpt-image-1.5"). HD on a
 * draft-only model is refused (typed error), never priced at the draft rate.
 */
export function imageCost(
  model: string,
  quality: ImageQuality,
  rates: ModelRatesTable = MODEL_RATES,
): ImageCostResult {
  if (quality !== "standard" && quality !== "hd") {
    throw new MeteringError(
      "invalid_usage",
      `unknown image quality "${String(quality)}"`,
      'quality must be "standard" or "hd" (§5.2 image tiers)',
    );
  }
  const rate = rates[model];
  if (rate === undefined) {
    throw new MeteringError(
      "model_rate_missing",
      `no rate row for image model "${model}"`,
      "add it to MODEL_RATES or the MODEL_RATES_JSON env override",
    );
  }
  if (rate.kind !== "image") {
    throw new MeteringError(
      "model_kind_mismatch",
      `model "${model}" is a text model; use computeCost()`,
      "per-image pricing requested for a token-priced model",
    );
  }
  if (quality === "hd" && rate.imageHdMicroUsd === null) {
    throw new MeteringError(
      "image_hd_unsupported",
      `model "${model}" has no HD tier`,
      "§5.2 HD images route to Gemini Image / GPT Image class models only",
    );
  }
  const microUsd = quality === "hd" ? (rate.imageHdMicroUsd as bigint) : rate.imageMicroUsd;
  return { microUsd, credits: quality === "hd" ? 2 : 1 };
}

/**
 * bigint micro-USD → number, refusing values above Number.MAX_SAFE_INTEGER.
 * DB columns (agent_runs.cost_micro_usd, jsonb model calls) are numbers; a
 * silent float64 wrap would corrupt money, so overflow fails fast instead.
 */
export function microToSafeNumber(micro: bigint): number {
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MeteringError(
      "unsafe_number_conversion",
      `micro-USD value ${micro} exceeds Number.MAX_SAFE_INTEGER`,
      "flush rollups (per-run/per-day rows) before accumulators grow unbounded",
    );
  }
  return Number(micro);
}

/** Zone vs the §0 60–75% gross-margin target. */
export type MarginZone = "below_target" | "in_target" | "above_target";

/** COGS margin check for §22 business dashboards (MRR / COGS ratio). */
export interface MarginCheck {
  /** Gross margin as a fraction of list revenue: (revenue − cost) / revenue. */
  readonly grossMargin: number;
  /** COGS ratio: cost / revenue (1 − grossMargin). */
  readonly cogsRatio: number;
  readonly zone: MarginZone;
  /** List revenue in USD: credits × $0.10 (Appendix D). */
  readonly revenueUsd: number;
}

/**
 * COGS margin check (§0 money note): `costUsd` is actual AI cost for the run /
 * day / workspace, `credits` the credits charged at list price ($0.10 each).
 * Returns gross margin, the COGS ratio and the zone vs the 60–75% target —
 * the §22 "COGS ratio" business-dashboard metric. Integer micro-USD math
 * throughout; only the final ratio crosses into float.
 */
export function margin(costUsd: number, credits: number): MarginCheck {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new MeteringError(
      "invalid_usage",
      `costUsd must be a finite non-negative number, got ${costUsd}`,
      "metering feeds the COGS dashboard; sanitize inputs upstream",
    );
  }
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new MeteringError(
      "invalid_usage",
      `credits must be a non-negative integer, got ${credits}`,
      "credits are whole ledger units (§14)",
    );
  }
  const costMicro = usdToMicroExact(costUsd);
  const revenueMicro = BigInt(credits) * usdToMicroExact(CREDIT_LIST_USD);
  if (revenueMicro === 0n) {
    // Degenerate conventions (pinned by tests): free run with zero cost keeps
    // a vacuous 100% margin; any cost against zero revenue is fully underwater.
    const underwater = costMicro > 0n;
    return Object.freeze({
      grossMargin: underwater ? Number.NEGATIVE_INFINITY : 1,
      cogsRatio: underwater ? Number.POSITIVE_INFINITY : 0,
      zone: underwater ? ("below_target" as const) : ("in_target" as const),
      revenueUsd: 0,
    });
  }
  const cogsRatio = Number(costMicro) / Number(revenueMicro);
  // Derive grossMargin straight from the integer rational (rev − cost)/rev:
  // deriving it as 1 − cogsRatio would compound float error at the band edges.
  const grossMargin = Number(revenueMicro - costMicro) / Number(revenueMicro);
  const zone: MarginZone =
    grossMargin < GROSS_MARGIN_TARGET.min
      ? "below_target"
      : grossMargin > GROSS_MARGIN_TARGET.max
        ? "above_target"
        : "in_target";
  return Object.freeze({
    grossMargin,
    cogsRatio,
    zone,
    revenueUsd: credits * CREDIT_LIST_USD,
  });
}
