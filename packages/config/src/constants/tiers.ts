// @studio/config — run tiers and budgets, spec §5.2 (exact table) + §14.1 multipliers.
//
//  | Tier      | Credits | Model class        | Token budget (in/out) | Tool calls | Revisions | Wall clock |
//  | quick     | 1       | economy           | 20k / 2k              | 6         | 1         | 2 min      |
//  | standard  | 2       | default           | 80k / 5k              | 12        | 2         | 5 min      |
//  | complex   | 5       | default+          | 200k / 12k            | 24        | 2         | 10 min     |
//  | premium   | ×2 base | Sonnet-class      | +50%                  | +50%      | 2         | 10 min     |
//  | max       | ×4 base | Opus-class        | +100%                 | +100%     | 3         | 15 min     |
//  | image gen | 1       | Flux-class        | n/a                   | 1         | 0         | 1 min      |
//  | image HD  | 2       | Gemini/GPT Image  | n/a                   | 1         | 0         | 2 min      |
//
// Premium/max multiply a base tier (§14.1: "multiply the base tier cost"). Their
// base is STANDARD: §14.4 pins premium = 4 credits and max = 8 credits (2×/4× of a
// standard run). Wall clock and revision counts are absolute per the §5.2 rows.
import { z } from 'zod';

export const RUN_TIER_IDS = [
  'quick',
  'standard',
  'complex',
  'premium',
  'max',
  'image_gen',
  'image_gen_hd',
] as const satisfies readonly string[];

export type RunTierId = (typeof RUN_TIER_IDS)[number];

export const RUN_TIER_ID_SCHEMA = z.enum(RUN_TIER_IDS);

/** Model classes per §5.2/§5.3 routing table. */
export const MODEL_CLASSES = [
  'economy',
  'default',
  'default_plus',
  'sonnet',
  'opus',
  'flux',
  'gemini_gpt_image',
] as const satisfies readonly string[];

export type ModelClass = (typeof MODEL_CLASSES)[number];

export const MODEL_CLASS_SCHEMA = z.enum(MODEL_CLASSES);

const positiveInt = z.number().int().min(1);
const nonNegativeInt = z.number().int().min(0);

/** A tier with absolute budgets (§5.2 rows 1–3). */
export const baseTierSchema = z
  .object({
    kind: z.literal('base'),
    credits: positiveInt,
    modelClass: MODEL_CLASS_SCHEMA,
    tokenBudgetIn: nonNegativeInt,
    tokenBudgetOut: nonNegativeInt,
    toolCallCap: positiveInt,
    revisions: nonNegativeInt,
    wallClockMs: positiveInt,
    // §5.1: no more than 8 model↔tool round trips per phase by default.
    roundtripsPerPhase: positiveInt,
  })
  .strict();

export type BaseTierConfig = z.infer<typeof baseTierSchema>;

/** Premium/max: multipliers over a base tier (§5.2 rows 4–5, §14.1). */
export const multipliedTierSchema = z
  .object({
    kind: z.literal('multiplied'),
    baseTier: z.enum(['standard', 'complex']),
    creditMultiplier: z.number().int().min(2),
    tokenBudgetMultiplier: z.number().positive(),
    toolCallMultiplier: z.number().positive(),
    modelClass: MODEL_CLASS_SCHEMA,
    revisions: nonNegativeInt,
    wallClockMs: positiveInt,
  })
  .strict();

export type MultipliedTierConfig = z.infer<typeof multipliedTierSchema>;

/** Image generation tiers (§5.2 rows 6–7): no token budget, one tool call, no revisions. */
export const imageTierSchema = z
  .object({
    kind: z.literal('image'),
    credits: positiveInt,
    modelClass: MODEL_CLASS_SCHEMA,
    toolCallCap: z.literal(1),
    revisions: z.literal(0),
    wallClockMs: positiveInt,
  })
  .strict();

export type ImageTierConfig = z.infer<typeof imageTierSchema>;

