import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { assets, projectVersions, projects, } from "../schema.js";
import { ensureUniqueSlug, slugify } from "../slug.js";
import { isUniqueViolation } from "./shared.js";
/** Lock a project row in a transaction (single-writer / version-advance path). */
export async function lockProject(tx, workspaceId, projectId) {
    const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .for("update");
    if (!project)
        throw DbError.notFound("project");
    return project;
}
export function createProjectsRepo(db) {
    return {
        async create(workspaceId, input) {
            const name = input.name.trim();
            if (!name)
                throw DbError.validation("Project name is required");
            const createdBy = input.createdBy.trim();
            if (!createdBy)
                throw DbError.validation("createdBy is required");
            const slugBase = slugify(input.slug !== undefined && input.slug !== "" ? input.slug : name);
            const takenRows = await db
                .select({ slug: projects.slug })
                .from(projects)
                .where(eq(projects.workspaceId, workspaceId));
            const taken = new Set(takenRows.map((row) => row.slug));
            const slug = ensureUniqueSlug(slugBase, taken);
            try {
                const [project] = await db
                    .insert(projects)
                    .values({
                    id: createId("prj"),
                    workspaceId,
                    name,
                    slug,
                    description: input.description,
                    thumbnailUrl: input.thumbnailUrl,
                    createdBy,
                    currentVersionId: null,
                })
                    .returning();
                if (!project)
                    throw DbError.conflict("Could not create project");
                return project;
            }
            catch (error) {
                if (isUniqueViolation(error)) {
                    throw DbError.conflict("Project slug already taken in this workspace", "Try another name.");
                }
                throw error;
            }
        },
        async list(workspaceId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select()
                .from(projects)
                .where(and(eq(projects.workspaceId, workspaceId), options?.includeDeleted ? undefined : isNull(projects.deletedAt), cursor
                ? or(lt(projects.updatedAt, new Date(cursor.t)), and(eq(projects.updatedAt, new Date(cursor.t)), lt(projects.id, cursor.id)))
                : undefined))
                .orderBy(desc(projects.updatedAt), desc(projects.id))
                .limit(limit + 1);
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }) : null,
            };
        },
        async get(workspaceId, projectId, options) {
            const [project] = await db
                .select()
                .from(projects)
                .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), options?.includeDeleted ? undefined : isNull(projects.deletedAt)))
                .limit(1);
            if (!project)
                throw DbError.notFound("project");
            return project;
        },
        async patch(workspaceId, projectId, input) {
            const values = { updatedAt: new Date() };
            if (input.name !== undefined) {
                const name = input.name.trim();
                if (!name)
                    throw DbError.validation("Project name cannot be empty");
                values.name = name;
            }
            if (input.description !== undefined)
                values.description = input.description;
            if (input.thumbnailUrl !== undefined)
                values.thumbnailUrl = input.thumbnailUrl;
            const [project] = await db
                .update(projects)
                .set(values)
                .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
                .returning();
            if (!project)
                throw DbError.notFound("project");
            return project;
        },
        async softDelete(workspaceId, projectId) {
            const now = new Date();
            const [project] = await db
                .update(projects)
                .set({ deletedAt: now, updatedAt: now })
                .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
                .returning();
            if (!project)
                throw DbError.notFound("project");
            return project;
        },
        async manifest(workspaceId, projectId) {
            const project = await this.get(workspaceId, projectId);
            const currentVersion = project.currentVersionId
                ? ((await db
                    .select()
                    .from(projectVersions)
                    .where(eq(projectVersions.id, project.currentVersionId))
                    .limit(1)).at(0) ?? null)
                : null;
            // Project-scoped assets + the workspace library (projectId IS NULL).
            const rows = await db
                .select()
                .from(assets)
                .where(and(eq(assets.workspaceId, workspaceId), or(eq(assets.projectId, projectId), isNull(assets.projectId))))
                .orderBy(desc(assets.createdAt));
            return {
                project,
                currentVersion,
                assets: rows.map((asset) => ({
                    id: asset.id,
                    projectId: asset.projectId,
                    name: asset.name,
                    mime: asset.mime,
                    sizeBytes: asset.sizeBytes,
                    sha256: asset.sha256,
                    objectKey: asset.objectKey,
                    width: asset.width,
                    height: asset.height,
                    durationTicks: asset.durationTicks,
                })),
            };
        },
    };
}
//# sourceMappingURL=projects.js.map