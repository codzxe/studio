// @studio/agent — the §23.2 planner prompt. Owner: W6-A (docs/AGENTS.md).
//
// Spec anchors:
//   §23.2  the prompt below is VERBATIM from the spec. The five `Inputs:` lines
//          are labeled sections whose brace placeholders interpolate the
//          worker-assembled context as compact JSON blocks (plain `${}` string
//          interpolation of JSON.stringify'd values — no template engine, no
//          promptfoo `{{}}` layer; the evals/prompts/planner.system.txt variant
//          is the tone reference for the same text). Every other character is
//          spec text: do not reword, reflow or reorder.
//   §5.4   context assembly decides WHAT rides in each section (brief, snapshot,
//          catalog, budget, rules); this builder only labels + stringifies.
//   §6.1   the planner sees tool NAMES + DESCRIPTIONS only —
//          @studio/tools `DEFAULT_TOOL_MANIFEST` is the `catalog.tools` input
//          (satisfies the section structurally; no package dependency here).
//          Argument schemas never enter prompts.
//   §5.1   the one-retry attachment (validatePlan issues + §23.2 rule issues)
//          is APPENDED by buildPlannerRetryPrompt — the §23.2 text itself is
//          never edited for a retry.
//
// Input contract ("Zod at every boundary"): the worker assembles the five
// sections; cross-check-relevant fields are typed below and everything else
// PASSES THROUGH untouched, so §5.4 fidelity (thumbnails, prior conversation,
// brand tokens, layer tree, …) is the worker's call and never lost to a schema.
import { RUN_TIER_IDS } from "@studio/config";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared field helpers
// ---------------------------------------------------------------------------

/** Bounded identifier string (asset/template/component/slot ids are §5.7 input). */
const idField = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// The five labeled sections (§23.2 `Inputs:`)
// ---------------------------------------------------------------------------

/** §23.2 BRIEF — {user prompt, attachments, export target, prior conversation}. */
export const plannerBriefSchema = z
  .object({
    /** The user prompt (§5.4). */
    prompt: z.string().min(1).max(20_000),
    /**
     * Brief attachment asset ids — the §5.5 `assets[].ref` cross-check source
     * (§23.2: "never invent … asset ids not present in CATALOG/SNAPSHOT").
     */
    attachments: z
      .array(z.object({ id: idField }).passthrough())
      .max(64)
      .optional(),
  })
  .passthrough();

export type PlannerBrief = z.infer<typeof plannerBriefSchema>;

/**
 * One catalog/snapshot template (§7.2 manifest distilled to what the planner
 * may cite): id, an optional pinned version, and slot NAMES — the `slots`
 * record keys a template_inspect returns, NOT the workspace snapshot's count.
 */
