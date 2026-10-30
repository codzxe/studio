// W1-e — the M6 invite-time seat gate (AUD-3 gap 3a) and its sibling
// interplay with the checkout pre-check (routes/billing.ts).
//
// Matrix:
//  - stub mode (no Postgres): trial exemption, paid under-limit → 201,
//    paid at-limit (members) → 429 SEATS_EXCEEDED, the envelope shape,
//    pending-invite accumulation through a list-invitations-shaped auth
//    handler, accepted/expired pendings never count, the seat limit ties to
//    the plan row (downgrade interplay), and the gate's fail-open parse.
//  - DB-gated (real Postgres + Better Auth): the REAL pending-invite count
//    through the synthesized /v1/auth/organization/list-invitations read,
//    at-limit via accepted members, the plan row growing the allowance,
//    the trial exemption on the real stack, and the checkout pre-check
//    refusing a plan smaller than members + pending invites.
//
// The stub auth's handler answers {"ok":true} for everything, so stub tests
// that need a pending count use SeatCountingAuth (below) — a FakeGatewayAuth
// whose handler serves better-auth-shaped invitation rows.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PlanId } from "@studio/config";
import type { Repos, SubscriptionStatus } from "@studio/db";
import type { Hono } from "hono";

import { buildApp } from "../src/app.js";
import type { AppBindings } from "../src/context.js";
import {
  CookieJar,
  FakeGatewayAuth,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  fakeRepos,
  stubDeps,
  testEnv,
  unique,
  uniqueEmail,
} from "./helpers.js";
import { FAKE_STRIPE_SECRET_KEY, FAKE_WEBHOOK_SECRET, FakeStripe } from "./helpers/fake-stripe.js";

// ---------------------------------------------------------------------------
// Stub-mode harness
// ---------------------------------------------------------------------------

const ENV = testEnv();

/** One better-auth-shaped invitation row as list-invitations serves it. */
interface FakeInvitationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: string;
}

/**
 * FakeGatewayAuth + a better-auth-shaped list-invitations read. The seat
 * gate synthesizes GET /v1/auth/organization/list-invitations against the
 * auth seam's raw `handler` member; this fake answers it the way the real
 * plugin does (a JSON array of invitation rows, filtered by organization).
 */
class SeatCountingAuth extends FakeGatewayAuth {
  readonly invitations: FakeInvitationRow[] = [];

