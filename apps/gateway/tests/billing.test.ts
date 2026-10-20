// Billing routes + service tests (W4-N) — deterministic, no network, no DB:
// the StripeLike/BillingDbLike/LedgerLike/AuditLike seams are faked in memory
// (NoopStripe supplies REAL HMAC signature verification) and the app is
// exercised end-to-end through buildApp().request() so every response flows
// through the real middleware stack (request-id, logger, error-mapper).
//
// Covers the W4-N acceptance list:
//   - webhook idempotency: the same event id twice → one ledger grant (§14.2
//     rule 6 money key `stripe:<eventId>` + idempotency_keys event claim)
//   - signature failure → typed 400 `invalid_signature`, zero side effects
//   - checkout is billing:manage-gated (owner/admin per ADR-0003 row 8 —
//     the task sketch said owner-only; the ADR matrix wins, W4-C precedent)
//   - customer.subscription.deleted → downgrade + one audit row (§22)
//   - plan cards public (§14.1 numbers), credit packs (§14.3), unknown events
//     answering a logged 200 no-op (§15.2)

import type { IdempotencyKey, Plan, Subscription } from "@studio/db";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import { mountBillingRoutes } from "../src/routes/billing.js";
import { createWorkspaceAuth, type AuthContext } from "../src/routes/workspaces.js";
import {
  IdempotencyConflictError,
  NoopStripe,
  createStripeBillingService,
  signWebhookPayload,
  type AuditEntry,
  type AuditLike,
  type BillingDbLike,
  type BillingMemberRow,
  type IdempotencyClaim,
  type LedgerGrantInput,
  type LedgerLike,
  type StripePriceMap,
  type SubscriptionUpsert,
} from "../src/services/stripe.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-02-01T10:00:00.000Z");
const WEBHOOK_SECRET = "whsec_test_secret";
const APP_URL = "https://app.studio.test";

/** uuid-shaped ids (audit_log/subscription columns are uuid, §12.1). */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const PLAN_STARTER_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_PRO_ID = "33333333-3333-4333-8333-333333333333";
const PLAN_BUSINESS_ID = "44444444-4444-4444-8444-444444444444";

const CUSTOMER = "cus_test_a";
const SUBSCRIPTION = "sub_test_a";

/** §14.1 plan catalog as the seeded plans table rows (§12.1 shapes). */
const PLAN_ROWS: readonly Plan[] = [
  {
    id: PLAN_STARTER_ID,
    code: "starter",
    monthlyUsdCents: 3000,
    monthlyCredits: 100,
    extraSeatUsdCents: 800,
    maxConcurrentEngineSessions: 1,
    maxUploadMb: 25,
    features: {},
    createdAt: FIXED_NOW
  },
  {
    id: PLAN_PRO_ID,
    code: "pro",
    monthlyUsdCents: 6000,
    monthlyCredits: 250,
    extraSeatUsdCents: 800,
    maxConcurrentEngineSessions: 3,
    maxUploadMb: 25,
    features: {},
    createdAt: FIXED_NOW
  },
  {
    id: PLAN_BUSINESS_ID,
    code: "business",
    monthlyUsdCents: 12000,
    monthlyCredits: 600,
    extraSeatUsdCents: 800,
    maxConcurrentEngineSessions: 6,
    maxUploadMb: 25,
    features: {},
    createdAt: FIXED_NOW
  }
];

/** Price-id map matching the W4-N env mapping (STRIPE_PRICE_STARTER/PRO/MAX). */
const PRICES: StripePriceMap = {
  starter: "price_starter",
  pro: "price_pro",
  max: "price_max",
  pack: "price_pack"
};

const ALICE: AuthContext = { userId: "user-alice", email: "alice@example.com" };
const BOB: AuthContext = { userId: "user-bob", email: "bob@example.com" };
const CAROL: AuthContext = { userId: "user-carol", email: "carol@example.com" };
const DAN: AuthContext = { userId: "user-dan", email: "dan@example.com" };
const ERIN: AuthContext = { userId: "user-erin", email: "erin@example.com" };

