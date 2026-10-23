// @studio/contracts — project versions (PRODUCT_ARCHITECTURE.md §7.2, §9.1, §9.3).
//
// Versions are immutable, content-addressed snapshots (§9.2). Upload carries
// `baseVersionId` — nullable (W3-G3): null = a root upload with no parent;
// a stale (non-null) base returns 409 PROJECT_VERSION_CONFLICT (§9.3) —
// never overwrite. The JSON descriptor below accompanies the multipart body
// (bytes go to the signed URL, descriptor goes to POST /v1/projects/:id/versions).

import { z } from "zod";

import { ID_SCHEMA, type Id, SHA256_SCHEMA } from "./common.js";

export const VERSION_LABEL_SCHEMA = z.string().max(280);

/**
 * Timeline/confirmation label bound (M7 task 4): labels shown in the version
 * timeline — and the restore confirmation the user types — are short strings
 * (≤ 120 chars, non-empty). The looser 280-char `VERSION_LABEL_SCHEMA` stays
 * for upload descriptors (agent summaries).
 */
export const TIMELINE_LABEL_SCHEMA = z.string().min(1).max(120);

/**
 * `POST /v1/projects/:id/versions` body (JSON descriptor; bytes via signed URL).
 * `baseVersionId` is REQUIRED but nullable (W3-G3): null = a root upload
 * (no parent); a missing key stays invalid — the base is always stated.
 */
export const UPLOAD_VERSION_SCHEMA = z.strictObject({
  baseVersionId: ID_SCHEMA.nullable(),
  sha256: SHA256_SCHEMA,
  label: VERSION_LABEL_SCHEMA.optional(),
  agentRunId: ID_SCHEMA.optional(),
  sizeBytes: z.number().int().positive(),
});

export type UploadVersionRequest = z.infer<typeof UPLOAD_VERSION_SCHEMA>;

/**
 * `POST /v1/projects/:id/versions/:versionId/restore` body — restore creates a
 * NEW version with `parent_version_id` set to the restored one; history is
 * never rewritten (§9.3). Confirm-with-confirmation semantics (M7 task 4): the
 * request must carry the exact version id (path) AND a confirmation label the
 * user typed — no bare restores.
 */
export const RESTORE_VERSION_SCHEMA = z.strictObject({
  confirmLabel: TIMELINE_LABEL_SCHEMA,
  note: VERSION_LABEL_SCHEMA.optional(),
});

export type RestoreVersionRequest = z.infer<typeof RESTORE_VERSION_SCHEMA>;

/**
 * `POST /v1/projects/:id/versions/:versionId/label` body. Labels are the ONLY
 * mutable field of a version row (§9.3 allows label metadata; the snapshot
 * bytes, hash, parent linkage and authorship are immutable) — see the D-24
 * candidate ruling in the M7 worklog.
 */
export const SET_VERSION_LABEL_SCHEMA = z.strictObject({
  label: TIMELINE_LABEL_SCHEMA,
});

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
