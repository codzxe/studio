// W3-gw — REAL end-to-end auth + workspace flows over HTTP against live
// Postgres + Better Auth (§7.1, §7.2, §12.1). Skips when no database is
// reachable (see helpers.resolveDatabaseUrl).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { entitlementsFor } from "@studio/config";

import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  unique,
  uniqueEmail,
} from "./helpers.js";

const DAY_MS = 86_400_000;

const d = describe.skipIf(!HAS_DATABASE);

let server: RunningTestServer;

beforeAll(async () => {
  server = await bootServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

async function signUp(): Promise<CookieJar> {
  const jar = new CookieJar();
  const response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail(), password: "Passw0rd!longenough", name: "W3GW User" },
  });
  expect(response.status).toBe(200);
  return jar;
}

async function createWorkspace(
  jar: CookieJar,
  name: string,
): Promise<{ id: string; slug: string }> {
  const response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws-create") },
    body: { name, slug: unique("ws") },
  });
  const body = (await response.json()) as { data: { id: string; slug: string } };
  expect(response.status).toBe(201);
  return body.data;
}

d("Better Auth sign-up (§7.1)", () => {
  it("POST /v1/auth/sign-up/email creates the user and sets a session cookie", async () => {
    const jar = new CookieJar();
    const email = uniqueEmail();
    const response = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: { email, password: "Passw0rd!longenough", name: "Fresh User" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string; email: string } };
    expect(body.user.email).toBe(email);
    expect(typeof body.user.id).toBe("string");
    const cookie = jar.header;
    expect(cookie).toContain("better-auth.session_token=");
    // The session actually works:
    const me = await api(server.base, "/v1/me", { jar });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { user: { email: string } } };
    expect(meBody.data.user.email).toBe(email);
  });

  it("rejects a duplicate sign-up with a 4xx envelope", async () => {
    const jar = new CookieJar();
    const email = uniqueEmail();
    const first = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      body: { email, password: "Passw0rd!longenough", name: "Once" },
    });
    expect(first.status).toBe(200);
    const second = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      body: { email, password: "Passw0rd!longenough", name: "Twice" },
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
  });
});

d("GET /v1/me (§7.2)", () => {
  it("returns user + memberships with roles", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Me WS"));
    const response = await api(server.base, "/v1/me", { jar });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        user: { id: string; email: string };
        memberships: {
          workspaceId: string;
          role: string;
          workspace: { id: string; name: string; slug: string };
        }[];
        plan: { plan: string; creditsBalance: number };
      };
    };
    expect(body.data.user.id).toBeTruthy();
    const membership = body.data.memberships.find((m) => m.workspaceId === ws.id);
    expect(membership).toBeDefined();
    expect(membership?.role).toBe("owner");
    expect(typeof body.data.plan.creditsBalance).toBe("number");
  });
});

