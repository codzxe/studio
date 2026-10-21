// @studio/tools — text_set (spec §6 row 8): create or rewrite editable text, fitted to box.
//
// Engine commands underneath (§6 row 8; ids verified against the pinned vendor, never
// invented):
//   - `type.create` / `type.edit` — vendor crates/engine/src/type_cmds.rs (§2.2 "Text").
//     `type.create` takes paragraph `box:[x,y,w,h]`, `name`, `align` and character keys
//     (`font`, `size`, `color`); its reply carries the new layer id. `type.edit` replaces
//     `text` first, then applies `runs:[{start,end,…}]` (character indices; `end` past the
//     text clamps to its end — type_cmds.rs `byte_at`), so one run `[0, chars)` styles all.
//   - `layout.fitText` — engine-patches/layout_cmds/fit_specs.rs (§2.3): the §9.3 fit
//     (measure → binary-search down to minSize → condensed tracking/ellipsis for
//     single-line slots), applied by the engine with one internal `type.edit`. On overflow
//     it writes NOTHING and reports `overflow:true` + exact `overflowPx`/`overflowChars`
//     (§9.3 step 4: never clip silently). This patch is the preferred path; the fallback
//     keeps the created layer and warns that the size is an unverified estimate.
//   - `type.setStyle` — vendor type_cmds.rs: the registry's alignment carrier. `type.edit`
//     has no paragraph keys (its params list only text/replace/runs/geometry/kerning), so an
//     `align` change on an existing layer goes through `type.setStyle` (§2.2: the live
//     registry is authoritative).
//
// Contract highlights:
//   - Text stays text (§10.1): every word becomes an editable type layer — nothing is
//     baked, rasterized, or hidden inside an image.
//   - §10.2 role names: create rejects machine names ("Layer 3") and non-semantic names;
//     §11.1's `naming` validator double-checks everything later.
//   - §10.2 fonts: the workspace font set only — a missing font is an error with an
//     install hint, never a silent substitution.
//   - §10.1 unique names: creation refuses to duplicate an existing layer name.
//   - The §6 seam's `EngineCommandReport` is deliberately minimal ({revision, message?});
//     conforming adapters attach the command reply under `result` (structural typing —
//     extra fields stay assignable). Fit metrics are read defensively with Zod: without a
//     usable payload the tool degrades to an estimate warning and NEVER claims a verified
//     fit, and an overflow report becomes `text_overflow` with the exact px + §6.1 hint.

import { z } from "zod";
import { TOOLS } from "../registry.js";
import {
  MAX_ARG_STRING_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNING_CHARS,
  ambiguousLayerErr,
  cappedString,
  defineTool,
  err,
  layerNotFoundErr,
  ok,
  strictObject,
  zColor,
  zIdempotencyKey,
  zLayerRef,
  type LayerRef,
} from "../kit.js";
import type {
  EngineCommand,
  EngineCommandReport,
  EngineLayerSummary,
  Tool,
  ToolContext,
  ToolErr,
  ToolResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Verified engine constants (vendor + engine-patches citations inline)
// ---------------------------------------------------------------------------

/** §2.2 Text commands (vendor type_cmds.rs `specs()`). */
const CMD_TYPE_CREATE = "type.create";
const CMD_TYPE_EDIT = "type.edit";
/** Vendor type_cmds.rs: the paragraph-key command (align) `type.edit` lacks. */
const CMD_TYPE_SET_STYLE = "type.setStyle";
/** engine-patches/layout_cmds/fit_specs.rs (§2.3, §9.4). */
const CMD_LAYOUT_FIT_TEXT = "layout.fitText";

/** §9.3/§11.1: never shrink body copy below 12 pt by default (fit_specs' minSize default). */
const MIN_FIT_PT = 12;
/** §6.2 text-slot size range (the example schema's 4..1200 pt). */
const MIN_REQUESTED_PT = 4;
const MAX_REQUESTED_PT = 1200;
/** fit_specs.rs `MAX_BOX_PX` / `MAX_COORD_PX` — mirror the engine or it rejects late. */
const MIN_BOX_PX = 1;
const MAX_BOX_PX = 1_000_000;
const MAX_COORD_PX = 1_000_000_000;
/**
 * `type.edit` run `end` for "style every character" when the text is not being replaced:
 * the engine clamps an out-of-range character index to the text's end (type_cmds.rs
 * `byte_at`), and 1e6 is the engine's own sane line/char ceiling (fit_text.rs `MAX_LINES`).
 */
const RUN_END_ALL_CHARS = 1_000_000;

// ---------------------------------------------------------------------------
// §10.2 name validation (pure, table-tested)
// ---------------------------------------------------------------------------

/** Photoshop-style machine names: "Layer", "Layer 3", "Group 12", "Artboard 2 copy". */
const MACHINE_NAME_RE = /^(?:layer|group|artboard|shape|path|copy)(?:\s+(?:copy|\d+))*$/i;

/**
 * §10.2 text-role names: PascalCase role words ("Headline", "Body Copy", "CTA"), optionally
 * with the spec's ` — <variant>` suffix ("Headline — es", "CTA — 20%" — em dash, §10.2's
 * exact table form). The variant is 1–60 non-empty chars.
 */
const ROLE_NAME_RE =
  /^[A-Z][A-Za-z0-9]*(?:['’-][A-Za-z0-9]+)*(?:\s[A-Z][A-Za-z0-9]*(?:['’-][A-Za-z0-9]+)*)*(?:\s+—\s+\S(?:.{0,59})?)?$/;

