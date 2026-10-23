// @studio/gateway — billing (§7.2, §10.3): Stripe Checkout (subscription +
// top-up), the customer portal, the ONE billing-state read the UI consumes,
// the card-required trial start, and the signature-verified webhook.
//
// M6 (BUILD_PLAN §M6 tasks 2-3+5) on the landed seams — the M6-B StripeSeam
// (typed StripeSeamResult boundary, injectable in tests via tests/helpers/
// fake-stripe.ts) and the M6-D billing repos (subscriptions.transitionStatus
// guarded updates, invoices.record idempotent, webhookEvents.seenOrRecord
// durable dedup). Binding rulings encoded here:
//  - D-4: trial is a subscription STATE on the Starter row, never a checkout
//    target — the checkout schema union IS the pricing-page display list.
//  - D-12: every ledger amount is integer MICROcredits; pack metadata carries
//    µc and the webhook grants exactly that integer.
//  - Law #4: POST /v1/billing/* mutations are idempotent through the
//    Idempotency-Key middleware (§7.2 — the client attaches the header); the
//    webhook carries its own event ids, deduped DURABLE FIRST
//    (webhookEvents.seenOrRecord) layered BEFORE the seam's in-memory
//    seenEvent.
//  - BP §M6 task 2: lifecycle webhooks only ever write SUBSCRIPTION state —
//    cancellation is status-only; projects, versions and ledger rows are
//    never touched from the webhook.
//  - BP §M6 task 5 abuse rules on POST /v1/billing/trial: one trial per
//    workspace (any prior subscription row), one trial per card (fingerprint,
//    cross-workspace), no trials for disposable email domains (frozen default
//    blocklist + STRIPE_BLOCKED_TRIAL_DOMAINS — see the note below), and a
//    payment method is REQUIRED (the workspace's Stripe customer must carry a
//    registered card fingerprint; the fake harness models the fingerprint via
//    checkout metadata, real Stripe enforces the card at Checkout).

import { Hono } from "hono";

import {
  type BillingState,
  CHECKOUT_SCHEMA,
  type CheckoutResponse,
  INVOICES_QUERY_SCHEMA,
  type InvoiceRecord,
  PORTAL_SCHEMA,
  type PortalResponse,
  TOPUP_SCHEMA,
  TOP_UP_PACKS,
  TRIAL_REQUEST_SCHEMA,
  type TopUpPackId,
  type TrialResponse,
} from "@studio/contracts";

import {
  PLAN_CATALOG,
  PRICING_PAGE_PLANS,
  type PaidPlanId,
  type PlanId,
  type StripePriceIdLookup,
  type StudioEnv,
  StudioError,
  creditsToMicrocredits,
  entitlementsFor,
  isPlausiblePlanId,
  stripePriceIdFor,
} from "@studio/config";

import { type Repos, type SubscriptionStatus, can, isDbError } from "@studio/db";

import type {
  AppBindings,
  AppContext,
  GatewayDeps,
  StripeEventLike,
  StripeSeam,
  WorkspaceContext,
} from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { effectivePlan, installSubscriptionReader } from "../plan.js";
import { outstandingReserveForWorkspace } from "./credits.js";

/**
 * The transition-input shape, DERIVED from the repo's pinned signature
 * (M6-D keeps repo input types off the package root — the documented M5-D
 * deep-import note; deriving from Parameters keeps this drift-proof).
 */
type SubscriptionTransitionInput = Parameters<Repos["subscriptions"]["transitionStatus"]>[1];

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

/**
 * credit_ledger.amount is a drizzle `integer` (int32) today; M6-A flagged the
 * Studio monthly allowance (10B µc) as over-range until the column moves to
 * bigint. Webhook grants parsed from external metadata are range-checked
 * against this ceiling — a hostile amount is audited-ignored, never a 500
 * that would make Stripe retry the poison forever.
 */
const MAX_LEDGER_AMOUNT = 2_147_483_647;

/**
 * Past-due dunning window (§M6 task 2 "grace period"). The M6-B fake harness
 * cancels a failing subscription at currentPeriodEnd + 30d — the same
 * boundary, so `graceEnd` lines up with the harness's deterministic clock.
 */
const GRACE_PERIOD_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Frozen default disposable-domain blocklist (BP §M6 task 5). Deployment
 * additions come from STRIPE_BLOCKED_TRIAL_DOMAINS, read from process.env
 * DIRECTLY with validation (the var is intentionally NOT added to the shared
 * env schema — env.ts is outside this task's ownership, law #12); the env var
 * EXTENDS the frozen list, never bypasses it.
 */
const DEFAULT_BLOCKED_TRIAL_DOMAINS: readonly string[] = Object.freeze([
  "mailinator.com",
  "10minutemail.com",
  "guerrillamail.com",
  "temp-mail.org",
  "tempmail.email",
  "yopmail.com",
  "throwawaymail.com",
  "sharklasers.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "trashmail.com",
]);

/** Validated deployment extension of the trial-domain blocklist. */
function blockedTrialDomains(envValue: string | undefined): ReadonlySet<string> {
  const blocked = new Set<string>(DEFAULT_BLOCKED_TRIAL_DOMAINS);
  if (typeof envValue !== "string" || envValue.trim().length === 0) return blocked;
  for (const raw of envValue.split(",")) {
    const domain = raw.trim().toLowerCase();
    // Strict domain grammar; anything else is ignored, never a crash.
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      blocked.add(domain);
    }
  }
  return blocked;
}

/** The part after the last "@", lowercased — null when absent/degenerate. */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

// ───────────────────────────────────────────────────────────────────────────
// Top-up packs (BP §M6 task 2) — the wire catalog is TOP_UP_PACKS in
// @studio/contracts; this map adds each pack's STRIPE_PRICE_IDS env key.
// BUSINESS-PENDING: pack volumes (100/500/2000) are the M6 pick; the prices
// live in Stripe, never in this repo.
// ───────────────────────────────────────────────────────────────────────────

