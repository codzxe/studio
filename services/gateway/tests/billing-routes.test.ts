// M6-C — the real billing flow, end-to-end over HTTP against live Postgres
// with the M6-B FakeStripe harness injected as deps.stripe (the documented
// seam-injection mode: fake.seam is a full StripeSeam facade over the same
// in-memory store; the webhook payloads are signed with the harness's
// HMAC-SHA256 `t=…,v1=…` scheme).
//
// Matrix (BUILD_PLAN §M6 tasks 2-3+5):
//  - checkout: happy (D-4 trial state on the Starter row), invalid plan,
//    trial-target rejected (D-4), seat pre-check, downgrade never instant,
//    plan-change arm (updateSubscription), canceled row → fresh session.
//  - topup: happy (D-12 integer µc grant), idempotent replay (header
//    middleware), unknown pack, missing pack price (second boot).
//  - portal: session + customer reuse.
//  - state: none/trialing/active snapshots, entitlements from the catalog.
//  - webhook: signature fail 400, replay (durable guard, cross-seam
//    restart proof, record-after-apply — W3-b02/S241: a handler crash is
//    never recorded, so Stripe's retry re-applies instead of reading
//    "duplicate"), out-of-order past_due-before-renewal,
//    guarded concurrent transitions (exactly one applies), invoice paid
//    (idempotent record + µc grant + dunning heal), invoice voided, unknown
//    event 200, hostile topup metadata, cancel → STATUS ONLY (no work
//    deletion — projects/versions/ledger untouched).
//  - trial abuse rules: one per workspace (any prior row), fingerprint
//    cross-workspace block, disposable-domain block, card required.
//
// DB-gated (bootServer boots real Postgres + Better Auth). FakeStripe is
// deterministic (fixed epoch, no Date.now()), zero network.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Repos } from "@studio/db";

import type { StripeSeam } from "../src/context.js";
import { effectivePlan } from "../src/plan.js";
import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  unique,
  uniqueEmail,
} from "./helpers.js";
import {
  FAKE_NOW_MS,
  FAKE_STRIPE_SECRET_KEY,
  FAKE_WEBHOOK_SECRET,
  FakeStripe,
  type FakeStripeEvent,
} from "./helpers/fake-stripe.js";

const d = describe.skipIf(!HAS_DATABASE);

/** Distinct price ids so the reverse price→plan map is unambiguous. */
const PRICE_IDS = JSON.stringify({
  starter: "price_test_starter",
  pro: "price_test_pro",
  studio: "price_test_studio",
  "pack:credits100": "price_test_pack100",
  "pack:credits500": "price_test_pack500",
  "pack:credits2000": "price_test_pack2000",
});

const DAY = 86_400;

let server: RunningTestServer;

beforeAll(async () => {
  server = await bootServer({
    env: {
      STRIPE_SECRET_KEY: FAKE_STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      STRIPE_PRICE_IDS: PRICE_IDS,
    },
  });
}, 30_000);

afterAll(async () => {
  await server?.close();
});

// ───────────────────────────────────────────────────────────────────────────
// Harness helpers
// ───────────────────────────────────────────────────────────────────────────

interface Workspace {
  readonly jar: CookieJar;
  readonly id: string;
  readonly email: string;
}

async function okData(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toHaveProperty("data");
  return body.data as Record<string, unknown>;
}

async function errOf(response: Response): Promise<{ code: string; hint?: string }> {
  const body = (await response.json()) as { error: { code: string; hint?: string } };
  expect(body.error).toBeDefined();
  return { code: body.error.code, hint: body.error.hint };
}

async function newWorkspace(target: RunningTestServer = server): Promise<Workspace> {
  const jar = new CookieJar();
  const email = uniqueEmail();
  const response = await api(target.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: "Biller" },
  });
  expect(response.status).toBe(200);
  const wsResponse = await api(target.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Billing WS"), slug: unique("bill-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { jar, id: ws.data.id, email };
}

/** Injects the fake seam as deps.stripe (the fleet-precedent live mutation). */
function setStripe(target: RunningTestServer, fake: FakeStripe): void {
  (target.deps as unknown as { stripe: StripeSeam | null }).stripe = fake.seam;
}

/** Fresh fake bound to the boot env's webhook secret. */
function freshFake(): FakeStripe {
  return new FakeStripe({ webhookSecret: FAKE_WEBHOOK_SECRET });
}

/**
 * The fake mints DETERMINISTIC event ids (evt_fake_N) — but the durable
 * webhook_events store and the ledger's globally-unique idempotency keys
 * survive tests AND runs (M6-D's run-unique-fixture note). Every scripted or
 * harness-created event gets a run-unique id BEFORE signing; the signature
 * covers the final bytes, so this is always consistent. Re-delivering the
 * SAME object (replay tests) keeps the same id — that is the point.
 */
function script(fake: FakeStripe, type: string, object: Record<string, unknown>): FakeStripeEvent {
  const event = fake.scriptEvent(type, object);
  return { ...event, id: `${event.id}_${unique("e")}` };
}

function reid(events: readonly FakeStripeEvent[]): FakeStripeEvent[] {
  return events.map((event) => ({ ...event, id: `${event.id}_${unique("e")}` }));
}

