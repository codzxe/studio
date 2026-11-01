// @studio/contracts — the WRITE tool contracts (BUILD_PLAN §M5.1,
// PRODUCT_ARCHITECTURE §8.4/§8.7, M5-SEAMS "write-tools" seam).
//
// M5.1 pinned EIGHT write tools; round 12 ("Tool catalog v3",
// docs/research/round12-design.md) adds THREE more, appended in this file so the
// original eight stay first and byte-compatible: engine_commands (the generic
// catalog-validated escape hatch), run_script (the approval-time scripting
// seam — script.run is never batchable, the engine's NOT_IN_BATCH refuses it)
// and add_asset (inline SVG → vector import).
//
// Write tools are PROPOSAL-ONLY (§8.4 rules 1-5, law #6): every result is a
// proposed batch (WRITE_TOOL_RESULT_SCHEMA) that the plan/approval card
// shows; NOTHING is executed until the user applies the plan and the bridge
// runs ONE atomic batch — one undo step, one version.
//
// Law #5: the model never sees raw engine commands or ids. Args here are
// CURATED (names, numbers, paths — never command ids or plugin paths); the
// server-side plan compiler maps tool+args → registry command steps.
//
// Layer references are BY NAME everywhere (never ids): ambiguous names are
// resolved client-side (M5-SEAMS `LayerResolutionRequest`) and posted with
// the apply.
//
// Dunder safety (M4-SAFETY F-1, §12.2): `__proto__` / `constructor` /
// `prototype` are rejected as layer names, as property-path segments, and as
// object keys ANYWHERE inside free-form values. The helpers below are
// exported so peers (plan compiler, client executor) reuse the same guard.

import { z } from "zod";

import type { PlanIntent, PlanRisk } from "./edit-plan.js";
import {
  BATCH_STEP_SCHEMA,
  MAX_BATCH_BYTES,
  MAX_BATCH_LABEL_LENGTH,
  MAX_BATCH_STEPS,
} from "./engine-batch.js";

// ---------------------------------------------------------------------------
// Identity (M5-SEAMS: the pinned 8 ids, unprefixed; tools.ts registers them
// under their wire ids `studio.<id>` — see studioWriteToolId below; round-12
// additions are appended after the eight)
// ---------------------------------------------------------------------------

/**
 * The write-tool ids (the §M5.1 eight, then the round-12 additions, in order).
 */
export const WRITE_TOOL_IDS = [
  "create_composition",
  "create_text",
  "set_properties",
  "add_effect",
  "set_keyframes",
  "apply_preset",
  "undo_run",
  "save_version",
  // Round-12 "Tool catalog v3" (appended — the eight above stay untouched):
  "engine_commands",
  "run_script",
  "add_asset",
] as const satisfies readonly string[];

export type WriteToolId = (typeof WRITE_TOOL_IDS)[number];

/** The wire id a write tool is registered under in the tool catalog. */
export function studioWriteToolId(id: WriteToolId): `studio.${WriteToolId}` {
  return `studio.${id}`;
}

// ---------------------------------------------------------------------------
// Bounds (curated per BUILD_PLAN §M5.1 + the real engine command params)
// ---------------------------------------------------------------------------

/** Composition name bound (§M5.1: name ≤ 80). */
export const MAX_COMPOSITION_NAME_LENGTH = 80;
/** Composition pixel bounds (§M5.1: width/height 1..8192). */
export const MIN_COMPOSITION_DIMENSION = 1;
export const MAX_COMPOSITION_DIMENSION = 8192;
/** Frame-rate bounds (§M5.1: fps 1..120; fractional rates like 29.97 allowed). */
export const MIN_FRAME_RATE = 1;
export const MAX_FRAME_RATE = 120;
/** Duration bounds in seconds (§M5.1: duration 0.01..36000). */
export const MIN_DURATION_SECONDS = 0.01;
export const MAX_DURATION_SECONDS = 36000;
/** Keyframe time bounds in seconds (§M5.1: timeSeconds 0..36000). */
export const MAX_TIME_SECONDS = 36000;
/** create_text text bound (§M5.1: ≤ 2000). */
export const MAX_TEXT_LENGTH = 2000;
/** Layer / preset / effect / version-label name bound (§M5.1: ≤ 120). */
export const MAX_TOOL_NAME_LENGTH = 120;
/** Font family / style bound (mirrors the M4 read-tool font bound). */
export const MAX_FONT_LENGTH = 200;
/** Property-path bound (§M5.1: path ≤ 200). */
export const MAX_PROPERTY_PATH_LENGTH = 200;
/** Layer references per call (§M5.1: ≤ 50, always BY NAME). */
export const MAX_LAYER_REFS = 50;
/** set_properties updates per call (§M5.1: 1..100). */
export const MAX_PROPERTY_UPDATES = 100;
/** set_keyframes keys per call (§M5.1: 1..500). */
export const MAX_KEYFRAME_KEYS = 500;
/** Font size bounds (engine clamps size to 0.1..10_000 — text_doc.rs). */
export const MIN_TEXT_SIZE = 0.1;
export const MAX_TEXT_SIZE = 10_000;
/** Comp-space coordinate bound for position/box (engine has none; curated). */
export const MAX_COORD = 1_000_000;
/** Stroke width / tracking / leading bounds (engine ≥0 only; curated). */
export const MAX_STROKE_WIDTH = 1000;
export const MAX_TRACKING = 10_000;
export const MAX_LEADING = 10_000;
/** Tool-result note bound (the "proposed, never executed" note). */
export const MAX_RESULT_NOTE_LENGTH = 1000;
/**
 * Total serialized-args ceiling for tools with free-form values/passthroughs
 * — the §8.5 2 MB batch payload cap applied at the tool-args boundary.
 */
