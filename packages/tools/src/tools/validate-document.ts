// @studio/tools — validate_document (§6 row 15): the deterministic lint pass.
//
// Spec anchors:
//   §6 row 15 "Deterministic report (bounds, contrast, overflow, fonts,
//             editability)" — runs in-worker against `document.inspect` output
//             + render analysis; the exact, cheap half of the quality system.
//   §5.1      "Validate before critique": this pass always runs first; the
//             vision critic only sees documents with no blocker.
//   §6.3      The validator is lint/typecheck: same document ⇒ same issues,
//             same order — no LLM anywhere in this file.
//   §10.1     Layer architecture: named layers, smart objects, no degenerate
//             layers, text stays text, z-order sanity.
//   §10.2     Naming conventions + "a missing font is an error with an install
//             hint, never a silent substitution".
//   §11.1     The check table: issue shape { level, code, layer?, message, fix },
//             thresholds (4.5:1 body / 3:1 large text, safe area, blockers).
//
// Engine seams (src/types.ts, minimal on purpose):
//   - `ctx.engine.inspect()`    → canvas + revision + rows (document.inspect).
//   - `ctx.engine.listLayers()` → the compact tree (layer.list). Both vendor
//     listings are TOP-DOWN (frontmost layer first — layer_list_cmds.rs /
//     inspect.rs `.rev()`); this file preserves that order for the z-order
//     check and treats an explicit `zIndex` probe as an override.
//   - The seam's `EngineLayerSummary` declares only id/name/kind/visible/
//     bounds/childCount; the pinned engine's inspect rows additionally carry
//     `opacity` (0..1), `children`, `text: {text, font, sizePt}` and — when the
//     Wave 2 adapter passes them through — colour/fill/smart-object/render-
//     analysis probes. Every extra field is read DEFENSIVELY (present → used,
//     absent → the check degrades to a warning, never a crash, never a guess).
//     Seam gap noted for the registry owner: a first-class `opacity` +
//     `text.color` on EngineLayerSummary would remove the probes.
//
// Template-bound arm (§7.4): with `template` bound the manifest IS the
// rulebook, and the engine owns the manifest-bound rules (mustLayers, slot
// layers/bounds, safeArea, contrast vs the declared background, maxTextLayers,
// palette, role + machine names — engine-patches/template_cmds/validate.rs).
// This tool delegates those to `engine.execute("template.validate")` and adds
// ONLY the document-generic rules the engine pass cannot own (workspace fonts,
// editability/smart objects, z-order, in-bounds, overflow, degenerate layers):
//   generic arm:      in_bounds, safe_area, contrast, text_overflow,
//                     missing_font, editability, z_order, max_text_layers,
//                     empty_layers, naming
//   template arm:     engine issues + [in_bounds, text_overflow, missing_font,
//                     editability, z_order, empty_layers]
//
// Read-only: no budget charge, no idempotency key, freely retryable (§6).

import { z } from "zod";
import {
  MAX_SUMMARY_CHARS,
  defineTool,
  err,
  ok,
  strictObject,
  zTemplateRef,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import { commandPayload } from "./workspace-snapshot.js";
import type {
  EngineCommandReport,
  EngineFailure,
  EngineLayerSummary,
  Tool,
  ToolErr,
} from "../types.js";

// ---------------------------------------------------------------------------
// Args (§6.1 strict schema)
// ---------------------------------------------------------------------------

/** §6 row 15: lint one document, optionally against a bound template's rules. */
export interface ValidateDocumentArgs {
  readonly documentId: string;
  /** `id@version` pin; present ⇒ the engine's template-bound rules run too. */
  readonly template?: string;
}

const argsSchema = strictObject({
  documentId: z.string().uuid(),
  template: zTemplateRef.optional(),
});

// ---------------------------------------------------------------------------
// Contract limits (exported for tests)
// ---------------------------------------------------------------------------

/** The issue cap: the reply is bounded even for a hostile document (§2.2). */
export const MAX_ISSUES = 25;
/** §11.1 `safe_area` default margin (the §7.2 example's `safeArea: 48`). */
export const DEFAULT_SAFE_AREA_PX = 48;
/** Generic-document text budget; template arms use the manifest's own cap. */
export const DEFAULT_MAX_TEXT_LAYERS = 12;
/** §11.1 `contrast`: large display text is ≥ 18 pt (WCAG's large-text cut). */
export const LARGE_TEXT_PT = 18;
export const BODY_CONTRAST = 4.5;
export const LARGE_CONTRAST = 3.0;

/** Names/strings echoed into messages are cut at a char boundary (§6.1). */
const NAME_CAP = 64;
const MESSAGE_CAP = 160;
const FIX_CAP = 140;
/** Render-rounding tolerance for bounds compares, in canvas px (W3-B3 parity). */
const BOUNDS_EPS_PX = 0.5;
/** Float slack so a ratio landing exactly on the threshold passes ("≥"). */
const RATIO_EPS = 1e-9;

/** The engine's template-bound pass (§7.4; engine-patches validate.rs). */
export const TEMPLATE_VALIDATE_COMMAND = "template.validate";

/** Rule ids this file may run locally, in emission order (deterministic). */
export const GENERIC_RULES = [
  "in_bounds",
  "safe_area",
  "contrast",
  "text_overflow",
  "missing_font",
  "editability",
  "z_order",
  "max_text_layers",
  "empty_layers",
  "naming",
] as const;

export type RuleId = (typeof GENERIC_RULES)[number];

/** Document-generic rules the engine's template.validate does not own. */
export const TEMPLATE_ARM_SUPPLEMENT_RULES: readonly RuleId[] = [
  "in_bounds",
  "text_overflow",
  "missing_font",
  "editability",
  "z_order",
  "empty_layers",
];

// ---------------------------------------------------------------------------
// Issues (§11.1 shape)
// ---------------------------------------------------------------------------

export type IssueLevel = "blocker" | "major" | "minor";

export interface ValidationIssue {
  readonly level: IssueLevel;
  readonly code: string;
  readonly layer?: string;
  readonly message: string;
  /** EXACT actionable fix (§6.1): a command-level instruction, never a vague wish. */
  readonly fix: string;
}

const LEVEL_RANK: Readonly<Record<IssueLevel, number>> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function shortName(name: string): string {
  return clip(name, NAME_CAP);
}

// ---------------------------------------------------------------------------
// Pure math (WCAG relative luminance; hostile-number-safe, table-tested)
// ---------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A colour string as 0..255 [r, g, b]; `#RGB` expands, `#RRGGBBAA` drops alpha. */
export function hexToRgb(hex: string): [number, number, number] | undefined {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) return undefined;
  const digits = hex.slice(1);
  if (digits.length === 3) {
    return digits.split("").map((d) => parseInt(d + d, 16)) as [number, number, number];
  }
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
}

