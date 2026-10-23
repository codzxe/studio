import { and, desc, eq, lt, or } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { projectVersions, projects, user } from "../schema.js";
import { assertExpectedVersion, buildRestorePlan, nextVersionNumber, } from "../version-logic.js";
import { lockProject } from "./projects.js";
import { requireNonEmpty, requireNonNegativeInt } from "./shared.js";
async function insertVersion(tx, args) {
    const [version] = await tx
        .insert(projectVersions)
        .values({ id: createId("ver"), ...args })
        .returning();
    if (!version)
        throw DbError.conflict("Could not insert version");
    return version;
}
async function advanceCurrentVersion(tx, projectId, versionId) {
    const [project] = await tx
        .update(projects)
        .set({ currentVersionId: versionId, updatedAt: new Date() })
        .where(eq(projects.id, projectId))
        .returning();
    if (!project)
        throw DbError.notFound("project");
    return project;
}
export function createVersionsRepo(db) {
    return {
        async upload(workspaceId, input) {
            requireNonEmpty(input.projectId, "projectId");
            requireNonEmpty(input.objectKey, "objectKey");
            requireNonEmpty(input.sha256, "sha256");
            requireNonNegativeInt(input.sizeBytes, "sizeBytes");
            requireNonEmpty(input.createdBy, "createdBy");
            return db.transaction(async (tx) => {
                const project = await lockProject(tx, workspaceId, input.projectId);
                assertExpectedVersion(project.currentVersionId, input.expectedVersionId);
                let parentVersion = null;
                if (input.expectedVersionId !== null) {
                    const [parent] = await tx
                        .select({ version: projectVersions.version })
                        .from(projectVersions)
                        .where(and(eq(projectVersions.id, input.expectedVersionId), eq(projectVersions.projectId, input.projectId)))
                        .limit(1);
                    if (!parent)
                        throw DbError.notFound("base version");
                    parentVersion = parent.version;
                }
                const version = await insertVersion(tx, {
                    projectId: input.projectId,
                    version: nextVersionNumber(parentVersion),
                    parentVersionId: input.expectedVersionId,
                    objectKey: input.objectKey,
                    sha256: input.sha256,
                    sizeBytes: input.sizeBytes,
                    label: input.label,
                    agentRunId: input.agentRunId,
                    createdBy: input.createdBy,
                });
                const updated = await advanceCurrentVersion(tx, input.projectId, version.id);
                return { version, project: updated };
            });
        },
        async restore(workspaceId, input) {
            return db.transaction(async (tx) => {
                const project = await lockProject(tx, workspaceId, input.projectId);
                const expected = input.expectedVersionId ?? project.currentVersionId;
                assertExpectedVersion(project.currentVersionId, expected);
                let currentVersionNumber = null;
                if (project.currentVersionId) {
                    const [current] = await tx
                        .select({ version: projectVersions.version })
                        .from(projectVersions)
                        .where(and(eq(projectVersions.id, project.currentVersionId), eq(projectVersions.projectId, input.projectId)))
                        .limit(1);
                    if (!current)
                        throw DbError.notFound("current version");
                    currentVersionNumber = current.version;
                }
                const [source] = await tx
                    .select()
                    .from(projectVersions)
                    .where(and(eq(projectVersions.id, input.versionId), eq(projectVersions.projectId, input.projectId)))
                    .limit(1);
                if (!source)
                    throw DbError.notFound("version");
                // §9.3: restoring creates a NEW version with parent = the restored one.
                const plan = buildRestorePlan({
                    currentVersionNumber,
                    source: {
                        id: source.id,
                        version: source.version,
                        objectKey: source.objectKey,
                        sha256: source.sha256,
                        sizeBytes: source.sizeBytes,
                    },
                    label: input.label,
                });
                const version = await insertVersion(tx, {
                    projectId: input.projectId,
                    version: plan.version,
                    parentVersionId: plan.parentVersionId,
                    objectKey: plan.objectKey,
                    sha256: plan.sha256,
                    sizeBytes: plan.sizeBytes,
                    label: plan.label,
                    createdBy: input.createdBy,
                });
                const updated = await advanceCurrentVersion(tx, input.projectId, version.id);
                return { version, project: updated, source };
            });
        },
        async list(workspaceId, projectId, options) {
            // Cross-tenant project ids read as 404 (§12.1).
            const project = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (project.length === 0)
                throw DbError.notFound("project");
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select()
                .from(projectVersions)
                .where(and(eq(projectVersions.projectId, projectId), cursor
                ? or(lt(projectVersions.createdAt, new Date(cursor.t)), and(eq(projectVersions.createdAt, new Date(cursor.t)), lt(projectVersions.id, cursor.id)))
                : undefined))
                .orderBy(desc(projectVersions.createdAt), desc(projectVersions.id))
                .limit(limit + 1);
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async timeline(workspaceId, projectId, options) {
            // Same tenant scope + ordering as `list` (§12.1), plus the author join.
            const project = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (project.length === 0)
                throw DbError.notFound("project");
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select({ version: projectVersions, createdByName: user.name })
                .from(projectVersions)
                .leftJoin(user, eq(user.id, projectVersions.createdBy))
                .where(and(eq(projectVersions.projectId, projectId), cursor
                ? or(lt(projectVersions.createdAt, new Date(cursor.t)), and(eq(projectVersions.createdAt, new Date(cursor.t)), lt(projectVersions.id, cursor.id)))
                : undefined))
                .orderBy(desc(projectVersions.createdAt), desc(projectVersions.id))
                .limit(limit + 1);
            const items = rows
                .slice(0, limit)
                .map((row) => ({ ...row.version, createdByName: row.createdByName }));
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async setLabel(workspaceId, input) {
            const projectId = requireNonEmpty(input.projectId, "projectId");
            const versionId = requireNonEmpty(input.versionId, "versionId");
            const label = requireNonEmpty(input.label, "label");
            if (label.length > 120) {
                throw DbError.validation("label must be at most 120 characters");
            }
            // Tenant scope first (§12.1): cross-tenant project ids read as 404.
            const project = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (project.length === 0)
                throw DbError.notFound("project");
            // Conditional update — the `label` column ONLY (§9.3/D-24 candidate);
            // zero rows means the version id does not belong to this project.
            const [row] = await db
                .update(projectVersions)
                .set({ label })
                .where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, projectId)))
                .returning();
            if (!row)
                throw DbError.notFound("version");
            return row;
        },
        async get(workspaceId, projectId, versionId) {
            const [row] = await db
                .select({ version: projectVersions })
                .from(projectVersions)
                .innerJoin(projects, eq(projectVersions.projectId, projects.id))
                .where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, projectId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (!row)
                throw DbError.notFound("version");
            return row.version;
        },
        async getById(workspaceId, versionId) {
            const id = requireNonEmpty(versionId, "versionId");
            const [row] = await db
                .select({ version: projectVersions })
                .from(projectVersions)
                .innerJoin(projects, eq(projectVersions.projectId, projects.id))
                .where(and(eq(projectVersions.id, id), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (!row)
                throw DbError.notFound("version");
            return row.version;
        },
    };
}
//# sourceMappingURL=versions.js.map