export const MAX_WRITE_TOOL_ARGS_BYTES = MAX_BATCH_BYTES;

// ---------------------------------------------------------------------------
// Round-12 bounds ("Tool catalog v3")
// ---------------------------------------------------------------------------

/** engine_commands steps per call (design doc: 1..50, tighter than the §8.5 100). */
export const MAX_ENGINE_COMMAND_STEPS = 50;
/** run_script code bound (design doc: ≤ 20 000 chars). */
export const MAX_SCRIPT_CODE_LENGTH = 20_000;
/** add_asset inline SVG markup bound (design doc: ≤ 50 000 chars). */
export const MAX_SVG_LENGTH = 50_000;

// ---------------------------------------------------------------------------
// Dunder-safe helpers (M4-SAFETY F-1 — shared with M5 peers)
// ---------------------------------------------------------------------------

/** Object keys that are never legitimate names, paths or data keys (F-1). */
export const DUNDER_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** `true` when `key` is one of the dangerous prototype-chain names. */
export function isDunderKey(key: string): boolean {
  return (DUNDER_KEYS as readonly string[]).includes(key);
}

/**
 * First dunder-key location inside `value` (e.g. `"a[2].__proto__"`), or
 * `undefined` when the value is clean. Walks own enumerable properties only,
 * so a JSON-parsed `__proto__` own-key IS caught (JSON.parse does not invoke
 * the setter). Shared DUNDER-safe refinement helper (M5-SEAMS; exported for
 * the plan compiler and client executor).
 */
