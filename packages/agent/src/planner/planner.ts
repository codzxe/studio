// @studio/agent — the §5.1/§23.2 PlannerService. Owner: W6-A (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  plan first: validate against the §5.5 schema BEFORE any engine
//         command runs; invalid → ONE retry with the validation errors
//         attached → fail with a clear message. Attempt count is
//         1 + @studio/config PLAN_RETRY_LIMIT.
//   §5.3  the model seam is INJECTED (`PlanModelLike`). The worker wires the
//         AI SDK provider abstraction + router: planner row defaults
//         Gemini 3.8 Flash (economy 2.5 Flash-Lite / DeepSeek 4.1 Flash,
//         premium Sonnet 5.5, max Opus 5.5 — see ../models.ts ROLE_ROUTES);
//         circuit breakers/failover live in the router, never here.
//   §23.2 rules enforced POST-validation (in code, deterministic — the prompt
//         alone is advisory): smallest-path classification (template >
//         components+layout > freeform), freeform requires notes_for_user,
//         never invent slot names / asset ids / template refs not present in
//         CATALOG/SNAPSHOT. A violation produces an issue string and rides
//         the same §5.1 one-retry path.
//   §5.7  every model-proposed value is untrusted: schema-validated
//         (validatePlan) + cross-checked; raw output excerpts are truncated
//         and control-char-sanitized before they can enter any envelope.
//   §22    usage numbers are tracked and surfaced; prompt/content is never
//         logged — failures carry counts and bounded issue strings only.
//   §15.3  user content is data: provider error messages are never echoed.
import { PLAN_RETRY_LIMIT } from "@studio/config";
import type { AgentErrorCode } from "../errors.js";
import { type Plan, validatePlan } from "../plan.js";
import {
  type PlannerSections,
  buildPlannerPrompt,
  buildPlannerRetryPrompt,
  plannerInputSchema,
} from "./prompt.js";

// ---------------------------------------------------------------------------
// The model seam (§5.3 — worker wires the AI SDK + router)
// ---------------------------------------------------------------------------

/**
 * Structural stand-in for the DOM/Node AbortSignal (engine-client precedent):
 * the real type satisfies it, keeping this package free of a `@types/node` peer.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/** Usage numbers one planner completion reports (NaN/negatives are dropped). */
export interface PlanModelUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cacheHits?: number;
}

/** One planner-model completion: raw text + optional provider usage telemetry. */
export interface PlanModelCompletion {
  readonly text: string;
  readonly usage?: PlanModelUsage;
}

/**
 * The injected planner model. The worker builds this over the §5.3 route for
 * the run's tier class (planner row: Gemini 3.8 Flash by default).
 */
export interface PlanModelLike {
  complete(prompt: string, signal?: AbortSignalLike): Promise<PlanModelCompletion>;
}

/** Planner input: the five §23.2 sections + the run loop's abort signal. */
export interface PlannerInput extends PlannerSections {
  readonly signal?: AbortSignalLike;
}

// ---------------------------------------------------------------------------
// Result envelope (AGENTS.md: typed envelopes; plan/registry result precedent)
// ---------------------------------------------------------------------------

/**
 * Deterministic plan-path classification (§23.2 smallest-path ladder):
 * - `template`          — a template ref is chosen;
 * - `variant`           — derives from the existing document (variant_create);
 * - `edit`              — edit_layers/resize/export operate on an existing
 *                         document, so the composition ladder does not apply;
 * - `components_layout` — no template, but components + layout primitives;
 * - `freeform`          — primitives only: the §23.2 last resort (flagged).
 */
export type PlannerPath = "template" | "components_layout" | "freeform" | "edit" | "variant";

/** Usage totals across every complete() call the planner made (§22). */
export interface PlannerUsageTotals {
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits: number;
}

export interface PlannerSuccess {
  readonly ok: true;
  readonly plan: Plan;
  readonly path: PlannerPath;
  /** §23.2 "last resort, flag it" — true iff path === "freeform". */
  readonly freeform: boolean;
  readonly warnings: readonly string[];
  /** complete() calls consumed (1 on the happy path; ≤ 1 + PLAN_RETRY_LIMIT). */
  readonly attempts: number;
  readonly usage: PlannerUsageTotals;
}