interface CreditPackDescriptor {
  readonly packId: TopUpPackId;
  /** Whole display credits; µc at the ledger via creditsToMicrocredits (D-12). */
  readonly credits: number;
  /** Key into the STRIPE_PRICE_IDS env map (env.ts documents the JSON shape). */
  readonly stripePriceKey: string;
}

const PACK_PRICE_KEYS: Readonly<Record<TopUpPackId, string>> = Object.freeze({
  credits100: "pack:credits100",
  credits500: "pack:credits500",
  credits2000: "pack:credits2000",
});

/** Resolves a wire pack id to its full descriptor (single source: contracts). */
function packDescriptor(packId: string): CreditPackDescriptor | null {
  const pack = TOP_UP_PACKS.find((entry) => entry.packId === packId);
  if (pack === undefined) return null;
  return {
    packId: pack.packId,
    credits: pack.credits,
    stripePriceKey: PACK_PRICE_KEYS[pack.packId],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────────────

/** Stub boots wire fake repos without the billing tables; absence degrades to
 * typed empty behavior — never a crash (the M5-O structural-guard precedent). */
function subscriptionsRepo(repos: Repos): Repos["subscriptions"] | null {
  const candidate = (repos as Repos & { subscriptions?: Repos["subscriptions"] }).subscriptions;
  if (candidate === undefined || typeof candidate.getByOrganization !== "function") return null;
  return candidate;
}

function invoicesRepo(repos: Repos): Repos["invoices"] | null {
  const candidate = (repos as Repos & { invoices?: Repos["invoices"] }).invoices;
  if (candidate === undefined || typeof candidate.record !== "function") return null;
  return candidate;
}

function webhookEventsRepo(repos: Repos): Repos["webhookEvents"] | null {
  const candidate = (repos as Repos & { webhookEvents?: Repos["webhookEvents"] }).webhookEvents;
  if (candidate === undefined || typeof candidate.seenOrRecord !== "function") return null;
  return candidate;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Unix seconds → Date; null for absent/non-positive values. */
function toDate(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

function toIso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The old pre-M6 seam kept the customer id in the better-auth org metadata —
 * adopted into the durable repo row on first touch (read-only migration). */
function parseOrgMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Plan rank for the downgrade rule: trial < starter < pro < studio. */
function planRank(planId: string): number {
  const index = (PRICING_PAGE_PLANS as readonly string[]).indexOf(planId);
  return index === -1 ? -1 : index;
}

// ───────────────────────────────────────────────────────────────────────
// Seat counting (M6 enforcement; W1-e) — shared by the checkout pre-check
// below and the invites route (the sibling gate, AUD-3 gap 3a)
// ───────────────────────────────────────────────────────────────────────

/**
 * NON-EXPIRED PENDING invites for one workspace — the half-open seat
 * reservations an admin created but nobody accepted yet (better-auth
 * `invitation` rows; accepted/rejected/canceled/expired rows never count).
 *
 * SEAM NOTE: the typed GatewayAuth surface (auth.ts) exposes only
 * inviteMember/acceptInvitation — there is no listInvitations member, and
 * auth.ts is outside this wave's ownership (law #12). The count therefore
 * rides the seam's RAW `handler` member — the exact better-auth HTTP
 * surface app.ts mounts at `/v1/auth/*`, called in-process with the
 * caller's forwarded session headers (GET /organization/list-invitations,
 * membership-checked by the org plugin itself). The response is parsed
 * defensively: anything that is not a JSON array of invitation-shaped rows
 * counts as ZERO pending — fail-open, never a crash (the members count
 * alone still enforces the hard floor; the gateway logs a warn). When a
 * typed listInvitations seam member lands on GatewayAuth, this function
 * body is the only cleanup (noted in the W1-e worklog).
 */
export async function countPendingInvites(
  deps: GatewayDeps,
  headers: Headers,
  organizationId: string,
): Promise<number> {
  const base = deps.env.app.url.replace(/\/+$/, "");
  const url = `${base}/v1/auth/organization/list-invitations?organizationId=${encodeURIComponent(
    organizationId,
  )}`;
  const forwarded = new Headers();
  // Session + origin only — better-auth needs nothing else on a GET; the
  // wrapping POST's content-length/content-type must not lie about a body.
  for (const name of ["cookie", "authorization", "origin"]) {
    const value = headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  let response: Response;
  try {
    response = await deps.auth.handler(new Request(url, { method: "GET", headers: forwarded }));
  } catch (error) {
    deps.logger.warn("seat_count_auth_unavailable", {
      organizationId,
      detail: error instanceof Error ? error.message : "unknown",
    });
    return 0;
  }
  if (!response.ok) {
    deps.logger.warn("seat_count_auth_rejected", { organizationId, status: response.status });
    return 0;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    deps.logger.warn("seat_count_auth_malformed", { organizationId });
    return 0;
  }
  if (!Array.isArray(body)) {
    // The stub auth handler answers {"ok":true} — no invitation list, so
    // stub-mode tests exercise the members side of the gate only (the
    // DB-gated suite proves the real better-auth pending count).
    return 0;
  }
  const now = Date.now();
  let pending = 0;
  for (const entry of body) {
    if (!isRecord(entry) || entry.status !== "pending") continue;
    const expiresAt = entry.expiresAt;
    const expiry =
      typeof expiresAt === "string" || typeof expiresAt === "number" || expiresAt instanceof Date
        ? new Date(expiresAt).getTime()
        : Number.NaN;
    // An absent/unparseable expiry counts as unexpired (conservative: the
    // gate refuses MORE invites, never fewer); an expired pending row freed
    // its seat (better-auth keeps the row but refuses the accept).
    if (Number.isNaN(expiry) || expiry > now) {
      pending += 1;
    }
  }
  return pending;
}

// ───────────────────────────────────────────────────────────────────────────
// Webhook state mapping (§M6 task 2 lifecycle)
// ───────────────────────────────────────────────────────────────────────────

/** Stripe subscription status → the persisted SubscriptionStatus (D-4: unpaid
 * dunning continues as `grace`; unknown statuses never grant entitlements). */
function mapStripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "grace";
    case "incomplete":
      return "incomplete";
    default:
      // canceled | incomplete_expired | paused | unknown — terminal, never grants.
      return "canceled";
  }
}

/**
 * Runtime-narrowed subscription view of an event object. StripeEventLike is
 * deliberately minimal (the seam's structural contract), so the period/price
 * fields are validated HERE before use (law #2: webhook input is external).
 */
interface SubscriptionEventView {
  readonly customer: string | null;
  readonly status: string;
  readonly trialEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: number | null;
  readonly priceId: string | null;
}

function priceIdOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value)) return nonEmptyString(value.id);
  return null;
}

