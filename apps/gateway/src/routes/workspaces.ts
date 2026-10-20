// Workspace routes (W4-E) — §13.1 REST surface.
//
//   GET    /v1/workspaces                       list mine (memberships)
//   POST   /v1/workspaces                       create: org + owner member +
//                                                 trial credit grant (§1.4/§14.1)
//   GET    /v1/workspaces/:id                   read (any member)
//   GET    /v1/workspaces/:id/members            admin+
//   POST   /v1/workspaces/:id/invites            admin+; role ∈ editor|viewer|admin
//   GET    /v1/workspaces/:id/invites            admin+
//   DELETE /v1/workspaces/:id/invites/:inviteId  admin+ (cancel)
//   PATCH  /v1/workspaces/:id                    rename / brand-tokens (admin+)
//   DELETE /v1/workspaces/:id/members/:userId    admin+; last-owner protected
//   GET    /v1/invites/:token                    view by email token (accept flow)
//   POST   /v1/invites/:token/accept             §13.1 accept  — TODO(email)
//   DELETE /v1/invites/:token                    cancel by token (admin+)
//
// MOUNT (W4-O): this module exports TWO routers because the invite accept flow
// is pinned at /v1/invites by §13.1 (outside the /v1/workspaces prefix):
//   v1.route("/workspaces", workspaceRoutes(deps));
//   v1.route("/invites",    inviteRoutes(deps));
// `deps` follows buildApp's dependency-injection pattern: db/billing/audit
// seams (services/workspaces.ts) + the auth seam below.
//
// Every route: requireAuth middleware → zod-validated input → assertTenant →
// assertCan (§15.2) → typed error envelopes (§13.3, mapped by error-mapper.ts)
// → request correlation (requestId from the §22 middleware, threaded into
// audit metadata). Mounting under buildApp provides errorMapper → requestId →
// requestLogger, so X-Request-Id is echoed on every response.
//
// TODO(idempotency): §13.1 requires Idempotency-Key on mutations; today the
// key is validated + correlated into audit metadata, with enforcement
// landing with the idempotency store / ledger wiring wave. The trial grant
// itself is idempotent per workspace (§14.2 rule 6).

import { Hono, type MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { AppError } from "../middleware/error-mapper.js";
import {
  assertCan,
  createWorkspaceService,
  type CallContext,
  type WorkspaceServiceDeps
} from "../services/workspaces.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Auth seam (parallel contract with W4-C's authz/guard.ts)
// ---------------------------------------------------------------------------

/** The authenticated caller, resolved by the injected user resolver. */
export interface AuthContext {
  readonly userId: string;
  /** Undefined when the resolver cannot establish a verified address (API keys). */
  readonly email?: string;
  readonly name?: string;
}

/**
 * The request context hono hands to middleware — path-agnostic, extracted from
 * MiddlewareHandler so it stays in lockstep with hono's own types.
 */
type GatewayContext = Parameters<MiddlewareHandler<AppEnv>>[0];

/** Resolves the caller (session cookie / API key) or null when unauthenticated. */
export type UserResolver = (c: GatewayContext) => Promise<AuthContext | null> | AuthContext | null;

export interface WorkspaceAuth {
  /** Middleware — 401 `unauthorized` envelope unless a user resolves. */
  readonly requireAuth: MiddlewareHandler<AppEnv>;
  /**
   * Wrap a route handler so it receives the AuthContext requireAuth resolved
   * for this request. (Context is passed via a WeakMap keyed by the request's
   * context object: AppEnv has no `auth` variable and types.ts is not owned by
   * W4-E; W4-C's guard can provide an equivalent adapter.)
   */
  readonly authed: (
    handler: (c: GatewayContext, auth: AuthContext) => Response | Promise<Response>
  ) => MiddlewareHandler<AppEnv>;
}

export function createWorkspaceAuth(resolve: UserResolver): WorkspaceAuth {
  const store = new WeakMap<object, AuthContext>();
  return {
    requireAuth: createMiddleware<AppEnv>(async (c, next) => {
      const user = await resolve(c);
      if (user === null) {
        throw new AppError(401, "unauthorized", "Authentication is required.", {
          hint: "Provide a valid session cookie or API key.",
          retryable: false
        });
      }
      store.set(c, user);
      await next();
    }),
    authed: (handler) =>
      async (c: GatewayContext): Promise<Response> => {
        const user = store.get(c);
        if (user === undefined) {
          // Defensive: requireAuth must run first (router.use("*", requireAuth)).
          throw new AppError(500, "internal_error", "Authentication context missing.", {
            retryable: false
          });
        }
        return handler(c, user);
      }
  };
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface WorkspaceRoutesDeps extends WorkspaceServiceDeps {
  readonly auth: WorkspaceAuth;
}

// ---------------------------------------------------------------------------
// Zod input schemas (§13 boundary validation; ZodError → 422 via error-mapper)
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(200);

const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "1–63 chars: a–z, 0–9, interior dashes")
      .optional()
  })
  .strict();

