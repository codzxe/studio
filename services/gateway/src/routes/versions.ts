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
  ID_SCHEMA,
  PAGINATION_QUERY_SCHEMA,
  RESTORE_VERSION_SCHEMA,
  UPLOAD_VERSION_SCHEMA,
  type ProjectVersion as VersionDto,
} from "@studio/contracts";

import type { ProjectVersion } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { sha256Hex, snapshotKey } from "../storage.js";
import { audit } from "./projects.js";

/**
 * W3-gw bugfix: a project's FIRST snapshot has no base version — a fresh
 * project has currentVersionId null, so the only non-conflicting descriptor
 * is baseVersionId: null (§9.3 keeps "base is required on upload" — the
 * field is present, its value is null). @studio/contracts'
 * UPLOAD_VERSION_SCHEMA pins baseVersionId to a non-null Id, which made the
 * first upload via POST /v1/projects/:id/versions unreachable (always 409);
 * the gateway therefore accepts null/omitted locally and passes it through to
 * the repo, which still enforces the optimistic-concurrency check. Follow-up
 * for the contracts owner: make UPLOAD_VERSION_SCHEMA.baseVersionId nullable.
 */
const UPLOAD_VERSION_GATEWAY_SCHEMA = UPLOAD_VERSION_SCHEMA.extend({
  baseVersionId: ID_SCHEMA.nullable(),
  // Query strings deliver sizeBytes as text — coerce here so the raw-bytes
  // branch parses; the multipart branch already receives numbers and is
  // unaffected. (Without this the raw upload path could never validate.)
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
      const result = await deps.repos.versions.list(workspaceId, pathParam(c, "id"), {
        cursor: query.data.cursor ?? null,
        limit: query.data.limit,
      });
      return page(c, result.items.map(toDto), result.nextCursor);
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
    "/v1/projects/:id/versions/:version/restore",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const parsed = RESTORE_VERSION_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "The optional note is at most 280 characters.",
          requestId: c.get("requestId"),
        });
      }
      // §9.3: restoring creates a NEW version whose parent is the restored
      // one; history is never rewritten (the repo enforces this).
      const { version } = await deps.repos.versions.restore(workspace.id, {
        projectId,
        versionId: pathParam(c, "version"),
        createdBy: c.get("auth").user.id,
        label: parsed.data.note,
      });
      await audit(deps, c, workspace.id, "version.restored", projectId, {
        versionId: version.id,
        restoredFrom: pathParam(c, "version"),
      });
      return ok(c, toDto(version), 201);
    },
  );

  return app;
}
