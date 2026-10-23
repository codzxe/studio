import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { assets, projects } from "../schema.js";
import { requireNonEmpty, requireNonNegativeInt } from "./shared.js";
export function createAssetsRepo(db) {
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
                if (rows.length === 0)
                    throw DbError.notFound("project");
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
            if (!asset)
                throw DbError.conflict("Could not create asset");
            return asset;
        },
        async list(workspaceId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select()
                .from(assets)
                .where(and(eq(assets.workspaceId, workspaceId), options?.projectId === undefined
                ? undefined
                : options.projectId === null
                    ? isNull(assets.projectId)
                    : or(eq(assets.projectId, options.projectId), 
                    // library assets are usable by every project
                    isNull(assets.projectId)), cursor
                ? or(lt(assets.createdAt, new Date(cursor.t)), and(eq(assets.createdAt, new Date(cursor.t)), lt(assets.id, cursor.id)))
                : undefined))
                .orderBy(desc(assets.createdAt), desc(assets.id))
                .limit(limit + 1);
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async get(workspaceId, assetId) {
            const [asset] = await db
                .select()
                .from(assets)
                .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)))
                .limit(1);
            if (!asset)
                throw DbError.notFound("asset");
            return asset;
        },
        async bySha256(workspaceId, sha256) {
            const [asset] = await db
                .select()
                .from(assets)
                .where(and(eq(assets.workspaceId, workspaceId), eq(assets.sha256, sha256)))
                .orderBy(desc(assets.createdAt))
                .limit(1);
            return asset ?? null;
        },
        async quota(workspaceId) {
            const [row] = await db
                .select({
                count: sql `count(*)`,
                totalBytes: sql `coalesce(sum(${assets.sizeBytes}), 0)`,
            })
                .from(assets)
                .where(eq(assets.workspaceId, workspaceId));
            return {
                count: Number(row?.count ?? 0),
                totalBytes: Number(row?.totalBytes ?? 0),
            };
        },
    };
}
//# sourceMappingURL=assets.js.map