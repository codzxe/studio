// @studio/gateway — the template/component catalog service (§7.2 template
// manifests, §8.2 component manifests, §13.1 `GET /v1/templates` /
// `GET /v1/components` — "Catalog with manifests"). Owner: W4-J.
//
// Spec anchors:
//   §7.2   template manifest schema — versioned, validated JSON; `id@version`
//          pins are immutable once shipped
//   §7.4   templates ship as data; start with 3 (Instagram post, YouTube
//          thumbnail, presentation slide), grow to 10 by beta
//   §8.2   component manifest schema; §8.3 the 5–10 hard-coded start
//          components (logo lockup, offer badge, star rating, price tag,
//          button, quote block, avatar, wave divider, ribbon, social handle)
//   §12.1  workspace_templates rows are public (organization_id null) or
//          workspace-scoped; registration lands a workspace row
//   §13.1  GET /v1/templates / GET /v1/components + manifests
//   §13.3  typed envelopes; never leak stack traces or absolute paths
//   §15.1  §12.2 tenant scoping — workspace registration is composite-scoped
//          by organization_id, never find-then-check
//
// The seed catalog lives in REPO DATA, not the DB: `evals/templates/*/`
// (`manifest.json`, §7.2) and `evals/components/*/` (`component.json`, §8.2).
// The service reads them with `fs` once at startup, validates each with Zod
// at the boundary, and caches them immutably keyed by `id@version` — this
// module NEVER writes manifest files. The catalog dir resolves repo-relative
// (walk up from this module to `pnpm-workspace.yaml`, then `evals/`); the
// `STUDIO_CATALOG_DIR` env override points it elsewhere (prod containers ship
// the catalog dir next to the gateway and set the var).
//
// DRIFT POSTURE (mirrors the engine, `engine-patches/template_cmds/manifest.rs`
// + `component_cmds/component_manifest.rs` — the protocol truth for the
// catalog): Zod here is a VALIDATOR, not the storage type. Schemas accept the
// union of what the engine accepts — optional fields stay optional (no
// `.default()` materialization), and the catalog keeps the RAW parsed JSON so
// `inspect` returns the manifest exactly as shipped. Validation skips an
// invalid manifest with a warning (§21: the catalog must never serve an
// unparseable manifest), and boot FAILS LOUD when zero valid manifests load
// (docs/AGENTS.md "fail fast") — an empty catalog is a wiring/mount bug, not a
// state to serve 200s from.
//
// Workspace registration (POST /v1/workspaces/:id/templates, §7.2
// `license: workspace | public`) is the ONE write path, over an injected
// DbLike seam into `workspace_templates` (W1-D schema). Row ids are
// deterministic (SHA-256 of the natural key org+id+version), so a retried
// registration dedupes on the primary key instead of stacking rows — §13's
// Idempotency-Key is still required at the route, and the natural key is the
// durable dedupe.

import { err, ok, type Result } from "@studio/config";
import {
  workspaceTemplates,
  type TemplateSource,
  type WorkspaceTemplate,
} from "@studio/db";
import { ROLE_RANK, type Role } from "../authz/roles.js";
import type { Logger } from "pino";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type { RateLimiter } from "./limiter.js";

// ---------------------------------------------------------------------------
// Catalog bounds — mirror the engine's caps (see the DRIFT POSTURE above)
// ---------------------------------------------------------------------------

/** One manifest may be at most 4 MiB (engine MAX_MANIFEST_BYTES). */
export const MAX_MANIFEST_BYTES = 4 << 20;
/** One kind may serve at most 256 entries (engine MAX_TEMPLATES). */
export const MAX_CATALOG_ENTRIES_PER_KIND = 256;
/** `list` accepts at most this many `tags` filters (engine MAX_QUERY_TAGS). */
export const MAX_QUERY_TAGS = 32;
/** Error hints list at most this many `id@version` pins (engine SHOWN_PINS). */
export const SHOWN_PINS = 8;
/** Catalog ids: a slug of lowercase letters, digits and hyphens, 1..64. */
export const CATALOG_ID_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, {
    message: "catalog ids are slugs: lowercase letters, digits and hyphens",
  });
/** Versions start at 1 (§7.2; engine `version: u64` with `version >= 1`). */
export const VERSION_SCHEMA = z.number().int().min(1).max(1_000_000_000);

/** §7.2/§8.4: a template or component is `workspace`-private or `public`. */
export const TEMPLATE_LICENSES = ["workspace", "public"] as const;
export type TemplateLicense = (typeof TEMPLATE_LICENSES)[number];
const licenseSchema = z.enum(TEMPLATE_LICENSES);

