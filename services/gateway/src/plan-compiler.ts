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
//   create_text        → layer.newText {text, name?, position?, box?, font?,
//                                  style?, size?, fill?, stroke?, strokeWidth?,
//                                  tracking?, leading?} — colors take BOTH
//                                  COLOR_SCHEMA forms (F-S1: a [r,g,b(,a)]
//                                  channel array compiles to the engine's
//                                  canonical #hex form, see engineColor)
//   set_properties     → prop.set × update {layer, path, value}
//                                  (path "name" → layer.rename, G-7/D-21)
//   set_keyframes      → prop.addKey × keyframe {layer, path: propertyPath,
//                                  time, value}
//   add_effect         → effect.apply {effect, layers: [layer]}
//   apply_preset       → anim.applyBuiltinPreset {preset, layers: targets}
//   undo_run           → edit.undo {}
//   save_version       → NO engine command — a compile-time annotation
//                        (result.saveVersion) consumed by the apply flow.
//
// Round-12 "Tool catalog v3" additions (propose-only, same ONE-batch law):
//   engine_commands    → VERBATIM {command, params} steps — every id must
//                        pass the ALLOWED engine catalog (contracts
//                        isAllowedEngineCommand; unknown/denied id ⇒ typed
//                        `command_not_allowed` fatal), 1..50 input steps,
//                        params ride unchanged (the engine validates params
//                        at execute time; the strict live schema bounds them
//                        to dunder-free JSON records)
//   run_script          → EXACTLY ONE {command: "script.run", params: {code}}
//                        CLIENT-SPECIAL step (the engine refuses script.run
//                        inside engine.batch — NOT_IN_BATCH; the client apply
//                        seam executes it via bridge.execute with ONE undo
//                        group) — gated by the static guard (no require(/
//                        fetch(/XMLHttpRequest/import(/eval( outside
//                        comments ⇒ typed `unsafe_script` fatal)
//   add_asset           → EXACTLY ONE {command: "asset.importSvg", params:
//                        {name, svg}} CLIENT-SPECIAL step (no direct engine
//                        id; the client apply seam imports the inline SVG) —
//                        svg must be <svg or <?xml markup (≤ 50 000 chars,
//                        external hrefs rejected ⇒ typed `invalid_svg` fatal)
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
//     model's numbers). "High" stays unreachable through the curated tools
//     AND the round-12 widening: engine_commands ids come from the ALLOWED
//     catalog (destructive/denied ids never compile), so the command floors
//     (delete-ish, render-ish, history) plus the medium tool-catalog floor
//     cap every compiled plan at medium — D-28: the reversible-command wall
//     (auto-apply.ts) is the actual safety.
//
// Purity: idempotent, deterministic, no IO, no clocks (law #1: the result is
// a typed envelope and compilePlan NEVER throws, even on hostile input).

