// @studio/gateway — the SERVER-SIDE PLAN COMPILER (BUILD_PLAN §M5 tasks 1-2,
// PRODUCT_ARCHITECTURE.md §8.5–§8.7, docs/phases/M5-SEAMS.md pinned seam,
// DECISIONS.md D-1: model loop ≤ 8 steps, plan ≤ 20 steps, compiled batch ≤
// 100 commands / 2 MB / 60 s).
//
// Mission (laws #5 + #6): the model proposes an EditPlan built from CURATED
// write-tool args; this module is the only thing that turns a plan into an
// engine `AgentBatch`. The per-step `batch` fields the model proposes are
// validated and ADVISORY ONLY — the compiled batch always comes from tool
// args translated against the curated command registry (deps.registry). One
// plan ⇒ ONE atomic batch ⇒ ONE undo step ⇒ ONE version (§8.4/§8.5).
//
// Tool → command translation table (every id verified against the real
// EffectCraft source at editor/crates/engine/src/commands/*.rs):
//
//   create_composition → comp.new {name, width, height, frameRate,
//                                  duration: args.durationSeconds}
//   create_text        → layer.newText {text, name?, position?,
//                                  size: fontSize?, font: fontFamily?,
//                                  fill: color?, comp: compId?}
//   set_properties     → prop.set × update {layer, path, value}
//   set_keyframes      → prop.addKey × keyframe {layer, path: propertyPath,
//                                  time, value}
//   add_effect         → effect.apply {effect, layers: [layer]}
//   apply_preset       → anim.applyBuiltinPreset {preset, layers: targets}
//   undo_run           → edit.undo {}
//   save_version       → NO engine command — a compile-time annotation
//                        (result.saveVersion) consumed by the apply flow.
//
// Ambiguity rulings (documented for the integrator — see the M5-B worklog):
//   * apply_preset NEVER compiles to `anim.applyPreset`: that command takes a
//     filesystem `path` (or an inline preset OBJECT), and a model-supplied
//     path breaks law #5 ("the model never sees filesystem paths"). Path-like
//     preset strings emit a `warn` and compile as builtin preset names.
//   * add_effect `params` and set_keyframes `easing` are CLIENT STATE (the
//     effect instance index and keyframe interpolation live in the editor);
//     they cannot be compiled server-side without guessing ids. They emit
//     `warn` issues instead of being silently dropped or fabricated.
//   * Layer references stay NAME strings in the compiled batch (the engine
//     accepts id|name|#n); `placeholders` + `resolutionRequests` let the
//     client (M5-F) substitute resolved ids before Apply. The compiler NEVER
//     fabricates ids; an injected `layerResolver` may substitute real ones.
//   * SEAMS names the request field `disambiguation` (the brief said
//     `candidates` — SEAMS wins per its own precedence rule). It carries the
//     plan's own `change` strings for that layer name.
//   * Risk and credits are RECOMPUTED from the compiled commands (never the
//     model's numbers). "High" is currently unreachable via the curated
//     tools (they compile to additive/property commands only) — it becomes
//     reachable when the registry widens past the eight write tools.
//
// Purity: idempotent, deterministic, no IO, no clocks (law #1: the result is
// a typed envelope and compilePlan NEVER throws, even on hostile input).

