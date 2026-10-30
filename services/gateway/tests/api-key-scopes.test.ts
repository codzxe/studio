// SEC-03 — API-key scope enforcement (stub suite, no database).
//
// Two layers:
//   1. the capability TABLE (apiKeyRouteAccess) pinned route-by-route —
//      every /v1 surface's key posture is load-bearing and must be declared;
//   2. the middleware through the real app: Bearer keys hit requireAuth,
//      scopes decide 200 vs typed 403 (message names the missing scope), and
//      the workspace binding confines a key to the workspace it was minted
//      for (cross-workspace reads as §12.1 404).
// Real-plugin (better-auth) mint + Bearer flows live in api-keys.test.ts.

import { beforeEach, describe, expect, it } from "vitest";

import type { Hono } from "hono";

import { buildApp } from "../src/app.js";
import type { AppBindings } from "../src/context.js";
import { apiKeyRouteAccess } from "../src/middleware.js";
import { FakeGatewayAuth, fakeRepos, stubDeps, testEnv } from "./helpers.js";

const env = testEnv();

let auth: FakeGatewayAuth;
let app: Hono<AppBindings>;
/** The owner principal + workspace every key in this suite is minted for. */
let home: { user: { id: string }; org: { id: string } };

beforeEach(() => {
  auth = new FakeGatewayAuth();
  const fakes = fakeRepos(auth);
  const deps = stubDeps(env, { auth, repos: fakes.repos });
  app = buildApp({ deps });
  home = auth.signUp("owner");
});

// ---------------------------------------------------------------------------
// 1. The capability table (SEC-03) — pinned surface by surface.
// ---------------------------------------------------------------------------

