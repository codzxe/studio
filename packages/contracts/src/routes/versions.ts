// @studio/contracts — project versions (PRODUCT_ARCHITECTURE.md §7.2, §9.1, §9.3).
//
// Versions are immutable, content-addressed snapshots (§9.2). Upload requires
// `baseVersionId`; a stale base returns 409 PROJECT_VERSION_CONFLICT (§9.3) —
// never overwrite. The JSON descriptor below accompanies the multipart body
// (bytes go to the signed URL, descriptor goes to POST /v1/projects/:id/versions).

import { z } from "zod";

import { ID_SCHEMA, type Id, SHA256_SCHEMA } from "./common.js";

export const VERSION_LABEL_SCHEMA = z.string().max(280);

/** `POST /v1/projects/:id/versions` body (JSON descriptor; bytes via signed URL). */
export const UPLOAD_VERSION_SCHEMA = z.strictObject({
  baseVersionId: ID_SCHEMA,
  sha256: SHA256_SCHEMA,
  label: VERSION_LABEL_SCHEMA.optional(),
  agentRunId: ID_SCHEMA.optional(),
  sizeBytes: z.number().int().positive(),
});

export type UploadVersionRequest = z.infer<typeof UPLOAD_VERSION_SCHEMA>;

/** `POST /v1/projects/:id/versions/:version/restore` body — restore creates a
 * NEW version with parent_version_id set; history is never rewritten (§9.3). */
export const RESTORE_VERSION_SCHEMA = z.strictObject({
  note: VERSION_LABEL_SCHEMA.optional(),
});

export type RestoreVersionRequest = z.infer<typeof RESTORE_VERSION_SCHEMA>;

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
