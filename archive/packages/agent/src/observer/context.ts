// @studio/agent/observer/context — §5.4 context assembly (what the model sees).
// Owner: W6-C (docs/AGENTS.md). Tests: tests/context.test.ts.
//
// Spec §5.4 — assembly order (THE contract this module implements):
//   1. system prompt (static, cached)
//   2. style guide — workspace brand tokens (palette, fonts, tone), cached per
//      workspace
//   3. template manifest — the CHOSEN template only, cached per template version
//   4. document summary — filtered `layer.list` + `document.inspect`; NEVER a
//      full scene-graph dump (strip pixel data, paths, internal ids)
//   5. brief — the user prompt, attachment descriptions/thumbnails, prior
//      conversation (chat edits), target export dimensions
//   6. validator report from the previous cycle (repair phase only), plus
//      critic issues
//
// Cache contract (§5.3 "cache the static prefixes … aim for ≥60% cache-hit
// rate"; §5.4 "stable ordering and ids so the cache prefix never shifts
// mid-run"):
//   - every section is serialized with `canonicalStringify` (object keys sorted
//     recursively) → byte-deterministic output for equal values regardless of
//     key insertion order;
//   - sections are emitted in §5.4 order under stable section ids;
//   - `cacheablePrefix` = `hashCachePrefix` over sections 1-3 ONLY
//     (CACHED_SECTION_IDS). The document summary, brief and validator report
//     change every turn and live AFTER the cached prefix — so a revision bump
//     rewrites section 4's bytes but never the prefix (THE §5.4 cache
//     assertion, pinned in tests/context.test.ts).
//
// Token discipline (§5.4): "for a 12-layer document the summary must stay
// under ~4k tokens" — pinned here as 4 chars ≈ 1 token, i.e. a 16_000-char
// budget for the document-summary section. Every section has a char budget
// and every truncation emits a warning (never silent).
//
// Boundary note (AGENTS.md "Zod at every boundary: HTTP input, tool args,
// engine params, env vars, manifests"): these inputs come from trusted
// internal seams (worker wiring — system prompt from executor/prompt.ts, the
// tool's own compact summary, the validator service's report), not from the
// wire/engine/model. Validation here is therefore defensive projection +
// clipping in the workspace_snapshot tool's defensive-reader style (never
// throws, §5.7 posture), not a zod schema.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// §5.4 section ids + the cacheable prefix set
// ---------------------------------------------------------------------------

/** §5.4 items in assembly order — the messages array follows this exactly. */
export const CONTEXT_SECTION_IDS = [
  "system_prompt",
  "style_guide",
  "template_manifest",
  "document_summary",
  "brief",
  "validator_report",
] as const;

export type ContextSectionId = (typeof CONTEXT_SECTION_IDS)[number];

/**
 * §5.4 items 1-3 — the static prefix the provider caches per §5.3. Everything
 * after these three changes per turn and is deliberately NOT hashed.
 */
export const CACHED_SECTION_IDS: readonly ContextSectionId[] = [
  "system_prompt",
  "style_guide",
  "template_manifest",
];

// ---------------------------------------------------------------------------
// Token discipline (§5.4) + section budgets
// ---------------------------------------------------------------------------

/** The approximation this module pins: ~4 chars ≈ 1 token (§5.4 "~4k tokens ≈ 16k chars"). */
export const CHARS_PER_TOKEN = 4;

/** §5.4: a 12-layer document summary stays under ~4k tokens. */
export const DOC_SUMMARY_TOKEN_BUDGET = 4_000;

/** The same budget in chars (4 chars/token). */
export const DOC_SUMMARY_CHAR_BUDGET = DOC_SUMMARY_TOKEN_BUDGET * CHARS_PER_TOKEN; // 16_000

/** Structured layer rows kept before truncation applies (tool precedent: 60). */
export const MAX_LAYERS_IN_CONTEXT = 60;

/** §6.2: manifests expose at most 40 slots (plan.ts MAX_PLAN_SLOTS precedent). */
export const MAX_MANIFEST_SLOTS = 40;