/** Planner failure codes — a subset of the agent catalog (../errors.ts). */
export type PlannerErrorCode = Extract<
  AgentErrorCode,
  "plan_invalid" | "provider_unhealthy" | "run_timeout"
>;

export interface PlannerFailure {
  readonly ok: false;
  readonly code: PlannerErrorCode;
  readonly message: string;
  readonly hint: string;
  readonly retryable: boolean;
  /** §5.1 issues from validatePlan + §23.2 rule enforcement (empty for provider failures). */
  readonly issues: readonly string[];
  /** Raw model output, ≤500 chars and control-char-sanitized (§5.7/§15.3). */
  readonly rawExcerpt: string;
  readonly attempts: number;
  readonly usage: PlannerUsageTotals;
}

export type PlannerResult = PlannerSuccess | PlannerFailure;

// ---------------------------------------------------------------------------
// §5.7 excerpt hygiene
// ---------------------------------------------------------------------------

/** Task contract: the raw text excerpt carried on plan_invalid is ≤500 chars. */
export const RAW_EXCERPT_MAX_CHARS = 500;

/**
 * Clips to RAW_EXCERPT_MAX_CHARS, then replaces every control char (C0 + DEL)
 * with a space via a charCode table (biome-clean — no control-char regexes) and
 * trims: an excerpt can never smuggle newlines/control payloads into envelopes.
 */
export function rawExcerptOf(text: string): string {
  const clipped = text.length > RAW_EXCERPT_MAX_CHARS ? text.slice(0, RAW_EXCERPT_MAX_CHARS) : text;
  let sanitized = "";
  for (let i = 0; i < clipped.length; i++) {
    const code = clipped.charCodeAt(i);
    sanitized += code < 0x20 || code === 0x7f ? " " : clipped.charAt(i);
  }
  return sanitized.trim();
}

// ---------------------------------------------------------------------------
// JSON extraction (fence/preamble-tolerant — parity with the W5-O critic)
// ---------------------------------------------------------------------------

export type PlanJsonExtraction =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly issue: string };

/** ```json / ``` fenced block, non-greedy; falls through when unterminated. */
const FENCE_RE = /```[a-zA-Z]*\s*([\s\S]*?)```/;

/** One JSON.parse attempt; `undefined` means "not JSON" (JSON never parses to undefined). */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** First balanced `{…}` slice honoring string escapes; `null` when unterminated. */
function firstBalancedObject(source: string): string | null {
  const start = source.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extracts the plan JSON from raw model text (§23.2 "Return JSON only" — models
 * still wrap output in fences or prose). Order: bare JSON → fenced JSON →
 * first balanced object. Shape is validatePlan's job (a bare `[1,2]` extracts
 * fine and then fails the §5.5 schema with clean issues).
 */
export function extractPlanJson(text: string): PlanJsonExtraction {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, issue: "plan: model output was empty" };
  }
  const bare = tryParse(trimmed);
  if (bare !== undefined) {
    return { ok: true, json: bare };
  }
  const fenced = FENCE_RE.exec(trimmed);
  if (fenced !== null && fenced[1] !== undefined) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) {
      return { ok: true, json: inner };
    }
  }
  const balanced = firstBalancedObject(trimmed);
  if (balanced !== null) {
    const parsed = tryParse(balanced);
    if (parsed !== undefined) {
      return { ok: true, json: parsed };
    }
  }
  return {
    ok: false,
    issue: "plan: model output is not valid JSON (return the plan object as JSON only — §23.2)",
  };
}

// ---------------------------------------------------------------------------
// §23.2 rule enforcement (pure, post-validation)
// ---------------------------------------------------------------------------

export interface PlanRuleOutcome {
  /** Violations → the plan is invalid (rides the §5.1 one-retry path). */
  readonly issues: readonly string[];
  readonly path: PlannerPath;
  readonly freeform: boolean;
  /** Non-fatal drift surfaced to the run timeline (never fails a plan alone). */
  readonly warnings: readonly string[];
}

