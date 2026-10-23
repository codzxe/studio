// @studio/gateway — /v1/projects/:id/versions (§7.2, §9.3): immutable,
// content-addressed snapshots with optimistic concurrency.
//
// Upload accepts either:
//   * multipart/form-data — `descriptor` (JSON string, UPLOAD_VERSION_SCHEMA)
//     + `file` (the .ecproj bytes), or
//   * raw bytes (application/octet-stream) with the descriptor as query
//     parameters (baseVersionId, sha256, sizeBytes, label?, agentRunId?).
//
// Bytes are buffered ONCE (bounded by PROJECT_MAX_BYTES — §9.2 per-plan max
// project size), hashed with SHA-256 server-side and REJECTED on mismatch,
// then written to the content-addressed §9.2 key and registered through the
// versions repo, which owns the PROJECT_VERSION_CONFLICT check (§9.3:
// baseVersionId must equal the project's currentVersionId — never overwrite).
//
// POST requires an Idempotencyency-Key header (middleware): replays return
// the stored version without re-streaming bytes.

import { Hono } from "hono";
import { z } from "zod";

import {
  PAGINATION_QUERY_SCHEMA,
  RESTORE_VERSION_SCHEMA,
  SET_VERSION_LABEL_SCHEMA,
  UPLOAD_VERSION_SCHEMA,
  type ProjectVersion as VersionDto,
  type VersionTimelineEntry,
} from "@studio/contracts";
// buildVersionDiff + VersionTimelineRow are root-exported from @studio/db
// (version-logic); the wire timeline/diff TYPES come from @studio/contracts.
import { type VersionTimelineRow, buildVersionDiff } from "@studio/db";
import type { ProjectVersion } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireLeaseForMutation } from "../lease-guard.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { sha256Hex, snapshotKey } from "../storage.js";
import { audit } from "./projects.js";

/**
 * W3-gw bugfix → CLOSED by W5-09: a project's FIRST snapshot has no base
 * version — a fresh project has currentVersionId null, so the only
 * non-conflicting descriptor is baseVersionId: null (§9.3 keeps "base is
 * required on upload" — the field is present, its value is null).
 * @studio/contracts' UPLOAD_VERSION_SCHEMA.baseVersionId is now
 * ID_SCHEMA.nullable() (required-but-nullable; a missing key stays invalid),
 * so the earlier local null-permission override is gone. What remains local:
 * query strings deliver sizeBytes as text — coerce here so the raw-bytes
 * branch parses; the multipart branch already receives numbers.
 */
const UPLOAD_VERSION_GATEWAY_SCHEMA = UPLOAD_VERSION_SCHEMA.extend({
  sizeBytes: z.coerce.number().int().positive(),
});

type UploadVersionDescriptor = z.infer<typeof UPLOAD_VERSION_GATEWAY_SCHEMA>;

