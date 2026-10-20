// @studio/tools — workspace_snapshot (§6 row 1): the one-call context read.
//
// Spec anchors:
//   §6 row 1  "One-call context: canvas, layer tree (compact), slots, palette,
//             fonts, recent runs" — over `document.inspect` (filtered),
//             `layer.list`, `variables.list`, `layerComp.list`.
//   §5.4      Context assembly: the document summary is FILTERED to relevant
//             fields — never the full scene graph; strip pixel data, paths,
//             internal ids; stable ordering so the cache prefix never shifts.
//   §6.1      Compact-reply rule + actionable errors; never expose tokens,
//             absolute paths, or other tenants' ids.
//
// Engine seams (packages/tools/src/types.ts — the W1-O contract this tool must
// follow; Wave 2's engine-client conforms structurally):
//   - `ctx.engine.inspect()`     → `document.inspect` (canvas + revision; the
//     runtime snapshot may also carry `layerComps` / `variables` rows, which the
//     pinned engine includes in every `document.inspect` reply — inspect.rs).
//   - `ctx.engine.listLayers()`  → `layer.list` (the compact tree).
//   - `ctx.engine.execute({id})` → `variables.list` (variables_cmds.rs) and
//     `layerComp.list` (comps_cmds.rs) — registry-verified ids, never invented.
//     `EngineCommandReport` is the minimal seam shape `{revision, message?}`;
//     a conforming adapter may attach the command's own JSON reply under
//     `result`/`value`/`reply` or serialize it into `message` —
//     `commandPayload()` reads those defensively and never trusts the shape.
//   - The seam's `EngineLayerSummary` does not declare `opacity`; the pinned
//     engine's rows carry it (0..1, layer.setProps), so it is read defensively
//     and omitted when absent (reported to W5-R as a seam extension to make).
//
// Degradation policy (deliberate, table-tested): canvas + layer tree are the
// core — when `document.inspect` fails the tool returns a mapped `err()`.
// Secondary sections (variables, comps, templates, recent runs) degrade to
// warnings instead of failing the whole read: a snapshot with most of the
// context beats no context, and the model can re-read narrowly later.
//
// Not registered here — W5-R assembles the registry (§6 surface).