import {
  AGENT_COMMAND_REGISTRY,
  type AgentBatch,
  type BatchStep,
  type CommandSchema,
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  MAX_BATCH_BYTES,
  MAX_BATCH_LABEL_LENGTH,
  MAX_BATCH_STEPS,
  MAX_ENGINE_COMMAND_STEPS,
  MAX_PLAN_AFFECTED_LAYERS,
  MAX_SCRIPT_CODE_LENGTH,
  MAX_SVG_LENGTH,
  PLAN_RISK_ORDER,
  type PlanRisk,
  WRITE_TOOLS,
  checkBatchCommands,
  estimateCredits,
  isAllowedEngineCommand,
  isReadEngineQuery,
  validateBatchRefs,
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
  | "unknown_tool" // step.tool is not one of the 11 write tools
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
  | "unit_normalized" // model wrote transform 0..1 fractions; compiled as percent
  | "undo_run_target" // undo_run named a run; the engine reverts the latest batch
  | "duplicate_save_version" // an earlier save_version step was superseded
  | "undeclared_layer" // a referenced layer is missing from affectedLayers
  | "resolver_error" // an injected layerResolver threw (treated as unresolved)
  | "command_not_allowed" // engine_commands step id is unknown or denied for agents
  | "unsafe_script" // run_script code hits the static guard outside comments
  | "invalid_svg"; // add_asset svg markup/size/external-href validation

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

/** Round-12 widening predicate: vouches for an engine command id as ALLOWED
 * for agents (the contracts catalog membership, isAllowedEngineCommand).
 * Injecting a custom one keeps hostile-args fixture tests deterministic;
 * a throwing predicate fails closed (compilePlan never throws — law #1). */
export type AllowedEngineCommandPredicate = (id: string) => boolean;

/** Tolerant write-tool entry: the M5-A seam may inject bare Zod schemas
 * (WRITE_TOOL_ARGS_SCHEMAS) or richer defs with risk metadata (WRITE_TOOLS). */
export interface WriteToolDef {
  readonly args?: ZodTypeAny;
  readonly risk?: PlanRisk;
}

export type WriteToolsDep = Readonly<Record<string, ZodTypeAny | WriteToolDef>>;

/** Injected so compilation can be tested against fixtures without the live
 * contract surfaces (both are real today: the curated command registry and
 * the write-tools catalog — see defaultCompileDeps). */
export interface CompileDeps {
  /** Curated agent command allowlist (M5-J) — id → descriptor. */
  readonly registry: CommandSchema;
  /** The 11 write tools (M5-A + round-12 v3) — Zod args schemas (± risk metadata). */
  readonly writeTools: WriteToolsDep;
  /** Optional authoritative name → id resolver (see LayerResolver). */
  readonly layerResolver?: LayerResolver;
  /** Round-12 widening seam: vouches for ALLOWED engine command ids compiled
   * from studio.engine_commands steps (the live wiring is the contracts
   * catalog membership, isAllowedEngineCommand — see defaultCompileDeps).
   * Absent ⇒ the contracts predicate stands in (fail-closed on throws). */
  readonly allowsEngineCommand?: AllowedEngineCommandPredicate;
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

/**
 * The engine's text-animator preset ids (crates/engine/presets/
 * text_animators.json via text_anim.rs PRESETS_JSON — the SAME list
 * layer.applyTextPreset's paramsDoc documents). These route to
 * layer.applyTextPreset, NOT anim.applyBuiltinPreset (whose library is
 * transitions + backgrounds only).
 */
const TEXT_ANIMATOR_PRESET_IDS: ReadonlySet<string> = new Set([
  "typewriter",
  "fadeUpCharacters",
  "bounceInWords",
  "trackingIn",
  "scramble",
  "blurIn",
  "jitter",
  "dropInLines",
]);

/** Bare leaf names the engine keeps under the `transform` group. */
const BARE_LEAF_PROPERTY_ALIASES: Readonly<Record<string, string>> = {
  opacity: "transform/opacity",
  scale: "transform/scale",
  position: "transform/position",
  rotation: "transform/rotation",
  anchor: "transform/anchor",
  // The text group (2026-11-01 Google-launch run: a compiled plan carried
  // prop.set path "sourceText" — the engine answered "no property
  // `sourceText`" and rolled the WHOLE batch back). Bare `text`,
  // `sourceText` and `source_text` all mean the text layer's content
  // property; the grouped form is the engine truth.
  text: "text/sourceText",
  sourcetext: "text/sourceText",
  source_text: "text/sourceText",
};

/**
 * Model property paths → engine paths (prop.rs groups).
 *
 * The engine addresses properties as slash GROUPS (`transform/opacity`,
 * `transform/scale`) while models emit AE style (`transform.scale`) or bare
 * leaf names (`opacity`), which the engine rejects ("no property
 * `opacity`"). Normalize: dots → slashes, and a bare leaf name gets its
 * canonical transform group. Grouped paths pass through untouched.
 */
function normalizePropertyPath(raw: string): string {
  const path = raw.trim().replace(/\./g, "/");
  if (path.includes("/")) return path;
  return BARE_LEAF_PROPERTY_ALIASES[path.toLowerCase()] ?? path;
}

/** CLIENT-SPECIAL compiled step ids (round-12): the two steps the engine
 * cannot take through engine.batch — `script.run` (NOT_IN_BATCH; the client
 * apply seam executes it via bridge.execute with ONE undo group) and
 * `asset.importSvg` (no direct engine id; the client imports the inline SVG
 * string). They are emitted ONLY by the guarded run_script / add_asset
 * translations — a model can never inject them directly (engine_commands
 * rejects both: script.run is code-exec DENIED in the catalog, asset.importSvg
 * is not an engine id at all), so the registry gate below admits them
 * unconditionally. */
const CLIENT_SPECIAL_STEP_COMMANDS: ReadonlySet<string> = new Set([
  "script.run",
  "asset.importSvg",
]);

/** run_script static guard: runtime APIs an agent script may never touch
 * (network, module loading, dynamic eval). The engine's boa sandbox has no
 * network or require anyway — the guard is the server-side defense-in-depth
 * and the repairable §8.9 message. Searched as LITERAL substrings. */
const FORBIDDEN_SCRIPT_TOKENS: readonly string[] = [
  "require(",
  "fetch(",
  "XMLHttpRequest",
  "import(",
  "eval(",
];

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

/** The round-12 ALLOWED-catalog seam: deps.allowsEngineCommand when injected,
 * else the contracts predicate (isAllowedEngineCommand). Throwing predicates
 * fail closed — compilePlan never throws (law #1). */
function predicateAllows(
  predicate: AllowedEngineCommandPredicate | undefined,
  id: string,
): boolean {
  const check = predicate ?? isAllowedEngineCommand;
  try {
    return check(id) === true;
  } catch {
    return false;
  }
}

/**
 * Unit seam for model-written transform values (observed with glm-4-plus and
 * any LLM really): the engine's `transform/opacity` and `transform/scale`
 * are PERCENT (static defaults 100; keyframes like 0 → 130 for a bounce
 * pop-in), while models habitually write 0..1 fractions (opacity 0 → 1,
 * scale 0 → 1.3). Raw fractions compile and apply fine — and then animate
 * nothing visible: a 1%-opacity tagline, a 1.3%-scale title (the 2026-10-31
 * Neon Typography render bug). One bounded pass, applied ONLY when every
 * numeric component sits in [0, 1] — an already-percent 0..100 value never
 * matches, so this is idempotent and safe on mixed plans. Positions and
 * everything else pass through untouched.
 */
export function normalizeTransformUnitForPath(
  path: string,
  value: unknown,
): { value: unknown; converted: boolean } {
  const segments = path.toLowerCase().split("/").filter((s) => s.length > 0);
  const leaf = segments[segments.length - 1];
  const isOpacity = leaf === "opacity";
  const isScale = leaf === "scale";
  if (!isOpacity && !isScale) return { value, converted: false };
  if (isOpacity) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { value, converted: false };
    }
    return { value: value * 100, converted: value !== 100 };
  }
  // scale: [x, y] or [x, y, z] — convert x/y fractions; leave anything else.
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    return { value, converted: false };
  }
  if (!value.every((c) => typeof c === "number" && Number.isFinite(c))) {
    return { value, converted: false };
  }
  if (!value.every((c) => c >= 0 && c <= 1)) {
    return { value, converted: false };
  }
  return { value: value.map((c) => c * 100), converted: true };
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
// Color (F-S1) — the engine's text-color convention, mirrored EXACTLY
// ---------------------------------------------------------------------------