/** §15.2 ladder for ORG_A: owner, admin, editor, viewer + a non-member. */
const MEMBERSHIPS: readonly BillingMemberRow[] = [
  { userId: ALICE.userId, organizationId: ORG_A, role: "owner" },
  { userId: CAROL.userId, organizationId: ORG_A, role: "admin" },
  { userId: BOB.userId, organizationId: ORG_A, role: "editor" },
  { userId: DAN.userId, organizationId: ORG_A, role: "viewer" }
];

let idSeq = 0;
function newId(): string {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

/** In-memory BillingDbLike over the billing schema shapes. */
class FakeBillingDb implements BillingDbLike {
  readonly memberships: BillingMemberRow[] = [];
  readonly plans: Plan[] = [];
  readonly subscriptions: Subscription[] = [];
  readonly idempotency: IdempotencyKey[] = [];

  constructor(memberships: readonly BillingMemberRow[], plans: readonly Plan[]) {
    this.memberships.push(...memberships.map((m) => ({ ...m })));
    this.plans.push(...plans.map((p) => ({ ...p })));
  }

  async findMembership(userId: string, workspaceId: string): Promise<BillingMemberRow | null> {
    return (
      this.memberships.find(
        (m) => m.userId === userId && m.organizationId === workspaceId
      ) ?? null
    );
  }

  async findSubscriptionByOrganization(organizationId: string): Promise<Subscription | null> {
    return this.subscriptions.find((s) => s.organizationId === organizationId) ?? null;
  }

  async findSubscriptionByCustomerId(customerId: string): Promise<Subscription | null> {
    return this.subscriptions.find((s) => s.stripeCustomerId === customerId) ?? null;
  }

  async findSubscriptionByStripeSubscriptionId(
    subscriptionId: string
  ): Promise<Subscription | null> {
    return (
      this.subscriptions.find((s) => s.stripeSubscriptionId === subscriptionId) ?? null
    );
  }

  async findPlanByCode(code: string): Promise<Plan | null> {
    return this.plans.find((p) => p.code === code) ?? null;
  }

  async findPlanById(id: string): Promise<Plan | null> {
    return this.plans.find((p) => p.id === id) ?? null;
  }

  async upsertSubscription(input: SubscriptionUpsert): Promise<Subscription> {
    const existing = this.subscriptions.find(
      (s) => s.organizationId === input.organizationId
    );
    if (existing !== undefined) {
      existing.planId = input.planId;
      existing.stripeCustomerId = input.stripeCustomerId;
      existing.stripeSubscriptionId = input.stripeSubscriptionId;
      existing.status = input.status;
      existing.currentPeriodEnd = input.currentPeriodEnd ?? null;
      existing.cancelAt = input.cancelAt ?? null;
      return { ...existing };
    }
    const created: Subscription = {
      id: newId(),
      organizationId: input.organizationId,
      planId: input.planId,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAt: input.cancelAt ?? null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW
    };
    this.subscriptions.push(created);
    return { ...created };
  }

  async findIdempotencyKey(key: string, scope: string): Promise<IdempotencyKey | null> {
    return this.idempotency.find((row) => row.key === key && row.scope === scope) ?? null;
  }

  async insertIdempotencyKey(input: IdempotencyClaim): Promise<void> {
    if (
      this.idempotency.some((row) => row.key === input.key && row.scope === input.scope)
    ) {
      // Mirrors idempotency_keys unique (key, scope) — the race loser
      // becomes a duplicate no-op (§14.2 rule 6 / §15.2).
      throw new IdempotencyConflictError(input.key, input.scope);
    }
    this.idempotency.push({
      id: newId(),
      key: input.key,
      scope: input.scope,
      organizationId: input.organizationId,
      result: input.result ?? null,
      createdAt: FIXED_NOW
    });
  }
}

/** Ledger fake mirroring the (idempotencyKey, kind) duplicate contract. */
class FakeLedger implements LedgerLike {
  readonly grants: LedgerGrantInput[] = [];

  async grant(input: LedgerGrantInput): Promise<{ readonly duplicate: boolean }> {
    const kind = input.kind ?? "grant";
    const duplicate = this.grants.some(
      (g) => g.idempotencyKey === input.idempotencyKey && (g.kind ?? "grant") === kind
    );
    if (duplicate) {
      return { duplicate: true };
    }
    this.grants.push({ ...input, kind });
    return { duplicate: false };
  }
}

class FakeAudit implements AuditLike {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly db: FakeBillingDb;
  readonly ledger: FakeLedger;
  readonly audit: FakeAudit;
  readonly stripe: NoopStripe;
  actAs(user: AuthContext | null): void;
}

function makeHarness(): Harness {
  let acting: AuthContext | null = ALICE;
  const auth = createWorkspaceAuth(() => acting);

  const db = new FakeBillingDb(MEMBERSHIPS, PLAN_ROWS);
  const ledger = new FakeLedger();
  const audit = new FakeAudit();
  const stripe = new NoopStripe();
  const service = createStripeBillingService({
    stripe,
    db,
    ledger,
    audit,
    prices: PRICES,
    webhookSecret: WEBHOOK_SECRET,
    appUrl: APP_URL,
    withTransaction: async <T>(work: (tx: BillingDbLike) => Promise<T>): Promise<T> =>
      work(db),
    logger: pino({ enabled: false }),
    clock: () => FIXED_NOW
  });

  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: FIXED_NOW.getTime(),
    mount(mountApp) {
      mountBillingRoutes(mountApp, { billing: service, auth });
    }
  } satisfies AppDeps);

  return {
    app,
    db,
    ledger,
    audit,
    stripe,
    actAs(user: AuthContext | null) {
      acting = user;
    }
  };
}