/** Is this a machine-generated name §10.1/§10.2 forbid ("no Layer 1, no Group 3")? */
export function isMachineLayerName(name: string): boolean {
  return MACHINE_NAME_RE.test(name);
}

/**
 * Does this name qualify as a §10.2 text-role name? The word pattern AND not a machine
 * name ("Layer" is PascalCase too — the machine family wins over the pattern).
 */
export function isRoleLayerName(name: string): boolean {
  return ROLE_NAME_RE.test(name) && !isMachineLayerName(name);
}

// ---------------------------------------------------------------------------
// Colour normalisation: §6.1 formats → engine hex (pure, table-tested)
// ---------------------------------------------------------------------------

// Same shapes the kit validates (kit.ts `isValidColor`), with one delta: the optional
// alpha is a CAPTURE group here — the kit only validates it, the conversion needs it.
const RGB_COLOR_RE =
  /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*(?:,\s*(1|0|0?\.[0-9]+)\s*)?\)$/i;
const HSL_COLOR_RE =
  /^hsla?\(\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*(?:deg)?\s*,\s*([0-9]{1,3})%\s*,\s*([0-9]{1,3})%\s*(?:,\s*(1|0|0?\.[0-9]+)\s*)?\)$/i;

const hex2 = (n: number): string =>
  Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, "0");

/** h/s/l in the kit's input units (deg, %, %) → "rrggbb". */
function hslToRgbHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = lig - c / 2;
  return `${hex2((r + m) * 255)}${hex2((g + m) * 255)}${hex2((b + m) * 255)}`;
}

/**
 * Converts a §6.1 colour value to the engine's hex form ("#rrggbb", or "#rrggbbAA" when an
 * alpha below 1 is given) — the form `type.create`/`type.edit` parse (type_cmds.rs `color`:
 * a 6/8-digit hex string, or float channels; hex is the compact, stable choice).
 */
export function toEngineColor(color: string): string {
  if (color.startsWith("#")) {
    const hex = color.slice(1).toLowerCase();
    if (hex.length === 3) {
      return `#${hex.charAt(0)}${hex.charAt(0)}${hex.charAt(1)}${hex.charAt(1)}${hex.charAt(2)}${hex.charAt(2)}`;
    }
    return `#${hex}`;
  }
  const rgb = RGB_COLOR_RE.exec(color);
  if (rgb !== null) {
    const base = `${hex2(Number(rgb[1] ?? 0))}${hex2(Number(rgb[2] ?? 0))}${hex2(Number(rgb[3] ?? 0))}`;
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    return alpha < 1 ? `#${base}${hex2(alpha * 255)}` : `#${base}`;
  }
  const hsl = HSL_COLOR_RE.exec(color);
  if (hsl !== null) {
    const base = hslToRgbHex(Number(hsl[1] ?? 0), Number(hsl[2] ?? 0), Number(hsl[3] ?? 0));
    const alpha = hsl[4] === undefined ? 1 : Number(hsl[4]);
    return alpha < 1 ? `#${base}${hex2(alpha * 255)}` : `#${base}`;
  }
  // Unreachable for schema-validated args (zColor); pass through for the engine to reject.
  return color;
}

