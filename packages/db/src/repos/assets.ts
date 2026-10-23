import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { Asset } from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty, requireNonNegativeInt } from "./shared.js";

/** Assets repository — workspace library + optional project scope (§9.1, §9.2). */
export interface AssetCreateInput {
  readonly projectId?: string | null;
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationTicks?: number | null;
  readonly createdBy: string;
}

export interface AssetListOptions {
  readonly projectId?: string | null;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface AssetQuota {
  readonly count: number;
  readonly totalBytes: number;
}

export interface AssetsRepo {
  create(workspaceId: WorkspaceId, input: AssetCreateInput): Promise<Asset>;
  list(workspaceId: WorkspaceId, options?: AssetListOptions): Promise<Page<Asset>>;
  get(workspaceId: WorkspaceId, assetId: string): Promise<Asset>;
  /**
   * Dedupe lookup by content hash (§9.2 content-addressed). W1-c: the
   * optional `excludeAssetId` lets the verify step find an OTHER row with
   * the same bytes (the descriptor under completion is excluded so a
   * self-hit never dedupes against itself).
   */
  bySha256(
    workspaceId: WorkspaceId,
    sha256: string,
    excludeAssetId?: string,
  ): Promise<Asset | null>;
  quota(workspaceId: WorkspaceId): Promise<AssetQuota>;
  /**
   * W1-c: record the server-side probe result from the verify step —
   * header-parsed image dimensions (width/height; null leaves the column
   * untouched). Tenant-scoped; unknown ids read as NOT_FOUND (§12.1).
   */
  recordProbe(
    workspaceId: WorkspaceId,
    assetId: string,
    probe: { width: number | null; height: number | null },
  ): Promise<Asset>;
  /**
   * W1-c: delete an asset ROW (verify-step rejection cleanup — the wrong-typed
   * upload must not linger as a usable row). Bytes live in object storage and
   * are reclaimed by the §9.2 lifecycle policy. Tenant-scoped (§12.1).
   */
  remove(workspaceId: WorkspaceId, assetId: string): Promise<void>;
}

export function createAssetsRepo(db: StudioDb): AssetsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { assets, projects } = tablesFor(db);
  return {
    async create(workspaceId, input) {
      const name = requireNonEmpty(input.name, "name");
      const mime = requireNonEmpty(input.mime, "mime");
      requireNonEmpty(input.sha256, "sha256");
      requireNonEmpty(input.objectKey, "objectKey");
      requireNonEmpty(input.createdBy, "createdBy");
      requireNonNegativeInt(input.sizeBytes, "sizeBytes");

      if (input.projectId) {
        const rows = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
          .limit(1);
        if (rows.length === 0) throw DbError.notFound("project");
      }

      const [asset] = await db
        .insert(assets)
        .values({
          id: createId("ast"),
          workspaceId,
          projectId: input.projectId ?? null,
          name,
          mime,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          objectKey: input.objectKey,
          width: input.width ?? null,
          height: input.height ?? null,
          durationTicks: input.durationTicks ?? null,
          createdBy: input.createdBy,
        })
        .returning();
      if (!asset) throw DbError.conflict("Could not create asset");
      return asset;
    },

    async list(workspaceId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.workspaceId, workspaceId),
            options?.projectId === undefined
              ? undefined
              : options.projectId === null
                ? isNull(assets.projectId)
                : or(
                    eq(assets.projectId, options.projectId),
                    // library assets are usable by every project
                    isNull(assets.projectId),
                  ),
            cursor
              ? or(
                  lt(assets.createdAt, new Date(cursor.t)),
                  and(eq(assets.createdAt, new Date(cursor.t)), lt(assets.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(assets.createdAt), desc(assets.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async get(workspaceId, assetId) {
      const [asset] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)))
        .limit(1);
      if (!asset) throw DbError.notFound("asset");
      return asset;
    },

    async bySha256(workspaceId, sha256, excludeAssetId) {
      const [asset] = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.workspaceId, workspaceId),
            eq(assets.sha256, sha256),
            excludeAssetId === undefined ? undefined : sql`${assets.id} <> ${excludeAssetId}`,
          ),
        )
        .orderBy(desc(assets.createdAt))
        .limit(1);
      return asset ?? null;
    },

    async quota(workspaceId) {
      const [row] = await db
        .select({
          count: sql<string>`count(*)`,
          totalBytes: sql<string>`coalesce(sum(${assets.sizeBytes}), 0)`,
        })
        .from(assets)
        .where(eq(assets.workspaceId, workspaceId));
      return {
        count: Number(row?.count ?? 0),
        totalBytes: Number(row?.totalBytes ?? 0),
      };
    },

    async recordProbe(workspaceId, assetId, probe) {
      const values: Partial<typeof assets.$inferInsert> = {};
      if (probe.width !== null) values.width = probe.width;
      if (probe.height !== null) values.height = probe.height;
      if (Object.keys(values).length === 0) {
        return this.get(workspaceId, assetId);
      }
      const [asset] = await db
        .update(assets)
        .set(values)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)))
        .returning();
      if (!asset) throw DbError.notFound("asset");
      return asset;
    },

    async remove(workspaceId, assetId) {
      // Idempotent by design: removing an already-removed asset is a no-op
      // (a second complete on a removed id 404s at the get() above).
      await db
        .delete(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
    },
  };
}