export const plannerTemplateEntrySchema = z
  .object({
    id: idField,
    version: z.union([z.number().int().min(0), z.string().min(1).max(40)]).optional(),
    slots: z.array(z.string().min(1).max(200)).max(200).optional(),
    tags: z.array(z.string().min(1).max(100)).max(50).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .passthrough();

export type PlannerTemplateEntry = z.infer<typeof plannerTemplateEntrySchema>;

/** One catalog component (§8.2): id + the variable names the §23.2 rule protects. */
export const plannerComponentEntrySchema = z
  .object({
    id: idField,
    variables: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .passthrough();

export type PlannerComponentEntry = z.infer<typeof plannerComponentEntrySchema>;

/** One asset reference (§6 row 6): `id` is what `assets[].ref` must cite. */
export const plannerAssetEntrySchema = z.object({ id: idField }).passthrough();

export type PlannerAssetEntry = z.infer<typeof plannerAssetEntrySchema>;

/**
 * §6.1 planner-facing tool manifest row — name + description only.
 * `@studio/tools` `DEFAULT_TOOL_MANIFEST` satisfies this structurally, so this
 * package keeps a type-only, dependency-free seam.
 */
export const plannerToolEntrySchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000),
  })
  .passthrough();

export type PlannerToolEntry = z.infer<typeof plannerToolEntrySchema>;

/** §23.2 SNAPSHOT — {canvas, layer tree, template slots, palette, fonts}. */
export const plannerSnapshotSchema = z
  .object({
    /** Slot names of the document's applied template, if any (cross-check source). */
    templateSlots: z.array(z.string().min(1).max(200)).max(200).optional(),
    /** Templates visible to this run (cross-check source for the template ref). */
    templates: z.array(plannerTemplateEntrySchema).max(200).optional(),
    /** Asset ids already in the document (cross-check source for assets[].ref). */
    assets: z.array(plannerAssetEntrySchema).max(500).optional(),
  })
  .passthrough();

export type PlannerSnapshot = z.infer<typeof plannerSnapshotSchema>;

/**
 * §23.2 CATALOG — {templates with tags and slots, components with variables},
 * plus the §6.1 tool manifest (`tools` carries `DEFAULT_TOOL_MANIFEST`).
 */
export const plannerCatalogSchema = z
  .object({
    tools: z.array(plannerToolEntrySchema).max(100),
    templates: z.array(plannerTemplateEntrySchema).max(200).optional(),
    components: z.array(plannerComponentEntrySchema).max(200).optional(),
    assets: z.array(plannerAssetEntrySchema).max(500).optional(),
  })
  .passthrough();

export type PlannerCatalog = z.infer<typeof plannerCatalogSchema>;

/** §23.2 BUDGET — {tier, max tokens, max tool calls, max revisions}. */
export const plannerBudgetSchema = z
  .object({
    /** §5.2 run tier; one taxonomy with @studio/config (image tiers never plan). */
    tier: z.enum(RUN_TIER_IDS),
    /** Field names follow @studio/config `resolveTierConfig` / budgets.ts limits. */
    tokenBudgetIn: z.number().int().min(0).nullable().optional(),
    tokenBudgetOut: z.number().int().min(0).nullable().optional(),
    toolCallCap: z.number().int().min(0).optional(),
    revisions: z.number().int().min(0).optional(),
  })
  .passthrough();

export type PlannerBudget = z.infer<typeof plannerBudgetSchema>;

/** §23.2 RULES — {validator checks, brand tokens}. */
export const plannerRulesSchema = z
  .object({
    /** §11.1 validator check ids the plan's `checks` may cite. */
    checks: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .passthrough();

export type PlannerRules = z.infer<typeof plannerRulesSchema>;

/** The five labeled §23.2 sections — `buildPlannerPrompt`'s exact input. */
export interface PlannerSections {
  readonly brief: PlannerBrief;
  readonly snapshot: PlannerSnapshot;
  readonly catalog: PlannerCatalog;
  readonly budget: PlannerBudget;
  readonly rules: PlannerRules;
}

/**
 * Boundary schema for the whole planner input (worker wiring). Passthrough so
 * `signal` and future run-loop fields ride along untouched.
 */
export const plannerInputSchema = z
  .object({
    brief: plannerBriefSchema,
    snapshot: plannerSnapshotSchema,
    catalog: plannerCatalogSchema,
    budget: plannerBudgetSchema,
    rules: plannerRulesSchema,
  })
  .passthrough();

export type PlannerInputData = z.infer<typeof plannerInputSchema>;

// ---------------------------------------------------------------------------
// The §23.2 prompt (VERBATIM — do not reword, reflow or reorder)
// ---------------------------------------------------------------------------

/**
 * JSON-encodes one section block. `JSON.stringify` returns `undefined` only for
 * non-JSON values (undefined/functions); `null` is the honest placeholder then.
 */
function block(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * Builds the §23.2 planner prompt: the spec text VERBATIM with the five labeled
 * input sections carrying the worker-assembled context as compact JSON blocks
 * (compact on purpose — §5.4 token discipline; stable key order keeps the
 * §5.3 prompt-cache prefix stable for equal inputs).
 */
export function buildPlannerPrompt(sections: PlannerSections): string {
  return `You are planning one design-agent run.

Inputs:
- BRIEF: ${block(sections.brief)}
- SNAPSHOT: ${block(sections.snapshot)}
- CATALOG: ${block(sections.catalog)}
- BUDGET: ${block(sections.budget)}
- RULES: ${block(sections.rules)}

Choose the smallest path to a correct, on-brand, editable document:
- If a template matches the intent, choose it and fill slots.
- Else if components + layout primitives can express it, plan that.
- Else plan a freeform composition from primitives (last resort, flag it).

Return JSON only, validated by the provided schema:
{
  "intent": "create_post|edit_layers|resize|variant|export",
  "template": "id@version or null",
  "assets": [{"ref":"asset_id","slot":"photo","fit":"cover","focal":{"x":0.5,"y":0.4}}],
  "slots": {"slot": "value"},
  "palette": ["#hex", ...],
  "typography": {"headline":{"font":"display","weight":"bold"}},
  "steps": [{"tool":"template_apply","args":{}}, {"tool":"template_fill","args":{}}],
  "checks": ["in_bounds","contrast>=4.5","headline_largest","safe_area"],
  "model_tier": "quick|standard|complex",
  "notes_for_user": "one sentence"
}

Rules:
- Prefer template > components+layout > freeform.
- Never invent slot names, component variables, or asset ids not present in CATALOG/SNAPSHOT.
- Keep text within slot maxChars; write shorter, punchier copy when in doubt.
- If the brief is ambiguous in a way that changes the outcome (language, product, logo),
  include {"tool":"ask_user","args":{...}} as the first step.
- Do not include raw pixel coordinates in slots; layout solves geometry.`;
}

// ---------------------------------------------------------------------------
// §5.1 retry attachment
// ---------------------------------------------------------------------------

/** Issue strings attached to the retry prompt, capped against prompt bloat. */
export const MAX_ISSUES_ATTACHED = 20;

/**
 * §5.1: "invalid plan → one retry with the validation errors attached". The
 * retry keeps the full original prompt (sections + rules) and APPENDS the
 * issues — the §23.2 text is never edited for a retry.
 */
export function buildPlannerRetryPrompt(prompt: string, issues: readonly string[]): string {
  const shown = issues.slice(0, MAX_ISSUES_ATTACHED).map((issue) => `- ${issue}`);
  const elided =
    issues.length > MAX_ISSUES_ATTACHED
      ? `\n- …and ${issues.length - MAX_ISSUES_ATTACHED} more issue(s)`
      : "";
  return `${prompt}

Your previous plan was rejected by validation. The issues were:
${shown.join("\n")}${elided}

Return the corrected plan now: the full JSON object only, no fences, no prose.`;
}
