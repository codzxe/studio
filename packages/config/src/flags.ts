// @studio/config — DB-backed feature-flag types (spec §4: "Feature flags:
// DB-backed, per-workspace; default everything risky to `off`").
// This module owns the flag vocabulary and row schema; persistence lives in @studio/db.
import { z } from 'zod';

/** All flag ids. Adding a flag requires an explicit decision + description here. */
export const FEATURE_FLAG_KEYS = [
  'multi_turn_chat_edits',
  'variants_bulk_export',
  'freeform_composition',
  'psd_export',
  'realtime_centrifugo',
] as const satisfies readonly string[];

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/** One flag definition. `defaultEnabled` is always `false` (§4 — default risky things off). */
export interface FeatureFlagDefinition {
  readonly description: string;
  readonly defaultEnabled: false;
}

export const FEATURE_FLAGS = {
  multi_turn_chat_edits: {
    description: 'Multi-turn chat edits on an open document ("make the headline shorter")',
    defaultEnabled: false, // §4
  },
  variants_bulk_export: {
    description: 'Variants via data sets + layer comps (sizes, languages) and bulk export',
    defaultEnabled: false, // §4
  },
  freeform_composition: {
    description: 'Freeform composition on layout primitives (planner picks template-vs-freeform)',
    defaultEnabled: false, // §4
  },
  psd_export: {
    description: 'PSD export (ships with warning label + fidelity report, §2.3)',
    defaultEnabled: false, // §4
  },
  realtime_centrifugo: {
    description: 'Centrifugo realtime fan-out alongside SSE (§3.1, optional at start)',
    defaultEnabled: false, // §4
  },
} as const satisfies Record<FeatureFlagKey, FeatureFlagDefinition>;

export const FEATURE_FLAG_KEY_SCHEMA = z.enum(FEATURE_FLAG_KEYS);

/** Overrides as stored per workspace: a sparse map of flag → enabled. */
export const FEATURE_FLAG_OVERRIDES_SCHEMA = z.record(FEATURE_FLAG_KEY_SCHEMA, z.boolean());

export type FeatureFlagOverrides = Partial<Record<FeatureFlagKey, boolean>>;

/** DB row shape for a per-workspace flag override. */
export const FEATURE_FLAG_ROW_SCHEMA = z
  .object({
    workspaceId: z.string().min(1),
    key: FEATURE_FLAG_KEY_SCHEMA,
    enabled: z.boolean(),
    updatedAt: z.coerce.date(),
  })
  .strict();

export type FeatureFlagRow = z.infer<typeof FEATURE_FLAG_ROW_SCHEMA>;

/** Every flag defaults to off (§4); an override flips it only when explicitly `true`. */
export function isFlagEnabled(overrides: FeatureFlagOverrides, key: FeatureFlagKey): boolean {
  return overrides[key] === true;
}

/** The default (all-off) state, e.g. for fresh workspaces. */
export function defaultFlagStates(): Record<FeatureFlagKey, false> {
  const states = {} as Record<FeatureFlagKey, false>;
  for (const key of FEATURE_FLAG_KEYS) {
    states[key] = false;
  }
  return states;
}