/** Template colours are `#rrggbb` or `#rrggbbaa` (engine parse_hex). */
const templateHexSchema = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
  message: 'colours must be "#rrggbb" or "#rrggbbaa"',
});
/** Component variables additionally allow short `#rgb`/`#rgba` (§8.2 README). */
const componentHexSchema = z.string().regex(
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
  { message: 'colours must be "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa"' },
);

/** A `component@version` pin, or a plain id meaning "the newest" (§7.3). */
const componentRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(129)
  .refine(
    (value) => /^[^@/:\\]{1,64}(?:@[1-9][0-9]*)?$/.test(value) && !/[\u0000-\u001f]/.test(value),
    { message: "component references are `id` or `id@version` (version >= 1)" },
  );

// ---------------------------------------------------------------------------
// §7.2 template manifest schema
// ---------------------------------------------------------------------------

/** `[x, y, w, h]`: finite, placeable, non-negative size (engine check_bounds). */
const boundsSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(
    ([x, y, w, h]) =>
      [x, y, w, h].every((n) => Number.isFinite(n)) &&
      Math.abs(x) <= 1e7 &&
      Math.abs(y) <= 1e7 &&
      w >= 0 &&
      w <= 1e7 &&
      h >= 0 &&
      h <= 1e7,
    { message: "bounds must be [x, y, w, h] within ±1e7 with non-negative size" },
  );

const autoFitSchema = z.object({
  minSize: z.number(),
  maxSize: z.number(),
});

/** The slot union — `kind`-tagged, exactly the engine's five kinds (§7.3). */
const slotSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    layer: z.string().min(1).max(256),
    bounds: boundsSchema,
    font: z.string().min(1).max(256),
    size: z.number(),
    weight: z.string().min(1).max(64).optional(),
    lineHeight: z.number().optional(),
    maxLines: z.number().int().min(1).optional(),
    maxChars: z.number().int().min(1).optional(),
    align: z.enum(["left", "center", "right", "justify"]).optional(),
    color: templateHexSchema.optional(),
    autoFit: autoFitSchema.optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("image"),
    layer: z.string().min(1).max(256),
    bounds: boundsSchema,
    fit: z.enum(["cover", "contain", "fill"]),
    minPixels: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
    focal: z
      .tuple([z.number(), z.number()])
      .refine(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1, {
        message: "focal coordinates are within 0..=1",
      })
      .optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("component"),
    component: componentRefSchema,
    layer: z.string().min(1).max(256),
    bounds: boundsSchema.optional(),
    vars: z.record(z.string().min(1).max(64), z.unknown()).optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("color"),
    layer: z.string().min(1).max(256),
    color: templateHexSchema.optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("visibility"),
    layer: z.string().min(1).max(256),
    default: z.boolean().optional(),
    optional: z.boolean().optional(),
  }),
]);

/**
 * A §7.2 manifest. Deliberately NOT `.strict()`: the engine's serde types are
 * the frozen contract and the catalog stores the raw document (see DRIFT
 * POSTURE) — a schema-growth field must not make the gateway drop a manifest
 * the engine serves.
 */
export const TEMPLATE_MANIFEST_SCHEMA = z.object({
  id: CATALOG_ID_SCHEMA,
  version: VERSION_SCHEMA,
  name: z.string().min(1).max(128),
  description: z.string().max(4096).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  canvas: z.object({
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000),
    background: templateHexSchema.optional(),
  }),
  slots: z
    .record(z.string().min(1).max(64), slotSchema)
    .refine((slots) => Object.keys(slots).length <= 64, {
      message: "a manifest declares at most 64 slots (§7.5: keep it under ~12)",
    })
    .optional(),
  rules: z
    .object({
      safeArea: z.number().optional(),
      minContrast: z.number().optional(),
      mustLayers: z.array(z.string().min(1).max(256)).max(32).optional(),
      maxTextLayers: z.number().int().min(1).optional(),
      palette: z.array(templateHexSchema).max(32).optional(),
    })
    .optional(),
  layerMap: z
    .record(
      z.string().min(1).max(256),
      z.object({
        role: z.string().min(1).max(64),
        fill: templateHexSchema.optional(),
        mask: z.string().min(1).max(64).optional(),
        maskRadius: z.number().optional(),
        component: componentRefSchema.optional(),
      }),
    )
    .refine((map) => Object.keys(map).length <= 128, {
      message: "layerMap lists at most 128 layers",
    })
    .optional(),
  thumbnail: z.string().min(1).max(512).optional(),
  license: licenseSchema.optional(),
  author: z.string().max(128).optional(),
});