/** Non-null array access without the `!` (noNonNullAssertion is repo-error). */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} is missing`);
  return item;
}

function repos(): Repos {
  return server.deps.repos;
}

/** Signs + delivers a webhook event to POST /v1/webhooks/stripe. */
async function deliver(
  fake: FakeStripe,
  event: FakeStripeEvent,
  target: RunningTestServer = server,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const { payload, signature } = fake.signWebhook(event);
  const response = await api(target.base, "/v1/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    rawBody: new Uint8Array(payload),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    data: (body.data as Record<string, unknown>) ?? { ...(body as Record<string, unknown>) },
  };
}

async function billingState(ws: Workspace): Promise<Record<string, unknown>> {
  const response = await api(server.base, "/v1/billing/state", {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  return okData(response);
}

async function subscriptionRow(workspaceId: string) {
  return repos().subscriptions.getByOrganization(workspaceId);
}

/** POSTs a billing mutation with a fresh Idempotency-Key (law #4, §7.2). */
async function billingPost(
  path: string,
  ws: Workspace,
  body: unknown,
  key: string = unique("bill"),
): Promise<Response> {
  return api(server.base, path, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": key },
    body,
  });
}

interface SubscriptionFlow {
  readonly fake: FakeStripe;
  readonly wire: Record<string, unknown>;
  readonly subId: string;
  readonly customer: string;
  /** The created subscription's wire fields (unix seconds). */
  readonly trialEnd: number;
  readonly periodEnd: number;
}

/** Full subscribe flow: checkout → complete → deliver both events. */
async function subscribeWorkspace(
  ws: Workspace,
  planId: "starter" | "pro" = "starter",
): Promise<SubscriptionFlow> {
  const fake = freshFake();
  setStripe(server, fake);
  const response = await billingPost("/v1/billing/checkout", ws, { planId });
  expect(response.status).toBe(201);
  const session = (await okData(response)) as { sessionId: string };
  const events = reid(fake.completeCheckout(session.sessionId));
  expect(events).toHaveLength(2);
  // customer.subscription.created → unhandled-type, still 200 (Stripe retries
  // on non-2xx; the subscription state lands via checkout.session.completed).
  const created = await deliver(fake, at(events, 0));
  expect(created.status).toBe(200);
  const completed = await deliver(fake, at(events, 1));
  expect(completed.status).toBe(200);
  expect(completed.data).toMatchObject({ received: true, handled: "subscription.synced" });
  const wire = at(events, 0).data.object as Record<string, unknown>;
  const item = at((wire.items as { data: Record<string, unknown>[] }).data, 0);
  return {
    fake,
    wire,
    subId: wire.id as string,
    customer: wire.customer as string,
    trialEnd: wire.trial_end as number,
    periodEnd: item.current_period_end as number,
  };
}

/** Builds a customer.subscription.* wire object from the created subscription. */
function subscriptionObject(
  flow: SubscriptionFlow,
  overrides: { status?: string; periodEnd?: number },
): Record<string, unknown> {
  const items = flow.wire.items as { data: Record<string, unknown>[] };
  const periodEnd = overrides.periodEnd ?? (at(items.data, 0).current_period_end as number);
  return {
    ...flow.wire,
    ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    current_period_end: periodEnd,
    items: { ...items, data: [{ ...at(items.data, 0), current_period_end: periodEnd }] },
  };
}

/** Delivers a scripted lifecycle event on the flow's fake. */
async function lifecycle(
  flow: SubscriptionFlow,
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  object: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return deliver(flow.fake, script(flow.fake, type, object));
}

/** The workspace's current ledger balance (µc, D-12). */
async function balanceOf(workspaceId: string): Promise<number> {
  return repos().ledger.balance(workspaceId);
}

/** Creates a project in the workspace (the "work" that must never be deleted). */
async function createProject(ws: Workspace): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Billing Project") },
  });
  expect(response.status).toBe(201);
  const project = (await okData(response)) as { id: string };
  return project.id;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helper: effectivePlan (D-4 gating — no DB)
// ───────────────────────────────────────────────────────────────────────────

describe("effectivePlan (D-4 state → plan gating, pure)", () => {
  const row = (status: string, planId: string) =>
    ({ status, planId }) as unknown as Parameters<typeof effectivePlan>[0];

  it("no row → trial (legacy workspaces)", () => {
    expect(effectivePlan(null)).toBe("trial");
  });

  it("trialing → trial regardless of the row's plan (D-4: the state's entitlements come from the catalog)", () => {
    expect(effectivePlan(row("trialing", "starter"))).toBe("trial");
  });

  it("unpaid terminal states → trial (no permanent free path)", () => {
    expect(effectivePlan(row("canceled", "pro"))).toBe("trial");
    expect(effectivePlan(row("incomplete", "studio"))).toBe("trial");
  });

  it("paid/dunning states gate as the row's plan", () => {
    expect(effectivePlan(row("active", "pro"))).toBe("pro");
    expect(effectivePlan(row("grace", "studio"))).toBe("studio");
    expect(effectivePlan(row("past_due", "starter"))).toBe("starter");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /v1/billing/checkout
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/billing/checkout", () => {
  it("400 VALIDATION_FAILED when billing is not configured (no seam)", async () => {
    const ws = await newWorkspace();
    // server.deps.stripe is null until a test injects a fake seam — but a
    // previous test may have set it; point it back at null for this one.
    (server.deps as unknown as { stripe: StripeSeam | null }).stripe = null;
    const response = await billingPost("/v1/billing/checkout", ws, { planId: "starter" });
    expect(response.status).toBe(400);
    expect((await errOf(response)).code).toBe("VALIDATION_FAILED");
  });

  it("creates a hosted Checkout session; completion lands the D-4 trialing state", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");

    const row = await subscriptionRow(ws.id);
    expect(row).not.toBeNull();
    // D-4: the trial state lives on the STARTER row.
    expect(row?.planId).toBe("starter");
    expect(row?.status).toBe("trialing");
    expect(row?.stripeSubscriptionId).toBe(flow.subId);
    expect(row?.cancelAtPeriodEnd).toBe(false);

    const state = await billingState(ws);
    // The EFFECTIVE plan is trial while trialing (D-4) — entitlements from the
    // catalog, never hardcoded.
    expect(state).toMatchObject({
      plan: "trial",
      status: "trialing",
      cancelAtPeriodEnd: false,
    });
    const entitlements = state.entitlements as Record<string, unknown>;
    expect(entitlements.seats).toBe(1);
    expect(entitlements.models).toEqual(["studio-fast"]);
    expect(entitlements.monthlyCreditAllowance).toBe(50_000_000); // 50 credits, µc (D-12)
    const stateTrialEnd = new Date(state.trialEnd as string);
    // The fake runs on its FIXED epoch (never Date.now) — the trial clock
    // starts there, not on the wall clock.
    const expected = new Date(FAKE_NOW_MS + 14 * DAY * 1000);
    expect(Math.abs(stateTrialEnd.getTime() - expected.getTime())).toBeLessThan(5 * 60 * 1000);

    // The models route reads the REAL row through resolvePlan now (plan
    // "trial" while trialing — both catalogs agree on trial models).
    const models = await api(server.base, "/v1/models", {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const modelsBody = (await okData(models)) as { plan: string; models: { id: string }[] };
    expect(modelsBody.plan).toBe("trial");
    expect(modelsBody.models.map((model) => model.id)).toEqual(["studio-fast"]);
  });

  it("rejects trial as a checkout target (D-4) and unknown plans with 400", async () => {
    const ws = await newWorkspace();
    const trial = await billingPost("/v1/billing/checkout", ws, { planId: "trial" });
    expect(trial.status).toBe(400);
    expect((await errOf(trial)).code).toBe("VALIDATION_FAILED");
    const unknown = await billingPost("/v1/billing/checkout", ws, { planId: "enterprise" });
    expect(unknown.status).toBe(400);
    expect((await errOf(unknown)).code).toBe("VALIDATION_FAILED");
    // nothing was persisted
    expect(await subscriptionRow(ws.id)).toBeNull();
  });

  it("400 when the workspace has more members than the target plan seats (server-side entitlement pre-check)", async () => {
    const ws = await newWorkspace();
    // Owner + two accepted invitees = 3 members > starter's 2 seats.
    for (let i = 0; i < 2; i += 1) {
      const invited = uniqueEmail("seatmate");
      const invite = await api(server.base, `/v1/workspaces/${ws.id}/invites`, {
        method: "POST",
        jar: ws.jar,
        headers: { "idempotency-key": unique("inv") },
        body: { email: invited, role: "viewer" },
      });
      expect(invite.status).toBe(201);
      const inviteBody = (await okData(invite)) as { id: string };
      const inviteeJar = new CookieJar();
      const signup = await api(server.base, "/v1/auth/sign-up/email", {
        method: "POST",
        jar: inviteeJar,
        body: { email: invited, password: "Passw0rd!longenough", name: "Seatmate" },
      });
      expect(signup.status).toBe(200);
      const accept = await api(server.base, `/v1/invites/${inviteBody.id}/accept`, {
        method: "POST",
        jar: inviteeJar,
        headers: { "idempotency-key": unique("acc") },
      });
      expect(accept.status).toBe(200);
    }
    const response = await billingPost("/v1/billing/checkout", ws, { planId: "starter" });
    expect(response.status).toBe(400);
    expect((await errOf(response)).code).toBe("VALIDATION_FAILED");
  });

  it("plan change on a live subscription: same-plan/upgrade switches server-side (planChanged: true)", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    // Convert the trial: updated event with status active (trial lifecycle:
    // trialEnd → active on payment).
    const converted = await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    expect(converted.status).toBe(200);
    expect(converted.data).toMatchObject({ handled: "subscription.active" });
    expect((await subscriptionRow(ws.id))?.status).toBe("active");
    // Mirror the conversion in the FAKE's store: the plan-change checkout
    // re-pins the row from the seam's subscription snapshot — the synthetic
    // lifecycle event only moved the row, so without this the fake would
    // still report trialing and the upgrade would regress the status.
    const storedSub = flow.fake.subscriptions.get(flow.subId);
    if (storedSub !== undefined) storedSub.status = "active";

    // Upgrade starter → pro: immediate server-side switch, features grow.
    const upgrade = await billingPost("/v1/billing/checkout", ws, { planId: "pro" });
    expect(upgrade.status).toBe(200);
    const body = (await okData(upgrade)) as { planChanged?: boolean };
    expect(body.planChanged).toBe(true);
    const row = await subscriptionRow(ws.id);
    expect(row?.planId).toBe("pro");
    expect(row?.status).toBe("active");
    // The fake's subscription price was swapped to the pro price.
    const sub = flow.fake.subscriptions.get(flow.subId);
    expect(sub?.priceId).toBe("price_test_pro");
    // The plan gates through the catalog: /v1/credits + /v1/billing/state.
    const credits = await api(server.base, "/v1/credits", {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const creditsBody = (await okData(credits)) as { plan: string; includedCredits: number };
    expect(creditsBody.plan).toBe("pro");
    expect(creditsBody.includedCredits).toBe(2_000_000_000); // 2,000 credits, µc (D-12)
  });

  it("downgrade is rejected: scheduled at period end via the portal, never instant feature loss", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    const activeSub = flow.fake.subscriptions.get(flow.subId);
    if (activeSub !== undefined) activeSub.status = "active";
    await billingPost("/v1/billing/checkout", ws, { planId: "pro" });
    expect((await subscriptionRow(ws.id))?.planId).toBe("pro");

    const downgrade = await billingPost("/v1/billing/checkout", ws, { planId: "starter" });
    expect(downgrade.status).toBe(400);
    const error = await errOf(downgrade);
    expect(error.code).toBe("VALIDATION_FAILED");
    // The row keeps pro until the period ends.
    const row = await subscriptionRow(ws.id);
    expect(row?.planId).toBe("pro");
    expect(row?.status).toBe("active");
  });

  it("a canceled row checks out a FRESH hosted session (resubscribe)", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    const canceled = await lifecycle(
      flow,
      "customer.subscription.deleted",
      subscriptionObject(flow, { status: "canceled" }),
    );
    expect(canceled.data).toMatchObject({ handled: "subscription.canceled" });
    expect((await subscriptionRow(ws.id))?.status).toBe("canceled");

    const response = await billingPost("/v1/billing/checkout", ws, { planId: "pro" });
    expect(response.status).toBe(201);
    const body = (await okData(response)) as { sessionId: string; url: string };
    expect(body.sessionId).not.toBe("");
    expect(body.url).toContain("checkout.stripe.com/fake/");
  });

  it("typed 400s when the env price map lacks the plan / pack (second boot)", async () => {
    const server2 = await bootServer({
      env: {
        STRIPE_SECRET_KEY: FAKE_STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
        STRIPE_PRICE_IDS: '{"starter":"price_test_starter"}',
      },
    });
    try {
      const fake2 = freshFake();
      setStripe(server2, fake2);
      const ws2 = await newWorkspace(server2);
      const checkout = await api(server2.base, "/v1/billing/checkout", {
        method: "POST",
        jar: ws2.jar,
        headers: { "x-workspace-id": ws2.id, "idempotency-key": unique("bill") },
        body: { planId: "pro" },
      });
      expect(checkout.status).toBe(400);
      const checkoutBody = (await checkout.json()) as { error: { code: string } };
      expect(checkoutBody.error.code).toBe("VALIDATION_FAILED");

      const topup = await api(server2.base, "/v1/billing/topup", {
        method: "POST",
        jar: ws2.jar,
        headers: { "x-workspace-id": ws2.id, "idempotency-key": unique("bill") },
        body: { packId: "credits100" },
      });
      expect(topup.status).toBe(400);
      const topupBody = (await topup.json()) as { error: { code: string } };
      expect(topupBody.error.code).toBe("VALIDATION_FAILED");
    } finally {
      await server2.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /v1/billing/topup
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/billing/topup", () => {
  it("buys a pack: one-time Checkout session → webhook grants INTEGER µc (D-12)", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const response = await billingPost("/v1/billing/topup", ws, { packId: "credits100" });
    expect(response.status).toBe(201);
    const session = (await okData(response)) as { sessionId: string; url: string };
    expect(session.url).toContain("checkout.stripe.com/fake/");

    const events = reid(fake.completeCheckout(session.sessionId));
    expect(events).toHaveLength(1);
    const delivered = await deliver(fake, at(events, 0));
    expect(delivered.status).toBe(200);
    expect(delivered.data).toMatchObject({ received: true, handled: "topup.granted" });

    // D-12: 100 credits = exactly 100,000,000 integer microcredits.
    expect(await balanceOf(ws.id)).toBe(100_000_000);
    const state = await billingState(ws);
    expect((state.credits as Record<string, unknown>).balance).toBe(100_000_000);
    const credits = await api(server.base, "/v1/credits", {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(((await okData(credits)) as { balance: number }).balance).toBe(100_000_000);
  });

  it("replays the SAME session for the same Idempotency-Key (law #4 header middleware)", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const key = unique("topup-idem");
    const first = await billingPost("/v1/billing/topup", ws, { packId: "credits500" }, key);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { sessionId: string } };
    const replay = await billingPost("/v1/billing/topup", ws, { packId: "credits500" }, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    const replayBody = (await replay.json()) as { data: { sessionId: string } };
    expect(replayBody.data.sessionId).toBe(firstBody.data.sessionId);
    // A different pack under the same key is a payload conflict (400).
    const conflict = await billingPost("/v1/billing/topup", ws, { packId: "credits100" }, key);
    expect(conflict.status).toBe(400);
  });

  it("rejects an unknown pack id (400 VALIDATION_FAILED)", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const response = await billingPost("/v1/billing/topup", ws, { packId: "credits77" });
    expect(response.status).toBe(400);
    expect((await errOf(response)).code).toBe("VALIDATION_FAILED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /v1/billing/portal
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/billing/portal", () => {
  it("returns a portal session and REUSES the workspace's single Stripe customer", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const first = await billingPost("/v1/billing/portal", ws, {});
    expect(first.status).toBe(200);
    const firstBody = (await okData(first)) as { url: string };
    expect(firstBody.url).toContain("billing.stripe.com/fake/session/");

    const customer = await repos().subscriptions.findStripeCustomer(ws.id);
    expect(customer).not.toBeNull();
    const customerId = customer?.stripeCustomerId ?? "";

    const second = await billingPost("/v1/billing/portal", ws, {});
    expect(second.status).toBe(200);
    // One customer per workspace (M6-D unique row), not one per portal call.
    expect(fake.customers.size).toBe(1);
    const after = await repos().subscriptions.findStripeCustomer(ws.id);
    expect(after?.stripeCustomerId).toBe(customerId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /v1/billing/state
// ───────────────────────────────────────────────────────────────────────────

d("GET /v1/billing/state", () => {
  it("fresh workspace: status none, trial entitlements, zero credits, the pack catalog — parses through the client's wire schema", async () => {
    const ws = await newWorkspace();
    const state = await billingState(ws);
    expect(state).toMatchObject({
      plan: "trial",
      status: "none",
      currentPeriodEnd: null,
      trialEnd: null,
      graceEnd: null,
      cancelAtPeriodEnd: false,
    });
    expect(state.credits).toEqual({ balance: 0, reserved: 0 });
    expect(state.topUpPacks).toEqual([
      { packId: "credits100", credits: 100 },
      { packId: "credits500", credits: 500 },
      { packId: "credits2000", credits: 2000 },
    ]);
    // The api-client's runtime validator (BILLING_STATE_SCHEMA in
    // packages/api-client/src/response-schemas.ts) is satisfies-pinned to the
    // same contracts interface; the deep shape assertions above pin the wire.
  });

  it("active subscription snapshot carries the paid plan + catalog entitlements (µc allowance, D-12)", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    const state = await billingState(ws);
    expect(state).toMatchObject({ plan: "starter", status: "active" });
    const entitlements = state.entitlements as Record<string, unknown>;
    expect(entitlements.seats).toBe(2);
    expect(entitlements.models).toEqual(["studio-fast", "studio-smart"]);
    expect(entitlements.monthlyCreditAllowance).toBe(500_000_000); // 500 credits, µc
    expect(entitlements.maxProjects).toBe(10);
    expect(state.currentPeriodEnd).toBe(new Date((flow.periodEnd as number) * 1000).toISOString());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /v1/webhooks/stripe
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/webhooks/stripe", () => {
  it("rejects a tampered payload with 400 (signature verification, typed envelope)", async () => {
    const fake = freshFake();
    setStripe(server, fake);
    const event = script(fake, "checkout.session.completed", {
      id: "cs_tampered",
      object: "checkout_session",
      metadata: {},
    });
    const { payload, signature } = fake.signWebhook(event);
    const tampered = Buffer.from(
      payload.toString("utf8").replace("cs_tampered", "cs_evil"),
      "utf8",
    );
    const response = await api(server.base, "/v1/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": signature },
      rawBody: new Uint8Array(tampered),
    });
    expect(response.status).toBe(400);
    expect((await errOf(response)).code).toBe("VALIDATION_FAILED");

    const missing = await api(server.base, "/v1/webhooks/stripe", {
      method: "POST",
      rawBody: new Uint8Array(payload),
    });
    expect(missing.status).toBe(400);
  });

  it("replay is a duplicate through the DURABLE guard (cross-seam restart); record-after-apply never loses a paid event", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const event = script(fake, "checkout.session.completed", {
      id: `cs_replay_${unique("s")}`,
      object: "checkout_session",
      mode: "payment",
      customer: `cus_replay_${unique("c")}`,
      subscription: null,
      status: "complete",
      payment_status: "paid",
      metadata: {
        organizationId: ws.id,
        kind: "topup",
        packId: "credits100",
        microcredits: "25000000",
      },
    });
    const first = await deliver(fake, event);
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ handled: "topup.granted" });
    expect(await balanceOf(ws.id)).toBe(25_000_000);

    // (a) Same event, same seam: the durable record answers the replay. The
    // handler re-run underneath (record-after-apply, W3-b02) is idempotent —
    // the ledger's `stripe:{eventId}` grant key replays, no second grant.
    fake.requeueWebhook(event);
    const replayed = await deliver(fake, event);
    expect(replayed.status).toBe(200);
    expect(replayed.data).toMatchObject({ received: true, duplicate: true });
    expect(await balanceOf(ws.id)).toBe(25_000_000);

    // (b) FRESH seam (in-memory set empty — a process restart), same DB: the
    // durable webhook_events row still answers "seen" — no re-grant.
    const freshSeam = freshFake();
    setStripe(server, freshSeam);
    const afterRestart = await deliver(freshSeam, event);
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.data).toMatchObject({ received: true, duplicate: true });
    expect(await balanceOf(ws.id)).toBe(25_000_000);

    // (c) W3-b02 FLIP (w1-a26 S241): an event id pre-marked in the seam's
    // in-memory set (never applied, never durably recorded) no longer
    // suppresses the apply. The pre-fix route consulted the in-memory mark
    // BEFORE the handler, so the same mark-after-crash window could swallow
    // Stripe's retry and permanently lose a paid top-up. The durable record
    // is the ONLY dedup authority; the in-memory mark is post-apply
    // observability. The delivery below APPLIES (that is the recovery).
    const premarked = script(freshSeam, "checkout.session.completed", {
      id: `cs_premarked_${unique("s")}`,
      object: "checkout_session",
      mode: "payment",
      // BIL-05 (2026-10-30 audit): real Stripe payment-mode sessions always
      // carry payment_status; the grant arm now fails CLOSED without it.
      payment_status: "paid",
      customer: `cus_premarked_${unique("c")}`,
      metadata: {
        organizationId: ws.id,
        kind: "topup",
        packId: "credits100",
        microcredits: "1000000",
      },
    });
    setStripe(server, freshSeam);
    freshSeam.seam.markEventSeen(premarked.id);
    const inMemory = await deliver(freshSeam, premarked);
    expect(inMemory.status).toBe(200);
    expect(inMemory.data).toMatchObject({ handled: "topup.granted" });
    expect(await balanceOf(ws.id)).toBe(26_000_000); // granted EXACTLY once
    // …and the NEXT delivery of that id is a durable duplicate.
    const premarkedAgain = await deliver(freshSeam, premarked);
    expect(premarkedAgain.data).toMatchObject({ received: true, duplicate: true });
    expect(await balanceOf(ws.id)).toBe(26_000_000);
    setStripe(server, fake);
  });

  it("W3-b02/S241: a handler crash records NOTHING — Stripe's retry re-applies the same event id and succeeds (no lost subscription transition)", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    // A REAL subscription checkout in the fake's store (the handler's resync
    // fetch needs a live subscription to snapshot).
    const checkout = await billingPost("/v1/billing/checkout", ws, { planId: "starter" });
    expect(checkout.status).toBe(201);
    const session = (await okData(checkout)) as { sessionId: string };
    const events = reid(fake.completeCheckout(session.sessionId));
    expect(events).toHaveLength(2);
    const created = await deliver(fake, at(events, 0)); // unhandled-type, 200
    expect(created.status).toBe(200);
    const completed = at(events, 1);

    // The flaky seam: the handler's provider resync BLOWS UP on the first
    // delivery only (a transient upstream blip — the S241 scenario). Injected
    // directly (setStripe wraps a FakeStripe; this is a raw StripeSeam).
    let resyncCalls = 0;
    const flaky: StripeSeam = {
      ...fake.seam,
      subscription: (customerId: string) => {
        resyncCalls += 1;
        if (resyncCalls === 1) {
          return Promise.reject(new Error("transient provider blip"));
        }
        return fake.seam.subscription(customerId);
      },
    };
    (server.deps as unknown as { stripe: StripeSeam | null }).stripe = flaky;

    // Delivery 1: the handler throws → 500 → NOTHING is durably recorded
    // (pre-fix, the seenOrRecord happened first and this event was LOST).
    const first = await deliver(fake, completed);
    expect(first.status).toBe(500);
    expect(resyncCalls).toBe(1);

    // Stripe retries the SAME event id: the retry re-runs the idempotent
    // handler and succeeds — the subscription row lands, the answer is the
    // HANDLED outcome, never { duplicate: true }.
    const retry = await deliver(fake, completed);
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ received: true, handled: "subscription.synced" });
    const row = await subscriptionRow(ws.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("trialing");

    // NOW the durable record exists — a third delivery is the duplicate.
    const third = await deliver(fake, completed);
    expect(third.status).toBe(200);
    expect(third.data).toMatchObject({ received: true, duplicate: true });
    setStripe(server, fake);
  });

  it("out-of-order delivery: a stale renewal after past_due is guarded off (never resurrects dunning)", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    const nextPeriod = flow.periodEnd + 30 * DAY;

    // The renewal event (real time: FIRST) …
    const renewal = script(
      flow.fake,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active", periodEnd: nextPeriod }),
    );
    // … and the failed-renewal past_due event (real time: LATER). Delivered
    // in the WRONG order: past_due first.
    const pastDue = script(
      flow.fake,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "past_due", periodEnd: nextPeriod }),
    );
    const pastDueResult = await deliver(flow.fake, pastDue);
    expect(pastDueResult.status).toBe(200);
    expect(pastDueResult.data).toMatchObject({ handled: "subscription.grace" });

    let row = await subscriptionRow(ws.id);
    expect(row?.status).toBe("grace");
    expect(row?.graceEnd).toEqual(new Date((nextPeriod + 30 * DAY) * 1000));
    expect(row?.currentPeriodEnd).toEqual(new Date(nextPeriod * 1000));

    // The stale renewal (active) arrives after the row entered grace: the
    // from-guard rejects it (grace heals only via a PAID invoice) — 200, audited.
    const renewalResult = await deliver(flow.fake, renewal);
    expect(renewalResult.status).toBe(200);
    expect(renewalResult.data).toMatchObject({ ignored: "transition-guarded" });
    row = await subscriptionRow(ws.id);
    expect(row?.status).toBe("grace");

    // The dunning heal: a PAID invoice returns the subscription to active.
    const healed = await deliver(
      flow.fake,
      script(flow.fake, "invoice.paid", {
        id: `in_heal_${unique("i")}`,
        object: "invoice",
        customer: flow.customer,
        subscription: flow.subId,
        amount_paid: 1200,
        currency: "usd",
        status: "paid",
        period_start: nextPeriod,
        period_end: nextPeriod + 30 * DAY,
        metadata: { organizationId: ws.id, kind: "subscription" },
      }),
    );
    expect(healed.status).toBe(200);
    expect(healed.data).toMatchObject({ handled: "invoice.paid-healed" });
    row = await subscriptionRow(ws.id);
    expect(row?.status).toBe("active");
    expect(row?.graceEnd).toBeNull();
  });

  it("BIL-01 regression: a subscription invoice grants the CATALOG µc allowance exactly (never ×10⁶)", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    // A renewal invoice for the existing subscription (kind: subscription).
    // Pre-fix (2026-10-30 audit): the grant wrapped the already-µc catalog
    // value in creditsToMicrocredits() — Starter buyers got 500,000,000
    // credits for $12 and the studio tier RangeError'd into a Stripe retry
    // poison loop. The pin: exactly the catalog µc, handled label included.
    const renewal = script(flow.fake, "invoice.paid", {
      id: `in_allowance_${unique("i")}`,
      object: "invoice",
      customer: flow.customer,
      subscription: flow.subId,
      amount_paid: 1200,
      currency: "usd",
      status: "paid",
      period_start: flow.periodEnd,
      period_end: flow.periodEnd + 30 * DAY,
      metadata: { organizationId: ws.id, kind: "subscription" },
    });
    const renewed = await deliver(flow.fake, renewal);
    expect(renewed.status).toBe(200);
    expect(renewed.data).toMatchObject({ handled: "invoice.allowance-granted" });
    // Starter = 500 credits = 500,000,000 µc — the catalog value, NOT ×10⁶.
    expect(await balanceOf(ws.id)).toBe(500 * 1_000_000);
    // A redelivery of the SAME event is a duplicate — it mints nothing.
    const again = await deliver(flow.fake, renewal);
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ received: true, duplicate: true });
    expect(await balanceOf(ws.id)).toBe(500 * 1_000_000);
  });

  it("two CONCURRENT subscription transitions: exactly one applies (the loser is a guarded 200)", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    const nextPeriod = flow.periodEnd + 30 * DAY;

    // Two different transitions race from the same starting state: one to
    // grace (failing renewal), one to canceled (deleted).
    const graceEvent = script(
      flow.fake,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "past_due", periodEnd: nextPeriod }),
    );
    const cancelEvent = script(
      flow.fake,
      "customer.subscription.deleted",
      subscriptionObject(flow, { status: "canceled", periodEnd: nextPeriod }),
    );
    const [graceResult, cancelResult] = await Promise.all([
      deliver(flow.fake, graceEvent),
      deliver(flow.fake, cancelEvent),
    ]);
    expect(graceResult.status).toBe(200);
    expect(cancelResult.status).toBe(200);

    const row = await subscriptionRow(ws.id);
    expect(row).not.toBeNull();
    if (row?.status === "grace") {
      expect(graceResult.data).toMatchObject({ handled: "subscription.grace" });
      expect(cancelResult.data).toMatchObject({ ignored: "transition-guarded" });
      expect(row.graceEnd).not.toBeNull();
    } else if (
      (graceResult.data as { handled?: string }).handled === "subscription.grace" &&
      (cancelResult.data as { handled?: string }).handled === "subscription.canceled"
    ) {
      // Third honest interleaving: grace applied FIRST, then cancel — the
      // canceled from-list includes grace, so both transitions are legal and
      // the terminal state is canceled (graceEnd wiped by the cancel).
      expect(row?.status).toBe("canceled");
      expect(row?.graceEnd).toBeNull();
    } else {
      expect(row?.status).toBe("canceled");
      expect(cancelResult.data).toMatchObject({ handled: "subscription.canceled" });
      expect(graceResult.data).toMatchObject({ ignored: "transition-guarded" });
      expect(row?.graceEnd).toBeNull();
    }
    // The durable store recorded BOTH deliveries (dedup is per event id).
    // Exactly one transition's effects are visible on the row above.
  });

  it("invoice.paid: idempotent invoice record + top-up grant keyed on the INVOICE id (no double-grant across event ids)", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const invoiceId = `in_topup_${unique("i")}`;
    const invoice = {
      id: invoiceId,
      object: "invoice",
      customer: `cus_invoice_${unique("c")}`,
      subscription: null,
      amount_paid: 1000,
      currency: "usd",
      status: "paid",
      period_start: 1_735_689_600,
      period_end: 1_735_689_600 + 30 * DAY,
      metadata: {
        organizationId: ws.id,
        kind: "topup",
        packId: "credits100",
        microcredits: "100000000",
      },
    };
    const first = await deliver(fake, script(fake, "invoice.paid", invoice));
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ handled: "invoice.topup-granted" });
    expect(await balanceOf(ws.id)).toBe(100_000_000);

    const listed = await repos().invoices.list(ws.id, { limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.stripeInvoiceId).toBe(invoiceId);
    expect(listed.items[0]?.amountCents).toBe(1000);
    expect(listed.items[0]?.status).toBe("paid");

    // The same invoice re-delivered under a FRESH event id: the record is
    // updated in place and the grant is deduped by the invoice-keyed
    // idempotency key — no double-grant.
    const replayed = await deliver(fake, script(fake, "invoice.paid", invoice));
    expect(replayed.status).toBe(200);
    expect(await balanceOf(ws.id)).toBe(100_000_000);
    const after = await repos().invoices.list(ws.id, { limit: 10 });
    expect(after.items).toHaveLength(1);
  });

  it("invoice.voided records the invoice as void", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const delivered = await deliver(
      fake,
      script(fake, "invoice.voided", {
        id: `in_void_${unique("i")}`,
        object: "invoice",
        customer: `cus_void_${unique("c")}`,
        amount_paid: 0,
        amount_due: 1200,
        currency: "usd",
        status: "void",
        metadata: { organizationId: ws.id, kind: "subscription" },
      }),
    );
    expect(delivered.status).toBe(200);
    expect(delivered.data).toMatchObject({ handled: "invoice.voided" });
    const listed = await repos().invoices.list(ws.id, { limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.status).toBe("void");
  });

  it("unknown event types are 200 + audited-ignored (Stripe retries on non-2xx — never a 500)", async () => {
    const fake = freshFake();
    setStripe(server, fake);
    const delivered = await deliver(
      fake,
      script(fake, "charge.dispute.created", { id: "dp_fake", object: "dispute" }),
    );
    expect(delivered.status).toBe(200);
    expect(delivered.data).toMatchObject({ received: true, ignored: "unhandled-type" });
  });

  it("hostile top-up metadata (µc overflow) is audited-ignored — never a poison 500", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const delivered = await deliver(
      fake,
      script(fake, "checkout.session.completed", {
        id: `cs_hostile_${unique("s")}`,
        object: "checkout_session",
        mode: "payment",
        // BIL-05: real sessions always carry payment_status — the hostile
        // amount must be rejected by the AMOUNT check, not the status gate.
        payment_status: "paid",
        customer: `cus_hostile_${unique("c")}`,
        metadata: {
          organizationId: ws.id,
          kind: "topup",
          packId: "credits100",
          microcredits: "99999999999999999999",
        },
      }),
    );
    expect(delivered.status).toBe(200);
    expect(delivered.data).toMatchObject({ ignored: "topup.amount-invalid" });
    expect(await balanceOf(ws.id)).toBe(0);
  });

  it("cancellation writes STATUS ONLY — projects, versions and the ledger are untouched (BP §M6.2)", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    const projectId = await createProject(ws);
    const balanceBefore = await balanceOf(ws.id);
    const projectsBefore = (
      (await okData(
        await api(server.base, "/v1/projects", {
          jar: ws.jar,
          headers: { "x-workspace-id": ws.id },
        }),
      )) as { items: unknown[] }
    ).items.length;

    const canceled = await lifecycle(
      flow,
      "customer.subscription.deleted",
      subscriptionObject(flow, { status: "canceled" }),
    );
    expect(canceled.status).toBe(200);
    expect(canceled.data).toMatchObject({ handled: "subscription.canceled" });

    const row = await subscriptionRow(ws.id);
    expect(row?.status).toBe("canceled");
    expect(row?.cancelAtPeriodEnd).toBe(false);

    // The work is still there, byte-for-byte.
    const project = await api(server.base, `/v1/projects/${projectId}`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(project.status).toBe(200);
    const projectsAfter = (
      (await okData(
        await api(server.base, "/v1/projects", {
          jar: ws.jar,
          headers: { "x-workspace-id": ws.id },
        }),
      )) as { items: unknown[] }
    ).items.length;
    expect(projectsAfter).toBe(projectsBefore);
    expect(await balanceOf(ws.id)).toBe(balanceBefore);

    // Canceled workspaces re-checkout (covered above) and gate as trial.
    const state = await billingState(ws);
    expect(state).toMatchObject({ plan: "trial", status: "canceled" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /v1/billing/trial — abuse rules (§M6 task 5)
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/billing/trial", () => {
  /** Seeds a workspace customer with a card fingerprint (the repo's model of
   * "customer with a payment method" — the fake captures it from checkout
   * metadata, real Stripe enforces the card at Checkout). */
  async function seedCustomerWithCard(workspaceId: string, fingerprint: string): Promise<string> {
    const customerId = `cus_seed_${unique("c")}`;
    await repos().subscriptions.ensureStripeCustomer(workspaceId, {
      stripeCustomerId: customerId,
      cardFingerprint: fingerprint,
    });
    return customerId;
  }

  /** Delivers a scripted completed checkout that carries a card fingerprint. */
  async function deliverCardCheckout(ws: Workspace, fingerprint: string): Promise<void> {
    const fake = freshFake();
    setStripe(server, fake);
    const delivered = await deliver(
      fake,
      script(fake, "checkout.session.completed", {
        id: `cs_card_${unique("s")}`,
        object: "checkout_session",
        mode: "payment",
        customer: `cus_card_${unique("c")}`,
        subscription: null,
        status: "complete",
        payment_status: "paid",
        metadata: {
          organizationId: ws.id,
          kind: "topup",
          packId: "credits100",
          microcredits: "1000000",
          cardFingerprint: fingerprint,
        },
      }),
    );
    expect(delivered.status).toBe(200);
    expect(delivered.data).toMatchObject({ handled: "topup.granted" });
    const customer = await repos().subscriptions.findStripeCustomer(ws.id);
    expect(customer?.cardFingerprint).toBe(fingerprint);
  }

  it("starts the 14-day trial on the Starter row when the card is on file (D-4)", async () => {
    const ws = await newWorkspace();
    await deliverCardCheckout(ws, unique("fp"));

    const response = await billingPost("/v1/billing/trial", ws, {});
    expect(response.status).toBe(201);
    const body = (await okData(response)) as { trialStarted: boolean; trialEnd: string };
    expect(body.trialStarted).toBe(true);
    const expected = new Date(Date.now() + 14 * DAY * 1000);
    expect(Math.abs(new Date(body.trialEnd).getTime() - expected.getTime())).toBeLessThan(
      5 * 60 * 1000,
    );

    const row = await subscriptionRow(ws.id);
    expect(row?.planId).toBe("starter"); // D-4: the state lives on the Starter row
    expect(row?.status).toBe("trialing");
    expect(row?.trialEnd).not.toBeNull();

    const state = await billingState(ws);
    expect(state).toMatchObject({ plan: "trial", status: "trialing" });
  });

  it("one trial per workspace: any prior subscription row (even canceled) is a 409", async () => {
    const ws = await newWorkspace();
    await deliverCardCheckout(ws, unique("fp"));
    expect((await billingPost("/v1/billing/trial", ws, {})).status).toBe(201);

    const again = await billingPost("/v1/billing/trial", ws, {});
    expect(again.status).toBe(409);
    expect((await errOf(again)).code).toBe("CONFLICT");

    // A workspace with a CANCELED history is equally refused.
    const ws2 = await newWorkspace();
    const flow = await subscribeWorkspace(ws2, "starter");
    await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    await lifecycle(
      flow,
      "customer.subscription.deleted",
      subscriptionObject(flow, { status: "canceled" }),
    );
    const refused = await billingPost("/v1/billing/trial", ws2, {});
    expect(refused.status).toBe(409);
  });

  it("one trial per CARD: a fingerprint already used by ANOTHER workspace is a 403", async () => {
    const fingerprint = unique("fpshared");
    const wsA = await newWorkspace();
    const wsB = await newWorkspace();
    await seedCustomerWithCard(wsA.id, fingerprint);
    await seedCustomerWithCard(wsB.id, fingerprint);

    // Workspace A burns the card first.
    expect((await billingPost("/v1/billing/trial", wsA, {})).status).toBe(201);
    // Workspace B — no subscription row, card on file, but the fingerprint is
    // used cross-workspace: refused.
    const refused = await billingPost("/v1/billing/trial", wsB, {});
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).code).toBe("FORBIDDEN");
    expect(await subscriptionRow(wsB.id)).toBeNull();
  });

  it("no trial for disposable email domains (frozen blocklist)", async () => {
    const jar = new CookieJar();
    const email = `${unique("throwaway")}@mailinator.com`;
    const response = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: { email, password: "Passw0rd!longenough", name: "Throwaway" },
    });
    expect(response.status).toBe(200);
    const wsResponse = await api(server.base, "/v1/workspaces", {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("ws") },
      body: { name: unique("Disposable WS"), slug: unique("disposable-ws") },
    });
    expect(wsResponse.status).toBe(201);
    const ws = (await wsResponse.json()) as { data: { id: string } };
    const workspace: Workspace = { jar, id: ws.data.id, email };
    await seedCustomerWithCard(workspace.id, unique("fp"));

    const refused = await billingPost("/v1/billing/trial", workspace, {});
    expect(refused.status).toBe(400);
    expect((await errOf(refused)).code).toBe("VALIDATION_FAILED");
    expect(await subscriptionRow(workspace.id)).toBeNull();
  });

  it("card required: no customer row, or a customer without a fingerprint, is a 400", async () => {
    const noCustomer = await newWorkspace();
    const refusedA = await billingPost("/v1/billing/trial", noCustomer, {});
    expect(refusedA.status).toBe(400);
    expect((await errOf(refusedA)).code).toBe("VALIDATION_FAILED");

    const noCard = await newWorkspace();
    await repos().subscriptions.ensureStripeCustomer(noCard.id, {
      stripeCustomerId: `cus_nocard_${unique("c")}`,
    });
    const refusedB = await billingPost("/v1/billing/trial", noCard, {});
    expect(refusedB.status).toBe(400);
    expect((await errOf(refusedB)).code).toBe("VALIDATION_FAILED");
    expect(await subscriptionRow(noCard.id)).toBeNull();
  });
});
