// @studio/gateway — Stripe seam + billing service (W4-N).
//
// Spec anchors:
//   §13.1  POST /v1/billing/checkout / portal, POST /v1/webhooks/stripe,
//          GET /v1/billing/plans (plan cards)
//   §14.1  plans $30/$60/$120 → 100/250/600 monthly credits; seats 1/3/10,
//          extra seat +$8; credit pack $10 → 100 credits (never expiring)
//   §14.2  rule 6 — idempotency keys everywhere on money paths; the ledger
//          rejects duplicate (key, kind) writes
//   §14.3  Stripe webhooks are the ONLY source of truth for subscription
//          state; checkout covers subscriptions AND credit packs; customer
//          portal for card/plan changes
//   §15.2  webhooks: signature verification + idempotent processing by event
//          id; RBAC enforced server-side (billing:manage, ADR-0003 row 8)
//   §13.3  never leak internal ids / Stripe errors to callers
//
// OWNERSHIP (docs/AGENTS.md): this file owns the Stripe seam for the gateway.
// It defines four injectable seams so tests/dev never need network or the
// Stripe SDK:
//   StripeLike    — constructEvent / createCheckoutSession /
//                   createPortalSession / upsertCustomer. NoopStripe (tests,
//                   dev) and createStripeSdk (production, lazy import of the
//                   `stripe` optional dependency) implement it.
//   BillingDbLike — narrow storage seam over the billing schema (W1-F) plus
//                   the membership role lookup; createDrizzleBillingDb is the
//                   production adapter.
//   LedgerLike    — grant(monthlyCredits) with an idempotency key; the
//                   ledgerFromStore adapter rides @studio/billing's
//                   LedgerStore, whose unique (idempotencyKey, kind) index is
//                   the money-side guard (§14.2 rule 6).
//   WithTransaction — check-then-act webhook idempotency: the event id is
//                   claimed in idempotency_keys (unique (key, scope)) inside
//                   the injected transaction, so a replayed or concurrently
//                   redelivered event applies exactly once.
//
// PLAN CODE NOTE (contract reconciliation): the W4-N wire contract names the
// $30/$60/$120 tiers starter/pro/max (§14.1 sketch, the STRIPE_PRICE_STARTER /
// PRO / MAX env mapping and packages/db's `'starter' | 'pro' | 'max'` schema
// comment), while @studio/config (W1-B) — the pricing single source of truth —
// calls the $120 tier `business` (W1-N: "max is a RUN TIER (§5.2), not a
// plan"). CONFIG_PLAN_BY_CODE below reconciles the two; the config package is
// not touched.

import { PLAN_CATALOG } from "@studio/billing";
import type { LedgerStore } from "@studio/billing";
import {
  CREDIT_PACK,
  CREDIT_PRICE_USD_CENTS,
  err,
  isFailure,
  ok,
  PLANS,
  PLAN_ID_SCHEMA,
  type PlanId,
  type Result,
} from "@studio/config";
import {
  idempotencyKeys,
  member,
  plans,
  subscriptions,
} from "@studio/db";
import type {
  Db,
  IdempotencyKey,
  Plan,
  Subscription,
} from "@studio/db";
import { and, eq } from "drizzle-orm";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { AppError } from "../middleware/error-mapper.js";

// ---------------------------------------------------------------------------
// Plan codes (wire) + config plan ids (§14.1)
// ---------------------------------------------------------------------------

/** §14.1 tiers on the billing wire, plus the one-time credit pack (§14.3). */
export const BILLING_PLAN_CODES = ["starter", "pro", "max", "pack"] as const;
export type BillingPlanCode = (typeof BILLING_PLAN_CODES)[number];

/** Zod boundary schema for plan codes (HTTP bodies and webhook metadata). */
export const BILLING_PLAN_CODE_SCHEMA = z.enum(BILLING_PLAN_CODES);

/** The three subscription tiers (the pack is a one-time checkout, §14.3). */
export type SubscriptionPlanCode = Exclude<BillingPlanCode, "pack">;

/**
 * Wire plan code → @studio/config PlanId. `max` is the W4-N wire name of the
 * $120 tier that config calls `business` (see the header note).
 */
const CONFIG_PLAN_BY_CODE: Readonly<Record<SubscriptionPlanCode, PlanId>> = {
  starter: "starter",
  pro: "pro",
  max: "business",
};

/** Config PlanId → wire plan code (plan cards render `max`, not `business`). */
function wirePlanCode(configId: PlanId): SubscriptionPlanCode {
  return configId === "business" ? "max" : configId;
}

// ---------------------------------------------------------------------------
// Price-id map (plan lookup by price id, §14.3 / W4-N env mapping)
// ---------------------------------------------------------------------------

/**
 * Stripe price ids per product. The W4-N env mapping is
 * STRIPE_PRICE_STARTER / PRO / MAX; the STRIPE_PRICE_PLAN_*_CREDITS names
 * from .env.example (W1-B) are accepted as aliases.
 */
export interface StripePriceMap {
  readonly starter: string;
  readonly pro: string;
  readonly max: string;
  /** One-time credit pack price ($10 → 100 credits) — optional product. */
  readonly pack?: string;
  /** Recurring extra-seat price (+$8/mo) — optional product. */
  readonly seat?: string;
}

