// @studio/contracts — project versions (PRODUCT_ARCHITECTURE.md §7.2, §9.1, §9.3).
//
// Versions are immutable, content-addressed snapshots (§9.2). Upload requires
// `baseVersionId`; a stale base returns 409 PROJECT_VERSION_CONFLICT (§9.3) —
// never overwrite. The JSON descriptor below accompanies the multipart body
// (bytes go to the signed URL, descriptor goes to POST /v1/projects/:id/versions).
import { z } from "zod";
import { ID_SCHEMA, SHA256_SCHEMA } from "./common.js";
export const VERSION_LABEL_SCHEMA = z.string().max(280);
/**
 * Timeline/confirmation label bound (M7 task 4): labels shown in the version
 * timeline — and the restore confirmation the user types — are short strings
 * (≤ 120 chars, non-empty). The looser 280-char `VERSION_LABEL_SCHEMA` stays
 * for upload descriptors (agent summaries).
 */
export const TIMELINE_LABEL_SCHEMA = z.string().min(1).max(120);
/** `POST /v1/projects/:id/versions` body (JSON descriptor; bytes via signed URL). */
export const UPLOAD_VERSION_SCHEMA = z.strictObject({
    baseVersionId: ID_SCHEMA,
    sha256: SHA256_SCHEMA,
    label: VERSION_LABEL_SCHEMA.optional(),
    agentRunId: ID_SCHEMA.optional(),
    sizeBytes: z.number().int().positive(),
});
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
/**
 * `POST /v1/projects/:id/versions/:versionId/label` body. Labels are the ONLY
 * mutable field of a version row (§9.3 allows label metadata; the snapshot
 * bytes, hash, parent linkage and authorship are immutable) — see the D-24
 * candidate ruling in the M7 worklog.
 */
export const SET_VERSION_LABEL_SCHEMA = z.strictObject({
    label: TIMELINE_LABEL_SCHEMA,
});
//# sourceMappingURL=versions.js.map