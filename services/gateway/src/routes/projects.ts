// @studio/gateway — /v1/projects (§7.2, §9.1): list/create/patch/soft-delete
// and the manifest (current version + assets + 10-minute signed URLs, §9.2).
// Tenant scoping happens in @studio/db repos (§12.1: cross-tenant ids 404).
//
// W1-c (AUD-1 gaps #4/#5/#6): the PATCH-able `archived` lifecycle flag +
// list filter (§9.1), POST /v1/projects/:id/duplicate (project + current
// version snapshot copy), and the per-plan maxProjects quota (§M2.5) enforced
// on create AND duplicate with 429 QUOTA_EXCEEDED. The flat env caps stay the
// outer bounds; the plan catalog is the inner gate.

import { Hono } from "hono";

import {
  CREATE_PROJECT_SCHEMA,
  type ManifestAsset,
  PAGINATION_QUERY_SCHEMA,
  PATCH_PROJECT_SCHEMA,
  type Project as ProjectDto,
  type ProjectManifest,
} from "@studio/contracts";
// The plan catalog lives in @studio/config (§M2.5/M6.1): per-plan maxProjects
// and storageBytes are the INNER quota gates behind the flat env caps.
import { type Entitlements, entitlementsFor } from "@studio/config";

import type { Project } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireLeaseForMutation } from "../lease-guard.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { resolvePlan } from "../plan.js";
import { SIGNED_URL_TTL_SECONDS } from "../signing.js";
import { snapshotKey } from "../storage.js";

export function projectsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  const toDto = (project: Project): ProjectDto => ({
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    slug: project.slug,
    thumbnailUrl: project.thumbnailUrl,
    // §9.1 lifecycle flag (W1-c): archived ≠ deleted.
    archived: project.archived,
    currentVersionId: project.currentVersionId,
    createdBy: project.createdBy,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    deletedAt: project.deletedAt !== null ? project.deletedAt.toISOString() : null,
  });

  app.get("/v1/projects", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
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
    // W1-c (§9.1): the archived list filter. Absent/"false" → the default
    // view EXCLUDES archived projects; "true" → archived-only. Anything
    // else is a 400, never a silent fallback.
    const archivedParam = c.req.query("archived");
    if (archivedParam !== undefined && archivedParam !== "true" && archivedParam !== "false") {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "The `archived` filter accepts true or false.",
        requestId: c.get("requestId"),
      });
    }
    const workspaceId = c.get("workspace").id;
    const result = await deps.repos.projects.list(workspaceId, {
      cursor: query.data.cursor ?? null,
      limit: query.data.limit,
      archivedOnly: archivedParam === "true",
    });
    return page(c, result.items.map(toDto), result.nextCursor);
  });

  app.post("/v1/projects", requireWorkspace("editor"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    const parsed = CREATE_PROJECT_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Project names are 1-120 characters.",
        requestId: c.get("requestId"),
      });
    }
    // W1-c (§M2.5 maxProjects): the plan catalog's project cap. Check-then-act
    // is not atomic across concurrent creates (documented deviation — the
    // worker-wave usage counters tighten it); a plan at the cap refuses new
    // projects with 429 before any row is written.
    await assertProjectQuota(deps, workspace.id, c.get("requestId"));
    const project = await deps.repos.projects.create(workspace.id, {
      name: parsed.data.name,
      description: parsed.data.description,
      createdBy: c.get("auth").user.id,
    });
    await audit(deps, c, workspace.id, "project.created", project.id);
    return ok(c, toDto(project), 201);
  });

  app.get(
    "/v1/projects/:id/manifest",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspaceId = c.get("workspace").id;
      const manifest = await deps.repos.projects.manifest(workspaceId, pathParam(c, "id"));

      const currentVersion = manifest.currentVersion;
      let versionBlock: ProjectManifest["currentVersion"] = null;
      if (currentVersion !== null) {
        const signed = await deps.storage.getSignedUrl(
          currentVersion.objectKey,
          SIGNED_URL_TTL_SECONDS,
          { method: "GET" },
        );
        versionBlock = {
          id: currentVersion.id,
          version: currentVersion.version,
          sha256: currentVersion.sha256,
          label: currentVersion.label,
          sizeBytes: currentVersion.sizeBytes,
          createdAt: currentVersion.createdAt.toISOString(),
          url: signed.url,
        };
      }

      const assets: ManifestAsset[] = await Promise.all(
        manifest.assets.map(async (asset): Promise<ManifestAsset> => {
          const signed = await deps.storage.getSignedUrl(asset.objectKey, SIGNED_URL_TTL_SECONDS, {
            method: "GET",
          });
          return {
            id: asset.id,
            name: asset.name,
            mime: asset.mime,
            sizeBytes: asset.sizeBytes,
            width: asset.width,
            height: asset.height,
            durationTicks: asset.durationTicks,
            url: signed.url,
          };
        }),
      );

      const body: ProjectManifest = {
        projectId: manifest.project.id,
        currentVersion: versionBlock,
        assets,
        updatedAt: manifest.project.updatedAt.toISOString(),
      };
      return ok(c, body);
    },
  );

  app.get(
    "/v1/projects/:id",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const project = await deps.repos.projects.get(c.get("workspace").id, pathParam(c, "id"));
      return ok(c, toDto(project));
    },
  );

  app.patch(
    "/v1/projects/:id",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const parsed = PATCH_PROJECT_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Provide at least one of name or description.",
          requestId: c.get("requestId"),
        });
      }
      // §M7 task 3 read-only: metadata edits belong to the lease holder — a
      // non-holder under an ACTIVE lease gets 409 LEASE_HELD (free/expired pass).
      await requireLeaseForMutation(deps, c, pathParam(c, "id"));
      const project = await deps.repos.projects.patch(workspace.id, pathParam(c, "id"), {
        name: parsed.data.name,
        description: parsed.data.description,
      });
      await audit(deps, c, workspace.id, "project.updated", project.id);
      return ok(c, toDto(project));
    },
  );

  app.delete(
    "/v1/projects/:id",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const project = await deps.repos.projects.softDelete(workspace.id, pathParam(c, "id"));
      await audit(deps, c, workspace.id, "project.deleted", project.id);
      return ok(c, { id: project.id, deletedAt: project.deletedAt?.toISOString() ?? null });
    },
  );

  return app;
}

export async function audit(
  deps: GatewayDeps,
  c: AppContext,
  workspaceId: string,
  action: string,
  targetId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.repos.audit.append(workspaceId, {
      actorId: c.get("auth").user.id,
      action,
      targetType: "project",
      targetId,
      metadata,
    });
  } catch (error) {
    // §7.1 audit-on-mutation, but an audit hiccup must not fail the mutation.
    deps.logger.warn("audit_failed", {
      action,
      workspaceId,
      detail: error instanceof Error ? error.message : "unknown",
    });
  }
}