/** Parses the price map from an env source; missing plans fail fast (§4). */
export function priceMapFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Result<StripePriceMap> {
  const starter = env.STRIPE_PRICE_STARTER ?? env.STRIPE_PRICE_PLAN_100_CREDITS;
  const pro = env.STRIPE_PRICE_PRO ?? env.STRIPE_PRICE_PLAN_250_CREDITS;
  const max = env.STRIPE_PRICE_MAX ?? env.STRIPE_PRICE_PLAN_120_CREDITS;
  const pack = env.STRIPE_PRICE_PACK ?? env.STRIPE_PRICE_CREDIT_PACK_100;
  const seat = env.STRIPE_PRICE_EXTRA_SEAT;
  const missing: string[] = [];
  if (starter === undefined) {
    missing.push("STRIPE_PRICE_STARTER");
  }
  if (pro === undefined) {
    missing.push("STRIPE_PRICE_PRO");
  }
  if (max === undefined) {
    missing.push("STRIPE_PRICE_MAX");
  }
  if (missing.length > 0) {
    return err("validation_failed", "Stripe price ids are not configured.", {
      hint: `Set ${missing.join(", ")} (or the STRIPE_PRICE_PLAN_*_CREDITS aliases from .env.example).`,
    });
  }
  return ok({ starter, pro, max, pack, seat });
}

/** The Stripe price id for a plan code (checkout line item). */
export function priceIdForPlanCode(
  prices: StripePriceMap,
  planCode: BillingPlanCode,
): Result<string> {
  if (planCode === "pack") {
    if (prices.pack === undefined) {
      return err("not_configured", "Credit pack checkout is not configured.", {
        hint: "Set STRIPE_PRICE_CREDIT_PACK_100 (or STRIPE_PRICE_PACK) to sell packs.",
      });
    }
    return ok(prices.pack);
  }
  return ok(prices[planCode]);
}