// W1-04 stub purge: GET /v1/me must report the active workspace's REAL
// subscription row through the same derivation GET /v1/billing/state uses
// (subscription row → effectivePlan, D-4 → catalog entitlements) — never the
// old hardcoded `{ plan: "trial", includedCredits: 0, renewsAt: null }`.
d("GET /v1/me plan summary — real subscription data (W1-04)", () => {
  interface MePlan {
    readonly plan: string;
    readonly creditsBalance: number;
    readonly includedCredits: number;
    readonly renewsAt: string | null;
  }

  async function mePlan(jar: CookieJar): Promise<MePlan> {
    const response = await api(server.base, "/v1/me", { jar });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { plan: MePlan } };
    return body.data.plan;
  }

  it("trialing subscription row → plan 'trial' with the row's trial window (D-4 state on the Starter row)", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Me Trial WS"));
    // Exactly what POST /v1/billing/trial writes (D-4): status 'trialing' on
    // the STARTER row, trialEnd = period end.
    const trialEnd = new Date(Date.now() + 14 * DAY_MS);
    await server.deps.repos.subscriptions.upsertState(ws.id, {
      planId: "starter",
      status: "trialing",
      stripeSubscriptionId: null,
      currentPeriodEnd: trialEnd,
      trialEnd,
      cancelAtPeriodEnd: false,
    });

    const plan = await mePlan(jar);
    // The trialing row gates as the TRIAL catalog tier (D-4) — derived, and
    // distinguishable from the old stub via the row's trial window + the
    // catalog allowance (the stub had renewsAt:null + includedCredits:0).
    expect(plan.plan).toBe("trial");
    expect(plan.includedCredits).toBe(entitlementsFor("trial").monthlyCreditAllowance);
    expect(plan.includedCredits).toBe(50_000_000); // 50 credits, µc (D-12)
    expect(plan.renewsAt).toBe(trialEnd.toISOString());
  });

  it("paid subscription row → plan is the PAID plan, not a fabricated 'trial'", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Me Paid WS"));
    const periodEnd = new Date(Date.now() + 30 * DAY_MS);
    await server.deps.repos.subscriptions.upsertState(ws.id, {
      planId: "pro",
      status: "active",
      stripeSubscriptionId: "sub_test_pro",
      currentPeriodEnd: periodEnd,
      trialEnd: null,
      cancelAtPeriodEnd: false,
    });
    // A real ledger grant so creditsBalance is provably the workspace's own
    // ledger sum (µc, D-12) for the same row-derived plan.
    await server.deps.repos.ledger.grant(ws.id, {
      amount: 3_200_000_000,
      idempotencyKey: unique("me-grant-pro"),
    });

    const plan = await mePlan(jar);
    expect(plan.plan).toBe("pro");
    expect(plan.includedCredits).toBe(entitlementsFor("pro").monthlyCreditAllowance);
    expect(plan.includedCredits).toBe(2_000_000_000); // 2,000 credits, µc (D-12)
    expect(plan.renewsAt).toBe(periodEnd.toISOString());
    expect(plan.creditsBalance).toBe(3_200_000_000);
  });

  it("no subscription row → the documented no-row default, agreeing with GET /v1/billing/state", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Me NoRow WS"));

    const plan = await mePlan(jar);
    // Honest DERIVED default (plan.ts effectivePlan(null)): the most
    // restrictive trial tier — the same plan GET /v1/billing/state reports,
    // with the trial catalog allowance (not the old hardcoded 0) and no
    // fabricated renewal date.
    expect(plan.plan).toBe("trial");
    expect(plan.includedCredits).toBe(entitlementsFor("trial").monthlyCreditAllowance);
    expect(plan.includedCredits).not.toBe(0);
    expect(plan.renewsAt).toBeNull();

    // Consistency: the ONE billing read reports the same plan for this
    // workspace — /v1/me never disagrees with /v1/billing/state.
    const state = await api(server.base, "/v1/billing/state", {
      jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as { data: { plan: string; status: string } };
    expect(stateBody.data.plan).toBe(plan.plan);
    expect(stateBody.data.status).toBe("none");
  });
});

