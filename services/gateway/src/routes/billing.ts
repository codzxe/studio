// @studio/gateway — billing (§7.2, §10.3): Stripe Checkout / Portal / webhooks.
//
// When the Stripe envs are absent (local without a key) the routes return a
// typed VALIDATION_FAILED with the "not configured in this environment" hint
// instead of a raw SDK error. With keys present the real Stripe SDK is used
// (stripe ^23; the seam in context.ts keeps the SDK out of tests).
//
// Webhook: signature-verified, idempotent per event id; checkout.session.completed
// grants the monthly/pack credits onto the workspace ledger (§8.8).

import { Hono } from "hono";

import { CHECKOUT_SCHEMA, PORTAL_SCHEMA, type CheckoutResponse, type PortalResponse } from "@studio/contracts";

import { StudioError } from "@studio/config";
import { can } from "@studio/db";

import { ok } from "../http.js";
import { GatewayError } from "../errors.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { PLAN_MONTHLY_CREDITS } from "./credits.js";
import { audit } from "./projects.js";
import type { AppBindings, AppContext, GatewayDeps, StripeEventLike } from "../context.js";

export function billingRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/billing/*", requireAuth());

  function requireStripe(c: AppContext): NonNullable<GatewayDeps["stripe"]> {
    if (deps.stripe === null || deps.env.stripe.secretKey === undefined) {
      throw new StudioError("VALIDATION_FAILED", {
        hint: "billing not configured in this environment",
        requestId: c.get("requestId"),
      });
    }
    return deps.stripe;
  }

  app.post("/v1/billing/checkout", requireWorkspace("admin"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    if (!can(workspace.role, "manageBilling")) {
      throw new StudioError("FORBIDDEN", { requestId: c.get("requestId") });
    }
    const stripe = requireStripe(c);
    const parsed = CHECKOUT_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
    }
    const base = deps.env.app.url.replace(/\/+$/, "");

    if (parsed.data.planId !== undefined) {
      const planId = parsed.data.planId;
      const priceId = deps.env.stripe.priceIds[planId];
      if (priceId === undefined) {
        throw new GatewayError("VALIDATION_FAILED", "Unknown plan for this environment.", {
          status: 400,
          hint: "The STRIPE_PRICE_IDS map has no price for that plan.",
          requestId: c.get("requestId"),
        });
      }
      const session = await stripe.checkout({
        mode: "subscription",
        priceId,
        customerEmail: c.get("auth").user.email,
        successUrl: `${base}/billing?checkout=success`,
        cancelUrl: `${base}/billing?checkout=cancelled`,
        metadata: {
          organizationId: workspace.id,
          kind: "subscription",
          planId,
          credits: String(PLAN_MONTHLY_CREDITS[planId] ?? 0),
        },
      });
      const body: CheckoutResponse = { sessionId: session.id, url: session.url };
      return ok(c, body, 201);
    }

    // Credit pack (one-time payment).
    const packId = parsed.data.packId as string;
    const priceId = deps.env.stripe.priceIds[`pack:${packId}`] ?? deps.env.stripe.priceIds[packId];
    if (priceId === undefined) {
      throw new GatewayError("VALIDATION_FAILED", "Unknown credit pack for this environment.", {
        status: 400,
        hint: "The STRIPE_PRICE_IDS map has no price for that pack.",
        requestId: c.get("requestId"),
      });
    }
    const session = await stripe.checkout({
      mode: "payment",
      priceId,
      customerEmail: c.get("auth").user.email,
      successUrl: `${base}/billing?checkout=success`,
      cancelUrl: `${base}/billing?checkout=cancelled`,
      metadata: {
        organizationId: workspace.id,
        kind: "pack",
        packId,
        credits: String(deps.env.stripe.priceIds[`${packId}:credits`] ?? 0),
      },
    });
    const body: CheckoutResponse = { sessionId: session.id, url: session.url };
    return ok(c, body, 201);
  });

  app.post("/v1/billing/portal", requireWorkspace("admin"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    if (!can(workspace.role, "manageBilling")) {
      throw new StudioError("FORBIDDEN", { requestId: c.get("requestId") });
    }
    const stripe = requireStripe(c);
    const parsed = PORTAL_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
    }
    const base = deps.env.app.url.replace(/\/+$/, "");

    // Customer id rides in the better-auth org metadata (JSON text).
    const metadata = parseOrgMetadata(workspace.organization.metadata);
    const rawCustomerId = metadata.stripeCustomerId;
    let customerId: string = typeof rawCustomerId === "string" && rawCustomerId !== "" ? rawCustomerId : "";
    if (customerId === "") {
      const customer = await stripe.createCustomer({
        email: c.get("auth").user.email,
        metadata: { organizationId: workspace.id },
      });
      customerId = customer.id;
      await deps.auth.updateWorkspace(c.req.raw.headers, {
        organizationId: workspace.id,
        data: { metadata: JSON.stringify({ ...metadata, stripeCustomerId: customerId }) },
      });
    }

    const session = await stripe.portal({
      customerId,
      returnUrl: parsed.data.returnUrl ?? `${base}/billing`,
    });
    const body: PortalResponse = { url: session.url };
    return ok(c, body);
  });

  // Stripe webhook: raw body + signature verification (§10.3). The route is
  // excluded from idempotency-key middleware (events carry their own ids).
  app.post("/v1/webhooks/stripe", async (c: AppContext): Promise<Response> => {
    const stripe = deps.stripe;
    if (stripe === null) {
      throw new StudioError("VALIDATION_FAILED", {
        hint: "billing not configured in this environment",
        requestId: c.get("requestId"),
      });
    }
    const payload = Buffer.from(await c.req.arrayBuffer());
    const verified = stripe.verifyWebhook(payload, c.req.header("stripe-signature") ?? null);
    if (!verified.ok) {
      throw new GatewayError("VALIDATION_FAILED", "Webhook signature verification failed.", {
        status: 400,
        requestId: c.get("requestId"),
      });
    }
    const event = verified.event;
    if (stripe.seenEvent(event.id)) {
      return ok(c, { received: true, duplicate: true });
    }

    if (event.type === "checkout.session.completed") {
      const object = event.data.object;
      const organizationId = object.metadata?.organizationId;
      const credits = Number.parseInt(object.metadata?.credits ?? "0", 10);
      if (organizationId !== undefined && Number.isInteger(credits) && credits > 0) {
        await deps.repos.ledger.grant(organizationId, {
          amount: credits,
          idempotencyKey: `stripe:${event.id}`,
          metadata: { stripeEventId: event.id, kind: object.metadata?.kind ?? "unknown" },
        });
      }
    }
    return ok(c, { received: true });
  });

  return app;
}

function parseOrgMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type { StripeEventLike };
