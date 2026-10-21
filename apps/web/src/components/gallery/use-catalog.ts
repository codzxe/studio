// apps/web — catalog hooks + wire mirrors (W8-J).
//
// The browser layer over the gateway catalog (§13.1):
//   GET /v1/templates?tags=&query=     discovery cards (§7.4 template.list)
//   GET /v1/templates/:id?version=N    full §7.2 manifest (template.inspect)
//   GET /v1/components?tags=&query=    discovery cards (§8.3 component.list)
//   GET /v1/components/:id?version=N   full §8.2 manifest (component.inspect)
//
// Wire schemas are local mirrors of apps/gateway/src/services/catalog.ts —
// the same posture as the SSE mirror in src/lib/api.ts: the gateway package
// is server-side and not importable from the browser bundle. TODO(sync):
// keep in step with W4-J. Mirrors are deliberately NOT `.strict()` (the
// gateway's load schema carries the same note: engine serde types are the
// frozen contract, a schema-growth field must not blank a gallery).
//
// Caching (W8-J contract): manifests are versioned and immutable — an
// `id@version` pin never changes content (§7.2/§10.4) — so inspect queries
// use staleTime Infinity. Cards use a long finite window: the gateway loads
// the catalog at boot (W4-J), so a long session eventually notices new
// pins after a deploy without re-fetching on every visit.
//
// Relative `../../lib/api` imports (not the `@/` alias) keep this module
// importable by the repo's config-less vitest (tests/api.test.ts precedent).

import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { createGatewayClientFromEnv, type GatewayClient } from "../../lib/api";

// ---------------------------------------------------------------------------
// Wire mirrors — discovery cards (§7.4 / §8.3)
// ---------------------------------------------------------------------------

const HEX_SCHEMA = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'hex colours are "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa"');

/** `[x, y, w, h]` (§7.2 slot bounds). */
export type SlotBounds = readonly [number, number, number, number];
const BOUNDS_SCHEMA = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const AUTO_FIT_SCHEMA = z.object({ minSize: z.number(), maxSize: z.number() });

/** `GET /v1/templates` card — discovery shape, NOT the full manifest (§7.4). */
export const templateCardSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  /** The immutable `id@version` pin — always explicit in replies (§7.2). */
  ref: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  canvas: z.object({ width: z.number().int(), height: z.number().int() }),
  slots: z.array(z.string()),
});
export type TemplateCard = z.infer<typeof templateCardSchema>;

export const templateCardsSchema = z.object({ templates: z.array(templateCardSchema) });
export type TemplateCards = z.infer<typeof templateCardsSchema>;

/** `GET /v1/components` card (§8.3 discovery shape). */
export const componentCardSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  ref: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  defaultSize: z.object({ width: z.number().int(), height: z.number().int() }),
  license: z.string(),
  variables: z.array(z.string()),
  comps: z.array(z.string()),
});
export type ComponentCard = z.infer<typeof componentCardSchema>;

export const componentCardsSchema = z.object({ components: z.array(componentCardSchema) });
export type ComponentCards = z.infer<typeof componentCardsSchema>;

// ---------------------------------------------------------------------------
// Wire mirrors — full manifests (§7.2 / §8.2)
// ---------------------------------------------------------------------------

/** The slot union — `kind`-tagged, exactly the engine's five kinds (§7.3). */
export const templateSlotSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    layer: z.string(),
    bounds: BOUNDS_SCHEMA,
    font: z.string(),
    size: z.number(),
    weight: z.string().optional(),
    lineHeight: z.number().optional(),
    maxLines: z.number().int().optional(),
    maxChars: z.number().int().optional(),
    align: z.enum(["left", "center", "right", "justify"]).optional(),
    color: HEX_SCHEMA.optional(),
    autoFit: AUTO_FIT_SCHEMA.optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("image"),
    layer: z.string(),
    bounds: BOUNDS_SCHEMA,
    fit: z.enum(["cover", "contain", "fill"]),
    minPixels: z.tuple([z.number().int(), z.number().int()]).optional(),
    focal: z.tuple([z.number(), z.number()]).optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("component"),
    layer: z.string(),
    component: z.string(),
    bounds: BOUNDS_SCHEMA.optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("color"),
    layer: z.string(),
    color: HEX_SCHEMA.optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("visibility"),
    layer: z.string(),
    default: z.boolean().optional(),
    optional: z.boolean().optional(),
  }),
]);
export type TemplateSlot = z.infer<typeof templateSlotSchema>;

