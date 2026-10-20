// Route registry (§13): the single place where /v1 routers are mounted.
//
// Wave status (W1-H): health only. Every later router lands here in the same
// pattern — build a typed `Hono<AppEnv>` in `src/routes/<area>.ts`, mount it on
// the /v1 sub-app. Keep this catch-all LAST so concrete routes always win.
//
// TODO(§13.1, W2+): mount in rough dependency order —
//   auth        — POST /v1/auth/*  (Better Auth handlers), GET /v1/me
//   workspaces  — POST/GET /v1/workspaces/:id, invites
//   documents   — CRUD + /runs + /commands + /versions + /exports + /preview + SSE wiring
//   runs        — GET /v1/runs/:id, GET /v1/runs/:id/events (SSE, §13.2), POST /cancel
//   uploads     — POST /v1/uploads, GET /v1/assets (pre-signed, §13.1)
//   catalog     — GET /v1/templates, /v1/components
//   billing     — GET /v1/credits, POST /v1/billing/*, POST /v1/webhooks/stripe (idempotent)
//   usage       — GET /v1/usage

import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import type { AppEnv } from "../types.js";
import { healthRoutes } from "./health.js";

/** Typed 501 for /v1 routes that are spec'd but not mounted yet. */
function notImplemented(): Hono<AppEnv> {
  return new Hono<AppEnv>().all("*", (c) =>
    c.json(
      {
        ok: false,
        code: "not_implemented",
        message: "This endpoint is not implemented yet.",
        hint: "It ships in a later wave — see docs/BUILD_PROMPT.md §13.1 for the contract.",
        retryable: false,
        docs_url: undefined,
        details: undefined
      },
      501
    )
  );
}

/** Mount the /v1 API (health today; §13.1 routers as waves land). */
export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const v1 = new Hono<AppEnv>();

  v1.route("/health", healthRoutes(deps));

  // Placeholder so unmounted §13.1 paths answer with a typed 501 instead of a
  // bare 404 while waves are landing. Must stay AFTER all concrete mounts.
  v1.route("/", notImplemented());

  app.route("/v1", v1);
}
