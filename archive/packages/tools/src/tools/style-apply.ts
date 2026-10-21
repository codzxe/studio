// style_apply — §6 row 10: layer styles + adjustment layers from a style/preset.
//
// Engine ids are grep-verified, never invented (§2.2 "never hardcode blindly"):
//   - layer.layerStyle.{dropShadow,stroke,colorOverlay,gradientOverlay,innerShadow,
//     outerGlow,bevelEmboss,clear} — engine-client/src/commands.ts EFFECT_COMMANDS;
//     vendor crates/engine/src/layer_style.rs specs() (style_cmd! kinds + clear).
//   - layer.newAdjustmentLayer.{levels,curves,hueSaturation,brightnessContrast} —
//     engine-client/src/commands.ts ADJUSTMENT_COMMANDS; vendor commands.rs ADJ
//     table (exact suffix casing: hueSaturation, brightnessContrast).
//   - layer.select — engine-client/src/commands.ts LAYER_COMMANDS, used only to
//     place a single-target adjustment layer above the named layer.
// Engine param units verified against vendor layer_style.rs overlay_effect() and
// commands.rs explicit_layer(): `layer` takes an id (number) or name (string),
// `opacity` is 0..100 (the tool takes 0..1), sizes/distances are px, angles degrees.
// The shadow offset model is inverted from vendor crates/compose/src/effects.rs
// offset(): dx = round(-cos(angle)·distance), dy = round(sin(angle)·distance).
// Tools import nothing from @studio/engine-client (README "Layout": the seams in
// types.ts are structural); the ids above are pinned here with citations instead.

