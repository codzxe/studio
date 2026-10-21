// @studio/tools — template_list (§6 row 2; engine `template.list`, §7.4).
//
// CARD view, never a manifest dump: each row is {id, name, version, tags,
// canvas, slots: string[]} — slot NAMES only; bounds/rules/layerMap belong to
// template_inspect (§6: "List templates with slots and tags"). The card list
// rides the §6.1 envelope as compact JSON in the `summary` string
// (`{"templates":[…]}` — the engine's §7.4 reply shape) because the kit's
// result envelopes carry a string summary.
//
// Semantics mirror the engine (template_cmds.rs `list_from`) and the gateway
// catalog (services/catalog.ts `tagsMatchAll`/`queryMatches`): tags match AND,
// trimmed, case-insensitively; `query` is a case-insensitive substring over the
// seam's id+title (the engine also matches description; the minimal
// TemplateSummary seam has none). ctx.templates (types.ts) exposes ONE list()
// hop with a single `tag` filter, so this tool filters in-tool — one full
// list() hop is also what the unknown-tag warning needs to name the tags that
// do exist. Unknown tags are NOT an error (§6.1): ok with an empty list plus a
// warning listing the available tags, so the model can retry with real ones.
//
// Shared W5-B probe helpers (probeFields/fieldOf/capText/pin order) live here
// and are imported by template-inspect.ts — both files are this task's own.

import { z } from "zod";
import {
  MAX_SUMMARY_CHARS,
  MAX_WARNING_CHARS,
  cappedArray,
  cappedString,
  defineTool,
  ok,
  strictObject,
} from "../kit.js";
import type { TemplateSummary, Tool } from "../types.js";

// ---------------------------------------------------------------------------
// Contract limits (engine template_cmds.rs + gateway catalog caps)
// ---------------------------------------------------------------------------

/** `tags` filter cap — tighter than the engine's MAX_QUERY_TAGS (32), per W5-B. */
export const MAX_LIST_TAGS = 12;
/** Tag strings are 1..64 chars (gateway catalog tag schema). */
export const MAX_TAG_CHARS = 64;
/** `query` cap (W5-B contract; the engine leaves it unbounded). */
export const MAX_QUERY_CHARS = 120;
/** §6.1 compact reply fits ~16 cards; this also bounds the cached get() hops. */
export const MAX_LIST_CARDS = 16;
/** Error hints list at most this many `id@version` pins (engine SHOWN_PINS). */
export const MAX_SHOWN_PINS = 8;
/** Warnings list at most this many available tags. */
const MAX_SHOWN_TAGS = 12;

// ---------------------------------------------------------------------------
// Shared probe helpers (§7.2 runtime widening over the minimal tools seam)
// ---------------------------------------------------------------------------