export function firstDunderKeyLocation(value: unknown): string | undefined {
  const visited = new WeakSet<object>();
  const walk = (node: unknown, path: string): string | undefined => {
    if (Array.isArray(node)) {
      if (visited.has(node)) return undefined; // already walked (cycle/DAG)
      visited.add(node);
      for (let i = 0; i < node.length; i++) {
        const found = walk(node[i], `${path}[${i}]`);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof node === "object" && node !== null) {
      if (visited.has(node)) return undefined;
      visited.add(node);
      for (const [key, child] of Object.entries(node)) {
        const here = path === "" ? key : `${path}.${key}`;
        if (isDunderKey(key)) return here;
        const found = walk(child, here);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(value, "");
}

/** `true` when no object key anywhere inside `value` is a dunder key (F-1). */
export function hasNoDunderKeys(value: unknown): boolean {
  return firstDunderKeyLocation(value) === undefined;
}

/**
 * `true` when no path SEGMENT of `path` is a dunder key. Segments are the
 * identifier runs between separators (e.g. `"transform/opacity"` →
 * `["transform", "opacity"]`), so `__proto__`, `a.__proto__.b` and
 * `effects[0].constructor` are rejected while `my__proto__field` is not.
 */
export function hasNoDunderSegments(path: string): boolean {
  return path
    .split(/[^A-Za-z0-9_$]+/)
    .filter((segment) => segment.length > 0)
    .every((segment) => !isDunderKey(segment));
}

/**
 * Deep JSON-serializability (for free-form values): null/boolean/string/
 * finite-number, arrays, and plain objects only — no `undefined`, functions,
 * symbols, bigints, class instances (Date/Map/…) or cycles. Tool args cross
 * the wire as JSON, so non-JSON values are rejected at the boundary.
 */
export function isJsonSerializableValue(value: unknown): boolean {
  const onPath = new WeakSet<object>();
  const check = (node: unknown): boolean => {
    if (node === null) return true;
    if (typeof node === "string" || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (typeof node !== "object") return false;
    if (onPath.has(node)) return false; // cycle — JSON.stringify would throw
    onPath.add(node);
    let result: boolean;
    if (Array.isArray(node)) {
      result = node.every(check);
    } else {
      const proto = Object.getPrototypeOf(node);
      result = (proto === Object.prototype || proto === null) && Object.values(node).every(check);
    }
    onPath.delete(node);
    return result;
  };
  return check(value);
}

/** Issues found in a free-form JSON value (dunder keys first, then serializability). */
function freeFormValueIssues(value: unknown): { message: string }[] {
  const dunder = firstDunderKeyLocation(value);
  if (dunder !== undefined) {
    return [{ message: `dunder key "${dunder}" is not allowed in values` }];
  }
  if (!isJsonSerializableValue(value)) {
    return [{ message: "value must be JSON-serializable" }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Shared leaf schemas
// ---------------------------------------------------------------------------

/** Dunder-safe identifier/name (F-1 class guard, ≤ 120 chars). */
const SAFE_NAME_SCHEMA = z
  .string()
  .min(1)
  .max(MAX_TOOL_NAME_LENGTH)
  .refine((v) => !isDunderKey(v), { message: "dunder keys are not valid names" });

/** Property path: bounded, separator-flexible, dunder-segment-free. */
const PROPERTY_PATH_SCHEMA = z
  .string()
  .min(1)
  .max(MAX_PROPERTY_PATH_LENGTH)
  .refine(hasNoDunderSegments, {
    message: "property paths must not reference dunder keys",
  });

/**
 * Layer references, BY NAME (law #5 — layer ids never enter the model
 * context). Disambiguation of duplicate names is the compiler/client's job
 * (M5-SEAMS `LayerResolutionRequest`), not the model's.
 */
const LAYER_REFS_SCHEMA = z
  .array(z.strictObject({ name: SAFE_NAME_SCHEMA }))
  .min(1)
  .max(MAX_LAYER_REFS);

/**
 * Bounded passthrough record (documented exception to strict mode): free
 * keys/values for effect params or preset args. Keys and values are
 * dunder-checked and JSON-checked; the whole args object is additionally
 * size-bounded by `withArgsSizeBound` (§8.5 2 MB).
 *
 * The checks run in `z.preprocess` on the RAW input because Zod REBUILDS
 * records/objects while parsing and an own `__proto__` key (as produced by
 * JSON.parse — no accessor involved) is silently DROPPED before any output
 * refinement can see it (verified against zod 4: a plain `z.record` output
 * lacks the key entirely). Rejecting at the raw boundary is the only way to
 * fail loudly instead of silently dropping model-emitted keys.
 */
const PASSTHROUGH_RECORD_SCHEMA = z.preprocess(
  (raw, ctx) => {
    for (const issue of freeFormValueIssues(raw)) {
      ctx.addIssue({ code: "custom", message: issue.message });
    }
    return raw;
  },
  z.record(z.string(), z.unknown()),
);

/** Color: `#rrggbb` / `#rrggbbaa` or [r,g,b] / [r,g,b,a] with channels 0..255
 * (mirrors the engine's text color params — text_doc.rs `color_json`). */
const COLOR_SCHEMA = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, {
    message: "color must be #rrggbb or #rrggbbaa",
  }),
  z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]),
  z.tuple([
    z.number().min(0).max(255),
    z.number().min(0).max(255),
    z.number().min(0).max(255),
    z.number().min(0).max(255),
  ]),
]);

/**
 * Color INPUT with repair (2026-11-01 root-cause fix): real runs kept
 * emitting near-miss color shapes — `fill: "[\"66\", \"133\", \"244\"]"` (the
 * gateway's stringified-JSON repair un-wraps the string but leaves numeric
 * STRINGS inside the array) and `"[\"#4285F4\"]"` (a hex string wrapped in a
 * one-element array). Both bounced off the strict union and burned a retry
 * each. One deterministic preprocess pass repairs exactly those two shapes
 * — numeric-string channels become numbers, a lone hex string unwraps — and
 * then the STRICT union above still has the final say on everything else.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?$/;

function repairColorish(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  if (
    raw.length === 1 &&
    typeof raw[0] === "string" &&
    HEX_COLOR_RE.test(raw[0].trim())
  ) {
    return raw[0].trim();
  }
  return raw.map((channel) =>
    typeof channel === "string" && NUMERIC_STRING_RE.test(channel.trim())
      ? Number(channel.trim())
      : channel,
  );
}

const COLOR_INPUT_SCHEMA = z.preprocess(repairColorish, COLOR_SCHEMA);

const COORD_SCHEMA = z.number().min(-MAX_COORD).max(MAX_COORD);
const BOX_SIZE_SCHEMA = z.number().min(1).max(MAX_COORD);

/** Adds the §8.5 2 MB total-args bound to a strict args object. */
function withArgsSizeBound<T extends z.ZodObject>(schema: T): T {
  return schema.superRefine((args, ctx) => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(args);
    } catch {
      return; // non-serializable args are already rejected by the value checks
    }
    if (serialized !== undefined && serialized.length > MAX_WRITE_TOOL_ARGS_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `args exceed the ${MAX_WRITE_TOOL_ARGS_BYTES}-byte serialized limit (${serialized.length} bytes)`,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Per-tool args schemas (STRICT: no unknown keys; the only passthroughs are
// the documented bounded records/values above)
// ---------------------------------------------------------------------------

export const CREATE_COMPOSITION_ARGS_SCHEMA = z.strictObject({
  name: z.string().min(1).max(MAX_COMPOSITION_NAME_LENGTH),
  width: z.number().int().min(MIN_COMPOSITION_DIMENSION).max(MAX_COMPOSITION_DIMENSION).optional(),
  height: z.number().int().min(MIN_COMPOSITION_DIMENSION).max(MAX_COMPOSITION_DIMENSION).optional(),
  frameRate: z.number().min(MIN_FRAME_RATE).max(MAX_FRAME_RATE).optional(),
  durationSeconds: z.number().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS).optional(),
  // 2026-11-01 root-cause fix: both failing runs immediately tried to set the
  // composition's background AFTER creating it — set_properties on the
  // composition's name (comp.new has taken `background` all along, but the
  // tool surface never exposed it). Meet the model at its natural expression
  // point: the background rides composition creation directly.
  background: COLOR_INPUT_SCHEMA.optional(),
});

/**
 * Curated subset of the REAL `layer.newText` params (layer.rs ~1592-1601):
 * `{text?, name?, position? [x,y], box? [x,y,w,h], font?, style?, size?,
 * fill?, stroke?, strokeWidth?, tracking?, leading?, …}`. The engine clamps
 * size to 0.1..10_000 and treats stroke as applyStroke=true; bounds here
 * mirror or tighten those. `leading` is a number (omit it for Auto).
 */
export const CREATE_TEXT_ARGS_SCHEMA = z.strictObject({
  // The teaching message (2026-11-01: a real run burned 5 tool calls on
  // text:"" — the generic zod min() message never told the model WHY or what
  // to do instead). validateToolCall surfaces issue messages verbatim. Prose
  // only — the description law keeps raw registry ids out of tool surface.
  text: z
    .string()
    .min(
      1,
      "text is REQUIRED — the visible content (1..2000 chars); never empty or placeholder " +
        "(an empty-text layer is always rejected — for a background/void layer propose a " +
        "SOLID layer via studio.engine_commands instead)",
    )
    .max(MAX_TEXT_LENGTH),
  name: SAFE_NAME_SCHEMA.optional(),
  position: z.tuple([COORD_SCHEMA, COORD_SCHEMA]).optional(),
  box: z.tuple([COORD_SCHEMA, COORD_SCHEMA, BOX_SIZE_SCHEMA, BOX_SIZE_SCHEMA]).optional(),
  font: z.string().min(1).max(MAX_FONT_LENGTH).optional(),
  style: z.string().min(1).max(MAX_FONT_LENGTH).optional(),
  size: z.number().min(MIN_TEXT_SIZE).max(MAX_TEXT_SIZE).optional(),
  fill: COLOR_INPUT_SCHEMA.optional(),
  stroke: COLOR_INPUT_SCHEMA.optional(),
  strokeWidth: z.number().min(0).max(MAX_STROKE_WIDTH).optional(),
  tracking: z.number().min(-MAX_TRACKING).max(MAX_TRACKING).optional(),
  leading: z.number().min(0).max(MAX_LEADING).optional(),
  // 2026-11-01 root-cause fix: the #1 rejected key across BOTH failing runs
  // (8 calls burned). Motion-graphics briefs demand fade-ins, so models reach
  // for `opacity` at CREATION time. The engine's layer.newText takes no
  // opacity — the plan compiler emits a follow-up transform/opacity set in
  // the same atomic batch, using the same 0..1-fraction → percent convention
  // as set_properties (normalizeTransformUnitForPath).
  opacity: z
    .number()
    .min(0, "opacity cannot be negative")
    .max(
      100,
      "opacity is 0..1 as a fraction (0.5 = half) or 1..100 as a percent (100 = fully opaque)",
    )
    .optional(),
});

/** Property updates for the named layers: 1..100 {path ≤ 200, JSON value}. */
const PROPERTY_UPDATES_SCHEMA = z
  .array(z.strictObject({ path: PROPERTY_PATH_SCHEMA, value: z.unknown() }))
  .min(1)
  .max(MAX_PROPERTY_UPDATES)
  .superRefine((updates, ctx) => {
    updates.forEach((update, index) => {
      for (const issue of freeFormValueIssues(update.value)) {
        ctx.addIssue({ code: "custom", path: [index, "value"], message: issue.message });
      }
    });
  });

export const SET_PROPERTIES_ARGS_SCHEMA = withArgsSizeBound(
  z.strictObject({
    layers: LAYER_REFS_SCHEMA,
    properties: PROPERTY_UPDATES_SCHEMA,
  }),
);

/**
 * The effect is a HUMAN effect name (e.g. "Gaussian Blur") — never a raw
 * plugin/registry path. The plan compiler maps it to the registry effect.
 */
const EFFECT_NAME_SCHEMA = z
  .string()
  .min(1)
  .max(MAX_TOOL_NAME_LENGTH)
  .refine((v) => !isDunderKey(v) && !v.includes("/") && !v.includes("\\"), {
    message: "effect must be a human-readable effect name, not a plugin path",
  });

export const ADD_EFFECT_ARGS_SCHEMA = withArgsSizeBound(
  z.strictObject({
    layers: LAYER_REFS_SCHEMA,
    effect: z.strictObject({ name: EFFECT_NAME_SCHEMA }),
    params: PASSTHROUGH_RECORD_SCHEMA.optional(),
  }),
);

/** Keyframe interpolation (the engine's core trio — prop.rs Interp). */
export const KEYFRAME_INTERPOLATION_SCHEMA = z.enum(["linear", "bezier", "hold"]);

const KEYFRAME_SCHEMA = z.strictObject({
  timeSeconds: z.number().min(0).max(MAX_TIME_SECONDS),
  value: z.unknown(),
  interpolation: KEYFRAME_INTERPOLATION_SCHEMA.optional(),
});

const KEYFRAMES_SCHEMA = z
  .array(KEYFRAME_SCHEMA)
  .min(1)
  .max(MAX_KEYFRAME_KEYS)
  .superRefine((keys, ctx) => {
    keys.forEach((key, index) => {
      for (const issue of freeFormValueIssues(key.value)) {
        ctx.addIssue({ code: "custom", path: [index, "value"], message: issue.message });
      }
    });
  });

export const SET_KEYFRAMES_ARGS_SCHEMA = withArgsSizeBound(
  z.strictObject({
    layers: LAYER_REFS_SCHEMA,
    propertyPath: PROPERTY_PATH_SCHEMA,
    keys: KEYFRAMES_SCHEMA,
  }),
);

export const APPLY_PRESET_ARGS_SCHEMA = withArgsSizeBound(
  z.strictObject({
    /** Preset by display name OR built-in id — exactly one of the two. */
    preset: z.union([
      z.strictObject({ name: SAFE_NAME_SCHEMA }),
      z.strictObject({ builtinId: SAFE_NAME_SCHEMA }),
    ]),
    /** Omit to target the current selection (client-side default). */
    layers: LAYER_REFS_SCHEMA.optional(),
    args: PASSTHROUGH_RECORD_SCHEMA.optional(),
  }),
);

/** undo_run takes NO args: it proposes ONE undo for the whole applied run
 * (law #6 — the run applied as one atomic batch, so it undoes as one). */
export const UNDO_RUN_ARGS_SCHEMA = z.strictObject({});

export const SAVE_VERSION_ARGS_SCHEMA = z.strictObject({
  label: z.string().min(1).max(MAX_TOOL_NAME_LENGTH).optional(),
});

// -- round-12 additions ("Tool catalog v3") ----------------------------------

/**
 * Engine command-id shape (mirrors the command-registry id grammar): a
 * lowercase-prefixed dotted identifier like `comp.new` — sanity only; the
 * ALLOWED catalog is the authority and is checked server-side at turn time.
 */
const ENGINE_COMMAND_ID_SCHEMA = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/, {
    message: "command must be a dotted engine command id (e.g. category.action)",
  })
  .refine((v) => !isDunderKey(v), { message: "dunder keys are not valid ids" });

/**
 * `studio.engine_commands` steps: the model's steps ARE the batch payload.
 * Command ids are validated against the generated ALLOWED catalog server-side
 * at turn time (unknown/denied id → typed repairable tool error naming the
 * closest catalog id); params are the bounded dunder-safe passthrough. Risk
 * floor medium (design doc); HIGH (destructive/denied) never enters the list.
 */
export const ENGINE_COMMANDS_ARGS_SCHEMA = withArgsSizeBound(
  z.strictObject({
    steps: z
      .array(
        z.strictObject({
          command: ENGINE_COMMAND_ID_SCHEMA,
          params: PASSTHROUGH_RECORD_SCHEMA,
        }),
      )
      .min(1)
      .max(MAX_ENGINE_COMMAND_STEPS),
  }),
);

/**
 * `studio.run_script`: JavaScript editing code executed at APPLY time via the
 * engine's sandboxed script seam (never inside a batch — the engine's
 * NOT_IN_BATCH refuses script.run there). Bounds: ≤ 20 000 chars; the
 * server adds the static guard (no require/fetch/eval outside comments);
 * risk floor medium, intent `animate` (the scripting object model is the
 * animation/rig seam).
 */
export const RUN_SCRIPT_ARGS_SCHEMA = withArgsSizeBound(
  z.strictObject({
    code: z.string().min(1).max(MAX_SCRIPT_CODE_LENGTH),
  }),
);

/**
 * `studio.add_asset`: inline SVG markup → engine vector import (the string-based
 * seam only — no filesystem ids ever). `kind` pins the v1 shape to "svg".
 */
export const ADD_ASSET_ARGS_SCHEMA = withArgsSizeBound(
  z.strictObject({
    kind: z.literal("svg"),
    name: SAFE_NAME_SCHEMA,
    svg: z.string().min(1).max(MAX_SVG_LENGTH),
  }),
);

export type CreateCompositionArgs = z.infer<typeof CREATE_COMPOSITION_ARGS_SCHEMA>;
export type CreateTextArgs = z.infer<typeof CREATE_TEXT_ARGS_SCHEMA>;
export type SetPropertiesArgs = z.infer<typeof SET_PROPERTIES_ARGS_SCHEMA>;
export type AddEffectArgs = z.infer<typeof ADD_EFFECT_ARGS_SCHEMA>;
export type SetKeyframesArgs = z.infer<typeof SET_KEYFRAMES_ARGS_SCHEMA>;
export type ApplyPresetArgs = z.infer<typeof APPLY_PRESET_ARGS_SCHEMA>;
export type SaveVersionArgs = z.infer<typeof SAVE_VERSION_ARGS_SCHEMA>;
export type EngineCommandsArgs = z.infer<typeof ENGINE_COMMANDS_ARGS_SCHEMA>;
export type RunScriptArgs = z.infer<typeof RUN_SCRIPT_ARGS_SCHEMA>;
export type AddAssetArgs = z.infer<typeof ADD_ASSET_ARGS_SCHEMA>;

// ---------------------------------------------------------------------------
// Registry: id → args schema (M5-SEAMS seam; every entry is a STRICT ZodObject)
// ---------------------------------------------------------------------------

export const WRITE_TOOL_ARGS_SCHEMAS = {
  create_composition: CREATE_COMPOSITION_ARGS_SCHEMA,
  create_text: CREATE_TEXT_ARGS_SCHEMA,
  set_properties: SET_PROPERTIES_ARGS_SCHEMA,
  add_effect: ADD_EFFECT_ARGS_SCHEMA,
  set_keyframes: SET_KEYFRAMES_ARGS_SCHEMA,
  apply_preset: APPLY_PRESET_ARGS_SCHEMA,
  undo_run: UNDO_RUN_ARGS_SCHEMA,
  save_version: SAVE_VERSION_ARGS_SCHEMA,
  engine_commands: ENGINE_COMMANDS_ARGS_SCHEMA,
  run_script: RUN_SCRIPT_ARGS_SCHEMA,
  add_asset: ADD_ASSET_ARGS_SCHEMA,
} as const satisfies Readonly<Record<WriteToolId, z.ZodObject>>;

// ---------------------------------------------------------------------------
// Tool definitions (the write-tools half of the §8.4 catalog)
// ---------------------------------------------------------------------------

export interface WriteToolDefinition {
  readonly id: WriteToolId;
  readonly kind: "write";
  /** Risk badge for the plan card (EDITOR_CHAT_UX §6.2) — the plan compiler's
   * per-tool risk FLOOR (riskMax never lowers it). */
  readonly risk: PlanRisk;
  /** Model-facing description. No command ids, no engine internals, and it
   * always states the result is a PROPOSED batch, never an execution. */
  readonly description: string;
  /** STRICT ZodObject the gateway validates before the tool runs (law #2). */
  readonly inputSchema: z.ZodObject;
  readonly returns: "proposed-batch";
  /**
   * Round-12 optional plan-intent HINT (§8.6 vocabulary). Absent ⇒ the
   * gateway's WRITE_TOOL_INTENTS fallback ("edit") applies — that server map
   * stays authoritative; this field only lets a tool pin its natural intent
   * (run_script → animate) at the contract source.
   */
  readonly intent?: PlanIntent;
}

/** The write tools: the §M5.1 eight, then the round-12 additions, in order. */
export const WRITE_TOOLS: readonly WriteToolDefinition[] = [
  {
    id: "create_composition",
    kind: "write",
    risk: "medium",
    returns: "proposed-batch",
    description:
      "Propose creating a new composition with a name, optional pixel width/height, optional " +
      "frame rate, optional duration in seconds, and an optional background color (#rrggbb or " +
      "[r, g, b] channels) — the matte behind every layer (a deep void, a white studio). Set the " +
      "background HERE rather than trying to edit the composition afterwards. The result is a " +
      "PROPOSED batch of steps for the user to review — nothing is executed until the user " +
      "applies the plan, and the applied change lands as one undo step.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.create_composition,
  },
  {
    id: "create_text",
    kind: "write",
    risk: "low",
    returns: "proposed-batch",
    description:
      "Propose adding an editable text layer to the active composition: REQUIRED `text` — " +
      "the visible content (1..2000 chars, never empty or placeholder; an empty text is " +
      "always rejected — for a background/void propose a SOLID layer via " +
      "studio.engine_commands instead) — plus optional layer name, position, paragraph box, " +
      "font, style, size, fill and stroke colors (#rrggbb or [r, g, b] channels), stroke width, " +
      "tracking, leading, and an optional starting `opacity` (0..1 fraction, or 1..100 as " +
      "percent — the fade-in starting point; animate it afterwards with " +
      "studio.set_keyframes). The result is a PROPOSED batch for the user to review — " +
      "never executed until the user applies the plan.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.create_text,
  },
  {
    id: "set_properties",
    kind: "write",
    risk: "low",
    returns: "proposed-batch",
    description:
      "Propose setting property values on existing layers, referenced BY NAME: up to 50 named " +
      "layers and up to 100 updates, each a property path and a JSON value (transforms, opacity, " +
      "text content, effect parameters). The result is a PROPOSED batch for the user to review — " +
      "never executed until the user applies the plan. Ambiguous layer names are resolved against " +
      "the open project when the plan is applied.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.set_properties,
  },
  {
    id: "add_effect",
    kind: "write",
    risk: "medium",
    returns: "proposed-batch",
    description:
      "Propose adding an effect to up to 50 existing layers referenced BY NAME. Pass a " +
      "human-readable effect name (never a plugin path) and optional effect parameters. The " +
      "result is a PROPOSED batch for the user to review — never executed until the user applies " +
      "the plan.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.add_effect,
  },
  {
    id: "set_keyframes",
    kind: "write",
    risk: "low",
    returns: "proposed-batch",
    description:
      "Propose keyframes for one property path on existing layers referenced BY NAME: 1..500 " +
      "keys, each with a time in seconds, a JSON value and an optional interpolation of linear, " +
      "bezier or hold. The result is a PROPOSED batch for the user to review — never executed " +
      "until the user applies the plan.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.set_keyframes,
  },
  {
    id: "apply_preset",
    kind: "write",
    risk: "medium",
    returns: "proposed-batch",
    description:
      "Propose applying an animation or style preset to up to 50 target layers referenced BY " +
      "NAME (omit layers to use the current selection). Name the preset by its display name or " +
      "its built-in id, with optional preset arguments. The result is a PROPOSED batch for the " +
      "user to review — never executed until the user applies the plan.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.apply_preset,
  },
  {
    id: "undo_run",
    kind: "write",
    risk: "medium",
    returns: "proposed-batch",
    description:
      "Propose undoing the entire applied agent run as ONE undo step: the run applied as one " +
      "atomic batch, so it also undoes as one. Takes no arguments; the run's saved version stays " +
      "in project history. The result is a PROPOSED batch for the user to review — never " +
      "executed until the user applies the plan.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.undo_run,
  },
  {
    id: "save_version",
    kind: "write",
    risk: "low",
    returns: "proposed-batch",
    description:
      "Propose saving an immutable, labeled snapshot of the project (optional label). Snapshots " +
      "never modify project content and always remain in history. The result is a PROPOSED batch " +
      "for the user to review — never executed until the user applies the plan.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.save_version,
  },
  // -- round-12 additions ("Tool catalog v3") ------------------------------
  {
    id: "engine_commands",
    kind: "write",
    risk: "medium",
    returns: "proposed-batch",
    description:
      "Propose a sequence of engine commands as one atomic change: 1-50 steps, each a command id " +
      "(discover ids with the catalog tools) plus its JSON params. Every id is validated against " +
      "the allowed catalog before anything is proposed, and unknown or denied ids come back as a " +
      "repairable error naming the closest allowed id. The result is a PROPOSED batch for the " +
      "user to review — never executed until the user applies the plan, and the applied change " +
      "lands as one undo step.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.engine_commands,
  },
  {
    id: "run_script",
    kind: "write",
    risk: "medium",
    returns: "proposed-batch",
    intent: "animate",
    description:
      "Propose running a JavaScript editing script (up to 20000 characters) against the project at " +
      "apply time — the escape hatch for loops, rigs and generators the per-command tools cannot " +
      "express. The code runs sandboxed with no network or filesystem access and its edits land " +
      "as one undo step. The result is a PROPOSED batch for the user to review — never executed " +
      "until the user applies the plan.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.run_script,
  },
  {
    id: "add_asset",
    kind: "write",
    risk: "medium",
    returns: "proposed-batch",
    description:
      "Propose adding a vector asset to the active composition from inline SVG markup (up to " +
      "50000 characters) with a given name — no files or paths, the markup itself becomes a " +
      "shape layer that later steps can reference. The result is a PROPOSED batch for the user " +
      "to review — never executed until the user applies the plan, and the applied change lands " +
      "as one undo step.",
    inputSchema: WRITE_TOOL_ARGS_SCHEMAS.add_asset,
  },
];

// ---------------------------------------------------------------------------
// Tool result envelope (every write tool returns this, nothing else)
// ---------------------------------------------------------------------------

/**
 * The proposed-batch tool result envelope. `proposedBatch` mirrors the §8.5
 * batch steps (the same shape §8.6 plans carry as data); `note` always tells
 * the model the batch is proposed, never executed. The dunder/JSON guards
 * run in `z.preprocess` on the RAW payload — step params are records, and
 * Zod's record rebuild silently drops own `__proto__` keys before output
 * refinements run (see PASSTHROUGH_RECORD_SCHEMA) — and the whole envelope
 * is bounded to the §8.5 2 MB payload.
 */
export const WRITE_TOOL_RESULT_SCHEMA = z.preprocess(
  (raw, ctx) => {
    for (const issue of freeFormValueIssues(raw)) {
      ctx.addIssue({ code: "custom", message: issue.message });
    }
    return raw;
  },
  z
    .strictObject({
      proposedBatch: z.strictObject({
        label: z.string().min(1).max(MAX_BATCH_LABEL_LENGTH),
        steps: z.array(BATCH_STEP_SCHEMA).min(1).max(MAX_BATCH_STEPS),
      }),
      note: z.string().min(1).max(MAX_RESULT_NOTE_LENGTH),
    })
    .superRefine((result, ctx) => {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(result.proposedBatch);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["proposedBatch"],
          message: "proposed batch must be JSON-serializable",
        });
        return;
      }
      if (serialized !== undefined && serialized.length > MAX_BATCH_BYTES) {
        ctx.addIssue({
          code: "custom",
          path: ["proposedBatch"],
          message: `proposed batch exceeds the ${MAX_BATCH_BYTES}-byte serialized limit`,
        });
      }
    }),
);

export type WriteToolResult = z.infer<typeof WRITE_TOOL_RESULT_SCHEMA>;

/** Canonical note for write-tool results (always ≤ MAX_RESULT_NOTE_LENGTH). */
export const PROPOSED_BATCH_NOTE =
  "Proposed batch only — nothing is executed until the user applies the plan.";

/**
 * The TRUTHFUL note for auto-applicable carriers (2026-11-01 root-cause fix).
 *
 * The old single note told the model "nothing is executed until the user
 * applies the plan" on EVERY write result — while the live-apply pipeline was
 * applying reversible carriers automatically at each turn's end. The model
 * read the contradiction, watched the canvas, and when a proposal failed to
 * apply it concluded its work had vanished and re-proposed the composition
 * from scratch (run 59cead8c: steps 10-11 duplicated steps 1-2 verbatim).
 * Auto-applicable carriers (create/edit/style/animate — everything the §7.3
 * gate passes) now say what actually happens; the review-waiting note stays
 * for the organize-intent carriers (undo_run / save_version) and anywhere
 * auto-apply genuinely cannot run.
 */
export const AUTO_APPLY_BATCH_NOTE =
  "Proposed batch — it applies automatically when this turn finishes (one Undo reverts it).";