// ---------------------------------------------------------------------------
// Argument schema — two modes, one strict surface (§6.1)
// ---------------------------------------------------------------------------

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const zAlign = z.enum(["left", "center", "right", "justify"]);
const zFont = cappedString(100, 1).refine((v) => v === v.trim(), {
  message: "font must be a trimmed family name",
});
const zSizePt = z.number().min(MIN_REQUESTED_PT).max(MAX_REQUESTED_PT);
const zTextContent = cappedString(MAX_ARG_STRING_CHARS, 1).refine((v) => v.trim().length > 0, {
  message: "text must contain non-whitespace characters (§10.1: no empty text layers)",
});
const zBounds = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(
    (b) => {
      const [x, y, w, h] = b;
      return (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(w) &&
        Number.isFinite(h) &&
        Math.abs(x) <= MAX_COORD_PX &&
        Math.abs(y) <= MAX_COORD_PX &&
        w >= MIN_BOX_PX &&
        w <= MAX_BOX_PX &&
        h >= MIN_BOX_PX &&
        h <= MAX_BOX_PX
      );
    },
    {
      message:
        "bounds must be [x, y, w, h] px: finite x/y within ±1e9, width/height 1–1000000 (engine box limits)",
    },
  );

/** Create mode: a fitted, named, editable text layer (§10.2 role name required). */
const createArgsSchema = strictObject({
  mode: z.literal("create"),
  name: cappedString(80, 1).refine((v) => v === v.trim() && !CONTROL_CHARS_RE.test(v), {
    message: "name must be a trimmed, single-line layer name",
  }),
  text: zTextContent,
  bounds: zBounds,
  font: zFont,
  size: zSizePt.optional(),
  color: zColor.optional(),
  align: zAlign.optional(),
  idempotencyKey: zIdempotencyKey.optional(),
});

/** Rewrite mode: change text/size/colour/alignment/font of an existing type layer. */
const editArgsSchema = strictObject({
  mode: z.literal("edit"),
  layer: zLayerRef,
  text: zTextContent.optional(),
  size: zSizePt.optional(),
  color: zColor.optional(),
  align: zAlign.optional(),
  font: zFont.optional(),
  idempotencyKey: zIdempotencyKey.optional(),
});

/**
 * The tool's argument schema: two modes in one surface. The superRefine (not a branch
 * refine — `z.discriminatedUnion` only takes plain objects) forces an edit to change
 * something; a no-op rewrite would be a silent success otherwise.
 */
export const textSetArgs = z
  .union([createArgsSchema, editArgsSchema])
  .superRefine((value, issue) => {
    if (
      value.mode === "edit" &&
      value.text === undefined &&
      value.size === undefined &&
      value.color === undefined &&
      value.align === undefined &&
      value.font === undefined
    ) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "an edit needs at least one change: text, size, color, align or font",
      });
    }
  });

export type TextSetArgs = z.infer<typeof textSetArgs>;
type CreateArgs = z.infer<typeof createArgsSchema>;
type EditArgs = z.infer<typeof editArgsSchema>;

// ---------------------------------------------------------------------------
// Engine payload readers (Zod at the engine boundary; §6 seam is structural)
// ---------------------------------------------------------------------------

/**
 * The payload a conforming adapter attaches to the minimal seam report (structural typing:
 * extra fields are assignable). Absent payload = metrics unavailable → estimate warning.
 */
function commandPayload(report: EngineCommandReport): unknown {
  return (report as { readonly result?: unknown }).result;
}

