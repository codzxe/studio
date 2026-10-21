// @studio/agent — the §5.5 planner output contract. Owner: W1-P (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  the plan is validated against this schema BEFORE any engine command runs.
//          Invalid plan → one retry with the validation errors attached → fail clear.
//   §5.5  output contract (JSON, schema-validated) — the exact key set below.
//   §5.7  every model-proposed tool name and argument is untrusted input:
//          validate format here, cap string/array sizes; the executor additionally
//          rejects tool names that are not in the §6 registry (Wave 6).
//   §6.2  fit enum + focal point shape (asset slots), text slot value cap.
//   §14.4 / limits.ts MAX_MUTATING_COMMANDS_PER_RUN = the steps cap (§5.7 policy).
//
// The schema is STRICT: unknown properties are rejected so a model cannot smuggle
// extra directives into the plan (§5.7 injection stance).
import { MAX_MUTATING_COMMANDS_PER_RUN, RUN_TIER_IDS } from "@studio/config";
import { z } from "zod";

// --- Enums and formats -----------------------------------------------------------

/** §5.5 `intent` — exactly these five. */
export const PLAN_INTENTS = ["create_post", "edit_layers", "resize", "variant", "export"] as const;
export type PlanIntent = (typeof PLAN_INTENTS)[number];

export const PLAN_INTENT_SCHEMA = z.enum(PLAN_INTENTS);

/**
 * §5.5 `model_tier` — the five interactive run tiers of §5.2 rows 1–5. Image
 * tiers (image_gen/image_gen_hd) are asset jobs, not document plans; the
 * planner cannot request them.
 */
export const PLAN_MODEL_TIER_IDS = ["quick", "standard", "complex", "premium", "max"] as const;
export type PlanModelTier = (typeof PLAN_MODEL_TIER_IDS)[number];

export const PLAN_MODEL_TIER_SCHEMA = z.enum(PLAN_MODEL_TIER_IDS);

/** `template` is `id@version` (e.g. `instagram-post@3`) or `null` (§5.5). */
export const TEMPLATE_REF_RE = /^[a-z0-9][a-z0-9_-]*@[0-9]+(?:\.[0-9]+)*$/;

/** §5.5 palette values are hex strings (`#F4E7D3`); §6.1 permits `#RGB`/`#RRGGBB`. */
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Tool names inside `steps`: the §5.5 example uses dotted engine-style ids
 * (`template.apply`), the §6 registry uses snake_case (`template_fill`). Both are
 * accepted here; anything else (uppercase, shell metacharacters, …) is rejected —
 * §5.7 treats model-proposed tool names as untrusted input.
 */
export const PLAN_TOOL_NAME_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;

/** §6.2 asset fit modes. */
export const ASSET_FITS = ["cover", "contain", "fill"] as const;
export type AssetFit = (typeof ASSET_FITS)[number];

// --- Sizes (policy constants; §5.7 "cap string lengths and array sizes") ---------

/** §6.2: a template manifest exposes at most 40 slots (`too many slots`). */
export const MAX_PLAN_SLOTS = 40;
/** One asset per slot is the §5.5 shape; keep the same ceiling. */
export const MAX_PLAN_ASSETS = 40;
/** Brand palettes are small; 16 colours is generous. */
export const MAX_PLAN_PALETTE = 16;
/** Typography overrides target named roles (headline/body/…); 16 is generous. */
export const MAX_PLAN_TYPOGRAPHY_KEYS = 16;
/** §11.1 defines 16 validator checks; the plan may cite them plus custom ones. */
export const MAX_PLAN_CHECKS = 32;
/** §6.2 text slot values cap at 2000 chars; reuse for notes and slot text. */
export const MAX_PLAN_STRING = 2000;
/**
 * §5.7: cap total mutating commands per run. Mirrors @studio/config
 * MAX_MUTATING_COMMANDS_PER_RUN (256) — the plan may not promise more work than
 * the run policy allows.
 */
export const MAX_PLAN_STEPS = MAX_MUTATING_COMMANDS_PER_RUN;

// --- Sub-schemas ------------------------------------------------------------------

/** §6.2 focal point: normalized 0..1 on both axes. */
export const focalPointSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export type FocalPoint = z.infer<typeof focalPointSchema>;