export type TierConfig = BaseTierConfig | MultipliedTierConfig | ImageTierConfig;

export const TIER_CONFIG_SCHEMA = z
  .object({
    quick: baseTierSchema,
    standard: baseTierSchema,
    complex: baseTierSchema,
    premium: multipliedTierSchema,
    max: multipliedTierSchema,
    image_gen: imageTierSchema,
    image_gen_hd: imageTierSchema,
  })
  .strict();

export type TierConfigTable = z.infer<typeof TIER_CONFIG_SCHEMA>;

const TIER_CONFIG_TABLE: TierConfigTable = {
  // Quick edit (change text/colour/fix) — 1 credit, economy model, 2 min (§5.2).
  quick: {
    kind: 'base',
    credits: 1,
    modelClass: 'economy',
    tokenBudgetIn: 20_000,
    tokenBudgetOut: 2_000,
    toolCallCap: 6,
    revisions: 1,
    wallClockMs: 120_000, // 2 min
    roundtripsPerPhase: 8, // §5.1 default
  },
  // Standard generation — 2 credits, default model, 5 min (§5.2).
  standard: {
    kind: 'base',
    credits: 2,
    modelClass: 'default',
    tokenBudgetIn: 80_000,
    tokenBudgetOut: 5_000,
    toolCallCap: 12,
    revisions: 2,
    wallClockMs: 300_000, // 5 min
    roundtripsPerPhase: 8, // §5.1 default
  },
  // Complex generation — 5 credits, default+ with more planning, 10 min (§5.2).
  complex: {
    kind: 'base',
    credits: 5,
    modelClass: 'default_plus',
    tokenBudgetIn: 200_000,
    tokenBudgetOut: 12_000,
    toolCallCap: 24,
    revisions: 2,
    wallClockMs: 600_000, // 10 min
    roundtripsPerPhase: 8, // §5.1 default
  },
  // Premium — ×2 credits, Sonnet-class, +50% tokens/tool calls, 2 revisions, 10 min (§5.2).
  // Base = standard: §14.4 fixes premium at 4 credits ($0.40).
  premium: {
    kind: 'multiplied',
    baseTier: 'standard',
    creditMultiplier: 2,
    tokenBudgetMultiplier: 1.5,
    toolCallMultiplier: 1.5,
    modelClass: 'sonnet',
    revisions: 2,
    wallClockMs: 600_000, // 10 min
  },
  // Max — ×4 credits, Opus-class, +100% tokens/tool calls, 3 revisions, 15 min (§5.2).
  // Base = standard: §14.4 fixes max at 8 credits ($0.80).
  max: {
    kind: 'multiplied',
    baseTier: 'standard',
    creditMultiplier: 4,
    tokenBudgetMultiplier: 2,
    toolCallMultiplier: 2,
    modelClass: 'opus',
    revisions: 3,
    wallClockMs: 900_000, // 15 min
  },
  // Image generation (each 1024²) — 1 credit, Flux-class, 1 min (§5.2).
  image_gen: {
    kind: 'image',
    credits: 1,
    modelClass: 'flux',
    toolCallCap: 1,
    revisions: 0,
    wallClockMs: 60_000, // 1 min
  },
  // Image generation HD — 2 credits, Gemini Image / GPT Image class, 2 min (§5.2).
  image_gen_hd: {
    kind: 'image',
    credits: 2,
    modelClass: 'gemini_gpt_image',
    toolCallCap: 1,
    revisions: 0,
    wallClockMs: 120_000, // 2 min
  },
};

/** The §5.2 tier table, validated by Zod at import time (fail fast on drift). */
export const TIER_CONFIG: TierConfigTable = TIER_CONFIG_SCHEMA.parse(TIER_CONFIG_TABLE);

/** Concrete, absolute budgets for a tier (multiplied tiers resolved over their base). */
export interface ResolvedTierBudget {
  readonly tier: RunTierId;
  readonly credits: number;
  readonly modelClass: ModelClass;
  /** `null` for image tiers — token budgets are n/a (§5.2). */
  readonly tokenBudgetIn: number | null;
  readonly tokenBudgetOut: number | null;
  readonly toolCallCap: number;
  readonly revisions: number;
  readonly wallClockMs: number;
  readonly roundtripsPerPhase: number | null;
}