/** A §7.2 template manifest (permissive mirror — see header note). */
export const templateManifestSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  canvas: z.object({
    width: z.number().int(),
    height: z.number().int(),
    background: HEX_SCHEMA.optional(),
  }),
  slots: z.record(z.string(), templateSlotSchema).optional(),
  rules: z
    .object({
      safeArea: z.number().optional(),
      minContrast: z.number().optional(),
      mustLayers: z.array(z.string()).optional(),
      maxTextLayers: z.number().int().optional(),
      palette: z.array(HEX_SCHEMA).optional(),
    })
    .optional(),
  layerMap: z
    .record(
      z.string(),
      z.object({
        role: z.string(),
        fill: HEX_SCHEMA.optional(),
        mask: z.string().optional(),
        maskRadius: z.number().optional(),
        component: z.string().optional(),
      }),
    )
    .optional(),
  thumbnail: z.string().optional(),
  license: z.string().optional(),
  author: z.string().optional(),
});
export type TemplateManifest = z.infer<typeof templateManifestSchema>;

export const templateInspectSchema = z.object({ template: templateManifestSchema });
export type TemplateInspect = z.infer<typeof templateInspectSchema>;

/** §8.2 variable specs: `kind` selects the default's type (strict engine rule). */
export const componentVariableSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    default: z.string(),
    maxChars: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("color"), default: HEX_SCHEMA }),
  z.object({ kind: z.literal("visibility"), default: z.boolean() }),
]);
export type ComponentVariable = z.infer<typeof componentVariableSchema>;

/** A §8.2 component manifest (license is required there, author optional). */
export const componentManifestSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  author: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  defaultSize: z.object({ width: z.number().int(), height: z.number().int() }),
  variables: z.record(z.string(), componentVariableSchema).optional(),
  anchors: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
  comps: z.array(z.string()).optional(),
  license: z.string(),
});
export type ComponentManifest = z.infer<typeof componentManifestSchema>;

export const componentInspectSchema = z.object({ component: componentManifestSchema });
export type ComponentInspect = z.infer<typeof componentInspectSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in use-catalog.test.ts)
// ---------------------------------------------------------------------------

/** List filter accepted by both catalog endpoints (§7.4). */
export interface CatalogFilter {
  readonly tags?: readonly string[];
  readonly query?: string;
}

/**
 * Serializes a filter into the `?tags=&query=` wire form, OMITTING empty
 * parameters: the gateway requires ≥1 tag in `tags` and treats `query` as a
 * substring search (TAGS_LIST_SCHEMA, W4-J) — an empty filter lists
 * everything. Normalizing the empty case also keeps the unfiltered and the
 * "no filters yet" query keys identical, so react-query dedupes them.
 */
export function buildCatalogSearchParams(filter?: CatalogFilter | null): string {
  const tags = (filter?.tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const query = (filter?.query ?? "").trim();
  if (tags.length === 0 && query.length === 0) {
    return "";
  }
  const params = new URLSearchParams();
  if (tags.length > 0) {
    params.set("tags", tags.join(","));
  }
  if (query.length > 0) {
    params.set("query", query);
  }
  return params.toString();
}

/** A tag + how many catalog cards carry it (drives the filter chips). */
export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

export interface CollectTagCountsOptions {
  /** How many chips to show by default (frequency first). */
  readonly limit?: number;
  /** Tags that must stay visible even past the limit (active selections). */
  readonly alwaysInclude?: readonly string[];
}

/** How many tag chips the galleries surface by default. */
export const DEFAULT_TAG_CHIP_LIMIT = 12;

/**
 * Counts tags across cards (case-insensitive, once per card) and ranks them
 * by frequency, then name. `alwaysInclude` re-surfaces selected tags that
 * fell past the limit — a selected chip must never disappear from view.
 */
export function collectTagCounts(
  items: readonly { readonly tags: readonly string[] }[],
  options: CollectTagCountsOptions = {},
): readonly TagCount[] {
  const limit = options.limit ?? DEFAULT_TAG_CHIP_LIMIT;
  const always = new Set(
    (options.alwaysInclude ?? []).map((tag) => tag.trim().toLowerCase()),
  );
  const counts = new Map<string, number>();
  for (const item of items) {
    const seen = new Set<string>();
    for (const tag of item.tags) {
      const key = tag.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) {
        continue; // one card counts each tag once, whatever its casing
      }
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const byFrequencyThenName = (a: TagCount, b: TagCount): number =>
    b.count - a.count || a.tag.localeCompare(b.tag);
  const ranked = [...counts.entries()]
    .map((entry): TagCount => ({ tag: entry[0], count: entry[1] }))
    .sort(byFrequencyThenName);
  const top = ranked.slice(0, Math.max(0, limit));
  const pinned = ranked.filter(
    (entry) => always.has(entry.tag) && !top.some((candidate) => candidate.tag === entry.tag),
  );
  return [...top, ...pinned].sort(byFrequencyThenName);
}

/** Ratio terms above this value stop being readable — the chip is dropped. */
const MAX_RATIO_TERM = 99;

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y > 0) {
    const rest = x % y;
    x = y;
    y = rest;
  }
  return x;
}