/** Reverse lookup: which plan code does this Stripe price id belong to? */
export function planCodeForPriceId(
  prices: StripePriceMap,
  priceId: string,
): BillingPlanCode | null {
  for (const code of BILLING_PLAN_CODES) {
    const price = code === "pack" ? prices.pack : prices[code];
    if (price === priceId) {
      return code;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stripe events — structural shapes + defensive field readers
// ---------------------------------------------------------------------------

/** The event surface the webhook processor consumes (no SDK types leak out). */
export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: { readonly object: Record<string, unknown> };
}

/** Strict, non-throwing parse of a raw event payload into a StripeEvent. */
export function parseStripeEvent(raw: unknown): Result<StripeEvent> {
  if (typeof raw !== "object" || raw === null) {
    return err("validation_failed", "Stripe event payload is not an object.", {
      hint: "constructEvent callers must pass the SDK event.",
    });
  }
  const candidate = raw as Record<string, unknown>;
  const id = stringField(candidate, "id");
  const type = stringField(candidate, "type");
  const data = recordField(candidate, "data");
  const object = data === undefined ? undefined : recordField(data, "object");
  if (id === undefined || type === undefined || object === undefined) {
    return err("validation_failed", "Stripe event payload is not a shaped event.", {
      hint: "Expected { id, type, data: { object } }.",
    });
  }
  return ok({ id, type, data: { object } });
}

function recordField(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function arrayField(
  source: Record<string, unknown>,
  key: string,
): readonly unknown[] | undefined {
  const value = source[key];
  return Array.isArray(value) ? value : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The first price id on an invoice's line items (plan lookup, §14.3). */
function firstInvoicePriceId(invoice: Record<string, unknown>): string | undefined {
  const lines = recordField(invoice, "lines");
  if (lines === undefined) {
    return undefined;
  }
  const data = arrayField(lines, "data");
  const first = data === undefined ? undefined : data[0];
  if (first === undefined) {
    return undefined;
  }
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const price = recordField(first as Record<string, unknown>, "price");
  return price === undefined ? undefined : stringField(price, "id");
}

// ---------------------------------------------------------------------------
// Webhook verification failures (typed; never leak Stripe internals §13.3)
// ---------------------------------------------------------------------------

/** Verification failure kinds, each mapped to a typed 400 by the route. */
export class StripeWebhookError extends Error {
  readonly code: "invalid_signature" | "invalid_payload";

  constructor(code: "invalid_signature" | "invalid_payload", message: string) {
    super(message);
    this.name = "StripeWebhookError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// StripeLike seam
// ---------------------------------------------------------------------------

export interface CheckoutSessionInput {
  readonly planCode: BillingPlanCode;
  /** Used when no Stripe customer exists yet. */
  readonly customerEmail?: string;
  /** Preferred when a customer already exists (portal flows). */
  readonly customerId?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Copied onto the session; the webhook reads organizationId/planCode. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CheckoutSession {
  readonly url: string;
  readonly sessionId: string;
}

export interface PortalSession {
  readonly url: string;
}

export interface CustomerRef {
  readonly customerId: string;
}

/**
 * The narrow Stripe surface the gateway needs (§14.3). Two implementations:
 * `NoopStripe` (tests/dev, no network, real HMAC verification) and
 * `createStripeSdk` (production, lazy-loads the `stripe` optional dependency).
 */
export interface StripeLike {
  /** Verifies signature + parses the raw body; throws StripeWebhookError. */
  constructEvent(rawBody: string, signature: string, secret: string): StripeEvent;
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<PortalSession>;
  upsertCustomer(input: { organizationId: string; email: string }): Promise<CustomerRef>;
}

// ---------------------------------------------------------------------------
// NoopStripe — deterministic, network-free, real signature verification
// ---------------------------------------------------------------------------

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Signs a raw webhook body in Stripe's `t=<unix>,v1=<hmac>` scheme so tests and
 * dev tooling can exercise the verification path without the Stripe SDK.
 */
export function signWebhookPayload(
  secret: string,
  rawBody: string,
  timestampMs: number = Date.now(),
): string {
  const t = Math.floor(timestampMs / 1000).toString();
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * StripeLike for tests and dev: deterministic ids, no network, and REAL
 * HMAC-SHA256 signature verification in Stripe's scheme (so signature
 * failures are exercised). Timestamp tolerance is not enforced — dev tooling
 * may replay fixtures with old timestamps.
 */
export class NoopStripe implements StripeLike {
  constructEvent(rawBody: string, signature: string, secret: string): StripeEvent {
    let timestamp = "";
    const signatures: string[] = [];
    for (const part of signature.split(",")) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      if (key === "t") {
        timestamp = value;
      } else if (key === "v1") {
        signatures.push(value);
      }
    }
    if (timestamp.length === 0 || signatures.length === 0) {
      throw new StripeWebhookError("invalid_signature", "Webhook signature verification failed.");
    }
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    if (!signatures.some((candidate) => hexEqual(candidate, expected))) {
      throw new StripeWebhookError("invalid_signature", "Webhook signature verification failed.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      throw new StripeWebhookError("invalid_payload", "Webhook payload could not be parsed.");
    }
    const result = parseStripeEvent(parsed);
    if (isFailure(result)) {
      throw new StripeWebhookError("invalid_payload", "Webhook payload could not be parsed.");
    }
    return result.value;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const parsed = BILLING_PLAN_CODE_SCHEMA.safeParse(input.planCode);
    if (!parsed.success) {
      throw new Error("[noop-stripe] unknown plan code");
    }
    const sessionId = `cs_noop_${randomUUID()}`;
    return { sessionId, url: `https://billing.noop.studio.local/checkout/${sessionId}` };
  }

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<PortalSession> {
    return {
      url: `https://billing.noop.studio.local/portal/${encodeURIComponent(input.customerId)}`,
    };
  }

  async upsertCustomer(input: {
    organizationId: string;
    email: string;
  }): Promise<CustomerRef> {
    const digest = createHash("sha256")
      .update(`${input.organizationId}:${input.email}`)
      .digest("hex")
      .slice(0, 24);
    return { customerId: `cus_noop_${digest}` };
  }
}

// ---------------------------------------------------------------------------
// Production adapter — lazy import of the `stripe` optional dependency
// ---------------------------------------------------------------------------

export interface StripeSdkConfig {
  readonly secretKey: string;
  readonly prices: StripePriceMap;
}

/**
 * StripeLike over the real SDK. The `stripe` package is an OPTIONAL dependency
 * (apps/gateway/package.json): it is imported lazily so tests, dev and any
 * environment without the SDK never load it. SDK failures bubble to the
 * caller, which maps them to the generic 503 (§13.3 — never leak Stripe
 * errors to callers).
 */
export async function createStripeSdk(config: StripeSdkConfig): Promise<StripeLike> {
  const { default: Stripe } = await import("stripe");
  const client = new Stripe(config.secretKey);
  const prices = config.prices;

  return {
    constructEvent(rawBody: string, signature: string, secret: string): StripeEvent {
      let raw: unknown;
      try {
        raw = client.webhooks.constructEvent(rawBody, signature, secret);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new StripeWebhookError("invalid_payload", "Webhook payload could not be parsed.");
        }
        throw new StripeWebhookError("invalid_signature", "Webhook signature verification failed.");
      }
      const parsed = parseStripeEvent(raw);
      if (isFailure(parsed)) {
        throw new StripeWebhookError("invalid_payload", "Webhook payload could not be parsed.");
      }
      return parsed.value;
    },

    async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
      const price = priceIdForPlanCode(prices, input.planCode);
      if (isFailure(price)) {
        throw new AppError(501, "not_configured", "This product is not configured.", {
          hint: price.hint,
          retryable: false,
        });
      }
      const params: {
        mode: "subscription" | "payment";
        line_items: [{ price: string; quantity: number }];
        success_url: string;
        cancel_url: string;
        metadata: Record<string, string>;
        customer?: string;
        customer_email?: string;
      } = {
        mode: input.planCode === "pack" ? "payment" : "subscription",
        line_items: [{ price: price.value, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: { ...(input.metadata ?? {}) },
      };
      if (input.customerId !== undefined) {
        params.customer = input.customerId;
      } else if (input.customerEmail !== undefined) {
        params.customer_email = input.customerEmail;
      }
      const session = await client.checkout.sessions.create(params);
      if (session.url === null) {
        throw new Error("[stripe] checkout session returned no url");
      }
      return { url: session.url, sessionId: session.id };
    },

    async createPortalSession(input: {
      customerId: string;
      returnUrl: string;
    }): Promise<PortalSession> {
      const session = await client.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    },

    async upsertCustomer(input: {
      organizationId: string;
      email: string;
    }): Promise<CustomerRef> {
      const found = await client.customers.list({ email: input.email, limit: 1 });
      const existing = found.data[0];
      if (existing !== undefined) {
        return { customerId: existing.id };
      }
      const created = await client.customers.create({
        email: input.email,
        metadata: { organizationId: input.organizationId },
      });
      return { customerId: created.id };
    },
  };
}

// ---------------------------------------------------------------------------
// LedgerLike — grant(monthlyCredits) with a money-side idempotency key
// ---------------------------------------------------------------------------

export interface LedgerGrantInput {
  readonly organizationId: string;
  readonly credits: number;
  /** §14.2 rule 6 — `stripe:<eventId>` for webhook-driven grants (W4-N). */
  readonly idempotencyKey: string;
  readonly kind?: "grant" | "pack";
  readonly note?: string;
}

/**
 * The money seam (§14.2): appending a grant is idempotent by
 * (idempotencyKey, kind) — the ledger's unique index rejects duplicates, so a
 * webhook that retries after a half-failed transaction can never mint
 * credits twice.
 */
export interface LedgerLike {
  grant(input: LedgerGrantInput): Promise<{ readonly duplicate: boolean }>;
}

/** LedgerLike over @studio/billing's LedgerStore (production + tests). */
export function ledgerFromStore(store: LedgerStore): LedgerLike {
  return {
    async grant(input: LedgerGrantInput) {
      const kind = input.kind ?? "grant";
      if (await store.findByIdempotency(input.idempotencyKey, kind)) {
        return { duplicate: true };
      }
      await store.append({
        organizationId: input.organizationId,
        delta: input.credits,
        kind,
        idempotencyKey: input.idempotencyKey,
        note: input.note,
      });
      return { duplicate: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Audit seam (§22) — parallel contract with services/workspaces.ts
// ---------------------------------------------------------------------------

export interface AuditEntry {
  readonly organizationId: string;
  /** Null for system/webhook-actor entries (audit_log.actor_id, §12.1). */
  readonly actorId: string | null;
  readonly action: string;
  /** Stable "<type>:<id>" — readable after the referenced row is gone. */
  readonly target: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditLike {
  append(entry: AuditEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// BillingDbLike — storage seam + the transaction runner
// ---------------------------------------------------------------------------

/** The role slice the RBAC check needs (member.role enum, §15.2). */
export type BillingRole = "viewer" | "editor" | "admin" | "owner";

/** The membership slice billing routes need (§12.2 tenant root). */
export interface BillingMemberRow {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: BillingRole;
}

/** idempotency_keys claim row (packages/db billing.ts, W1-F). */
export interface IdempotencyClaim {
  readonly key: string;
  readonly scope: string;
  readonly organizationId: string;
  readonly result?: unknown;
}

/** Fields upserted on the one-subscription-per-org row (§12.1). */
export interface SubscriptionUpsert {
  readonly organizationId: string;
  readonly planId: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly status: string;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAt?: Date | null;
}

/**
 * Raised when the idempotency_keys unique (key, scope) index rejects a claim —
 * a concurrent redelivery of the same event id won the race. Handlers treat it
 * as a duplicate, never as a failure.
 */
export class IdempotencyConflictError extends Error {
  constructor(key: string, scope: string) {
    super(`idempotency key already claimed: ${scope}:${key}`);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Narrow storage seam over the billing schema (subscriptions / plans /
 * idempotency_keys) plus the membership role lookup. The Drizzle adapter
 * below implements it against @studio/db exports; tests fake it in memory.
 * Row types are the schema's inferred types so the Drizzle adapter needs no
 * mapping layer.
 */
export interface BillingDbLike {
  findMembership(userId: string, workspaceId: string): Promise<BillingMemberRow | null>;
  findSubscriptionByOrganization(organizationId: string): Promise<Subscription | null>;
  findSubscriptionByCustomerId(customerId: string): Promise<Subscription | null>;
  findSubscriptionByStripeSubscriptionId(subscriptionId: string): Promise<Subscription | null>;
  findPlanByCode(code: string): Promise<Plan | null>;
  findPlanById(id: string): Promise<Plan | null>;
  /** Insert-or-update the org's subscription row (organizationId UNIQUE, §12.1). */
  upsertSubscription(input: SubscriptionUpsert): Promise<Subscription>;
  findIdempotencyKey(key: string, scope: string): Promise<IdempotencyKey | null>;
  /** Claims (key, scope); throws IdempotencyConflictError on the unique race. */
  insertIdempotencyKey(input: IdempotencyClaim): Promise<void>;
}

/**
 * The transaction seam: work receives a BillingDbLike bound to the
 * transaction, so the idempotency claim and its side effects commit or roll
 * back together (check-then-act, §14.2 rule 6 / §15.2 idempotent webhooks).
 */
export type WithTransaction = <T>(work: (tx: BillingDbLike) => Promise<T>) => Promise<T>;

// ---------------------------------------------------------------------------
// RBAC (§15.2) — billing:manage, ADR-0003 row 8
// ---------------------------------------------------------------------------

const ROLE_RANK: Readonly<Record<BillingRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/**
 * §15.2 billing gate. The W4-N task sketch said "owner only"; ADR-0003's RBAC
 * matrix row 8 ("Billing (checkout/portal, credit packs)") grants admin AND
 * owner — the ADR wins, owner inherits cumulatively (same call W4-C made
 * for `billing:manage`; matrix-audited in authz/matrix.ts).
 */
export function assertBillingManager(role: BillingRole): void {
  if (ROLE_RANK[role] < ROLE_RANK.admin) {
    throw new AppError(403, "forbidden", "Your workspace role does not allow billing actions.", {
      hint: "Only owners and admins manage billing (§15.2).",
      retryable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (§13.1 responses; snake_case like the spec tables)
// ---------------------------------------------------------------------------

/** GET /v1/billing/plans card — §14.1 pricing joined with runtime limits. */
export interface PlanCard {
  readonly code: SubscriptionPlanCode;
  readonly monthly_price_usd_cents: number;
  readonly monthly_credits: number;
  readonly extra_seat_price_usd_cents: number;
  readonly seats: number;
  readonly concurrent_runs: number;
  readonly concurrent_sessions: number;
  readonly max_canvas_megapixels: number;
  readonly daily_spend_cap_credits: number;
}

export interface PlanCardsResponse {
  readonly ok: true;
  readonly plans: readonly PlanCard[];
  readonly credit_pack: { readonly credits: number; readonly price_usd_cents: number };
  readonly credit_price_usd_cents: number;
}

/** The authenticated caller, resolved by the injected auth seam. */
export interface BillingCaller {
  readonly userId: string;
  readonly email?: string;
}

export interface CheckoutRequest {
  readonly planCode: BillingPlanCode;
  readonly workspaceId: string;
}

/** Per-event processing result (the route always answers 2xx, §15.2). */
export interface WebhookOutcome {
  readonly type: string;
  /** False for unknown or unattributable events (200 no-op, logged). */
  readonly handled: boolean;
  /** True when the event id was already processed (idempotent replay). */
  readonly duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Service deps + factory
// ---------------------------------------------------------------------------

export interface StripeBillingDeps {
  readonly stripe: StripeLike;
  readonly db: BillingDbLike;
  readonly ledger: LedgerLike;
  readonly audit: AuditLike;
  readonly prices: StripePriceMap;
  /** STRIPE_WEBHOOK_SECRET (parsed by @studio/config at bootstrap, §4). */
  readonly webhookSecret: string;
  /** Absolute app URL (APP_URL) — checkout/portal redirect targets. */
  readonly appUrl: string;
  readonly withTransaction: WithTransaction;
  readonly logger: Logger;
  /** Injectable clock — deterministic webhook result payloads in tests. */
  readonly clock?: () => Date;
}

export interface StripeBillingService {
  /** STRIPE_WEBHOOK_SECRET passthrough for the route's constructEvent call. */
  readonly webhookSecret: string;
  /** §13.1 public plan cards from @studio/config pricing (§14.1). */
  planCards(): PlanCardsResponse;
  /** POST /v1/billing/checkout — owner/admin only (§15.2, ADR-0003 row 8). */
  createCheckout(caller: BillingCaller, input: CheckoutRequest): Promise<CheckoutSession>;
  /** POST /v1/billing/portal — owner/admin only. */
  openPortal(caller: BillingCaller, input: { workspaceId: string }): Promise<PortalSession>;
  /** Signature verification over the RAW request body (§15.2). */
  verifyWebhook(rawBody: string, signature: string): StripeEvent;
  /** Idempotent-by-event-id processing (§14.3 / §15.2). */
  handleWebhookEvent(event: StripeEvent): Promise<WebhookOutcome>;
}

/** idempotency_keys scope for Stripe webhook events. */
const IDEMPOTENCY_SCOPE = "stripe.webhook";

export function createStripeBillingService(deps: StripeBillingDeps): StripeBillingService {
  const { stripe, db, ledger, audit, prices, withTransaction } = deps;
  const log = deps.logger;
  const now = (): Date => deps.clock?.() ?? new Date();
  const appBase = (): string => deps.appUrl.replace(/\/+$/, "");

  /**
   * Provider calls map to a generic 503 — Stripe error bodies never reach
   * callers (§13.3); the real error is logged for operators only.
   */
  async function providerCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError || error instanceof StripeWebhookError) {
        throw error;
      }
      log.error({ err: error }, "stripe_provider_call_failed");
      throw new AppError(
        503,
        "billing_provider_unavailable",
        "The billing provider is temporarily unavailable.",
        { hint: "Try again in a moment.", retryable: true },
      );
    }
  }

  /** Money-side guard: ledger.grant is idempotent by (key, kind), §14.2 r6. */
  async function grant(input: LedgerGrantInput): Promise<void> {
    const outcome = await ledger.grant(input);
    if (outcome.duplicate) {
      log.info({ idempotencyKey: input.idempotencyKey }, "ledger_grant_duplicate");
    }
  }

  /**
   * Check-then-act idempotency (§15.2): fast pre-check, then inside the
   * injected transaction claim (event id, scope) — the unique index is the
   * concurrency guard; the losing delivery folds into a duplicate no-op. Side
   * effects run AFTER the claim so a rolled-back claim can never half-apply.
   */
  async function claimEvent(
    event: StripeEvent,
    organizationId: string,
    apply: (tx: BillingDbLike) => Promise<void>,
  ): Promise<WebhookOutcome> {
    const type = event.type;
    const existing = await db.findIdempotencyKey(event.id, IDEMPOTENCY_SCOPE);
    if (existing !== null) {
      log.info({ eventId: event.id, type }, "stripe_webhook_duplicate");
      return { type, handled: true, duplicate: true };
    }
    let duplicate = false;
    await withTransaction(async (tx) => {
      try {
        await tx.insertIdempotencyKey({
          key: event.id,
          scope: IDEMPOTENCY_SCOPE,
          organizationId,
          result: { processed: true, type, at: now().toISOString() },
        });
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          duplicate = true;
          return;
        }
        throw error;
      }
      await apply(tx);
    });
    if (duplicate) {
      log.info({ eventId: event.id, type }, "stripe_webhook_duplicate_race");
      return { type, handled: true, duplicate: true };
    }
    log.info({ eventId: event.id, type }, "stripe_webhook_handled");
    return { type, handled: true, duplicate: false };
  }

  /** 200 no-op path: known-but-unattributable or unknown events (§15.2). */
  function skipped(event: StripeEvent, reason: string): WebhookOutcome {
    log.warn({ eventId: event.id, type: event.type, reason }, "stripe_webhook_skipped");
    return { type: event.type, handled: false, duplicate: false };
  }

  // --- checkout.session.completed → attach subscription / grant pack -----
  async function handleCheckoutCompleted(event: StripeEvent): Promise<WebhookOutcome> {
    const session = event.data.object;
    const metadata = recordField(session, "metadata");
    const organizationId = metadata === undefined ? undefined : stringField(metadata, "organizationId");
    if (organizationId === undefined) {
      // Cannot attribute and cannot claim (idempotency_keys.organization_id
      // NOT NULL) — a replay after metadata is fixed still processes.
      return skipped(event, "checkout session without organizationId metadata");
    }
    const mode = stringField(session, "mode") ?? "subscription";

    if (mode === "payment") {
      // §14.3: checkout covers credit packs too; §14.1: $10 → 100 credits,
      // never expiring while subscribed.
      return claimEvent(event, organizationId, async () => {
        await grant({
          organizationId,
          credits: CREDIT_PACK.credits,
          idempotencyKey: `stripe:${event.id}`,
          kind: "pack",
          note: "credit pack purchase (§14.1)",
        });
      });
    }

    const subscriptionId = stringField(session, "subscription");
    const customerId = stringField(session, "customer");
    const rawPlanCode = metadata === undefined ? undefined : stringField(metadata, "planCode");
    if (subscriptionId === undefined || customerId === undefined || rawPlanCode === undefined) {
      return skipped(event, "subscription checkout without subscription/customer/planCode");
    }
    const parsed = BILLING_PLAN_CODE_SCHEMA.safeParse(rawPlanCode);
    if (!parsed.success || parsed.data === "pack") {
      return skipped(event, `non-subscription planCode on a subscription checkout: ${rawPlanCode}`);
    }
    const planCode: SubscriptionPlanCode = parsed.data;
    // planId is a NOT NULL FK to plans (§12.1) — the catalog must be seeded
    // (§14.1 "seeded via migration"). Unseeded → skip without claiming, so
    // the event re-processes once the seed lands.
    const planRow = await db.findPlanByCode(CONFIG_PLAN_BY_CODE[planCode]);
    if (planRow === null) {
      return skipped(event, "plans table not seeded (§14.1 catalog)");
    }
    return claimEvent(event, organizationId, async (tx) => {
      const row = await tx.upsertSubscription({
        organizationId,
        planId: planRow.id,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        status: "active",
        currentPeriodEnd: null,
        cancelAt: null,
      });
      await audit.append({
        organizationId,
        actorId: null,
        action: "billing.subscription.attached",
        target: `subscription:${row.id}`,
        metadata: { reason: "checkout.session.completed", planCode, stripeSubscriptionId: subscriptionId },
      });
    });
  }

  // --- invoice.paid → extend credits per plan (§14.3, §14.1) --------------
  async function handleInvoicePaid(event: StripeEvent): Promise<WebhookOutcome> {
    const invoice = event.data.object;
    const customerId = stringField(invoice, "customer");
    if (customerId === undefined) {
      return skipped(event, "invoice without customer id");
    }
    const row = await db.findSubscriptionByCustomerId(customerId);
    if (row === null) {
      // Invoices flow after checkout.session.completed attached the row; an
      // unknown customer cannot be attributed to a workspace (§12.2).
      return skipped(event, "invoice for an unknown Stripe customer");
    }
    // Plan lookup: price id → plan code via the env mapping (W4-N), falling
    // back to the attached row's plan.
    let planCode: SubscriptionPlanCode | undefined;
    const priceId = firstInvoicePriceId(invoice);
    if (priceId !== undefined) {
      const byPrice = planCodeForPriceId(prices, priceId);
      if (byPrice !== null && byPrice !== "pack") {
        planCode = byPrice;
      }
    }
    if (planCode === undefined) {
      const planRow = await db.findPlanById(row.planId);
      if (planRow === null) {
        return skipped(event, "attached plan row vanished");
      }
      const configId = PLAN_ID_SCHEMA.safeParse(planRow.code);
      if (!configId.success) {
        return skipped(event, `unknown plan code on the attached row: ${planRow.code}`);
      }
      planCode = wirePlanCode(configId.data);
    }
    const resolvedPlan: SubscriptionPlanCode = planCode;
    const monthlyCredits = PLANS[CONFIG_PLAN_BY_CODE[resolvedPlan]].monthlyCredits;
    return claimEvent(event, row.organizationId, async (tx) => {
      // §14.2 rule 6 money key: `stripe:<eventId>` — replays after a
      // half-committed transaction land on the ledger's duplicate path.
      await grant({
        organizationId: row.organizationId,
        credits: monthlyCredits,
        idempotencyKey: `stripe:${event.id}`,
        note: `invoice.paid grant for plan ${resolvedPlan} (§14.1)`,
      });
      // Webhooks are the source of truth (§14.3): keep the row in step with
      // what was actually paid (portal plan switches included).
      const planRow = await tx.findPlanByCode(CONFIG_PLAN_BY_CODE[resolvedPlan]);
      if (planRow !== null) {
        await tx.upsertSubscription({
          organizationId: row.organizationId,
          planId: planRow.id,
          stripeCustomerId: row.stripeCustomerId,
          stripeSubscriptionId: row.stripeSubscriptionId,
          status: "active",
          currentPeriodEnd: row.currentPeriodEnd,
          cancelAt: row.cancelAt,
        });
      }
    });
  }

  // --- customer.subscription.deleted → downgrade + audit ------------------
  async function handleSubscriptionDeleted(event: StripeEvent): Promise<WebhookOutcome> {
    const object = event.data.object;
    const subscriptionId = stringField(object, "id") ?? stringField(object, "subscription");
    const customerId = stringField(object, "customer");
    if (subscriptionId === undefined) {
      return skipped(event, "subscription event without an id");
    }
    let row = await db.findSubscriptionByStripeSubscriptionId(subscriptionId);
    if (row === null && customerId !== undefined) {
      row = await db.findSubscriptionByCustomerId(customerId);
    }
    if (row === null) {
      return skipped(event, "no subscription row for the deleted Stripe subscription");
    }
    // const alias: the closure below must see the narrowed row on every TS
    // version (let-narrowing inside closures landed in TS 5.4).
    const target: Subscription = row;
    const previousStatus = target.status;
    return claimEvent(event, target.organizationId, async (tx) => {
      const updated = await tx.upsertSubscription({
        organizationId: target.organizationId,
        planId: target.planId,
        stripeCustomerId: customerId ?? target.stripeCustomerId,
        stripeSubscriptionId: subscriptionId,
        // §14.3: the workspace drops out of the paid state — the grace ladder
        // (holding, read-only documents) reads this status; credits already
        // granted are never revoked and documents are never deleted.
        status: "canceled",
        currentPeriodEnd: target.currentPeriodEnd,
        cancelAt: target.cancelAt,
      });
      await audit.append({
        organizationId: target.organizationId,
        actorId: null,
        action: "billing.subscription.downgraded",
        target: `subscription:${updated.id}`,
        metadata: {
          reason: "customer.subscription.deleted",
          previousStatus,
          status: "canceled",
          stripeSubscriptionId: subscriptionId,
        },
      });
    });
  }

  const service: StripeBillingService = {
    webhookSecret: deps.webhookSecret,

    planCards(): PlanCardsResponse {
      return {
        ok: true,
        plans: PLAN_CATALOG.map((plan) => ({
          code: wirePlanCode(plan.code),
          monthly_price_usd_cents: plan.monthlyPriceUsdCents,
          monthly_credits: plan.monthlyCredits,
          extra_seat_price_usd_cents: plan.extraSeatPriceUsdCents,
          seats: plan.seats,
          concurrent_runs: plan.concurrentRuns,
          concurrent_sessions: plan.concurrentSessions,
          max_canvas_megapixels: plan.maxCanvasMegapixels,
          daily_spend_cap_credits: plan.dailySpendCapCredits,
        })),
        credit_pack: { credits: CREDIT_PACK.credits, price_usd_cents: CREDIT_PACK.priceUsdCents },
        credit_price_usd_cents: CREDIT_PRICE_USD_CENTS,
      };
    },

    async createCheckout(caller, input) {
      const membership = await db.findMembership(caller.userId, input.workspaceId);
      if (membership === null) {
        // §15.1: cross-tenant lookups 404 — existence is not disclosed.
        throw new AppError(404, "not_found", "Workspace not found.", {
          hint: "Check the workspace id.",
          retryable: false,
        });
      }
      assertBillingManager(membership.role);
      const packPrice = priceIdForPlanCode(prices, input.planCode);
      if (isFailure(packPrice)) {
        throw new AppError(501, "not_configured", "This product is not configured.", {
          hint: packPrice.hint,
          retryable: false,
        });
      }
      const row = await db.findSubscriptionByOrganization(input.workspaceId);
      let customerId = row?.stripeCustomerId;
      if (customerId === undefined) {
        if (caller.email === undefined) {
          throw new AppError(
            400,
            "billing_email_required",
            "A billing email is required to start checkout.",
            { hint: "Sign in with a verified email address, then retry.", retryable: false },
          );
        }
        customerId = (
          await providerCall(() =>
            stripe.upsertCustomer({ organizationId: input.workspaceId, email: caller.email }),
          )
        ).customerId;
      }
      const base = appBase();
      return providerCall(() =>
        stripe.createCheckoutSession({
          planCode: input.planCode,
          customerId,
          customerEmail: caller.email,
          successUrl: `${base}/billing/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${base}/billing/checkout/cancelled`,
          // The webhook reads these back (§14.3 attribution).
          metadata: { organizationId: input.workspaceId, planCode: input.planCode },
        }),
      );
    },

    async openPortal(caller, input) {
      const membership = await db.findMembership(caller.userId, input.workspaceId);
      if (membership === null) {
        throw new AppError(404, "not_found", "Workspace not found.", {
          hint: "Check the workspace id.",
          retryable: false,
        });
      }
      assertBillingManager(membership.role);
      const row = await db.findSubscriptionByOrganization(input.workspaceId);
      if (row === null) {
        throw new AppError(404, "no_subscription", "This workspace has no billing customer yet.", {
          hint: "Start a checkout first — the portal opens once a subscription exists.",
          retryable: false,
        });
      }
      const base = appBase();
      return providerCall(() =>
        stripe.createPortalSession({
          customerId: row.stripeCustomerId,
          returnUrl: `${base}/billing`,
        }),
      );
    },

    verifyWebhook(rawBody, signature) {
      // Signature verification over the RAW body (§15.2); failures throw the
      // typed StripeWebhookError the route maps to 400.
      return stripe.constructEvent(rawBody, signature, deps.webhookSecret);
    },

    async handleWebhookEvent(event) {
      switch (event.type) {
        case "checkout.session.completed":
          return handleCheckoutCompleted(event);
        case "invoice.paid":
          return handleInvoicePaid(event);
        case "customer.subscription.deleted":
          return handleSubscriptionDeleted(event);
        default:
          // §15.2: unknown events are a logged 200 no-op.
          log.info({ eventId: event.id, type: event.type }, "stripe_webhook_ignored");
          return { type: event.type, handled: false, duplicate: false };
      }
    },
  };
  return service;
}

// ---------------------------------------------------------------------------
// Drizzle adapters — production implementations over @studio/db exports
// ---------------------------------------------------------------------------

/** Postgres unique-violation (23505) — searched along the cause chain. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** BillingDbLike over the real Drizzle client (drizzle-orm/postgres-js). */
export function createDrizzleBillingDb(db: Db): BillingDbLike {
  return {
    async findMembership(userId, workspaceId) {
      const rows = await db
        .select()
        .from(member)
        .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)));
      return rows[0] ?? null;
    },

    async findSubscriptionByOrganization(organizationId) {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, organizationId));
      return rows[0] ?? null;
    },

    async findSubscriptionByCustomerId(customerId) {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.stripeCustomerId, customerId));
      return rows[0] ?? null;
    },

    async findSubscriptionByStripeSubscriptionId(subscriptionId) {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
      return rows[0] ?? null;
    },

    async findPlanByCode(code) {
      const rows = await db.select().from(plans).where(eq(plans.code, code));
      return rows[0] ?? null;
    },

    async findPlanById(id) {
      const rows = await db.select().from(plans).where(eq(plans.id, id));
      return rows[0] ?? null;
    },

    async upsertSubscription(input) {
      // One atomic statement: insert-or-update the org's row
      // (subscriptions.organizationId UNIQUE, §12.1) — no read-modify-write
      // race between concurrent webhook deliveries.
      const rows = await db
        .insert(subscriptions)
        .values({
          organizationId: input.organizationId,
          planId: input.planId,
          stripeCustomerId: input.stripeCustomerId,
          stripeSubscriptionId: input.stripeSubscriptionId,
          status: input.status,
          currentPeriodEnd: input.currentPeriodEnd ?? null,
          cancelAt: input.cancelAt ?? null,
        })
        .onConflictDoUpdate({
          target: subscriptions.organizationId,
          set: {
            planId: input.planId,
            stripeCustomerId: input.stripeCustomerId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            status: input.status,
            currentPeriodEnd: input.currentPeriodEnd ?? null,
            cancelAt: input.cancelAt ?? null,
          },
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new AppError(500, "internal_error", "Subscription upsert returned no row.", {
          retryable: true,
        });
      }
      return row;
    },

    async findIdempotencyKey(key, scope) {
      const rows = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, scope)));
      return rows[0] ?? null;
    },

    async insertIdempotencyKey(input) {
      try {
        await db.insert(idempotencyKeys).values({
          key: input.key,
          scope: input.scope,
          organizationId: input.organizationId,
          result: input.result ?? null,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new IdempotencyConflictError(input.key, input.scope);
        }
        throw error;
      }
    },
  };
}

/** WithTransaction over Drizzle's transactional client (rollback = real). */
export function drizzleWithTransaction(db: Db): WithTransaction {
  return async <T>(work: (tx: BillingDbLike) => Promise<T>) =>
    db.transaction(async (tx) => work(createDrizzleBillingDb(tx as unknown as Db)));
}
