import { z } from "zod";
import { type Id } from "./common.js";
export declare const VERSION_LABEL_SCHEMA: z.ZodString;
/**
 * Timeline/confirmation label bound (M7 task 4): labels shown in the version
 * timeline — and the restore confirmation the user types — are short strings
 * (≤ 120 chars, non-empty). The looser 280-char `VERSION_LABEL_SCHEMA` stays
 * for upload descriptors (agent summaries).
 */
export declare const TIMELINE_LABEL_SCHEMA: z.ZodString;
/** `POST /v1/projects/:id/versions` body (JSON descriptor; bytes via signed URL). */
export declare const UPLOAD_VERSION_SCHEMA: z.ZodObject<{
    baseVersionId: z.ZodString;
    sha256: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    agentRunId: z.ZodOptional<z.ZodString>;
    sizeBytes: z.ZodNumber;
}, z.core.$strict>;
export type UploadVersionRequest = z.infer<typeof UPLOAD_VERSION_SCHEMA>;
/**
 * `POST /v1/projects/:id/versions/:versionId/restore` body — restore creates a
 * NEW version with `parent_version_id` set to the restored one; history is
 * never rewritten (§9.3). Confirm-with-confirmation semantics (M7 task 4): the
 * request must carry the exact version id (path) AND a confirmation label the
 * user typed — no bare restores.
 */
export declare const RESTORE_VERSION_SCHEMA: z.ZodObject<{
    confirmLabel: z.ZodString;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type RestoreVersionRequest = z.infer<typeof RESTORE_VERSION_SCHEMA>;
/**
 * `POST /v1/projects/:id/versions/:versionId/label` body. Labels are the ONLY
 * mutable field of a version row (§9.3 allows label metadata; the snapshot
 * bytes, hash, parent linkage and authorship are immutable) — see the D-24
 * candidate ruling in the M7 worklog.
 */
export declare const SET_VERSION_LABEL_SCHEMA: z.ZodObject<{
    label: z.ZodString;
}, z.core.$strict>;
export type SetVersionLabelRequest = z.infer<typeof SET_VERSION_LABEL_SCHEMA>;
/** Version row (§9.1 `project_versions`). */
export interface ProjectVersion {
    readonly id: Id;
    readonly projectId: Id;
    readonly version: number;
    readonly parentVersionId: Id | null;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly label: string | null;
    readonly agentRunId: Id | null;
    readonly createdBy: Id;
    readonly createdAt: string;
}
/**
 * Timeline entry (M7 task 4): the wire version row plus the fields the version
 * timeline renders — author display name, agent-run presence (agentRunId ≠
 * null) and the sha256 PREFIX (12 hex chars; full hashes never appear in user
 * copy beyond a 12-char prefix).
 */
export interface VersionTimelineEntry extends ProjectVersion {
    readonly createdByName: string | null;
    readonly isAgent: boolean;
    readonly sha256Prefix: string;
}
/**
 * Structural diff against the parent version (M7 task 4 v1: no deep content
 * diff — size delta, parent linkage, authorship change, time gap).
 */
export interface VersionDiffFromParent {
    readonly parentVersionId: Id;
    readonly parentVersion: number;
    /** This version's size − the parent's (positive = grew). */
    readonly sizeDeltaBytes: number;
    readonly labelChanged: boolean;
    readonly authorChanged: boolean;
    /** Milliseconds between the parent's creation and this version's. */
    readonly createdGapMs: number;
}
/** `GET /v1/projects/:id/versions/:versionId/diff` response. */
export interface VersionDiffSummary {
    /** `null` for a root version (no parent to compare against). */
    readonly fromParent: VersionDiffFromParent | null;
    /** Human-safe short copy — no raw content hashes. */
    readonly summary: string;
}