/**
 * WCAG 2.x relative luminance of a hex colour: linearize each sRGB channel
 * (c ≤ 0.04045 ? c/12.92 : ((c + 0.055)/1.055)^2.4), then
 * 0.2126R + 0.7152G + 0.0722B. Unparseable input is NaN — callers degrade,
 * they never guess (mirrors engine-patches validate.rs `relative_luminance`).
 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (rgb === undefined) return Number.NaN;
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** The WCAG contrast ratio 1..=21 — lighter over darker, argument order-free. */
export function contrastRatio(foreHex: string, backHex: string): number {
  const a = relativeLuminance(foreHex);
  const b = relativeLuminance(backHex);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** §11.1 `contrast` threshold: 4.5:1 body, 3:1 for large display text. */
export function contrastThresholdFor(sizePt: number | undefined): number {
  return sizePt !== undefined && Number.isFinite(sizePt) && sizePt >= LARGE_TEXT_PT
    ? LARGE_CONTRAST
    : BODY_CONTRAST;
}

// ---------------------------------------------------------------------------
// Pure geometry (mirrors engine-patches validate.rs; NaN is a violation)
// ---------------------------------------------------------------------------

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function finiteBox(b: Box): boolean {
  return [b.x, b.y, b.width, b.height].every((v) => Number.isFinite(v));
}

/** §11.1 `in_bounds`: the box has real overlap with the canvas (a zero-width
 * touch at an edge is NOT an intersection — nothing renders there). */
export function intersectsCanvas(b: Box, canvasW: number, canvasH: number): boolean {
  if (!finiteBox(b) || !Number.isFinite(canvasW) || !Number.isFinite(canvasH)) return false;
  return !(b.x >= canvasW || b.y >= canvasH || b.x + b.width <= 0 || b.y + b.height <= 0);
}

/** §11.1 `safe_area`: the box keeps `safe` px clear of every canvas edge. */
export function withinSafeArea(b: Box, canvasW: number, canvasH: number, safe: number): boolean {
  if (!finiteBox(b) || !Number.isFinite(canvasW) || !Number.isFinite(canvasH)) return false;
  if (!Number.isFinite(safe) || safe < 0) return false;
  return b.x >= safe && b.y >= safe && b.x + b.width <= canvasW - safe &&
    b.y + b.height <= canvasH - safe;
}

/** Render-rounded containment (validate.rs `fits_in`): `inner` sits inside `outer`. */
export function fitsIn(inner: Box, outer: Box, eps = BOUNDS_EPS_PX): boolean {
  if (!finiteBox(inner) || !finiteBox(outer)) return false;
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

// ---------------------------------------------------------------------------
// §10.2 naming (mirrors validate.rs's byte-exact rule)
// ---------------------------------------------------------------------------

const MACHINE_KINDS = ["Layer", "Group", "Shape"] as const;

/** §10.1/§7.5: a machine-generated default name — `Layer 27`, `Group 3`, `Shape 12`. */
export function isMachineName(name: string): boolean {
  const space = name.indexOf(" ");
  if (space <= 0) return false;
  const kind = name.slice(0, space);
  const digits = name.slice(space + 1);
  return (
    (MACHINE_KINDS as readonly string[]).includes(kind) &&
    digits.length > 0 &&
    /^[0-9]+$/.test(digits)
  );
}

const VARIANT_SEP = " — ";
const BRAND_ROLE_NAMES = ["Logo", "Badge", "Watermark"] as const;

/** Strip one trailing ` — <variant>` (§10.2 Variants row: `Headline — es`). */
function baseName(name: string): string {
  const cut = name.lastIndexOf(VARIANT_SEP);
  return cut > 0 && cut + VARIANT_SEP.length < name.length ? name.slice(0, cut) : name;
}

// ---------------------------------------------------------------------------
// Defensive row readers (the seam is minimal; the runtime may be richer)
// ---------------------------------------------------------------------------

type Rec = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function readString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? clip(value, max) : undefined;
}

function readId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return clip(value, 48);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Bounds as `{x,y,width,height}` (the seam) or `[x, y, w, h]` (the vendor rows). */
function readBounds(value: unknown): Box | undefined {
  const record = asRecord(value);
  if (record !== undefined) {
    const x = readNumber(record.x);
    const y = readNumber(record.y);
    const w = readNumber(record.width);
    const h = readNumber(record.height);
    if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
      return { x, y, width: w, height: h };
    }
  }
  if (Array.isArray(value) && value.length >= 4) {
    const x = readNumber(value[0]);
    const y = readNumber(value[1]);
    const w = readNumber(value[2]);
    const h = readNumber(value[3]);
    if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
      return { x, y, width: w, height: h };
    }
  }
  return undefined;
}

