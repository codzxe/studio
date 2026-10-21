// @studio/agent — the §23.5 chat-edit classifier. Owner: W6-O (AGENTS.md).
//
// Spec anchors:
//   §23.5  the classification contract: { action, target_layers, args,
//          cost_tier, needs_template_reapply }, "pick the CHEAPEST action",
//          ambiguity → action "clarify" with candidates + one question, never
//          a full regeneration when a targeted edit works.
//   §24.2  the worked example: "Make the subhead smaller and add a 20% OFF
//          badge." → restyle + add_component, target Subhead, quick tier,
//          1 credit. §23.5 lists ATOMIC actions; §24.2 shows composition —
//          the `action` field parses "+"-joined atoms (≤3, unique).
//   §5.1   one retry: invalid classification → exactly one retry with the
//          validation issues attached (1 + @studio/config PLAN_RETRY_LIMIT),
//          then fail `plan_invalid` with a clear message.
//   §5.2   tier tool-call caps (quick 6 / standard 12 / complex 24) drive the
//          deterministic cost-tier guard; the run tail (render + validate +
//          commit, §24.2 trace) is part of the estimate.
//   §5.3   the model seam is INJECTED (`ClassifierModelLike`); the worker
//          wires the AI SDK + router — provider ids never appear here.
//   §5.5   success emits a MINI PLAN (buildRepairMiniPlan precedent): the
//          steps are §5.5 PlanStep-shaped and wrapped in a schema-validated
//          Plan the executor (src/executor) can walk directly.
//   §14.1  cost-tier resolution: quick 1 / standard 2 / complex 5 credits —
//          priced via @studio/config `resolveTierConfig` (the same §14.1
//          table @studio/billing `creditsForRun` reads; this package does
//          not depend on @studio/billing).
//   §5.7   model output is untrusted: strictObject (no smuggled keys), capped
//          args, invented target/component refs rejected, excerpts sanitized.
//   §22/§15.3 usage is counts only; provider/user content never enters
//          error envelopes.
import { PLAN_RETRY_LIMIT, resolveTierConfig } from "@studio/config";
import { z } from "zod";
import type { AgentErrorCode } from "../errors.js";
import {
  MAX_PLAN_STRING,
  type Plan,
  type PlanIntent,
  type PlanStep,
  validatePlan,
} from "../plan.js";
import { type AbortSignalLike, rawExcerptOf } from "../planner/planner.js";
import {
  type ChatEditCatalog,
  type ChatEditComponentEntry,
  type ChatEditLayerSummary,
  type ChatEditUserRequest,
  buildChatEditPrompt,
  buildChatEditRetryPrompt,
  chatEditInputSchema,
} from "./prompt.js";

// ---------------------------------------------------------------------------
// The action vocabulary (§23.5 atoms; §24.2 composes with "+")
// ---------------------------------------------------------------------------

/** §23.5 `action` — the ten atomic chat-edit actions, exactly these. */
export const CHAT_EDIT_ACTIONS = [
  "set_text",
  "replace_field",
  "restyle",
  "move",
  "resize",
  "add_component",
  "remove_layer",
  "recolor",
  "export",
  "clarify",
] as const;

export type ChatEditAction = (typeof CHAT_EDIT_ACTIONS)[number];

export const chatEditActionSchema = z.enum(CHAT_EDIT_ACTIONS);

const CHAT_ACTION_SET: ReadonlySet<string> = new Set(CHAT_EDIT_ACTIONS);

/** §24.2 shows two atoms composing; three is the generous ceiling. */
export const MAX_COMPOSITE_ACTIONS = 3;

/** Generous for "set_text+replace_field+add_component". */
export const MAX_ACTION_EXPR_CHARS = 120;

export type ActionExprResult =
  | { readonly ok: true; readonly atoms: readonly ChatEditAction[] }
  | { readonly ok: false; readonly issue: string };

/** Clips untrusted strings so issues never echo a wall of model output. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Parses the `action` field: one §23.5 atom, or "+"-joined atoms (§24.2
 * writes "restyle + add_component" — spaces around "+" are tolerated).
 * Duplicate atoms and >3 atoms are invalid.
 */