async function callJson(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Posts a raw signed webhook payload to /v1/webhooks/stripe. */
async function postWebhook(
  h: Harness,
  payload: string,
  options?: { secret?: string; omitSignature?: boolean }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options?.omitSignature !== true) {
    headers["stripe-signature"] = signWebhookPayload(
      options?.secret ?? WEBHOOK_SECRET,
      payload,
      1_769_987_200_000
    );
  }
  const res = await h.app.request("/v1/webhooks/stripe", {
    method: "POST",
    headers,
    body: payload
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Event payloads (Stripe shapes, minimal fields the handlers read)
// ---------------------------------------------------------------------------

function eventJson(id: string, type: string, object: Record<string, unknown>): string {
  return JSON.stringify({ id, type, data: { object } });
}

function attachSessionEvent(id: string, planCode: string): string {
  return eventJson(id, "checkout.session.completed", {
    id: `cs_${id}`,
    object: "checkout.session",
    mode: "subscription",
    customer: CUSTOMER,
    subscription: SUBSCRIPTION,
    metadata: { organizationId: ORG_A, planCode }
  });
}

function invoicePaidEvent(id: string, priceId: string): string {
  return eventJson(id, "invoice.paid", {
    id: `in_${id}`,
    object: "invoice",
    customer: CUSTOMER,
    subscription: SUBSCRIPTION,
    status: "paid",
    lines: { object: "list", data: [{ price: { id: priceId } }] }
  });
}

function subscriptionDeletedEvent(id: string): string {
  return eventJson(id, "customer.subscription.deleted", {
    id: SUBSCRIPTION,
    object: "subscription",
    status: "canceled",
    customer: CUSTOMER
  });
}

// ---------------------------------------------------------------------------
// Webhooks — checkout.session.completed
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/stripe — checkout.session.completed", () => {
  it("attaches the subscription row and audits it (§14.3 / §22)", async () => {
    const h = makeHarness();
    const res = await postWebhook(h, attachSessionEvent("evt_attach_1", "pro"));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ handled: true, duplicate: false });
    expect(h.db.subscriptions.length).toBe(1);
    expect(h.db.subscriptions[0]).toMatchObject({
      organizationId: ORG_A,
      planId: PLAN_PRO_ID,
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: SUBSCRIPTION,
      status: "active"
    });
    expect(
      h.audit.entries.some((entry) => entry.action === "billing.subscription.attached")
    ).toBe(true);

    // Same event id again: idempotent — one row, one audit entry, no second claim.
    const replay = await postWebhook(h, attachSessionEvent("evt_attach_1", "pro"));
    expect(replay.json).toMatchObject({ handled: true, duplicate: true });
    expect(h.db.subscriptions.length).toBe(1);
    expect(
      h.audit.entries.filter((entry) => entry.action === "billing.subscription.attached").length
    ).toBe(1);
  });

  it("skips sessions that cannot be attributed to a workspace", async () => {
    const h = makeHarness();
    const payload = eventJson("evt_anon_1", "checkout.session.completed", {
      id: "cs_anon",
      object: "checkout.session",
      mode: "subscription",
      customer: "cus_z",
      subscription: "sub_z"
    });
    const res = await postWebhook(h, payload);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ handled: false, duplicate: false });
    // No claim row: a later redelivery carrying metadata still processes.
    expect(h.db.idempotency.length).toBe(0);
    expect(h.db.subscriptions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Webhooks — invoice.paid (idempotency, §14.2 rule 6)
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/stripe — invoice.paid", () => {
  it("grants the plan's monthly credits exactly once per event id (§14.2 r6)", async () => {
    const h = makeHarness();
    await postWebhook(h, attachSessionEvent("evt_attach_2", "pro"));

    const first = await postWebhook(h, invoicePaidEvent("evt_invoice_1", "price_pro"));
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ handled: true, duplicate: false });
    expect(h.ledger.grants.length).toBe(1);
    expect(h.ledger.grants[0]).toMatchObject({
      organizationId: ORG_A,
      credits: 250, // §14.1 pro plan monthly credits
      idempotencyKey: "stripe:evt_invoice_1",
      kind: "grant"
    });

    // Replay the same event id: the claim short-circuits — no second grant.
    const second = await postWebhook(h, invoicePaidEvent("evt_invoice_1", "price_pro"));
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ handled: true, duplicate: true });
    expect(h.ledger.grants.length).toBe(1);
    expect(h.db.idempotency.filter((row) => row.key === "evt_invoice_1")).toHaveLength(1);
  });

  it("resolves the plan by price id and grants the max tier's 600 credits", async () => {
    const h = makeHarness();
    await postWebhook(h, attachSessionEvent("evt_attach_3", "starter"));
    const res = await postWebhook(h, invoicePaidEvent("evt_invoice_2", "price_max"));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ handled: true, duplicate: false });
    expect(h.ledger.grants[0]).toMatchObject({ credits: 600 });
    // Webhooks are the source of truth (§14.3): the row follows what was paid.
    expect(h.db.subscriptions[0]).toMatchObject({ planId: PLAN_BUSINESS_ID, status: "active" });
  });

  it("skips invoices for customers with no attached subscription", async () => {
    const h = makeHarness();
    const payload = eventJson("evt_invoice_3", "invoice.paid", {
      id: "in_x",
      object: "invoice",
      customer: "cus_unknown",
      status: "paid"
    });
    const res = await postWebhook(h, payload);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ handled: false });
    expect(h.ledger.grants.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Webhooks — signature verification (§15.2)
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/stripe — signature verification", () => {
  it("rejects a bad signature with a typed 400 and applies nothing", async () => {
    const h = makeHarness();
    await postWebhook(h, attachSessionEvent("evt_attach_4", "pro"));
    const res = await postWebhook(h, invoicePaidEvent("evt_invoice_4", "price_pro"), {
      secret: "whsec_wrong_secret"
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({
      ok: false,
      code: "invalid_signature",
      retryable: false
    });
    expect(h.ledger.grants.length).toBe(0);
    expect(h.db.idempotency.length).toBe(1); // only the attach claim
  });

  it("rejects a missing Stripe-Signature header with 400", async () => {
    const h = makeHarness();
    const res = await postWebhook(h, invoicePaidEvent("evt_invoice_5", "price_pro"), {
      omitSignature: true
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_signature");
    expect(h.db.idempotency.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Webhooks — customer.subscription.deleted (downgrade + audit)
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/stripe — customer.subscription.deleted", () => {
  it("downgrades the workspace and writes exactly one audit row", async () => {
    const h = makeHarness();
    await postWebhook(h, attachSessionEvent("evt_attach_5", "pro"));

    const first = await postWebhook(h, subscriptionDeletedEvent("evt_del_1"));
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ handled: true, duplicate: false });
    expect(h.db.subscriptions[0]?.status).toBe("canceled");

    const downgrades = h.audit.entries.filter(
      (entry) => entry.action === "billing.subscription.downgraded"
    );
    expect(downgrades.length).toBe(1);
    expect(downgrades[0]?.organizationId).toBe(ORG_A);
    expect(downgrades[0]?.actorId).toBeNull(); // system/webhook actor (§22)
    expect(downgrades[0]?.metadata).toMatchObject({
      reason: "customer.subscription.deleted",
      previousStatus: "active",
      status: "canceled"
    });

    // Replay: idempotent — no second downgrade, no second audit row.
    const replay = await postWebhook(h, subscriptionDeletedEvent("evt_del_1"));
    expect(replay.json).toMatchObject({ handled: true, duplicate: true });
    expect(h.db.subscriptions[0]?.status).toBe("canceled");
    expect(
      h.audit.entries.filter((entry) => entry.action === "billing.subscription.downgraded")
        .length
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Webhooks — unknown events (§15.2 logged no-op)
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/stripe — unknown events", () => {
  it("answers 200 and no-ops without claiming", async () => {
    const h = makeHarness();
    const payload = eventJson("evt_unknown_1", "customer.created", {
      id: "cus_new",
      object: "customer"
    });
    const res = await postWebhook(h, payload);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, received: true, handled: false, duplicate: false });
    expect(h.db.idempotency.length).toBe(0);
    expect(h.ledger.grants.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/billing/checkout — RBAC (§15.2, ADR-0003 row 8)
// ---------------------------------------------------------------------------

describe("POST /v1/billing/checkout", () => {
  const body = { planCode: "pro", workspaceId: ORG_A };

  it("is owner-gated: owner+admin pass, editor/viewer/non-member do not", async () => {
    const h = makeHarness();

    h.actAs(ALICE); // owner
    const owner = await callJson(h.app, "POST", "/v1/billing/checkout", body);
    expect(owner.status).toBe(200);
    expect(owner.json.ok).toBe(true);
    expect(String(owner.json.url)).toMatch(
      /^https:\/\/billing\.noop\.studio\.local\/checkout\/cs_noop_/
    );
    expect(typeof owner.json.session_id).toBe("string");

    // ADR-0003 row 8 grants admin too ("Billing (checkout/portal, credit
    // packs)"); the W4-N sketch said owner-only — the ADR matrix wins (W4-C
    // precedent for billing:manage).
    h.actAs(CAROL); // admin
    expect((await callJson(h.app, "POST", "/v1/billing/checkout", body)).status).toBe(200);

    h.actAs(BOB); // editor
    expect((await callJson(h.app, "POST", "/v1/billing/checkout", body)).status).toBe(403);

    h.actAs(DAN); // viewer
    expect((await callJson(h.app, "POST", "/v1/billing/checkout", body)).status).toBe(403);

    h.actAs(ERIN); // non-member — §15.1: existence is not disclosed
    expect((await callJson(h.app, "POST", "/v1/billing/checkout", body)).status).toBe(404);

    h.actAs(null); // unauthenticated
    expect((await callJson(h.app, "POST", "/v1/billing/checkout", body)).status).toBe(401);

    // No rejected call created a Stripe customer or subscription row.
    expect(h.db.subscriptions.length).toBe(0);
  });

  it("sells credit packs through a payment-mode checkout (§14.3)", async () => {
    const h = makeHarness();
    h.actAs(ALICE);
    const checkout = await callJson(h.app, "POST", "/v1/billing/checkout", {
      planCode: "pack",
      workspaceId: ORG_A
    });
    expect(checkout.status).toBe(200);

    const pack = eventJson("evt_pack_1", "checkout.session.completed", {
      id: "cs_pack",
      object: "checkout.session",
      mode: "payment",
      customer: CUSTOMER,
      metadata: { organizationId: ORG_A, planCode: "pack" }
    });
    const res = await postWebhook(h, pack);
    expect(res.json).toMatchObject({ handled: true, duplicate: false });
    expect(h.ledger.grants.length).toBe(1);
    expect(h.ledger.grants[0]).toMatchObject({
      organizationId: ORG_A,
      credits: 100, // §14.1 pack: $10 → 100 credits
      kind: "pack",
      idempotencyKey: "stripe:evt_pack_1"
    });
    expect(h.db.subscriptions.length).toBe(0); // packs are not subscriptions
  });

  it("rejects an unknown planCode with 422 (Zod boundary)", async () => {
    const h = makeHarness();
    h.actAs(ALICE);
    const res = await callJson(h.app, "POST", "/v1/billing/checkout", {
      planCode: "enterprise",
      workspaceId: ORG_A
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/billing/portal
// ---------------------------------------------------------------------------

describe("POST /v1/billing/portal", () => {
  it("404s before a subscription exists, then opens a portal session", async () => {
    const h = makeHarness();
    h.actAs(ALICE);
    const before = await callJson(h.app, "POST", "/v1/billing/portal", { workspaceId: ORG_A });
    expect(before.status).toBe(404);
    expect(before.json.code).toBe("no_subscription");

    await postWebhook(h, attachSessionEvent("evt_attach_6", "pro"));
    const after = await callJson(h.app, "POST", "/v1/billing/portal", { workspaceId: ORG_A });
    expect(after.status).toBe(200);
    expect(String(after.json.url)).toMatch(
      /^https:\/\/billing\.noop\.studio\.local\/portal\//
    );

    h.actAs(BOB); // editor — portal is billing:manage gated too
    const editor = await callJson(h.app, "POST", "/v1/billing/portal", { workspaceId: ORG_A });
    expect(editor.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/billing/plans — public §14.1 catalog from @studio/config
// ---------------------------------------------------------------------------

describe("GET /v1/billing/plans", () => {
  it("is public and lists the §14.1 plan cards", async () => {
    const h = makeHarness();
    h.actAs(null); // no auth required — marketing/billing pages
    const res = await callJson(h.app, "GET", "/v1/billing/plans");
    expect(res.status).toBe(200);

    const cards = res.json.plans as Array<Record<string, unknown>>;
    expect(cards.map((card) => card.code)).toEqual(["starter", "pro", "max"]);
    expect(cards[0]).toMatchObject({
      monthly_price_usd_cents: 3000,
      monthly_credits: 100,
      extra_seat_price_usd_cents: 800,
      seats: 1,
      concurrent_runs: 1,
      max_canvas_megapixels: 32,
      daily_spend_cap_credits: 200
    });
    expect(cards[2]).toMatchObject({
      monthly_price_usd_cents: 12000,
      monthly_credits: 600,
      seats: 10,
      concurrent_runs: 6,
      max_canvas_megapixels: 128
    });
    expect(res.json.credit_pack).toEqual({ credits: 100, price_usd_cents: 1000 });
    expect(res.json.credit_price_usd_cents).toBe(10);
  });
});