export type TemplateManifest = z.infer<typeof TEMPLATE_MANIFEST_SCHEMA>;

// ---------------------------------------------------------------------------
// §8.2 component manifest schema
// ---------------------------------------------------------------------------

/** §8.2 variable specs: `kind` selects the default's type (strict engine rule). */
const componentVariableSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    default: z.string(),
    maxChars: z.number().int().min(1).max(4096).optional(),
  }),
  z.object({
    kind: z.literal("color"),
    default: componentHexSchema,
  }),
  z.object({
    kind: z.literal("visibility"),
    default: z.boolean(),
  }),
]);

/** §8.2 component manifest (license is REQUIRED — evals/components/README.md). */
export const COMPONENT_MANIFEST_SCHEMA = z.object({
  id: CATALOG_ID_SCHEMA,
  version: VERSION_SCHEMA,
  name: z.string().min(1).max(128),
  author: z.string().max(128).optional(),
  description: z.string().max(4096).optional(),
  tags: z.array(z.string().min(1).max(32)).max(32).optional(),
  defaultSize: z
    .object({
      width: z.number().int().min(1).max(8192),
      height: z.number().int().min(1).max(8192),
    })
    .refine((s) => s.width * s.height <= 64_000_000, {
      message: "defaultSize is at most 64 MP (the automation ceiling)",
    }),
  variables: z
    .record(z.string().min(1).max(64), componentVariableSchema)
    .refine((vars) => Object.keys(vars).length <= 64, {
      message: "a component declares at most 64 variables",
    })
    .optional(),
  anchors: z
    .record(z.string().min(1).max(32), z.tuple([z.number(), z.number()]))
    .refine((anchors) => Object.keys(anchors).length <= 16, {
      message: "a component lists at most 16 anchors",
    })
    .optional(),
  comps: z
    .array(z.string().min(1).max(128))
    .max(32)
    .refine((comps) => new Set(comps).size === comps.length, {
      message: "comp names are unique",
    })
    .optional(),
  license: licenseSchema,
});

export type ComponentManifest = z.infer<typeof COMPONENT_MANIFEST_SCHEMA>;

/**
 * POST /v1/workspaces/:id/templates body — a full §7.2 manifest. STRICT on
 * purpose (unlike the load schema above): registration is a WRITE of a
 * manifest the engine's serde must also accept (`deny_unknown_fields`), so
 * an extra field is a 422, never silently stripped from the stored jsonb.
 */
export const REGISTER_TEMPLATE_BODY_SCHEMA = TEMPLATE_MANIFEST_SCHEMA.strict();
export type RegisterTemplateBody = TemplateManifest;

// ---------------------------------------------------------------------------
// Catalog results — lookup misses use gateway-local stable codes (§13.3)
// ---------------------------------------------------------------------------

/**
 * `unknown_template` / `unknown_component` (W4-J task contract; §13.3-style
 * stable strings). They are not in the @studio/config catalog, which is
 * add-only and owned by the config wave — flagged in the worklog for that
 * wave to adopt. HTTP status is 404 (§13.3 not-found).
 */
export type CatalogFailureCode = "unknown_template" | "unknown_component";

export interface CatalogFailure {
  readonly ok: false;
  readonly code: CatalogFailureCode;
  readonly message: string;
  readonly hint: string | undefined;
  readonly retryable: false;
}

export type CatalogResult<T> = { readonly ok: true; readonly value: T } | CatalogFailure;

export function catalogOk<T>(value: T): CatalogResult<T> {
  return { ok: true, value };
}

/** A lookup miss with the known `id@version` pins in the hint (task contract). */
export function catalogErr(
  code: CatalogFailureCode,
  message: string,
  hint: string,
): CatalogResult<never> {
  return { ok: false, code, message, hint, retryable: false };
}

// ---------------------------------------------------------------------------
// Pure list semantics — mirror the engine (template_cmds.rs / component_cmds.rs)
// ---------------------------------------------------------------------------

/**
 * A manifest matches a `tags` filter when it carries EVERY wanted tag,
 * case-insensitively (engine: `tags.iter().all(|tag| own.eq_ignore_ascii_case(tag))`).
 */
export function tagsMatchAll(own: readonly string[], wanted: readonly string[]): boolean {
  const have = new Set(own.map((tag) => tag.toLowerCase()));
  return wanted.every((tag) => have.has(tag.trim().toLowerCase()));
}