/** §13.1 invites: role ∈ editor|viewer|admin (never owner). */
const inviteSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    role: z.enum(["admin", "editor", "viewer"]),
    expires_in_days: z.number().int().min(1).max(90).optional()
  })
  .strict();

const patchWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    brand_tokens: z.record(z.string().min(1).max(64), z.unknown()).optional()
  })
  .strict()
  .refine((value) => value.name !== undefined || value.brand_tokens !== undefined, {
    message: "Provide at least one of: name, brand_tokens."
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDEMPOTENCY_HEADER = "idempotency-key";
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** §13.1: use the client's Idempotency-Key when well-formed. */
function idempotencyKey(c: GatewayContext): string | undefined {
  const raw = c.req.header(IDEMPOTENCY_HEADER);
  if (raw !== undefined && IDEMPOTENCY_PATTERN.test(raw)) {
    return raw;
  }
  return undefined;
}

/** §22 correlation context for audit metadata. */
function callContext(c: GatewayContext, withIdempotency: boolean): CallContext {
  return {
    requestId: c.get("requestId"),
    ...(withIdempotency ? { idempotencyKey: idempotencyKey(c) } : {})
  };
}

async function readJsonBody(c: GatewayContext): Promise<unknown> {
  const raw = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    throw new AppError(400, "bad_request", "Request body must be a JSON object.", {
      hint: "Send Content-Type: application/json with a JSON object body.",
      retryable: true
    });
  }
  return raw;
}

function param(c: GatewayContext, key: string): string {
  return idSchema.parse(c.req.param(key));
}

/** Typed 503 when a router is mounted without its dependency seams. */
function notConfigured(): Hono<AppEnv> {
  return new Hono<AppEnv>().all("*", (c) =>
    c.json(
      {
        ok: false,
        code: "not_configured",
        message: "This router was mounted without its dependency seams.",
        hint: "Call workspaceRoutes(deps)/inviteRoutes(deps) with db, billing, audit and auth seams.",
        retryable: false,
        docs_url: undefined,
        details: undefined
      },
      503
    )
  );
}

// ---------------------------------------------------------------------------
// /v1/workspaces router
// ---------------------------------------------------------------------------

export function workspaceRoutes(deps?: WorkspaceRoutesDeps): Hono<AppEnv> {
  if (deps === undefined) {
    return notConfigured();
  }
  const service = createWorkspaceService(deps);
  const auth = deps.auth;
  const router = new Hono<AppEnv>();

  router.use("*", auth.requireAuth);

  // GET /v1/workspaces — list mine.
  router.get(
    "/",
    auth.authed(async (c, user) => {
      const workspaces = await service.listWorkspaces(user.userId);
      return c.json({ ok: true, workspaces });
    })
  );

  // POST /v1/workspaces — create: org + owner member + trial grant.
  router.post(
    "/",
    auth.authed(async (c, user) => {
      const input = createWorkspaceSchema.parse(await readJsonBody(c));
      const created = await service.createWorkspace(user.userId, input, callContext(c, true));
      return c.json(
        { ok: true, workspace: created.workspace, role: created.role, trial: created.trial },
        201
      );
    })
  );

  // GET /v1/workspaces/:id — read (any member; viewer+).
  router.get(
    "/:id",
    auth.authed(async (c, user) => {
      const tenant = await service.assertTenant(user.userId, param(c, "id"));
      assertCan(tenant.membership.role, "workspace.read");
      return c.json({
        ok: true,
        workspace: service.getWorkspace(tenant),
        role: tenant.membership.role
      });
    })
  );

  // GET /v1/workspaces/:id/members — admin+.
  router.get(
    "/:id/members",
    auth.authed(async (c, user) => {
      const tenant = await service.assertTenant(user.userId, param(c, "id"));
      assertCan(tenant.membership.role, "members.list");
      const members = await service.listMembers(tenant);
      return c.json({ ok: true, members });
    })
  );

  // GET /v1/workspaces/:id/invites — admin+.
  router.get(
    "/:id/invites",
    auth.authed(async (c, user) => {
      const tenant = await service.assertTenant(user.userId, param(c, "id"));
      assertCan(tenant.membership.role, "invites.list");
      const invites = await service.listInvites(tenant);
      return c.json({ ok: true, invites });
    })
  );

  // POST /v1/workspaces/:id/invites — admin+; role validated by inviteSchema.
  // TODO(email): the token is returned in-band; email delivery lands with the
  // email wave (see services/workspaces.ts createInvite).
  router.post(
    "/:id/invites",
    auth.authed(async (c, user) => {
      const tenant = await service.assertTenant(user.userId, param(c, "id"));
      assertCan(tenant.membership.role, "invites.create");
      const input = inviteSchema.parse(await readJsonBody(c));
      const invite = await service.createInvite(
        tenant,
        { email: input.email, role: input.role, expiresInDays: input.expires_in_days },
        callContext(c, true)
      );
      return c.json({ ok: true, invite }, 201);
    })
  );

  // DELETE /v1/workspaces/:id/invites/:inviteId — admin+ (cancel).
  router.delete(
    "/:id/invites/:inviteId",
    auth.authed(async (c, user) => {
      const workspaceId = param(c, "id");
      const inviteId = param(c, "inviteId");
      await service.cancelInvite(
        user.userId,
        { token: inviteId, workspaceId },
        callContext(c, true)
      );
      return c.json({ ok: true });
    })
  );

  // PATCH /v1/workspaces/:id — rename / brand tokens (admin+).
  router.patch(
    "/:id",
    auth.authed(async (c, user) => {
      const tenant = await service.assertTenant(user.userId, param(c, "id"));
      assertCan(tenant.membership.role, "workspace.update");
      const input = patchWorkspaceSchema.parse(await readJsonBody(c));
      const workspace = await service.updateWorkspace(
        tenant,
        { name: input.name, brandTokens: input.brand_tokens },
        callContext(c, true)
      );
      return c.json({ ok: true, workspace });
    })
  );

  // DELETE /v1/workspaces/:id/members/:userId — admin+, last-owner protected.
  router.delete(
    "/:id/members/:userId",
    auth.authed(async (c, user) => {
      const tenant = await service.assertTenant(user.userId, param(c, "id"));
      assertCan(tenant.membership.role, "members.remove");
      await service.removeMember(tenant, param(c, "userId"), callContext(c, true));
      return c.json({ ok: true });
    })
  );

  return router;
}

// ---------------------------------------------------------------------------
// /v1/invites router (§13.1 invite accept flow; TODO(email) seams)
// ---------------------------------------------------------------------------

export function inviteRoutes(deps?: WorkspaceRoutesDeps): Hono<AppEnv> {
  if (deps === undefined) {
    return notConfigured();
  }
  const service = createWorkspaceService(deps);
  const router = new Hono<AppEnv>();

  router.use("*", deps.auth.requireAuth);

  // GET /v1/invites/:token — pre-accept view (token is the capability).
  router.get(
    "/:token",
    deps.auth.authed(async (c) => {
      const invite = await service.viewInvite(param(c, "token"));
      return c.json({ ok: true, invite });
    })
  );

  // POST /v1/invites/:token/accept — §13.1. Placeholder for the email-verified
  // flow: TODO(email) — delivery of the token by email, plus verifying the
  // accepter's address against invitation.email, land with the email wave.
  router.post(
    "/:token/accept",
    deps.auth.authed(async (c, user) => {
      const accepted = await service.acceptInvite(
        user.userId,
        param(c, "token"),
        callContext(c, true)
      );
      return c.json({ ok: true, workspace_id: accepted.workspaceId, role: accepted.role });
    })
  );

  // DELETE /v1/invites/:token — cancel (admin+ of the inviting workspace).
  router.delete(
    "/:token",
    deps.auth.authed(async (c, user) => {
      await service.cancelInvite(user.userId, { token: param(c, "token") }, callContext(c, true));
      return c.json({ ok: true });
    })
  );

  return router;
}
