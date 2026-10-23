import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { auditLog, projectVersions, projects, user } from "../schema.js";
import { requireNonEmpty } from "./shared.js";
/**
 * Hard row bound for one-shot exports (M7 task 4): an audit export is a
 * bounded download, never an unbounded table dump. Rows beyond the bound are
 * reported via `truncated` and stay queryable through the paginated feed.
 */
export const AUDIT_EXPORT_MAX_ROWS = 1000;
export function createAuditRepo(db) {
    return {
        async append(workspaceId, input) {
            const action = requireNonEmpty(input.action, "action");
            const [entry] = await db
                .insert(auditLog)
                .values({
                id: createId("aud"),
                workspaceId,
                actorId: input.actorId ?? null,
                action,
                targetType: input.targetType ?? null,
                targetId: input.targetId ?? null,
                metadata: input.metadata,
                ip: input.ip ?? null,
            })
                .returning();
            if (!entry)
                throw DbError.conflict("Could not append audit entry");
            return entry;
        },
        async list(workspaceId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select()
                .from(auditLog)
                .where(and(eq(auditLog.workspaceId, workspaceId), options?.targetType === undefined
                ? undefined
                : eq(auditLog.targetType, options.targetType), options?.targetId === undefined ? undefined : eq(auditLog.targetId, options.targetId), cursor
                ? or(lt(auditLog.createdAt, new Date(cursor.t)), and(eq(auditLog.createdAt, new Date(cursor.t)), lt(auditLog.id, cursor.id)))
                : undefined))
                .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
                .limit(limit + 1);
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async listForProject(workspaceId, projectId, options) {
            const id = requireNonEmpty(projectId, "projectId");
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select({ entry: auditLog, actorName: user.name, actorEmail: user.email })
                .from(auditLog)
                .leftJoin(user, eq(user.id, auditLog.actorId))
                .where(and(eq(auditLog.workspaceId, workspaceId), or(eq(auditLog.targetId, id), 
            // Version-targeted rows (version.restored, version.labeled)
            // resolve through the version join; the subquery is workspace-
            // scoped so another tenant's ids can never match (§12.1).
            inArray(auditLog.targetId, db
                .select({ id: projectVersions.id })
                .from(projectVersions)
                .innerJoin(projects, eq(projectVersions.projectId, projects.id))
                .where(and(eq(projects.workspaceId, workspaceId), eq(projectVersions.projectId, id))))), cursor
                ? or(lt(auditLog.createdAt, new Date(cursor.t)), and(eq(auditLog.createdAt, new Date(cursor.t)), lt(auditLog.id, cursor.id)))
                : undefined))
                .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
                .limit(limit + 1);
            const items = rows
                .slice(0, limit)
                .map((row) => ({ ...row.entry, actorName: row.actorName, actorEmail: row.actorEmail }));
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async exportForProject(workspaceId, projectId, limit) {
            const id = requireNonEmpty(projectId, "projectId");
            const requested = limit !== undefined && Number.isInteger(limit) && limit > 0 ? limit : AUDIT_EXPORT_MAX_ROWS;
            const bound = Math.min(requested, AUDIT_EXPORT_MAX_ROWS);
            const rows = await db
                .select({ entry: auditLog, actorName: user.name, actorEmail: user.email })
                .from(auditLog)
                .leftJoin(user, eq(user.id, auditLog.actorId))
                .where(and(eq(auditLog.workspaceId, workspaceId), or(eq(auditLog.targetId, id), inArray(auditLog.targetId, db
                .select({ id: projectVersions.id })
                .from(projectVersions)
                .innerJoin(projects, eq(projectVersions.projectId, projects.id))
                .where(and(eq(projects.workspaceId, workspaceId), eq(projectVersions.projectId, id)))))))
                .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
                .limit(bound + 1);
            return {
                rows: rows.slice(0, bound).map((row) => ({
                    ...row.entry,
                    actorName: row.actorName,
                    actorEmail: row.actorEmail,
                })),
                truncated: rows.length > bound,
                maxRows: AUDIT_EXPORT_MAX_ROWS,
            };
        },
    };
}
//# sourceMappingURL=audit.js.map