/** §11.1/tools: the validator caps its visible issue list at 25 rows. */
export const MAX_VALIDATOR_ISSUES = 25;

/** Brief attachment rows kept (descriptions/thumbnails; §5.4 item 5). */
export const MAX_BRIEF_ATTACHMENTS = 16;

/** Prior-conversation turns kept (chronological; §5.4 item 5 "prior conversation"). */
export const MAX_PRIOR_CHAT_TURNS = 30;

/** Warning cap/count mirrors the tool kit's discipline (§6.1 compactness). */
export const MAX_WARNINGS = 10;
export const MAX_WARNING_CHARS = 200;

/**
 * Per-section char budgets. §5.4 pins only the document-summary budget; the
 * others are generous module constants (the static sections are hand-authored
 * and cached — hitting their cap is a wiring bug you will see as a warning).
 */
export const DEFAULT_SECTION_CHAR_BUDGETS: Readonly<Record<ContextSectionId, number>> = {
  system_prompt: 32_000,
  style_guide: 8_000,
  template_manifest: 8_000,
  document_summary: DOC_SUMMARY_CHAR_BUDGET,
  brief: 16_000,
  validator_report: 8_000,
};

/** Estimates tokens from chars (§5.4 approximation; 0 for empty/invalid). */
export function estimateTokens(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;
}

// ---------------------------------------------------------------------------
// canonicalStringify — JSON with recursively sorted keys (stable bytes)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      // JSON.stringify semantics: NaN/Infinity serialize as null.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      // JSON.stringify would throw; this seam never throws — render as string.
      return JSON.stringify(value.toString());
    case "object": {
      if (Array.isArray(value)) {
        // Array order is meaningful (chat turns, layer rows) — kept verbatim;
        // `undefined` items become null, exactly like JSON.stringify.
        return `[${value.map((item) => canonicalize(item)).join(",")}]`;
      }
      const record = value as Readonly<Record<string, unknown>>;
      const entries: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item === undefined) continue; // JSON.stringify drops undefined entries
        entries.push(`${JSON.stringify(key)}:${canonicalize(item)}`);
      }
      return `{${entries.join(",")}}`;
    }
    default:
      return "null"; // function / symbol / undefined — never model-relevant
  }
}

/**
 * JSON with object keys sorted recursively: byte-deterministic for equal
 * values regardless of key insertion order (§5.4 stable bytes → the cache
 * prefix never shifts). Mirrors `JSON.stringify` for undefined (dropped in
 * objects, `null` in arrays) and NaN/Infinity (→ `null`); never throws.
 */
export function canonicalStringify(value: unknown): string {
  return canonicalize(value);
}

/**
 * sha256 over the cached sections' contents (§5.4 items 1-3), length-framed
 * so different splits of the same byte stream cannot collide. Identifies the
 * cached prefix for cache-key tracking; contents are never logged (§22).
 */
