// W1-b — REAL workspace API-key lifecycle over HTTP against live Postgres +
// Better Auth (§7.1 "scoped, hashed, revocable", §3.3 manageApiKeys, §12.1).
// Skips when no database is reachable (see helpers.resolveDatabaseUrl).
//
// Covers the AUD-1 gap #2 surface end-to-end: mint (owner/admin only, the
// plaintext key shown EXACTLY once, audit row), list (workspace-wide, paged,
// NEVER key material, lastUsedAt after first Bearer use), revoke (admin
// revoking another member's key, idempotent, audit row) and Bearer
// authentication through the existing gateway middleware: a valid key reaches
// an authenticated endpoint as its minting user, a revoked/garbage key and a
// session-less request all read as 401.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  unique,
  uniqueEmail,
} from "./helpers.js";

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
    body: { email: uniqueEmail(), password: "Passw0rd!longenough", name: "W1B User" },
  });
  expect(response.status).toBe(200);
  return jar;
}

async function createWorkspace(jar: CookieJar): Promise<{ id: string; slug: string }> {
  const response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("ApiKeys WS"), slug: unique("ws") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string; slug: string } };
  return body.data;
}

interface MintedKey {
  readonly id: string;
  readonly key: string;
}

async function mintKey(
  jar: CookieJar,
  workspaceId: string,
  body: { name: string; scopes: string[]; expiresAt?: string },
): Promise<{ status: number; minted?: MintedKey; err?: { code: string } }> {
  const response = await api(server.base, `/v1/workspaces/${workspaceId}/api-keys`, {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("key") },
    body,
  });
  const parsed = (await response.json()) as {
    data?: { id: string; key: string };
    error?: { code: string };
  };
  return {
    status: response.status,
    minted: parsed.data ? { id: parsed.data.id, key: parsed.data.key } : undefined,
    err: parsed.error,
  };
}

/** Invites an email, the invitee signs up + accepts, returns their jar. */
async function inviteAndAccept(
  jarOwner: CookieJar,
  workspaceId: string,
  role: string,
): Promise<CookieJar> {
  const email = uniqueEmail("member");
  const inviteResponse = await api(server.base, `/v1/workspaces/${workspaceId}/invites`, {
    method: "POST",
    jar: jarOwner,
    headers: { "idempotency-key": unique("invite") },
    body: { email, role },
  });
  expect(inviteResponse.status).toBe(201);
  const invite = (await inviteResponse.json()) as { data: { id: string } };

  const jar = new CookieJar();
  const signUpResponse = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: "Member" },
  });
  expect(signUpResponse.status).toBe(200);
  const acceptResponse = await api(server.base, `/v1/invites/${invite.data.id}/accept`, {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("accept") },
  });
  expect(acceptResponse.status).toBe(200);
  return jar;
}