/** Steps that mark the components+layout path (§23.2 ladder rung 2). */
const COMPONENTS_LAYOUT_TOOLS: ReadonlySet<string> = new Set([
  "component_place",
  "component_set_vars",
  "layout_apply",
]);

/** §5.5 dotted engine-style ids ≡ §6 snake_case tool names ("template.apply" ≡ "template_apply"). */
function normalizeToolName(tool: string): string {
  return tool.replace(/\./g, "_");
}

/** `id@version` (plan.ts TEMPLATE_REF_RE forbids `@` inside the id) vs a catalog entry. */
function templateRefMatches(
  ref: string,
  entry: { id: string; version?: number | string },
): boolean {
  const at = ref.indexOf("@");
  const id = at === -1 ? ref : ref.slice(0, at);
  const version = at === -1 ? "" : ref.slice(at + 1);
  if (entry.id !== id) {
    return false;
  }
  return entry.version === undefined || String(entry.version) === version;
}

/**
 * Enforces the §23.2 rules that are deterministically checkable, on a plan that
 * ALREADY passed the §5.5 schema (validatePlan). Hard violations (invented
 * template/slot/asset references; an unexplained freeform composition) become
 * `issues`; preference drift becomes `warnings` — "prefer template" is the
 * model's judgment call, so the code flags freeform and makes it explain
 * itself instead of guessing intent matches.
 *
 * Deliberately NOT hard-checked here (documented): `steps[].args` contents
 * (component variables, slot maxChars, raw coordinates) — passthrough jsonb is
 * validated at the tool boundary (§6.1: component_set_vars lists allowed
 * variables; template_fill fits text §7.3; the executor rejects unknown
 * tools). Tool names are a warning: §5.5/§24 legitimately use dotted
 * engine-style step ids (e.g. `canvas.resize`).
 */
export function enforcePlannerRules(plan: Plan, sections: PlannerSections): PlanRuleOutcome {
  const issues: string[] = [];
  const warnings: string[] = [];
  const templates = [...(sections.catalog.templates ?? []), ...(sections.snapshot.templates ?? [])];

  // Legal asset refs: brief attachments ∪ document assets ∪ catalog assets.
  const assetIds = new Set<string>();
  for (const attachment of sections.brief.attachments ?? []) {
    assetIds.add(attachment.id);
  }
  for (const asset of sections.snapshot.assets ?? []) {
    assetIds.add(asset.id);
  }
  for (const asset of sections.catalog.assets ?? []) {
    assetIds.add(asset.id);
  }

  // 1. The chosen template must exist (§23.2: ids are never invented).
  const templateRef = plan.template;
  let chosen: { id: string; version?: number | string; slots?: readonly string[] } | undefined;
  if (templateRef !== null) {
    chosen = templates.find((entry) => templateRefMatches(templateRef, entry));
    if (chosen === undefined) {
      issues.push(
        `plan.template: "${templateRef}" is not present in CATALOG/SNAPSHOT — invented template id (§23.2)`,
      );
    } else if (!plan.steps.some((step) => normalizeToolName(step.tool) === "template_apply")) {
      warnings.push(
        "plan chooses a template but has no template_apply step; the executor must apply it before filling slots (§6 row 4)",
      );
    }
  }

  // 2. Slot names (plan.slots keys AND assets[].slot): scoped to the chosen
  //    template when one is known; else any known slot. No slot data anywhere
  //    → nothing may be cited (§23.2 "never invent slot names").
  const slotScope =
    chosen !== undefined && chosen.slots !== undefined
      ? new Set<string>(chosen.slots)
      : allKnownSlots(sections, templates);
  const slotNames = new Set<string>([
    ...Object.keys(plan.slots),
    ...plan.assets.map((a) => a.slot),
  ]);
  if (slotNames.size > 0 && slotScope.size === 0) {
    issues.push(
      "plan.slots: slot names cannot be verified — CATALOG/SNAPSHOT list no template slots, so citing any slot invents one (§23.2)",
    );
  }
  for (const slot of slotNames) {
    if (slotScope.size > 0 && !slotScope.has(slot)) {
      issues.push(
        `plan slot "${slot}": not a slot in CATALOG/SNAPSHOT — invented slot name (§23.2)`,
      );
    }
  }
  if (templateRef === null && Object.keys(plan.slots).length > 0) {
    warnings.push("plan fills slots without choosing a template; prefer the template path (§23.2)");
  }

  // 3. Asset refs (§23.2 "never invent … asset ids").
  if (plan.assets.length > 0 && assetIds.size === 0) {
    issues.push(
      "plan.assets: asset refs cannot be verified — BRIEF/SNAPSHOT/CATALOG list no asset ids, so citing any ref invents one (§23.2)",
    );
  }
  for (const asset of plan.assets) {
    if (assetIds.size > 0 && !assetIds.has(asset.ref)) {
      issues.push(
        `plan asset ref "${asset.ref}": not present in BRIEF/SNAPSHOT/CATALOG — invented asset id (§23.2)`,
      );
    }
  }

  // 4. Smallest-path classification + freeform flagging (§23.2 ladder).
  const tools = plan.steps.map((step) => normalizeToolName(step.tool));
  const path = classifyPath(plan, templateRef, tools);
  const freeform = path === "freeform";
  if (freeform) {
    if (plan.notes_for_user.trim().length === 0) {
      issues.push(
        "plan.notes_for_user: a freeform composition (no template, no components/layout step) is the §23.2 last resort and must be explained in notes_for_user",
      );
    }
    warnings.push("freeform composition planned — flagged as the §23.2 last resort");
    if (templates.length > 0) {
      warnings.push(
        `freeform chosen while CATALOG/SNAPSHOT list ${templates.length} template(s); prefer template > components+layout > freeform (§23.2)`,
      );
    }
  }

  // 5. Soft check: step tools vs the §6 manifest (the executor rejects unknown
  //    tools at the boundary; dotted §5.5 ids normalize before comparing).
  if (sections.catalog.tools.length > 0) {
    const known = new Set(sections.catalog.tools.map((tool) => tool.name));
    const unknown = [...new Set(tools.filter((tool) => !known.has(tool)))];
    if (unknown.length > 0) {
      warnings.push(
        `plan steps name tools outside the §6 manifest (${unknown.slice(0, 5).join(", ")}); the executor will reject unknown tools (§6.1)`,
      );
    }
  }

  return { issues, path, freeform, warnings };
}