function subscriptionViewOf(
  object: StripeEventLike["data"]["object"],
): SubscriptionEventView | null {
  const record = object as unknown as Record<string, unknown>;
  if (!isRecord(record)) return null;
  const status = nonEmptyString(record.status);
  if (status === null) return null;
  let currentPeriodEnd: number | null = null;
  let priceId: string | null = null;
  const items = record.items;
  if (isRecord(items) && Array.isArray(items.data) && items.data.length > 0) {
    const item = items.data[0];
    if (isRecord(item)) {
      const periodEnd = item.current_period_end;
      if (typeof periodEnd === "number" && Number.isFinite(periodEnd)) {
        currentPeriodEnd = periodEnd;
      }
      priceId = priceIdOf(item.price);
    }
  }
  const trialEnd = record.trial_end;
  return {
    customer: nonEmptyString(record.customer),
    status,
    trialEnd: typeof trialEnd === "number" && Number.isFinite(trialEnd) ? trialEnd : null,
    cancelAtPeriodEnd: record.cancel_at_period_end === true,
    currentPeriodEnd,
    priceId,
  };
}

/** Reverse price map (env.stripe.priceIds): price id → the paid plan it sells. */
function planIdFromPrice(env: StudioEnv, priceId: string | null): PaidPlanId | null {
  if (priceId === null) return null;
  for (const plan of PRICING_PAGE_PLANS) {
    if (env.stripe.priceIds[plan] === priceId) return plan;
  }
  return null;
}

/** Workspace attribution for webhook objects: the checkout-stamped metadata. */
function organizationIdOf(object: StripeEventLike["data"]["object"]): string | null {
  return nonEmptyString(object.metadata?.organizationId);
}

/** Plan id from event metadata, narrowed to the catalog union (M6-A helper). */
function planIdFromMetadata(object: StripeEventLike["data"]["object"]): PlanId | null {
  const raw = object.metadata?.planId;
  return typeof raw === "string" && isPlausiblePlanId(raw) ? raw : null;
}

/** Per-event webhook outcome carried on the 200 body (audited, never a 5xx). */
interface WebhookOutcome {
  readonly handled?: string;
  readonly ignored?: string;
}

/** Maps a typed seam failure ({ok:false, code, reason}) to the nearest wire
 * code (law #1: the seam's reason is human-safe; it stays server-side in cause). */
