// @studio/worker — per-job hydration (docs/phases/m8-cli-spike.md §4, THE recipe).
//
// For one render job, inside a confined temp dir under
// `<repo>/.local/render-jobs/<renderId>-XXXXXX` (fs.mkdtemp, gitignored):
//   1. write the pinned version's `.ecproj` bytes → `<workdir>/project.ecproj`;
//   2. write EVERY project asset under its `sanitizeAssetName` — EXACTLY the
//      name the browser editor assigned at import (the `.ecproj` references
//      that name);
//   3. rewrite the working copy's footage paths: single-segment browser
//      virtual paths (`/name` — the web path_for keeps only the last path
//      segment) get their leading slash stripped so `resolve_footage` (#652)
//      finds the file NEXT TO the project. Deep paths (`/a/b.png`) were never
//      producible by the browser surface — left untouched, the job fails
//      honestly. NEVER `--save` (opening+saving rewrites stored paths to
//      absolute ones; the stored version bytes stay untouchable anyway).
//
// Missing assets fail the job with typed RENDER_ASSET_MISSING BEFORE the CLI
// spawns — the CLI renders missing footage as a placeholder frame and still
// exits 0 (spike §4), so CLI success alone proves nothing; this pre-validation
// is the guarantee that a completed render actually used real footage.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Asset, Page, Repos } from "@studio/db";
import { sanitizeAssetName } from "@studio/editor-bridge";

import type { StorageChoice } from "@studio/gateway/storage";
import { RenderJobError } from "./errors.js";
import { readObjectBytes } from "./storage.js";

/** One second in `.ecproj` ticks (editor `crates/time`: 254 016 000 000/s). */
const TICKS_PER_SECOND = 254_016_000_000;

/** Pagination bound: 50 pages × repo MAX_PAGE_SIZE(100) = 5 000 assets. */
const MAX_ASSET_PAGES = 50;

/** The repo scratch root for render job dirs (gitignored, see .gitignore). */
export function scratchRoot(repoRoot: string): string {
  return join(repoRoot, ".local", "render-jobs");
}

// ───────────────────────────────────────────────────────────────────────────
// Pure .ecproj parsing helpers (unit-tested)
// ───────────────────────────────────────────────────────────────────────────

/** The native facts of the composition being rendered. */
export interface CompFacts {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
}

/**
 * Parse `.ecproj` bytes as JSON. Throws a typed `RENDER_PROJECT_INVALID`
 * RenderJobError for non-JSON bytes (the raw parse message stays log-only).
 */