import {
  AGENT_COMMAND_REGISTRY,
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  estimateCredits,
  type AgentBatch,
  type BatchStep,
  checkBatchCommands,
  type CommandSchema,
  MAX_BATCH_BYTES,
  MAX_BATCH_LABEL_LENGTH,
  MAX_BATCH_STEPS,
  MAX_PLAN_AFFECTED_LAYERS,
  type PlanRisk,
  PLAN_RISK_ORDER,
  validateBatchRefs,
  WRITE_TOOL_ARGS_SCHEMAS,
} from "@studio/contracts";
import type { ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Pinned seam types (M5-SEAMS.md) + additive fields
// ---------------------------------------------------------------------------

/** Compile failures never throw; they are typed issues. Fatals abort the
 * compile (repair turn per §8.9); warns surface on the ok result. */
export type PlanIssueSeverity = "fatal" | "warn";

export type PlanIssueCode =
  | "plan_schema" // EditPlan failed its §8.6 schema (defense-in-depth re-check)
  | "plan_too_large" // serialized plan over the internal pre-flight cap
  | "internal" // unexpected failure — never leaks details (law #1)
  | "unknown_tool" // step.tool is not one of the 8 write tools
  | "invalid_args" // args failed the tool's Zod schema (§8.9 repair turn)
  | "unusable_args" // typed-but-unusable field under a weak (stub) schema
  | "empty_step" // the step translated to zero commands
  | "empty_batch" // the whole plan translated to zero commands
  | "too_many_commands" // compiled batch over the 100-step cap
  | "batch_too_large" // compiled batch over the 2 MB cap
  | "too_many_layer_names" // unique layer names over the 50 cap
  | "unknown_command" // compiled: fatal / proposed: warn
  | "missing_required_param" // compiled: fatal / proposed: warn
  | "unresolvable_ref" // $N.key forward/self/out-of-range (§8.5)
  | "batch_mismatch" // the model's proposed batch disagrees with the translation
  | "uncompilable_arg" // client-state arg (effect params, easing, preset paths)
  | "undo_run_target" // undo_run named a run; the engine reverts the latest batch
  | "duplicate_save_version" // an earlier save_version step was superseded
  | "undeclared_layer" // a referenced layer is missing from affectedLayers
  | "resolver_error"; // an injected layerResolver threw (treated as unresolved)

/** One compile problem: severity, stable code, human-safe message (law #1:
 * no stack traces, no internal ids, clipped length) and typed pointers. */
export interface PlanIssue {
  readonly severity: PlanIssueSeverity;
  readonly code: PlanIssueCode;
  readonly message: string;
  /** 1-based PLAN step the issue belongs to (when applicable). */
  readonly step?: number;
  /** 1-based COMPILED batch step (registry/refs issues on the compiled batch). */
  readonly batchStep?: number;
  readonly tool?: string;
  readonly command?: string;
  readonly param?: string;
}

/** A layer NAME the plan touches, for the client (M5-F) to resolve to ids via
 * the bridge (list_layers) before Apply — ids never enter the model context
 * (§8.7). `disambiguation` carries the plan's own `change` descriptions. */
export interface LayerResolutionRequest {
  readonly requestId: string;
  readonly layerName: string;
  readonly disambiguation: readonly string[];
}

/** One NAME occurrence inside the compiled batch the client may rewrite to a
 * resolved id. `param` is the object path within the step's params. */
export interface BatchPlaceholder {
  /** 1-based compiled batch step. */
  readonly step: number;
  readonly param: string;
  readonly layerName: string;
  /** Matches a LayerResolutionRequest — absent when already substituted. */
  readonly requestId?: string;
  /** Set when deps.layerResolver resolved the name server-side. */
  readonly resolvedId?: string | number;
}

/** Save-version annotation consumed by the apply flow (no engine command). */
export interface SaveVersionAnnotation {
  readonly label?: string;
}

/** Resolves a layer NAME to a real id (authoritative callers only — the
 * compiler never fabricates ids). Throwing resolvers are contained. */
export type LayerResolver = (layerName: string) => string | number | undefined;

/** Tolerant write-tool entry: the M5-A seam may inject bare Zod schemas
 * (WRITE_TOOL_ARGS_SCHEMAS) or richer defs with risk metadata (WRITE_TOOLS). */
export interface WriteToolDef {
  readonly args?: ZodTypeAny;
  readonly risk?: PlanRisk;
}

export type WriteToolsDep = Readonly<Record<string, ZodTypeAny | WriteToolDef>>;

/** Injected so compilation can be tested against fixtures while M5-A/M5-J
 * land (their stubs are intentionally empty/passthrough today). */
export interface CompileDeps {
  /** Curated agent command allowlist (M5-J) — id → descriptor. */
  readonly registry: CommandSchema;
  /** The 8 write tools (M5-A) — Zod args schemas (± risk metadata). */
  readonly writeTools: WriteToolsDep;
  /** Optional authoritative name → id resolver (see LayerResolver). */
  readonly layerResolver?: LayerResolver;
}

/** SEAMS input shape ({plan} + future resolution context). compilePlan also
 * accepts a bare EditPlan for convenience — both are normalized. */
export interface CompilePlanInput {
  readonly plan: EditPlan;
}

/** Compile outcome (M5-SEAMS pinned, plus additive fields the brief pins:
 * placeholders, warnings, saveVersion). */
export type CompilePlanResult =
  | {
      readonly ok: true;
      readonly batch: AgentBatch;
      readonly risk: PlanRisk;
      readonly estimatedCredits: number;
      readonly resolutionRequests: readonly LayerResolutionRequest[];
      /** Where layer NAME strings sit in the batch (M5-F rewrite sites). */
      readonly placeholders: readonly BatchPlaceholder[];
      /** Non-fatal issues (typed, advisory — the compiled batch stands). */
      readonly warnings: readonly PlanIssue[];
      /** Present when the plan contains a save_version step. */
      readonly saveVersion?: SaveVersionAnnotation;
    }
  | {
      readonly ok: false;
      /** Fatal issues only (the repair-turn payload, §8.9). */
      readonly issues: readonly PlanIssue[];
    };

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Pre-flight serialized-plan cap. Generous multiple of the 2 MB batch cap:
 * proposed batches are discarded, so a plan may be far bigger than its
 * compiled batch — but not unboundedly so. */
const MAX_PLAN_BYTES = 8 * 1024 * 1024;

/** Cap on collected issues so hostile input cannot balloon the result. */
const MAX_ISSUES = 50;

/** Cap on any issue message (law #1 hygiene). */
const MAX_MESSAGE_LENGTH = 200;

const STUDIO_TOOL_PREFIX = "studio.";
const AGENT_LABEL_PREFIX = "Agent: ";

/** delete-ish ids (and effect.remove explicitly) force ≥ medium risk. */
const DELETE_ISH_COMMAND = /(?:^|\.)(?:delete|remove|purge)/;
/** render/export-ish ids force ≥ medium risk (none emitted by the 8 tools). */
const RENDER_ISH_COMMAND = /^(?:render|export)\./;
/** History commands revert project state — never "low" risk. */
const HISTORY_COMMANDS: ReadonlySet<string> = new Set(["edit.undo", "edit.redo"]);

/** A preset string that looks like a filesystem path (law #5 hazard). */
const PRESET_PATH_LIKE = /(?:[\\/]|\.ecpreset$)/;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clip(text: string, max = MAX_MESSAGE_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Own-property registry lookup — a "__proto__" command id must NOT resolve
 * through the prototype chain (M4-N F-1 defense, applied to the registry). */
function registryHas(registry: CommandSchema, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, id);
}

/** Deterministic, depth-capped canonical JSON (sorted object keys) used to
 * compare the model's proposed batch with the compiled translation. */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > 64) return '"<deep>"';
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : '"<nan>"';
    case "boolean":
    case "bigint":
      return String(value);
    default: {
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
      }
      if (typeof value !== "object") return '"<unserializable>"';
      const record = value as Record<string, unknown>;
      const body = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], depth + 1)}`)
        .join(",");
      return `{${body}}`;
    }
  }
}

function riskMax(a: PlanRisk, b: PlanRisk): PlanRisk {
  return PLAN_RISK_ORDER[a] >= PLAN_RISK_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Risk recompute (brief: from compiled commands — never the model's number)
// ---------------------------------------------------------------------------

/**
 * Recomputed plan risk from the COMPILED commands plus an optional tool-catalog
 * floor. delete-ish / effect.remove / render/export / edit.undo+redo ⇒ at
 * least medium; nothing of the sort ⇒ low. Exported for tests and future
 * registry widening.
 */
export function recomputePlanRisk(
  steps: ReadonlyArray<Pick<BatchStep, "command">>,
  toolFloor: PlanRisk = "low",
): PlanRisk {
  let risk: PlanRisk = "low";
  for (const step of steps) {
    const id = step.command;
    if (DELETE_ISH_COMMAND.test(id) || RENDER_ISH_COMMAND.test(id) || HISTORY_COMMANDS.has(id)) {
      risk = riskMax(risk, "medium");
    }
  }
  return riskMax(risk, toolFloor);
}

// ---------------------------------------------------------------------------
// Compilation state
// ---------------------------------------------------------------------------

interface LocalLayerSite {
  /** 0-based index within this plan step's own translation. */
  readonly localStep: number;
  readonly param: string;
  readonly layerName: string;
}

interface StepTranslation {
  readonly steps: BatchStep[];
  readonly sites: LocalLayerSite[];
}

interface NormalizedTool {
  readonly bareId: string;
  readonly argsSchema?: ZodTypeAny;
  readonly risk?: PlanRisk;
}

class Compiler {
  readonly warnings: PlanIssue[] = [];
  readonly fatals: PlanIssue[] = [];
  private readonly compiledSteps: BatchStep[] = [];
  private readonly sites: Array<LocalLayerSite & { planStep: number; globalStep: number }> = [];
  private readonly toolRisks: PlanRisk[] = [];
  private saveVersion: SaveVersionAnnotation | undefined;
  private saveVersionStep: number | undefined;

  constructor(private readonly depsRegistry: CommandSchema) {}

  private pushIssue(issue: PlanIssue): void {
    const target = issue.severity === "fatal" ? this.fatals : this.warnings;
    if (target.length >= MAX_ISSUES) return; // bounded, deterministic
    target.push(issue);
  }

  fatal(code: PlanIssueCode, message: string, extra?: Omit<PlanIssue, "severity" | "code" | "message">): void {
    this.pushIssue({ severity: "fatal", code, message: clip(message), ...extra });
  }

  warn(code: PlanIssueCode, message: string, extra?: Omit<PlanIssue, "severity" | "code" | "message">): void {
    this.pushIssue({ severity: "warn", code, message: clip(message), ...extra });
  }

  /** Translate one plan step's curated args into registry command steps. */
  translate(planStep: number, tool: string, args: unknown): StepTranslation {
    const steps: BatchStep[] = [];
    const sites: LocalLayerSite[] = [];
    const argsObj: Record<string, unknown> = isPlainObject(args) ? args : {};
    const add = (command: string, params: Record<string, unknown>): void => {
      steps.push({ command, params });
    };
    const addSite = (param: string, layerName: string): void => {
      sites.push({ localStep: steps.length - 1, param, layerName });
    };
    const unusable = (field: string, why: string): void => {
      this.warn("unusable_args", `field \`${field}\` ${why}`, { step: planStep, tool });
    };
    const compilesToNothing = (): void => {
      this.warn("empty_step", "step compiled to no engine commands", { step: planStep, tool });
    };

    switch (tool) {
      case "create_composition": {
        const params: Record<string, unknown> = {};
        const name = readString(argsObj, "name");
        if (name !== undefined) params.name = name;
        for (const key of ["width", "height", "frameRate"] as const) {
          const value = argsObj[key];
          if (isFiniteNumber(value)) params[key] = value;
          else if (value !== undefined) unusable(key, "is not a finite number");
        }
        const duration = argsObj.durationSeconds;
        if (isFiniteNumber(duration)) params.duration = duration;
        else if (duration !== undefined) unusable("durationSeconds", "is not a finite number");
        if (Object.keys(params).length === 0) {
          compilesToNothing();
          break;
        }
        add("comp.new", params);
        break;
      }

      case "create_text": {
        const params: Record<string, unknown> = {};
        const text = readString(argsObj, "text");
        if (text !== undefined) params.text = text;
        else if ("text" in argsObj) unusable("text", "is not a non-empty string");
        const name = readString(argsObj, "name");
        if (name !== undefined) params.name = name;
        const compId = readString(argsObj, "compId");
        if (compId !== undefined) params.comp = compId;
        const fontSize = argsObj.fontSize;
        if (isFiniteNumber(fontSize)) params.size = fontSize;
        else if (fontSize !== undefined) unusable("fontSize", "is not a finite number");
        const fontFamily = readString(argsObj, "fontFamily");
        if (fontFamily !== undefined) params.font = fontFamily;
        const color = readString(argsObj, "color");
        if (color !== undefined) params.fill = color;
        const position = argsObj.position;
        if (position !== undefined) {
          const [x, y] = Array.isArray(position) ? position : [];
          if (isFiniteNumber(x) && isFiniteNumber(y)) {
            params.position = [x, y];
          } else {
            unusable("position", "is not a [x, y] number pair");
          }
        }
        if (Object.keys(params).length === 0) {
          compilesToNothing();
          break;
        }
        add("layer.newText", params);
        break;
      }

      case "set_properties": {
        const updates = argsObj.updates;
        if (!Array.isArray(updates)) {
          unusable("updates", "is not an array");
          break;
        }
        for (const update of updates) {
          if (!isPlainObject(update)) {
            unusable("updates", "contains a non-object entry (skipped)");
            continue;
          }
          const layer = readString(update, "layer");
          if (layer === undefined) {
            // Without a layer the engine falls back to the EDITOR SELECTION —
            // a wrong-target hazard; never compile that (skip + warn).
            unusable("updates", "entry has no layer; it would target the editor selection (skipped)");
            continue;
          }
          const params: Record<string, unknown> = { layer };
          const path = readString(update, "path");
          if (path !== undefined) params.path = path;
          if ("value" in update) params.value = update.value;
          add("prop.set", params);
          addSite("layer", layer);
        }
        if (steps.length === 0 && updates.length > 0) compilesToNothing();
        break;
      }

      case "set_keyframes": {
        const layer = readString(argsObj, "layer");
        const keyframes = argsObj.keyframes;
        if (layer === undefined) {
          // Selection-capture hazard, same rationale as set_properties.
          unusable("layer", "is missing; keyframes would target the editor selection");
          break;
        }
        if (!Array.isArray(keyframes)) {
          unusable("keyframes", "is not an array");
          break;
        }
        const propertyPath = readString(argsObj, "propertyPath");
        for (const keyframe of keyframes) {
          if (!isPlainObject(keyframe)) {
            unusable("keyframes", "contains a non-object entry (skipped)");
            continue;
          }
          const params: Record<string, unknown> = { layer };
          if (propertyPath !== undefined) params.path = propertyPath;
          const time = keyframe.time;
          if (isFiniteNumber(time)) params.time = time;
          else if (time !== undefined) unusable("keyframes", "entry time is not a finite number");
          if ("value" in keyframe) params.value = keyframe.value;
          const easing = readString(keyframe, "easing");
          if (easing !== undefined && easing !== "linear") {
            this.warn(
              "uncompilable_arg",
              `easing \`${clip(easing, 24)}\` is editor-side keyframe interpolation; the ` +
                "keyframe compiles with the engine default (set it via the timeline after apply)",
              { step: planStep, tool, param: "easing" },
            );
          }
          add("prop.addKey", params);
          addSite("layer", layer);
        }
        if (steps.length === 0 && keyframes.length > 0) compilesToNothing();
        break;
      }

      case "add_effect": {
        const layer = readString(argsObj, "layer");
        const effect = readString(argsObj, "effect");
        if (layer === undefined) {
          unusable("layer", "is missing; the effect would target the editor selection");
          break;
        }
        const params: Record<string, unknown> = { layers: [layer] };
        if (effect !== undefined) params.effect = effect;
        add("effect.apply", params);
        addSite("layers[0]", layer);
        const effectParams = argsObj.params;
        if (effectParams !== undefined) {
          if (isPlainObject(effectParams)) {
            for (const key of Object.keys(effectParams).sort()) {
              this.warn(
                "uncompilable_arg",
                `effect parameter \`${clip(key, 40)}\` cannot be compiled server-side (the ` +
                  "effect instance index is editor state); set it via set_properties after apply",
                { step: planStep, tool, param: key },
              );
            }
          } else {
            unusable("params", "is not an object");
          }
        }
        break;
      }

      case "apply_preset": {
        const targets = argsObj.targets;
        if (!Array.isArray(targets)) {
          unusable("targets", "is not an array");
          break;
        }
        const names: string[] = [];
        for (const target of targets) {
          if (typeof target === "string" && target.length > 0) names.push(target);
          else unusable("targets", "contains a non-string entry (skipped)");
        }
        if (names.length === 0) {
          compilesToNothing();
          break;
        }
        const preset = readString(argsObj, "preset");
        if (preset !== undefined && PRESET_PATH_LIKE.test(preset)) {
          this.warn(
            "uncompilable_arg",
            "preset looks like a filesystem path; paths are never agent-compilable " +
              "(compiled as a builtin preset name)",
            { step: planStep, tool, param: "preset" },
          );
        }
        const params: Record<string, unknown> = { layers: names };
        if (preset !== undefined) params.preset = preset;
        add("anim.applyBuiltinPreset", params);
        names.forEach((name, index) => addSite(`layers[${index}]`, name));
        break;
      }

      case "undo_run": {
        add("edit.undo", {});
        if ("runId" in argsObj) {
          this.warn(
            "undo_run_target",
            "undo_run named a specific run; the engine command reverts the most recently " +
              "applied batch — the gateway checks run ordering at undo time",
            { step: planStep, tool },
          );
        }
        break;
      }

      case "save_version": {
        const rawLabel = argsObj.label;
        const label = typeof rawLabel === "string" ? rawLabel : undefined;
        if (this.saveVersion !== undefined && this.saveVersionStep !== undefined) {
          this.warn("duplicate_save_version", "an earlier save_version step was superseded (the last labels the version)", {
            step: this.saveVersionStep,
            tool,
          });
        }
        this.saveVersion = label !== undefined ? { label } : {};
        this.saveVersionStep = planStep;
        break;
      }

      default: {
        // Exhaustiveness guard — lookupWriteTool already rejected unknown ids.
        this.fatal("unknown_tool", `tool \`${clip(tool, 64)}\` is not a write tool`, { step: planStep, tool });
        break;
      }
    }

    return { steps, sites };
  }

  /** Validate the model's PROPOSED batch for one step (advisory — warn only:
   * the compiled translation wins, law #5). */
  validateProposed(
    planStep: number,
    tool: string,
    proposed: readonly BatchStep[],
    translated: readonly BatchStep[],
  ): void {
    // Own-property allowlist scan — a "__proto__" id must not resolve through
    // the prototype chain (SEAMS: "never invent a command id").
    for (const [index, step] of proposed.entries()) {
      if (!registryHas(this.depsRegistry, step.command)) {
        this.warn("unknown_command", `proposed command \`${clip(step.command, 64)}\` is not in the agent registry`, {
          step: planStep,
          tool,
          command: step.command,
          batchStep: index + 1,
        });
      }
    }
    // Required params for the KNOWN proposed commands (reuse the contracts
    // helper; unknown-command duplicates were handled above).
    for (const issue of checkBatchCommands({ steps: [...proposed] }, this.depsRegistry)) {
      if (issue.reason !== "missing_required_param") continue;
      this.warn("missing_required_param", `proposed \`${issue.command}\` is missing required param \`${issue.param}\``, {
        step: planStep,
        tool,
        command: issue.command,
        batchStep: issue.step,
        param: issue.param,
      });
    }
    // Backwards-only $N.key refs (§8.5) within the proposed batch's own
    // 1-based numbering.
    for (const issue of validateBatchRefs(proposed)) {
      this.warn("unresolvable_ref", `proposed batch has $-reference \`${issue.ref.raw}\` (${issue.reason})`, {
        step: planStep,
        tool,
        batchStep: issue.step,
      });
    }
    // Disagreement: the compiled translation wins — warn, never merge.
    const agrees =
      proposed.length === translated.length &&
      proposed.every(
        (step, index) =>
          step.command === translated[index]?.command &&
          stableStringify(step.params) === stableStringify(translated[index]?.params),
      );
    if (!agrees) {
      this.warn("batch_mismatch", "the model's proposed batch disagrees with the compiled translation; the translation stands", {
        step: planStep,
        tool,
      });
    }
  }

  /** Merge one plan step's translation into the single atomic batch. */
  merge(planStep: number, translation: StepTranslation, toolRisk: PlanRisk | undefined): void {
    const base = this.compiledSteps.length;
    for (const step of translation.steps) this.compiledSteps.push(step);
    for (const site of translation.sites) {
      this.sites.push({ ...site, planStep, globalStep: base + site.localStep });
    }
    this.toolRisks.push(toolRisk ?? "low");
  }

  steps(): readonly BatchStep[] {
    return this.compiledSteps;
  }

  layerSites(): ReadonlyArray<LocalLayerSite & { planStep: number; globalStep: number }> {
    return this.sites;
  }

  toolRiskFloor(): PlanRisk {
    return this.toolRisks.reduce<PlanRisk>((floor, risk) => riskMax(floor, risk), "low");
  }

  annotation(): SaveVersionAnnotation | undefined {
    return this.saveVersion;
  }
}