function seamFailure(
  c: AppContext,
  failure: { readonly code: string; readonly reason: string },
): GatewayError {
  const requestId = c.get("requestId");
  const options = { requestId, cause: failure };
  switch (failure.code) {
    case "not_configured":
      return new GatewayError(
        "BILLING_NOT_CONFIGURED",
        "Billing is not configured in this environment.",
        { status: 400, ...options },
      );
    case "not_found":
      return new GatewayError("NOT_FOUND", "That billing object was not found.", {
        status: 404,
        ...options,
      });
    case "invalid_request":
      return new GatewayError("VALIDATION_FAILED", "The billing provider rejected that request.", {
        status: 400,
        ...options,
      });
    default:
      return new GatewayError(
        "SERVICE_UNAVAILABLE",
        "The billing provider is unavailable right now.",
        { status: 503, retryable: true, ...options },
      );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The route factory
// ───────────────────────────────────────────────────────────────────────────

export function billingRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/billing/*", requireAuth());

  // resolvePlan seam wiring (plan.ts): the subscription-row reader is
  // installed at construction time — every request runs after buildApp, so
  // models/chat/credits routes read the REAL plan through resolvePlan.
  const subscriptions = subscriptionsRepo(deps.repos);
  installSubscriptionReader(
    subscriptions === null
      ? undefined
      : (workspaceId: string) => subscriptions.getByOrganization(workspaceId),
  );

  function requireStripe(c: AppContext): NonNullable<GatewayDeps["stripe"]> {
    if (deps.stripe === null || deps.env.stripe.secretKey === undefined) {
      throw new StudioError("VALIDATION_FAILED", {
        hint: "billing not configured in this environment",
        requestId: c.get("requestId"),
      });
    }
    return deps.stripe;
  }

  function requireBillingRole(c: AppContext): WorkspaceContext {
    const workspace = c.get("workspace");
    if (!can(workspace.role, "manageBilling")) {
      throw new StudioError("FORBIDDEN", { requestId: c.get("requestId") });
    }
    return workspace;
  }

  function appBase(): string {
    return deps.env.app.url.replace(/\/+$/, "");
  }

  /**
   * Resolves the workspace's Stripe customer id (the durable repo row first,
   * legacy org-metadata adoption, else creates the customer). The repo row is
   * the source of truth for customer → workspace billing state.
   */
  async function ensureWorkspaceCustomer(
    c: AppContext,
    workspace: WorkspaceContext,
    stripe: StripeSeam,
  ): Promise<string> {
    if (subscriptions !== null) {
      const existing = await subscriptions.findStripeCustomer(workspace.id);
      if (existing !== null && existing.stripeCustomerId !== "") {
        return existing.stripeCustomerId;
      }
    }
    const legacy = parseOrgMetadata(workspace.organization.metadata).stripeCustomerId;
    if (typeof legacy === "string" && legacy !== "") {
      if (subscriptions !== null) {
        await subscriptions.ensureStripeCustomer(workspace.id, { stripeCustomerId: legacy });
      }
      return legacy;
    }
    const customer = await stripe.createCustomer({
      email: c.get("auth").user.email,
      metadata: { organizationId: workspace.id },
    });
    if (subscriptions !== null) {
      await subscriptions.ensureStripeCustomer(workspace.id, { stripeCustomerId: customer.id });
    }
    return customer.id;
  }

  /**
   * Price-id lookup through the M6-A helper (typed problem vocabulary).
   * StudioEnv parses STRIPE_PRICE_IDS into a record at boot; the helper
   * consumes the raw JSON value, so the parsed map is re-serialized here —
   * values are env-validated strings, the round-trip is exact.
   */
  function planPriceId(planId: string): StripePriceIdLookup {
    return stripePriceIdFor(planId, JSON.stringify(deps.env.stripe.priceIds));
  }

  function requirePlanPriceId(c: AppContext, planId: string): string {
    const lookup = planPriceId(planId);
    if (lookup.ok) return lookup.priceId;
    switch (lookup.problem.kind) {
      case "plan-without-price":
        throw new GatewayError(
          "VALIDATION_FAILED",
          "That plan has no price configured in this environment.",
          {
            status: 400,
            hint: "The STRIPE_PRICE_IDS map has no price for that plan.",
            requestId: c.get("requestId"),
          },
        );
      case "unknown-plan":
      case "plan-not-purchasable":
        // Unreachable behind CHECKOUT_SCHEMA (D-4: trial is never a checkout
        // target) — kept fail-closed anyway.
        throw new GatewayError("VALIDATION_FAILED", "That plan is not available for checkout.", {
          status: 400,
          requestId: c.get("requestId"),
        });
      default:
        throw new GatewayError(
          "BILLING_NOT_CONFIGURED",
          "Billing is not configured in this environment.",
          { status: 400, requestId: c.get("requestId"), cause: lookup.problem },
        );
    }
  }

  // ── POST /v1/billing/checkout — plan subscription / plan change ──────────

  app.post(
    "/v1/billing/checkout",
    requireWorkspace("admin"),
    async (c: AppContext): Promise<Response> => {
      const workspace = requireBillingRole(c);
      const stripe = requireStripe(c);
      const parsed = CHECKOUT_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
      }
      const planId = parsed.data.planId;

      // Server-side entitlement pre-checks (§M6 task 1): the target plan must
      // fit the CURRENT workspace shape — checked here, never trusted to the
      // client. Sibling enforcement lives on the invites route
      // (routes/invites.ts: members + pending invites vs the paid plan's
      // seats → 429 SEATS_EXCEEDED); this checkout arm guards the
      // CONVERSION itself and counts pending invites too, so a seat queued
      // behind an unaccepted invite can never land on a plan too small for
      // members + pending combined.
      const entitlements = entitlementsFor(planId);
      const pendingInvites = await countPendingInvites(deps, c.req.raw.headers, workspace.id);
      if (workspace.members.length + pendingInvites > entitlements.seats) {
        throw new GatewayError(
          "VALIDATION_FAILED",
          "This workspace has more members than that plan allows.",
          {
            status: 400,
            hint: "Remove members (or pending invites) before switching to a smaller plan.",
            requestId: c.get("requestId"),
          },
        );
      }

      const priceId = requirePlanPriceId(c, planId);
      const row =
        subscriptions !== null ? await subscriptions.getByOrganization(workspace.id) : null;

      if (row !== null && row.status !== "canceled") {
        // A live subscription: Checkout sessions always create NEW
        // subscriptions, so a plan change goes through subscriptions.update.
        // DOWNGRADES ARE NEVER INSTANT (§M6 task 2): a smaller plan is
        // scheduled at period end from the customer portal (Stripe's native
        // semantics) — current entitlements stay until the period ends.
        if (planRank(planId) < planRank(row.planId)) {
          throw new GatewayError(
            "VALIDATION_FAILED",
            "Downgrades take effect at the end of the current billing period.",
            {
              status: 400,
              hint: "Use the billing portal to schedule a downgrade; your current features stay until the period ends.",
              requestId: c.get("requestId"),
            },
          );
        }
        const customerId = await ensureWorkspaceCustomer(c, workspace, stripe);
        const updated = await stripe.updateSubscription(customerId, { planPriceKey: priceId });
        if (!updated.ok) {
          throw seamFailure(c, updated);
        }
        // Same-plan/upgrade swaps only ever GROW entitlements, so pin the row
        // immediately; the ensuing customer.subscription.updated webhook
        // re-pins idempotently through the guarded transition.
        if (subscriptions !== null) {
          await subscriptions.upsertState(workspace.id, {
            planId,
            status: mapStripeStatus(updated.data.status),
            stripeSubscriptionId: updated.data.subscriptionId,
            currentPeriodEnd: toDate(updated.data.currentPeriodEnd),
            trialEnd: toDate(updated.data.trialEnd ?? null),
            cancelAtPeriodEnd: updated.data.cancelAtPeriodEnd,
          });
        }
        const body: CheckoutResponse = { sessionId: "", url: "", planChanged: true };
        return ok(c, body);
      }

      // No live subscription (never subscribed, or canceled): hosted Checkout.
      const customerId = await ensureWorkspaceCustomer(c, workspace, stripe);
      const session = await stripe.checkout({
        mode: "subscription",
        priceId,
        customerId,
        customerEmail: c.get("auth").user.email,
        successUrl: `${appBase()}/billing?checkout=success`,
        cancelUrl: `${appBase()}/billing?checkout=cancelled`,
        metadata: {
          organizationId: workspace.id,
          kind: "subscription",
          planId,
        },
      });
      const body: CheckoutResponse = { sessionId: session.id, url: session.url };
      return ok(c, body, 201);
    },
  );

  // ── POST /v1/billing/topup — one-time-payment credit pack ─────────────────

  app.post(
    "/v1/billing/topup",
    requireWorkspace("admin"),
    async (c: AppContext): Promise<Response> => {
      const workspace = requireBillingRole(c);
      const stripe = requireStripe(c);
      const parsed = TOPUP_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
      }
      const pack = packDescriptor(parsed.data.packId);
      if (pack === null) {
        throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
      }
      const priceId = deps.env.stripe.priceIds[pack.stripePriceKey];
      if (typeof priceId !== "string" || priceId === "") {
        throw new GatewayError(
          "VALIDATION_FAILED",
          "That credit pack is not available in this environment.",
          {
            status: 400,
            hint: "The STRIPE_PRICE_IDS map has no price for the pack.",
            requestId: c.get("requestId"),
          },
        );
      }

      // D-12: pack credits convert to integer microcredits ONCE, here — the
      // checkout metadata carries µc and the webhook grants exactly that.
      const microcredits = creditsToMicrocredits(pack.credits);
      const customerId = await ensureWorkspaceCustomer(c, workspace, stripe);
      // M6-B seam: topUpCheckout takes the resolved Stripe PRICE id directly.
      const session = await stripe.topUpCheckout({
        packId: priceId,
        quantity: 1,
        customerId,
        customerEmail: c.get("auth").user.email,
        successUrl: `${appBase()}/billing?checkout=success`,
        cancelUrl: `${appBase()}/billing?checkout=cancelled`,
        metadata: {
          organizationId: workspace.id,
          kind: "topup",
          packId: pack.packId,
          microcredits: String(microcredits),
        },
      });
      if (!session.ok) {
        throw seamFailure(c, session);
      }
      const body: CheckoutResponse = { sessionId: session.data.id, url: session.data.url };
      return ok(c, body, 201);
    },
  );

  // ── POST /v1/billing/portal — Stripe customer portal session ─────────────

  app.post(
    "/v1/billing/portal",
    requireWorkspace("admin"),
    async (c: AppContext): Promise<Response> => {
      const workspace = requireBillingRole(c);
      const stripe = requireStripe(c);
      const parsed = PORTAL_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
      }
      const customerId = await ensureWorkspaceCustomer(c, workspace, stripe);
      const session = await stripe.portal({
        customerId,
        returnUrl: parsed.data.returnUrl ?? `${appBase()}/billing`,
      });
      const body: PortalResponse = { url: session.url };
      return ok(c, body);
    },
  );

  // ── GET /v1/billing/state — the ONE billing read the UI consumes ────────

  app.get(
    "/v1/billing/state",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspaceId = c.get("workspace").id;
      const row =
        subscriptions !== null ? await subscriptions.getByOrganization(workspaceId) : null;
      // D-4: the EFFECTIVE plan (a trialing row gates as the trial catalog
      // tier); entitlements always come from the catalog, never hardcoded.
      const plan = effectivePlan(row);
      const catalogEntitlements = entitlementsFor(plan);
      const balance = await deps.repos.ledger.balance(workspaceId);
      const reserved = await outstandingReserveForWorkspace(deps, workspaceId);

      const body: BillingState = {
        plan,
        status: row?.status ?? "none",
        currentPeriodEnd: toIso(row?.currentPeriodEnd ?? null),
        trialEnd: toIso(row?.trialEnd ?? null),
        cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
        graceEnd: toIso(row?.graceEnd ?? null),
        entitlements: {
          seats: catalogEntitlements.seats,
          models: [...catalogEntitlements.models],
          maxProjects: catalogEntitlements.maxProjects,
          storageBytes: catalogEntitlements.storageBytes,
          renderMinutesPerMonth: catalogEntitlements.renderMinutesPerMonth,
          monthlyCreditAllowance: catalogEntitlements.monthlyCreditAllowance,
        },
        // Raw ledger numbers in µc — the same units as GET /v1/credits (D-12).
        credits: { balance, reserved },
        topUpPacks: TOP_UP_PACKS.map((pack) => ({ packId: pack.packId, credits: pack.credits })),
      };
      return ok(c, body);
    },
  );

  // ── GET /v1/billing/invoices — the recorded invoice history (F-J3) ─────
  //
  // The §M6 wire read for the invoices the webhook persists (invoice.paid /
  // invoice.voided → repos.invoices.record, M6-D): newest-first,
  // cursor-paginated, workspace-scoped (law #3 — cross-tenant rows are never
  // visible, a stranger's list is simply empty). `viewer` is the member floor:
  // every workspace member can read their billing history; no money moves on
  // a GET. `amountCents` is MONEY in Stripe minor units, never credits (D-12
  // keeps the credit ledger in its own µc domain).
  app.get(
    "/v1/billing/invoices",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const parsed = INVOICES_QUERY_SCHEMA.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Check the pagination parameters.",
          requestId: c.get("requestId"),
        });
      }
      const invoices = invoicesRepo(deps.repos);
      if (invoices === null) {
        throw new GatewayError("SERVICE_UNAVAILABLE", "The database is not reachable right now.", {
          status: 503,
          retryable: true,
          hint: "Invoice history needs billing persistence. Try again once the database is up.",
          requestId: c.get("requestId"),
        });
      }
      const result = await invoices.list(c.get("workspace").id, {
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      const rows: InvoiceRecord[] = result.items.map((invoice) => ({
        id: invoice.id,
        stripeInvoiceId: invoice.stripeInvoiceId,
        amountCents: invoice.amountCents,
        currency: invoice.currency,
        status: invoice.status,
        periodStart: toIso(invoice.periodStart),
        periodEnd: toIso(invoice.periodEnd),
        hostedUrl: invoice.hostedUrl,
        pdfUrl: invoice.pdfUrl,
        createdAt: invoice.createdAt.toISOString(),
      }));
      return page(c, rows, result.nextCursor);
    },
  );

  // ── POST /v1/billing/trial — card-required trial start (§M6 task 5) ─────

  app.post(
    "/v1/billing/trial",
    requireWorkspace("admin"),
    async (c: AppContext): Promise<Response> => {
      const workspace = requireBillingRole(c);
      const parsed = TRIAL_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
      }
      if (subscriptions === null) {
        throw new GatewayError("SERVICE_UNAVAILABLE", "The database is not reachable right now.", {
          status: 503,
          retryable: true,
          hint: "Trial state needs billing persistence. Try again once the database is up.",
          requestId: c.get("requestId"),
        });
      }
      const workspaceId = workspace.id;
      const requestId = c.get("requestId");

      // (1) One trial per workspace: ANY prior subscription row — including a
      // canceled one — means the workspace already spent its trial.
      const existing = await subscriptions.getByOrganization(workspaceId);
      if (existing !== null) {
        throw new GatewayError("CONFLICT", "This workspace already has a billing history.", {
          status: 409,
          hint: "Trials are limited to one per workspace. Choose a plan instead.",
          requestId,
        });
      }

      // (2) Card required (§M6 exit criteria): the workspace's Stripe customer
      // must carry a registered payment-method fingerprint. The fake harness
      // models the fingerprint via checkout metadata; real Stripe enforces the
      // card at Checkout and the fingerprint lands here through the webhook.
      const customer = await subscriptions.findStripeCustomer(workspaceId);
      const fingerprint = nonEmptyString(customer?.cardFingerprint);
      if (customer === null || fingerprint === null) {
        throw new GatewayError(
          "VALIDATION_FAILED",
          "A payment method is required to start a trial.",
          {
            status: 400,
            hint: "Add a card first. The trial starts immediately and is not charged for its duration.",
            requestId,
          },
        );
      }

      // (3) One trial per card — cross-workspace by design (M6-D repo).
      const usedBy = await subscriptions.cardFingerprintUsed(fingerprint);
      if (usedBy !== null && usedBy.organizationId !== workspaceId) {
        throw new GatewayError("FORBIDDEN", "That payment method already started a trial.", {
          status: 403,
          hint: "Trials are limited to one per payment method.",
          requestId,
        });
      }

      // (4) Disposable-domain blocklist (frozen defaults + validated env
      // extension). A degenerate email fails closed.
      const domain = emailDomain(c.get("auth").user.email);
      if (
        domain === null ||
        blockedTrialDomains(process.env.STRIPE_BLOCKED_TRIAL_DOMAINS).has(domain)
      ) {
        throw new GatewayError(
          "VALIDATION_FAILED",
          "A trial can't be started for that email address.",
          {
            status: 400,
            hint: "Use a permanent email address to start a trial.",
            requestId,
          },
        );
      }

      // D-4: the trial state lives on the STARTER row, trialEnd from the
      // M6-A catalog. The card is never charged by this route.
      const trialDays = PLAN_CATALOG.trial.trialDays ?? 14;
      const trialEnd = new Date(Date.now() + trialDays * DAY_MS);
      await subscriptions.upsertState(workspaceId, {
        planId: "starter",
        status: "trialing",
        stripeSubscriptionId: null,
        currentPeriodEnd: trialEnd,
        trialEnd,
        cancelAtPeriodEnd: false,
      });
      const body: TrialResponse = { trialStarted: true, trialEnd: trialEnd.toISOString() };
      return ok(c, body, 201);
    },
  );

  // ── POST /v1/webhooks/stripe — signature + durable idempotency + switch ──
  //
  // Excluded from the Idempotency-Key middleware (events carry their own ids).
  // Law #4 layering: the M6-D webhookEvents repo (durable, restart-safe,
  // race-arbitrated by the UNIQUE index) guards FIRST; the seam's in-memory
  // seenEvent set layers after it as the fast path.

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
        cause: verified.reason,
      });
    }
    const event = verified.event;

    const webhookEvents = webhookEventsRepo(deps.repos);
    if (webhookEvents !== null) {
      const durable = await webhookEvents.seenOrRecord("stripe", event.id, {
        type: event.type,
        payload: event,
      });
      if (durable.seen) {
        return ok(c, { received: true, duplicate: true });
      }
    }
    if (stripe.seenEvent(event.id)) {
      return ok(c, { received: true, duplicate: true });
    }

    const outcome = await handleStripeEvent(stripe, event);
    return ok(c, { received: true, ...outcome });
  });

  // ── the typed event switch (§M6 task 2 lifecycle) ─────────────────────────

  /**
   * Guarded transition wrapper (law #4: never double-apply). The repo's
   * UPDATE re-checks `status IN from` — the racing/stale delivery loses with
   * a typed CONFLICT, reported here as "guarded", never an error: a stale
   * webhook is still a DELIVERED webhook (Stripe must see 2xx, not a retry loop).
   */
  async function guardedTransition(
    organizationId: string,
    input: SubscriptionTransitionInput,
  ): Promise<boolean> {
    if (subscriptions === null) return false;
    try {
      await subscriptions.transitionStatus(organizationId, input);
      return true;
    } catch (error) {
      if (isDbError(error) && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) {
        return false;
      }
      throw error;
    }
  }

  /** Ledger grant for a top-up from external µc metadata (D-12 + int32 ceiling). */
  async function grantTopUp(
    organizationId: string,
    event: StripeEventLike,
    metadata: Record<string, string> | null | undefined,
    idempotencyKey: string,
  ): Promise<boolean> {
    const raw = metadata?.microcredits;
    if (typeof raw !== "string" || raw === "") return false;
    const microcredits = Number.parseInt(raw, 10);
    if (!Number.isInteger(microcredits) || microcredits <= 0 || microcredits > MAX_LEDGER_AMOUNT) {
      // Hostile/overflowing amounts are audited-ignored — never a poison retry.
      return false;
    }
    await deps.repos.ledger.grant(organizationId, {
      amount: microcredits,
      idempotencyKey,
      metadata: {
        stripeEventId: event.id,
        kind: "topup",
        packId: metadata?.packId ?? null,
      },
    });
    return true;
  }

  /** Records a Stripe customer + card fingerprint from a verified event. */
  async function recordCustomer(
    organizationId: string,
    object: StripeEventLike["data"]["object"],
  ): Promise<void> {
    const customerId = nonEmptyString(object.customer);
    if (subscriptions === null || customerId === null) return;
    const fingerprint = nonEmptyString(object.metadata?.cardFingerprint);
    await subscriptions.ensureStripeCustomer(organizationId, {
      stripeCustomerId: customerId,
      ...(fingerprint !== null ? { cardFingerprint: fingerprint } : {}),
    });
  }

  /** Minimal event objects: resync the current view from the provider. */
  async function resyncView(
    stripe: StripeSeam,
    customer: string,
  ): Promise<SubscriptionEventView | null> {
    const snapshot = await stripe.subscription(customer);
    if (!snapshot.ok) return null;
    return {
      customer,
      status: snapshot.data.status,
      trialEnd: snapshot.data.trialEnd ?? null,
      cancelAtPeriodEnd: snapshot.data.cancelAtPeriodEnd,
      currentPeriodEnd: snapshot.data.currentPeriodEnd,
      priceId: snapshot.data.priceId,
    };
  }

  async function handleCheckoutCompleted(
    stripe: StripeSeam,
    event: StripeEventLike,
  ): Promise<WebhookOutcome> {
    const object = event.data.object;
    const organizationId = organizationIdOf(object);
    if (organizationId === null) return { ignored: "unattributed" };

    // Customer + payment-method bookkeeping (§M6 task 5): the repo is the
    // durable customer mapping; cardFingerprint metadata is the fake's card
    // model (real Stripe attaches the fingerprint with the payment method).
    await recordCustomer(organizationId, object);

    const kind = object.metadata?.kind ?? null;
    if (kind === "topup") {
      const granted = await grantTopUp(
        organizationId,
        event,
        object.metadata,
        `stripe:${event.id}`,
      );
      return granted ? { handled: "topup.granted" } : { ignored: "topup.amount-invalid" };
    }
    if (kind !== "subscription") {
      return { ignored: "unknown-kind" };
    }

    // The session object carries no period data — resync the canonical
    // snapshot from the provider (D-4: the trial status rides on the sub).
    const customer = nonEmptyString(object.customer);
    if (customer === null) return { ignored: "no-customer" };
    const snapshot = await stripe.subscription(customer);
    if (!snapshot.ok) return { ignored: "subscription-unavailable" };
    const planId = planIdFromMetadata(object) ?? planIdFromPrice(deps.env, snapshot.data.priceId);
    if (planId === null) return { ignored: "unknown-plan" };
    if (subscriptions !== null) {
      // First row (or resubscription): upsert is race-proof on the unique
      // organization_id — concurrent completions converge on one row.
      await subscriptions.upsertState(organizationId, {
        planId,
        status: mapStripeStatus(snapshot.data.status),
        stripeSubscriptionId: snapshot.data.subscriptionId,
        currentPeriodEnd: toDate(snapshot.data.currentPeriodEnd),
        trialEnd: toDate(snapshot.data.trialEnd ?? null),
        cancelAtPeriodEnd: snapshot.data.cancelAtPeriodEnd,
      });
    }
    return { handled: "subscription.synced" };
  }

  /**
   * Shared guarded-transition driver for subscription lifecycle events
   * (customer.subscription.updated/deleted). The event's object is the
   * HISTORICAL truth (webhooks replay history); minimal objects resync from
   * the provider.
   */
  async function applySubscriptionTransition(
    stripe: StripeSeam,
    event: StripeEventLike,
    forcedTarget?: SubscriptionStatus,
  ): Promise<WebhookOutcome> {
    const object = event.data.object;
    const organizationId = organizationIdOf(object);
    if (organizationId === null) return { ignored: "unattributed" };
    if (subscriptions === null) return { ignored: "no-persistence" };

    let view = subscriptionViewOf(object);
    if (view === null || view.currentPeriodEnd === null) {
      const customer = view?.customer ?? nonEmptyString(object.customer);
      if (customer !== null) {
        view = await resyncView(stripe, customer);
      }
    }
    if (view === null) return { ignored: "unparsable" };
    const target = forcedTarget ?? mapStripeStatus(view.status);

    const row = await subscriptions.getByOrganization(organizationId);
    if (row === null) {
      // A subscription event for a workspace we never tracked: attribution
      // exists (metadata) but there is no state to transition — audited.
      return { ignored: "no-subscription" };
    }

    // From-lists (the guarded state machine; heals land via invoice.paid):
    //  active   ← trialing | active | incomplete   (trial conversion, renewal)
    //  grace    ← active | grace | past_due | incomplete (past-due dunning)
    //  canceled ← any live state (BP §M6.2: status only — NO work deletion)
    //  trialing ← trialing | incomplete (idempotent re-pin)
    //  incomplete ← trialing | active | incomplete
    //  past_due ← grace (legacy rows only; Stripe past_due maps to grace)
    const FROM_LISTS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
      active: ["trialing", "active", "incomplete"],
      grace: ["active", "grace", "past_due", "incomplete"],
      canceled: ["trialing", "active", "grace", "past_due", "incomplete"],
      trialing: ["trialing", "incomplete"],
      incomplete: ["trialing", "active", "incomplete"],
      past_due: ["grace"],
    };
    const from = FROM_LISTS[target];
    if (!from.includes(row.status)) {
      return { ignored: "transition-guarded" };
    }

    const periodEndMs = view.currentPeriodEnd !== null ? view.currentPeriodEnd * 1000 : null;
    // Never move the period BACKWARDS (an out-of-order renewal must not
    // regress the row), and never write a null over a known period.
    const periodAdvances =
      periodEndMs !== null &&
      (row.currentPeriodEnd === null || periodEndMs >= row.currentPeriodEnd.getTime());

    // Plan pinning (§M6 task 2 "never instant feature loss"): the event's new
    // price only becomes the row's plan when it is an UPGRADE (features grow)
    // or the period actually advanced (the change took effect). A downgrade
    // scheduled at period end keeps the row's plan until then.
    const targetPlan = planIdFromPrice(deps.env, view.priceId) ?? planIdFromMetadata(object);
    const planId =
      targetPlan !== null &&
      target !== "canceled" &&
      (planRank(targetPlan) > planRank(row.planId) || periodAdvances)
        ? targetPlan
        : null;

    const graceEnd =
      target === "grace"
        ? periodEndMs !== null
          ? new Date(periodEndMs + GRACE_PERIOD_DAYS * DAY_MS)
          : undefined
        : target === "active" || target === "canceled"
          ? null
          : undefined;
    const applied = await guardedTransition(organizationId, {
      from,
      to: target,
      ...(planId !== null ? { planId } : {}),
      ...(periodAdvances ? { currentPeriodEnd: new Date(periodEndMs) } : {}),
      ...(view.trialEnd !== null ? { trialEnd: new Date(view.trialEnd * 1000) } : {}),
      ...(graceEnd !== undefined ? { graceEnd } : {}),
      cancelAtPeriodEnd: view.cancelAtPeriodEnd,
    });
    return applied ? { handled: `subscription.${target}` } : { ignored: "transition-guarded" };
  }

  async function handleSubscriptionUpdated(
    stripe: StripeSeam,
    event: StripeEventLike,
  ): Promise<WebhookOutcome> {
    return applySubscriptionTransition(stripe, event);
  }

  async function handleSubscriptionDeleted(
    stripe: StripeSeam,
    event: StripeEventLike,
  ): Promise<WebhookOutcome> {
    // BP §M6.2: cancellation writes STATUS ONLY. Projects, versions and
    // ledger rows are never touched by the webhook — no work deletion, ever.
    return applySubscriptionTransition(stripe, event, "canceled");
  }

  async function handleInvoice(event: StripeEventLike): Promise<WebhookOutcome> {
    const object = event.data.object;
    const organizationId = organizationIdOf(object);
    if (organizationId === null) return { ignored: "unattributed" };
    const invoices = invoicesRepo(deps.repos);
    if (invoices === null) return { ignored: "no-persistence" };

    const record = object as unknown as Record<string, unknown>;
    const invoiceId = nonEmptyString(record.id);
    if (invoiceId === null) return { ignored: "invoice-unparsable" };
    const amountRaw = record.amount_paid ?? record.amount_due;
    const amountCents =
      typeof amountRaw === "number" && Number.isFinite(amountRaw) && amountRaw >= 0
        ? Math.round(amountRaw)
        : 0;
    const currencyRaw = nonEmptyString(record.currency);
    const periodStart = toDate(
      typeof record.period_start === "number" ? record.period_start : null,
    );
    const periodEnd = toDate(typeof record.period_end === "number" ? record.period_end : null);

    const status = event.type === "invoice.paid" ? ("paid" as const) : ("void" as const);
    try {
      await invoices.record(organizationId, {
        stripeInvoiceId: invoiceId,
        amountCents,
        currency: currencyRaw ?? "usd",
        status,
        periodStart,
        periodEnd,
        hostedUrl: nonEmptyString(record.hosted_invoice_url),
        pdfUrl: nonEmptyString(record.invoice_pdf),
      });
    } catch (error) {
      if (isDbError(error) && (error.code === "VALIDATION_FAILED" || error.code === "CONFLICT")) {
        // A foreign/malformed invoice is audited-ignored — never a retry loop.
        return { ignored: "invoice-invalid" };
      }
      throw error;
    }

    if (status !== "paid") {
      return { handled: "invoice.voided" };
    }

    // Top-up grants invoiced outside Checkout (§M6 task 2): keyed on the
    // INVOICE id, so re-deliveries under fresh event ids cannot double-grant.
    let handled = "invoice.paid";
    if (object.metadata?.kind === "topup") {
      const granted = await grantTopUp(
        organizationId,
        event,
        object.metadata,
        `stripe:invoice:${invoiceId}:topup`,
      );
      if (granted) handled = "invoice.topup-granted";
    }

    // Dunning heal (§M6 task 2 trial/renewal lifecycle): a PAID invoice while
    // the row sits in the grace window returns the subscription to active.
    if (subscriptions !== null) {
      const row = await subscriptions.getByOrganization(organizationId);
      if (row !== null && (row.status === "grace" || row.status === "past_due")) {
        const healed = await guardedTransition(organizationId, {
          from: ["grace", "past_due"],
          to: "active",
          ...(periodEnd !== null ? { currentPeriodEnd: periodEnd } : {}),
          graceEnd: null,
        });
        if (healed) handled = "invoice.paid-healed";
      }
    }
    return { handled };
  }

  async function handleStripeEvent(
    stripe: StripeSeam,
    event: StripeEventLike,
  ): Promise<WebhookOutcome> {
    switch (event.type) {
      case "checkout.session.completed":
        return handleCheckoutCompleted(stripe, event);
      case "customer.subscription.updated":
        return handleSubscriptionUpdated(stripe, event);
      case "customer.subscription.deleted":
        return handleSubscriptionDeleted(stripe, event);
      case "invoice.paid":
      case "invoice.voided":
        return handleInvoice(event);
      default:
        // Unknown event types are 200 + audited-ignored: Stripe retries on
        // non-2xx, so an unhandled type must NEVER be a 500.
        return { ignored: "unhandled-type" };
    }
  }

  return app;
}

export type { StripeEventLike };
