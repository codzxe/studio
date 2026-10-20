import { describe, expect, it } from 'vitest';
import {
  RESOLVED_TIERS,
  RESOLVED_TIER_SCHEMA,
  RUN_TIER_ID_SCHEMA,
  resolveMultipliedTier,
  resolveTierConfig,
  TIER_CONFIG,
  type RunTierId,
} from '../src/index.js';

// §5.2 exact table.
describe('tiers: §5.2 base rows resolve exactly', () => {
  it('quick — 1 credit, economy, 20k/2k tokens, 6 calls, 1 revision, 2 min', () => {
    expect(resolveTierConfig('quick')).toMatchObject({
      tier: 'quick',
      credits: 1,
      modelClass: 'economy',
      tokenBudgetIn: 20_000,
      tokenBudgetOut: 2_000,
      toolCallCap: 6,
      revisions: 1,
      wallClockMs: 120_000,
      roundtripsPerPhase: 8,
    });
  });

  it('standard — 2 credits, default, 80k/5k, 12 calls, 2 revisions, 5 min', () => {
    expect(resolveTierConfig('standard')).toMatchObject({
      tier: 'standard',
      credits: 2,
      modelClass: 'default',
      tokenBudgetIn: 80_000,
      tokenBudgetOut: 5_000,
      toolCallCap: 12,
      revisions: 2,
      wallClockMs: 300_000,
    });
  });

  it('complex — 5 credits, default+, 200k/12k, 24 calls, 2 revisions, 10 min', () => {
    expect(resolveTierConfig('complex')).toMatchObject({
      tier: 'complex',
      credits: 5,
      modelClass: 'default_plus',
      tokenBudgetIn: 200_000,
      tokenBudgetOut: 12_000,
      toolCallCap: 24,
      revisions: 2,
      wallClockMs: 600_000,
    });
  });

  it('premium — ×2 credits (4 per §14.4), sonnet class, +50% budgets, 2 revs, 10 min', () => {
    expect(resolveTierConfig('premium')).toMatchObject({
      tier: 'premium',
      credits: 4, // §14.4: premium = 4 credits = $0.40
      modelClass: 'sonnet',
      tokenBudgetIn: 120_000, // 80k + 50%
      tokenBudgetOut: 7_500, // 5k + 50%
      toolCallCap: 18, // 12 + 50%
      revisions: 2,
      wallClockMs: 600_000,
    });
  });

  it('max — ×4 credits (8 per §14.4), opus class, +100% budgets, 3 revs, 15 min', () => {
    expect(resolveTierConfig('max')).toMatchObject({
      tier: 'max',
      credits: 8, // §14.4: max = 8 credits = $0.80
      modelClass: 'opus',
      tokenBudgetIn: 160_000, // 80k + 100%
      tokenBudgetOut: 10_000, // 5k + 100%
      toolCallCap: 24, // 12 + 100%
      revisions: 3,
      wallClockMs: 900_000,
    });
  });

  it('image_gen — 1 credit, flux class, no token budget, 1 call, 0 revs, 1 min', () => {
    const tier = resolveTierConfig('image_gen');
    expect(tier).toMatchObject({
      tier: 'image_gen',
      credits: 1,
      modelClass: 'flux',
      tokenBudgetIn: null,
      tokenBudgetOut: null,
      toolCallCap: 1,
      revisions: 0,
      wallClockMs: 60_000,
    });
  });

  it('image_gen_hd — 2 credits, gemini/gpt image class, 1 call, 0 revs, 2 min', () => {
    expect(resolveTierConfig('image_gen_hd')).toMatchObject({
      tier: 'image_gen_hd',
      credits: 2,
      modelClass: 'gemini_gpt_image',
      tokenBudgetIn: null,
      toolCallCap: 1,
      revisions: 0,
      wallClockMs: 120_000,
    });
  });
});

describe('tiers: multiplier mechanics', () => {
  it('premium over a complex base multiplies the complex row (§14.1)', () => {
    expect(resolveMultipliedTier('premium', 'complex')).toMatchObject({
      credits: 10, // 5 × 2
      tokenBudgetIn: 300_000, // 200k × 1.5
      tokenBudgetOut: 18_000, // 12k × 1.5
      toolCallCap: 36, // 24 × 1.5
      revisions: 2,
      wallClockMs: 600_000,
    });
  });

  it('max over a complex base multiplies the complex row', () => {
    expect(resolveMultipliedTier('max', 'complex')).toMatchObject({
      credits: 20, // 5 × 4
      tokenBudgetIn: 400_000, // 200k × 2
      toolCallCap: 48, // 24 × 2
      revisions: 3,
      wallClockMs: 900_000,
    });
  });

  it('TIER_CONFIG carries the raw multipliers (×2 premium, ×4 max)', () => {
    expect(TIER_CONFIG.premium).toMatchObject({
      kind: 'multiplied',
      creditMultiplier: 2,
      tokenBudgetMultiplier: 1.5,
      toolCallMultiplier: 1.5,
      modelClass: 'sonnet',
    });
    expect(TIER_CONFIG.max).toMatchObject({
      kind: 'multiplied',
      creditMultiplier: 4,
      tokenBudgetMultiplier: 2,
      toolCallMultiplier: 2,
      modelClass: 'opus',
    });
  });
});

describe('tiers: table integrity', () => {
  const allTiers: RunTierId[] = [
    'quick',
    'standard',
    'complex',
    'premium',
    'max',
    'image_gen',
    'image_gen_hd',
  ];

  it('every tier is pre-resolved and schema-valid', () => {
    for (const tier of allTiers) {
      const resolved = RESOLVED_TIERS[tier];
      expect(resolved, `missing resolution for ${tier}`).toBeDefined();
      expect(RESOLVED_TIER_SCHEMA.safeParse(resolved).success, `schema-invalid: ${tier}`).toBe(
        true,
      );
      expect(resolved.credits).toBeGreaterThan(0);
      expect(resolved.wallClockMs).toBeGreaterThan(0);
      expect(resolved.toolCallCap).toBeGreaterThan(0);
    }
  });

  it('credits are exactly {1,2,5,4,8,1,2} across the canonical ids', () => {
    const expected: Record<RunTierId, number> = {
      quick: 1,
      standard: 2,
      complex: 5,
      premium: 4,
      max: 8,
      image_gen: 1,
      image_gen_hd: 2,
    };
    for (const tier of allTiers) {
      expect(RESOLVED_TIERS[tier].credits).toBe(expected[tier]);
    }
  });

  it('wall clocks grow monotonically with tier weight', () => {
    expect(RESOLVED_TIERS.quick.wallClockMs).toBeLessThan(RESOLVED_TIERS.standard.wallClockMs);
    expect(RESOLVED_TIERS.standard.wallClockMs).toBeLessThan(RESOLVED_TIERS.complex.wallClockMs);
    expect(RESOLVED_TIERS.complex.wallClockMs).toBe(RESOLVED_TIERS.premium.wallClockMs);
    expect(RESOLVED_TIERS.premium.wallClockMs).toBeLessThan(RESOLVED_TIERS.max.wallClockMs);
  });

  it('rejects unknown tier ids', () => {
    expect(RUN_TIER_ID_SCHEMA.safeParse('mega').success).toBe(false);
    const unknownTier: RunTierId = 'mega' as string as RunTierId;
    expect(() => resolveTierConfig(unknownTier)).toThrow(/unknown run tier/);
  });
});