import { z } from "zod";
import {
  MAX_SUMMARY_CHARS,
  MAX_WARNINGS,
  MAX_WARNING_CHARS,
  defineTool,
  err,
  ok,
  strictObject,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import type {
  EngineCommandReport,
  EngineDocumentSnapshot,
  EngineFailure,
  EngineLayerSummary,
  Tool,
  ToolContext,
  ToolErr,
} from "../types.js";

// ---------------------------------------------------------------------------
// Args (§6.1 strict schema)
// ---------------------------------------------------------------------------

/** §6 row 1: one-call context for one document. Read-only — no idempotency key. */
export interface WorkspaceSnapshotArgs {
  readonly documentId: string;
}

const argsSchema = strictObject({
  /** §12.2 composite ids; uuid as everywhere on the API surface. */
  documentId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Compaction limits (§5.4 token discipline; every cap emits a warning when hit)
// ---------------------------------------------------------------------------

/** §6.1 small-reply rule is the hard ceiling: summaries stay ≤ 2000 chars. */
export const SNAPSHOT_SUMMARY_BUDGET_CHARS = MAX_SUMMARY_CHARS;
/** Layer rows kept before budget truncation applies (ids sorted, prefix kept). */
export const MAX_LAYERS_IN_SNAPSHOT = 60;
export const MAX_TEMPLATE_ROWS = 8;
export const MAX_TEMPLATE_TAGS = 3;
export const MAX_PALETTE_TOKENS = 12;
export const MAX_FONTS = 8;
export const MAX_VARIABLE_DEFS = 20;
export const MAX_DATA_SET_NAMES = 10;
export const MAX_COMPS = 10;
export const MAX_RECENT_RUNS = 5;

/** Registry-verified command ids (§2.2; vendor pins — never invented). */
const CMD_VARIABLES_LIST = "variables.list"; // variables_cmds.rs
const CMD_LAYER_COMP_LIST = "layerComp.list"; // comps_cmds.rs

/** Engine failure codes worth one retry (§13.3 classes; §24.4 resume semantics). */
const RETRYABLE_ENGINE_CODES: ReadonlySet<string> = new Set([
  "engine_timeout",
  "engine_unavailable",
  "engine_crashed",
  "rate_limited",
  "provider_unhealthy",
]);

// ---------------------------------------------------------------------------
// Small defensive readers — the seam is minimal, the runtime may be richer
// ---------------------------------------------------------------------------

type Rec = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** Clip a string to `max` chars with a single ellipsis (never silent growth). */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function readString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? clip(value, max) : undefined;
}

/** Engine layer ids are u64 on the wire; the seam types them as strings. */
function readId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return clip(value, 48);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function readBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Integer counter (childCount, slotCount, missing layers…). */
function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Opacity 0..1 (layer.setProps range). Some surfaces report percent 0..100 —
 * normalize that defensively; anything else non-finite is dropped.
 */
function readOpacity(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = value > 1 && value <= 100 ? value / 100 : value;
  if (normalized < 0 || normalized > 1) return undefined;
  return Math.round(normalized * 100) / 100;
}

function compactBounds(x: unknown, y: unknown, w: unknown, h: unknown): SnapshotBounds | undefined {
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return undefined;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/**
 * Bounds arrive as `{x,y,width,height}` (the seam's EngineBounds) or as the
 * engine's `[x0, y0, w, h]` array (inspect.rs / layer_list_cmds.rs). Both are
 * accepted; coordinates round to integers for compactness.
 */
function readBounds(value: unknown): SnapshotBounds | undefined {
  const record = asRecord(value);
  if (record !== undefined) {
    const bounds = compactBounds(record.x, record.y, record.width, record.height);
    if (bounds !== undefined) return bounds;
  }
  if (Array.isArray(value)) {
    const [x, y, width, height] = value as readonly unknown[];
    return compactBounds(x, y, width, height);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Stable ordering (§5.4: "stable ordering and ids"; this tool sorts by id)
// ---------------------------------------------------------------------------

const NUMERIC_ID_RE = /^\d+$/;

/** Deterministic id comparator: numeric when both ids are numeric, else bytewise. */
export function compareLayerIds(a: string, b: string): number {
  if (NUMERIC_ID_RE.test(a) && NUMERIC_ID_RE.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Section shapes (what the model sees — §5.4-filtered)
// ---------------------------------------------------------------------------

export interface SnapshotBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** §6 row 1 compact row: id/name/kind/bounds/visible/opacity (+ childCount). */
export interface SnapshotLayer {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly visible: boolean;
  readonly opacity?: number;
  readonly bounds?: SnapshotBounds;
  readonly childCount?: number;
}

export interface SnapshotTemplate {
  readonly ref: string;
  readonly title: string;
  readonly slots: number;
  readonly tags: readonly string[];
}

export interface SnapshotVariableDef {
  readonly name: string;
  readonly layer: string;
  readonly type?: string;
}

export interface SnapshotVariables {
  readonly defs: readonly SnapshotVariableDef[];
  readonly dataSets: readonly string[];
  readonly active?: number | string;
}

export interface SnapshotComps {
  readonly comps: readonly { readonly id: string; readonly name: string }[];
  readonly lastApplied?: string;
}

export interface SnapshotRun {
  readonly id: string;
  readonly status: string;
  readonly createdAt?: string;
}

export type PaletteEntry = { readonly token: string; readonly value: string };

/** Everything `summarizeSnapshot` may render, already §5.4-filtered and sorted. */
export interface SnapshotSections {
  readonly canvas: { readonly widthPx: number; readonly heightPx: number };
  readonly layers: readonly SnapshotLayer[];
  /** Projected rows before the MAX_LAYERS cap — the document's real count. */
  readonly layersTotal: number;
  readonly templates?: readonly SnapshotTemplate[];
  readonly palette?: readonly PaletteEntry[];
  readonly fonts?: readonly string[];
  readonly variables?: SnapshotVariables;
  readonly comps?: SnapshotComps;
  readonly recentRuns?: readonly SnapshotRun[];
  /** Warnings gathered while building sections (caps, degradations). */
  readonly buildWarnings: readonly string[];
}

export interface SnapshotSummary {
  readonly summary: string;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// §5.4 compaction: project engine rows down to the whitelisted fields
// ---------------------------------------------------------------------------

/**
 * One `layer.list` / `document.inspect` row → the compact §6 row. ONLY the
 * whitelisted fields survive; pixel data, smart-source paths, smart-contents
 * internal ids, effects, adjustment params, label colors etc. are dropped
 * mechanically (§5.4 "never dump the full scene graph"). Returns undefined for
 * rows without a usable id (malformed — skipped, not guessed).
 */
export function compactLayer(row: EngineLayerSummary): SnapshotLayer | undefined {
  const record = row as unknown as Rec;
  const id = readId(record.layerId ?? record.id);
  if (id === undefined) return undefined;
  const name = readString(record.name, 80) ?? "(unnamed)";
  const kind = readString(record.kind, 24) ?? "layer";
  const visible = readBool(record.visible) ?? true;
  const opacity = readOpacity(record.opacity);
  const bounds = readBounds(record.bounds);
  const childCount = readCount(record.childCount);
  // Canonical key order keeps JSON.stringify deterministic (§5.4 cache prefix).
  const layer: {
    id: string;
    name: string;
    kind: string;
    visible: boolean;
    opacity?: number;
    bounds?: SnapshotBounds;
    childCount?: number;
  } = { id, name, kind, visible };
  if (opacity !== undefined && opacity !== 1) layer.opacity = opacity; // 1 is the default
  if (bounds !== undefined) layer.bounds = bounds;
  if (childCount !== undefined && childCount > 0) layer.childCount = childCount;
  return layer;
}

/** compactLayers result: the kept rows plus the pre-cap total (for warnings). */
export interface CompactLayers {
  readonly layers: readonly SnapshotLayer[];
  readonly total: number;
}

/**
 * Sort by id (§5.4 stable ordering), drop malformed rows (with a warning), and
 * cap the count.
 */
export function compactLayers(
  rows: readonly EngineLayerSummary[],
  warnings: string[],
): CompactLayers {
  const projected: SnapshotLayer[] = [];
  let skipped = 0;
  for (const row of rows) {
    const layer = compactLayer(row);
    if (layer === undefined) skipped += 1;
    else projected.push(layer);
  }
  if (skipped > 0) warnings.push(`${skipped} layer row(s) skipped (no usable id)`);
  projected.sort((a, b) => compareLayerIds(a.id, b.id) || compareStrings(a.name, b.name));
  const kept = projected.slice(0, MAX_LAYERS_IN_SNAPSHOT);
  if (projected.length > kept.length) {
    warnings.push(
      `layer tree limited to first ${kept.length} of ${projected.length} rows (id order; use render_preview for the rest)`,
    );
  }
  return { layers: kept, total: projected.length };
}

/** Template summaries = "slots at a glance"; template_inspect has the manifest (§6 row 3). */
export function compactTemplates(
  rows: readonly {
    readonly id: string;
    readonly version: string;
    readonly title: string;
    readonly tags: readonly string[];
    readonly slotCount: number;
  }[],
  warnings: string[],
): readonly SnapshotTemplate[] {
  const projected = rows.map((row) => ({
    ref: clip(`${row.id}@${row.version}`, 80),
    title: clip(row.title, 60),
    slots: Number.isInteger(row.slotCount) && row.slotCount >= 0 ? row.slotCount : 0,
    tags: row.tags.slice(0, MAX_TEMPLATE_TAGS).map((tag) => clip(tag, 16)),
  }));
  projected.sort((a, b) => compareStrings(a.ref, b.ref));
  const kept = projected.slice(0, MAX_TEMPLATE_ROWS);
  if (projected.length > kept.length) {
    warnings.push(`templates limited to first ${kept.length} of ${projected.length} (ref order)`);
  }
  return kept;
}

/** Brand palette (§5.4 item 2): token → colour, name-sorted, capped. */
export function compactPalette(
  palette: Readonly<Record<string, string>>,
  warnings: string[],
): readonly PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const [token, value] of Object.entries(palette)) {
    const colour = readString(value, 32);
    if (colour !== undefined) entries.push({ token: clip(token, 32), value: colour });
  }
  entries.sort((a, b) => compareStrings(a.token, b.token));
  const kept = entries.slice(0, MAX_PALETTE_TOKENS);
  if (entries.length > kept.length) {
    warnings.push(
      `palette limited to first ${kept.length} of ${entries.length} tokens (name order)`,
    );
  }
  return kept;
}

/** Brand fonts plus fonts the document itself uses (engine snapshot), deduped. */
export function compactFonts(
  brandFonts: readonly string[],
  snapshotFonts: readonly string[] | undefined,
  warnings: string[],
): readonly string[] {
  const merged = new Set<string>();
  for (const font of [...brandFonts, ...(snapshotFonts ?? [])]) {
    const name = readString(font, 48);
    if (name !== undefined) merged.add(name);
  }
  const sorted = [...merged].sort(compareStrings);
  const kept = sorted.slice(0, MAX_FONTS);
  if (sorted.length > kept.length) {
    warnings.push(`fonts limited to first ${kept.length} of ${sorted.length} (name order)`);
  }
  return kept;
}

/**
 * `variables.list` payload (variables_cmds.rs) or the `document.inspect`
 * `variables` row (inspect.rs) → names, layers and data-set NAMES only. Data
 * set values are dropped: they can be long text or pixel references (§5.4).
 */
export function compactVariables(
  payload: unknown,
  warnings: string[],
): SnapshotVariables | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  const defs: SnapshotVariableDef[] = [];
  if (Array.isArray(record.defs)) {
    for (const raw of record.defs) {
      const def = asRecord(raw);
      if (def === undefined) continue;
      const name = readString(def.name, 60);
      const layer = readId(def.layer);
      if (name === undefined || layer === undefined) continue;
      const type = readString(def.type ?? def.kind, 24);
      defs.push(type === undefined ? { name, layer } : { name, layer, type });
    }
  }
  defs.sort((a, b) => compareStrings(a.name, b.name) || compareLayerIds(a.layer, b.layer));
  const keptDefs = defs.slice(0, MAX_VARIABLE_DEFS);
  if (defs.length > keptDefs.length) {
    warnings.push(
      `variables limited to first ${keptDefs.length} of ${defs.length} defs (name order)`,
    );
  }
  const dataSets: string[] = [];
  if (Array.isArray(record.dataSets)) {
    for (const raw of record.dataSets) {
      const row = asRecord(raw);
      const name = readString(row === undefined ? raw : row.name, 60);
      if (name !== undefined) dataSets.push(name);
    }
  }
  dataSets.sort(compareStrings);
  const keptSets = dataSets.slice(0, MAX_DATA_SET_NAMES);
  if (dataSets.length > keptSets.length) {
    warnings.push(
      `data sets limited to first ${keptSets.length} of ${dataSets.length} (name order)`,
    );
  }
  if (keptDefs.length === 0 && keptSets.length === 0) return undefined;
  const activeRaw = record.active;
  const active =
    typeof activeRaw === "number" && Number.isSafeInteger(activeRaw)
      ? activeRaw
      : readString(activeRaw, 60);
  return active === undefined
    ? { defs: keptDefs, dataSets: keptSets }
    : { defs: keptDefs, dataSets: keptSets, active };
}

/**
 * `layerComp.list` payload (comps_cmds.rs: {comps:[{id,name,…}], lastApplied})
 * or the `document.inspect` `layerComps` row (inspect.rs: [{id,name}]).
 * Comments and per-comp option flags are dropped (§5.4 compactness).
 */
export function compactComps(payload: unknown, warnings: string[]): SnapshotComps | undefined {
  const record = asRecord(payload);
  // Two vendor shapes, both read defensively: comps_cmds.rs wraps the rows in
  // `{comps:[…], lastApplied}`; inspect.rs sends a bare array of `{id,name}`.
  const rawComps: readonly unknown[] = Array.isArray(payload)
    ? payload
    : record !== undefined && Array.isArray(record.comps)
      ? record.comps
      : record !== undefined && Array.isArray(record.layerComps)
        ? record.layerComps
        : [];
  const comps: { id: string; name: string }[] = [];
  for (const raw of rawComps) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const id = readId(row.id);
    const name = readString(row.name, 60);
    if (id === undefined || name === undefined) continue;
    comps.push({ id, name });
  }
  comps.sort((a, b) => compareLayerIds(a.id, b.id) || compareStrings(a.name, b.name));
  const kept = comps.slice(0, MAX_COMPS);
  if (comps.length > kept.length) {
    warnings.push(`comps limited to first ${kept.length} of ${comps.length} (id order)`);
  }
  if (kept.length === 0) return undefined;
  const lastApplied =
    record !== undefined ? readId(record.lastApplied ?? record.lastAppliedComp) : undefined;
  return lastApplied === undefined ? { comps: kept } : { comps: kept, lastApplied };
}

/** Optional recent-runs rows (agent_runs shape): id/status/date only (§5.4). */
export function compactRuns(rows: readonly unknown[], warnings: string[]): readonly SnapshotRun[] {
  const runs: SnapshotRun[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const id = readId(row.runId ?? row.id);
    const status = readString(row.status, 16);
    if (id === undefined || status === undefined) continue;
    const date =
      row.createdAt instanceof Date
        ? clip(row.createdAt.toISOString(), 30)
        : (readString(row.createdAt, 30) ?? readString(row.updatedAt, 30));
    runs.push(date === undefined ? { id, status } : { id, status, createdAt: date });
  }
  // Newest first; stable id tiebreak (§5.4 stable ordering).
  runs.sort((a, b) => {
    const left = a.createdAt ?? "";
    const right = b.createdAt ?? "";
    if (left !== right) return left > right ? -1 : 1;
    return compareLayerIds(a.id, b.id);
  });
  const kept = runs.slice(0, MAX_RECENT_RUNS);
  if (runs.length > kept.length) {
    warnings.push(`recent runs limited to ${kept.length} of ${runs.length}`);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Payload probing for `ctx.engine.execute` (minimal seam {revision, message?})
// ---------------------------------------------------------------------------

const PAYLOAD_KEYS = ["value", "result", "reply", "data", "payload"] as const;

/**
 * Extracts the command's own JSON reply from an `EngineCommandReport`. The
 * seam declares only `{revision, message?}`; a conforming adapter attaches
 * the rpc.rs engine.execute result under a conventional key, or serializes it
 * into `message`. Never throws; undefined means "no payload" (caller degrades
 * to the document.inspect row).
 */
export function commandPayload(report: EngineCommandReport): unknown {
  const record = report as unknown as Rec;
  for (const key of PAYLOAD_KEYS) {
    const payload = record[key];
    if (payload !== undefined && payload !== null) return payload;
  }
  const message = record.message;
  if (typeof message === "object" && message !== null) return message;
  if (typeof message === "string" && message.length > 0) {
    const trimmed = message.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scrub: paths / pixel data never reach the model, even if a seam leaks one
// ---------------------------------------------------------------------------

const DATA_URI_RE = /data:[a-z]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const FILE_URL_RE = /file:\/\/[^\s"\\]+/gi;
const UNIX_PATH_RE = /\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)+/gi;
const WINDOWS_PATH_RE = /[a-z]:\\\\[^\s"\\]+/gi;
const BASE64_BLOB_RE = /[a-z0-9+/]{120,}={0,2}/gi;

interface Scrubbed {
  readonly text: string;
  readonly hits: number;
}

/**
 * Defense-in-depth for §6.1 ("never expose … absolute filesystem paths") and
 * §5.4 ("strip pixel data"): applied to the serialized summary only. Every
 * replacement token is JSON-safe (no quotes or backslashes) and shorter than
 * what it replaces, so a fitted summary stays within the budget.
 */
export function scrubSummary(text: string): Scrubbed {
  let scrubbed = text;
  let hits = 0;
  const replace = (pattern: RegExp, token: string): void => {
    scrubbed = scrubbed.replace(pattern, () => {
      hits += 1;
      return token;
    });
  };
  replace(DATA_URI_RE, "<data>");
  replace(FILE_URL_RE, "<path>");
  replace(WINDOWS_PATH_RE, "<path>");
  replace(UNIX_PATH_RE, "<path>");
  replace(BASE64_BLOB_RE, "<blob>");
  return { text: scrubbed, hits };
}

// ---------------------------------------------------------------------------
// summarize(): strict budget enforcement (§5.4 + §6.1 small-reply rule)
// ---------------------------------------------------------------------------

type Section = "layers" | "templates" | "palette" | "fonts" | "variables" | "comps" | "recentRuns";

/**
 * Shed order when the budget is tight: least planner-critical first. Templates
 * (slot structure) outlast style-guide rows; the layer tree is truncated only
 * after every other section is gone (§5.4).
 */
const SHED_ORDER: readonly Section[] = [
  "recentRuns",
  "comps",
  "variables",
  "fonts",
  "palette",
  "templates",
];

function sectionEmpty(sections: SnapshotSections, section: Section): boolean {
  switch (section) {
    case "layers":
      return sections.layers.length === 0;
    case "templates":
      return (sections.templates?.length ?? 0) === 0;
    case "palette":
      return (sections.palette?.length ?? 0) === 0;
    case "fonts":
      return (sections.fonts?.length ?? 0) === 0;
    case "variables":
      return sections.variables === undefined;
    case "comps":
      return sections.comps === undefined;
    case "recentRuns":
      return (sections.recentRuns?.length ?? 0) === 0;
  }
}

/** Serializes the kept sections in canonical key order (deterministic JSON). */
function assemble(
  sections: SnapshotSections,
  keep: ReadonlySet<Section>,
  layerLimit: number,
): string {
  const out: Record<string, unknown> = {
    canvas: { widthPx: sections.canvas.widthPx, heightPx: sections.canvas.heightPx },
  };
  if (keep.has("layers")) {
    const rows = sections.layers.slice(0, layerLimit);
    if (rows.length > 0) out.layers = rows;
  }
  if (keep.has("templates") && (sections.templates?.length ?? 0) > 0) {
    out.templates = sections.templates;
  }
  if (keep.has("palette") && (sections.palette?.length ?? 0) > 0) {
    const palette: Record<string, string> = {};
    for (const entry of sections.palette ?? []) palette[entry.token] = entry.value;
    out.palette = palette;
  }
  if (keep.has("fonts") && (sections.fonts?.length ?? 0) > 0) out.fonts = sections.fonts;
  if (keep.has("variables") && sections.variables !== undefined) {
    out.variables = sections.variables;
  }
  if (keep.has("comps") && sections.comps !== undefined) out.comps = sections.comps;
  if (keep.has("recentRuns") && (sections.recentRuns?.length ?? 0) > 0) {
    out.recentRuns = sections.recentRuns;
  }
  return JSON.stringify(out);
}

function finalizeWarnings(collected: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const warning of collected) {
    const clipped = clip(warning, MAX_WARNING_CHARS);
    if (!seen.has(clipped)) {
      seen.add(clipped);
      warnings.push(clipped);
    }
    if (warnings.length >= MAX_WARNINGS) break;
  }
  return warnings;
}

/**
 * The §5.4 compaction pass. Builds the summary JSON in canonical key order,
 * then enforces `budgetChars` (default: the kit's 2000-char §6.1 ceiling):
 *   1. shed whole sections in SHED_ORDER (only sections actually present),
 *   2. truncate the id-sorted layer list to the largest prefix that fits,
 *   3. hard-clamp (unreachable by construction — every field is capped — but
 *      the kit throws ToolError above the ceiling, so it can never be skipped).
 * Every loss emits a warning; the result is deterministic byte-for-byte.
 */
export function summarizeSnapshot(
  sections: SnapshotSections,
  budgetChars: number = SNAPSHOT_SUMMARY_BUDGET_CHARS,
): SnapshotSummary {
  const budget =
    Number.isInteger(budgetChars) && budgetChars > 0 ? budgetChars : SNAPSHOT_SUMMARY_BUDGET_CHARS;
  const warnings: string[] = [...sections.buildWarnings];
  const keep = new Set<Section>([
    "layers",
    "templates",
    "palette",
    "fonts",
    "variables",
    "comps",
    "recentRuns",
  ]);
  let serialized = assemble(sections, keep, sections.layers.length);

  const dropped: string[] = [];
  for (const section of SHED_ORDER) {
    if (serialized.length <= budget) break;
    if (sectionEmpty(sections, section)) continue;
    keep.delete(section);
    dropped.push(section);
    serialized = assemble(sections, keep, sections.layers.length);
  }
  if (dropped.length > 0) {
    warnings.push(`summary budget: dropped ${dropped.join(", ")}`);
  }

  // Largest id-sorted layer prefix that fits (length is monotonic in the prefix).
  if (serialized.length > budget && sections.layers.length > 0) {
    let low = 0;
    let high = sections.layers.length;
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (assemble(sections, keep, mid).length <= budget) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best < sections.layers.length) {
      warnings.push(
        `layer tree truncated to ${best} of ${sections.layers.length} rows ` +
          `(of ${sections.layersTotal} in the document) to fit the summary budget`,
      );
      serialized = assemble(sections, keep, best);
    }
  }

  if (serialized.length > budget) {
    // The §6.1 ceiling is mechanical (ok() throws above it) — clamp as last resort.
    serialized = `${serialized.slice(0, Math.max(0, budget - 1))}…`;
    warnings.push("summary hard-truncated to the budget");
  }

  const scrubbed = scrubSummary(serialized);
  if (scrubbed.hits > 0) {
    warnings.push(`stripped ${scrubbed.hits} path/pixel-data value(s) from the summary (§5.4)`);
  }
  return { summary: scrubbed.text, warnings: finalizeWarnings(warnings) };
}

// ---------------------------------------------------------------------------
// Failure mapping (§6.1: actionable errors; the engine seam already sanitizes)
// ---------------------------------------------------------------------------

function retryableFor(code: string, engineValue: boolean | undefined): boolean {
  return engineValue ?? RETRYABLE_ENGINE_CODES.has(code);
}

/** Core read failed: no canvas, no context — the mapped envelope, never a partial ok. */
function inspectFailure(failure: EngineFailure): ToolErr {
  // §6.1 actionable errors: always a hint, even when the seam failure has none.
  const fallback =
    "The engine session may not have this document open. Retry workspace_snapshot once; if it repeats the run should stop cleanly.";
  return err(failure.code, `The document could not be read: ${clip(failure.message, 300)}`, {
    hint: failure.hint ?? fallback,
    retryable: retryableFor(failure.code, failure.retryable),
  });
}

// ---------------------------------------------------------------------------
// Section readers (engine + catalog + db seams, with the degradation policy)
// ---------------------------------------------------------------------------

/** The document.inspect `variables` row (inspect.rs) via the runtime snapshot. */
function snapshotVariables(
  snapshot: EngineDocumentSnapshot,
  warnings: string[],
): SnapshotVariables | undefined {
  return compactVariables((snapshot as unknown as Rec).variables, warnings);
}

/** The document.inspect `layerComps` row (inspect.rs) via the runtime snapshot. */
function snapshotComps(
  snapshot: EngineDocumentSnapshot,
  warnings: string[],
): SnapshotComps | undefined {
  return compactComps((snapshot as unknown as Rec).layerComps, warnings);
}

async function readVariables(
  ctx: ToolContext,
  snapshot: EngineDocumentSnapshot,
  signal: AbortSignal,
  warnings: string[],
): Promise<SnapshotVariables | undefined> {
  try {
    const outcome = await ctx.engine.execute({ id: CMD_VARIABLES_LIST, params: {} }, { signal });
    if (!outcome.ok) {
      warnings.push(`variables unavailable (${outcome.code}); data-set context omitted`);
      return snapshotVariables(snapshot, warnings);
    }
    const payload = commandPayload(outcome.value);
    const compacted = payload === undefined ? undefined : compactVariables(payload, warnings);
    return compacted ?? snapshotVariables(snapshot, warnings);
  } catch {
    // Transport surprise on a secondary read degrades; the core sections stand.
    warnings.push("variables unavailable; data-set context omitted");
    return snapshotVariables(snapshot, warnings);
  }
}

async function readComps(
  ctx: ToolContext,
  snapshot: EngineDocumentSnapshot,
  signal: AbortSignal,
  warnings: string[],
): Promise<SnapshotComps | undefined> {
  try {
    const outcome = await ctx.engine.execute({ id: CMD_LAYER_COMP_LIST, params: {} }, { signal });
    if (!outcome.ok) {
      warnings.push(`layer comps unavailable (${outcome.code}); comp list omitted`);
      return snapshotComps(snapshot, warnings);
    }
    const payload = commandPayload(outcome.value);
    const compacted = payload === undefined ? undefined : compactComps(payload, warnings);
    return compacted ?? snapshotComps(snapshot, warnings);
  } catch {
    warnings.push("layer comps unavailable; comp list omitted");
    return snapshotComps(snapshot, warnings);
  }
}

/**
 * ctx.db is the minimal DbLike seam (W1-O) — it declares no run-listing
 * method. Wave 3 repositories conform structurally and MAY expose one; probe
 * for the conventional names and omit the section when none exists ("recent
 * runs — optional"). The lister receives the caller's documentId so the
 * implementation scopes its own tenant queries (§12.2 composite lookups).
 */
type RunsLister = (
  documentId: string,
  options?: { readonly limit?: number },
) => Promise<readonly unknown[]>;

async function readRecentRuns(
  ctx: ToolContext,
  documentId: string,
  warnings: string[],
): Promise<readonly SnapshotRun[] | undefined> {
  const db = ctx.db as typeof ctx.db & {
    readonly listRuns?: RunsLister;
    readonly recentRuns?: RunsLister;
  };
  const lister = db.listRuns ?? db.recentRuns;
  if (typeof lister !== "function") return undefined;
  try {
    const rows = await lister(documentId, { limit: MAX_RECENT_RUNS });
    if (!Array.isArray(rows)) return undefined;
    return compactRuns(rows, warnings);
  } catch {
    warnings.push("recent runs unavailable; run history omitted");
    return undefined;
  }
}

async function readTemplates(
  ctx: ToolContext,
  warnings: string[],
): Promise<readonly SnapshotTemplate[] | undefined> {
  try {
    const rows = await ctx.templates.list();
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    return compactTemplates(rows, warnings);
  } catch {
    warnings.push("template catalog unavailable; slot overview omitted");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The tool (§6 row 1, §6.2 shape)
// ---------------------------------------------------------------------------

export const workspaceSnapshot: Tool<WorkspaceSnapshotArgs> = defineTool({
  name: TOOLS.workspace_snapshot,
  description:
    "One-call document context: compact canvas, layer tree, template slots, palette, fonts, variables, layer comps, and recent runs (§5.4 summary).",
  args: argsSchema,
  async run(ctx, args, signal) {
    // Core read: canvas + revision (document.inspect). Failing here means no
    // context at all — mapped err, never a partial ok (§6.1).
    const inspected = await ctx.engine.inspect();
    if (!inspected.ok) return inspectFailure(inspected);
    const snapshot = inspected.value;

    const layerWarnings: string[] = [];
    const templateWarnings: string[] = [];
    const paletteWarnings: string[] = [];
    const fontWarnings: string[] = [];
    const variableWarnings: string[] = [];
    const compWarnings: string[] = [];
    const runWarnings: string[] = [];

    // Layer tree: layer.list semantics (§6 row 1); document.inspect rows are
    // the fallback when the command path fails (§5.4 filtering is identical).
    let rows: readonly EngineLayerSummary[] = snapshot.layers;
    const listed = await ctx.engine.listLayers();
    if (listed.ok) {
      rows = listed.value;
    } else {
      layerWarnings.push(
        `layer.list unavailable (${listed.code}); layer tree from document.inspect`,
      );
    }
    const { layers, total } = compactLayers(rows, layerWarnings);

    // Secondary sections, each with its own warnings so the merge order below
    // is deterministic regardless of promise resolution order (§5.4).
    const [templates, variables, comps, recentRuns] = await Promise.all([
      readTemplates(ctx, templateWarnings),
      readVariables(ctx, snapshot, signal, variableWarnings),
      readComps(ctx, snapshot, signal, compWarnings),
      readRecentRuns(ctx, args.documentId, runWarnings),
    ]);
    const palette = compactPalette(ctx.workspace.brandTokens.palette, paletteWarnings);
    const fonts = compactFonts(ctx.workspace.brandTokens.fonts, snapshot.fonts, fontWarnings);

    const { summary, warnings: summaryWarnings } = summarizeSnapshot({
      canvas: { widthPx: snapshot.widthPx, heightPx: snapshot.heightPx },
      layers,
      layersTotal: total,
      templates,
      palette,
      fonts,
      variables,
      comps,
      recentRuns,
      buildWarnings: [
        ...layerWarnings,
        ...templateWarnings,
        ...paletteWarnings,
        ...fontWarnings,
        ...variableWarnings,
        ...compWarnings,
        ...runWarnings,
      ],
    });

    // Breadcrumbs only — counts, never user content or ids (§22).
    ctx.logger.debug("workspace_snapshot assembled", {
      layerRows: layers.length,
      templateRows: templates?.length ?? 0,
      warningCount: summaryWarnings.length,
      summaryChars: summary.length,
    });

    const revision =
      Number.isInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : undefined;
    return ok({
      summary,
      warnings: summaryWarnings.length > 0 ? summaryWarnings : undefined,
      documentRevision: revision,
    });
  },
});