  // The parent fake's handler contract is `() => Promise<Response>` (it is
  // never called with the request), so the override keeps the parameter
  // OPTIONAL to stay assignable — and answers the bare call like the base.
  override handler = async (request?: Request): Promise<Response> => {
    if (request === undefined) {
      return new Response('{"ok":true}', { status: 200 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/v1/auth/organization/list-invitations") {
      const organizationId = url.searchParams.get("organizationId") ?? "";
      return Response.json(
        this.invitations.filter((invite) => invite.organizationId === organizationId),
      );
    }
    return new Response('{"ok":true}', { status: 200 });
  };

  override async inviteMember(
    headers: Headers,
    body: { organizationId: string; email: string; role: string },
  ) {
    const invite = await super.inviteMember(headers, body);
    this.invitations.push({
      id: invite.id,
      organizationId: invite.organizationId,
      email: invite.email,
      role: invite.role,
      status: "pending",
      expiresAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    });
    return invite;
  }
}

/** The subscription row the plan seam reads (resolvePlan → effectivePlan). */
function subscriptionRow(planId: PlanId, status: SubscriptionStatus) {
  return {
    id: "sub_fake",
    organizationId: "fake_org_1",
    planId,
    status,
    stripeSubscriptionId: null,
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    graceEnd: null,
    updatedAt: new Date(),
  };
}

/** fakeRepos + a subscriptions repo whose row resolvePlan reads. */
function reposWithSubscription(
  auth: FakeGatewayAuth,
  row: ReturnType<typeof subscriptionRow> | null,
): Repos {
  const fakes = fakeRepos(auth);
  const subscriptions = {
    // resolvePlan only ever calls getByOrganization; anything else on this
    // fake would be a route drift and should throw loudly.
    getByOrganization: async () => row,
  };
  return { ...fakes.repos, subscriptions } as unknown as Repos;
}

interface StubBoot {
  readonly auth: SeatCountingAuth;
  readonly app: Hono<AppBindings>;
  /** The owner-only org signUp created (its token is fake-session-token-1). */
  readonly orgId: string;
}

/** Fresh stub app: SeatCountingAuth + a subscription row + an owner-only org. */
function bootStub(row: ReturnType<typeof subscriptionRow> | null): StubBoot {
  const auth = new SeatCountingAuth();
  const { org } = auth.signUp("owner");
  const deps = stubDeps(ENV, { auth, repos: reposWithSubscription(auth, row) });
  return { auth, app: buildApp({ deps }), orgId: org.id };
}

/** The invite POST through the stub app (idempotency-key per §7.2). */
async function stubInvite(
  boot: StubBoot,
  email: string,
  role: "admin" | "editor" | "viewer" = "viewer",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await boot.app.request(`/v1/workspaces/${boot.orgId}/invites`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "w3gw=fake-session-token-1",
      "idempotency-key": unique("seat-inv"),
    },
    body: JSON.stringify({ email, role }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

/** Adds a member row to the boot's org (the fake's member map is the source). */
function seedMember(boot: StubBoot, userId: string, role: string): void {
  const members = boot.auth.orgs.get(boot.orgId)?.members;
  expect(members).toBeDefined();
  members?.set(userId, role);
}

function errCode(body: Record<string, unknown>): Record<string, unknown> {
  expect(body.error).toBeDefined();
  return body.error as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stub mode — the seat gate
// ---------------------------------------------------------------------------

describe("invite seat gate (stub deps)", () => {
  it("exempts trial-state workspaces (no subscription row): invites stay open pre-checkout", async () => {
    const boot = bootStub(null);
    const invite = await stubInvite(boot, uniqueEmail("mate"));
    expect(invite.status).toBe(201);
    expect(invite.body.data).toMatchObject({ status: "pending", role: "viewer" });
  });

  it("exempts trialing and terminal-unpaid rows (effectivePlan = trial)", async () => {
    const trialing = bootStub(subscriptionRow("starter", "trialing"));
    expect((await stubInvite(trialing, uniqueEmail("mate"))).status).toBe(201);
    const canceled = bootStub(subscriptionRow("pro", "canceled"));
    expect((await stubInvite(canceled, uniqueEmail("mate"))).status).toBe(201);
  });

  it("201 under the paid limit: starter (2 seats), 1 member, 0 pending", async () => {
    const boot = bootStub(subscriptionRow("starter", "active"));
    const invite = await stubInvite(boot, uniqueEmail("mate"));
    expect(invite.status).toBe(201);
  });

  it("429 SEATS_EXCEEDED at the limit: starter (2 seats), 2 members", async () => {
    const boot = bootStub(subscriptionRow("starter", "active"));
    seedMember(boot, "fake_user_77", "viewer");
    const invite = await stubInvite(boot, uniqueEmail("mate"));
    expect(invite.status).toBe(429);
    const error = errCode(invite.body);
    expect(error.code).toBe("SEATS_EXCEEDED");
    expect(error.retryable).toBe(false);
    expect(typeof error.requestId).toBe("string");
    // No invite row was minted for a refused seat.
    expect(boot.auth.inviteLog).toHaveLength(0);
  });

  it("pending invites hold their seat: the second invite on a 2-seat plan is refused", async () => {
    const boot = bootStub(subscriptionRow("starter", "active"));
    const first = await stubInvite(boot, uniqueEmail("first"));
    expect(first.status).toBe(201);
    // 1 member + 1 pending = the full 2-seat allowance → no seat for a new invite.
    const second = await stubInvite(boot, uniqueEmail("second"));
    expect(second.status).toBe(429);
    expect(errCode(second.body).code).toBe("SEATS_EXCEEDED");
  });

  it("accepted and expired pending rows never count (the seat is free again)", async () => {
    const boot = bootStub(subscriptionRow("starter", "active"));
    boot.auth.invitations.push(
      {
        id: "inv_accepted",
        organizationId: boot.orgId,
        email: "gone@w3gw.test",
        role: "viewer",
        status: "accepted",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      {
        id: "inv_expired",
        organizationId: boot.orgId,
        email: "late@w3gw.test",
        role: "viewer",
        status: "pending",
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    );
    const invite = await stubInvite(boot, uniqueEmail("mate"));
    expect(invite.status).toBe(201);
  });

  it("the limit ties to the plan row: 2 members are full on starter, 3 are open on pro", async () => {
    const starter = bootStub(subscriptionRow("starter", "active"));
    seedMember(starter, "fake_user_77", "viewer");
    const refused = await stubInvite(starter, uniqueEmail("mate"));
    expect(refused.status).toBe(429);

    // Downgrade interplay: the same member shape on pro (5 seats) has room.
    const pro = bootStub(subscriptionRow("pro", "active"));
    seedMember(pro, "fake_user_77", "viewer");
    seedMember(pro, "fake_user_78", "editor");
    const welcome = await stubInvite(pro, uniqueEmail("mate"));
    expect(welcome.status).toBe(201);
  });

  it("dunning keeps the paid gate: a grace starter row still enforces seats", async () => {
    const boot = bootStub(subscriptionRow("starter", "grace"));
    seedMember(boot, "fake_user_77", "viewer");
    const invite = await stubInvite(boot, uniqueEmail("mate"));
    expect(invite.status).toBe(429);
    expect(errCode(invite.body).code).toBe("SEATS_EXCEEDED");
  });

  it("SEC-11: a non-invitation-shaped auth answer fails CLOSED (503, no invite minted)", async () => {
    // The plain fake answers {"ok":true} — a real better-auth ALWAYS answers
    // an invitation array, so this is an auth malfunction: the seat-gated
    // mutation is refused (retryable 503), never under-counted open.
    const auth = new FakeGatewayAuth();
    const { org } = auth.signUp("owner");
    const repos = reposWithSubscription(auth, subscriptionRow("starter", "active"));
    const deps = stubDeps(ENV, { auth, repos });
    const app = buildApp({ deps });
    const response = await app.request(`/v1/workspaces/${org.id}/invites`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "w3gw=fake-session-token-1",
        "idempotency-key": unique("seat-inv"),
      },
      body: JSON.stringify({ email: uniqueEmail("mate"), role: "viewer" }),
    });
    expect(response.status).toBe(503);
    const error = errCode((await response.json()) as Record<string, unknown>);
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(auth.inviteLog).toHaveLength(0);
  });

  it("SEC-11: a thrown auth handler fails CLOSED (503, no invite minted)", async () => {
    const auth = new SeatCountingAuth();
    auth.handler = async () => {
      throw new Error("auth is down");
    };
    const { org } = auth.signUp("owner");
    const repos = reposWithSubscription(auth, subscriptionRow("starter", "active"));
    const deps = stubDeps(ENV, { auth, repos });
    const app = buildApp({ deps });
    const response = await app.request(`/v1/workspaces/${org.id}/invites`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "w3gw=fake-session-token-1",
        "idempotency-key": unique("seat-inv"),
      },
      body: JSON.stringify({ email: uniqueEmail("mate"), role: "viewer" }),
    });
    expect(response.status).toBe(503);
    const error = errCode((await response.json()) as Record<string, unknown>);
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(auth.inviteLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DB-gated — real Postgres + real Better Auth invitation rows
// ---------------------------------------------------------------------------

const d = describe.skipIf(!HAS_DATABASE);

d("invite seat gate (real Postgres + Better Auth)", () => {
  let server: RunningTestServer;

  beforeAll(async () => {
    server = await bootServer({
      env: {
        STRIPE_SECRET_KEY: FAKE_STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
        STRIPE_PRICE_IDS: JSON.stringify({
          starter: "price_test_starter",
          pro: "price_test_pro",
          studio: "price_test_studio",
        }),
      },
    });
    // The checkout pre-check runs behind requireStripe — inject the fake
    // seam (billing-routes' setStripe precedent) so its 400 can only come
    // from the seat pre-check itself.
    (server.deps as unknown as { stripe: FakeStripe["seam"] }).stripe = new FakeStripe({
      webhookSecret: FAKE_WEBHOOK_SECRET,
    }).seam;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  interface Workspace {
    readonly jar: CookieJar;
    readonly id: string;
  }

  async function newWorkspace(): Promise<Workspace> {
    const jar = new CookieJar();
    const email = uniqueEmail("seatowner");
    const signUp = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: { email, password: "Passw0rd!longenough", name: "Seat Owner" },
    });
    expect(signUp.status).toBe(200);
    const wsResponse = await api(server.base, "/v1/workspaces", {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("seat-ws") },
      body: { name: unique("Seat WS"), slug: unique("seat-ws") },
    });
    expect(wsResponse.status).toBe(201);
    const ws = (await wsResponse.json()) as { data: { id: string } };
    return { jar, id: ws.data.id };
  }

  async function invite(ws: Workspace, email: string): Promise<Response> {
    return api(server.base, `/v1/workspaces/${ws.id}/invites`, {
      method: "POST",
      jar: ws.jar,
      headers: { "idempotency-key": unique("seat-inv") },
      body: { email, role: "viewer" },
    });
  }

  /** Signs the invited address up and accepts its invitation as that user. */
  async function signUpAndAccept(
    ws: Workspace,
    email: string,
    inviteId: string,
  ): Promise<Response> {
    const inviteeJar = new CookieJar();
    const signUp = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar: inviteeJar,
      body: { email, password: "Passw0rd!longenough", name: "Seatmate" },
    });
    expect(signUp.status).toBe(200);
    return api(server.base, `/v1/invites/${inviteId}/accept`, {
      method: "POST",
      jar: inviteeJar,
      headers: { "idempotency-key": unique("seat-acc") },
    });
  }

  async function setPlan(ws: Workspace, planId: "starter" | "pro"): Promise<void> {
    await server.deps.repos.subscriptions.upsertState(ws.id, {
      planId,
      status: "active",
      stripeSubscriptionId: `sub_${unique("seat")}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      trialEnd: null,
      cancelAtPeriodEnd: false,
    });
  }

  it("trial-state workspaces can invite pre-checkout (the exemption on the real stack)", async () => {
    const ws = await newWorkspace();
    const response = await invite(ws, uniqueEmail("mate"));
    expect(response.status).toBe(201);
  });

  it("counts REAL pending invites: the second invite on a 2-seat starter row is refused", async () => {
    const ws = await newWorkspace();
    await setPlan(ws, "starter"); // 2 seats; 1 member (the owner)
    const first = await invite(ws, uniqueEmail("first"));
    expect(first.status).toBe(201);
    const second = await invite(ws, uniqueEmail("second"));
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("SEATS_EXCEEDED");
    expect(body.error.retryable).toBe(false);
  });

  it("accepting converts the pending seat into a member seat (still at the limit)", async () => {
    const ws = await newWorkspace();
    await setPlan(ws, "starter");
    const email = uniqueEmail("mate");
    const first = await invite(ws, email);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };

    // Accepts are NOT gated (the invitee cannot read the org pre-accept) —
    // the create gate's invariant keeps members + pending ≤ seats.
    const accepted = await signUpAndAccept(ws, email, firstBody.data.id);
    expect(accepted.status).toBe(200);

    // 2 members + 0 pending = the full allowance again → the next invite 429s.
    const third = await invite(ws, uniqueEmail("late"));
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("SEATS_EXCEEDED");
  });

  it("the allowance grows with the plan row (downgrade interplay on the real stack)", async () => {
    const ws = await newWorkspace();
    await setPlan(ws, "starter"); // 2 seats, owner only
    const first = await invite(ws, uniqueEmail("first"));
    expect(first.status).toBe(201);
    const second = await invite(ws, uniqueEmail("second"));
    expect(second.status).toBe(429);

    await setPlan(ws, "pro"); // 5 seats — the SAME shape now has room
    const third = await invite(ws, uniqueEmail("third"));
    expect(third.status).toBe(201);
  });

  it("checkout refuses a paid plan smaller than members + pending invites (sibling gate)", async () => {
    const ws = await newWorkspace(); // trial: invite freely (exempt)
    for (let i = 0; i < 2; i += 1) {
      const response = await invite(ws, uniqueEmail("queued"));
      expect(response.status).toBe(201);
    }
    // 1 member + 2 pending = 3 > starter's 2 seats → the conversion 400s
    // before any Stripe session exists. pro (5 seats) fits.
    const checkout = await api(server.base, "/v1/billing/checkout", {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("seat-checkout") },
      body: { planId: "starter" },
    });
    expect(checkout.status).toBe(400);
    expect(((await checkout.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_FAILED",
    );
    const proCheckout = await api(server.base, "/v1/billing/checkout", {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("seat-checkout") },
      body: { planId: "pro" },
    });
    expect(proCheckout.status).toBe(201);
  });
});