describe("apiKeyRouteAccess — the SEC-03 capability table", () => {
  const cases: readonly [string, string, string][] = [
    // Introspection — any valid key.
    ["GET", "/v1/me", "any-key"],
    ["GET", "/v1/me/settings", "any-key"],
    ["GET", "/v1/models", "any-key"],
    ["GET", "/v1/workspaces", "any-key"],
    ["GET", "/v1/workspaces/org_1", "any-key"],
    ["POST", "/v1/workspaces/org_1/switch", "any-key"],
    // Account/auth mutations — never keys.
    ["POST", "/v1/auth/sign-in/email", "cookie-only"],
    ["PATCH", "/v1/me/settings", "cookie-only"],
    ["POST", "/v1/invites/inv_1/accept", "cookie-only"],
    // Workspace administration — cookie-only (incl. admin READS).
    ["POST", "/v1/workspaces", "cookie-only"],
    ["PATCH", "/v1/workspaces/org_1", "cookie-only"],
    ["GET", "/v1/workspaces/org_1/members", "cookie-only"],
    ["GET", "/v1/workspaces/org_1/audit", "cookie-only"],
    ["GET", "/v1/workspaces/org_1/api-keys", "cookie-only"],
    ["DELETE", "/v1/workspaces/org_1/members/usr_1", "cookie-only"],
    ["POST", "/v1/workspaces/org_1/transfer-ownership", "cookie-only"],
    // Money plane — reads scope-gated, mutations cookie-only.
    ["GET", "/v1/billing/state", "billing:read"],
    ["GET", "/v1/billing/invoices", "billing:read"],
    ["GET", "/v1/credits", "billing:read"],
    ["GET", "/v1/credits/ledger", "billing:read"],
    ["POST", "/v1/billing/checkout", "cookie-only"],
    ["POST", "/v1/billing/topup", "cookie-only"],
    ["POST", "/v1/billing/portal", "cookie-only"],
    ["POST", "/v1/billing/trial", "cookie-only"],
    ["POST", "/v1/credits/reconcile", "cookie-only"],
    // Share-link minting/revocation — cookie-only by design.
    ["POST", "/v1/projects/prj_1/share-links", "cookie-only"],
    ["DELETE", "/v1/share/shr_1", "cookie-only"],
    ["GET", "/v1/projects/prj_1/share-links", "projects:read"],
    // The agent loop — chat:run.
    ["GET", "/v1/projects/prj_1/threads", "chat:run"],
    ["POST", "/v1/projects/prj_1/threads", "chat:run"],
    ["GET", "/v1/threads/thr_1/messages", "chat:run"],
    ["POST", "/v1/threads/thr_1/turn", "chat:run"],
    ["POST", "/v1/threads/thr_1/tools/web_search", "chat:run"],
    ["GET", "/v1/runs/run_1", "chat:run"],
    ["POST", "/v1/runs/run_1/cancel", "chat:run"],
    ["POST", "/v1/runs/run_1/apply", "chat:run"],
    ["POST", "/v1/runs/run_1/undo", "chat:run"],
    // The render pipeline — renders:queue.
    ["GET", "/v1/renders", "renders:queue"],
    ["POST", "/v1/renders", "renders:queue"],
    ["POST", "/v1/renders/estimate", "renders:queue"],
    ["GET", "/v1/renders/rnd_1", "renders:queue"],
    ["POST", "/v1/renders/rnd_1/cancel", "renders:queue"],
    // Project content plane — read vs write.
    ["GET", "/v1/projects", "projects:read"],
    ["GET", "/v1/projects/prj_1", "projects:read"],
    ["POST", "/v1/projects", "projects:write"],
    ["PATCH", "/v1/projects/prj_1", "projects:write"],
    ["DELETE", "/v1/projects/prj_1", "projects:write"],
    ["POST", "/v1/projects/prj_1/duplicate", "projects:write"],
    ["GET", "/v1/projects/prj_1/versions", "projects:read"],
    ["GET", "/v1/projects/prj_1/versions/v/diff", "projects:read"],
    ["POST", "/v1/projects/prj_1/versions", "projects:write"],
    ["POST", "/v1/projects/prj_1/versions/v/restore", "projects:write"],
    ["GET", "/v1/assets", "projects:read"],
    ["GET", "/v1/assets/ast_1/url", "projects:read"],
    ["POST", "/v1/assets", "projects:write"],
    ["POST", "/v1/assets/ast_1/complete", "projects:write"],
    ["GET", "/v1/projects/prj_1/comments", "projects:read"],
    ["POST", "/v1/projects/prj_1/comments", "projects:write"],
    ["POST", "/v1/comments/cmt_1/replies", "projects:write"],
    ["GET", "/v1/projects/prj_1/lease-state", "projects:read"],
    ["POST", "/v1/projects/prj_1/lease", "projects:write"],
    ["GET", "/v1/projects/prj_1/presence", "projects:read"],
    ["POST", "/v1/projects/prj_1/presence", "projects:write"],
    ["GET", "/v1/projects/prj_1/activity", "projects:read"],
    // Unmapped surface — fail closed.
    ["GET", "/v1/novel-surface", "cookie-only"],
  ];

  it("pins every surface's key posture", () => {
    for (const [method, path, expected] of cases) {
      const access = apiKeyRouteAccess(method, path);
      const actual =
        access.kind === "scope"
          ? access.scope
          : access.kind === "any-key"
            ? "any-key"
            : "cookie-only";
      expect(actual, `${method} ${path}`).toBe(expected);
    }
  });

  it("treats method case insensitively", () => {
    expect(apiKeyRouteAccess("get", "/v1/projects")).toEqual({
      kind: "scope",
      scope: "projects:read",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The middleware through the real app (stub deps).
// ---------------------------------------------------------------------------

interface KeyFixture {
  readonly key: string;
  readonly id: string;
}

async function mint(
  workspaceId: string,
  statements: Record<string, string[]>,
): Promise<KeyFixture> {
  const minted = await auth.createWorkspaceApiKey({
    userId: home.user.id,
    workspaceId,
    name: "scope key",
    expiresInSeconds: null,
    statements,
  });
  return { key: minted.key, id: minted.id };
}

/** The statement map a `projects:read`-only key carries. */
const READ_PROJECTS: Record<string, string[]> = { projects: ["read"] };
const FULL: Record<string, string[]> = {
  projects: ["read", "write"],
  renders: ["queue"],
  chat: ["run"],
  billing: ["read"],
};

function bearer(fixture: KeyFixture): Record<string, string> {
  return { authorization: `Bearer ${fixture.key}` };
}

describe("SEC-03 — Bearer keys through requireAuth (stub suite)", () => {
  it("a projects:read key lists projects (200) but cannot create (403 naming projects:write)", async () => {
    const fixture = await mint(home.org.id, READ_PROJECTS);

    const list = await app.request("/v1/projects?limit=5", {
      headers: { ...bearer(fixture), "x-workspace-id": home.org.id },
    });
    expect(list.status).toBe(200);

    const create = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        ...bearer(fixture),
        "x-workspace-id": home.org.id,
        "content-type": "application/json",
        "idempotency-key": "sec03-create-1",
      },
      body: JSON.stringify({ name: "Should Not Exist" }),
    });
    expect(create.status).toBe(403);
    const body = (await create.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("API_KEY_FORBIDDEN");
    expect(body.error.message).toContain("projects:write");
  });

  it("a key with NO matching scope gets 403 naming the scope it lacks", async () => {
    const fixture = await mint(home.org.id, { renders: ["queue"] });

    const response = await app.request("/v1/projects?limit=5", {
      headers: { ...bearer(fixture), "x-workspace-id": home.org.id },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("API_KEY_FORBIDDEN");
    expect(body.error.message).toContain("projects:read");
  });

  it("a full-statement (*) key reads AND writes the project plane", async () => {
    const fixture = await mint(home.org.id, FULL);

    const create = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        ...bearer(fixture),
        "x-workspace-id": home.org.id,
        "content-type": "application/json",
        "idempotency-key": "sec03-create-2",
      },
      body: JSON.stringify({ name: "Full Key Project" }),
    });
    expect(create.status).toBe(201);
  });

  it("share-link minting is cookie-only even for a full key", async () => {
    const fixture = await mint(home.org.id, FULL);

    const response = await app.request("/v1/projects/prj_anyone/share-links", {
      method: "POST",
      headers: {
        ...bearer(fixture),
        "x-workspace-id": home.org.id,
        "content-type": "application/json",
        "idempotency-key": "sec03-share-1",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_FORBIDDEN");
  });

  it("billing reads are scope-gated (403 before any repo work without billing:read)", async () => {
    const fixture = await mint(home.org.id, READ_PROJECTS);

    const response = await app.request("/v1/credits", {
      headers: { ...bearer(fixture), "x-workspace-id": home.org.id },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("billing:read");
  });

  it("any-key introspection: GET /v1/models answers 200 for a minimal key", async () => {
    const fixture = await mint(home.org.id, READ_PROJECTS);
    const response = await app.request("/v1/models", {
      headers: { ...bearer(fixture), "x-workspace-id": home.org.id },
    });
    expect(response.status).toBe(200);
  });

  it("the workspace binding confines the key to its minted workspace (§12.1 404)", async () => {
    const other = auth.signUp("owner"); // second user + workspace
    expect(other.org.id).not.toBe(home.org.id);
    // The key's user IS a member of the other workspace too — so a 404 here
    // can only come from the KEY's workspace binding, not from membership.
    other.org.members.set(home.user.id, "owner");

    const fixture = await mint(home.org.id, FULL);

    // Minted-workspace membership is NOT enough → §12.1 404, never 403.
    const cross = await app.request("/v1/projects?limit=5", {
      headers: { ...bearer(fixture), "x-workspace-id": other.org.id },
    });
    expect(cross.status).toBe(404);
    const body = (await cross.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_NOT_FOUND");

    // The minted workspace still works.
    const homeList = await app.request("/v1/projects?limit=5", {
      headers: { ...bearer(fixture), "x-workspace-id": home.org.id },
    });
    expect(homeList.status).toBe(200);
  });

  it("a revoked Bearer key gets 401 (the fake honors enabled=false)", async () => {
    const fixture = await mint(home.org.id, FULL);
    await auth.revokeApiKey(fixture.id, home.user.id);

    const response = await app.request("/v1/projects?limit=5", {
      headers: { ...bearer(fixture), "x-workspace-id": home.org.id },
    });
    expect(response.status).toBe(401);
  });

  it("a garbage studio_ Bearer token gets 401, never a 5xx", async () => {
    const response = await app.request("/v1/projects?limit=5", {
      headers: { authorization: "Bearer studio_not-a-real-key", "x-workspace-id": home.org.id },
    });
    expect(response.status).toBe(401);
  });
});