/**
 * `query` is a case-insensitive substring over the given fields. Templates
 * search id + name + description; components search id + name (the engine's
 * exact field lists).
 */
export function queryMatches(query: string | undefined, fields: readonly string[]): boolean {
  if (query === undefined) {
    return true;
  }
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true; // a blank query lists everything (engine rejects earlier; defense here)
  }
  return fields.some((field) => field.toLowerCase().includes(needle));
}

/** `id@version` (§7.2) — the pin every reply and log line names. */
export function catalogPin(id: string, version: number): string {
  return `${id}@${version}`;
}

/** Hint text listing known pins, `SHOWN_PINS` at a time (engine `pins()`). */
export function formatPins(pins: readonly string[]): string {
  if (pins.length === 0) {
    return "the catalog is empty";
  }
  const shown = pins.slice(0, SHOWN_PINS).join(", ");
  return pins.length > SHOWN_PINS ? `${shown}, …` : shown;
}

// ---------------------------------------------------------------------------
// Catalog entries — the validated, immutable cache units
// ---------------------------------------------------------------------------

export interface TemplateCatalogEntry {
  readonly id: string;
  readonly version: number;
  readonly pin: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly tags: readonly string[];
  readonly license: TemplateLicense;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly slotNames: readonly string[];
  /** The raw manifest document, exactly as shipped (full-fidelity inspect). */
  readonly manifest: TemplateManifest;
}

export interface ComponentCatalogEntry {
  readonly id: string;
  readonly version: number;
  readonly pin: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly license: TemplateLicense;
  readonly defaultSize: { readonly width: number; readonly height: number };
  readonly variableNames: readonly string[];
  readonly comps: readonly string[];
  readonly manifest: ComponentManifest;
}

/** `GET /v1/templates` card — discovery shape, NOT the full manifest (§7.4). */
export interface TemplateCard {
  readonly id: string;
  readonly version: number;
  /** The immutable pin `id@version` (§7.2) — always explicit in replies. */
  readonly ref: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly canvas: { readonly width: number; readonly height: number };
  readonly slots: readonly string[];
}

/** `GET /v1/components` card (§8.2/§8.3 discovery shape). */
export interface ComponentCard {
  readonly id: string;
  readonly version: number;
  readonly ref: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly defaultSize: { readonly width: number; readonly height: number };
  readonly license: TemplateLicense;
  readonly variables: readonly string[];
  readonly comps: readonly string[];
}

/** `list` / `listComponents` filter (§7.4 `template.list { tags?, query? }`). */
export interface CatalogListFilter {
  readonly tags?: readonly string[];
  readonly query?: string;
}

// ---------------------------------------------------------------------------
// Boot-time catalog loading
// ---------------------------------------------------------------------------

/** Thrown at boot when the catalog cannot serve anything (fail fast). */
export class CatalogBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogBootError";
  }
}

export interface CatalogLoadOptions {
  /** Explicit catalog dir (wins over the env override — tests use this). */
  readonly dir?: string;
  /** Env source for `STUDIO_CATALOG_DIR`; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Root logger for skip/boot warnings (§22); silent when omitted. */
  readonly logger?: Logger;
}

/** `STUDIO_CATALOG_DIR` — a non-empty path override (strict: "" refuses boot). */
export const CATALOG_DIR_ENV_SCHEMA = z.string().trim().min(1).max(1024).optional();

/** The directory holding `templates/` and `components/` (repo `<root>/evals`). */
function defaultCatalogDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return join(dir, "evals");
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new CatalogBootError(
    "cannot resolve the repo root to locate the seed catalog (evals/) — " +
      "set STUDIO_CATALOG_DIR to the directory containing templates/ and components/",
  );
}

interface ScannedManifest {
  /** The subdirectory name (usually `id@version` — informational only). */
  readonly name: string;
  /** The parsed JSON document (validated later, stored raw). */
  readonly json: unknown;
}

/** Which half of the catalog dir a scan reads (its subdir + manifest file). */
type CatalogKind = {
  readonly subdir: "templates" | "components";
  readonly manifestFile: string;
};

const TEMPLATES_KIND: CatalogKind = { subdir: "templates", manifestFile: "manifest.json" };
const COMPONENTS_KIND: CatalogKind = { subdir: "components", manifestFile: "component.json" };

