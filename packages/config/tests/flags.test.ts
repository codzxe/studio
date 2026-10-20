import { describe, expect, it } from 'vitest';
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_KEY_SCHEMA,
  FEATURE_FLAG_OVERRIDES_SCHEMA,
  FEATURE_FLAG_ROW_SCHEMA,
  defaultFlagStates,
  isFlagEnabled,
  type FeatureFlagKey,
} from '../src/index.js';

describe('flags: DB-backed feature flags (§4)', () => {
  it('registry keys and the constant list are the same set', () => {
    expect([...FEATURE_FLAG_KEYS].sort()).toEqual(
      Object.keys(FEATURE_FLAGS).sort() as string[],
    );
  });

  it('every flag defaults to off (§4: default risky things to off)', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      const definition = FEATURE_FLAGS[key];
      expect(definition.defaultEnabled, `${key} must default to off`).toBe(false);
      expect(definition.description.length).toBeGreaterThan(10);
    }
  });

  it('defaultFlagStates() returns all-off', () => {
    const states = defaultFlagStates();
    expect(Object.keys(states).sort()).toEqual([...FEATURE_FLAG_KEYS].sort() as string[]);
    for (const key of FEATURE_FLAG_KEYS) {
      expect(states[key]).toBe(false);
    }
  });

  it('isFlagEnabled defaults to false and honours explicit true overrides only', () => {
    const key: FeatureFlagKey = 'psd_export';
    expect(isFlagEnabled({}, key)).toBe(false);
    expect(isFlagEnabled({ psd_export: false }, key)).toBe(false);
    expect(isFlagEnabled({ psd_export: true }, key)).toBe(true);
  });

  it('the key schema rejects unknown flags', () => {
    expect(FEATURE_FLAG_KEY_SCHEMA.safeParse('freeform_composition').success).toBe(true);
    expect(FEATURE_FLAG_KEY_SCHEMA.safeParse('delete_everything').success).toBe(false);
  });

  it('override maps reject unknown keys', () => {
    expect(FEATURE_FLAG_OVERRIDES_SCHEMA.safeParse({ psd_export: true }).success).toBe(true);
    expect(FEATURE_FLAG_OVERRIDES_SCHEMA.safeParse({ nuke: true }).success).toBe(false);
  });

  it('the DB row schema validates per-workspace flag overrides', () => {
    const parsed = FEATURE_FLAG_ROW_SCHEMA.safeParse({
      workspaceId: 'ws_123',
      key: 'multi_turn_chat_edits',
      enabled: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.updatedAt).toBeInstanceOf(Date);
    }
    expect(
      FEATURE_FLAG_ROW_SCHEMA.safeParse({ workspaceId: 'ws_123', key: 'nope', enabled: true })
        .success,
    ).toBe(false);
  });
});
