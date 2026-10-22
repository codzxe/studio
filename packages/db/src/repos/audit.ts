import { and, desc, eq, inArray, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import {
  type AuditLogEntry,
  auditLog,
  projectVersions,
  projects,
  user,
} from "../schema.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

/**
 * Audit repository — append-only (§7.1). Every role change, invite, API-key
 * create/revoke and destructive action lands here with actor + ip.
 */
export interface AuditAppendInput {
  readonly actorId?: string | null;
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly metadata?: unknown;
  readonly ip?: string | null;
}

export interface AuditListOptions {
  readonly targetType?: string;
  readonly targetId?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

/**
 * Hard row bound for one-shot exports (M7 task 4): an audit export is a
 * bounded download, never an unbounded table dump. Rows beyond the bound are
 * reported via `truncated` and stay queryable through the paginated feed.
 */
export const AUDIT_EXPORT_MAX_ROWS = 1000;

/**
 * An audit row joined with the actor's user fields (M7 task 4). The FEED only
 * ever surfaces `actorName`; `actorEmail` exists for the admin-only export —
 * the route layers decide what crosses the wire (law #1).
 */
export interface AuditFeedRow extends AuditLogEntry {
  readonly actorName: string | null;
  readonly actorEmail: string | null;
}

export interface AuditExportResult {
  readonly rows: readonly AuditFeedRow[];
  readonly truncated: boolean;
  /** The bound the export was capped at (mirror of AUDIT_EXPORT_MAX_ROWS). */
  readonly maxRows: number;
}

export interface AuditRepo {
  append(workspaceId: WorkspaceId, input: AuditAppendInput): Promise<AuditLogEntry>;
  list(workspaceId: WorkspaceId, options?: AuditListOptions): Promise<Page<AuditLogEntry>>;
  /**
   * M7 task 4 project feed: every audit row recorded against the project OR
   * any of its versions — the union of project-targeted events (project.*,
   * version.uploaded, run.applied, comment.*) and version-targeted events
   * (version.restored, version.labeled) resolved through the version join.
   * Newest-first, same (createdAt, id) cursor protocol as `list`.
   */
  listForProject(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: { limit?: number; cursor?: string | null },
  ): Promise<Page<AuditFeedRow>>;
  /**
   * M7 task 4 audit export: the same project-scoped union as `listForProject`,
   * newest-first, one-shot and BOUNDED by `AUDIT_EXPORT_MAX_ROWS`.
   */
  exportForProject(
    workspaceId: WorkspaceId,
    projectId: string,
    limit?: number,
  ): Promise<AuditExportResult>;
}

export function createAuditRepo(db: StudioDb): AuditRepo {
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
      if (!entry) throw DbError.conflict("Could not append audit entry");
      return entry;
    },

    async list(workspaceId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, workspaceId),
            options?.targetType === undefined
              ? undefined
              : eq(auditLog.targetType, options.targetType),
            options?.targetId === undefined ? undefined : eq(auditLog.targetId, options.targetId),
            cursor
              ? or(
                  lt(auditLog.createdAt, new Date(cursor.t)),
                  and(eq(auditLog.createdAt, new Date(cursor.t)), lt(auditLog.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
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

    async listForProject(workspaceId, projectId, options) {
      const id = requireNonEmpty(projectId, "projectId");
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select({ entry: auditLog, actorName: user.name, actorEmail: user.email })
        .from(auditLog)
        .leftJoin(user, eq(user.id, auditLog.actorId))
        .where(
          and(
            eq(auditLog.workspaceId, workspaceId),
            or(
              eq(auditLog.targetId, id),
              // Version-targeted rows (version.restored, version.labeled)
              // resolve through the version join; the subquery is workspace-
              // scoped so another tenant's ids can never match (§12.1).
              inArray(
                auditLog.targetId,
                db
                  .select({ id: projectVersions.id })
                  .from(projectVersions)
                  .innerJoin(projects, eq(projectVersions.projectId, projects.id))
                  .where(and(eq(projects.workspaceId, workspaceId), eq(projectVersions.projectId, id))),
              ),
            ),
            cursor
              ? or(
                  lt(auditLog.createdAt, new Date(cursor.t)),
                  and(eq(auditLog.createdAt, new Date(cursor.t)), lt(auditLog.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit + 1);

      const items: AuditFeedRow[] = rows
        .slice(0, limit)
        .map((row) => ({ ...row.entry, actorName: row.actorName, actorEmail: row.actorEmail }));
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async exportForProject(workspaceId, projectId, limit) {
      const id = requireNonEmpty(projectId, "projectId");
      const requested =
        limit !== undefined && Number.isInteger(limit) && limit > 0
          ? limit
          : AUDIT_EXPORT_MAX_ROWS;
      const bound = Math.min(requested, AUDIT_EXPORT_MAX_ROWS);
      const rows = await db
        .select({ entry: auditLog, actorName: user.name, actorEmail: user.email })
        .from(auditLog)
        .leftJoin(user, eq(user.id, auditLog.actorId))
        .where(
          and(
            eq(auditLog.workspaceId, workspaceId),
            or(
              eq(auditLog.targetId, id),
              inArray(
                auditLog.targetId,
                db
                  .select({ id: projectVersions.id })
                  .from(projectVersions)
                  .innerJoin(projects, eq(projectVersions.projectId, projects.id))
                  .where(and(eq(projects.workspaceId, workspaceId), eq(projectVersions.projectId, id))),
              ),
            ),
          ),
        )
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
