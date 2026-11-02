// @studio/gateway — /v1/workspaces (§7.2, §7.1): list/create/patch.
// Workspaces ARE Better Auth organizations (ADR-0003); slug availability is
// checked on create, every mutation is audited, and cross-tenant ids read as
// 404 (§12.1).

import { Hono } from "hono";

import { CREATE_WORKSPACE_SCHEMA, PATCH_WORKSPACE_SCHEMA, type Workspace } from "@studio/contracts";

import { can } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireAuth, resolveWorkspaceContext } from "../middleware.js";

export function workspacesRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/workspaces/*", requireAuth());

  const toWorkspace = (org: {
    id: string;
    name: string;
    slug: string;
    createdAt: string | null;
  }): Workspace => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    // better-auth's organization table has no updated_at; createdAt mirrors it.
    createdAt: org.createdAt ?? new Date().toISOString(),
    updatedAt: org.createdAt ?? new Date().toISOString(),
  });

  app.get("/v1/workspaces", async (c: AppContext): Promise<Response> => {
    const orgs = await deps.auth.listOrganizations(c.req.raw.headers);
    return ok(
      c,
      orgs.map((org) => toWorkspace(org)),
    );
  });

  app.post("/v1/workspaces", async (c: AppContext): Promise<Response> => {
    const parsed = CREATE_WORKSPACE_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Check the input and try again.",
        requestId: c.get("requestId"),
      });
    }
    const { name, slug } = parsed.data;
    const { user } = c.get("auth");

    const availability = await deps.auth.checkSlug(c.req.raw.headers, slug);
    if (!availability.available) {
      throw new GatewayError("CONFLICT", "That workspace slug is taken.", {
        status: 409,
        hint: "Pick a different slug.",
        requestId: c.get("requestId"),
      });
    }

    const workspace = await deps.auth.createWorkspace(c.req.raw.headers, {
      name,
      slug,
      userId: user.id,
    });
    await audit(c, workspace.id, "workspace.created", workspace.id, "workspace");

    // Signup welcome grant: every NEW workspace starts with a spendable
    // balance (env-overridable SIGNUP_WELCOME_GRANT_MICROCREDITS — the
    // effectively-unlimited first-run posture). Without it a fresh signup
    // reads "0.00 credits — Out of credits" and the FIRST chat turn fails 402
    // INSUFFICIENT_CREDITS (§8.8). Idempotency-keyed per workspace, so a
    // retried create can never double-grant. A grant failure must NEVER block
    // workspace creation — the billing page still renders and support can
    // re-grant. 0 disables the grant entirely (real-billing posture).
    const welcomeGrant = deps.env.app.signupWelcomeGrantMicrocredits;
    if (welcomeGrant > 0) {
      try {
        await deps.repos.ledger.grant(workspace.id, {
          amount: welcomeGrant,
          idempotencyKey: `signup-welcome:${workspace.id}`,
          metadata: { kind: "signup-welcome" },
        });
      } catch (error) {
        deps.logger.warn("signup_welcome_grant_failed", {
          workspaceId: workspace.id,
          detail: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return ok(c, toWorkspace(workspace), 201);
  });

  app.get("/v1/workspaces/:id", async (c: AppContext): Promise<Response> => {
    const candidate = pathParam(c, "id");
    const context = await resolveWorkspaceContext(c, candidate, "viewer");
    return ok(c, {
      ...toWorkspace(context.organization),
      role: context.role,
      members: context.members.map((member) => ({
        userId: member.userId,
        role: member.role,
        name: member.userName,
        email: member.userEmail,
      })),
    });
  });

  app.patch("/v1/workspaces/:id", async (c: AppContext): Promise<Response> => {
    const candidate = pathParam(c, "id");
    const context = await resolveWorkspaceContext(c, candidate, "admin");
    if (!can(context.role, "manageWorkspace")) {
      throw new GatewayError("FORBIDDEN", "You don't have permission to do that.", {
        status: 403,
        hint: "Ask a workspace admin for access.",
        requestId: c.get("requestId"),
      });
    }
    const parsed = PATCH_WORKSPACE_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Provide at least one of name or slug.",
        requestId: c.get("requestId"),
      });
    }
    if (parsed.data.slug !== undefined) {
      const availability = await deps.auth.checkSlug(c.req.raw.headers, parsed.data.slug);
      if (!availability.available) {
        throw new GatewayError("CONFLICT", "That workspace slug is taken.", {
          status: 409,
          hint: "Pick a different slug.",
          requestId: c.get("requestId"),
        });
      }
    }
    const workspace = await deps.auth.updateWorkspace(c.req.raw.headers, {
      organizationId: context.id,
      data: parsed.data,
    });
    await audit(c, context.id, "workspace.updated", context.id, "workspace");
    return ok(c, toWorkspace(workspace));
  });

  async function audit(
    c: AppContext,
    workspaceId: string,
    action: string,
    targetId: string,
    targetType: string,
  ): Promise<void> {
    try {
      await deps.repos.audit.append(workspaceId, {
        actorId: c.get("auth").user.id,
        action,
        targetType,
        targetId,
      });
    } catch (error) {
      // Audit is important but must not fail the user-visible mutation.
      deps.logger.warn("audit_failed", {
        action,
        workspaceId,
        detail: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return app;
}