/** Opacity 0..1 (layer.setProps range); percent 0..100 normalizes defensively. */
function readOpacity(value: unknown): number | undefined {
  const n = readNumber(value);
  if (n === undefined) return undefined;
  const normalized = n > 1 && n <= 100 ? n / 100 : n;
  return normalized >= 0 && normalized <= 1 ? normalized : undefined;
}

function readFontLike(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? clip(value.trim(), 80) : undefined;
}

/** One flattened row: the engine's top-down order preserved for z-order. */
interface Row {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly visible: boolean;
  readonly opacity?: number;
  readonly bounds?: Box;
  readonly font?: string;
  readonly sizePt?: number;
  readonly color?: string;
  readonly fillColor?: string;
  readonly smartObject?: boolean;
  readonly bakedText?: boolean;
  readonly box?: Box;
  readonly childCount?: number;
  /** Flattened position: frontmost layers first (vendor `.rev()` listings). */
  readonly order: number;
  /** Explicit z probe (`zIndex`/`z`), when the adapter carries one. */
  readonly z?: number;
  readonly children: readonly string[];
}

function kindOf(raw: string): string {
  return raw.trim().toLowerCase();
}

function isTextKind(kind: string): boolean {
  const k = kindOf(kind);
  return k === "type" || k === "text";
}

function isGroupKind(kind: string): boolean {
  return kindOf(kind) === "group";
}

function isImageKind(kind: string): boolean {
  const k = kindOf(kind);
  return k === "pixel" || k === "raster" || k === "image" || k === "photo" || k === "smart object";
}

function readBoolProbe(record: Rec, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const flag = readBool(record[key]);
    if (flag !== undefined) return flag;
  }
  return undefined;
}

function readTextProbe(record: Rec): Rec | undefined {
  return asRecord(record.text) ?? asRecord(record.textLayer);
}

/** Flatten the seam's rows (children depth-first, top-down order preserved). */
function toRow(raw: EngineLayerSummary, order: number, out: Row[], seen: Set<string>): void {
  const record = raw as unknown as Rec;
  const id = readId(record.layerId ?? record.id);
  if (id === undefined || seen.has(id)) return;
  seen.add(id);
  const name = readString(record.name, 120) ?? "";
  const kind = readString(record.kind, 32) ?? "layer";
  const visible = readBool(record.visible) ?? true;
  const opacity = readOpacity(record.opacity);
  const bounds = readBounds(record.bounds);
  const text = readTextProbe(record);
  const font = readFontLike(text?.font ?? record.font);
  const sizePt = readNumber(text?.sizePt ?? text?.size ?? record.sizePt);
  const color = readColorProbe(text, record);
  const smartObject = readBoolProbe(record, ["smartObject", "isSmartObject"]);
  const bakedText = readBoolProbe(record, ["bakedText", "textBaked", "baked_text"]);
  const box = readBounds(text?.box ?? record.textBox ?? record.box);
  const childCountRaw = readNumber(record.childCount);
  const z = readNumber(record.zIndex ?? record.z);
  const children: string[] = [];
  const rawChildren = Array.isArray(record.children) ? record.children : [];
  for (const child of rawChildren) {
    const childName = asRecord(child);
    if (childName !== undefined) children.push(readString(childName.name, 120) ?? "");
  }
  out.push({
    id,
    name,
    kind,
    visible,
    opacity,
    bounds,
    font,
    sizePt,
    color,
    fillColor: readColorProbe(undefined, record, ["fillColor", "fill", "backgroundColor"]),
    smartObject: smartObject === true || kindOf(kind) === "smart object",
    bakedText: bakedText === true,
    box,
    childCount: childCountRaw === undefined ? children.length || undefined : childCountRaw,
    order,
    z,
    children,
  });
  let next = order + 1;
  for (const child of rawChildren) {
    if (typeof child === "object" && child !== null) {
      toRow(child as EngineLayerSummary, next, out, seen);
      next += 1;
    }
  }
}