/** Safely reads one field off an `unknown` object (never throws). */
export function fieldOf(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * Copies only the fields of `source` that parse against their schema — a
 * fresh mutable record; absent or invalid fields are dropped, never echoed
 * (§6.1). The tools seam (types.ts) is a MINIMAL structural type: real
 * manifests carry more §7.2 fields, which are read through this gate.
 */
export function probeFields(
  source: unknown,
  fields: Readonly<Record<string, z.ZodTypeAny>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof source !== "object" || source === null) return out;
  const record = source as Record<string, unknown>;
  for (const [key, schema] of Object.entries(fields)) {
    const parsed = schema.safeParse(record[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

const CANVAS_FIELDS = {
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000),
} as const satisfies Readonly<Record<string, z.ZodTypeAny>>;

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/** Card canvas `{width,height}` — only when the runtime manifest carries one. */
export function probeCanvasSize(manifest: unknown): CanvasSize | undefined {
  const probed = probeFields(fieldOf(manifest, "canvas"), CANVAS_FIELDS);
  const { width, height } = probed;
  return typeof width === "number" && typeof height === "number"
    ? { width, height }
    : undefined;
}

/** Hard text cap, the kit's `...` convention (warnings and hints). */
export function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Numeric-aware version order ("2" < "10", "1.0.0" < "2"); string otherwise. */
export function compareVersions(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb || a.localeCompare(b);
  }
  return a.localeCompare(b);
}

/** Sort key mirroring the engine catalog: id, then version. */
export function byIdThenVersion(
  a: { readonly id: string; readonly version: string },
  b: { readonly id: string; readonly version: string },
): number {
  return a.id !== b.id
    ? (a.id < b.id ? -1 : 1)
    : compareVersions(a.version, b.version);
}

/** The immutable `id@version` pin (§7.2) — always explicit in replies/logs. */
export function pinOf(entry: { readonly id: string; readonly version: string }): string {
  return `${entry.id}@${entry.version}`;
}

// ---------------------------------------------------------------------------
// template_list (§6 row 2)
// ---------------------------------------------------------------------------

export interface TemplateListArgs {
  readonly tags?: readonly string[];
  readonly query?: string;
}

/** §7.4 card row: discovery shape, slots as names only — NOT a manifest. */
export interface TemplateCardView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly canvas?: CanvasSize;
  readonly slots: readonly string[];
}

const templateListArgs = strictObject({
  // Engine `tag_param`: a non-empty array of non-empty strings, or absent.
  tags: cappedArray(MAX_LIST_TAGS, cappedString(MAX_TAG_CHARS, 1)).min(1).optional(),
  query: cappedString(MAX_QUERY_CHARS, 1).optional(),
});

function toCard(
  summary: TemplateSummary,
  slots: readonly string[],
  canvas: CanvasSize | undefined,
): TemplateCardView {
  const base = {
    id: summary.id,
    name: summary.title,
    version: summary.version,
    tags: [...summary.tags],
  };
  return canvas === undefined ? { ...base, slots } : { ...base, canvas, slots };
}

/** Sorted, deduped tags that actually exist (first-seen casing). */
function availableTags(summaries: readonly TemplateSummary[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const summary of summaries) {
    for (const raw of summary.tags) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (tag === "" || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function tagList(tags: readonly string[]): string {
  const shown = tags.slice(0, MAX_SHOWN_TAGS).join(", ");
  return tags.length > MAX_SHOWN_TAGS ? `${shown}, ...` : shown;
}

/** Engine semantics: AND over `wanted` tags + substring over the seam's id+title. */
function matchesFilters(
  summary: TemplateSummary,
  wanted: readonly string[],
  needle: string,
): boolean {
  const carriesAll = wanted.every((tag) =>
    summary.tags.some((own) => own.trim().toLowerCase() === tag),
  );
  return (
    carriesAll &&
    (needle === "" || `${summary.id} ${summary.title}`.toLowerCase().includes(needle))
  );
}

export const templateList: Tool<TemplateListArgs> = defineTool({
  name: "template_list",
  description:
    "List template cards (id, name, version, tags, canvas, slot names) with AND-tag and text-query filters; use template_inspect on a pin for slot bounds and rules.",
  args: templateListArgs,
  async run(ctx, args) {
    const warnings: string[] = [];
    const summaries = [...(await ctx.templates.list())].sort(byIdThenVersion);
    if (summaries.length === 0) {
      return ok({
        summary: '{"templates":[]}',
        warnings: ["the template catalog is empty — nothing to list"],
      });
    }
    const available = availableTags(summaries);
    const availableSet = new Set(available.map((tag) => tag.toLowerCase()));
    const wanted = [...new Set((args.tags ?? []).map((tag) => tag.trim().toLowerCase()))];
    const unknownTags = wanted.filter((tag) => !availableSet.has(tag));
    const needle = args.query?.trim().toLowerCase() ?? "";
    const matches = summaries.filter((summary) => matchesFilters(summary, wanted, needle));
    if (unknownTags.length > 0) {
      warnings.push(
        capText(
          `unknown tag(s): ${unknownTags.join(", ")}; available tags: ${tagList(available)}`,
          MAX_WARNING_CHARS,
        ),
      );
    } else if (wanted.length > 0 && matches.length === 0) {
      warnings.push(
        capText(
          `no template carries all wanted tags (AND-match); available tags: ${tagList(available)}`,
          MAX_WARNING_CHARS,
        ),
      );
    } else if (needle !== "" && matches.length === 0) {
      warnings.push(
        capText(
          "no template matches the query; list without it to see every template",
          MAX_WARNING_CHARS,
        ),
      );
    }
    const cards: TemplateCardView[] = [];
    for (const summary of matches.slice(0, MAX_LIST_CARDS)) {
      const manifest = await ctx.templates.get(pinOf(summary));
      if (manifest === undefined) {
        // list()/get() drift inside the catalog — never fabricate a card.
        warnings.push(
          capText(`${pinOf(summary)} is listed but its manifest is missing`, MAX_WARNING_CHARS),
        );
        continue;
      }
      cards.push(toCard(summary, Object.keys(manifest.slots), probeCanvasSize(manifest)));
    }
    let summaryJson = JSON.stringify({ templates: cards });
    while (summaryJson.length > MAX_SUMMARY_CHARS && cards.length > 0) {
      cards.pop();
      summaryJson = JSON.stringify({ templates: cards });
    }
    if (matches.length > cards.length) {
      warnings.push(
        capText(
          `showing ${cards.length} of ${matches.length} matches; narrow with tags or query`,
          MAX_WARNING_CHARS,
        ),
      );
    }
    ctx.logger.debug("template_list resolved", {
      matches: matches.length,
      shown: cards.length,
      unknownTags: unknownTags.length,
    });
    return ok({
      summary: summaryJson,
      warnings: warnings.length === 0 ? undefined : warnings,
    });
  },
});
