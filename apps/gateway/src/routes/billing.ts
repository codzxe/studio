// @studio/gateway — billing routes (W4-N, spec §13.1 / §14.3 / §15.2).
//
//   POST /v1/billing/checkout      owner/admin only (§15.2, ADR-0003 row 8) —
//                                  body { planCode, workspaceId } → session url
//   POST /v1/billing/portal        owner/admin only → portal url
//   GET  /v1/billing/plans         public plan cards (§14.1 pricing)
//   POST /v1/webhooks/stripe       NO auth — raw body passthrough, signature
//                                  verified via constructEvent, idempotent by
//                                  event id (§14.3 / §15.2)
//
// All billing/webhook semantics live in src/services/stripe.ts. This file is
// HTTP only: Zod at the boundary, typed error envelopes via the shared
// error-mapper, and no domain logic. Webhook failures are never leaked to
// callers (§13.3): a bad signature is a typed 400 `invalid_signature`, a
// processing failure is the generic 500 (Stripe retries), and everything else
// answers 2xx so Stripe never retries a no-op.
//
// WIRING (the fleet pattern — mount BEFORE the /v1 catch-all in routes/index):
//   import { mountBillingRoutes } from "./routes/billing.js";
//   mountBillingRoutes(app, deps);            // → /v1/billing + /v1/webhooks/stripe
//   mountBillingRoutes(v1, deps, { billingPath: "/billing", webhookPath: "/webhooks/stripe" });
// deps: StripeBillingService (services/stripe.ts createStripeBillingService —
// NoopStripe for dev, createStripeSdk + createDrizzleBillingDb +
// drizzleWithTransaction + priceMapFromEnv for production) and the auth seam
// reused from routes/workspaces.ts (requireAuth/authed).

import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/error-mapper.js";
import {
  BILLING_PLAN_CODE_SCHEMA,
  StripeWebhookError,
  type StripeBillingService,
  type StripeEvent,
} from "../services/stripe.js";
import type { AppEnv } from "../types.js";
import type { WorkspaceAuth } from "./workspaces.js";

export interface BillingRoutesDeps {
  readonly billing: StripeBillingService;
  /** Reused W4-E auth seam: requireAuth + authed wrapper (WeakMap context). */
  readonly auth: WorkspaceAuth;
}

// ---------------------------------------------------------------------------
// Boundary schemas (§13: Zod at every boundary; ZodError → 422 via mapper)
// ---------------------------------------------------------------------------

const workspaceIdSchema = z.string().trim().min(1).max(200);

/** camelCase per the W4-N task contract (runs.ts precedent; the §13.1
 *  snake_case reconciliation belongs to the API-contract wave). */
const checkoutBodySchema = z
  .object({
    planCode: BILLING_PLAN_CODE_SCHEMA,
    workspaceId: workspaceIdSchema,
  })
  .strict();

const portalBodySchema = z
  .object({
    workspaceId: workspaceIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  const raw = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    throw new AppError(400, "bad_request", "Request body must be a JSON object.", {
      hint: "Send Content-Type: application/json with a JSON object body.",
      retryable: true,
    });
  }
  return raw;
}

/** Typed 503 when a router is mounted without its dependency seams. */
function notConfigured(): Hono<AppEnv> {
  return new Hono<AppEnv>().all("*", (c) =>
    c.json(
      {
        ok: false,
        code: "not_configured",
        message: "This router was mounted without its dependency seams.",
        hint: "Call billingRoutes(deps) with the StripeBillingService and auth seams.",
        retryable: false,
        docs_url: undefined,
        details: undefined
      },
      503
    )
  );
}

// ---------------------------------------------------------------------------
// /v1/billing router
// ---------------------------------------------------------------------------

export function billingRoutes(deps?: BillingRoutesDeps): Hono<AppEnv> {
  if (deps === undefined) {
    return notConfigured();
  }
  const router = new Hono<AppEnv>();
  const { auth, billing } = deps;

  // GET /v1/billing/plans — public plan cards (marketing + billing pages;
  // no auth by design, §14.1 numbers come straight from @studio/config).
  router.get("/plans", (c) => c.json(billing.planCards()));

  // POST /v1/billing/checkout — owner/admin only; returns the session url.
  router.post(
    "/checkout",
    auth.requireAuth,
    auth.authed(async (c, user) => {
      const input = checkoutBodySchema.parse(await readJsonBody(c));
      const session = await billing.createCheckout(user, input);
      return c.json({ ok: true, url: session.url, session_id: session.sessionId });
    })
  );

  // POST /v1/billing/portal — owner/admin only; Stripe-hosted card/plan
  // management (§14.3).
  router.post(
    "/portal",
    auth.requireAuth,
    auth.authed(async (c, user) => {
      const input = portalBodySchema.parse(await readJsonBody(c));
      const portal = await billing.openPortal(user, input);
      return c.json({ ok: true, url: portal.url });
    })
  );

  return router;
}

// ---------------------------------------------------------------------------
// /v1/webhooks/stripe router — NO auth (signature is the authentication)
// ---------------------------------------------------------------------------

export function stripeWebhookRoutes(deps?: BillingRoutesDeps): Hono<AppEnv> {
  if (deps === undefined) {
    return notConfigured();
  }
  const router = new Hono<AppEnv>();
  const billing = deps.billing;

  router.post("/", async (c) => {
    // RAW body passthrough (§15.2): the signature is computed over the exact
    // bytes Stripe sent — never a re-serialized parse.
    const rawBody = await c.req.raw.text();
    const signature = c.req.header("stripe-signature") ?? "";
    let event: StripeEvent;
    try {
      event = billing.verifyWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof StripeWebhookError) {
        // Typed 400; the header itself never reaches logs or the response.
        c.get("logger").warn({ code: error.code }, "stripe_webhook_verification_failed");
        throw new AppError(400, error.code, "Stripe webhook verification failed.", {
          hint: "Check the Stripe-Signature header and the webhook signing secret.",
          retryable: false
        });
      }
      throw error;
    }
    // Processing is idempotent by event id (§14.3): replays and concurrent
    // redeliveries collapse into the duplicate path; unknown events are a
    // logged 200 no-op. A processing failure bubbles as the generic 500 so
    // Stripe retries the delivery.
    const outcome = await billing.handleWebhookEvent(event);
    return c.json({
      ok: true,
      received: true,
      handled: outcome.handled,
      duplicate: outcome.duplicate
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Mount helper (fleet pattern — runs.ts mountRunRoutes)
// ---------------------------------------------------------------------------

/**
 * Wires both billing routers in one call:
 *
 *   mountBillingRoutes(app, deps)          // /v1/billing + /v1/webhooks/stripe
 *   mountBillingRoutes(v1, deps, { billingPath: "/billing",
 *                                  webhookPath: "/webhooks/stripe" })
 *
 * Must be registered BEFORE the /v1 catch-all in routes/index.ts.
 */
export function mountBillingRoutes(
  app: Hono<AppEnv>,
  deps: BillingRoutesDeps,
  options?: { readonly billingPath?: string; readonly webhookPath?: string },
): void {
  const billingPath = options?.billingPath ?? "/v1/billing";
  const webhookPath = options?.webhookPath ?? "/v1/webhooks/stripe";
  app.route(billingPath, billingRoutes(deps));
  app.route(webhookPath, stripeWebhookRoutes(deps));
}
