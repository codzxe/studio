// @studio/gateway — Hono app factory (§7 API surface).
//
// buildApp(deps) assembles the full middleware chain and every §7.2 route.
// All dependencies are injected (see context.ts) so tests boot the app with
// fake repos/auth/storage and production wires real ones (index.ts).

import { Hono } from "hono";

import { AUTH_MOUNT_PATH } from "./env.js";
import type { AppBindings, GatewayDeps } from "./context.js";
import { toErrorEnvelope } from "./errors.js";
import {
  accessLogMiddleware,
  corsMiddleware,
  idempotencyMiddleware,
  rateLimitMiddleware,
  requestIdMiddleware,
} from "./middleware.js";

import { activityRoutes } from "./routes/activity.js";
import { assetsRoutes } from "./routes/assets.js";
import { billingRoutes } from "./routes/billing.js";
import { chatRoutes } from "./routes/chat.js";
import { commentsRoutes } from "./routes/comments.js";
import { creditsRoutes } from "./routes/credits.js";
import { healthRoutes } from "./routes/health.js";
import { invitesRoutes } from "./routes/invites.js";
import { leasesRoutes } from "./routes/leases.js";
import { localStorageRoutes } from "./routes/local-storage.js";
import { meRoutes } from "./routes/me.js";
import { projectsRoutes } from "./routes/projects.js";
import { rendersRoutes } from "./routes/renders.js";
import { runsRoutes } from "./routes/runs.js";
import { threadsRoutes } from "./routes/threads.js";
import { versionsRoutes } from "./routes/versions.js";
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
    return c.json(envelope, status as 200 | 201 | 400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503 | 504);
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

  app.use("*", idempotencyMiddleware());

  app.route("/", healthRoutes(deps));
  app.route("/", meRoutes(deps));
  app.route("/", workspacesRoutes(deps));
  app.route("/", invitesRoutes(deps));
  app.route("/", projectsRoutes(deps));
  app.route("/", versionsRoutes(deps));
  app.route("/", leasesRoutes(deps));
  app.route("/", assetsRoutes(deps));
  app.route("/", threadsRoutes(deps));
  app.route("/", chatRoutes(deps));
  app.route("/", runsRoutes(deps));
  app.route("/", creditsRoutes(deps));
  app.route("/", billingRoutes(deps));
  app.route("/", rendersRoutes(deps));
  app.route("/", commentsRoutes(deps));
  app.route("/", activityRoutes(deps));
  if (deps.local !== null) {
    app.route("/", localStorageRoutes(deps));
  }

  return app;
}
