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

// The plan catalog lives in @studio/config (§M2.5/M6.1): per-plan maxProjects
// and storageBytes are the INNER quota gates behind the flat env caps.
import { type Entitlements, entitlementsFor } from "@studio/config";
import {
  CREATE_PROJECT_SCHEMA,
  type ManifestAsset,
  PAGINATION_QUERY_SCHEMA,
  PATCH_PROJECT_SCHEMA,
  type Project as ProjectDto,
  type ProjectManifest,
  type ProjectResolve,
} from "@studio/contracts";

import type { Project } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireLeaseForMutation } from "../lease-guard.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { isAdminRole, resolvePlan } from "../plan.js";
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
    await assertProjectQuota(
      deps,
      workspace.id,
      c.get("requestId"),
      isAdminRole(c.get("auth").user.role),
    );
    const project = await deps.repos.projects.create(workspace.id, {
      name: parsed.data.name,
      description: parsed.data.description,
      createdBy: c.get("auth").user.id,
    });
    await audit(deps, c, workspace.id, "project.created", project.id);
    return ok(c, toDto(project), 201);
  });

  app.get("/v1/projects/resolve/:slug", async (c: AppContext): Promise<Response> => {
    // The TTFB fix (perf round): by-slug resolution in ONE call — one auth
    // pass, one joined SQL, the manifest included. Replaces the RSC fan-out
    // (`/v1/me` + per-workspace project pages + manifest, each call paying
    // the auth+workspace middleware and better-auth's per-org lookups — a
    // measured 7-10s editor TTFB on many-workspace accounts).
    const { user } = c.get("auth");
    const slugParam = pathParam(c, "slug");
    // The history page's `?ws=` scoping: id or slug, narrowed in the repo's
    // joined query (a foreign workspace never leaks — the join only ever
    // follows the caller's own memberships).
    const workspaceFilter = c.req.query("workspace") ?? null;
    const resolved = await deps.repos.projects.resolveBySlug(user.id, slugParam, workspaceFilter);
    if (resolved === null) {
      throw new GatewayError("PROJECT_NOT_FOUND", "We couldn't find that project.", {
        status: 404,
        hint: "It may have been deleted or archived, or belong to another workspace.",
        requestId: c.get("requestId"),
      });
    }

    const manifest = await deps.repos.projects.manifest(resolved.workspaceId, resolved.project.id);
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

    const body: ProjectResolve = {
      workspaceId: resolved.workspaceId,
      workspace: {
        id: resolved.workspaceId,
        name: resolved.workspaceName,
        slug: resolved.workspaceSlug,
      },
      viewerId: user.id,
      role:
        resolved.role === "owner" ||
        resolved.role === "admin" ||
        resolved.role === "editor" ||
        resolved.role === "viewer"
          ? resolved.role
          : "viewer",
      project: toDto(resolved.project),
      manifest: {
        projectId: manifest.project.id,
        currentVersion: versionBlock,
        assets,
        updatedAt: manifest.project.updatedAt.toISOString(),
      },
    };
    return ok(c, body);
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
        // W1-c (§9.1): archived PATCHes ride the same lease rule — flipping
        // the lifecycle flag is a project-scoped mutation.
        archived: parsed.data.archived,
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

  // W1-c (§M2.1/§9.1): duplicate — copy the project and its CURRENT version
  // snapshot into a new "<name> (copy)" project. Design notes:
  //   * Reads of the source stay lease-legal (D-23 gates MUTATIONS only) and
  //     the fresh target cannot hold a lease — no lease gate here.
  //   * The snapshot copy is server-side (driver.copy — S3 CopyObject / a
  //     kernel file copy; the bytes never transit the gateway), then the
  //     versions repo owns the row + currentVersionId advance transactionally
  //     (same upload path as POST /v1/projects/:id/versions, §9.3: the copy is
  //     version 1 of the NEW project with parent null).
  //   * The maxProjects quota is enforced BEFORE anything is created.
  //   * v1 copies project metadata + the current snapshot only: history stays
  //     on the source, and project-scoped assets are not re-linked (the
  //     workspace library remains visible to the copy's manifest).
  app.post(
    "/v1/projects/:id/duplicate",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const sourceId = pathParam(c, "id");
      // §12.1 first: the repo get is tenant-scoped — cross-tenant ids read as
      // 404 before any quota state is probed.
      const source = await deps.repos.projects.get(workspace.id, sourceId);
      await assertProjectQuota(
        deps,
        workspace.id,
        c.get("requestId"),
        isAdminRole(c.get("auth").user.role),
      );

      const target = await deps.repos.projects.create(workspace.id, {
        name: duplicateName(source.name),
        description: source.description ?? undefined,
        createdBy: c.get("auth").user.id,
      });

      let project = target;
      if (source.currentVersionId !== null) {
        try {
          const snapshot = await deps.repos.versions.get(
            workspace.id,
            source.id,
            source.currentVersionId,
          );
          // §9.2 content addressing: the same sha lands under the TARGET
          // project's own key space (identical bytes, independent lifecycle).
          const targetKey = snapshotKey(workspace.id, target.id, snapshot.sha256);
          await deps.storage.copy(snapshot.objectKey, targetKey);
          const uploaded = await deps.repos.versions.upload(workspace.id, {
            projectId: target.id,
            expectedVersionId: null,
            objectKey: targetKey,
            sha256: snapshot.sha256,
            sizeBytes: snapshot.sizeBytes,
            label: `Copied from ${source.name}`.slice(0, 120),
            createdBy: c.get("auth").user.id,
          });
          project = uploaded.project;
        } catch (error) {
          // Roll the empty shell back into the deleted_at recovery window — a
          // half-duplicate (project row without its snapshot) must not linger
          // in the list view. The storage copy is best-effort (§9.2 orphans are
          // lifecycle-reclaimed); rethrow the original failure.
          await deps.repos.projects.softDelete(workspace.id, target.id).catch(() => undefined);
          throw error;
        }
      }

      await audit(deps, c, workspace.id, "project.duplicated", project.id, {
        sourceProjectId: source.id,
        snapshotCopied: source.currentVersionId !== null,
      });
      return ok(c, toDto(project), 201);
    },
  );

  return app;
}

/**
 * W1-c (§M2.5): the workspace's EFFECTIVE plan entitlements, resolved through
 * the single resolvePlan seam (subscription row; legacy/stub boots fall back
 * to trial per D-4 — the most restrictive tier, so quota gates fail CLOSED).
 * Exported for the assets route (the storageBytes gate shares this seam).
 */
export async function planEntitlements(workspaceId: string, admin = false): Promise<Entitlements> {
  return entitlementsFor(await resolvePlan(workspaceId, { admin }));
}

/** 429 QUOTA_EXCEEDED when the workspace is at its plan's maxProjects cap. */
async function assertProjectQuota(
  deps: GatewayDeps,
  workspaceId: string,
  requestId: string,
  admin: boolean,
): Promise<void> {
  const [entitlements, liveProjects] = await Promise.all([
    planEntitlements(workspaceId, admin),
    deps.repos.projects.countActive(workspaceId),
  ]);
  if (liveProjects >= entitlements.maxProjects) {
    throw new GatewayError("QUOTA_EXCEEDED", "You've reached your plan's project limit.", {
      status: 429,
      hint: "Upgrade your plan to create more projects, or delete one you no longer need.",
      requestId,
    });
  }
}

/** "<name> (copy)" — truncated so the total respects the 120-char name cap. */
function duplicateName(name: string): string {
  const suffix = " (copy)";
  if (name.length + suffix.length <= 120) return `${name}${suffix}`;
  return `${name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
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
