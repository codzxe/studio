// Route registry (§13): the single place where /v1 routers are mounted.
//
// Wave status: health (W1-H) + the credits/billing/audit groups (W8-K/W8-P
// fleet flags — the routers shipped in their own waves with one-call wire
// fns; W10-F mounts them here, deps-gated). /metrics is NOT mounted here —
// app.ts (W10-E) owns that internal-only root mount with the METRICS_TOKEN
// seam + the per-app HTTP counters. Every later router lands here in the
// same pattern — build a typed `Hono<AppEnv>` in `src/routes/<area>.ts`,
// mount it on the /v1 sub-app. Keep this catch-all LAST so concrete routes
// always win.
//
// TODO(§13.1, W2+): mount in rough dependency order —
//   auth        — POST /v1/auth/*  (Better Auth handlers), GET /v1/me
//   workspaces  — POST/GET /v1/workspaces/:id, invites (+ /v1/api-keys REST —
//                 W8-L flag: routes still to land, plugin columns missing)
//   documents   — CRUD + /runs + /commands + /versions + /exports + /preview + SSE wiring
//   runs        — GET /v1/runs/:id, GET /v1/runs/:id/events (SSE, §13.2), POST /cancel
//   usage       — mounted with credits above (GET /v1/usage)
//
// Group mounts are deps-gated like buildApp's own groups ("a route group
// mounts only when its pre-baked deps are present"): credits/billing/audit
// mount when AppDeps carries their group deps, and stay behind the typed 501
// catch-all otherwise (W8-K degrade contract — the web billing page renders
// its typed 501 state until the wiring wave injects the service seams).

import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import type { AppEnv } from "../types.js";
import { mountAuditRoutes } from "./audit.js";
import { mountBillingRoutes } from "./billing.js";
import { mountCreditsRoutes } from "./credits.js";
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

  // --- credits + usage (W4/W6 routes, mountCreditsRoutes one-call wire) ----
  if (deps.creditsDeps !== undefined) {
    mountCreditsRoutes(v1, deps.creditsDeps, {
      creditsPath: "/credits",
      usagePath: "/usage",
    });
  }

  // --- billing + Stripe webhook (W4-N routes, mountBillingRoutes) ----------
  if (deps.billingDeps !== undefined) {
    mountBillingRoutes(v1, deps.billingDeps, {
      billingPath: "/billing",
      webhookPath: "/webhooks/stripe",
    });
  }

  // --- audit export + summary (W4 routes, mountAuditRoutes) ----------------
  if (deps.auditDeps !== undefined) {
    mountAuditRoutes(v1, deps.auditDeps, {
      workspacesPath: "/workspaces",
      auditPath: "/audit",
    });
  }

  // Placeholder so unmounted §13.1 paths answer with a typed 501 instead of a
  // bare 404 while waves are landing. Must stay AFTER all concrete mounts.
  v1.route("/", notImplemented());

  app.route("/v1", v1);
}