export function parseActionExpr(value: string): ActionExprResult {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { ok: false, issue: `action "${clip(value, 40)}" is empty (§23.5)` };
  }
  if (parts.length > MAX_COMPOSITE_ACTIONS) {
    return {
      ok: false,
      issue: `action composes ${parts.length} atoms (max ${MAX_COMPOSITE_ACTIONS})`,
    };
  }
  const atoms: ChatEditAction[] = [];
  for (const part of parts) {
    if (!CHAT_ACTION_SET.has(part)) {
      return {
        ok: false,
        issue: `action atom "${clip(part, 40)}" is not one of the §23.5 actions (${CHAT_EDIT_ACTIONS.join("|")})`,
      };
    }
    const atom = part as ChatEditAction;
    if (atoms.includes(atom)) {
      return { ok: false, issue: `action repeats atom "${atom}"` };
    }
    atoms.push(atom);
  }
  return { ok: true, atoms };
}

// ---------------------------------------------------------------------------
// Cost tiers + §14.1 credit resolution
// ---------------------------------------------------------------------------

/** §23.5 `cost_tier` — the three chat-edit tiers (premium/max are §5.2 multipliers, never classifier output). */
export const CHAT_COST_TIERS = ["quick", "standard", "complex"] as const;
export type ChatCostTier = (typeof CHAT_COST_TIERS)[number];
export const chatCostTierSchema = z.enum(CHAT_COST_TIERS);

/** §5.2 tool-call caps per chat-edit tier. */
export const TIER_TOOL_CALL_CAPS: Readonly<Record<ChatCostTier, number>> = {
  quick: 6,
  standard: 12,
  complex: 24,
};

/**
 * §14.1 credit price of a chat-edit tier via the billing-policy table in
 * @studio/config (quick 1 / standard 2 / complex 5).
 */
export function creditsForCostTier(tier: ChatCostTier): number {
  return resolveTierConfig(tier).credits;
}

// ---------------------------------------------------------------------------
// The classification schema (§23.5, strict — §5.7 untrusted input)
// ---------------------------------------------------------------------------

/** Task pin: at most 10 target layers. */
export const MAX_TARGET_LAYERS = 10;

/** §5.7 caps on the passthrough args object. */
export const MAX_ARGS_KEYS = 32;
export const MAX_ARGS_JSON_CHARS = 8000;

/** Clarify payload caps (ask_user tool contract: question ≤300, options 1–4 × ≤120). */
export const MAX_CLARIFY_CANDIDATES = 10;
export const MAX_CLARIFY_QUESTION_CHARS = 300;
export const MAX_ASK_USER_OPTIONS = 4;
export const MAX_ASK_USER_OPTION_CHARS = 120;

/** `args` is passthrough jsonb — §23.5 "{...}"; content dies at the tool boundary (§6.1). */
export const chatEditArgsSchema = z
  .record(z.string().min(1).max(200), z.unknown())
  .refine((args) => Object.keys(args).length <= MAX_ARGS_KEYS, {
    message: `too many args keys (max ${MAX_ARGS_KEYS})`,
  })
  .refine((args) => JSON.stringify(args).length <= MAX_ARGS_JSON_CHARS, {
    message: `args exceed the ${MAX_ARGS_JSON_CHARS}-char budget`,
  });

/**
 * The §23.5 output contract, key set EXACTLY as the spec shows (strictObject:
 * a model cannot smuggle extra directives past the boundary, §5.7).
 */
export const chatEditClassificationSchema = z.strictObject({
  action: z
    .string()
    .min(1)
    .max(MAX_ACTION_EXPR_CHARS)
    .superRefine((value, ctx) => {
      const parsed = parseActionExpr(value);
      if (!parsed.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: parsed.issue });
      }
    }),
  target_layers: z.array(z.string().min(1).max(200)).max(MAX_TARGET_LAYERS),
  args: chatEditArgsSchema,
  cost_tier: chatCostTierSchema,
  needs_template_reapply: z.boolean(),
});

export type ChatEditClassification = z.infer<typeof chatEditClassificationSchema>;

