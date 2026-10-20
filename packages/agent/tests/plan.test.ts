// W1-P — §5.5 planner output contract: schema validation + one-retry issue strings.
import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_STEPS,
  validatePlan,
  type Plan,
  type PlanValidationResult,
} from '../src/plan.js';

// The §5.5 example, verbatim from the spec.
const specPlan = {
  intent: 'create_post',
  template: 'instagram-post@3',
  assets: [{ ref: 'asset_123', slot: 'photo', fit: 'cover' }],
  slots: { headline: 'Fresh roasted, every morning', subhead: 'Open 7–5 · Main St' },
  palette: ['#F4E7D3', '#3B2A20', '#D96C3B'],
  typography: { headline: { font: 'display', weight: 'bold' }, body: { font: 'sans' } },
  steps: [
    { tool: 'template.apply', args: {} },
    { tool: 'template.fill', args: {} },
  ],
  checks: ['in_bounds', 'contrast>=4.5', 'headline_largest', 'safe_area'],
  model_tier: 'standard',
  notes_for_user: 'Reused the brand palette; headline shortened to fit two lines.',
};

/**
 * Deep, prototype-free clone so table cases cannot leak into each other.
 * JSON round-trip (not structuredClone) — the package has no @types/node yet.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('plan: §5.5 happy path', () => {
  it('accepts the spec example exactly', () => {
    const result = validatePlan(specPlan);
    expect(result).toEqual({ ok: true, plan: clone(specPlan) });
  });

  it('returns a Plan whose types flow into the executor (compile-time)', () => {
    const result: PlanValidationResult = validatePlan(specPlan);
    if (!result.ok) throw new Error('expected a valid plan');
    const plan: Plan = result.plan;
    expect(plan.intent).toBe('create_post');
    expect(plan.template).toBe('instagram-post@3');
    expect(plan.model_tier).toBe('standard');
  });

  it('accepts a minimal resize plan and fills collection defaults', () => {
    const result = validatePlan({
      intent: 'resize',
      template: null,
      steps: [{ tool: 'canvas.resize', args: { width: 1080, height: 1080 } }],
      model_tier: 'quick',
      notes_for_user: '',
    });
    if (!result.ok) throw new Error(result.issues.join('\n'));
    expect(result.plan.assets).toEqual([]);
    expect(result.plan.slots).toEqual({});
    expect(result.plan.palette).toEqual([]);
    expect(result.plan.typography).toEqual({});
    expect(result.plan.checks).toEqual([]);
    expect(result.plan.template).toBeNull();
  });

  it('accepts a focal point and passthrough jsonb args (§24.4 example shape)', () => {
    const result = validatePlan({
      ...clone(specPlan),
      assets: [{ ref: 'asset_id', slot: 'photo', fit: 'cover', focal: { x: 0.5, y: 0.4 } }],
      steps: [
        { tool: 'asset_place', args: { deep: { list: [1, 'two', true], nested: { ok: true } } } },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts #RGB shorthand palette colours (§6.1) and default fit cover', () => {
    const result = validatePlan({
      ...clone(specPlan),
      palette: ['#FFF', '#F4E7D3'],
      assets: [{ ref: 'a', slot: 'photo' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.assets[0]?.fit).toBe('cover'); // §6.2 default
      expect(result.plan.assets[0]?.focal).toBeUndefined();
    }
  });
});

describe('plan: §5.7 untrusted output is rejected (table-driven)', () => {
  const cases = [
    {
      name: 'unknown intent',
      patch: (p: typeof specPlan) => ({ ...p, intent: 'delete_everything' }),
      issue: /intent/,
    },
    {
      name: 'extra property (strict, no extra props)',
      patch: (p: typeof specPlan) => ({ ...p, surprise: true }),
      issue: /Unrecognized key/,
    },
    {
      name: 'bad hex: colour word',
      patch: (p: typeof specPlan) => ({ ...p, palette: [...p.palette, 'blue'] }),
      issue: /palette\.3/,
    },
    {
      name: 'bad hex: malformed literal',
      patch: (p: typeof specPlan) => ({ ...p, palette: ['#12345'] }),
      issue: /palette\.0/,
    },
    {
      name: 'unknown fit',
      patch: (p: typeof specPlan) => ({
        ...p,
        assets: [{ ref: 'asset_123', slot: 'photo', fit: 'stretch' }],
      }),
      issue: /assets\.0\.fit/,
    },
    {
      name: 'oversized steps array (§5.7 mutating-command cap)',
      patch: (p: typeof specPlan) => ({
        ...p,
        steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, () => ({ tool: 'text_set', args: {} })),
      }),
      issue: new RegExp(`${MAX_PLAN_STEPS}`),
    },
    {
      name: 'template ref without @version',
      patch: (p: typeof specPlan) => ({ ...p, template: 'instagram-post' }),
      issue: /template/,
    },
    {
      name: 'template ref with wrong casing',
      patch: (p: typeof specPlan) => ({ ...p, template: 'Instagram-Post@3' }),
      issue: /template/,
    },
    {
      name: 'missing required notes_for_user',
      patch: (p: typeof specPlan) => {
        const { notes_for_user: _omitted, ...rest } = p;
        return rest;
      },
      issue: /notes_for_user/,
    },
    {
      name: 'notes_for_user over the 2000-char cap',
      patch: (p: typeof specPlan) => ({ ...p, notes_for_user: 'x'.repeat(2001) }),
      issue: /notes_for_user/,
    },
    {
      name: 'model-proposed tool name with shell metacharacters (§5.7)',
      patch: (p: typeof specPlan) => ({
        ...p,
        steps: [{ tool: 'rm -rf /', args: {} }],
      }),
      issue: /steps\.0\.tool/,
    },
    {
      name: 'tool name with wrong casing',
      patch: (p: typeof specPlan) => ({ ...p, steps: [{ tool: 'Template.Apply', args: {} }] }),
      issue: /steps\.0\.tool/,
    },
    {
      name: 'focal point out of [0,1] range',
      patch: (p: typeof specPlan) => ({
        ...p,
        assets: [{ ref: 'asset_123', slot: 'photo', focal: { x: 1.5, y: 0.5 } }],
      }),
      issue: /assets\.0\.focal/,
    },
    {
      name: 'more than 40 slots',
      patch: (p: typeof specPlan) => {
        const slots: Record<string, string> = {};
        for (let i = 0; i < 41; i += 1) slots[`s${i}`] = 'text';
        return { ...p, slots };
      },
      issue: /too many slots/,
    },
    {
      name: 'steps cannot be empty',
      patch: (p: typeof specPlan) => ({ ...p, steps: [] }),
      issue: /steps/,
    },
  ] as const;

  it.each(cases)('rejects: $name', ({ patch, issue }) => {
    const result = validatePlan(patch(clone(specPlan)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((text) => issue.test(text)), JSON.stringify(result.issues)).toBe(true);
  });
});

describe('plan: validatePlan is the §5.1 one-retry seam', () => {
  it('never throws — any garbage becomes issues', () => {
    const inputs: unknown[] = [null, undefined, 42, 'not json', [], [{ tool: 'x' }]];
    for (const input of inputs) {
      const result = validatePlan(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.issues.length).toBeGreaterThan(0);
      for (const text of result.issues) expect(typeof text).toBe('string');
    }
  });

  it('formats issues as plan.<path>: <message> for the retry prompt', () => {
    const result = validatePlan({ intent: 'nope' });
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.length).toBeGreaterThan(0);
    for (const text of result.issues) expect(text).toMatch(/^plan\./);
  });
});