const TYPE_CREATE_RESULT_SCHEMA = z
  .object({
    layer: z.number().int().nonnegative(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

const FIT_TEXT_RESULT_SCHEMA = z
  .object({
    layer: z.number().int().nonnegative().optional(),
    size: z.number().finite(),
    lines: z.number().int().nonnegative(),
    overflow: z.boolean(),
    overflowPx: z.number().finite().optional(),
    overflowChars: z.number().int().nonnegative().optional(),
    warnings: z
      .array(
        z.union([z.string(), z.object({ code: z.string(), message: z.string() }).passthrough()]),
      )
      .optional(),
  })
  .passthrough();

type FitData = z.infer<typeof FIT_TEXT_RESULT_SCHEMA>;

// ---------------------------------------------------------------------------
// Summary builder — the compact §6.1 reply, carrying the fit facts the model needs next
// ---------------------------------------------------------------------------

interface TextSetFacts {
  readonly layerId: number | null;
  readonly name: string | null;
  readonly chosenSize: number | null;
  readonly lines: number | null;
  readonly overflow: boolean | null;
  readonly warnings: readonly string[];
}

/**
 * Serializes the summary facts deterministically (JSON keeps `null` = "not evaluated"
 * distinct from `false` = "verified fitting"). Warnings are capped at 3 entries here; the
 * full list travels in the envelope's `warnings` field.
 */
function buildSummary(facts: TextSetFacts): string {
  const shown = facts.warnings.slice(0, 3);
  if (facts.warnings.length > 3) {
    shown.push(`(+${facts.warnings.length - 3} more)`);
  }
  const json = JSON.stringify({
    layerId: facts.layerId,
    name: facts.name,
    chosenSize: facts.chosenSize,
    lines: facts.lines,
    overflow: facts.overflow,
    warnings: shown,
  });
  return json.length <= MAX_SUMMARY_CHARS
    ? json
    : JSON.stringify({ ...facts, warnings: `(${facts.warnings.length} warnings)` });
}

function pushWarning(warnings: string[], warning: string): void {
  const text =
    warning.length > MAX_WARNING_CHARS ? `${warning.slice(0, MAX_WARNING_CHARS - 1)}…` : warning;
  warnings.push(text);
}

// ---------------------------------------------------------------------------
// Overflow error shape (§9.3 step 4 + §6.1's actionable-error example)
// ---------------------------------------------------------------------------

const roundPx = (n: number): string => String(Math.round(n * 100) / 100);

function overflowMessage(name: string, bounds: readonly number[], fit: FitData): string {
  return (
    `Text layer "${name}" overflows its box [${bounds.join(", ")}] by ${roundPx(fit.overflowPx ?? 0)} px ` +
    `(${fit.overflowChars ?? 0} chars too many at ${roundPx(fit.size)} pt); the engine clipped nothing — ` +
    'the layer was kept, retry with mode "edit"'
  );
}

/**
 * The §6.1 hint shape: "shorten to 40 chars or reduce size to 72pt". Fitting chars come
 * straight from the engine's report (text length − overflowChars). The size is a linear
 * scale estimate on the box's shorter side — the fit already proved no size in
 * [minSize, maxSize] fits, so the suggestion lands below minSize, conservatively for both
 * the width and the height term of the engine's `overflow_px = max(stack−h, widest−w, 0)`.
 */
function overflowHint(
  textLength: number,
  fit: FitData,
  bounds: readonly [number, number, number, number],
): string {
  const px = Math.max(fit.overflowPx ?? 0, 0);
  const chars = Math.max(fit.overflowChars ?? 0, 0);
  const fittingChars = Math.max(1, textLength - chars);
  const shortest = Math.min(bounds[2], bounds[3]);
  const ratio = px > 0 ? shortest / (shortest + px) : 0.99;
  const suggested = Math.max(1, Math.min(fit.size - 1, Math.floor(fit.size * ratio)));
  return `shorten to ${fittingChars} chars or reduce size to ${suggested}pt`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function budgetExhaustedErr(): ToolErr {
  return err("budget_exceeded", "The run's mutating-command budget ran out before text_set finished", {
    hint: "The run stops cleanly here; completed steps stay committed (§5.2 clean stop, partial charge).",
    retryable: false,
  });
}

function fontNotInWorkspaceErr(font: string, fonts: readonly string[]): ToolErr {
  return err("validation_failed", `Font "${font}" is not in the workspace font set`, {
    hint: `Install "${font}" in the workspace fonts, or pick one of: ${fonts.slice(0, 10).join(", ")} (§10.2).`,
    retryable: false,
  });
}

async function listLayersOrNull(ctx: ToolContext): Promise<readonly EngineLayerSummary[] | null> {
  const res = await ctx.engine.listLayers();
  return res.ok ? res.value : null;
}

/** Engine layer ids are u64s; the §6 seam types them as strings. Numeric → number. */
function engineId(id: string): number | null {
  return /^\d+$/.test(id) ? Number(id) : null;
}

/**
 * The `layer` param the engine commands take: a resolved numeric id when known (the engine
 * reads numbers as ids and strings as names — commands.rs `explicit_layer`), else the
 * caller's reference passed through for the engine to resolve.
 */
function layerParamFor(ref: LayerRef, resolvedId: number | null): number | string {
  if (resolvedId !== null) {
    return resolvedId;
  }
  if ("layerName" in ref) {
    return ref.layerName;
  }
  return engineId(ref.layerId) ?? ref.layerId;
}

/**
 * Resolves a layer reference against the compact tree (§6.3's cheap `ls`). Mirrors the
 * engine's own matching (commands.rs `explicit_layer`): exact names first, then
 * case-insensitive. Empty = not found; the caller decides whether the engine may still.
 */
function matchLayers(
  layers: readonly EngineLayerSummary[],
  ref: LayerRef,
): readonly EngineLayerSummary[] {
  if ("layerName" in ref) {
    const exact = layers.filter((l) => l.name === ref.layerName);
    if (exact.length > 0) {
      return exact;
    }
    return layers.filter((l) => l.name.toLowerCase() === ref.layerName.toLowerCase());
  }
  return layers.filter((l) => l.layerId === ref.layerId);
}

const countChars = (text: string): number => [...text].length;

async function findLayerIdByName(ctx: ToolContext, name: string): Promise<number | null> {
  const listed = await listLayersOrNull(ctx);
  if (listed === null) {
    return null;
  }
  const match = listed.find((l) => l.name === name);
  return match === undefined ? null : engineId(match.layerId);
}

const sizeLabel = (size: number | undefined): string =>
  size === undefined ? "engine-default" : `${size}pt`;

// ---------------------------------------------------------------------------
// Create flow: type.create → layout.fitText (§9.3, engine patch preferred)
// ---------------------------------------------------------------------------

async function createText(
  ctx: ToolContext,
  args: CreateArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  const name = args.name;
  if (isMachineLayerName(name)) {
    return err("validation_failed", `Name "${name}" is a machine-generated layer name`, {
      hint: 'Use a §10.2 semantic role name: "Headline", "Subhead", "Body", "Caption", "CTA" — or "Role — variant" like "Headline — es".',
      retryable: false,
    });
  }
  if (!isRoleLayerName(name)) {
    return err("validation_failed", `Name "${name}" is not a §10.2 semantic role name`, {
      hint: 'Role names are PascalCase words with an optional " — variant" suffix, e.g. "Headline", "Body Copy", "CTA — 20%".',
      retryable: false,
    });
  }
  const fonts = ctx.workspace.brandTokens.fonts;
  if (!fonts.includes(args.font)) {
    return fontNotInWorkspaceErr(args.font, fonts);
  }
  // §10.1: names are unique within a document — refuse to mint a duplicate (best-effort
  // read; when the tree is unreadable the engine stays authoritative and creates anyway).
  const listed = await listLayersOrNull(ctx);
  if (listed !== null && listed.some((l) => l.name === name)) {
    return err("validation_failed", `A layer named "${name}" already exists`, {
      hint: `Rewrite it with mode "edit", or use a variant name like "${name} — es" (§10.1: unique names).`,
      retryable: false,
    });
  }

  const box = [args.bounds[0], args.bounds[1], args.bounds[2], args.bounds[3]];
  const createParams: Record<string, unknown> = { name, text: args.text, box, font: args.font };
  if (args.size !== undefined) {
    createParams.size = args.size;
  }
  if (args.color !== undefined) {
    createParams.color = toEngineColor(args.color);
  }
  if (args.align !== undefined) {
    createParams.align = args.align;
  }
  ctx.logger.debug("text_set create", {
    name,
    size: args.size,
    hasColor: args.color !== undefined,
  });
  if (!ctx.budgets.charge({ commands: 1 })) {
    return budgetExhaustedErr();
  }
  const created = await ctx.engine.execute(
    { id: CMD_TYPE_CREATE, params: createParams },
    { signal },
  );
  if (!created.ok) {
    return err(created.code, created.message, { hint: created.hint, retryable: created.retryable });
  }

  let layerId: number | null = null;
  const warnings: string[] = [];
  const createPayload = TYPE_CREATE_RESULT_SCHEMA.safeParse(commandPayload(created.value));
  if (createPayload.success) {
    layerId = createPayload.data.layer;
    for (const warning of createPayload.data.warnings ?? []) {
      pushWarning(warnings, warning);
    }
  }

  // §9.3 via the engine patch. maxSize = the requested size; the engine defaults it to the
  // layer's current size. minSize never exceeds the request (a caption below 12 pt must
  // still be verifiable, not force-shrunk — fit_specs' own floor is the §11.1 body minimum).
  const fitParams: Record<string, unknown> = {
    bounds: box,
    minSize: Math.min(MIN_FIT_PT, args.size ?? MIN_FIT_PT),
  };
  if (layerId !== null) {
    fitParams.layer = layerId;
  }
  if (args.size !== undefined) {
    fitParams.maxSize = args.size;
  }
  if (!ctx.budgets.charge({ commands: 1 })) {
    return budgetExhaustedErr();
  }
  const fit = await ctx.engine.execute({ id: CMD_LAYOUT_FIT_TEXT, params: fitParams }, { signal });

  let revision = created.value.revision;
  let chosenSize: number | null = args.size ?? null;
  let lines: number | null = null;
  let overflow: boolean | null = null;
  if (!fit.ok) {
    // The patch is unavailable on this engine build (§2.2: discover, don't hardcode):
    // keep the created layer, warn that the size is an estimate — never claim a fit.
    pushWarning(
      warnings,
      `layout.fitText unavailable (${fit.code}): size ${sizeLabel(args.size)} is an unverified estimate — re-check with validate_document`,
    );
  } else {
    revision = fit.value.revision;
    const fitPayload = FIT_TEXT_RESULT_SCHEMA.safeParse(commandPayload(fit.value));
    if (!fitPayload.success) {
      pushWarning(
        warnings,
        `layout.fitText replied without usable fit metrics: size ${sizeLabel(args.size)} was not verified — re-check with validate_document`,
      );
    } else {
      const fitData = fitPayload.data;
      if (fitData.layer !== undefined) {
        layerId = fitData.layer;
      }
      for (const warning of fitData.warnings ?? []) {
        pushWarning(
          warnings,
          typeof warning === "string" ? warning : `${warning.code}: ${warning.message}`,
        );
      }
      if (fitData.overflow) {
        // §9.3 step 4: the engine wrote nothing; the created layer keeps its requested
        // size. §6.3's loop: the model reads this error, shortens or shrinks, retries with
        // mode "edit" — the layer is already there to be rewritten.
        return err("text_overflow", overflowMessage(name, box, fitData), {
          hint: overflowHint(countChars(args.text), fitData, args.bounds),
          retryable: false,
        });
      }
      chosenSize = fitData.size;
      lines = fitData.lines;
      overflow = false;
    }
  }
  if (layerId === null) {
    layerId = await findLayerIdByName(ctx, name);
  }
  return ok({
    summary: buildSummary({ layerId, name, chosenSize, lines, overflow, warnings }),
    documentRevision: revision,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

// ---------------------------------------------------------------------------
// Edit flow: type.edit (+ type.setStyle for align), one transactional batch (§6.2)
// ---------------------------------------------------------------------------

async function editText(
  ctx: ToolContext,
  args: EditArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  const ref = args.layer;
  // Best-effort pre-resolution (§6.1: name ambiguity is an error with candidates listed);
  // when the tree is unreadable the engine stays authoritative and resolves the ref itself.
  const listed = await listLayersOrNull(ctx);
  let layerId: number | null = null;
  let layerName: string | null = null;
  if (listed !== null) {
    const candidates = matchLayers(listed, ref);
    if (candidates.length > 1 && "layerName" in ref) {
      return ambiguousLayerErr(ref.layerName, candidates.map((l) => l.layerId));
    }
    const match = candidates[0];
    if (match === undefined) {
      return layerNotFoundErr("layerName" in ref ? ref.layerName : ref.layerId);
    }
    layerId = engineId(match.layerId);
    layerName = match.name;
    // Layer kinds read "Type" for text layers (vendor lib.rs `kind_name`; `layer.list`
    // exposes it as `kind`). Only refuse when the tree positively says otherwise.
    const isText =
      typeof match.kind !== "string" ||
      match.kind.length === 0 ||
      match.kind.toLowerCase() === "type";
    if (!isText) {
      return err(
        "validation_failed",
        `Layer "${match.name}" is a ${match.kind} layer, not a text layer`,
        {
          hint: 'text_set rewrites type layers only; create new text with mode "create" (§6 row 8).',
          retryable: false,
        },
      );
    }
  }
  if (args.font !== undefined && !ctx.workspace.brandTokens.fonts.includes(args.font)) {
    return fontNotInWorkspaceErr(args.font, ctx.workspace.brandTokens.fonts);
  }

  const layerParam = layerParamFor(ref, layerId);
  // One style run covering every character: `type.edit` replaces `text` BEFORE applying
  // `runs`, so the run's end is the NEW text's char count (vendor type_cmds.rs); without a
  // replacement, an out-of-range end clamps to the existing text's end.
  const styleRun: Record<string, unknown> = {
    start: 0,
    end: args.text !== undefined ? countChars(args.text) : RUN_END_ALL_CHARS,
  };
  const editParams: Record<string, unknown> = { layer: layerParam };
  const commands: EngineCommand[] = [];
  if (
    args.text !== undefined ||
    args.size !== undefined ||
    args.color !== undefined ||
    args.font !== undefined
  ) {
    if (args.text !== undefined) {
      editParams.text = args.text;
    }
    if (args.size !== undefined) {
      styleRun.size = args.size;
    }
    if (args.color !== undefined) {
      styleRun.color = toEngineColor(args.color);
    }
    if (args.font !== undefined) {
      styleRun.font = args.font;
    }
    if (args.size !== undefined || args.color !== undefined || args.font !== undefined) {
      editParams.runs = [styleRun];
    }
    commands.push({ id: CMD_TYPE_EDIT, params: editParams });
  }
  if (args.align !== undefined) {
    // type.edit carries no paragraph keys — align goes through type.setStyle (§2.2).
    commands.push({ id: CMD_TYPE_SET_STYLE, params: { layer: layerParam, align: args.align } });
  }
  if (commands.length === 0) {
    // Unreachable through the schema (superRefine); direct callers get a typed guard.
    return err("validation_failed", "An edit needs at least one change", {
      hint: "Pass text, size, color, align or font.",
      retryable: false,
    });
  }

  ctx.logger.debug("text_set edit", {
    byName: "layerName" in ref,
    hasText: args.text !== undefined,
    commands: commands.length,
  });
  if (!ctx.budgets.charge({ commands: commands.length })) {
    return budgetExhaustedErr();
  }
  // Transactional so a text/style change plus an align change land together or not at all
  // (§6.2); the fit inside create mutates, so the edit path owns its atomicity the same way.
  const res = await ctx.engine.batch(commands, { transaction: true, signal });
  if (!res.ok) {
    return res.code === "layer_not_found"
      ? layerNotFoundErr("layerName" in ref ? ref.layerName : ref.layerId)
      : err(res.code, res.message, { hint: res.hint, retryable: res.retryable });
  }
  return ok({
    summary: buildSummary({
      layerId: layerId ?? ("layerName" in ref ? null : engineId(ref.layerId)),
      name: layerName ?? ("layerName" in ref ? ref.layerName : null),
      chosenSize: args.size ?? null,
      // A rewrite keeps the layer's own paragraph box (§9.3 step 5 is the engine's job on
      // create); fit metrics are not re-evaluated here — null reads "not evaluated".
      lines: null,
      overflow: null,
      warnings: [],
    }),
    documentRevision: res.value.revision,
  });
}

// ---------------------------------------------------------------------------
// The tool (§6 row 8)
// ---------------------------------------------------------------------------

export const textSet: Tool<TextSetArgs> = defineTool({
  name: TOOLS.text_set,
  description:
    "Create an editable text layer fitted to its box, or rewrite an existing text layer. " +
    "Text stays editable text; machine names are rejected and overflow is reported, never clipped.",
  args: textSetArgs,
  async run(ctx, args, signal) {
    if (args.mode === "create") {
      return await createText(ctx, args, signal);
    }
    return await editText(ctx, args, signal);
  },
});