/** Reads every `<kind>/<dir>/<manifestFile>` under the catalog dir, sorted. */
function scanKindDir(catalogDir: string, kind: CatalogKind): ScannedManifest[] {
  const kindDir = join(catalogDir, kind.subdir);
  let names: string[];
  try {
    names = readdirSync(kindDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return []; // missing kind dir → zero entries; the boot gate handles loudness
  }
  const scanned: ScannedManifest[] = [];
  for (const name of names) {
    if (scanned.length >= MAX_CATALOG_ENTRIES_PER_KIND) {
      break; // engine MAX_TEMPLATES: a hostile directory cannot size the catalog
    }
    const path = join(kindDir, name, kind.manifestFile);
    try {
      if (statSync(path).size > MAX_MANIFEST_BYTES) {
        continue;
      }
      scanned.push({ name, json: JSON.parse(readFileSync(path, "utf8")) as unknown });
    } catch {
      continue; // unreadable/oversized/unparseable — skipped, logged by the caller
    }
  }
  return scanned;
}

/** First Zod issue as a one-line, path-prefixed reason (never a stack). */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "schema validation failed";
  }
  return `${issue.path.join(".")}: ${issue.message}`;
}

function loadTemplateEntries(
  catalogDir: string,
  logger: Logger | undefined,
): TemplateCatalogEntry[] {
  const entries: TemplateCatalogEntry[] = [];
  const seenPins = new Set<string>();
  for (const { name, json } of scanKindDir(catalogDir, TEMPLATES_KIND)) {
    const parsed = TEMPLATE_MANIFEST_SCHEMA.safeParse(json);
    if (!parsed.success) {
      logger?.warn(
        { catalog: "templates", dir: name },
        `skipped invalid template manifest: ${firstIssue(parsed.error)}`,
      );
      continue;
    }
    const manifest = parsed.data;
    const pin = catalogPin(manifest.id, manifest.version);
    if (seenPins.has(pin)) {
      logger?.warn(
        { catalog: "templates", pin },
        "skipped duplicate id@version (versions are immutable — add a new version instead)",
      );
      continue;
    }
    seenPins.add(pin);
    const raw = json as Record<string, unknown>;
    // A §7.2 manifest that does not declare a license is not declared private:
    // the public catalog is the default visibility (engine: license Option).
    if (raw.license === undefined) {
      raw.license = "public";
    }
    entries.push({
      id: manifest.id,
      version: manifest.version,
      pin,
      name: manifest.name,
      description: manifest.description,
      tags: manifest.tags ?? [],
      license: manifest.license ?? "public",
      canvas: { width: manifest.canvas.width, height: manifest.canvas.height },
      slotNames: Object.keys(manifest.slots ?? {}).sort(),
      manifest: raw as unknown as TemplateManifest,
    });
  }
  return entries;
}