d("POST /v1/workspaces/:id/api-keys — mint (§7.1, §3.3)", () => {
  it("owner mints a key: 201, plaintext shown exactly once, full shape", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const response = await api(server.base, `/v1/workspaces/${ws.id}/api-keys`, {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("key") },
      body: { name: "CI pipeline", scopes: ["projects:read", "renders:queue"] },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: {
        id: string;
        name: string;
        scopes: string[];
        createdAt: string;
        startsAt: string;
        expiresAt: string | null;
        lastUsedAt: string | null;
        enabled: boolean;
        key: string;
      };
    };
    const created = body.data;
    expect(created.name).toBe("CI pipeline");
    expect(created.scopes).toEqual(["projects:read", "renders:queue"]);
    expect(created.expiresAt).toBeNull();
    expect(created.lastUsedAt).toBeNull();
    expect(created.enabled).toBe(true);
    // The plaintext key crosses the wire exactly ONCE, branded and long.
    expect(created.key.startsWith("studio_")).toBe(true);
    expect(created.key.length).toBeGreaterThan(64);
    expect(created.startsAt).toBe(created.createdAt);
  });

  it("a viewer cannot mint keys — 403 FORBIDDEN (§3.3 manageApiKeys)", async () => {
    const jarOwner = await signUp();
    const ws = await createWorkspace(jarOwner);
    const jarViewer = await inviteAndAccept(jarOwner, ws.id, "viewer");
    const result = await mintKey(jarViewer, ws.id, { name: "Nope", scopes: ["projects:read"] });
    expect(result.status).toBe(403);
    expect(result.err?.code).toBe("FORBIDDEN");
  });

  it("audits apikey.created with the key id + scopes and NO key material", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const created = await mintKey(jar, ws.id, { name: "Audited key", scopes: ["chat:run"] });
    expect(created.status).toBe(201);
    expect(created.minted).toBeDefined();

    const auditPage = await server.deps.repos.audit.list(ws.id, { limit: 100 });
    const entry = auditPage.items.find((row) => row.action === "apikey.created");
    expect(entry).toBeDefined();
    expect(entry?.targetId).toBe(created.minted?.id);
    const metadata = entry?.metadata as { keyId?: string; scopes?: string[] } | null;
    expect(metadata?.keyId).toBe(created.minted?.id);
    expect(metadata?.scopes).toEqual(["chat:run"]);
    // Law #1: the audit row never carries the secret (hashed or plaintext).
    expect(JSON.stringify(entry)).not.toContain(created.minted?.key ?? "");
  });

  it("rejects an expiresAt under the 1-day minimum with 400 VALIDATION_FAILED", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const twoHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const result = await mintKey(jar, ws.id, {
      name: "Too short",
      scopes: ["projects:read"],
      expiresAt: twoHours,
    });
    expect(result.status).toBe(400);
    expect(result.err?.code).toBe("VALIDATION_FAILED");
  });
});