// ---------------------------------------------------------------------------
// Deps lookups
// ---------------------------------------------------------------------------

/** The M5-A seam may key tools by bare id (`create_text`) or with the
 * `studio.` prefix — and the plan may use either form too. Deterministic
 * candidate order, own-property lookup only. */
function lookupWriteTool(deps: CompileDeps, tool: string): NormalizedTool | undefined {
  const bare = tool.startsWith(STUDIO_TOOL_PREFIX) ? tool.slice(STUDIO_TOOL_PREFIX.length) : tool;
  for (const candidate of [bare, `${STUDIO_TOOL_PREFIX}${bare}`, tool]) {
    if (!Object.prototype.hasOwnProperty.call(deps.writeTools, candidate)) continue;
    const entry = deps.writeTools[candidate];
    if (entry !== null && typeof entry === "object" && "safeParse" in entry && typeof entry.safeParse === "function") {
      return { bareId: bare, argsSchema: entry as ZodTypeAny };
    }
    if (isPlainObject(entry)) {
      const def = entry as Record<string, unknown>;
      const args = def.args;
      const risk = def.risk;
      return {
        bareId: bare,
        argsSchema:
          args !== null &&
          typeof args === "object" &&
          "safeParse" in args &&
          typeof (args as ZodTypeAny).safeParse === "function"
            ? (args as ZodTypeAny)
            : undefined,
        risk: risk === "low" || risk === "medium" || risk === "high" ? risk : undefined,
      };
    }
  }
  return undefined;
}

