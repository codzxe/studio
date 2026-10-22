// @studio/gateway — /v1/projects (§7.2, §9.1): list/create/patch/soft-delete
// and the manifest (current version + assets + 10-minute signed URLs, §9.2).
// Tenant scoping happens in @studio/db repos (§12.1: cross-tenant ids 404).

import { Hono } from "hono";

import {
  CREATE_PROJECT_SCHEMA,
  type ManifestAsset,
  PAGINATION_QUERY_SCHEMA,
  PATCH_PROJECT_SCHEMA,
  type Project as ProjectDto,
  type ProjectManifest,
} from "@studio/contracts";

import type { Project } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireLeaseForMutation } from "../lease-guard.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { SIGNED_URL_TTL_SECONDS } from "../signing.js";

export function projectsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  const toDto = (project: Project): ProjectDto => ({
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    slug: project.slug,
    thumbnailUrl: project.thumbnailUrl,
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
    const workspaceId = c.get("workspace").id;
    const result = await deps.repos.projects.list(workspaceId, {
      cursor: query.data.cursor ?? null,
      limit: query.data.limit,
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