export function hashCachePrefix(contents: readonly string[]): string {
  const hash = createHash("sha256");
  for (const content of contents) {
    hash.update(`${content.length}:`);
    hash.update(content);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Defensive readers (fleet style: never throw, never guess)
// ---------------------------------------------------------------------------

/** Object (not array/null) or undefined. */
export type Rec = Readonly<Record<string, unknown>>;

/** Object (not array/null) or undefined. */
export function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** Clip to `max` chars with a single trailing ellipsis (never silent growth). */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function readString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? clip(value, max) : undefined;
}

function readBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Document revision (engine u64; safe-int on the wire) or undefined. */
export function readRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Opacity 0..1 (layer.setProps range); percent surfaces (0..100) normalize
 * defensively. Two decimals — compactness (§5.4).
 */
function readOpacity(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = value > 1 && value <= 100 ? value / 100 : value;
  if (normalized < 0 || normalized > 1) return undefined;
  return Math.round(normalized * 100) / 100;
}

export interface SummaryBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function compactBounds(x: unknown, y: unknown, w: unknown, h: unknown): SummaryBounds | undefined {
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

/** Bounds arrive as `{x,y,width,height}` or the engine's `[x0,y0,w,h]` array. */
function readBounds(value: unknown): SummaryBounds | undefined {
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

const NUMERIC_ID_RE = /^\d+$/;

/**
 * Deterministic layer-id comparator: numeric-aware when both ids are numeric,
 * else bytewise — mirrors the workspace_snapshot tool's comparator so rows
 * keep the same relative order in both surfaces (§5.4 stable ordering).
 */
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

/** Engine layer ids are u64 on the wire; the seam types them as strings. */
export function readLayerId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return clip(value, 48);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

/** Canvas dims (`{widthPx,heightPx}` or `{width,height}`), non-negative ints. */
export function readCanvas(value: unknown): { widthPx: number; heightPx: number } | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const widthPx = readCount(record.widthPx ?? record.width);
  const heightPx = readCount(record.heightPx ?? record.height);
  if (widthPx === undefined || heightPx === undefined) return undefined;
  return { widthPx, heightPx };
}

/**
 * §6.1: model-visible urls are http(s):// or root-relative `/…` only — never a
 * filesystem path, no whitespace. Applied to preview and attachment thumbnail
 * urls at assembly time (defense-in-depth; the seams own the primary check).
 */
export function isSafeContextUrl(url: string): boolean {
  return (
    url.length > 0 &&
    url.length <= 2_048 &&
    !/\s/.test(url) &&
    (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/"))
  );
}

// ---------------------------------------------------------------------------
// §5.4 section inputs
// ---------------------------------------------------------------------------

/** §5.4 (2): workspace brand tokens — palette, fonts, tone (cached per workspace). */
export interface StyleGuideInput {
  readonly palette?: Readonly<Record<string, string>>;
  readonly fonts?: readonly string[];
  readonly tone?: string;
}

/** §5.4 (3): one manifest slot (name/kind/required only — §5.4 compactness). */
export interface ManifestSlotInput {
  readonly name: string;
  readonly kind?: string;
  readonly required?: boolean;
}

/** §5.4 (3): the chosen template's manifest (cached per template version). */
export interface TemplateManifestInput {
  /** `id@version` (§5.5 template ref) — the CHOSEN template only, never the catalog. */
  readonly ref: string;
  readonly title?: string;
  readonly slots?: readonly ManifestSlotInput[];
}

/**
 * §5.4 (4), compact arm: a pre-compacted summary string — the
 * workspace_snapshot tool's `summary` (§5.4-filtered, guaranteed ≤2000 chars
 * by the kit) or an `Observation.compactSummary` (observer.ts, incl. delta
 * JSON) — plus the current revision.
 */
export interface CompactDocumentSummary {
  readonly summary: string;
  readonly revision?: number;
}

/**
 * §5.4 (4), structured arm: filtered layer rows this module compacts itself
 * (whitelist projection below — a full dump can never pass through, §5.4).
 */
export interface StructuredDocumentSummary {
  readonly revision?: number;
  readonly canvas: { readonly widthPx: number; readonly heightPx: number };
  readonly layers: readonly unknown[];
}

export type DocumentSummaryInput = CompactDocumentSummary | StructuredDocumentSummary;

/** §5.4 (5): attachment descriptions/thumbnails. */
export interface BriefAttachmentInput {
  readonly name?: string;
  readonly description?: string;
  readonly previewUrl?: string;
}

/** §5.4 (5): prior conversation turns (chat edits), chronological. */
export interface BriefChatTurnInput {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** §5.4 (5): the brief — prompt, attachments, prior chat, export dimensions. */
export interface BriefInput {
  readonly prompt: string;
  readonly attachments?: readonly BriefAttachmentInput[];
  readonly priorChat?: readonly BriefChatTurnInput[];
  readonly exportDimensions?: { readonly width: number; readonly height: number };
}

/** §5.4 (6): the previous cycle's validator report + critic issues (repair phase). */
export interface ValidatorReportInput {
  readonly ok: boolean;
  readonly issueCounts: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
  };
  readonly issues?: readonly unknown[];
  readonly criticIssues?: readonly unknown[];
  readonly truncated?: boolean;
}

/** §5.4 assembly input — every section, in §5.4 order. */
export interface ContextInput {
  readonly system: string;
  readonly styleGuide?: StyleGuideInput;
  readonly templateManifest?: TemplateManifestInput;
  readonly documentSummary?: DocumentSummaryInput;
  readonly brief?: BriefInput;
  readonly priorValidatorReport?: string | ValidatorReportInput;
}

// ---------------------------------------------------------------------------
// Assembled output
// ---------------------------------------------------------------------------

/** One assembled model message (§5.4 order; sections ride as system role). */
export interface ContextMessage {
  readonly role: "system";
  readonly content: string;
}

export interface AssembledSection {
  readonly id: ContextSectionId;
  readonly role: "system";
  /** Canonical JSON bytes — budget-capped when `truncated` is true. */
  readonly content: string;
  readonly chars: number;
  /** True for §5.4 items 1-3 (inside the cacheablePrefix). */
  readonly cached: boolean;
  readonly truncated: boolean;
}

export interface AssembledContext {
  /** §5.4 order; optional sections are omitted entirely. */
  readonly messages: readonly ContextMessage[];
  /** `sha256:<hex>` over sections 1-3 — stable across revisions (§5.4). */
  readonly cacheablePrefix: string;
  /** Same content as `messages`, plus ids/caching/truncation bookkeeping. */
  readonly sections: readonly AssembledSection[];
  /** §22-safe: section names + counts only, never payload content. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Budget clamps + warnings (§5.4 "with truncation warnings")
// ---------------------------------------------------------------------------

export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
}

/**
 * Hard budget clamp (the final backstop after array/row caps): slice + one
 * ellipsis. The caller emits a warning whenever `truncated` is true.
 */
export function capText(text: string, budget: number): CappedText {
  if (text.length <= budget) return { text, truncated: false, originalChars: text.length };
  return {
    text: `${text.slice(0, Math.max(0, budget - 1))}…`,
    truncated: true,
    originalChars: text.length,
  };
}

/** Dedupe + clip + cap warnings (§22: counts and section names, never content). */
export function finalizeWarnings(
  collected: readonly string[],
  max: number = MAX_WARNINGS,
): readonly string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const warning of collected) {
    const clipped = clip(warning, MAX_WARNING_CHARS);
    if (!seen.has(clipped)) {
      seen.add(clipped);
      warnings.push(clipped);
    }
    if (warnings.length >= max) break;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Section payload builders (pure; each returns data WITHOUT the section key)
// ---------------------------------------------------------------------------

function readPalette(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const palette: Record<string, string> = {};
  for (const [token, colour] of Object.entries(record)) {
    const name = readString(token, 64);
    const hex = readString(colour, 64);
    if (name === undefined || hex === undefined) continue;
    palette[name] = hex;
  }
  // Keys are sorted by canonicalStringify — deterministic regardless of order.
  return Object.keys(palette).length > 0 ? palette : undefined;
}

function readFonts(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fonts = new Set<string>();
  for (const font of value) {
    const name = readString(font, 64);
    if (name !== undefined) fonts.add(name);
  }
  return fonts.size > 0 ? [...fonts].sort(compareStrings) : undefined;
}

function buildStyleGuide(value: StyleGuideInput, warnings: string[]): Rec | undefined {
  const record = asRecord(value) ?? {};
  const paletteRecord = asRecord(record.palette);
  const palette = paletteRecord === undefined ? undefined : readPalette(paletteRecord);
  const fontsRaw = record.fonts;
  const fonts = Array.isArray(fontsRaw) ? readFonts(fontsRaw) : undefined;
  const tone = readString(record.tone, 1_000);
  // Warn only when something WAS there but nothing survived projection.
  if (
    palette === undefined &&
    paletteRecord !== undefined &&
    Object.keys(paletteRecord).length > 0
  ) {
    warnings.push("style guide: palette unreadable; omitted");
  }
  if (fonts === undefined && Array.isArray(fontsRaw) && fontsRaw.length > 0) {
    warnings.push("style guide: fonts unreadable; omitted");
  }
  if (palette === undefined && fonts === undefined && tone === undefined) return undefined;
  const payload: Record<string, unknown> = {};
  if (palette !== undefined) payload.palette = palette;
  if (fonts !== undefined) payload.fonts = fonts;
  if (tone !== undefined) payload.tone = tone;
  return payload;
}

function readSlots(value: unknown, warnings: string[]): readonly Rec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const slots: Rec[] = [];
  for (const raw of value) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const name = readString(row.name, 120);
    if (name === undefined) continue;
    const slot: Record<string, unknown> = { name };
    const kind = readString(row.kind, 32);
    if (kind !== undefined) slot.kind = kind;
    const required = readBool(row.required);
    if (required !== undefined) slot.required = required;
    slots.push(slot);
  }
  slots.sort((a, b) => compareStrings(String(a.name), String(b.name)));
  const kept = slots.slice(0, MAX_MANIFEST_SLOTS);
  if (slots.length > kept.length) {
    warnings.push(
      `template manifest: slots limited to first ${kept.length} of ${slots.length} (name order)`,
    );
  }
  return kept.length > 0 ? kept : undefined;
}

function buildTemplateManifest(value: TemplateManifestInput, warnings: string[]): Rec | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const ref = readString(record.ref, 200);
  if (ref === undefined) {
    warnings.push("template manifest ignored (no template ref)");
    return undefined;
  }
  const payload: Record<string, unknown> = { ref };
  const title = readString(record.title, 120);
  if (title !== undefined) payload.title = title;
  const slots = readSlots(record.slots, warnings);
  if (slots !== undefined) payload.slots = slots;
  return payload;
}

function parseEmbeddedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One layer row → the §5.4 whitelist projection (never a full-dump copy). */
export interface SummaryLayerRow {
  readonly id: string;
  readonly name?: string;
  readonly kind?: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly bounds?: SummaryBounds;
  readonly childCount?: number;
}

/**
 * §5.4 (4) core: rows → whitelisted compact rows. ONLY id/name/kind/visible/
 * opacity/bounds/childCount survive — pixel data, smart-source paths and
 * smart-contents internal ids are dropped mechanically (§5.4 "never dump the
 * full scene graph"). Rows without a usable id are skipped (with a warning),
 * never guessed. Output is id-sorted (§5.4 stable ordering).
 */
export function compactLayerRows(
  rows: readonly unknown[],
  warnings: string[],
): readonly SummaryLayerRow[] {
  const projected: SummaryLayerRow[] = [];
  let skipped = 0;
  for (const raw of rows) {
    const row = asRecord(raw);
    const id = row === undefined ? undefined : readLayerId(row.layerId ?? row.id);
    if (row === undefined || id === undefined) {
      skipped += 1;
      continue;
    }
    const layer: {
      id: string;
      name?: string;
      kind?: string;
      visible?: boolean;
      opacity?: number;
      bounds?: SummaryBounds;
      childCount?: number;
    } = {
      id,
      name: readString(row.name, 80) ?? "(unnamed)",
      kind: readString(row.kind, 24) ?? "layer",
      visible: readBool(row.visible) ?? true,
    };
    const opacity = readOpacity(row.opacity);
    if (opacity !== undefined && opacity !== 1) layer.opacity = opacity; // 1 = default
    const bounds = readBounds(row.bounds);
    if (bounds !== undefined) layer.bounds = bounds;
    const childCount = readCount(row.childCount);
    if (childCount !== undefined && childCount > 0) layer.childCount = childCount;
    projected.push(layer);
  }
  if (skipped > 0) {
    warnings.push(`document summary: ${skipped} layer row(s) skipped (no usable id)`);
  }
  projected.sort(
    (a, b) => compareLayerIds(a.id, b.id) || compareStrings(a.name ?? "", b.name ?? ""),
  );
  return projected;
}

function readAttachments(value: unknown, warnings: string[]): readonly Rec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: Rec[] = [];
  let droppedUrls = 0;
  for (const raw of value.slice(0, MAX_BRIEF_ATTACHMENTS)) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const attachment: Record<string, unknown> = {};
    const name = readString(row.name, 120);
    if (name !== undefined) attachment.name = name;
    const description = readString(row.description, 2_000);
    if (description !== undefined) attachment.description = description;
    const url = readString(row.previewUrl ?? row.thumbnailUrl, 2_048);
    if (url !== undefined && isSafeContextUrl(url)) attachment.previewUrl = url;
    else if (url !== undefined) droppedUrls += 1;
    if (Object.keys(attachment).length > 0) rows.push(attachment);
  }
  if (value.length > MAX_BRIEF_ATTACHMENTS) {
    warnings.push(
      `brief: attachments limited to first ${MAX_BRIEF_ATTACHMENTS} of ${value.length}`,
    );
  }
  if (droppedUrls > 0) {
    warnings.push(
      `brief: ${droppedUrls} attachment thumbnail url(s) dropped (§6.1: http(s) or root-relative only)`,
    );
  }
  return rows.length > 0 ? rows : undefined;
}