/**
 * The canvas's simplified aspect ratio ("1:1", "16:9", "9:16") or null when
 * it does not reduce to two small terms (e.g. a 1063×652 print card) —
 * better no chip than a noisy one.
 */
export function aspectLabel(width: number, height: number): string | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const divisor = greatestCommonDivisor(width, height);
  const w = width / divisor;
  const h = height / divisor;
  if (w > MAX_RATIO_TERM || h > MAX_RATIO_TERM) {
    return null;
  }
  return `${w}:${h}`;
}

/**
 * The compose handoff (W8-D contract): "Use template" lands on the compose
 * page with the pinned manifest preselected via `?template=id@version`.
 * TODO(W8-D): once (app)/compose exists, swap the window.location handoff in
 * the gallery for a typed <Link> — typedRoutes (next.config.ts) only accepts
 * hrefs for routes that exist at build time.
 */
export const COMPOSE_ROUTE = "/compose";

export function composeHref(pin: string): string {
  return `${COMPOSE_ROUTE}?template=${encodeURIComponent(pin)}`;
}

/** One search input → one endpoint hit: debounce the wire query param. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Gateway client + hooks
// ---------------------------------------------------------------------------

let cachedGateway: GatewayClient | undefined;

/**
 * Lazy singleton — never constructed at module scope: `next build`
 * prerenders client components without an `.env`, and src/lib/env.ts fails
 * fast on FIRST USE by design (first real gateway call, never at build).
 */
function gateway(): GatewayClient {
  cachedGateway ??= createGatewayClientFromEnv();
  return cachedGateway;
}

/** Cards change only when the gateway restarts (boot-time catalog, W4-J). */
const CARD_STALE_TIME_MS = 5 * 60_000;
/** `id@version` content is immutable (§7.2/§10.4) — never stale, just cached. */
const MANIFEST_STALE_TIME_MS = Infinity;
/** Keep inspected manifests around between modal opens; they never change. */
const MANIFEST_GC_TIME_MS = 30 * 60_000;

function catalogPath(prefix: string, params: string): string {
  return params.length > 0 ? `${prefix}?${params}` : prefix;
}

export function useTemplateCards(filter?: CatalogFilter): UseQueryResult<TemplateCards> {
  const params = buildCatalogSearchParams(filter);
  return useQuery({
    queryKey: ["catalog", "templates", params],
    queryFn: () =>
      gateway().get(catalogPath("/templates", params), { schema: templateCardsSchema }),
    staleTime: CARD_STALE_TIME_MS,
    // The previous page of results stays visible while a new filter fetches.
    placeholderData: keepPreviousData,
  });
}

export function useComponentCards(filter?: CatalogFilter): UseQueryResult<ComponentCards> {
  const params = buildCatalogSearchParams(filter);
  return useQuery({
    queryKey: ["catalog", "components", params],
    queryFn: () =>
      gateway().get(catalogPath("/components", params), { schema: componentCardsSchema }),
    staleTime: CARD_STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });
}

export function useTemplateManifest(
  id: string | null,
  version: number | null,
): UseQueryResult<TemplateInspect> {
  return useQuery({
    queryKey: ["catalog", "template", id, version],
    // A null id means "nothing selected" — hold the query until a card is picked.
    enabled: id !== null,
    staleTime: MANIFEST_STALE_TIME_MS,
    gcTime: MANIFEST_GC_TIME_MS,
    queryFn: () => {
      if (id === null) {
        throw new Error("useTemplateManifest requires a template id");
      }
      const suffix = version === null ? "" : `?version=${encodeURIComponent(version)}`;
      return gateway().get(`/templates/${encodeURIComponent(id)}${suffix}`, {
        schema: templateInspectSchema,
      });
    },
  });
}

export function useComponentManifest(
  id: string | null,
  version: number | null,
): UseQueryResult<ComponentInspect> {
  return useQuery({
    queryKey: ["catalog", "component", id, version],
    enabled: id !== null,
    staleTime: MANIFEST_STALE_TIME_MS,
    gcTime: MANIFEST_GC_TIME_MS,
    queryFn: () => {
      if (id === null) {
        throw new Error("useComponentManifest requires a component id");
      }
      const suffix = version === null ? "" : `?version=${encodeURIComponent(version)}`;
      return gateway().get(`/components/${encodeURIComponent(id)}${suffix}`, {
        schema: componentInspectSchema,
      });
    },
  });
}