function loadComponentEntries(
  catalogDir: string,
  logger: Logger | undefined,
): ComponentCatalogEntry[] {
  const entries: ComponentCatalogEntry[] = [];
  const seenPins = new Set<string>();
  for (const { name, json } of scanKindDir(catalogDir, COMPONENTS_KIND)) {
    const parsed = COMPONENT_MANIFEST_SCHEMA.safeParse(json);
    if (!parsed.success) {
      logger?.warn(
        { catalog: "components", dir: name },
        `skipped invalid component manifest: ${firstIssue(parsed.error)}`,
      );
      continue;
    }
    const manifest = parsed.data;
    const pin = catalogPin(manifest.id, manifest.version);
    if (seenPins.has(pin)) {
      logger?.warn(
        { catalog: "components", pin },
        "skipped duplicate id@version (versions are immutable — add a new version instead)",
      );
      continue;
    }
    seenPins.add(pin);
    const raw = json as Record<string, unknown>;
    // §8.2 makes license required for components; the schema enforces it, the
    // raw document carries it — nothing to normalize here.
    entries.push({
      id: manifest.id,
      version: manifest.version,
      pin,
      name: manifest.name,
      tags: manifest.tags ?? [],
      license: manifest.license,
      defaultSize: { width: manifest.defaultSize.width, height: manifest.defaultSize.height },
      variableNames: Object.keys(manifest.variables ?? {}).sort(),
      comps: manifest.comps ?? [],
      manifest: raw as unknown as ComponentManifest,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// TemplateCatalog — the immutable, id@version-keyed catalog service
// ---------------------------------------------------------------------------

function byIdThenVersion<T extends { readonly id: string; readonly version: number }>(
  entries: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const map = new Map<string, T[]>();
  for (const entry of entries) {
    const list = map.get(entry.id);
    if (list === undefined) {
      map.set(entry.id, [entry]);
      continue;
    }
    list.push(entry);
  }
  for (const list of map.values()) {
    list.sort((left, right) => left.version - right.version);
  }
  return map;
}

function pinsOf(entries: readonly { readonly pin: string }[]): readonly string[] {
  return entries.map((entry) => entry.pin).sort((left, right) => (left < right ? -1 : 1));
}

export class TemplateCatalog {
  readonly #templates: ReadonlyMap<string, readonly TemplateCatalogEntry[]>;
  readonly #components: ReadonlyMap<string, readonly ComponentCatalogEntry[]>;
  readonly #templatePins: readonly string[];
  readonly #componentPins: readonly string[];

  /** Loads + validates the seed catalog. Throws CatalogBootError on an empty load. */
  static load(options: CatalogLoadOptions = {}): TemplateCatalog {
    const env = options.env ?? process.env;
    const envDir = CATALOG_DIR_ENV_SCHEMA.parse(env.STUDIO_CATALOG_DIR);
    const dir = options.dir ?? (envDir !== undefined ? resolve(envDir) : defaultCatalogDir());
    const logger = options.logger;
    const templates = loadTemplateEntries(dir, logger);
    const components = loadComponentEntries(dir, logger);
    if (templates.length === 0 && components.length === 0) {
      throw new CatalogBootError(
        `the catalog at ${dir} loaded zero valid manifests ` +
          `(templates: ${templates.length}, components: ${components.length}) — ` +
          "refusing to start with an empty catalog (set STUDIO_CATALOG_DIR correctly)",
      );
    }
    if (templates.length === 0 || components.length === 0) {
      logger?.warn(
        { catalogDir: dir, templates: templates.length, components: components.length },
        "catalog loaded an empty kind (templates or components) — check the catalog dir",
      );
    }
    return new TemplateCatalog(templates, components);
  }

  private constructor(
    templates: readonly TemplateCatalogEntry[],
    components: readonly ComponentCatalogEntry[],
  ) {
    this.#templates = byIdThenVersion(templates);
    this.#components = byIdThenVersion(components);
    this.#templatePins = pinsOf(templates);
    this.#componentPins = pinsOf(components);
  }

  /** All known template pins, sorted (hints + tests). */
  templatePins(): readonly string[] {
    return this.#templatePins;
  }

  /** All known component pins, sorted (hints + tests). */
  componentPins(): readonly string[] {
    return this.#componentPins;
  }

  /** Loaded template count (all versions of all ids). */
  get templateCount(): number {
    return this.#templatePins.length;
  }

  /** Loaded component count (all versions of all ids). */
  get componentCount(): number {
    return this.#componentPins.length;
  }

  // --- templates (§7.4 list/inspect semantics) -----------------------------

  /** `template.list { tags?, query? }` — every pin, filtered, cards only. */
  list(filter: CatalogListFilter = {}): readonly TemplateCard[] {
    const entries: TemplateCatalogEntry[] = [];
    for (const id of [...this.#templates.keys()].sort()) {
      entries.push(...(this.#templates.get(id) ?? []));
    }
    return entries
      .filter((entry) => tagsMatchAll(entry.tags, filter.tags ?? []))
      .filter((entry) =>
        queryMatches(filter.query, [entry.id, entry.name, entry.description ?? ""]),
      )
      .map((entry) => ({
        id: entry.id,
        version: entry.version,
        ref: entry.pin,
        name: entry.name,
        tags: [...entry.tags],
        canvas: { width: entry.canvas.width, height: entry.canvas.height },
        slots: [...entry.slotNames],
      }));
  }

  /** `template.inspect { id, version? }` — the full manifest (newest default). */
  inspect(id: string, version?: number): CatalogResult<TemplateManifest> {
    const versions = this.#templates.get(id);
    if (versions === undefined || versions.length === 0) {
      return catalogErr(
        "unknown_template",
        `No template '${id}' in the catalog.`,
        `Known templates: ${formatPins(this.#templatePins)}`,
      );
    }
    const entry =
      version === undefined
        ? versions[versions.length - 1]
        : versions.find((candidate) => candidate.version === version);
    if (entry === undefined) {
      const known = versions.map((candidate) => String(candidate.version)).join(", ");
      return catalogErr(
        "unknown_template",
        `Template '${id}' has no version ${String(version)}.`,
        `Versions of ${id}: ${known}; known templates: ${formatPins(this.#templatePins)}`,
      );
    }
    return catalogOk(entry.manifest);
  }

  // --- components (§8.3 list/inspect semantics) ----------------------------

  /** `component.list { tags?, query? }` — id/name substring, tags AND. */
  listComponents(filter: CatalogListFilter = {}): readonly ComponentCard[] {
    const entries: ComponentCatalogEntry[] = [];
    for (const id of [...this.#components.keys()].sort()) {
      entries.push(...(this.#components.get(id) ?? []));
    }
    return entries
      .filter((entry) => tagsMatchAll(entry.tags, filter.tags ?? []))
      .filter((entry) => queryMatches(filter.query, [entry.id, entry.name]))
      .map((entry) => ({
        id: entry.id,
        version: entry.version,
        ref: entry.pin,
        name: entry.name,
        tags: [...entry.tags],
        defaultSize: { width: entry.defaultSize.width, height: entry.defaultSize.height },
        license: entry.license,
        variables: [...entry.variableNames],
        comps: [...entry.comps],
      }));
  }

  /** `component.inspect { id, version? }` — the full manifest (newest default). */
  inspectComponent(id: string, version?: number): CatalogResult<ComponentManifest> {
    const versions = this.#components.get(id);
    if (versions === undefined || versions.length === 0) {
      return catalogErr(
        "unknown_component",
        `No component '${id}' in the catalog.`,
        `Known components: ${formatPins(this.#componentPins)}`,
      );
    }
    const entry =
      version === undefined
        ? versions[versions.length - 1]
        : versions.find((candidate) => candidate.version === version);
    if (entry === undefined) {
      const known = versions.map((candidate) => String(candidate.version)).join(", ");
      return catalogErr(
        "unknown_component",
        `Component '${id}' has no version ${String(version)}.`,
        `Versions of ${id}: ${known}; known components: ${formatPins(this.#componentPins)}`,
      );
    }
    return catalogOk(entry.manifest);
  }
}

// ---------------------------------------------------------------------------
// Caller + auth seam (mirrors services/runs.ts AuthLike — W4-G mount contract)
// ---------------------------------------------------------------------------

/** The authenticated caller (§15.1: organizationId is the tenant anchor). */
export interface CatalogCaller {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
}

/** Resolves the caller from the raw request; typed failures (401/403). */
export interface CatalogAuthLike {
  authenticate(request: Request): Promise<Result<CatalogCaller>>;
}

// ---------------------------------------------------------------------------
// Workspace registration — the DbLike seam over workspace_templates (§12.1)
// ---------------------------------------------------------------------------

/**
 * Narrow structural seam over the Drizzle client (event-store.ts precedent):
 * exactly the query builders the registration needs. A real `Db` from
 * @studio/db's createDb satisfies it structurally; tests fake the store.
 */
export type DbLike = Pick<NodePgDatabase, "insert" | "select">;

/** The workspace_templates persistence seam (composite org-scoped, §12.2). */
export interface WorkspaceTemplatesStore {
  /** Newest row for (organizationId, template id, version) — natural key. */
  findWorkspaceTemplate(
    organizationId: string,
    templateId: string,
    version: number,
  ): Promise<WorkspaceTemplate | null>;
  /** Insert with on-conflict-do-nothing semantics on the deterministic id. */
  insertWorkspaceTemplate(row: {
    readonly id: string;
    readonly organizationId: string;
    readonly source: TemplateSource;
    readonly manifest: Record<string, unknown>;
    readonly version: number;
  }): Promise<WorkspaceTemplate>;
}

/**
 * Deterministic row id for a registration's natural key: the same
 * (organization, template id, version) retried under any Idempotency-Key maps
 * to the same primary key, so the insert dedupes without a schema change.
 */
export function workspaceTemplateId(
  organizationId: string,
  templateId: string,
  version: number,
): string {
  const digest = createHash("sha256")
    .update(`workspace-template:${organizationId}:${templateId}:${version}`)
    .digest("hex");
  // uuid-shaped (8-4-4-4-12) so audit/log joins keep working (W4-E note)
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

/** Drizzle adapter over `workspace_templates` (production wiring). */
export function drizzleWorkspaceTemplatesStore(db: DbLike): WorkspaceTemplatesStore {
  return {
    async findWorkspaceTemplate(organizationId, templateId, version) {
      const rows = await db
        .select()
        .from(workspaceTemplates)
        .where(
          and(
            eq(workspaceTemplates.organizationId, organizationId),
            sql`${workspaceTemplates.manifest}->>'id' = ${templateId}`,
            eq(workspaceTemplates.version, version),
          ),
        )
        .orderBy(desc(workspaceTemplates.createdAt))
        .limit(1);
      const row = rows[0];
      return row ?? null;
    },
    async insertWorkspaceTemplate(row) {
      const inserted = await db
        .insert(workspaceTemplates)
        .values({
          id: row.id,
          organizationId: row.organizationId,
          source: row.source,
          manifest: row.manifest,
          version: row.version,
        })
        // Same natural key retried → the deterministic PK conflicts: the
        // insert is a no-op and the caller reads the existing row.
        .onConflictDoNothing()
        .returning();
      const winner = inserted[0];
      if (winner !== undefined) {
        return winner;
      }
      const existing = await db
        .select()
        .from(workspaceTemplates)
        .where(eq(workspaceTemplates.id, row.id))
        .limit(1);
      const conflicted = existing[0];
      if (conflicted === undefined) {
        throw new Error("workspace template insert conflicted, but the row is missing");
      }
      return conflicuted;
    },
  };
}

// ---------------------------------------------------------------------------
// Registration service (POST /v1/workspaces/:id/templates)
// ---------------------------------------------------------------------------

/** Routes-injected deps (the runs.ts mount contract: one deps object). */
export interface CatalogDeps {
  readonly auth: CatalogAuthLike;
  readonly catalog: TemplateCatalog;
  readonly store: WorkspaceTemplatesStore;
  /** Optional: per-org rate limiting (W4-D RateLimiter; omitted = unlimited). */
  readonly limiter?: RateLimiter;
  /** Root/child logger for the §22 storage-failure line on registration. */
  readonly logger?: Logger;
}

export interface RegisterTemplateInput {
  readonly caller: CatalogCaller;
  readonly workspaceId: string;
  /** The validated body manifest (strict schema — extras were a 422, not kept). */
  readonly manifest: TemplateManifest;
}

export interface RegisteredTemplate {
  readonly row: WorkspaceTemplate;
  /** True when the natural key already had a row (replay / retry). */
  readonly duplicate: boolean;
}

/**
 * Registers a workspace-private template row (§7.2 `license: workspace|public`).
 *
 * Guards in order: tenant (§15.1 — the path's workspace must be the caller's
 * own organization; cross-tenant is a typed 403, the W4-C assertTenant seam)
 * then role. ADMIN+ is the W4-J task pin — NOTE the ADR-0003 drift: the ADR
 * groups "register templates" under `assets:upload` (editor+); this route is
 * stricter because a registered template becomes an org-wide creation surface.
 * Flagged in the worklog for the contract wave to settle.
 *
 * The row's `source` mirrors the manifest's `license` (§12.1 TemplateSource);
 * an undeclared license defaults to `workspace` — a workspace registration
 * that does not declare visibility is private to that workspace.
 */
export async function registerWorkspaceTemplate(
  deps: CatalogDeps,
  input: RegisterTemplateInput,
): Promise<Result<RegisteredTemplate>> {
  if (input.caller.organizationId !== input.workspaceId) {
    return err(
      "cross_tenant_denied",
      "The workspace id does not match your organization.",
      { hint: "Register templates into your own workspace (§15.1).", retryable: false },
    );
  }
  const rank = ROLE_RANK[input.caller.role] ?? -1;
  if (rank < ROLE_RANK.admin) {
    return err("forbidden", "Your workspace role does not allow registering templates.", {
      hint: "Admins and owners register workspace templates (§15.2).",
      retryable: false,
    });
  }
  const license: TemplateLicense = input.manifest.license ?? "workspace";
  const manifest: Record<string, unknown> = { ...input.manifest, license };
  try {
    const existing = await deps.store.findWorkspaceTemplate(
      input.workspaceId,
      input.manifest.id,
      input.manifest.version,
    );
    if (existing !== null) {
      return ok({ row: existing, duplicate: true });
    }
    const row = await deps.store.insertWorkspaceTemplate({
      id: workspaceTemplateId(input.workspaceId, input.manifest.id, input.manifest.version),
      organizationId: input.workspaceId,
      source: license,
      manifest,
      version: input.manifest.version,
    });
    return ok({ row, duplicate: false });
  } catch (error) {
    // Storage failures are retryable typed envelopes; the row write is the
    // only side effect and the deterministic id makes retries safe. §22:
    // the real error goes to logs, the envelope stays generic.
    deps.logger?.error(
      { err: error, workspaceId: input.workspaceId, templateId: input.manifest.id },
      "workspace template registration failed",
    );
    return err("storage_error", "The template registration could not be persisted.", {
      hint: "Retry with the same idempotency key; the registration is safe to repeat.",
      retryable: true,
    });
  }
}