function allKnownSlots(
  sections: PlannerSections,
  templates: readonly { slots?: readonly string[] }[],
): Set<string> {
  const slots = new Set<string>();
  for (const entry of templates) {
    for (const slot of entry.slots ?? []) {
      slots.add(slot);
    }
  }
  for (const slot of sections.snapshot.templateSlots ?? []) {
    slots.add(slot);
  }
  return slots;
}

function classifyPath(
  plan: Plan,
  templateRef: string | null,
  tools: readonly string[],
): PlannerPath {
  if (templateRef !== null) {
    return "template";
  }
  if (tools.includes("variant_create")) {
    return "variant";
  }
  // edit_layers/resize/export operate on an existing document — the
  // composition ladder (template > components+layout > freeform) governs
  // composing intents (create_post/variant) only.
  if (plan.intent !== "create_post" && plan.intent !== "variant") {
    return "edit";
  }
  if (tools.some((tool) => COMPONENTS_LAYOUT_TOOLS.has(tool))) {
    return "components_layout";
  }
  return "freeform";
}

// ---------------------------------------------------------------------------
// Usage bookkeeping (§22: numbers, never content)
// ---------------------------------------------------------------------------

interface MutableUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
}

function emptyUsage(): MutableUsage {
  return { calls: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0 };
}