import { z } from "zod";
import {
  type LayerRef,
  cappedArray,
  cappedRecord,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
  ToolError,
  zColor,
  zIdempotencyKey,
  zLayerRef,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import type { EngineCommand, Tool } from "../types.js";

// ---------------------------------------------------------------------------
// Limits (§6.1: every argument is capped)
// ---------------------------------------------------------------------------

/** Task cap: at most 50 target layers per call; one command per layer. */
export const MAX_TARGET_LAYERS = 50;
/** Adjustment params are passthrough but bounded: ≤ 20 keys per object level. */
export const MAX_ADJ_PARAM_KEYS = 20;
/** Longest nested array inside adjustment params (curve point lists). */
const MAX_ADJ_PARAM_ARRAY_ITEMS = 64;
/** Longest string inside adjustment params (adjustment kinds take numbers mostly). */
const MAX_ADJ_PARAM_STRING_CHARS = 200;
/** Object/array nesting levels below `params`; bounds recursion depth. */
const MAX_ADJ_PARAM_DEPTH = 3;
/** Layers actually named in a summary before "(+N more)" (§6.1 small replies). */
const MAX_SUMMARY_LAYER_LIST = 10;

// ---------------------------------------------------------------------------
// Engine command ids (§2.2 — see file header for the grep citations)
// ---------------------------------------------------------------------------

/** Layer-style kinds → engine ids (vendor layer_style.rs style_cmd! concat!s). */
const STYLE_COMMAND_IDS = {
  drop_shadow: "layer.layerStyle.dropShadow",
  stroke: "layer.layerStyle.stroke",
  color_overlay: "layer.layerStyle.colorOverlay",
  gradient_overlay: "layer.layerStyle.gradientOverlay",
  inner_shadow: "layer.layerStyle.innerShadow",
  outer_glow: "layer.layerStyle.outerGlow",
  bevel_emboss: "layer.layerStyle.bevelEmboss",
} as const;

/** §6 row 10: style clear → layer.layerStyle.clear. */
const CLEAR_COMMAND_ID = "layer.layerStyle.clear";

/** §2.2 Layer ops: new adjustment layers are inserted above the active layer,
 * so a single-target adjustment first selects that layer. */
const SELECT_COMMAND_ID = "layer.select";

/** Tool adjustment types → engine ids (ADJ table suffix casing). */
const ADJUSTMENT_COMMAND_IDS = {
  levels: "layer.newAdjustmentLayer.levels",
  curves: "layer.newAdjustmentLayer.curves",
  hue_saturation: "layer.newAdjustmentLayer.hueSaturation",
  brightness_contrast: "layer.newAdjustmentLayer.brightnessContrast",
} as const;

/** Planner-facing kind labels (snake_case kinds are never shown as-is). */
const KIND_LABELS = {
  drop_shadow: "drop shadow",
  stroke: "stroke",
  color_overlay: "color overlay",
  gradient_overlay: "gradient overlay",
  inner_shadow: "inner shadow",
  outer_glow: "outer glow",
  bevel_emboss: "bevel/emboss",
} as const;

// ---------------------------------------------------------------------------
// Colour normalization — the engine parses "#rrggbb" pair-wise (vendor
// layer_style.rs color_of(): strings need ≥ 6 hex digits), so every §6.1 colour
// form is converted to 6-digit hex before it reaches a command.
// ---------------------------------------------------------------------------

export interface NormalizedColor {
  /** `#rrggbb`, lowercase — the only string form the engine parses losslessly. */
  readonly hex: string;
  /** rgba()/hsla() alpha < 1: not representable in a layer-style colour. */
  readonly droppedAlpha: boolean;
}

/** Converts one §6.1 colour (pre-validated by zColor) to engine hex. */
export function normalizeColor(color: string): NormalizedColor {
  if (color.startsWith("#")) {
    const body = color.slice(1);
    const hex = body.length === 3 ? body.replace(/(.)/g, "$1$1") : body;
    return { hex: `#${hex.toLowerCase()}`, droppedAlpha: false };
  }
  // zColor guarantees the shapes, so plain number extraction is safe.
  const numbers = color.match(/[0-9.]+/g) ?? [];
  const alpha = numbers.length >= 4 ? Number(numbers[3]) : 1;
  if (color.startsWith("rgb")) {
    return {
      hex: rgbToHex(Number(numbers[0]), Number(numbers[1]), Number(numbers[2])),
      droppedAlpha: alpha < 1,
    };
  }
  const [r, g, b] = hslToRgb(Number(numbers[0]), Number(numbers[1]), Number(numbers[2]));
  return { hex: rgbToHex(r, g, b), droppedAlpha: alpha < 1 };
}

function rgbToHex(r: number, g: number, b: number): string {
  const pair = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/** Canonical HSL→RGB (hue 0..360 deg, saturation/lightness 0..100). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [chroma, secondary, 0];
  else if (hp < 2) [r, g, b] = [secondary, chroma, 0];
  else if (hp < 3) [r, g, b] = [0, chroma, secondary];
  else if (hp < 4) [r, g, b] = [0, secondary, chroma];
  else if (hp < 5) [r, g, b] = [secondary, 0, chroma];
  else [r, g, b] = [chroma, 0, secondary];
  const lift = light - chroma / 2;
  return [(r + lift) * 255, (g + lift) * 255, (b + lift) * 255];
}

// ---------------------------------------------------------------------------
// Layer references (§6.1: layer_id or layer_name; the engine resolves names)
// ---------------------------------------------------------------------------

/**
 * The engine's `layer` param value: an id (number) or a name (string) — vendor
 * commands.rs explicit_layer(). Numeric layer_id strings become ids; anything
 * else is handed over for the engine to resolve (and to report candidates on).
 */
function layerParamValue(ref: LayerRef): number | string {
  if ("layerId" in ref) {
    return /^\d+$/.test(ref.layerId) ? Number(ref.layerId) : ref.layerId;
  }
  return ref.layerName;
}

/** Compact ref description for summaries and error envelopes (§6.1). */
export function describeLayerRef(ref: LayerRef): string {
  if ("layerId" in ref) {
    return /^\d+$/.test(ref.layerId) ? `layer ${ref.layerId}` : `layer "${ref.layerId}"`;
  }
  return `"${ref.layerName}"`;
}

/** The single target (schema guarantees ≥ 1; typed guard for noUncheckedIndexedAccess). */
function firstTarget(targets: readonly LayerRef[]): LayerRef {
  const first = targets[0];
  if (first === undefined) {
    throw new ToolError("internal_error", "style target list is empty");
  }
  return first;
}

// ---------------------------------------------------------------------------
// Argument schema (§6.1: strict, capped; §6.2 idempotency key on mutating tools)
// ---------------------------------------------------------------------------

/** 0..1 ratios (opacity, intensity) — converted to the engine's 0..100 percent. */
const zUnitRatio = z.number().finite().min(0).max(1);

/** A passthrough adjustment-params value: bounded JSON (numbers/bools/short
 * strings/bounded arrays and records) — semantic validation is the engine's
 * from_params() job; §6.1 only demands the argument be bounded. */
type AdjustmentParamValue =
  | number
  | boolean
  | string
  | readonly AdjustmentParamValue[]
  | { readonly [key: string]: AdjustmentParamValue };

const zAdjustmentLeaf = z.union([
  z.number().finite(),
  z.boolean(),
  cappedString(MAX_ADJ_PARAM_STRING_CHARS),
]);

function zAdjustmentValue(depth: number): z.ZodType<AdjustmentParamValue> {
  if (depth === 0) {
    return zAdjustmentLeaf;
  }
  const inner = zAdjustmentValue(depth - 1);
  return z.union([
    zAdjustmentLeaf,
    cappedArray(MAX_ADJ_PARAM_ARRAY_ITEMS, inner),
    cappedRecord(MAX_ADJ_PARAM_KEYS, inner),
  ]);
}

const zStyle = z.discriminatedUnion("kind", [
  strictObject({
    kind: z.literal("drop_shadow"),
    color: zColor,
    opacity: zUnitRatio,
    offsetX: z.number().finite().min(-2000).max(2000),
    offsetY: z.number().finite().min(-2000).max(2000),
    blur: z.number().finite().min(0).max(100),
  }),
  strictObject({
    kind: z.literal("stroke"),
    color: zColor,
    width: z.number().finite().min(0).max(50),
    position: z.enum(["outside", "center", "inside"]),
  }),
  strictObject({ kind: z.literal("color_overlay"), color: zColor, opacity: zUnitRatio }),
  strictObject({
    kind: z.literal("gradient_overlay"),
    from: zColor,
    to: zColor,
    angle: z.number().finite().min(0).max(360),
  }),
  strictObject({ kind: z.literal("inner_shadow"), color: zColor, intensity: zUnitRatio }),
  strictObject({ kind: z.literal("outer_glow"), color: zColor, intensity: zUnitRatio }),
  strictObject({ kind: z.literal("bevel_emboss"), color: zColor, intensity: zUnitRatio }),
  strictObject({
    kind: z.literal("adjustment"),
    type: z.enum(["levels", "curves", "hue_saturation", "brightness_contrast"]),
    params: cappedRecord(MAX_ADJ_PARAM_KEYS, zAdjustmentValue(MAX_ADJ_PARAM_DEPTH)),
  }),
  strictObject({ kind: z.literal("clear") }),
]);

export const styleApplyArgsSchema = strictObject({
  /** One layer ref, or up to MAX_TARGET_LAYERS refs (one command per layer). */
  target: z.union([zLayerRef, cappedArray(MAX_TARGET_LAYERS, zLayerRef).min(1)]),
  style: zStyle,
  /** §14.2: mutating tools carry an idempotency key (§6 tool contract). */
  idempotencyKey: zIdempotencyKey,
});

export type StyleApplyArgs = z.infer<typeof styleApplyArgsSchema>;
export type StyleSpec = StyleApplyArgs["style"];
/** The 7 per-layer style kinds (adjustment and clear are handled separately). */
export type LayerStyleSpec = Exclude<StyleSpec, { kind: "adjustment" | "clear" }>;

// ---------------------------------------------------------------------------
// Command planning (pure — table-tested)
// ---------------------------------------------------------------------------

export interface StyleCommandPlan {
  /** The transactional batch to send (§6.2 ctx.engine.batch). */
  readonly commands: readonly EngineCommand[];
  /** Aggregated warnings for the ok() envelope (≤ 20 × 500, §6.1). */
  readonly warnings: readonly string[];
  /** §6.1 compact reply: what changed and what is next, never an engine dump. */
  readonly summary: string;
  /** Per command: the layer it addresses (undefined for document-wide creates). */
  readonly refs: readonly (string | undefined)[];
}

const ALPHA_WARNING =
  "alpha in rgba()/hsla() colour values is not applied to layer styles; use the style's opacity field instead";
const BEVEL_COLOR_WARNING =
  "bevel_emboss colour is not applied: the engine's bevel command exposes no highlight/shadow colour parameters";

/** Engine opacity percent from the tool's 0..1 ratio. */
function percent01(ratio: number): number {
  return Math.round(ratio * 100);
}

function listTargets(targets: readonly LayerRef[]): string {
  const shown = targets.slice(0, MAX_SUMMARY_LAYER_LIST).map(describeLayerRef).join(", ");
  const more =
    targets.length > MAX_SUMMARY_LAYER_LIST
      ? ` (+${targets.length - MAX_SUMMARY_LAYER_LIST} more)`
      : "";
  return `${shown}${more}`;
}

/** §6 row 10 batching: layer styles and clear apply one command per target. */
function styleParamsFor(style: LayerStyleSpec, warnings: string[]): Record<string, unknown> {
  const color = (value: string): string => {
    const normalized = normalizeColor(value);
    if (normalized.droppedAlpha) {
      warnings.push(ALPHA_WARNING);
    }
    return normalized.hex;
  };
  switch (style.kind) {
    case "drop_shadow": {
      // Invert the engine's angle+distance model so the model's cartesian offset
      // survives: dx = round(-cos(angle)·distance), dy = round(sin(angle)·distance)
      // (vendor compose/effects.rs offset()). useGlobalLight:false pins the
      // per-effect angle (factory default true would read the global light).
      const distance = Math.hypot(style.offsetX, style.offsetY);
      const angle =
        distance > 0
          ? ((Math.atan2(style.offsetY, -style.offsetX) * 180) / Math.PI + 360) % 360
          : undefined;
      return {
        color: color(style.color),
        opacity: percent01(style.opacity),
        size: style.blur,
        ...(angle === undefined
          ? { distance: 0 }
          : { angle, distance, useGlobalLight: false }),
      };
    }
    case "stroke":
      return { size: style.width, position: style.position, color: color(style.color) };
    case "color_overlay":
      return { color: color(style.color), opacity: percent01(style.opacity) };
    case "gradient_overlay":
      return { from: color(style.from), to: color(style.to), angle: style.angle };
    case "inner_shadow":
      return { color: color(style.color), opacity: percent01(style.intensity) };
    case "outer_glow":
      return { color: color(style.color), opacity: percent01(style.intensity) };
    case "bevel_emboss": {
      // intensity maps to `depth` (engine command units 1..1000, vendor
      // layer_style.rs: bv.depth = depth/100). The colour is schema-required but
      // the engine's bevelEmboss command takes no colour params — warn, never fail.
      if (normalizeColor(style.color).droppedAlpha) {
        warnings.push(ALPHA_WARNING);
      }
      warnings.push(BEVEL_COLOR_WARNING);
      return { depth: Math.round(style.intensity * 1000) };
    }
    default: {
      const exhaustive: never = style;
      throw new ToolError("internal_error", `unreachable style kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Compiles a style + targets into the transactional engine batch:
 *   - layer styles and clear → one command per target layer;
 *   - adjustment → the engine's layer.newAdjustmentLayer.<kind> takes no layer
 *     param (it inserts above the ACTIVE layer), so one layer is created per
 *     call: above the single target (select + create), else above the active
 *     layer with a warning for multi-target calls.
 */
export function planStyleCommands(
  style: StyleSpec,
  targets: readonly LayerRef[],
): StyleCommandPlan {
  const warnings: string[] = [];
  const layerWord = targets.length === 1 ? "layer" : "layers";

  if (style.kind === "clear") {
    return {
      commands: targets.map((ref) => ({
        id: CLEAR_COMMAND_ID,
        params: { layer: layerParamValue(ref) },
      })),
      warnings,
      summary: `Cleared layer styles on ${targets.length} ${layerWord}: ${listTargets(targets)}`,
      refs: targets.map(describeLayerRef),
    };
  }

  if (style.kind === "adjustment") {
    const label = style.type.replace("_", " ");
    const single = targets.length === 1 ? firstTarget(targets) : undefined;
    const commands: EngineCommand[] = [];
    const refs: (string | undefined)[] = [];
    if (single !== undefined) {
      commands.push({ id: SELECT_COMMAND_ID, params: { layer: layerParamValue(single) } });
      refs.push(describeLayerRef(single));
    } else {
      warnings.push(
        `adjustment layers apply to the whole document below them; one ${label} layer was created above the active layer, not one per target`,
      );
    }
    commands.push({ id: ADJUSTMENT_COMMAND_IDS[style.type], params: { ...style.params } });
    refs.push(undefined);
    return {
      commands,
      warnings,
      summary:
        single !== undefined
          ? `Added a ${label} adjustment layer above ${describeLayerRef(single)}`
          : `Added a ${label} adjustment layer above the active layer`,
      refs,
    };
  }

  const commandId = STYLE_COMMAND_IDS[style.kind];
  const styleParams = styleParamsFor(style, warnings);
  return {
    commands: targets.map((ref) => ({
      id: commandId,
      params: { layer: layerParamValue(ref), ...styleParams },
    })),
    warnings,
    summary: `Styled ${targets.length} ${layerWord} with ${KIND_LABELS[style.kind]}: ${listTargets(
      targets,
    )}`,
    refs: targets.map(describeLayerRef),
  };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

function styleLabel(style: StyleSpec): string {
  return style.kind === "adjustment"
    ? `${style.type.replace("_", " ")} adjustment layer`
    : style.kind === "clear"
      ? "style clear"
      : KIND_LABELS[style.kind];
}

export const styleApplyTool: Tool<StyleApplyArgs> = defineTool({
  name: TOOLS.style_apply,
  description:
    "Apply a non-destructive layer style (drop shadow, stroke, color or gradient overlay, inner shadow, outer glow, bevel) to one or more layers, add an adjustment layer (levels, curves, hue/saturation, brightness/contrast), or clear styles.",
  args: styleApplyArgsSchema,
  async run(ctx, args, signal) {
    const targets: readonly LayerRef[] = Array.isArray(args.target) ? args.target : [args.target];
    const plan = planStyleCommands(args.style, targets);
    ctx.logger.debug("style_apply planned", {
      styleKind: args.style.kind,
      targets: targets.length,
      commands: plan.commands.length,
    });

    // §5.2 clean stop: charge before touching the engine, never mid-batch.
    if (!ctx.budgets.charge({ commands: plan.commands.length })) {
      return err(
        "budget_exceeded",
        `Applying this style needs ${plan.commands.length} commands and would cross the run's command budget`,
        {
          hint: "Split the call: fewer target layers per style_apply, then continue in the next run slice (§5.2).",
          retryable: false,
        },
      );
    }

    const batch = await ctx.engine.batch(plan.commands, { transaction: true, signal });
    if (!batch.ok) {
      return err(batch.code, batch.message.slice(0, 900), {
        hint: batch.hint,
        retryable: batch.retryable,
      });
    }
    const failed = batch.value.outcomes.find((outcome) => !outcome.ok);
    if (failed !== undefined) {
      const index = failed.index ?? batch.value.outcomes.indexOf(failed);
      const where = plan.refs[index] ?? "the active layer";
      const reason = failed.message === undefined ? "" : `: ${failed.message.slice(0, 400)}`;
      return err(
        "validation_failed",
        `The engine rejected this ${styleLabel(args.style)} on ${where}${reason}`,
        {
          hint: "The transactional batch was rolled back — nothing was applied. Check the layer tree with workspace_snapshot, then retry.",
          retryable: false,
        },
      );
    }

    return ok({
      summary: plan.summary,
      documentRevision: batch.value.revision,
      warnings: plan.warnings.length > 0 ? plan.warnings : undefined,
    });
  },
});