/**
 * Project the seam's layer rows onto the validator's flattened, id-deduped view.
 * Rows without a usable id are counted as skipped (a warning, never a guess).
 */
export function flattenRows(rows: readonly EngineLayerSummary[]): {
  readonly flat: readonly Row[];
  readonly skipped: number;
} {
  const out: Row[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const walk = (input: readonly EngineLayerSummary[]): void => {
    for (const raw of input) {
      const record = raw as unknown as Rec;
      if (readId(record.layerId ?? record.id) === undefined) {
        skipped += 1;
        continue;
      }
      toRow(raw, out.length, out, seen);
    }
  };
  walk(rows);
  return { flat: out, skipped };
}

/** A colour probe on a text object / row: hex strings only (§6.1 formats). */
function readColorProbe(
  text: Rec | undefined,
  record: Rec,
  keys: readonly string[] = ["color", "colour", "textColor", "fill"],
): string | undefined {
  const sources = [text, record];
  for (const source of sources) {
    if (source === undefined) continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && HEX_RE.test(value)) return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The rules (each pure: rows + settings → issues + degradation notes)
// ---------------------------------------------------------------------------

/** Everything the local rules need; pure so the rule table is unit-testable. */
export interface RuleInput {
  readonly canvasW: number;
  readonly canvasH: number;
  readonly rows: readonly EngineLayerSummary[];
  readonly brandFonts: readonly string[];
  readonly safeAreaPx?: number;
  readonly maxTextLayers?: number;
  /** Which rules run (generic arm vs the template arm's local supplement). */
  readonly rules?: readonly RuleId[];
}

export interface Issues {
  readonly issues: readonly ValidationIssue[];
  readonly notes: readonly string[];
}

class Collector {
  readonly issues: ValidationIssue[] = [];
  readonly notes: string[] = [];

  push(level: IssueLevel, code: string, layer: string | undefined, message: string, fix: string): void {
    const issue: ValidationIssue = { level, code, message: clip(message, MESSAGE_CAP), fix: clip(fix, FIX_CAP) };
    if (layer !== undefined && layer.length > 0) issue.layer = clip(layer, NAME_CAP);
    this.issues.push(issue);
  }

  note(message: string): void {
    if (!this.notes.includes(message)) this.notes.push(message);
  }
}

/** Effective background for the generic contrast check (validate.rs parity). */
export function effectiveBackground(rows: readonly Row[]): string | undefined {
  // Top-down listing ⇒ the BOTTOM-most solid fill named `Background` wins;
  // otherwise the deepest visible solid-fill layer of any name.
  const named: string[] = [];
  const anyFill: string[] = [];
  for (const row of rows) {
    if (!row.visible || row.fillColor === undefined || isTextKind(row.kind)) continue;
    if (baseName(row.name) === "Background") named.push(row.fillColor);
    anyFill.push(row.fillColor);
  }
  if (named.length > 0) return named[named.length - 1];
  return anyFill.length > 0 ? anyFill[anyFill.length - 1] : undefined;
}

function zRank(row: Row): number {
  return row.z !== undefined ? row.z : -row.order;
}

function boundsText(b: Box): string {
  return `[${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.width)}, ${Math.round(b.height)}]`;
}

function normalizeFont(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isEssential(row: Row): boolean {
  if (isTextKind(row.kind)) return true;
  return isImageKind(row.kind) && (BRAND_ROLE_NAMES as readonly string[]).includes(baseName(row.name));
}

function checkInBounds(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  const canvas = `${input.canvasW}×${input.canvasH}`;
  for (const row of rows) {
    if (!row.visible || row.bounds === undefined) continue;
    if (!intersectsCanvas(row.bounds, input.canvasW, input.canvasH)) {
      out.push(
        "blocker",
        "in_bounds",
        row.name,
        `layer "${shortName(row.name)}" at ${boundsText(row.bounds)} is fully outside the ${canvas} canvas`,
        "move it back on canvas (edit.transform, or layout.apply)",
      );
    }
  }
}

function checkSafeArea(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  const safe = input.safeAreaPx ?? DEFAULT_SAFE_AREA_PX;
  for (const row of rows) {
    if (!row.visible || !isEssential(row) || row.bounds === undefined) continue;
    if (!withinSafeArea(row.bounds, input.canvasW, input.canvasH, safe)) {
      out.push(
        "major",
        "safe_area",
        row.name,
        `essential content "${shortName(row.name)}" at ${boundsText(row.bounds)} reaches inside the ${safe} px safe-area margin`,
        `keep essential content at least ${safe} px inside every canvas edge (edit.transform, or layout.apply)`,
      );
    }
  }
}

function checkContrast(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  const textRows = rows.filter((row) => row.visible && isTextKind(row.kind));
  if (textRows.length === 0) return;
  const background = effectiveBackground(rows);
  if (background === undefined) {
    out.note("contrast unchecked: no readable background colour in the layer rows");
    return;
  }
  let unreadable = 0;
  for (const row of textRows) {
    if (row.color === undefined) {
      unreadable += 1;
      continue;
    }
    const required = contrastThresholdFor(row.sizePt);
    const ratio = contrastRatio(row.color, background);
    if (!Number.isFinite(ratio)) {
      unreadable += 1;
      continue;
    }
    if (ratio + RATIO_EPS < required) {
      out.push(
        "blocker",
        "contrast",
        row.name,
        `the text on "${shortName(row.name)}" contrasts ${ratio.toFixed(1)}:1 against the background, below the required ${required}:1`,
        `darken the text or lighten the background until the WCAG ratio reaches ${required}:1 (type.setStyle color / layer.fill.solidColor.set)`,
      );
    }
  }
  if (unreadable > 0) {
    out.note(`contrast skipped for ${unreadable} text layer(s) without a readable colour`);
  }
}

function checkOverflow(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  for (const row of rows) {
    if (!row.visible || !isTextKind(row.kind)) continue;
    if (row.box === undefined || row.bounds === undefined) continue;
    if (fitsIn(row.bounds, row.box)) continue;
    const protrude = Math.max(
      row.box.x - row.bounds.x,
      row.box.y - row.bounds.y,
      row.bounds.x + row.bounds.width - (row.box.x + row.box.width),
      row.bounds.y + row.bounds.height - (row.box.y + row.box.height),
    );
    out.push(
      "blocker",
      "text_overflow",
      row.name,
      `the text on "${shortName(row.name)}" overflows its box by ${Math.max(0, Math.round(protrude))} px (bounds ${boundsText(row.bounds)} vs box ${boundsText(row.box)})`,
      "shorten the text or reduce its size until it fits the box (type.edit, then layout.fitText)",
    );
  }
}

function checkFonts(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  if (input.brandFonts.length === 0) {
    out.note("font check skipped: the workspace declares no fonts");
    return;
  }
  const workspace = new Set(input.brandFonts.map(normalizeFont));
  const known = input.brandFonts.slice(0, 10).join(", ");
  let unreadable = 0;
  for (const row of rows) {
    if (!isTextKind(row.kind) || !row.visible) continue;
    if (row.font === undefined) {
      unreadable += 1;
      continue;
    }
    if (!workspace.has(normalizeFont(row.font))) {
      out.push(
        "blocker",
        "missing_font",
        row.name,
        `the font of "${shortName(row.name)}" ("${shortName(row.font)}") is not in the workspace font set`,
        `install "${shortName(row.font)}" in the workspace fonts, or switch the layer to a workspace font (type.edit font; available: ${known})`,
      );
    }
  }
  if (unreadable > 0) {
    out.note(`font check skipped for ${unreadable} text layer(s) without a readable font`);
  }
}

function checkEditability(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  for (const row of rows) {
    if (!row.visible || !isImageKind(row.kind)) continue;
    if (row.smartObject !== true) {
      out.push(
        "blocker",
        "editability",
        row.name,
        `the image layer "${shortName(row.name)}" is a plain raster, not a smart object (§10.1)`,
        "replace it with a smart object (doc.place smartObject true, or layer.smartObjects.convertToSmartObject)",
      );
    }
    if (row.bakedText) {
      out.push(
        "blocker",
        "editability",
        row.name,
        `the image layer "${shortName(row.name)}" contains baked-in text (§10.1: text stays text)`,
        "recreate the words as an editable text layer (type.create) and drop the baked pixels",
      );
    }
  }
}

function checkZOrder(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  for (const row of rows) {
    if (!row.visible || !isTextKind(row.kind) || row.bounds === undefined) continue;
    const textBounds = row.bounds;
    const cover = rows.find(
      (other) =>
        other.id !== row.id &&
        other.visible &&
        isImageKind(other.kind) &&
        zRank(other) > zRank(row) &&
        (other.opacity ?? 1) >= 0.999 &&
        other.bounds !== undefined &&
        fitsIn(textBounds, other.bounds),
    );
    if (cover !== undefined) {
      out.push(
        "blocker",
        "z_order",
        row.name,
        `the text "${shortName(row.name)}" is hidden behind the opaque image "${shortName(cover.name)}" (§10.1 z-order)`,
        "bring the text above the covering image (layer.arrange.bringToFront on the text, or layer.arrange.sendBackward on the image)",
      );
    }
  }
}

function checkMaxTextLayers(out: Collector, input: RuleInput, rows: readonly Row[]): void {
  const cap = input.maxTextLayers ?? DEFAULT_MAX_TEXT_LAYERS;
  const n = rows.filter((row) => isTextKind(row.kind)).length;
  if (n > cap) {
    out.push(
      "major",
      "max_text_layers",
      undefined,
      `the document carries ${n} text layers; the cap is ${cap}`,
      `hide or remove text layers beyond the cap (layer.setProps visible false, or layer.delete; keep ≤ ${cap})`,
    );
  }
}

function checkEmptyLayers(out: Collector, _input: RuleInput, rows: readonly Row[]): void {
  for (const row of rows) {
    if (row.bounds !== undefined && (row.bounds.width < 1 || row.bounds.height < 1)) {
      out.push(
        "minor",
        "empty_layers",
        row.name,
        `layer "${shortName(row.name)}" is ${Math.round(row.bounds.width)}×${Math.round(row.bounds.height)} px (degenerate)`,
        "delete the leftover or size it properly (layer.delete / edit.transform)",
      );
    }
    if (row.opacity !== undefined && row.opacity <= 0) {
      out.push(
        "minor",
        "empty_layers",
        row.name,
        `layer "${shortName(row.name)}" has zero opacity (a leftover, §10.1)`,
        "delete the leftover or restore its opacity (layer.delete / layer.setProps opacity)",
      );
    }
    if (isGroupKind(row.kind) && row.childCount === 1) {
      const childName = row.children[0] ?? "";
      if (childName.trim().length === 0 || isMachineName(childName)) {
        out.push(
          "minor",
          "empty_layers",
          row.name,
          `group "${shortName(row.name)}" has a single unnamed child (§10.1)`,
          "ungroup it or rename the child after its role (§10.2; layer.setProps name)",
        );
      }
    }
  }
}

function checkNaming(out: Collector, _input: RuleInput, rows: readonly Row[]): void {
  for (const row of rows) {
    if (row.name.trim().length === 0) {
      out.push(
        "minor",
        "naming",
        undefined,
        `layer #${row.id} has no name`,
        "name it after its role (§10.2: Background, Photo — <subject>, Headline, CTA)",
      );
    } else if (isMachineName(row.name)) {
      out.push(
        "minor",
        "naming",
        row.name,
        `"${shortName(row.name)}" is a machine-generated name`,
        "rename it after its role (§10.2: Background, Photo — <subject>, Headline, CTA)",
      );
    }
  }
}

const RULES: Readonly<Record<RuleId, (out: Collector, input: RuleInput, rows: readonly Row[]) => void>> = {
  in_bounds: checkInBounds,
  safe_area: checkSafeArea,
  contrast: checkContrast,
  text_overflow: checkOverflow,
  missing_font: checkFonts,
  editability: checkEditability,
  z_order: checkZOrder,
  max_text_layers: checkMaxTextLayers,
  empty_layers: checkEmptyLayers,
  naming: checkNaming,
};

/**
 * The deterministic local pass (§6.3 lint): one fixed rule order, one issue per
 * violation, NaN-safe math, probe-gated checks degrade to `notes` (surfaced as
 * warnings) instead of guessing. Pure — table-tested with crafted fixtures.
 */
export function collectIssues(input: RuleInput): Issues {
  const rules = input.rules ?? GENERIC_RULES;
  const { flat, skipped } = flattenRows(input.rows);
  const out = new Collector();
  if (skipped > 0) out.note(`${skipped} layer row(s) skipped (no usable id)`);
  for (const rule of rules) {
    RULES[rule](out, input, flat);
  }
  return { issues: sortIssues(out.issues), notes: out.notes };
}

/** Severity first (blockers drive the repair loop, §5.1); `sort` is stable, so the
 * fixed rule-emission order survives within each level (§6.3 determinism). */
export function sortIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

// ---------------------------------------------------------------------------
// Reply shaping: cap 25 → fit the §6.1 2000-char budget → compact JSON
// ---------------------------------------------------------------------------

export interface IssueCounts {
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
}

export function countIssues(issues: readonly ValidationIssue[]): IssueCounts {
  const counts = { blocker: 0, major: 0, minor: 0 };
  for (const issue of issues) counts[issue.level] += 1;
  return counts;
}

/** The 25-issue cap (§2.2 reply budgets): kept rows + the pre-cap total. */
export function capIssues(issues: readonly ValidationIssue[]): {
  readonly kept: readonly ValidationIssue[];
  readonly total: number;
  readonly truncated: boolean;
} {
  return {
    kept: issues.slice(0, MAX_ISSUES),
    total: issues.length,
    truncated: issues.length > MAX_ISSUES,
  };
}

function issueRow(issue: ValidationIssue): Rec {
  const row: { level: string; code: string; layer?: string; message: string; fix: string } = {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    fix: issue.fix,
  };
  if (issue.layer !== undefined) row.layer = issue.layer;
  return row;
}

/** §6.1 compact-reply rule is the hard ceiling: shed from the tail (minors first).
 * The candidate mirrors `renderSummary`'s exact shape, suffix included, so a
 * "fits" verdict here is a fits verdict there (worst case `truncated:false`). */
function fitToBudget(prefix: string, issues: readonly ValidationIssue[]): {
  readonly kept: readonly ValidationIssue[];
  readonly truncated: boolean;
} {
  let kept = issues;
  let truncated = false;
  while (kept.length > 1) {
    const head = kept.slice(0, -1);
    const candidate = `${prefix}${JSON.stringify(head.map(issueRow))},"truncated":false}`;
    truncated = true;
    if (candidate.length <= MAX_SUMMARY_CHARS) {
      kept = head;
      break;
    }
    kept = head;
  }
  return { kept, truncated };
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly issueCounts: IssueCounts;
  readonly issues: readonly ValidationIssue[];
  readonly truncated: boolean;
  readonly template?: string;
  readonly warnings: readonly string[];
}

/** Counts over EVERY issue; the visible list is the capped, budget-fitted tail. */
export function buildReport(issues: readonly ValidationIssue[], options: {
  readonly template?: string;
  readonly extraWarnings?: readonly string[];
} = {}): ValidationReport {
  const sorted = sortIssues(issues);
  const counts = countIssues(sorted);
  const capped = capIssues(sorted);
  const prefixParts = [
    `"ok":${counts.blocker === 0}`,
    `"issueCounts":{"blocker":${counts.blocker},"major":${counts.major},"minor":${counts.minor}}`,
  ];
  if (options.template !== undefined) prefixParts.push(`"template":${JSON.stringify(options.template)}`);
  const fit = fitToBudget(`{${prefixParts.join(",")},"issues":`, capped.kept);
  const warnings = [...(options.extraWarnings ?? [])];
  if (capped.truncated) {
    warnings.push(
      `issue list capped at ${MAX_ISSUES} (${sorted.length} total); fix blockers first, then re-validate`,
    );
  } else if (fit.truncated) {
    warnings.push(
      `summary budget reached: showing ${fit.kept.length} of ${sorted.length} issues; fix blockers first, then re-validate`,
    );
  }
  return {
    ok: counts.blocker === 0,
    issueCounts: counts,
    issues: fit.kept,
    truncated,
    template: options.template,
    warnings,
  };
}

/** The summary the model sees: compact JSON (fleet precedent, §6.1 string envelope). */
export function renderSummary(report: ValidationReport): string {
  const prefixParts = [
    `"ok":${report.ok}`,
    `"issueCounts":{"blocker":${report.issueCounts.blocker},"major":${report.issueCounts.major},"minor":${report.issueCounts.minor}}`,
  ];
  if (report.template !== undefined) prefixParts.push(`"template":${JSON.stringify(report.template)}`);
  prefixParts.push(`"issues":${JSON.stringify(report.issues.map(issueRow))}`);
  prefixParts.push(`"truncated":${report.truncated}`);
  return `{${prefixParts.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Engine template.validate delegation (§7.4)
// ---------------------------------------------------------------------------

export interface EngineValidateReply {
  readonly issues: readonly ValidationIssue[];
  readonly dropped: number;
  readonly truncated: boolean;
}

function readLevel(value: unknown): IssueLevel | undefined {
  return value === "blocker" || value === "major" || value === "minor" ? value : undefined;
}

/**
 * The engine's `{ ok, issues, truncated }` reply (validate.rs), read defensively
 * off the minimal `EngineCommandReport` seam via the adapter's payload
 * convention (`result`/`value`/… or JSON in `message`). Malformed rows are
 * dropped and counted, never guessed.
 */
export function readValidateReport(report: EngineCommandReport): EngineValidateReply | undefined {
  const payload = commandPayload(report);
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  const rows = Array.isArray(record.issues) ? record.issues : undefined;
  if (rows === undefined) return undefined;
  const issues: ValidationIssue[] = [];
  let dropped = 0;
  for (const row of rows) {
    const r = asRecord(row);
    const level = readLevel(r?.level);
    const code = readString(r?.code, 64);
    const message = readString(r?.message, MESSAGE_CAP);
    const fix = readString(r?.fix, FIX_CAP);
    if (level === undefined || code === undefined || message === undefined || fix === undefined) {
      dropped += 1;
      continue;
    }
    const issue: ValidationIssue = { level, code, message, fix };
    const layer = readString(r?.layer, NAME_CAP);
    if (layer !== undefined) issue.layer = layer;
    issues.push(issue);
  }
  return { issues, dropped, truncated: record.truncated === true };
}

// ---------------------------------------------------------------------------
// Failure mapping (mirror workspace-snapshot's inspect ladder)
// ---------------------------------------------------------------------------

const RETRYABLE_ENGINE_CODES: ReadonlySet<string> = new Set([
  "engine_timeout",
  "engine_unavailable",
  "engine_crashed",
  "rate_limited",
  "provider_unhealthy",
]);

function retryableFor(code: string, engineValue: boolean | undefined): boolean {
  return engineValue ?? RETRYABLE_ENGINE_CODES.has(code);
}

/** The core read failed: no canvas, nothing to lint — the mapped envelope. */
function inspectFailure(failure: EngineFailure): ToolErr {
  return err(failure.code, `The document could not be read: ${clip(failure.message, 300)}`, {
    hint:
      failure.hint ??
      "The engine session may not have this document open. Retry validate_document once; then stop cleanly.",
    retryable: retryableFor(failure.code, failure.retryable),
  });
}

// ---------------------------------------------------------------------------
// The tool (§6 row 15, §6.2 shape)
// ---------------------------------------------------------------------------

export const validateDocument: Tool<ValidateDocumentArgs> = defineTool({
  name: TOOLS.validate_document,
  description:
    "Deterministic document lint (bounds, safe area, contrast, overflow, fonts, editability, z-order); pass a template pin to add its manifest-bound rules.",
  args: argsSchema,
  async run(ctx, args, signal) {
    // Core read (document.inspect): failing here means nothing to lint (§6.1).
    const inspected = await ctx.engine.inspect();
    if (!inspected.ok) return inspectFailure(inspected);
    const snapshot = inspected.value;

    // Layer rows: layer.list first, document.inspect rows as the fallback.
    let rows: readonly EngineLayerSummary[] = snapshot.layers;
    const warnings: string[] = [];
    const listed = await ctx.engine.listLayers();
    if (listed.ok) {
      rows = listed.value;
    } else {
      warnings.push(`layer.list unavailable (${listed.code}); layer rows from document.inspect`);
    }
    if (rows.length === 0) {
      return err("validation_failed", "The document has no layers to validate", {
        hint: "Add content first (template.apply or text_set), then validate (§11.1).",
        retryable: false,
      });
    }
    // A tree with no USABLE rows is just as empty — never lint-guess, never pass
    // an unreadable document on to the critic (§5.1 validate before critique).
    if (flattenRows(rows).flat.length === 0) {
      return err("validation_failed", "The document's layer rows could not be read", {
        hint: "Re-validate once after re-opening the document; then stop cleanly.",
        retryable: true,
      });
    }

    const canvasW = Number.isFinite(snapshot.widthPx) ? snapshot.widthPx : 0;
    const canvasH = Number.isFinite(snapshot.heightPx) ? snapshot.heightPx : 0;
    let issues: readonly ValidationIssue[] = [];
    let templatePin: string | undefined;

    if (args.template === undefined) {
      // Generic arm: the full local rulebook over inspect/list rows (§11.1).
      const pass = collectIssues({
        canvasW,
        canvasH,
        rows,
        brandFonts: ctx.workspace.brandTokens.fonts,
      });
      issues = pass.issues;
      warnings.push(...pass.notes);
    } else {
      // Template arm: delegate the manifest-bound rules to the engine (§7.4),
      // then add only the document-generic rules the engine pass cannot own.
      templatePin = args.template;
      const manifest = await ctx.templates.get(args.template);
      if (manifest === undefined) {
        let candidates: readonly string[] = [];
        try {
          const summaries = await ctx.templates.list();
          candidates = summaries
            .map((s) => `${s.id}@${s.version}`)
            .sort()
            .slice(0, 8);
        } catch {
          candidates = [];
        }
        return err("not_found", `Template "${args.template}" is not in the workspace catalog`, {
          hint:
            candidates.length > 0
              ? `Known templates: ${candidates.join(", ")}; or validate without the template argument`
              : "Check template_list, or validate without the template argument",
          retryable: false,
        });
      }
      const executed = await ctx.engine.execute(
        { id: TEMPLATE_VALIDATE_COMMAND, params: { template: args.template } },
        { signal },
      );
      if (!executed.ok) {
        return err(executed.code, clip(executed.message, 300), {
          hint: executed.hint ?? "The template-bound validation pass failed engine-side; retry once.",
          retryable: retryableFor(executed.code, executed.retryable),
        });
      }
      const reply = readValidateReport(executed.value);
      if (reply === undefined) {
        return err("internal_error", "The engine's validate reply could not be read", {
          hint: "The adapter must attach the command reply (result/value/reply or JSON message); retry after it is fixed.",
          retryable: false,
        });
      }
      if (reply.dropped > 0) {
        warnings.push(`${reply.dropped} engine issue row(s) dropped (malformed)`);
      }
      if (reply.truncated) {
        warnings.push("the engine capped its own issue list (256)");
      }
      const local = collectIssues({
        canvasW,
        canvasH,
        rows,
        brandFonts: ctx.workspace.brandTokens.fonts,
        rules: TEMPLATE_ARM_SUPPLEMENT_RULES,
      });
      issues = [...reply.issues, ...local.issues];
      warnings.push(...local.notes);
    }

    const report = buildReport(issues, { template: templatePin, extraWarnings: warnings });

    // Breadcrumbs only — counts, never user content (§22).
    ctx.logger.debug("validate_document finished", {
      blockers: report.issueCounts.blocker,
      majors: report.issueCounts.major,
      minors: report.issueCounts.minor,
      shown: report.issues.length,
    });

    const revision =
      Number.isInteger(snapshot.revision) && snapshot.revision >= 0
        ? snapshot.revision
        : undefined;
    return ok({
      summary: renderSummary(report),
      warnings: report.warnings.length > 0 ? report.warnings : undefined,
      documentRevision: revision,
    });
  },
});
