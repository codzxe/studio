// @studio/gateway — Hono app factory (§7 API surface).
//
// buildApp(deps) assembles the full middleware chain and every §7.2 route.
// All dependencies are injected (see context.ts) so tests boot the app with
// fake repos/auth/storage and production wires real ones (index.ts).

import { Hono } from "hono";

import type { AppBindings, GatewayDeps } from "./context.js";
import { AUTH_MOUNT_PATH } from "./env.js";
import { toErrorEnvelope } from "./errors.js";
import {
  accessLogMiddleware,
  corsMiddleware,
  idempotencyMiddleware,
  rateLimitMiddleware,
  requestIdMiddleware,
} from "./middleware.js";

import { activityRoutes } from "./routes/activity.js";
import { apiKeysRoutes } from "./routes/api-keys.js";
import { applyRoutes } from "./routes/apply.js";
import { assetsRoutes } from "./routes/assets.js";
import { billingRoutes } from "./routes/billing.js";
import { commentsRoutes } from "./routes/comments.js";
import { creditsRoutes } from "./routes/credits.js";
import { healthRoutes } from "./routes/health.js";
import { invitesRoutes } from "./routes/invites.js";
import { leasesRoutes } from "./routes/leases.js";
import { localStorageRoutes } from "./routes/local-storage.js";
import { meRoutes } from "./routes/me.js";
import { membersRoutes } from "./routes/members.js";
import { modelsRoutes } from "./routes/models.js";
import { presenceRoutes } from "./routes/presence.js";
import { projectsRoutes } from "./routes/projects.js";
import { rendersRoutes } from "./routes/renders.js";
import { runsRoutes } from "./routes/runs.js";
import { settingsRoutes } from "./routes/settings.js";
import { shareAuthedRoutes, sharePublicRoutes } from "./routes/share.js";
import { threadsRoutes } from "./routes/threads.js";
import { registerToolRoutes } from "./routes/tools.js";
import { turnRoutes } from "./routes/turn.js";
import { versionsRoutes } from "./routes/versions.js";
import { workspaceAuditRoutes } from "./routes/workspace-audit.js";
import { workspacesRoutes } from "./routes/workspaces.js";

export interface BuildAppOptions {
  readonly deps: GatewayDeps;
}

export function buildApp(options: BuildAppOptions): Hono<AppBindings> {
  const { deps } = options;
  const app = new Hono<AppBindings>();

  // Dependencies on the context for every downstream handler/middleware.
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.use("*", requestIdMiddleware());
  app.use("*", accessLogMiddleware());
  app.use("*", corsMiddleware(deps.env.app.url));
  app.use("*", rateLimitMiddleware());

  // Error boundary (§7.3): every failure renders a safe Err envelope; stacks,
  // paths, URLs and provider errors stay in server-side logs only.
  app.onError((error, c) => {
    const requestId = c.get("requestId") ?? "req_unknown";
    const { status, envelope } = toErrorEnvelope(error, requestId);
    if (status >= 500) {
      deps.logger.error("request_failed", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        code: envelope.error.code,
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    } else {
      deps.logger.info("request_rejected", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        code: envelope.error.code,
        status,
      });
    }
    return c.json(
      envelope,
      status as
        | 200
        | 201
        | 400
        | 401
        | 402
        | 403
        | 404
        | 409
        | 413
        | 415
        | 429
        | 500
        | 502
        | 503
        | 504,
    );
  });

  // Default 404: { error: { code: "NOT_FOUND", … } }.
  app.notFound((c) => {
    const requestId = c.get("requestId") ?? "req_unknown";
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Not found.",
          hint: "Check the URL and try again.",
          retryable: false,
          requestId,
        },
      },
      404,
    );
  });

  // Better Auth (§7.1): handler consumes the raw Request and returns a full
  // Response (cookies included) — Hono passes both through untouched.
  // Verified against installed better-auth 1.7.12: `handler: (request:
  // Request) => Promise<Response>`; the internal router's basePath comes from
  // the baseURL pathname, hence createAuth receives `${APP_URL}/v1/auth`.
  app.on(["POST", "GET"], `${AUTH_MOUNT_PATH}/*`, (c) => deps.auth.handler(c.req.raw));

  // M7-E (§M7 task 5): the PUBLIC share surface, /v1/share/*. Mounted BEFORE
  // the idempotency middleware (below): anonymous share-page POSTs — guest
  // comments via the pinned createGuestComment handler + request-access —
  // cannot carry an Idempotency-Key, so they bypass the §7.2 idempotency
  // gate and rely on this router's own per-IP fixed windows + password
  // gates instead (Hono runs the earlier-matching POST handler and stops
  // there; every earlier middleware — requestId/log/CORS/rate-limit — still
  // applies). No requireAuth anywhere in this router: the token (or token +
  // x-share-password) IS the capability.
  app.route("/", sharePublicRoutes(deps));

  app.use("*", idempotencyMiddleware());

  app.route("/", healthRoutes(deps));
  app.route("/", meRoutes(deps));
  app.route("/", settingsRoutes(deps));
  app.route("/", workspacesRoutes(deps));
  app.route("/", workspaceAuditRoutes(deps));
  app.route("/", invitesRoutes(deps));
  app.route("/", projectsRoutes(deps));
  app.route("/", versionsRoutes(deps));
  app.route("/", leasesRoutes(deps));
  app.route("/", assetsRoutes(deps));
  app.route("/", threadsRoutes(deps));
  // ROUND 12: the client-driven agent loop — the stateless turn route
  // (research/round12-design.md) replaces the retired in-request /chat loop.
  app.route("/", turnRoutes(deps));
  // ROUND 12: agent generative tools (web_search / generate_image) — keyless
  // Tavily by default, env-configured image provider when set.
  app.route("/", registerToolRoutes(deps));
  app.route("/", runsRoutes(deps));
  app.route("/", applyRoutes(deps));
  app.route("/", modelsRoutes(deps));
  app.route("/", creditsRoutes(deps));
  app.route("/", billingRoutes(deps));
  app.route("/", rendersRoutes(deps));
  app.route("/", commentsRoutes(deps));
  app.route("/", shareAuthedRoutes(deps));
  app.route("/", activityRoutes(deps));
  app.route("/", presenceRoutes(deps));
  app.route("/", membersRoutes(deps));
  app.route("/", apiKeysRoutes(deps));
  if (deps.local !== null) {
    app.route("/", localStorageRoutes(deps));
  }

  return app;
}