/** One zod issue → a bounded, readable string (attached verbatim to the retry). */
function formatClassificationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `classification.${clip(path, 120)}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// Action semantics (deterministic tables — §24.2 trace grounding)
// ---------------------------------------------------------------------------

/** §6 primary tool per atom (snake_case registry names; the executor gate knows these). */
export const ACTION_PRIMARY_TOOLS: Readonly<Record<ChatEditAction, string>> = {
  set_text: "text_set", // §6 row 8 — type.edit under text_set
  replace_field: "template_fill", // §6 row 5 — slot/field replacement
  restyle: "style_apply", // §6 row 10 — styles/presets (§24.2 "smaller subhead")
  move: "layer_ops", // §6 row 9 — arrange/reorder
  resize: "layer_ops", // §6 row 9 — setProps; canvas-level rides args
  remove_layer: "layer_ops", // §6 row 9
  recolor: "style_apply", // §6 row 10 — edit.fill / style colors
  add_component: "component_place", // §6 row 12 (+ row 13 vars ride the place args, §24.2)
  export: "export_document", // §6 row 18
  clarify: "ask_user", // §6 model-orchestrated row (§23.2 ask_user precedent)
};

/** Atoms that operate on named existing layers → need ≥1 target (§23.5). */
export const LAYER_TARGETED_ACTIONS: ReadonlySet<ChatEditAction> = new Set([
  "set_text",
  "replace_field",
  "restyle",
  "move",
  "remove_layer",
  "recolor",
]);

// ---------------------------------------------------------------------------
// Post-rules (pure, post-schema — §23.5 deterministically checkable)
// ---------------------------------------------------------------------------

/** The validated clarify payload: §23.5 candidates + the one question. */
export interface ClarifyRequest {
  readonly question: string;
  readonly candidates: readonly string[];
}

export interface ChatEditRuleContext {
  /** Layer names from the §5.4 LAYER SUMMARY (empty = unverifiable). */
  readonly layerNames: ReadonlySet<string>;
  /** Catalog component entries (empty = unverifiable). */
  readonly components: readonly ChatEditComponentEntry[];
}

export interface ChatEditRuleOutcome {
  /** Violations → retry with the issues attached (§5.1). */
  readonly issues: readonly string[];
  /** Non-fatal drift surfaced to the run timeline (§22-safe: names only). */
  readonly warnings: readonly string[];
  /** The validated clarify payload when action is "clarify"; else null. */
  readonly clarify: ClarifyRequest | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClarifyPayload(args: Record<string, unknown>):
  | {
      ok: true;
      clarify: ClarifyRequest;
    }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const rawCandidates = args.candidates;
  const candidates: string[] = [];
  if (Array.isArray(rawCandidates) && rawCandidates.length > 0) {
    for (const candidate of rawCandidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        if (candidate.length <= 200) {
          candidates.push(candidate);
        } else {
          issues.push("clarify candidate exceeds the 200-char layer-name budget (§23.5)");
        }
      }
    }
    if (candidates.length === 0) {
      issues.push("clarify args.candidates must list the candidate targets as strings (§23.5)");
    }
    if (rawCandidates.length > MAX_CLARIFY_CANDIDATES) {
      issues.push(
        `clarify lists ${rawCandidates.length} candidates (max ${MAX_CLARIFY_CANDIDATES})`,
      );
    }
  } else {
    issues.push("clarify requires args.candidates with the ambiguous target candidates (§23.5)");
  }
  const question = args.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    issues.push("clarify requires args.question with the ONE question to ask (§23.5)");
  } else if (question.length > MAX_CLARIFY_QUESTION_CHARS) {
    issues.push(`clarify question exceeds the ${MAX_CLARIFY_QUESTION_CHARS}-char ask_user budget`);
  }
  if (issues.length > 0 || typeof question !== "string") {
    return { ok: false, issues };
  }
  return { ok: true, clarify: { question, candidates } };
}

/** `id@version` (component ids may inline the version, §24.2 "offer-badge@2"). */
function componentRefMatches(ref: string, entry: ChatEditComponentEntry): boolean {
  if (entry.id === ref) {
    return true;
  }
  const at = ref.indexOf("@");
  if (at === -1 || entry.version === undefined) {
    return false;
  }
  return entry.id === ref.slice(0, at) && String(entry.version) === ref.slice(at + 1);
}

/**
 * Enforces the §23.5 rules that are deterministically checkable, on output
 * that ALREADY passed the schema: clarify shape (candidates + one question,
 * never composed), layer-targeted atoms need named targets, targets/component
 * refs are never invented (the §23.2 "never invent" stance carried over to
 * chat edits). Unverifiable inputs (empty layer summary / empty component
 * catalog) degrade to warnings, never failures.
 */
export function enforceChatEditRules(
  atoms: readonly ChatEditAction[],
  classification: ChatEditClassification,
  context: ChatEditRuleContext,
): ChatEditRuleOutcome {
  const issues: string[] = [];
  const warnings: string[] = [];
  const args = classification.args;
  const targets = classification.target_layers;

  // 1. clarify: candidates + one question, and a clarify never composes.
  let clarify: ClarifyRequest | null = null;
  if (atoms.includes("clarify")) {
    if (atoms.length > 1) {
      issues.push('"clarify" never composes — a question pauses the edit (§23.5)');
    }
    const payload = readClarifyPayload(args);
    if (payload.ok) {
      clarify = payload.clarify;
    } else {
      issues.push(...payload.issues);
    }
  }

  // 2. Layer-targeted atoms need at least one named target.
  const targeted = atoms.filter((atom) => LAYER_TARGETED_ACTIONS.has(atom));
  if (targeted.length > 0 && targets.length === 0) {
    issues.push(
      `target_layers is empty but action(s) ${targeted.join("+")} need named target layers (§23.5)`,
    );
  }

  // 3. Targets must exist in the layer summary (never invented).
  if (targets.length > 0) {
    if (context.layerNames.size === 0) {
      warnings.push("target layer(s) could not be verified — the layer summary lists no layers");
    } else {
      for (const target of targets) {
        if (!context.layerNames.has(target)) {
          issues.push(
            `target layer "${clip(target, 200)}" is not in the layer summary — invented target (§23.5); use a real layer name or action "clarify" with candidates`,
          );
        }
      }
    }
  }

  // 4. add_component: the cited component must exist in the catalog.
  if (atoms.includes("add_component")) {
    const scoped = args.add_component;
    const ref = isPlainObject(scoped)
      ? firstStringRef(scoped, ["component", "id", "ref"])
      : firstStringRef(args, ["component", "id", "ref"]);
    if (ref === undefined) {
      warnings.push(
        "add_component args carry no component id (component|id|ref) — the §6 boundary validates the place call",
      );
    } else if (context.components.length === 0) {
      warnings.push(
        `component "${clip(ref, 60)}" could not be verified — the catalog lists no components`,
      );
    } else if (!context.components.some((entry) => componentRefMatches(ref, entry))) {
      issues.push(
        `component "${clip(ref, 60)}" is not present in the catalog — invented component id (§23.5)`,
      );
    }
  }

  return { issues, warnings, clarify };
}

function firstStringRef(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Cost-tier resolution — the §23.5 "cheapest action" guard (pure)
// ---------------------------------------------------------------------------

/** render_preview + validate_document + commit (§24.2 trace tail). */
export const RUN_TAIL_CALLS = 3;
/** needs_template_reapply adds template_apply + template_fill to the run. */
export const REAPPLY_CALLS = 2;

export interface CostTierResolution {
  /** What the model proposed (§23.5 `cost_tier`). */
  readonly proposed: ChatCostTier;
  /** What the run charges after the guard (never heavier than the work needs). */
  readonly resolved: ChatCostTier;
  /** §14.1 credits of the resolved tier (1 / 2 / 5). */
  readonly credits: number;
  /** Deterministic workload estimate (mutating steps + tail + reapply). */
  readonly estimatedCalls: number;
  readonly warnings: readonly string[];
}

const TIER_ORDER: readonly ChatCostTier[] = ["quick", "standard", "complex"];

/** Cheapest tier whose §5.2 tool-call cap fits `calls` (complex is the ceiling). */
function cheapestTierForCalls(calls: number): ChatCostTier {
  for (const tier of TIER_ORDER) {
    if (calls <= TIER_TOOL_CALL_CAPS[tier]) {
      return tier;
    }
  }
  return "complex";
}

/**
 * The full-regeneration downgrade guard (§23.5): a targeted chat edit never
 * needs a heavier tier than its workload. `estimatedCalls` mirrors EXACTLY the
 * steps buildChatEditSteps emits, plus the §24.2 run tail and the reapply
 * pair. The resolved tier is the CHEAPEST tier that satisfies the request:
 * heavier proposals are downgraded (with a warning); lighter proposals are
 * raised so the run does not §5.2-clean-stop mid-edit (also with a warning).
 */
export function resolveCostTier(params: {
  readonly atoms: readonly ChatEditAction[];
  readonly targetCount: number;
  readonly needsTemplateReapply: boolean;
  readonly proposed: ChatCostTier;
}): CostTierResolution {
  const warnings: string[] = [];
  let mutating = 0;
  for (const atom of params.atoms) {
    if (LAYER_TARGETED_ACTIONS.has(atom) || atom === "resize") {
      // Layer-targeted atoms emit one step per target; resize also emits one
      // canvas-level step when no target is named (Math.max covers it).
      mutating += Math.max(1, params.targetCount);
    } else {
      mutating += 1; // add_component, export, clarify
    }
  }
  const tail = params.atoms.includes("clarify") ? 0 : RUN_TAIL_CALLS;
  const reapply = params.needsTemplateReapply ? REAPPLY_CALLS : 0;
  const estimatedCalls = mutating + tail + reapply;

  const resolved = cheapestTierForCalls(estimatedCalls);
  if (resolved === "complex" && estimatedCalls > TIER_TOOL_CALL_CAPS.complex) {
    warnings.push(
      `the classified ask needs ~${estimatedCalls} tool call(s), over even the complex cap of ${TIER_TOOL_CALL_CAPS.complex} — the run may stop cleanly at the cap (§5.2)`,
    );
  }
  if (resolved === params.proposed) {
    return {
      proposed: params.proposed,
      resolved,
      credits: creditsForCostTier(resolved),
      estimatedCalls,
      warnings,
    };
  }
  const rank = (tier: ChatCostTier): number => TIER_ORDER.indexOf(tier);
  if (rank(resolved) > rank(params.proposed)) {
    warnings.push(
      `cost_tier "${params.proposed}" raised to "${resolved}" — the ask needs ~${estimatedCalls} tool call(s), over the ${params.proposed} cap of ${TIER_TOOL_CALL_CAPS[params.proposed]} (§5.2); the lighter tier would stop mid-edit`,
    );
  } else {
    warnings.push(
      `cost_tier "${params.proposed}" downgraded to "${resolved}" — the targeted ask needs ~${estimatedCalls} tool call(s) and a targeted edit never justifies the heavier tier (§23.5: pick the cheapest action that satisfies the request)`,
    );
  }
  return {
    proposed: params.proposed,
    resolved,
    credits: creditsForCostTier(resolved),
    estimatedCalls,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Mini-plan step assembly (§24.2 trace; the executor owns §6 arg validation)
// ---------------------------------------------------------------------------

export interface ChatEditStepPlan {
  readonly steps: readonly PlanStep[];
  readonly warnings: readonly string[];
}

/**
 * Args scoping: when the model nests an atom's payload under args[atom] (the
 * composite convention), that atom gets exactly its own object; unscoped atoms
 * share the remainder (args minus every atom-keyed sub-object). Single-atom
 * requests with flat args keep the whole object.
 */
function scopedArgsFor(
  args: Record<string, unknown>,
  atom: ChatEditAction,
  atoms: readonly ChatEditAction[],
): Record<string, unknown> {
  const own = args[atom];
  if (isPlainObject(own)) {
    return { ...own };
  }
  const remainder: Record<string, unknown> = { ...args };
  for (const other of atoms) {
    delete remainder[other];
  }
  return remainder;
}

/**
 * Builds the executor steps: one step per (layer-targeted atom × target), one
 * per canvas-level atom (resize with no targets, add_component, export), and
 * a single ask_user step for clarify (options capped to the tool's 1–4 —
 * extra candidates are warned, never silently dropped). The emitted step
 * COUNT is exactly `resolveCostTier`'s mutating estimate.
 */
export function buildChatEditSteps(
  classification: ChatEditClassification,
  atoms: readonly ChatEditAction[],
  clarify: ClarifyRequest | null,
): ChatEditStepPlan {
  const steps: PlanStep[] = [];
  const warnings: string[] = [];
  const targets = classification.target_layers;
  const args = classification.args;

  for (const atom of atoms) {
    if (atom === "clarify") {
      if (clarify === null) {
        continue; // unreachable post-rules; buildChatEditMiniPlan needs ≥1 step
      }
      const options = clarify.candidates.slice(0, MAX_ASK_USER_OPTIONS);
      if (clarify.candidates.length > options.length) {
        warnings.push(
          `${clarify.candidates.length - options.length} clarify candidate(s) beyond the ask_user option cap (${MAX_ASK_USER_OPTIONS}) dropped from the question card`,
        );
      }
      steps.push({ tool: "ask_user", args: { question: clarify.question, options } });
      continue;
    }
    const tool = ACTION_PRIMARY_TOOLS[atom];
    const scoped = scopedArgsFor(args, atom, atoms);
    if (LAYER_TARGETED_ACTIONS.has(atom)) {
      for (const target of targets) {
        steps.push({ tool, args: { ...scoped, layer: target } });
      }
      continue;
    }
    if (atom === "resize" && targets.length > 0) {
      for (const target of targets) {
        steps.push({ tool, args: { ...scoped, layer: target } });
      }
      continue;
    }
    steps.push({ tool, args: scoped }); // canvas-level resize, add_component, export
  }
  return { steps, warnings };
}

/** §5.5 intent: export/resize when the whole ask is that atom; else edit_layers. */
function intentFor(atoms: readonly ChatEditAction[]): PlanIntent {
  const first = atoms[0];
  if (atoms.length === 1 && (first === "export" || first === "resize")) {
    return first;
  }
  return "edit_layers";
}

/** notes_for_user, §22-safe: names/counts only, clipped to the §5.5 budget. */
function notesFor(
  classification: ChatEditClassification,
  atoms: readonly ChatEditAction[],
  tier: ChatCostTier,
  credits: number,
  clarify: ClarifyRequest | null,
): string {
  const parts = [
    `Chat edit (§23.5): ${atoms.join(" + ")}.`,
    `Cost tier ${tier} (${credits} credit${credits === 1 ? "" : "s"}, §14.1).`,
  ];
  if (classification.target_layers.length > 0) {
    parts.push(`Target layer(s): ${classification.target_layers.join(", ")}.`);
  }
  if (classification.needs_template_reapply) {
    parts.push("Template reapply needed after the edit (§23.5).");
  }
  if (clarify !== null) {
    parts.push(`Clarifying question: ${clarify.question}`);
  }
  return clip(parts.join(" "), MAX_PLAN_STRING);
}

/**
 * Swap-point (W6-F REPAIR_PLAN_INVALID_CODE precedent): errors.ts is add-only
 * and carries no classifier-specific code, so invalid classifier output maps
 * to the closest existing agent code — `plan_invalid`. errors.ts owner: add a
 * chat-edit code to AGENT_ERROR_CODES, widen ChatEditErrorCode, then flip this
 * one-line constant. Tests import it.
 */
export const CHAT_EDIT_INVALID_CODE: ChatEditErrorCode = "plan_invalid";

/**
 * Wraps the chat-edit steps into a full §5.5-validated Plan (the executor
 * walks whole plans — buildRepairMiniPlan precedent; render/validate/commit
 * stay run phases, §5.1). `template` is null: a §23.5 targeted edit never
 * re-instantiates a template; the needs_template_reapply flag travels on the
 * classification result for the run manager.
 */
export function buildChatEditMiniPlan(params: {
  readonly classification: ChatEditClassification;
  readonly atoms: readonly ChatEditAction[];
  readonly steps: readonly PlanStep[];
  readonly tier: ChatCostTier;
  readonly clarify: ClarifyRequest | null;
}): { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly issues: string[] } {
  const { classification } = params;
  const validated = validatePlan({
    intent: intentFor(params.atoms),
    template: null,
    assets: [],
    slots: {},
    palette: [],
    typography: {},
    steps: [...params.steps],
    checks: [],
    model_tier: params.tier,
    notes_for_user: notesFor(
      classification,
      params.atoms,
      params.tier,
      creditsForCostTier(params.tier),
      params.clarify,
    ),
  });
  if (!validated.ok) {
    return { ok: false, issues: validated.issues };
  }
  return { ok: true, plan: validated.plan };
}

// ---------------------------------------------------------------------------
// The injected model seam (§5.3 — the worker wires the AI SDK + router)
// ---------------------------------------------------------------------------

/** Usage numbers one classifier completion reports (NaN/negatives dropped). */
export interface ClassifierModelUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cacheHits?: number;
}

export interface ClassifierModelCompletion {
  readonly text: string;
  readonly usage?: ClassifierModelUsage;
}

/**
 * The injected classifier model: one raw-text completion. The worker wires
 * this over the quick-tier economy route (§5.2/§5.3 — chat edits classify on
 * the cheap model); circuit breakers/failover live in the router, never here.
 */
export interface ClassifierModelLike {
  complete(prompt: string, signal?: AbortSignalLike): Promise<ClassifierModelCompletion>;
}

/** Classifier input: the three §23.5 sections + the run loop's abort signal. */
export interface ChatEditClassifyInput {
  readonly userRequest: ChatEditUserRequest;
  readonly layerSummary: ChatEditLayerSummary;
  readonly catalog: ChatEditCatalog;
  readonly signal?: AbortSignalLike;
}

// ---------------------------------------------------------------------------
// Result envelope (AGENTS.md typed envelopes; planner precedent)
// ---------------------------------------------------------------------------

/** Usage totals across every complete() call (§22 numbers only). */
export interface ChatEditUsageTotals {
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits: number;
}

export interface ChatEditSuccess {
  readonly ok: true;
  readonly classification: ChatEditClassification;
  /** Parsed action atoms (1..3 unique, §24.2 order). */
  readonly actions: readonly ChatEditAction[];
  readonly proposedTier: ChatCostTier;
  /** Resolved tier after the §23.5 cheapest-action guard. */
  readonly costTier: ChatCostTier;
  /** §14.1 credits of the resolved tier (1 / 2 / 5). */
  readonly credits: number;
  readonly needsTemplateReapply: boolean;
  /** Post-rule warnings (unverifiable refs, tier guard) — §22-safe. */
  readonly warnings: readonly string[];
  /** The §5.5 mini plan the executor walks. */
  readonly plan: Plan;
  /** Validated clarify payload when action is "clarify"; else null. */
  readonly clarify: ClarifyRequest | null;
  readonly attempts: number;
  readonly usage: ChatEditUsageTotals;
}

/** Classifier failure codes — the planner subset (../errors.ts catalog). */
export type ChatEditErrorCode = Extract<
  AgentErrorCode,
  "plan_invalid" | "provider_unhealthy" | "run_timeout"
>;

export interface ChatEditFailure {
  readonly ok: false;
  readonly code: ChatEditErrorCode;
  readonly message: string;
  readonly hint: string;
  readonly retryable: boolean;
  /** §5.1 issues from extraction/schema/post-rules (empty for provider failures). */
  readonly issues: readonly string[];
  /** Raw model output, ≤500 chars, control-char-sanitized (§5.7/§15.3). */
  readonly rawExcerpt: string;
  readonly attempts: number;
  readonly usage: ChatEditUsageTotals;
}

export type ChatEditResult = ChatEditSuccess | ChatEditFailure;

// ---------------------------------------------------------------------------
// JSON extraction (fence/preamble-tolerant — planner parity)
// ---------------------------------------------------------------------------

export type ChatEditJsonExtraction =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly issue: string };

/** ```json / ``` fenced block, non-greedy; falls through when unterminated. */
const FENCE_RE = /```[a-zA-Z]*\s*([\s\S]*?)```/;

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
 * Extracts the classification JSON from raw model text (§23.5 "Return JSON
 * only" — models still wrap output in fences or prose). Order: bare JSON →
 * fenced JSON → first balanced object.
 */
export function extractChatEditJson(text: string): ChatEditJsonExtraction {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, issue: "classification: model output was empty" };
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
    issue:
      "classification: model output is not valid JSON (return the classification object as JSON only — §23.5)",
  };
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

function accumulateUsage(total: MutableUsage, usage: ClassifierModelUsage | undefined): void {
  total.calls += 1;
  total.tokensIn += saneTokens(usage?.tokensIn);
  total.tokensOut += saneTokens(usage?.tokensOut);
  total.cacheHits += saneTokens(usage?.cacheHits);
}

function freezeUsage(usage: MutableUsage): ChatEditUsageTotals {
  return Object.freeze({ ...usage });
}

// ---------------------------------------------------------------------------
// Failure builders (typed envelopes; no provider/user content leaks)
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function failure(
  code: ChatEditErrorCode,
  message: string,
  hint: string,
  retryable: boolean,
  attempts: number,
  usage: MutableUsage,
  issues: readonly string[] = [],
  rawExcerpt = "",
): ChatEditFailure {
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
// ChatEditClassifier
// ---------------------------------------------------------------------------

/**
 * The §23.5 chat-edit classifier: prompts the injected quick-tier model,
 * validates the raw output (fence-tolerant JSON → strict §23.5 schema →
 * deterministic post-rules), applies the cheapest-action tier guard, and
 * emits a §5.5 mini plan + the tier's credit price for the executor. Exactly
 * ONE retry on invalid output (§5.1), with the issues attached.
 */
export class ChatEditClassifier {
  private readonly model: ClassifierModelLike;

  constructor(model: ClassifierModelLike) {
    this.model = model;
  }

  async classify(input: ChatEditClassifyInput): Promise<ChatEditResult> {
    if (input.signal?.aborted) {
      return failure(
        "run_timeout",
        "The classifier call was aborted before the edit was classified (§3.4 run timeout or cancellation).",
        "The run loop owns the §5.2 wall-clock deadline; no engine command ran.",
        false,
        0,
        emptyUsage(),
      );
    }

    const parsed = chatEditInputSchema.safeParse(input);
    if (!parsed.success) {
      // Worker wiring bug → fail fast (planner precedent) with field PATHS
      // only — the user request is user content and never echoes (§15.3).
      const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
      throw new Error(`[agent/classifier] invalid classifier input (worker wiring): ${paths}`);
    }
    const layerNames = new Set(parsed.data.layerSummary.map((row) => row.name));
    const context: ChatEditRuleContext = {
      layerNames,
      components: parsed.data.catalog.components ?? [],
    };

    const usage = emptyUsage();
    let prompt = buildChatEditPrompt(parsed.data);
    const maxAttempts = 1 + PLAN_RETRY_LIMIT; // §5.1: one retry
    let issues: readonly string[] = [];
    let rawExcerpt = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let completion: ClassifierModelCompletion;
      try {
        completion = await this.model.complete(prompt, input.signal);
      } catch (error) {
        if (isAbortError(error)) {
          return failure(
            "run_timeout",
            "The classifier call was aborted before the edit was classified (§3.4 run timeout or cancellation).",
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
          "The classifier model call failed (§5.3 provider seam).",
          "The worker's §5.3 router owns retries/failover; re-run once the provider recovers.",
          true,
          attempt,
          usage,
        );
      }
      accumulateUsage(usage, completion.usage);
      rawExcerpt = rawExcerptOf(completion.text);

      const extraction = extractChatEditJson(completion.text);
      const schema = extraction.ok
        ? chatEditClassificationSchema.safeParse(extraction.json)
        : undefined;
      const classification = schema?.success ? schema.data : undefined;
      const atoms =
        classification !== undefined ? parseActionExpr(classification.action) : undefined;
      const rules =
        classification !== undefined && atoms !== undefined && atoms.ok
          ? enforceChatEditRules(atoms.atoms, classification, context)
          : undefined;
      issues = [
        ...(extraction.ok ? [] : [extraction.issue]),
        ...(schema !== undefined && !schema.success
          ? formatClassificationIssues(schema.error)
          : []),
        ...(atoms !== undefined && !atoms.ok ? [atoms.issue] : []),
        ...(rules !== undefined ? rules.issues : []),
      ];

      if (
        classification !== undefined &&
        atoms !== undefined &&
        atoms.ok &&
        rules !== undefined &&
        issues.length === 0
      ) {
        return this.succeed(classification, atoms.atoms, rules, usage, attempt);
      }
      if (attempt < maxAttempts) {
        // §5.1: exactly one retry, with the validation issues attached.
        prompt = buildChatEditRetryPrompt(prompt, issues);
      }
    }

    return failure(
      CHAT_EDIT_INVALID_CODE,
      `The chat-edit classifier did not return a valid classification after ${maxAttempts} attempt(s) (§5.1: one retry with the validation issues attached).`,
      "The validation issues are attached for the run timeline; a clearer edit request may fix it.",
      false,
      maxAttempts,
      usage,
      issues,
      rawExcerpt,
    );
  }

  /** Deterministic post-resolution: tier guard + step assembly + mini plan. */
  private succeed(
    classification: ChatEditClassification,
    atoms: readonly ChatEditAction[],
    rules: ChatEditRuleOutcome,
    usage: MutableUsage,
    attempt: number,
  ): ChatEditResult {
    const tier = resolveCostTier({
      atoms,
      targetCount: classification.target_layers.length,
      needsTemplateReapply: classification.needs_template_reapply,
      proposed: classification.cost_tier,
    });
    const stepPlan = buildChatEditSteps(classification, atoms, rules.clarify);
    const mini = buildChatEditMiniPlan({
      classification,
      atoms,
      steps: stepPlan.steps,
      tier: tier.resolved,
      clarify: rules.clarify,
    });
    if (!mini.ok) {
      // Deterministic assembly over an already-valid classification — a
      // §5.5 failure here is internal drift, not a model error; retrying
      // cannot change it. Fail clear, never leak args (§15.3).
      return failure(
        CHAT_EDIT_INVALID_CODE,
        "The chat-edit mini plan failed the §5.5 schema after a valid classification.",
        "Internal drift between the classifier step assembly and plan.ts — check steps/model_tier contract.",
        false,
        attempt,
        usage,
        mini.issues,
      );
    }
    return {
      ok: true,
      classification,
      actions: atoms,
      proposedTier: tier.proposed,
      costTier: tier.resolved,
      credits: tier.credits,
      needsTemplateReapply: classification.needs_template_reapply,
      warnings: [...rules.warnings, ...tier.warnings, ...stepPlan.warnings],
      plan: mini.plan,
      clarify: rules.clarify,
      attempts: attempt,
      usage: freezeUsage(usage),
    };
  }
}