export function parseProjectJson(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RenderJobError("RENDER_PROJECT_INVALID", {
      raw: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Find the render target comp by id or name (the CLI accepts both; this
 * mirrors that lookup). Returns null when the comp does not exist — the job
 * fails fast with RENDER_PROJECT_INVALID instead of spawning a doomed CLI.
 */
export function parseCompFacts(project: unknown, compId: string): CompFacts | null {
  if (typeof project !== "object" || project === null) return null;
  const items = (project as { items?: unknown }).items;
  if (typeof items !== "object" || items === null) return null;

  const needle = compId.trim();
  if (needle === "") return null;
  for (const item of Object.values(items)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const kind =
      typeof record.kind === "object" && record.kind !== null
        ? (record.kind as Record<string, unknown>)
        : null;
    if (kind === null || kind.type !== "Comp") continue;
    const idMatches = String(record.id ?? "") === needle;
    const nameMatches = typeof record.name === "string" && record.name === needle;
    if (!idMatches && !nameMatches) continue;

    const width = numberOr(kind.width);
    const height = numberOr(kind.height);
    if (width === null || width <= 0 || height === null || height <= 0) return null;
    const rate = frameRateOr(kind.frame_rate);
    const durationTicks = numberOr(kind.duration);
    if (rate === null || durationTicks === null || durationTicks <= 0) return null;
    return {
      width: Math.round(width),
      height: Math.round(height),
      frameRate: rate,
      durationSeconds: durationTicks / TICKS_PER_SECOND,
    };
  }
  return null;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function frameRateOr(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const rate = value as Record<string, unknown>;
  const num = numberOr(rate.num);
  const den = numberOr(rate.den);
  if (num === null || den === null || num <= 0 || den <= 0) return null;
  return num / den;
}

/**
 * `"/photo.png"` → `"photo.png"`; anything else (relative, deep, empty)
 * returns null = leave untouched. Browser virtual footage paths are
 * single-segment by construction (spike §4).
 */
export function stripLeadingSlashPath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const rest = path.slice(1);
  if (rest.includes("/")) return null; // deep path — never browser-producible
  return rest.length > 0 ? rest : null;
}

export interface FootageRewrite {
  readonly project: unknown;
  /** Number of paths rewritten (item paths + sequence entries). */
  readonly rewritten: number;
}

/**
 * Rewrite the working copy's footage paths (spike §4 step 3): every Footage
 * item `path` and every `sequence[]` entry matching `^/[^/]+$` loses its
 * leading slash. Returns the SAME parsed object when nothing matches (zero
 * rewrites) so callers can skip a needless re-serialize.
 */
export function rewriteFootagePaths(project: unknown): FootageRewrite {
  if (typeof project !== "object" || project === null) {
    throw new RenderJobError("RENDER_PROJECT_INVALID");
  }
  const items = (project as { items?: unknown }).items;
  if (typeof items !== "object" || items === null) {
    throw new RenderJobError("RENDER_PROJECT_INVALID");
  }

  let rewritten = 0;
  for (const item of Object.values(items)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const kind =
      typeof record.kind === "object" && record.kind !== null
        ? (record.kind as Record<string, unknown>)
        : null;
    if (kind === null || kind.type !== "Footage") continue;

    if (typeof kind.path === "string") {
      const stripped = stripLeadingSlashPath(kind.path);
      if (stripped !== null) {
        kind.path = stripped;
        rewritten += 1;
      }
    }
    if (Array.isArray(kind.sequence)) {
      kind.sequence = kind.sequence.map((entry) => {
        if (typeof entry === "string") {
          const stripped = stripLeadingSlashPath(entry);
          if (stripped !== null) {
            rewritten += 1;
            return stripped;
          }
        }
        return entry;
      });
    }
  }

  return { project, rewritten };
}

// ───────────────────────────────────────────────────────────────────────────
// The hydration job
// ───────────────────────────────────────────────────────────────────────────

export interface HydrateArgs {
  readonly storage: StorageChoice;
  readonly assets: Repos["assets"];
  readonly repoRoot: string;
  readonly workspaceId: string;
  readonly row: { id: string; projectId: string; compId: string };
  /** The pinned version row (fetched + tenant-checked by the pipeline). */
  readonly version: { objectKey: string };
}

export interface HydratedJob {
  readonly workdir: string;
  readonly projectPath: string;
  readonly comp: CompFacts;
  readonly assetCount: number;
}

/**
 * Materialize the render's complete input set into a fresh confined dir.
 * Throws ONLY typed RenderJobError values:
 * - `RENDER_PROJECT_INVALID` — version bytes unreadable, non-JSON, no comp;
 * - `RENDER_ASSET_MISSING`  — any manifest asset's bytes are absent.
 * The CLI is never spawned for these jobs (spike §4: it would render
 * placeholders and exit 0).
 */
export async function hydrateJob(args: HydrateArgs): Promise<HydratedJob> {
  const root = scratchRoot(args.repoRoot);
  await mkdir(root, { recursive: true });
  const workdir = await mkdtemp(join(root, `${args.row.id}-`));

  // 1. The pinned project version (§9.3 — immutable, content-addressed).
  const projectBytes = await readObjectBytes(args.storage, args.version.objectKey);
  if (projectBytes === null) {
    throw new RenderJobError("RENDER_PROJECT_INVALID", { raw: "version object unreadable" });
  }
  const project = parseProjectJson(projectBytes);

  // 2. The render target comp must exist in this version (fail before spawn).
  const comp = parseCompFacts(project, args.row.compId);
  if (comp === null) {
    throw new RenderJobError("RENDER_PROJECT_INVALID", { raw: "comp not found in version" });
  }

  // 3. Browser-path rewrite on the WORKING copy (stored bytes untouched).
  const rewrite = rewriteFootagePaths(project);
  const projectPath = join(workdir, "project.ecproj");
  const projectText =
    rewrite.rewritten > 0 ? JSON.stringify(rewrite.project) : projectBytes.toString("utf8");
  await writeFile(projectPath, projectText, { encoding: "utf8" });

  // 4. Every project asset, under exactly the browser-assigned name.
  let assetCount = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ASSET_PAGES; page += 1) {
    const result: Page<Asset> = await args.assets.list(args.workspaceId, {
      projectId: args.row.projectId,
      limit: 100,
      ...(cursor === null ? {} : { cursor }),
    });
    for (const asset of result.items) {
      const bytes = await readObjectBytes(args.storage, asset.objectKey);
      if (bytes === null) {
        throw new RenderJobError("RENDER_ASSET_MISSING", { raw: "asset bytes absent" });
      }
      // Collisions sanitize to the same name → last write wins (the editor
      // itself cannot import two files with the same name into one project).
      await writeFile(join(workdir, sanitizeAssetName(asset.name)), bytes);
      assetCount += 1;
    }
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  return { workdir, projectPath, comp, assetCount };
}
