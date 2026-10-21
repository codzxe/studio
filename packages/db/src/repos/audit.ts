import { and, desc, eq, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { type AuditLogEntry, auditLog } from "../schema.js";
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

export interface AuditRepo {
  append(workspaceId: WorkspaceId, input: AuditAppendInput): Promise<AuditLogEntry>;
  list(workspaceId: WorkspaceId, options?: AuditListOptions): Promise<Page<AuditLogEntry>>;
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
  };
}