function readPriorChat(value: unknown, warnings: string[]): readonly Rec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const turns: Rec[] = [];
  for (const raw of value.slice(0, MAX_PRIOR_CHAT_TURNS)) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const content = readString(row.content, 2_000);
    if (content === undefined) continue;
    turns.push(
      row.role === "assistant" ? { role: "assistant", content } : { role: "user", content }, // anything else reads as the user's turn
    );
  }
  if (value.length > MAX_PRIOR_CHAT_TURNS) {
    warnings.push(
      `brief: prior chat limited to first ${MAX_PRIOR_CHAT_TURNS} of ${value.length} turns (chronological)`,
    );
  }
  return turns.length > 0 ? turns : undefined;
}

function readExportDimensions(value: unknown): Rec | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const width = readCount(record.width);
  const height = readCount(record.height);
  if (width === undefined || height === undefined || width === 0 || height === 0) return undefined;
  return { width, height };
}

function buildBrief(value: BriefInput, warnings: string[]): Rec | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const prompt = readString(record.prompt, 8_000);
  if (prompt === undefined) {
    warnings.push("brief ignored (no prompt text)");
    return undefined;
  }
  const payload: Record<string, unknown> = { prompt };
  const attachments = readAttachments(record.attachments, warnings);
  if (attachments !== undefined) payload.attachments = attachments;
  const priorChat = readPriorChat(record.priorChat, warnings);
  if (priorChat !== undefined) payload.priorChat = priorChat; // order preserved (arrays)
  const exportDimensions = readExportDimensions(record.exportDimensions);
  if (exportDimensions !== undefined) payload.exportDimensions = exportDimensions;
  return payload;
}