/**
 * The engine's text-color form (F-S1). `layer.newText` / `layer.setText`
 * fill+stroke parse through the engine's own `color_json`
 * (keyframe/src/text_doc.rs:956): a `#rrggbb` / `#rrggbbaa` string normalizes
 * each channel as `u8 / 255`, while an ARRAY is read RAW into the internal
 * 0..1 color space (no scaling — that arm exists for the engine's own
 * 0..1-internal callers, e.g. script prelude `fill: [1, 1, 1, 1]`). The
 * contracts COLOR_SCHEMA speaks 0..255 channels, so a schema-valid
 * `[r, g, b]` / `[r, g, b, a]` array compiles into the engine's canonical hex
 * string — the exact `/255` quantization the engine's own hex arm applies —
 * and is NEVER passed through raw (a raw 0..255 array would land in a 0..1
 * space and render as a blown-out color). Strings ride as-is (the common
 * case and every existing golden).
 */
function engineColor(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  if (value.length < 3 || value.length > 4) return undefined;
  const channels: number[] = [];
  for (const channel of value) {
    if (typeof channel !== "number" || !Number.isFinite(channel)) return undefined;
    // Clamp to the schema's 0..255 band before quantizing (the engine's hex
    // arm parses exactly two hex digits per channel; Math.round halves up).
    channels.push(Math.min(255, Math.max(0, Math.round(channel))));
  }
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// run_script static guard (round-12) — comment-aware token scan
// ---------------------------------------------------------------------------

/**
 * Replace JS comment bodies with spaces (newlines preserved) so the static
 * guard never flags commented-out code, while STRING LITERALS stay intact —
 * a `//` or `/*` INSIDE a string is not a comment, and code after such a
 * string is still scanned (a naive strip would mask a real call: e.g.
 * `const u = "http://x"; fetch(u)` must still FAIL). Template literal `${…}`
 * interpolations are scanned as code via a brace-depth stack. Known
 * limitation: regex literals are not tokenized (a regex containing `//` can
 * mask the rest of its line) — such code is either a parse error at the
 * engine or fails closed elsewhere; the sandbox itself has no network.
 */
function stripJsComments(code: string): string {
  const out: string[] = [];
  const interpolationDepth: number[] = []; // open-brace depth per `${` frame
  let mode: "code" | "string" = "code";
  let quote = ""; // "'", '"', or '`'
  let i = 0;
  while (i < code.length) {
    const ch = code[i] ?? "";
    const next = code[i + 1] ?? "";
    if (mode === "string") {
      if (ch === "\\") {
        out.push(ch, next);
        i += 2;
        continue;
      }
      if (ch === quote) {
        mode = "code";
        out.push(ch);
        i += 1;
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        interpolationDepth.push(1);
        mode = "code";
        out.push(ch, next);
        i += 2;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) {
        out.push(code[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < code.length) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      mode = "string";
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    if (interpolationDepth.length > 0) {
      const top = interpolationDepth.length - 1;
      const depth = interpolationDepth[top] ?? 0;
      if (ch === "{") {
        interpolationDepth[top] = depth + 1;
      } else if (ch === "}") {
        if (depth <= 1) {
          interpolationDepth.pop();
          mode = "string"; // the `}` closed the `${` interpolation
        } else {
          interpolationDepth[top] = depth - 1;
        }
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/** The first forbidden runtime-API token found OUTSIDE comments (after
 * comment-aware stripping), or `undefined` when the code is clean. */
function forbiddenScriptToken(code: string): string | undefined {
  const stripped = stripJsComments(code);
  for (const token of FORBIDDEN_SCRIPT_TOKENS) {
    if (stripped.includes(token)) return token;
  }
  return undefined;
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

  /** Plan context (D-21): the plan's affectedLayers names — apply_preset's
   * no-layers fallback. Set by compilePlanInner before the step loop. */
  planLayerNames: readonly string[] = [];

  constructor(
    private readonly depsRegistry: CommandSchema,
    private readonly allowsEnginePredicate: AllowedEngineCommandPredicate | undefined = undefined,
  ) {}

  private pushIssue(issue: PlanIssue): void {
    const target = issue.severity === "fatal" ? this.fatals : this.warnings;
    if (target.length >= MAX_ISSUES) return; // bounded, deterministic
    target.push(issue);
  }

  fatal(
    code: PlanIssueCode,
    message: string,
    extra?: Omit<PlanIssue, "severity" | "code" | "message">,
  ): void {
    this.pushIssue({ severity: "fatal", code, message: clip(message), ...extra });
  }

  warn(
    code: PlanIssueCode,
    message: string,
    extra?: Omit<PlanIssue, "severity" | "code" | "message">,
  ): void {
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
      // G-3 completeness ruling: a step that translates to ZERO commands
      // makes the WHOLE plan fatally incomplete — the user must never approve
      // N edits and silently get fewer (M5-M gp-11 finding).
      this.fatal(
        "empty_step",
        "step compiled to no engine commands; the plan is rejected as incomplete",
        { step: planStep, tool },
      );
    };
    /** Read `[{name}]`-shaped layer refs (M5-A LAYER_REFS_SCHEMA) as names. */
    const readLayerNames = (value: unknown): string[] => {
      const names: string[] = [];
      if (!Array.isArray(value)) return names;
      for (const entry of value) {
        const name = isPlainObject(entry) ? readString(entry, "name") : undefined;
        if (name !== undefined) names.push(name);
        else unusable("layers", "entry has no usable name (skipped)");
      }
      return names;
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
        // 2026-11-01: comp.new takes `background` (#hex | [r,g,b]) — the
        // create_composition tool surface now exposes it (both failing runs
        // tried to set the background right after creation and had nowhere to
        // put it). engineColor normalizes channel arrays to hex.
        const background = argsObj.background;
        if (background !== undefined) {
          const color = engineColor(background);
          if (color !== undefined) params.background = color;
          else unusable("background", "is not a #hex color string or a [r, g, b] channel array");
        }
        if (params.name === undefined) {
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
        const font = readString(argsObj, "font");
        if (font !== undefined) params.font = font;
        const style = readString(argsObj, "style");
        if (style !== undefined) params.style = style;
        // F-S1: fill/stroke accept BOTH COLOR_SCHEMA forms. Strings ride 1:1
        // (the common case and every pre-existing golden); schema-valid
        // [r, g, b(, a)] channel arrays are CONVERTED into the engine's
        // canonical hex form (see engineColor) instead of being silently
        // dropped — and anything else warns as unusable, never rides.
        for (const key of ["fill", "stroke"] as const) {
          const value = argsObj[key];
          if (value === undefined) continue;
          const color = engineColor(value);
          if (color !== undefined) {
            params[key] = color;
          } else {
            this.warn(
              "unusable_args",
              `field \`${key}\` is not a #hex color string or a [r, g, b(, a)] channel array`,
              { step: planStep, tool, param: key },
            );
          }
        }
        for (const key of ["size", "strokeWidth", "tracking", "leading"] as const) {
          const value = argsObj[key];
          if (isFiniteNumber(value)) params[key] = value;
          else if (value !== undefined) unusable(key, "is not a finite number");
        }
        const box = argsObj.box;
        if (box !== undefined) {
          const [bx, by, w, h] = Array.isArray(box) ? box : [];
          if (isFiniteNumber(bx) && isFiniteNumber(by) && isFiniteNumber(w) && isFiniteNumber(h)) {
            params.box = [bx, by, w, h];
          } else {
            unusable("box", "is not an [x, y, w, h] number tuple");
          }
        }
        if (params.text === undefined) {
          compilesToNothing();
          break;
        }
        const position = argsObj.position;
        if (position !== undefined) {
          const [x, y] = Array.isArray(position) ? position : [];
          if (isFiniteNumber(x) && isFiniteNumber(y)) {
            params.position = [x, y];
          } else {
            unusable("position", "is not a [x, y] number pair");
          }
        }
        if (params.text === undefined) {
          compilesToNothing();
          break;
        }
        // 2026-11-01 root-cause fix: `opacity` at CREATION — the #1 rejected
        // key across both failing runs (8 burned calls; motion-graphics
        // briefs demand fade-ins). layer.newText takes no opacity, so the
        // starting opacity compiles to a follow-up transform/opacity set in
        // the SAME atomic batch, resolved BY NAME: the prop.set step runs
        // right after the layer.newText step that created it (the engine
        // resolves layer names at each step's execution time; the client's
        // apply defers batch-created names). The name must be deterministic —
        // when the model sent none, the text itself becomes the layer name.
        const opacity = argsObj.opacity;
        if (opacity !== undefined && !isFiniteNumber(opacity)) {
          unusable("opacity", "is not a finite number");
        } else if (isFiniteNumber(opacity)) {
          if (typeof params.name !== "string" || params.name.length === 0) {
            params.name = (text ?? "Text").slice(0, 60);
          }
        }
        add("layer.newText", params);
        if (isFiniteNumber(opacity)) {
          const unit = normalizeTransformUnitForPath("transform/opacity", opacity);
          add("prop.set", {
            layer: params.name,
            path: "transform/opacity",
            value: unit.value,
          });
        }
        break;
      }

      case "set_properties": {
        // M5-A shape: {layers: [{name}], properties: [{path, value}]} ->
        // cross-product prop.set per layer x property; a "name" path maps to
        // layer.rename (G-7 -- rename was otherwise inexpressible).
        const layers = readLayerNames(argsObj.layers);
        const properties = argsObj.properties;
        if (layers.length === 0) {
          unusable("layers", "no usable named layers");
          compilesToNothing();
          break;
        }
        if (!Array.isArray(properties)) {
          unusable("properties", "is not an array");
          compilesToNothing();
          break;
        }
        for (const property of properties) {
          if (!isPlainObject(property)) {
            unusable("properties", "contains a non-object entry (skipped)");
            continue;
          }
          const path = readString(property, "path");
          if (path === undefined) {
            unusable("properties", "entry has no path (skipped)");
            continue;
          }
          for (const layer of layers) {
            if (path === "name") {
              const value = readString(property, "value");
              if (value === undefined) {
                unusable("properties", "a rename needs a string value (skipped)");
                continue;
              }
              add("layer.rename", { layer, name: value });
            } else {
              const normalizedPath = normalizePropertyPath(path);
              const params: Record<string, unknown> = {
                layer,
                path: normalizedPath,
              };
              if ("value" in property) {
                const unit = normalizeTransformUnitForPath(normalizedPath, property.value);
                params.value = unit.value;
                if (unit.converted) {
                  this.warn(
                    "unit_normalized",
                    `transform value written as a 0..1 fraction; compiled as percent (engine convention)`,
                    { step: planStep, tool, param: "value" },
                  );
                }
              }
              add("prop.set", params);
            }
            addSite("layer", layer);
          }
        }
        if (steps.length === 0) compilesToNothing();
        break;
      }

      case "set_keyframes": {
        // M5-A shape: {layers: [{name}], propertyPath, keys: [{timeSeconds,
        // value, interpolation?}]} -> cross-product prop.addKey per layer x key.
        const layers = readLayerNames(argsObj.layers);
        const keys = argsObj.keys;
        const propertyPath = readString(argsObj, "propertyPath");
        if (layers.length === 0) {
          unusable("layers", "no usable named layers");
          compilesToNothing();
          break;
        }
        if (!Array.isArray(keys)) {
          unusable("keys", "is not an array");
          compilesToNothing();
          break;
        }
        for (const key of keys) {
          if (!isPlainObject(key)) {
            unusable("keys", "contains a non-object entry (skipped)");
            continue;
          }
          const time = key.timeSeconds;
          const interpolation = readString(key, "interpolation");
          for (const layer of layers) {
            const params: Record<string, unknown> = { layer };
            if (propertyPath !== undefined) {
              params.path = normalizePropertyPath(propertyPath);
            }
            if (isFiniteNumber(time)) params.time = time;
            else if (time !== undefined) {
              unusable("keys", "entry timeSeconds is not a finite number");
            }
            if ("value" in key) {
              const unit = normalizeTransformUnitForPath(
                propertyPath !== undefined ? normalizePropertyPath(propertyPath) : "",
                key.value,
              );
              params.value = unit.value;
              if (unit.converted) {
                this.warn(
                  "unit_normalized",
                  `transform keyframe written as a 0..1 fraction; compiled as percent (engine convention)`,
                  { step: planStep, tool, param: "value" },
                );
              }
            }
            if (interpolation !== undefined && interpolation !== "linear") {
              this.warn(
                "uncompilable_arg",
                `interpolation \`${clip(interpolation, 24)}\` is editor-side keyframe state; the key compiles with the engine default (set it via the timeline after apply)`,
                { step: planStep, tool, param: "interpolation" },
              );
            }
            add("prop.addKey", params);
            addSite("layer", layer);
          }
        }
        if (steps.length === 0) compilesToNothing();
        break;
      }

      case "add_effect": {
        // M5-A shape: {layers: [{name}], effect: {name}, params?} ->
        // effect.apply {layers: [names], effect: name}. Effect instance
        // params are editor state (uncompilable server-side; warn + set via
        // set_properties after apply).
        const layers = readLayerNames(argsObj.layers);
        if (layers.length === 0) {
          unusable("layers", "no usable named layers");
          compilesToNothing();
          break;
        }
        const effectObj = argsObj.effect;
        const effectName = isPlainObject(effectObj) ? readString(effectObj, "name") : undefined;
        const params: Record<string, unknown> = { layers: [...layers] };
        if (effectName !== undefined) params.effect = effectName;
        else unusable("effect", "has no usable name");
        add("effect.apply", params);
        layers.forEach((layer, index) => addSite(`layers[${index}]`, layer));
        const effectParams = argsObj.params;
        if (effectParams !== undefined) {
          if (isPlainObject(effectParams)) {
            for (const key of Object.keys(effectParams).sort()) {
              this.warn(
                "uncompilable_arg",
                `effect parameter \`${clip(key, 40)}\` cannot be compiled server-side (the effect instance index is editor state); set it via set_properties after apply`,
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
        // M5-A shape: {preset: {name}|{builtinId}, layers? [{name}], args?}.
        // D-21 ruling: when `layers` is omitted the plan's affectedLayers
        // names are the targets (never the live editor selection -- a
        // selection-capture hazard the compiler refuses).
        const explicitLayers = readLayerNames(argsObj.layers);
        const layers = explicitLayers.length > 0 ? explicitLayers : [...this.planLayerNames];
        if (layers.length === 0) {
          unusable(
            "layers",
            "no target layers: neither step layers nor plan affectedLayers name any",
          );
          compilesToNothing();
          break;
        }
        const presetObj = argsObj.preset;
        let preset: string | undefined;
        if (isPlainObject(presetObj)) {
          preset = readString(presetObj, "name") ?? readString(presetObj, "builtinId");
        }
        if (preset !== undefined && PRESET_PATH_LIKE.test(preset)) {
          this.warn(
            "uncompilable_arg",
            "preset looks like a filesystem path; paths are never agent-compilable " +
              "(compiled as a builtin preset name)",
            { step: planStep, tool, param: "preset" },
          );
        }
        if (preset === undefined) {
          unusable("preset", "needs a name or builtinId");
          compilesToNothing();
          break;
        }
        // The text-animator library (crates/engine/presets/text_animators.json:
        // typewriter, fadeUpCharacters, bounceInWords, trackingIn, scramble,
        // blurIn, jitter, dropInLines) is NOT part of anim.applyBuiltinPreset's
        // library (transitions + backgrounds only — anim_presets.rs presets());
        // applying those ids there fails with "no animation preset". They have
        // their own engine command — layer.applyTextPreset — so route by id
        // (layer refs ride the same resolution sites either way).
        if (TEXT_ANIMATOR_PRESET_IDS.has(preset)) {
          for (const layer of layers) {
            add("layer.applyTextPreset", { layer, preset });
            addSite("layer", layer);
          }
          break;
        }
        const params: Record<string, unknown> = { layers: [...layers], preset };
        const presetArgs = argsObj.args;
        if (isPlainObject(presetArgs)) {
          for (const key of Object.keys(presetArgs).sort()) {
            this.warn(
              "uncompilable_arg",
              `preset arg \`${clip(key, 40)}\` is editor-side state; set it via set_properties after apply`,
              { step: planStep, tool, param: key },
            );
          }
        }
        add("anim.applyBuiltinPreset", params);
        layers.forEach((layer, index) => addSite(`layers[${index}]`, layer));
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
          this.warn(
            "duplicate_save_version",
            "an earlier save_version step was superseded (the last labels the version)",
            {
              step: this.saveVersionStep,
              tool,
            },
          );
        }
        this.saveVersion = label !== undefined ? { label } : {};
        this.saveVersionStep = planStep;
        break;
      }

      case "engine_commands": {
        // Round-12 "Tool catalog v3": the model's steps ARE the batch payload.
        // Every command id must pass the ALLOWED engine catalog — an unknown
        // or denied id is a typed `command_not_allowed` fatal (§8.9 repair
        // turn). Valid steps ride VERBATIM (params unchanged); the input is
        // bounded to 1..50 steps (the strict live schema enforces the same
        // bound — this is the weak-schema defense-in-depth).
        const stepsIn = argsObj.steps;
        if (!Array.isArray(stepsIn)) {
          unusable("steps", "is not an array");
          compilesToNothing();
          break;
        }
        if (stepsIn.length === 0) {
          unusable("steps", "is empty");
          compilesToNothing();
          break;
        }
        if (stepsIn.length > MAX_ENGINE_COMMAND_STEPS) {
          unusable("steps", `exceeds the ${MAX_ENGINE_COMMAND_STEPS}-step bound`);
          compilesToNothing();
          break;
        }
        let denied = false;
        for (const [index, entry] of stepsIn.entries()) {
          if (!isPlainObject(entry)) {
            unusable("steps", `entry ${index + 1} is not an object (skipped)`);
            continue;
          }
          const command = readString(entry, "command");
          if (command === undefined) {
            unusable("steps", `entry ${index + 1} has no command id (skipped)`);
            continue;
          }
          if (!predicateAllows(this.allowsEnginePredicate, command)) {
            // w8 harness fix — a read-only engine query (anim.builtinPresets,
            // text.presets, …) is a REGISTERED id the params docs keep
            // referencing; the refusal must TEACH, not dead-end: the query is
            // never batchable, its data lives in the read tools / the inline
            // preset library of the system prompt.
            this.fatal(
              "command_not_allowed",
              isReadEngineQuery(command)
                ? `engine command "${clip(command, 64)}" is a READ-ONLY engine query — it can never be a batch step; its data is already covered by the studio read tools and the inline preset library in your instructions`
                : `engine command "${clip(command, 64)}" is not allowed for agents`,
              { step: planStep, tool, command },
            );
            denied = true;
            continue;
          }
          const params = entry.params;
          if (!isPlainObject(params)) {
            unusable("steps", `entry ${index + 1} has no params record (skipped)`);
            continue;
          }
          // The same bare-leaf repair set_properties gets (2026-11-01:
          // engine_commands prop.set path "sourceText" reached the engine
          // verbatim and rolled the batch back — "no property
          // `sourceText`"). Only the two path-bearing commands are
          // normalized, and only a string `path` param is touched; every
          // other step rides verbatim.
          if (
            (command === "prop.set" || command === "prop.addKey") &&
            typeof params.path === "string"
          ) {
            add(command, { ...params, path: normalizePropertyPath(params.path) });
          } else {
            add(command, { ...params });
          }
        }
        if (steps.length === 0 && !denied) compilesToNothing();
        break;
      }

      case "run_script": {
        // Round-12: the code executes at APPLY time through the client's
        // special bridge.execute("script.run") seam (the engine refuses
        // script.run inside engine.batch — NOT_IN_BATCH), wrapped in ONE undo
        // group. The compile emits EXACTLY ONE client-special step after the
        // static guard; the code length bound mirrors MAX_SCRIPT_CODE_LENGTH
        // for weak (stub) schemas — the strict live schema caps it anyway.
        const code = argsObj.code;
        const codeText = typeof code === "string" ? code : "";
        if (codeText.length === 0) {
          unusable("code", "is not a non-empty string");
          compilesToNothing();
          break;
        }
        if (codeText.length > MAX_SCRIPT_CODE_LENGTH) {
          unusable("code", `exceeds the ${MAX_SCRIPT_CODE_LENGTH}-character bound`);
          compilesToNothing();
          break;
        }
        const forbidden = forbiddenScriptToken(codeText);
        if (forbidden !== undefined) {
          this.fatal(
            "unsafe_script",
            `script code uses "${clip(forbidden, 24)}" — network, module-loading and eval APIs are not allowed in agent scripts`,
            { step: planStep, tool, param: "code" },
          );
          break;
        }
        add("script.run", { code: codeText });
        break;
      }

      case "add_asset": {
        // Round-12: inline SVG → vector import at APPLY time through the
        // client's apply seam. `asset.importSvg` is a CLIENT-SPECIAL step id
        // (no direct engine command — the client imports the SVG string and
        // folds it into the batch's one undo). The svg must be markup
        // (leading whitespace tolerated), bounded, and free of EXTERNAL
        // references (href="http… / xlink:href="http… — any *href= attribute).
        const kind = argsObj.kind;
        if (kind !== "svg") {
          unusable("kind", 'is not "svg" (the only supported asset kind)');
          compilesToNothing();
          break;
        }
        const name = readString(argsObj, "name");
        if (name === undefined) {
          unusable("name", "is not a non-empty string");
          compilesToNothing();
          break;
        }
        const svg = argsObj.svg;
        const svgText = typeof svg === "string" ? svg : "";
        if (svgText.length === 0) {
          unusable("svg", "is not a non-empty string");
          compilesToNothing();
          break;
        }
        if (svgText.length > MAX_SVG_LENGTH) {
          unusable("svg", `exceeds the ${MAX_SVG_LENGTH}-character bound`);
          compilesToNothing();
          break;
        }
        const trimmed = svgText.trim();
        if (!trimmed.startsWith("<svg") && !trimmed.startsWith("<?xml")) {
          this.fatal(
            "invalid_svg",
            "the svg payload must be inline markup starting with <svg or <?xml",
            { step: planStep, tool, param: "svg" },
          );
          break;
        }
        const lowered = svgText.toLowerCase();
        if (lowered.includes('href="http') || lowered.includes("href='http")) {
          this.fatal(
            "invalid_svg",
            "the svg payload references an external href — external references are not allowed",
            { step: planStep, tool, param: "svg" },
          );
          break;
        }
        add("asset.importSvg", { name, svg: svgText });
        break;
      }

      default: {
        // Exhaustiveness guard — lookupWriteTool already rejected unknown ids.
        this.fatal("unknown_tool", `tool \`${clip(tool, 64)}\` is not a write tool`, {
          step: planStep,
          tool,
        });
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
        this.warn(
          "unknown_command",
          `proposed command \`${clip(step.command, 64)}\` is not in the agent registry`,
          {
            step: planStep,
            tool,
            command: step.command,
            batchStep: index + 1,
          },
        );
      }
    }
    // Required params for the KNOWN proposed commands (reuse the contracts
    // helper; unknown-command duplicates were handled above).
    for (const issue of checkBatchCommands({ steps: [...proposed] }, this.depsRegistry)) {
      if (issue.reason !== "missing_required_param") continue;
      this.warn(
        "missing_required_param",
        `proposed \`${issue.command}\` is missing required param \`${issue.param}\``,
        {
          step: planStep,
          tool,
          command: issue.command,
          batchStep: issue.step,
          param: issue.param,
        },
      );
    }
    // Backwards-only $N.key refs (§8.5) within the proposed batch's own
    // 1-based numbering.
    for (const issue of validateBatchRefs(proposed)) {
      this.warn(
        "unresolvable_ref",
        `proposed batch has $-reference \`${issue.ref.raw}\` (${issue.reason})`,
        {
          step: planStep,
          tool,
          batchStep: issue.step,
        },
      );
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
      this.warn(
        "batch_mismatch",
        "the model's proposed batch disagrees with the compiled translation; the translation stands",
        {
          step: planStep,
          tool,
        },
      );
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
    if (
      entry !== null &&
      typeof entry === "object" &&
      "safeParse" in entry &&
      typeof entry.safeParse === "function"
    ) {
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
function applyParamPath(
  params: Record<string, unknown>,
  path: string,
  value: string | number,
): void {
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
  const compiler = new Compiler(deps.registry, deps.allowsEngineCommand);

  // -- 0. pre-flight: the plan must serialize (cycle-hostile) and be sane.
  let serializedPlan: string;
  try {
    serializedPlan = JSON.stringify(plan) ?? "null";
  } catch {
    compiler.fatal("plan_too_large", "the plan is not serializable JSON");
    return { ok: false, issues: compiler.fatals };
  }
  if (serializedPlan.length > MAX_PLAN_BYTES) {
    compiler.fatal(
      "plan_too_large",
      `the plan is too large to compile (${serializedPlan.length} bytes)`,
    );
    return { ok: false, issues: compiler.fatals };
  }

  // -- 1. defense-in-depth re-validation against the §8.6 schema (the runner
  // validates first; hostile direct calls stop here).
  const parsed = EDIT_PLAN_SCHEMA.safeParse(plan);
  if (!parsed.success) {
    const messages = parsed.error.issues.slice(0, 5).map((issue) => issue.message);
    compiler.fatal(
      "plan_schema",
      `the plan failed its schema: ${messages.join("; ") || "invalid shape"}`,
    );
    return { ok: false, issues: compiler.fatals };
  }
  const editPlan = parsed.data;
  compiler.planLayerNames = editPlan.affectedLayers
    .map((layer) => (typeof layer.name === "string" && layer.name.length > 0 ? layer.name : ""))
    .filter((name) => name !== "");

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
      compiler.fatal(
        "unknown_tool",
        `tool \`${clip(planStep.tool, 64)}\` is not one of the 11 write tools`,
        {
          step: position,
          tool: planStep.tool,
        },
      );
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
        compiler.fatal(
          "invalid_args",
          `args for \`${tool.bareId}\` failed validation: ${argsMessage}`,
          {
            step: position,
            tool: tool.bareId,
          },
        );
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
    compiler.fatal(
      "empty_batch",
      "the plan compiles to an empty command batch (only annotation steps)",
    );
    return { ok: false, issues: compiler.fatals };
  }
  if (steps.length > MAX_BATCH_STEPS) {
    compiler.fatal(
      "too_many_commands",
      `the compiled batch has ${steps.length} commands (max ${MAX_BATCH_STEPS})`,
    );
    return { ok: false, issues: compiler.fatals };
  }
  for (const issue of checkBatchCommands({ steps }, deps.registry)) {
    if (issue.reason === "unknown_command") {
      // Round-12 widening: a compiled command outside the CURATED registry is
      // admitted when it is (a) a CLIENT-SPECIAL step id — script.run /
      // asset.importSvg, emitted ONLY by the guarded run_script / add_asset
      // translations, never model-chosen — or (b) an ALLOWED engine catalog id
      // (studio.engine_commands steps, validated per id at translate time).
      // Anything else stays a fatal (defense-in-depth — the model's proposed
      // batches never reach this gate as compiled steps).
      if (
        CLIENT_SPECIAL_STEP_COMMANDS.has(issue.command) ||
        predicateAllows(deps.allowsEngineCommand, issue.command)
      ) {
        continue;
      }
      compiler.fatal(
        "unknown_command",
        `compiled command \`${issue.command}\` is not in the agent registry`,
        {
          batchStep: issue.step,
          command: issue.command,
        },
      );
    } else {
      compiler.fatal(
        "missing_required_param",
        `\`${issue.command}\` is missing required param \`${issue.param}\``,
        {
          batchStep: issue.step,
          command: issue.command,
          param: issue.param,
        },
      );
    }
  }
  // The compiled batch is name-based by construction — refs are validated as
  // defense-in-depth anyway (§8.5 backwards-only $N.key).
  for (const issue of validateBatchRefs(steps)) {
    compiler.fatal(
      "unresolvable_ref",
      `compiled batch has $-reference \`${issue.ref.raw}\` (${issue.reason})`,
      {
        batchStep: issue.step,
      },
    );
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
    compiler.warn(
      "undeclared_layer",
      `layer \`${clip(site.layerName, 64)}\` is used by a step but not declared in the plan`,
      {
        step: site.planStep,
      },
    );
  }

  const resolved = new Map<string, string | number>();
  if (deps.layerResolver !== undefined) {
    for (const name of uniqueNames) {
      try {
        const id = deps.layerResolver(name);
        if (id !== undefined) resolved.set(name, id);
      } catch {
        compiler.warn(
          "resolver_error",
          "the layer resolver failed; the layer name stays in the batch",
        );
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
      placeholders.push({
        step: site.globalStep + 1,
        param: site.param,
        layerName: site.layerName,
        resolvedId,
      });
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
  // G-4: the recomputed risk is a floor-safeguarded value -- the model's
  // declared risk is never LOWERED (the card must never understate risk),
  // but the command-based floors still raise it.
  const risk = riskMax(recomputePlanRisk(steps, compiler.toolRiskFloor()), editPlan.risk);
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
export function compilePlan(
  planOrInput: EditPlan | CompilePlanInput,
  deps: CompileDeps,
): CompilePlanResult {
  try {
    const plan = isCompileInput(planOrInput) ? planOrInput.plan : planOrInput;
    return compilePlanInner(plan, deps);
  } catch {
    // Absolute backstop: no stack traces, no details (law #1).
    return {
      ok: false,
      issues: [
        { severity: "fatal", code: "internal", message: "plan compilation failed unexpectedly" },
      ],
    };
  }
}

/**
 * Live deps from the M5-A/M5-J contract surfaces, read at CALL time (ESM live
 * bindings) so peer stubs landing mid-wave are picked up. The registry is the
 * REAL curated command allowlist (M5-J); the write tools are the REAL M5-A
 * catalog (now 11 tools — the round-12 v3 additions ride the same projection,
 * F-S2): each entry carries its args schema AND its risk badge, so
 * lookupWriteTool's per-tool risk floor works on the live wire path
 * (defaultCompileDeps previously passed the bare WRITE_TOOL_ARGS_SCHEMAS and
 * the catalog badges never reached the recomputed risk). The round-12
 * widening seam is the contracts ALLOWED-catalog predicate
 * (isAllowedEngineCommand — every studio.engine_commands step id must pass
 * it at translate time). Built once — the catalog is frozen.
 */
const CATALOG_WRITE_TOOLS: WriteToolsDep = Object.fromEntries(
  WRITE_TOOLS.map((tool) => [tool.id, { args: tool.inputSchema, risk: tool.risk }]),
);

export function defaultCompileDeps(): CompileDeps {
  return {
    registry: AGENT_COMMAND_REGISTRY,
    writeTools: CATALOG_WRITE_TOOLS,
    allowsEngineCommand: isAllowedEngineCommand,
  };
}