/** Write `value` at a `layer`/`layers[i]`-style path inside a params object. */
function applyParamPath(params: Record<string, unknown>, path: string, value: string | number): void {
  const match = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(path);
  if (match === null) return;
  const key = match[1];
  if (key === undefined) return;
  const indexText = match[2];
  if (indexText === undefined) {
    params[key] = value;
    return;
  }
  const list = params[key];
  if (Array.isArray(list)) {
    const index = Number.parseInt(indexText, 10);
    if (index >= 0 && index < list.length) list[index] = value;
  }
}

function isCompileInput(value: unknown): value is CompilePlanInput {
  return isPlainObject(value) && "plan" in value && isPlainObject(value.plan);
}

// ---------------------------------------------------------------------------
// Main entry (SEAMS: typed, never throws)
// ---------------------------------------------------------------------------

function compilePlanInner(plan: unknown, deps: CompileDeps): CompilePlanResult {
  const compiler = new Compiler(deps.registry);

  // -- 0. pre-flight: the plan must serialize (cycle-hostile) and be sane.
  let serializedPlan: string;
  try {
    serializedPlan = JSON.stringify(plan) ?? "null";
  } catch {
    compiler.fatal("plan_too_large", "the plan is not serializable JSON");
    return { ok: false, issues: compiler.fatals };
  }
  if (serializedPlan.length > MAX_PLAN_BYTES) {
    compiler.fatal("plan_too_large", `the plan is too large to compile (${serializedPlan.length} bytes)`);
    return { ok: false, issues: compiler.fatals };
  }

  // -- 1. defense-in-depth re-validation against the §8.6 schema (the runner
  // validates first; hostile direct calls stop here).
  const parsed = EDIT_PLAN_SCHEMA.safeParse(plan);
  if (!parsed.success) {
    const messages = parsed.error.issues.slice(0, 5).map((issue) => issue.message);
    compiler.fatal("plan_schema", `the plan failed its schema: ${messages.join("; ") || "invalid shape"}`);
    return { ok: false, issues: compiler.fatals };
  }
  const editPlan = parsed.data;

  // -- 2. per-step: allowlist the tool, validate args, translate, validate
  // the proposed batch (warns only — the translation wins, law #5).
  for (const [index, planStep] of editPlan.steps.entries()) {
    const position = index + 1;
    if (typeof planStep.tool !== "string" || planStep.tool.length === 0) {
      compiler.fatal("unknown_tool", `step ${position} has no tool`, { step: position });
      continue;
    }
    const tool = lookupWriteTool(deps, planStep.tool);
    if (tool === undefined) {
      compiler.fatal("unknown_tool", `tool \`${clip(planStep.tool, 64)}\` is not one of the 8 write tools`, {
        step: position,
        tool: planStep.tool,
      });
      continue;
    }

    if (tool.argsSchema !== undefined) {
      let argsOk = true;
      let argsMessage = "";
      try {
        const safe = tool.argsSchema.safeParse(planStep.args);
        if (!safe.success) {
          argsOk = false;
          argsMessage = safe.error.issues
            .slice(0, 5)
            .map((issue) => issue.message)
            .join("; ");
        }
      } catch {
        argsOk = false;
        argsMessage = "args could not be validated";
      }
      if (!argsOk) {
        compiler.fatal("invalid_args", `args for \`${tool.bareId}\` failed validation: ${argsMessage}`, {
          step: position,
          tool: tool.bareId,
        });
        continue;
      }
    }

    const translation = compiler.translate(position, tool.bareId, planStep.args);
    compiler.validateProposed(position, tool.bareId, planStep.batch.steps, translation.steps);
    compiler.merge(position, translation, tool.risk);
  }
  if (compiler.fatals.length > 0) {
    return { ok: false, issues: compiler.fatals };
  }

  // -- 3. bounds + registry gate on the COMPILED batch (violations are fatal).
  const steps: BatchStep[] = [...compiler.steps()];
  if (steps.length === 0) {
    compiler.fatal("empty_batch", "the plan compiles to an empty command batch (only annotation steps)");
    return { ok: false, issues: compiler.fatals };
  }
  if (steps.length > MAX_BATCH_STEPS) {
    compiler.fatal("too_many_commands", `the compiled batch has ${steps.length} commands (max ${MAX_BATCH_STEPS})`);
    return { ok: false, issues: compiler.fatals };
  }
  for (const issue of checkBatchCommands({ steps }, deps.registry)) {
    if (issue.reason === "unknown_command") {
      compiler.fatal("unknown_command", `compiled command \`${issue.command}\` is not in the agent registry`, {
        batchStep: issue.step,
        command: issue.command,
      });
    } else {
      compiler.fatal("missing_required_param", `\`${issue.command}\` is missing required param \`${issue.param}\``, {
        batchStep: issue.step,
        command: issue.command,
        param: issue.param,
      });
    }
  }
  // The compiled batch is name-based by construction — refs are validated as
  // defense-in-depth anyway (§8.5 backwards-only $N.key).
  for (const issue of validateBatchRefs(steps)) {
    compiler.fatal("unresolvable_ref", `compiled batch has $-reference \`${issue.ref.raw}\` (${issue.reason})`, {
      batchStep: issue.step,
    });
  }
  if (compiler.fatals.length > 0) {
    return { ok: false, issues: compiler.fatals };
  }

  // -- 4. layer-name resolution: requests + placeholders (names stay names in
  // the batch; the client substitutes ids via the bridge — §8.7).
  const declaredNames: string[] = [];
  const disambiguation = new Map<string, string[]>();
  for (const layer of editPlan.affectedLayers) {
    if (typeof layer.name !== "string" || layer.name.length === 0) continue;
    if (!declaredNames.includes(layer.name)) declaredNames.push(layer.name);
    const notes = disambiguation.get(layer.name) ?? [];
    if (!notes.includes(layer.change)) notes.push(layer.change);
    disambiguation.set(layer.name, notes);
  }
  const uniqueNames = [...declaredNames];
  for (const site of compiler.layerSites()) {
    if (!uniqueNames.includes(site.layerName)) uniqueNames.push(site.layerName);
  }
  if (uniqueNames.length > MAX_PLAN_AFFECTED_LAYERS) {
    compiler.fatal(
      "too_many_layer_names",
      `the plan references ${uniqueNames.length} distinct layer names (max ${MAX_PLAN_AFFECTED_LAYERS})`,
    );
    return { ok: false, issues: compiler.fatals };
  }

  const warnedUndeclared = new Set<string>();
  for (const site of compiler.layerSites()) {
    if (declaredNames.includes(site.layerName) || warnedUndeclared.has(site.layerName)) continue;
    warnedUndeclared.add(site.layerName);
    compiler.warn("undeclared_layer", `layer \`${clip(site.layerName, 64)}\` is used by a step but not declared in the plan`, {
      step: site.planStep,
    });
  }

  const resolved = new Map<string, string | number>();
  if (deps.layerResolver !== undefined) {
    for (const name of uniqueNames) {
      try {
        const id = deps.layerResolver(name);
        if (id !== undefined) resolved.set(name, id);
      } catch {
        compiler.warn("resolver_error", "the layer resolver failed; the layer name stays in the batch");
      }
    }
  }

  const requests: LayerResolutionRequest[] = [];
  const requestIdByName = new Map<string, string>();
  let requestIndex = 0;
  for (const name of uniqueNames) {
    if (resolved.has(name)) continue; // substituted server-side — no request
    requestIndex += 1;
    const requestId = `lr-${requestIndex}`;
    requestIdByName.set(name, requestId);
    requests.push({ requestId, layerName: name, disambiguation: disambiguation.get(name) ?? [] });
  }

  const placeholders: BatchPlaceholder[] = [];
  for (const site of compiler.layerSites()) {
    const resolvedId = resolved.get(site.layerName);
    if (resolvedId !== undefined) {
      // Substitute the authoritative id (resolver-provided, never fabricated).
      const step = steps[site.globalStep];
      if (step !== undefined) applyParamPath(step.params, site.param, resolvedId);
      placeholders.push({ step: site.globalStep + 1, param: site.param, layerName: site.layerName, resolvedId });
      continue;
    }
    placeholders.push({
      step: site.globalStep + 1,
      param: site.param,
      layerName: site.layerName,
      requestId: requestIdByName.get(site.layerName),
    });
  }

  // -- 5. assemble the ONE atomic batch (§8.4/§8.5: "Agent: <summary>").
  const label = `${AGENT_LABEL_PREFIX}${clip(editPlan.summary, MAX_BATCH_LABEL_LENGTH - AGENT_LABEL_PREFIX.length)}`;
  const batch: AgentBatch = { label, atomic: true, steps };

  const serializedBatch = JSON.stringify(batch);
  if (serializedBatch !== undefined && serializedBatch.length > MAX_BATCH_BYTES) {
    compiler.fatal(
      "batch_too_large",
      `the compiled batch exceeds the ${MAX_BATCH_BYTES}-byte limit (${serializedBatch.length} bytes)`,
    );
    return { ok: false, issues: compiler.fatals };
  }

  // -- 6. risk + credits recomputed server-side (never the model's numbers).
  const risk = recomputePlanRisk(steps, compiler.toolRiskFloor());
  const estimatedCredits = estimateCredits({ risk, steps: editPlan.steps });

  // -- 7. dedupe advisory issues (unknown/param warns can double-report).
  const seen = new Set<string>();
  const warnings = compiler.warnings.filter((issue) => {
    const key = `${issue.code}|${issue.step ?? ""}|${issue.batchStep ?? ""}|${issue.command ?? ""}|${issue.param ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const base: CompilePlanResult = {
    ok: true,
    batch,
    risk,
    estimatedCredits,
    resolutionRequests: requests,
    placeholders,
    warnings,
  };
  const annotation = compiler.annotation();
  return annotation !== undefined ? { ...base, saveVersion: annotation } : base;
}

/**
 * Compile an EditPlan into ONE atomic AgentBatch (§8.5 bounds enforced), with
 * layer-name resolution requests, recomputed risk + credits, and typed issues.
 * Accepts a bare EditPlan or a SEAMS CompilePlanInput. NEVER throws (law #1).
 */
export function compilePlan(planOrInput: EditPlan | CompilePlanInput, deps: CompileDeps): CompilePlanResult {
  try {
    const plan = isCompileInput(planOrInput) ? planOrInput.plan : planOrInput;
    return compilePlanInner(plan, deps);
  } catch {
    // Absolute backstop: no stack traces, no details (law #1).
    return {
      ok: false,
      issues: [{ severity: "fatal", code: "internal", message: "plan compilation failed unexpectedly" }],
    };
  }
}

/**
 * Live deps from the M5-A/M5-J contract surfaces, read at CALL time (ESM live
 * bindings) so peer stubs landing mid-wave are picked up. With today's stubs
 * the registry is empty — every compiled command fails the allowlist — wire
 * the real flow only after M5-J lands, or inject a registry fixture.
 */
export function defaultCompileDeps(): CompileDeps {
  return { registry: AGENT_COMMAND_REGISTRY, writeTools: WRITE_TOOL_ARGS_SCHEMAS };
}