export function versionsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  const toDto = (version: ProjectVersion): VersionDto => ({
    id: version.id,
    projectId: version.projectId,
    version: version.version,
    parentVersionId: version.parentVersionId,
    sha256: version.sha256,
    sizeBytes: version.sizeBytes,
    label: version.label,
    agentRunId: version.agentRunId,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
  });

  /**
   * M7 task 4 timeline entry: the version row plus the timeline display
   * fields — author display name, agent-run presence (agentRunId ≠ null) and
   * the 12-char sha256 prefix (full hashes never appear in user copy).
   */
  const toTimelineDto = (row: VersionTimelineRow): VersionTimelineEntry => ({
    ...toDto(row),
    createdByName: row.createdByName,
    isAgent: row.agentRunId !== null,
    sha256Prefix: row.sha256.slice(0, 12),
  });

  app.get(
    "/v1/projects/:id/versions",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const query = PAGINATION_QUERY_SCHEMA.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!query.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Check the pagination parameters.",
          requestId: c.get("requestId"),
        });
      }
      const workspaceId = c.get("workspace").id;
      const result = await deps.repos.versions.timeline(workspaceId, pathParam(c, "id"), {
        cursor: query.data.cursor ?? null,
        limit: query.data.limit,
      });
      return page(c, result.items.map(toTimelineDto), result.nextCursor);
    },
  );

  app.post(
    "/v1/projects/:id/versions",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const maxBytes = deps.env.storage.projectMaxBytes;
      const requestId = c.get("requestId");

      // §M7 task 3 read-only gate, FIRST in the handler: cross-tenant ids 404
      // through the guard's tenant-filtered lease read (law #3), and a held
      // project refuses bytes BEFORE any buffering/hashing/storage happens.
      // The editor's autosave loop holds the lease, so holder uploads pass.
      await requireLeaseForMutation(deps, c, projectId);

      const contentType = c.req.header("content-type") ?? "";
      const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (Number.isInteger(contentLength) && contentLength > maxBytes) {
        throw new GatewayError("QUOTA_EXCEEDED", "This file is larger than your plan allows.", {
          status: 429,
          hint: `Projects are capped at ${maxBytes} bytes in this environment.`,
          requestId,
        });
      }

      let descriptor: UploadVersionDescriptor;
      let bytes: Buffer;

      if (contentType.includes("multipart/form-data")) {
        const form = await c.req.parseBody();
        const descriptorPart = form.descriptor;
        const filePart = form.file;
        if (typeof descriptorPart !== "string" || !(filePart instanceof File)) {
          throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
            status: 400,
            hint: "Send a multipart body with a `descriptor` JSON part and a `file` part.",
            requestId,
          });
        }
        let parsedDescriptor: unknown;
        try {
          parsedDescriptor = JSON.parse(descriptorPart) as unknown;
        } catch {
          throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
            status: 400,
            hint: "The `descriptor` part must be a JSON object.",
            requestId,
          });
        }
        const validated = UPLOAD_VERSION_GATEWAY_SCHEMA.safeParse(parsedDescriptor);
        if (!validated.success) {
          throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
            status: 400,
            hint: "The descriptor needs baseVersionId, sha256 (64 hex) and sizeBytes.",
            requestId,
          });
        }
        descriptor = validated.data;
        bytes = Buffer.from(await filePart.arrayBuffer());
      } else {
        // Raw .ecproj bytes; descriptor comes from the query string. An omitted
        // baseVersionId means "no base" — the project's first snapshot.
        const validated = UPLOAD_VERSION_GATEWAY_SCHEMA.safeParse({
          baseVersionId: c.req.query("baseVersionId") ?? null,
          sha256: c.req.query("sha256"),
          label: c.req.query("label") ?? undefined,
          agentRunId: c.req.query("agentRunId") ?? undefined,
          sizeBytes: c.req.query("sizeBytes"),
        });
        if (!validated.success) {
          throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
            status: 400,
            hint: "Send the descriptor (baseVersionId, sha256, sizeBytes) as query parameters with the raw bytes as the body.",
            requestId,
          });
        }
        descriptor = validated.data;
        bytes = Buffer.from(await c.req.arrayBuffer());
      }

      if (bytes.byteLength > maxBytes) {
        throw new GatewayError("QUOTA_EXCEEDED", "This file is larger than your plan allows.", {
          status: 429,
          hint: `Projects are capped at ${maxBytes} bytes in this environment.`,
          requestId,
        });
      }
      if (bytes.byteLength !== descriptor.sizeBytes) {
        throw new GatewayError(
          "VALIDATION_FAILED",
          "The uploaded size does not match the descriptor.",
          {
            status: 400,
            hint: `Declared sizeBytes ${descriptor.sizeBytes}, received ${bytes.byteLength}.`,
            requestId,
          },
        );
      }
      const actualSha = sha256Hex(bytes);
      if (actualSha !== descriptor.sha256) {
        // §9.2 content addressing: the blob is only stored under its true hash.
        throw new GatewayError(
          "SHA256_MISMATCH",
          "The uploaded bytes don't match the declared sha256.",
          {
            status: 400,
            hint: "Re-export the project and upload again with the new digest.",
            requestId,
          },
        );
      }

      const objectKey = snapshotKey(workspace.id, projectId, actualSha);
      await deps.storage.put(objectKey, bytes);
      // Orphaned blobs (row insert failed) are reclaimed by the storage
      // lifecycle policy (§9.2 content addressing makes them safe: any future
      // upload of the same bytes reuses the key); the DB row is the source of
      // truth, so typed repo errors propagate untouched.
      const { version } = await deps.repos.versions.upload(workspace.id, {
        projectId,
        expectedVersionId: descriptor.baseVersionId,
        objectKey,
        sha256: actualSha,
        sizeBytes: bytes.byteLength,
        label: descriptor.label,
        agentRunId: descriptor.agentRunId,
        createdBy: c.get("auth").user.id,
      });
      await audit(deps, c, workspace.id, "version.uploaded", projectId, {
        versionId: version.id,
        sha256: actualSha,
      });
      return ok(c, toDto(version), 201);
    },
  );

  app.post(
    "/v1/projects/:id/versions/:versionId/restore",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const versionId = pathParam(c, "versionId");
      const parsed = RESTORE_VERSION_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "Restoring needs a confirmation label.", {
          status: 400,
          hint: 'Send { "confirmLabel": "…" } naming the version you are restoring — no bare restores.',
          requestId: c.get("requestId"),
        });
      }
      // §M7 task 3 read-only gate: a restore creates a new version (a project
      // write) — same holder-only rule as the upload path.
      await requireLeaseForMutation(deps, c, projectId);

      // Confirm-with-confirmation target check: the version must belong to
      // this project BEFORE anything mutates (§12.1 — cross-tenant 404s).
      // Version rows are immutable, so this read cannot go stale against the
      // restore transaction below.
      const source = await deps.repos.versions.get(workspace.id, projectId, versionId);

      // §9.3: restoring creates a NEW version whose parent is the restored
      // one; history is never rewritten (the repo enforces this). The new
      // row's label records where it came from; the typed confirmation +
      // optional note land in the audit entry (restore metadata).
      const { version } = await deps.repos.versions.restore(workspace.id, {
        projectId,
        versionId,
        createdBy: c.get("auth").user.id,
        label: `Restored from v${source.version}`,
      });
      await auditVersion(deps, c, workspace.id, "version.restored", version.id, {
        projectId,
        restoredFromId: source.id,
        restoredFromVersion: source.version,
        confirmLabel: parsed.data.confirmLabel,
        note: parsed.data.note ?? null,
      });
      return ok(c, toDto(version), 201);
    },
  );

  app.post(
    "/v1/projects/:id/versions/:versionId/label",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const versionId = pathParam(c, "versionId");
      const parsed = SET_VERSION_LABEL_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "Version labels are 1–120 characters.", {
          status: 400,
          hint: 'Send { "label": "…" }.',
          requestId: c.get("requestId"),
        });
      }
      // §M7 task 3 read-only gate: a label edit is a project-scoped mutation —
      // same holder-only rule as upload/restore.
      await requireLeaseForMutation(deps, c, projectId);
      // §9.3/D-24 candidate: the label column is the ONLY mutable version field.
      const version = await deps.repos.versions.setLabel(workspace.id, {
        projectId,
        versionId,
        label: parsed.data.label,
      });
      await auditVersion(deps, c, workspace.id, "version.labeled", version.id, {
        projectId,
        label: parsed.data.label,
      });
      return ok(c, toDto(version));
    },
  );

  app.get(
    "/v1/projects/:id/versions/:versionId/diff",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspaceId = c.get("workspace").id;
      const projectId = pathParam(c, "id");
      const versionId = pathParam(c, "versionId");
      const version = await deps.repos.versions.get(workspaceId, projectId, versionId);
      const parent =
        version.parentVersionId !== null
          ? await deps.repos.versions.get(workspaceId, projectId, version.parentVersionId)
          : null;
      // Structural diff only (M7 v1): size delta, parent linkage, authorship
      // change, time gap — never snapshot content or raw hashes in the copy.
      return ok(c, buildVersionDiff(version, parent));
    },
  );

  return app;
}

/**
 * Audit a version-targeted mutation (M7 task 4). Targets the VERSION row,
 * not the project — the activity feed resolves version-targeted rows back to
 * the project through the version join (repos/audit.listForProject). An
 * audit hiccup must never fail the mutation (§7.1 posture, mirrors
 * routes/projects.ts `audit`).
 */
async function auditVersion(
  deps: GatewayDeps,
  c: AppContext,
  workspaceId: string,
  action: string,
  versionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.repos.audit.append(workspaceId, {
      actorId: c.get("auth").user.id,
      action,
      targetType: "version",
      targetId: versionId,
      metadata,
    });
  } catch (error) {
    deps.logger.warn("audit_failed", {
      action,
      workspaceId,
      detail: error instanceof Error ? error.message : "unknown",
    });
  }
}