/** Provider telemetry can be flaky; sanitize like budgets.ts (never throw on it). */
function saneTokens(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function accumulateUsage(total: MutableUsage, usage: PlanModelUsage | undefined): void {
  total.calls += 1;
  total.tokensIn += saneTokens(usage?.tokensIn);
  total.tokensOut += saneTokens(usage?.tokensOut);
  total.cacheHits += saneTokens(usage?.cacheHits);
}

function freezeUsage(usage: MutableUsage): PlannerUsageTotals {
  return Object.freeze({ ...usage });
}

// ---------------------------------------------------------------------------
// Failure builders (typed envelopes; no leaks)
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function failure(
  code: PlannerErrorCode,
  message: string,
  hint: string,
  retryable: boolean,
  attempts: number,
  usage: MutableUsage,
  issues: readonly string[] = [],
  rawExcerpt = "",
): PlannerFailure {
  return {
    ok: false,
    code,
    message,
    hint,
    retryable,
    issues,
    rawExcerpt,
    attempts,
    usage: freezeUsage(usage),
  };
}

// ---------------------------------------------------------------------------
// PlannerService
// ---------------------------------------------------------------------------

/**
 * The §5.1 planner: prompts the injected §5.3 model with the §23.2 prompt,
 * validates the raw output (fence-tolerant JSON → validatePlan schema → §23.2
 * rules) and gives the model EXACTLY ONE retry with the issues attached before
 * failing with `plan_invalid`.
 */
export class PlannerService {
  private readonly model: PlanModelLike;

  constructor(model: PlanModelLike) {
    this.model = model;
  }

  async plan(input: PlannerInput): Promise<PlannerResult> {
    if (input.signal?.aborted) {
      return failure(
        "run_timeout",
        "The planner call was aborted before a plan was produced (§3.4 run timeout or cancellation).",
        "The run loop owns the §5.2 wall-clock deadline; no engine command ran.",
        false,
        0,
        emptyUsage(),
      );
    }

    const parsed = plannerInputSchema.safeParse(input);
    if (!parsed.success) {
      // Worker wiring bug → fail fast (BudgetTracker.parse precedent) with
      // field PATHS only — the brief is user content and never echoes (§15.3).
      const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
      throw new Error(`[agent/planner] invalid planner input (worker wiring): ${paths}`);
    }
    const sections: PlannerSections = parsed.data;

    const usage = emptyUsage();
    let prompt = buildPlannerPrompt(sections);
    const maxAttempts = 1 + PLAN_RETRY_LIMIT; // §5.1: one retry
    let issues: readonly string[] = [];
    let rawExcerpt = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let completion: PlanModelCompletion;
      try {
        completion = await this.model.complete(prompt, input.signal);
      } catch (error) {
        if (isAbortError(error)) {
          return failure(
            "run_timeout",
            "The planner call was aborted before a plan was produced (§3.4 run timeout or cancellation).",
            "The run loop owns the §5.2 wall-clock deadline; no engine command ran.",
            false,
            attempt,
            usage,
          );
        }
        // §5.3 health/failover is the worker's seam; provider internals
        // (messages, stack, model ids) never enter the envelope (§15.3/§22).
        return failure(
          "provider_unhealthy",
          "The planner model call failed (§5.3 provider seam).",
          "The worker's §5.3 router owns retries/failover; re-run once the provider recovers.",
          true,
          attempt,
          usage,
        );
      }
      accumulateUsage(usage, completion.usage);
      rawExcerpt = rawExcerptOf(completion.text);

      const extraction = extractPlanJson(completion.text);
      const schema = extraction.ok ? validatePlan(extraction.json) : undefined;
      const rules =
        schema !== undefined && schema.ok ? enforcePlannerRules(schema.plan, sections) : undefined;
      issues = [
        ...(extraction.ok ? [] : [extraction.issue]),
        ...(schema !== undefined && !schema.ok ? schema.issues : []),
        ...(rules !== undefined && rules.issues.length > 0 ? rules.issues : []),
      ];

      if (schema !== undefined && schema.ok && rules !== undefined && issues.length === 0) {
        return {
          ok: true,
          plan: schema.plan,
          path: rules.path,
          freeform: rules.freeform,
          warnings: rules.warnings,
          attempts: attempt,
          usage: freezeUsage(usage),
        };
      }
      if (attempt < maxAttempts) {
        // §5.1: exactly one retry, with the validation errors attached.
        prompt = buildPlannerRetryPrompt(prompt, issues);
      }
    }

    return failure(
      "plan_invalid",
      `The planner did not return a valid plan after ${maxAttempts} attempt(s) (§5.1: one retry with the validation issues attached).`,
      "The validation issues are attached for the run timeline; a clearer brief or a different planner route (§5.3) may fix it.",
      false,
      maxAttempts,
      usage,
      issues,
      rawExcerpt,
    );
  }
}