d("GET /v1/workspaces/:id/api-keys — workspace list (never key material)", () => {
  it("an admin sees the OWNER-minted key; paged; plaintext never appears", async () => {
    const jarOwner = await signUp();
    const ws = await createWorkspace(jarOwner);
    const first = await mintKey(jarOwner, ws.id, {
      name: "Owner key A",
      scopes: ["projects:read"],
    });
    const second = await mintKey(jarOwner, ws.id, {
      name: "Owner key B",
      scopes: ["billing:read"],
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const jarAdmin = await inviteAndAccept(jarOwner, ws.id, "admin");
    const listResponse = await api(server.base, `/v1/workspaces/${ws.id}/api-keys?limit=1`, {
      jar: jarAdmin,
    });
    expect(listResponse.status).toBe(200);
    const page1 = (await listResponse.json()) as {
      data: { items: Record<string, unknown>[]; nextCursor: string | null };
    };
    expect(page1.data.items.length).toBe(1);
    expect(typeof page1.data.nextCursor).toBe("string");

    const listAll = await api(server.base, `/v1/workspaces/${ws.id}/api-keys`, { jar: jarAdmin });
    const body = (await listAll.json()) as { data: { items: Record<string, unknown>[] } };
    const ids = body.data.items.map((item) => item.id);
    expect(ids).toContain(first.minted?.id);
    expect(ids).toContain(second.minted?.id);
    // NEVER key material: no `key` field, no plaintext anywhere.
    expect(body.data.items.every((item) => !("key" in item))).toBe(true);
    expect(JSON.stringify(body)).not.toContain(first.minted?.key ?? "__absent__");
  });
});

d("DELETE /v1/workspaces/:id/api-keys/:keyId — revoke (§7.1)", () => {
  it("an admin revokes the owner's key: idempotent, audited, enabled flips", async () => {
    const jarOwner = await signUp();
    const ws = await createWorkspace(jarOwner);
    const created = await mintKey(jarOwner, ws.id, {
      name: "Doomed key",
      scopes: ["projects:read"],
    });
    expect(created.status).toBe(201);
    expect(created.minted).toBeDefined();

    const jarAdmin = await inviteAndAccept(jarOwner, ws.id, "admin");
    const revokeResponse = await api(
      server.base,
      `/v1/workspaces/${ws.id}/api-keys/${created.minted?.id}`,
      { method: "DELETE", jar: jarAdmin },
    );
    expect(revokeResponse.status).toBe(200);
    const revoked = (await revokeResponse.json()) as {
      data: { id: string; revokedAt: string; enabled: false };
    };
    expect(revoked.data.id).toBe(created.minted?.id);
    expect(revoked.data.enabled).toBe(false);

    // Idempotent: a repeat DELETE returns the same shape, still 200.
    const repeat = await api(
      server.base,
      `/v1/workspaces/${ws.id}/api-keys/${created.minted?.id}`,
      { method: "DELETE", jar: jarAdmin },
    );
    expect(repeat.status).toBe(200);

    const auditPage = await server.deps.repos.audit.list(ws.id, { limit: 100 });
    const entry = auditPage.items.find(
      (row) => row.action === "apikey.revoked" && row.targetId === created.minted?.id,
    );
    expect(entry).toBeDefined();

    // The list shows the key disabled.
    const listResponse = await api(server.base, `/v1/workspaces/${ws.id}/api-keys`, {
      jar: jarOwner,
    });
    const body = (await listResponse.json()) as {
      data: { items: { id: string; enabled: boolean }[] };
    };
    const row = body.data.items.find((item) => item.id === created.minted?.id);
    expect(row?.enabled).toBe(false);
  });

  it("a key id from ANOTHER workspace reads as 404 (§12.1, no existence leak)", async () => {
    const jarA = await signUp();
    const wsA = await createWorkspace(jarA);
    const created = await mintKey(jarA, wsA.id, { name: "Foreign key", scopes: ["*"] });
    expect(created.status).toBe(201);

    const jarB = await signUp();
    const wsB = await createWorkspace(jarB);
    const response = await api(
      server.base,
      `/v1/workspaces/${wsB.id}/api-keys/${created.minted?.id}`,
      { method: "DELETE", jar: jarB },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

d("Authorization: Bearer <key> (the PAT model through requireAuth)", () => {
  it("a valid key reaches an authenticated endpoint and sets lastUsedAt", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const created = await mintKey(jar, ws.id, { name: "Bearer key", scopes: ["projects:read"] });
    expect(created.status).toBe(201);

    // No cookie jar: the Bearer key alone authenticates as the minting user.
    const projectsResponse = await api(server.base, "/v1/projects?limit=10", {
      headers: { authorization: `Bearer ${created.minted?.key}`, "x-workspace-id": ws.id },
    });
    expect(projectsResponse.status).toBe(200);

    // /v1/me works too — the key acts as its user across the surface.
    const meResponse = await api(server.base, "/v1/me", {
      headers: { authorization: `Bearer ${created.minted?.key}` },
    });
    expect(meResponse.status).toBe(200);

    // First use flips lastUsedAt from null to a timestamp.
    const listResponse = await api(server.base, `/v1/workspaces/${ws.id}/api-keys`, { jar });
    const body = (await listResponse.json()) as {
      data: { items: { id: string; lastUsedAt: string | null }[] };
    };
    const row = body.data.items.find((item) => item.id === created.minted?.id);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("a REVOKED key gets 401 AUTH_REQUIRED", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const created = await mintKey(jar, ws.id, { name: "Revoked soon", scopes: ["projects:read"] });
    expect(created.status).toBe(201);

    const revokeResponse = await api(
      server.base,
      `/v1/workspaces/${ws.id}/api-keys/${created.minted?.id}`,
      { method: "DELETE", jar },
    );
    expect(revokeResponse.status).toBe(200);

    const projectsResponse = await api(server.base, "/v1/projects?limit=10", {
      headers: { authorization: `Bearer ${created.minted?.key}`, "x-workspace-id": ws.id },
    });
    expect(projectsResponse.status).toBe(401);
    const body = (await projectsResponse.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("a garbage Bearer token gets 401, never a 5xx", async () => {
    const projectsResponse = await api(server.base, "/v1/projects?limit=10", {
      headers: { authorization: "Bearer studio_totally-invalid-key", "x-workspace-id": "any" },
    });
    expect(projectsResponse.status).toBe(401);
    const body = (await projectsResponse.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("a session-less request with no key gets 401 AUTH_REQUIRED", async () => {
    const projectsResponse = await api(server.base, "/v1/projects?limit=10", {
      headers: { "x-workspace-id": "any" },
    });
    expect(projectsResponse.status).toBe(401);
    const body = (await projectsResponse.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });
});

d("SEC-03 — stored scopes are ENFORCED (real plugin mint + Bearer)", () => {
  it("a projects:read key reads projects (200) but creating gets 403 naming projects:write", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const created = await mintKey(jar, ws.id, { name: "Read only", scopes: ["projects:read"] });
    expect(created.status).toBe(201);

    const list = await api(server.base, "/v1/projects?limit=10", {
      headers: { authorization: `Bearer ${created.minted?.key}`, "x-workspace-id": ws.id },
    });
    expect(list.status).toBe(200);

    const create = await api(server.base, "/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.minted?.key}`,
        "x-workspace-id": ws.id,
        "idempotency-key": unique("sec03"),
      },
      body: { name: "Key-Made Project" },
    });
    expect(create.status).toBe(403);
    const body = (await create.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("API_KEY_FORBIDDEN");
    expect(body.error.message).toContain("projects:write");
  });

  it("a renders:queue key cannot read the project plane (403 naming projects:read)", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const created = await mintKey(jar, ws.id, { name: "Render bot", scopes: ["renders:queue"] });
    expect(created.status).toBe(201);

    const response = await api(server.base, "/v1/projects?limit=10", {
      headers: { authorization: `Bearer ${created.minted?.key}`, "x-workspace-id": ws.id },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("projects:read");
  });

  it("a * key gets billing:read reads but never the billing mutations", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const created = await mintKey(jar, ws.id, { name: "Full key", scopes: ["*"] });
    expect(created.status).toBe(201);

    const credits = await api(server.base, "/v1/credits", {
      headers: { authorization: `Bearer ${created.minted?.key}`, "x-workspace-id": ws.id },
    });
    expect(credits.status).toBe(200);

    const checkout = await api(server.base, "/v1/billing/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.minted?.key}`,
        "x-workspace-id": ws.id,
        "idempotency-key": unique("sec03b"),
      },
      body: { tier: "starter" },
    });
    expect(checkout.status).toBe(403);
    const body = (await checkout.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_FORBIDDEN");
  });

  it("share-link minting stays cookie-only even for a * key", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar);
    const projectResponse = await api(server.base, "/v1/projects", {
      method: "POST",
      jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
      body: { name: "Share source" },
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { data: { id: string } };

    const created = await mintKey(jar, ws.id, { name: "Full key", scopes: ["*"] });
    expect(created.status).toBe(201);

    const response = await api(server.base, `/v1/projects/${project.data.id}/share-links`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.minted?.key}`,
        "x-workspace-id": ws.id,
        "idempotency-key": unique("shr"),
      },
      body: {},
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_FORBIDDEN");
  });

  it("the workspace binding confines the key to its minted workspace (§12.1 404)", async () => {
    const jar = await signUp();
    const wsA = await createWorkspace(jar);
    const wsB = await createWorkspace(jar); // same owner, second workspace
    expect(wsA.id).not.toBe(wsB.id);

    const created = await mintKey(jar, wsA.id, { name: "Bound to A", scopes: ["*"] });
    expect(created.status).toBe(201);

    // Same owner, other workspace → 404 (never 403: no existence leak).
    const cross = await api(server.base, "/v1/projects?limit=10", {
      headers: { authorization: `Bearer ${created.minted?.key}`, "x-workspace-id": wsB.id },
    });
    expect(cross.status).toBe(404);
    const body = (await cross.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_NOT_FOUND");

    // The minted workspace still works.
    const home = await api(server.base, "/v1/projects?limit=10", {
      headers: { authorization: `Bearer ${created.minted?.key}`, "x-workspace-id": wsA.id },
    });
    expect(home.status).toBe(200);
  });
});