export const planAssetSchema = z.strictObject({
  ref: z.string().min(1).max(200),
  slot: z.string().min(1).max(200),
  fit: z.enum(ASSET_FITS).default("cover"), // §6.2 default
  focal: focalPointSchema.optional(),
});

export type PlanAsset = z.infer<typeof planAssetSchema>;

/**
 * §5.5 `steps[].args` is passthrough jsonb: the executor validates args against
 * the §6 tool schema of the named tool (Wave 6). Unknown keys are allowed here
 * by design; the tool boundary is where they die.
 */
export const planStepSchema = z.strictObject({
  tool: z.string().regex(PLAN_TOOL_NAME_RE, "tool must be a snake_case or dotted tool name"),
  args: z.record(z.string(), z.unknown()).default({}),
});

export type PlanStep = z.infer<typeof planStepSchema>;

/** §5.5 `typography` values: named overrides with string/number/boolean values. */
export const typographyValueSchema = z.record(
  z.string().min(1).max(64),
  z.union([z.string().max(500), z.number(), z.boolean()]),
);

export type PlanTypographyValue = z.infer<typeof typographyValueSchema>;

// --- The plan (§5.5 exact key set, strict) ----------------------------------------

const slotRecordSchema = z
  .record(z.string().min(1).max(200), z.string().max(MAX_PLAN_STRING))
  .refine((slots) => Object.keys(slots).length <= MAX_PLAN_SLOTS, {
    message: `too many slots (max ${MAX_PLAN_SLOTS})`,
  });

const typographyRecordSchema = z
  .record(z.string().min(1).max(200), typographyValueSchema)
  .refine((typography) => Object.keys(typography).length <= MAX_PLAN_TYPOGRAPHY_KEYS, {
    message: `too many typography roles (max ${MAX_PLAN_TYPOGRAPHY_KEYS})`,
  });

export const planSchema = z
  .strictObject({
    intent: PLAN_INTENT_SCHEMA,
    // §5.5: `"template": "instagram-post@3"` — or null when the plan builds from scratch.
    template: z.string().regex(TEMPLATE_REF_RE).nullable(),
    assets: z.array(planAssetSchema).max(MAX_PLAN_ASSETS).default([]),
    slots: slotRecordSchema.default({}),
    palette: z.array(z.string().regex(HEX_COLOR_RE)).max(MAX_PLAN_PALETTE).default([]),
    typography: typographyRecordSchema.default({}),
    steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS),
    checks: z.array(z.string().min(1).max(100)).max(MAX_PLAN_CHECKS).default([]),
    model_tier: PLAN_MODEL_TIER_SCHEMA,
    notes_for_user: z.string().max(MAX_PLAN_STRING),
  })
  .strict();

/** A §5.5 plan that passed the schema — the only shape the executor will act on. */
export type Plan = z.infer<typeof planSchema>;

/**
 * `validatePlan` result: success carries the plan; failure carries one readable
 * issue per schema violation (attached verbatim to the §5.1 one-retry prompt).
 */
export type PlanValidationResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly issues: string[] };

/** Truncates untrusted key paths so issues never echo a wall of model output. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function formatPlanIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `plan.${truncate(path, 120)}: ${issue.message}`;
  });
}

/**
 * Validates raw planner output (untrusted, §5.7) against the §5.5 contract.
 *
 * One-retry rule (§5.1): on failure the planner gets EXACTLY one retry with
 * `issues` attached to the prompt; a second failure ends the run with
 * `plan_invalid`. The retry itself is enforced by the planner driver (Wave 6);
 * `@studio/config` PLAN_RETRY_LIMIT is the shared constant.
 */
export function validatePlan(json: unknown): PlanValidationResult {
  const parsed = planSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: formatPlanIssues(parsed.error) };
  }
  return { ok: true, plan: parsed.data };
}

// Fail fast at import if the planner tier enum drifts from @studio/config §5.2 tiers.
for (const tier of PLAN_MODEL_TIER_IDS) {
  if (!(RUN_TIER_IDS as readonly string[]).includes(tier)) {
    throw new Error(`[agent/plan] model_tier '${tier}' is not a @studio/config run tier`);
  }
}