/** The base tier a multiplied tier expands over. */
export type MultipliableBaseTier = 'standard' | 'complex';

/** Resolves a multiplied tier over an explicit base (used by billing for §14.1 multipliers). */
export function resolveMultipliedTier(
  variant: 'premium' | 'max',
  base: MultipliableBaseTier,
): ResolvedTierBudget {
  const row = TIER_CONFIG[variant];
  if (row.kind !== 'multiplied') {
    throw new Error(`[config] tier '${variant}' is not a multiplied tier`);
  }
  const baseRow = TIER_CONFIG[base];
  if (baseRow.kind !== 'base') {
    throw new Error(`[config] tier '${base}' is not a base tier`);
  }
  return {
    tier: variant,
    credits: baseRow.credits * row.creditMultiplier,
    modelClass: row.modelClass,
    tokenBudgetIn: Math.round(baseRow.tokenBudgetIn * row.tokenBudgetMultiplier),
    tokenBudgetOut: Math.round(baseRow.tokenBudgetOut * row.tokenBudgetMultiplier),
    toolCallCap: Math.round(baseRow.toolCallCap * row.toolCallMultiplier),
    revisions: row.revisions,
    wallClockMs: row.wallClockMs,
    roundtripsPerPhase: Math.round(baseRow.roundtripsPerPhase * row.toolCallMultiplier),
  };
}

/** Resolves any tier id into absolute budgets (§5.2). Unknown ids cannot occur (typed). */
export function resolveTierConfig(tier: RunTierId): ResolvedTierBudget {
  const row: TierConfig | undefined = TIER_CONFIG[tier];
  if (row === undefined) {
    // Defence for untyped (JS) callers — the type system prevents this in TS.
    throw new Error(`[config] unknown run tier: ${tier}`);
  }
  switch (row.kind) {
    case 'base':
      return {
        tier,
        credits: row.credits,
        modelClass: row.modelClass,
        tokenBudgetIn: row.tokenBudgetIn,
        tokenBudgetOut: row.tokenBudgetOut,
        toolCallCap: row.toolCallCap,
        revisions: row.revisions,
        wallClockMs: row.wallClockMs,
        roundtripsPerPhase: row.roundtripsPerPhase,
      };
    case 'multiplied':
      return resolveMultipliedTier(tier === 'max' ? 'max' : 'premium', row.baseTier);
    case 'image':
      return {
        tier,
        credits: row.credits,
        modelClass: row.modelClass,
        tokenBudgetIn: null,
        tokenBudgetOut: null,
        toolCallCap: row.toolCallCap,
        revisions: row.revisions,
        wallClockMs: row.wallClockMs,
        roundtripsPerPhase: null,
      };
  }
}

/** All seven tiers pre-resolved — the worker enforces these as hard caps (§5.2). */
export const RESOLVED_TIERS: Readonly<Record<RunTierId, ResolvedTierBudget>> =
  Object.fromEntries(
    RUN_TIER_IDS.map((tier) => [tier, resolveTierConfig(tier)]),
  ) as Record<RunTierId, ResolvedTierBudget>;

export const RESOLVED_TIER_SCHEMA = z
  .object({
    tier: RUN_TIER_ID_SCHEMA,
    credits: positiveInt,
    modelClass: MODEL_CLASS_SCHEMA,
    tokenBudgetIn: nonNegativeInt.nullable(),
    tokenBudgetOut: nonNegativeInt.nullable(),
    toolCallCap: positiveInt,
    revisions: nonNegativeInt,
    wallClockMs: positiveInt,
    roundtripsPerPhase: positiveInt.nullable(),
  })
  .strict();

export type ResolvedTier = z.infer<typeof RESOLVED_TIER_SCHEMA>;
