import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type Project, type ProjectVersion } from "../schema.js";
import { type VersionTimelineRow } from "../version-logic.js";
import { type WorkspaceId } from "./shared.js";
/**
 * Versions repository — immutable snapshots (§9.3).
 *
 * - `upload` is an optimistic-concurrency transaction: the project row is
 *   locked FOR UPDATE, `expectedVersionId` must equal `projects.currentVersionId`
 *   or the caller gets a typed PROJECT_VERSION_CONFLICT, then the version row
 *   is inserted and `currentVersionId` advanced — atomically.
 * - No update paths exist EXCEPT `setLabel`: a version row's snapshot bytes,
 *   hash, parent linkage and authorship are immutable; the human label is the
 *   one piece of §9.3-allowed metadata that may change (D-24 candidate ruling).
 * - `restore` creates a NEW version whose parent is the restored one.
 */
export interface VersionUploadInput {
    readonly projectId: string;
    /** Optimistic concurrency token — must equal the project's currentVersionId. */
    readonly expectedVersionId: string | null;
    readonly objectKey: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly label?: string;
    readonly agentRunId?: string;
    readonly createdBy: string;
}
export interface VersionRestoreInput {
    readonly projectId: string;
    readonly versionId: string;
    readonly createdBy: string;
    /** Optional: stricter than "current at restore time". */
    readonly expectedVersionId?: string | null;
    readonly label?: string;
}
/** `setLabel` input (M7 task 4): the ONLY mutable version field (D-24). */
export interface VersionLabelInput {
    readonly projectId: string;
    readonly versionId: string;
    /** 1–120 characters (TIMELINE_LABEL_SCHEMA bound, enforced again here). */
    readonly label: string;
}
export interface VersionListOptions {
    readonly limit?: number;
    readonly cursor?: string | null;
}
export interface VersionRestoreResult {
    readonly version: ProjectVersion;
    readonly project: Project;
    /** The restored source row (immutable §9.3) — for audit/label metadata. */
    readonly source: ProjectVersion;
}
export interface VersionsRepo {
    upload(workspaceId: WorkspaceId, input: VersionUploadInput): Promise<{
        version: ProjectVersion;
        project: Project;
    }>;
    restore(workspaceId: WorkspaceId, input: VersionRestoreInput): Promise<VersionRestoreResult>;
    list(workspaceId: WorkspaceId, projectId: string, options?: VersionListOptions): Promise<Page<ProjectVersion>>;
    /**
     * M7 task 4 timeline: the same newest-first page as `list`, joined with the
     * author's display name for the timeline UI. Cross-tenant project ids read
     * as NOT_FOUND (§12.1).
     */
    timeline(workspaceId: WorkspaceId, projectId: string, options?: VersionListOptions): Promise<Page<VersionTimelineRow>>;
    get(workspaceId: WorkspaceId, projectId: string, versionId: string): Promise<ProjectVersion>;
    /**
     * M7 task 4 labels: conditional update of the `label` column ONLY — the
     * one §9.3-allowed mutable field (D-24 candidate). Cross-tenant or unknown
     * version/project reads as NOT_FOUND; no other column is ever touched.
     */
    setLabel(workspaceId: WorkspaceId, input: VersionLabelInput): Promise<ProjectVersion>;
    /**
     * M5.4 apply flow: fetch a version by id scoped to the workspace alone (the
     * run row supplies the project; a version of another tenant's project or
     * an unknown id reads as NOT_FOUND — §12.1). Read-only; versions stay
     * immutable (§9.3).
     */
    getById(workspaceId: WorkspaceId, versionId: string): Promise<ProjectVersion>;
}
export declare function createVersionsRepo(db: StudioDb): VersionsRepo;
