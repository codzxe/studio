import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type AuditLogEntry } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
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
export declare const AUDIT_EXPORT_MAX_ROWS = 1000;
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
    listForProject(workspaceId: WorkspaceId, projectId: string, options?: {
        limit?: number;
        cursor?: string | null;
    }): Promise<Page<AuditFeedRow>>;
    /**
     * M7 task 4 audit export: the same project-scoped union as `listForProject`,
     * newest-first, one-shot and BOUNDED by `AUDIT_EXPORT_MAX_ROWS`.
     */
    exportForProject(workspaceId: WorkspaceId, projectId: string, limit?: number): Promise<AuditExportResult>;
}
export declare function createAuditRepo(db: StudioDb): AuditRepo;