d("Workspaces (§7.2)", () => {
  it("lists workspaces including a newly created one", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("List WS"));
    const response = await api(server.base, "/v1/workspaces", { jar });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.some((entry) => entry.id === ws.id)).toBe(true);
  });

  it("GET /v1/workspaces/:id resolves by id with role + members", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Get WS"));
    const response = await api(server.base, `/v1/workspaces/${ws.id}`, { jar });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { id: string; role: string; members: { role: string }[] };
    };
    expect(body.data.id).toBe(ws.id);
    expect(body.data.role).toBe("owner");
    expect(body.data.members.length).toBeGreaterThan(0);
  });

  it("rejects a duplicate slug with 409 CONFLICT (not INTERNAL)", async () => {
    const jar = await signUp();
    const slug = unique("dup");
    const first = await api(server.base, "/v1/workspaces", {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("ws-dup") },
      body: { name: "First", slug },
    });
    expect(first.status).toBe(201);
    const second = await api(server.base, "/v1/workspaces", {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("ws-dup") },
      body: { name: "Second", slug },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("PATCH /v1/workspaces/:id renames the workspace", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Patch WS"));
    const renamed = `${ws.slug}-renamed`;
    const response = await api(server.base, `/v1/workspaces/${ws.id}`, {
      method: "PATCH",
      jar,
      body: { name: "Renamed Workspace" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { name: string } };
    expect(body.data.name).toBe("Renamed Workspace");
    void renamed;
  });
});

d("Cross-tenant isolation (§12.1: existence never leaks)", () => {
  it("user A cannot see user B's workspace — 404 WORKSPACE_NOT_FOUND", async () => {
    const jarA = await signUp();
    const jarB = await signUp();
    const wsB = await createWorkspace(jarB, unique("Private WS"));
    const response = await api(server.base, "/v1/projects?limit=10", {
      jar: jarA,
      headers: { "x-workspace-id": wsB.id },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("an unknown workspace id also reads as 404 (no enumeration signal)", async () => {
    const jar = await signUp();
    const response = await api(server.base, "/v1/projects?limit=10", {
      jar,
      headers: { "x-workspace-id": "totally-unknown-workspace" },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_NOT_FOUND");
  });
});

d("Invite → accept → role matrix (§7.1, §3.3)", () => {
  it("invites a viewer, they accept, and the viewer cannot create projects (403 FORBIDDEN)", async () => {
    const jarOwner = await signUp();
    const ws = await createWorkspace(jarOwner, unique("Invite WS"));
    const invitedEmail = uniqueEmail("invitee");

    // owner invites the viewer (role matrix: viewer ⊂ editor ⊂ admin ⊂ owner)
    const inviteResponse = await api(server.base, `/v1/workspaces/${ws.id}/invites`, {
      method: "POST",
      jar: jarOwner,
      headers: { "idempotency-key": unique("invite") },
      body: { email: invitedEmail, role: "viewer" },
    });
    expect(inviteResponse.status).toBe(201);
    const invite = (await inviteResponse.json()) as {
      data: {
        id: string;
        workspaceId: string;
        email: string;
        role: string;
        status: string;
        expiresAt: string | null;
      };
    };
    expect(invite.data.role).toBe("viewer");
    expect(invite.data.status).toBe("pending");
    expect(invite.data.workspaceId).toBe(ws.id);

    // the invitee signs up with the invited email and accepts (the invitation
    // id doubles as the accept token; no email round-trip needed)
    const jarViewer = new CookieJar();
    const signUpResponse = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar: jarViewer,
      body: { email: invitedEmail, password: "Passw0rd!longenough", name: "Invitee" },
    });
    expect(signUpResponse.status).toBe(200);

    const acceptResponse = await api(server.base, `/v1/invites/${invite.data.id}/accept`, {
      method: "POST",
      jar: jarViewer,
      headers: { "idempotency-key": unique("accept") },
    });
    expect(acceptResponse.status).toBe(200);
    const accepted = (await acceptResponse.json()) as {
      data: { inviteId: string; workspaceId: string; role: string };
    };
    expect(accepted.data.workspaceId).toBe(ws.id);
    expect(accepted.data.role).toBe("viewer");

    // viewer can read the workspace's projects…
    const listResponse = await api(server.base, "/v1/projects?limit=10", {
      jar: jarViewer,
      headers: { "x-workspace-id": ws.id },
    });
    expect(listResponse.status).toBe(200);

    // …but a viewer cannot create one — the typed FORBIDDEN envelope.
    const createResponse = await api(server.base, "/v1/projects", {
      method: "POST",
      jar: jarViewer,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("viewer-create") },
      body: { name: "Should Not Create" },
    });
    expect(createResponse.status).toBe(403);
    const body = (await createResponse.json()) as {
      error: { code: string; message: string; retryable: boolean };
    };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.retryable).toBe(false);

    // and the workspace membership now shows the viewer role
    const meResponse = await api(server.base, "/v1/me", { jar: jarViewer });
    const me = (await meResponse.json()) as {
      data: { memberships: { workspaceId: string; role: string }[] };
    };
    const membership = me.data.memberships.find((m) => m.workspaceId === ws.id);
    expect(membership?.role).toBe("viewer");
  });
});