function readIssueCounts(value: unknown): Rec | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return {
    blocker: readCount(record.blocker) ?? 0,
    major: readCount(record.major) ?? 0,
    minor: readCount(record.minor) ?? 0,
  };
}

function readCappedArray(
  value: unknown,
  cap: number,
  label: string,
  warnings: string[],
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.slice(0, cap);
  if (value.length > kept.length) {
    warnings.push(`${label} limited to first ${kept.length} of ${value.length}`);
  }
  return kept;
}

function buildValidatorReport(
  value: string | ValidatorReportInput,
  warnings: string[],
): Rec | undefined {
  // String arm: the validator service passes the tool's compact renderSummary
  // (§6.1 ≤2000 chars) verbatim — parse JSON so the model reads structured
  // fields instead of escaped JSON-in-JSON; unparseable strings embed raw.
  if (typeof value === "string") {
    const parsed = parseEmbeddedJson(value);
    const record = asRecord(parsed);
    return record === undefined ? { report: value } : { report: record };
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const ok = readBool(record.ok);
  if (ok === undefined) {
    warnings.push("validator report ignored (no ok verdict)");
    return undefined;
  }
  const payload: Record<string, unknown> = { ok };
  const issueCounts = readIssueCounts(record.issueCounts);
  if (issueCounts !== undefined) payload.issueCounts = issueCounts;
  const issues = readCappedArray(
    record.issues,
    MAX_VALIDATOR_ISSUES,
    "validator report: issues",
    warnings,
  );
  if (issues !== undefined) payload.issues = issues;
  const criticIssues = readCappedArray(
    record.criticIssues,
    MAX_VALIDATOR_ISSUES,
    "validator report: critic issues",
    warnings,
  );
  if (criticIssues !== undefined) payload.criticIssues = criticIssues;
  const truncated = readBool(record.truncated);
  if (truncated !== undefined) payload.truncated = truncated;
  // Both arms wrap under `report` — one stable shape for the model (§5.4 item 6).
  return { report: payload };
}

// ---------------------------------------------------------------------------
// ContextAssembler
// ---------------------------------------------------------------------------

export interface ContextAssemblerOptions {
  /** Per-section char budgets (tests / degraded tiers override here). */
  readonly budgets?: Partial<Readonly<Record<ContextSectionId, number>>>;
}

function sanitizedBudgets(
  overrides: Partial<Readonly<Record<ContextSectionId, number>>> | undefined,
): Partial<Record<ContextSectionId, number>> {
  if (overrides === undefined) return {};
  const out: Partial<Record<ContextSectionId, number>> = {};
  for (const [id, budget] of Object.entries(overrides)) {
    if (typeof budget === "number" && Number.isInteger(budget) && budget > 0) {
      out[id as ContextSectionId] = budget;
    }
  }
  return out;
}

/**
 * Assembles the §5.4 model context. Pure: same input → byte-identical output,
 * so re-assembling each turn keeps the cached prefix stable (§5.4 "the cache
 * prefix never shifts mid-run"). The worker owns one instance per run.
 */
export class ContextAssembler {
  private readonly budgets: Readonly<Record<ContextSectionId, number>>;

  constructor(options: ContextAssemblerOptions = {}) {
    this.budgets = { ...DEFAULT_SECTION_CHAR_BUDGETS, ...sanitizedBudgets(options.budgets) };
  }

  /** §5.4 assembly: sections in order, canonical bytes, cached-prefix hash. */
  assembleContext(input: ContextInput): AssembledContext {
    const warnings: string[] = [];
    const sections: AssembledSection[] = [];
    for (const id of CONTEXT_SECTION_IDS) {
      const content = this.buildSection(id, input, warnings);
      if (content === undefined) continue;
      const budget = this.budgets[id];
      const capped = capText(content, budget);
      if (capped.truncated) {
        warnings.push(
          `${id} truncated from ${capped.originalChars} to ${budget} chars (§5.4 section budget)`,
        );
      }
      sections.push({
        id,
        role: "system",
        content: capped.text,
        chars: capped.text.length,
        cached: (CACHED_SECTION_IDS as readonly ContextSectionId[]).includes(id),
        truncated: capped.truncated,
      });
    }
    const messages: ContextMessage[] = sections.map((section) => ({
      role: "system",
      content: section.content,
    }));
    // Sections are in §5.4 order, so the cached filter preserves items 1-3.
    const cachedContents = sections
      .filter((section) => section.cached)
      .map((section) => section.content);
    return {
      messages,
      cacheablePrefix: hashCachePrefix(cachedContents),
      sections,
      warnings: finalizeWarnings(warnings),
    };
  }

  private buildSection(
    id: ContextSectionId,
    input: ContextInput,
    warnings: string[],
  ): string | undefined {
    switch (id) {
      case "system_prompt": {
        if (typeof input.system !== "string" || input.system.length === 0) {
          warnings.push("system prompt missing (not a non-empty string); section omitted");
          return undefined;
        }
        return canonicalStringify({ section: id, text: input.system });
      }
      case "style_guide": {
        if (input.styleGuide === undefined) return undefined;
        const data = buildStyleGuide(input.styleGuide, warnings);
        return data === undefined ? undefined : canonicalStringify({ ...data, section: id });
      }
      case "template_manifest": {
        if (input.templateManifest === undefined) return undefined;
        const data = buildTemplateManifest(input.templateManifest, warnings);
        return data === undefined ? undefined : canonicalStringify({ ...data, section: id });
      }
      case "document_summary":
        return this.buildDocumentSummarySection(input.documentSummary, warnings);
      case "brief": {
        if (input.brief === undefined) return undefined;
        const data = buildBrief(input.brief, warnings);
        return data === undefined ? undefined : canonicalStringify({ ...data, section: id });
      }
      case "validator_report": {
        if (input.priorValidatorReport === undefined) return undefined;
        const data = buildValidatorReport(input.priorValidatorReport, warnings);
        return data === undefined ? undefined : canonicalStringify({ ...data, section: id });
      }
      default:
        return undefined; // unreachable: CONTEXT_SECTION_IDS is exhaustive
    }
  }

  /**
   * §5.4 (4). Compact arm: the workspace_snapshot tool's §5.4-FILTERED bytes
   * (the seam contract) or an Observation.compactSummary — parseable JSON is
   * embedded as structured fields (cheaper tokens than escaped JSON-in-JSON).
   * Structured arm: rows pass through THIS module's whitelist projection, then
   * the largest id-sorted layer prefix that fits the §5.4 budget is kept.
   */
  private buildDocumentSummarySection(
    value: DocumentSummaryInput | undefined,
    warnings: string[],
  ): string | undefined {
    if (value === undefined) return undefined;
    const record = asRecord(value);
    if (record === undefined) {
      warnings.push("document summary ignored (malformed input)");
      return undefined;
    }
    const revision = readRevision(record.revision);

    // Compact arm (string): trusted tool bytes — the §5.4 filtering happened in
    // workspace_snapshot (its job, its seam contract); this module only embeds
    // + budget-caps. Revision overrides any value inside the parsed summary.
    if (typeof record.summary === "string") {
      const text = record.summary;
      if (text.length === 0) {
        warnings.push("document summary ignored (empty summary string)");
        return undefined;
      }
      const parsed = parseEmbeddedJson(text);
      const parsedRecord = asRecord(parsed);
      if (parsedRecord !== undefined) {
        const merged: Record<string, unknown> = { ...parsedRecord };
        if (revision !== undefined) merged.revision = revision;
        return canonicalStringify({ ...merged, section: "document_summary" });
      }
      const raw: Record<string, unknown> = revision === undefined ? {} : { revision };
      raw.summary = text;
      return canonicalStringify({ ...raw, section: "document_summary" });
    }

    // Structured arm: THIS module's whitelist compaction (§5.4 "never a full
    // dump" enforced mechanically — unknown fields never copy).
    if (!Array.isArray(record.layers)) {
      warnings.push(
        "document summary ignored (neither a compact summary string nor a layers array)",
      );
      return undefined;
    }
    const rows = compactLayerRows(record.layers, warnings);
    const projected = rows.slice(0, MAX_LAYERS_IN_CONTEXT);
    if (rows.length > projected.length) {
      warnings.push(
        `document summary: layer tree limited to first ${projected.length} of ${rows.length} rows (id order)`,
      );
    }
    const canvas = readCanvas(record.canvas);
    if (canvas === undefined && record.canvas !== undefined) {
      warnings.push("document summary: canvas unreadable; omitted");
    }
    const build = (layerRows: readonly SummaryLayerRow[]): string => {
      const payload: Record<string, unknown> = {};
      if (revision !== undefined) payload.revision = revision;
      if (canvas !== undefined) payload.canvas = canvas;
      if (layerRows.length > 0) payload.layers = layerRows;
      return canonicalStringify({ ...payload, section: "document_summary" });
    };

    let content = build(projected);
    const budget = this.budgets.document_summary;
    if (content.length > budget && projected.length > 0) {
      // Largest id-sorted layer prefix that fits (length is monotonic in the
      // prefix — binary search, same trick as the tool's summarize pass).
      let low = 0;
      let high = projected.length;
      let best = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (build(projected.slice(0, mid)).length <= budget) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best < projected.length) {
        warnings.push(
          `document summary: layer tree truncated to ${best} of ${projected.length} rows ` +
            `(of ${rows.length} in the document) to fit the §5.4 budget`,
        );
        content = build(projected.slice(0, best));
      }
    }
    return content;
  }
}

/** Default instance for the worker (pure — safe to share across runs). */
export const defaultContextAssembler = new ContextAssembler();
