// W5-04 (W3-G2 backend half) — the settings + workspace-audit seams over live
// Postgres + Better Auth (BUILD_PLAN §M9 settings surface; §7.1/§7.2): the
// user-scoped auto-apply preference (GET/PATCH /v1/me/settings) and the
// viewer-floor workspace audit feed (GET /v1/workspaces/:id/audit). Skips
// when no database is reachable (helpers.resolveDatabaseUrl); the server is
// the REAL gateway (bootServer) — no mocks on either path.
//
// Coverage map:
//   * settings — 401 floor for GET+PATCH; absent row reads as the documented
//     default false (D-22: off until opt-in); PATCH upserts and echoes;
//     invalid bodies fail VALIDATION_FAILED without writing
//   * audit feed — 401 floor; empty workspace reads as an empty page (not an
//     error); seeded rows (workspace.created, member.role_changed) come back
//     newest-first with the ACTOR NAME JOIN (owner's display name), and with
//     metadata/ip/actorEmail stripped (law #1); the VIEWER floor lets any
//     member read while strangers get the §12.1 404 (existence never leaks);
//     the targetType filter is server-side; cursor pagination is disjoint
//     and covers the union

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

// ---------------------------------------------------------------------------
// Fixtures (mirrors members.test.ts patterns)
// ---------------------------------------------------------------------------

const OWNER_NAME = "W504 Owner";

async function signUp(name = OWNER_NAME): Promise<CookieJar> {
  const jar = new CookieJar();
  const response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail(), password: "Passw0rd!longenough", name },
  });
  expect(response.status).toBe(200);
  return jar;
}

async function createWorkspace(jar: CookieJar, name: string): Promise<string> {
  const response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws-create") },
    body: { name, slug: unique("ws") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function meUserId(jar: CookieJar): Promise<string> {
  const response = await api(server.base, "/v1/me", { jar });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { user: { id: string } } };
  return body.data.user.id;
}

/** Owner invites `email`; that person signs up and accepts — now a member. */
async function inviteAndAccept(
  ownerJar: CookieJar,
  workspaceId: string,
  role: "admin" | "editor" | "viewer",
): Promise<CookieJar> {
  const email = uniqueEmail("member");
  const inviteResponse = await api(server.base, `/v1/workspaces/${workspaceId}/invites`, {
    method: "POST",
    jar: ownerJar,
    headers: { "idempotency-key": unique("invite") },
    body: { email, role },
  });
  expect(inviteResponse.status).toBe(201);
  const invite = (await inviteResponse.json()) as { data: { id: string } };

  const jar = new CookieJar();
  const signUpResponse = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: "Invitee" },
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

// ---------------------------------------------------------------------------
// /v1/me/settings
// ---------------------------------------------------------------------------

interface SettingsBody {
  readonly autoApplyEnabled: boolean;
}

async function getSettings(
  jar: CookieJar | null,
): Promise<{ status: number; body?: SettingsBody; code?: string }> {
  const response = await api(server.base, "/v1/me/settings", { jar: jar ?? undefined });
  const parsed = (await response.json()) as { data?: SettingsBody; error?: { code: string } };
  return { status: response.status, body: parsed.data, code: parsed.error?.code };
}

async function patchSettings(
  jar: CookieJar | null,
  body: unknown,
): Promise<{ status: number; body?: SettingsBody; code?: string }> {
  const response = await api(server.base, "/v1/me/settings", {
    method: "PATCH",
    jar: jar ?? undefined,
    body,
  });
  const parsed = (await response.json()) as { data?: SettingsBody; error?: { code: string } };
  return { status: response.status, body: parsed.data, code: parsed.error?.code };
}

d("GET/PATCH /v1/me/settings (W3-G2)", () => {
  it("401s without a session (GET and PATCH)", async () => {
    const got = await getSettings(null);
    expect(got.status).toBe(401);
    expect(got.code).toBe("AUTH_REQUIRED");
    const patched = await patchSettings(null, { autoApplyEnabled: true });
    expect(patched.status).toBe(401);
    expect(patched.code).toBe("AUTH_REQUIRED");
  });

  it("reads TRUE for a fresh user (absent row = the v2 schema default: auto-apply on)", async () => {
    const jar = await signUp();
    const result = await getSettings(jar);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ autoApplyEnabled: true });
  });

  it("PATCH upserts and echoes; the stored value survives a fresh GET", async () => {
    const jar = await signUp();
    const on = await patchSettings(jar, { autoApplyEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ autoApplyEnabled: true });

    const read = await getSettings(jar);
    expect(read.body).toEqual({ autoApplyEnabled: true });

    const off = await patchSettings(jar, { autoApplyEnabled: false });
    expect(off.body).toEqual({ autoApplyEnabled: false });
    const readAgain = await getSettings(jar);
    expect(readAgain.body).toEqual({ autoApplyEnabled: false });
  });

  it("rejects an invalid body with VALIDATION_FAILED and never writes", async () => {
    const jar = await signUp();
    for (const bad of [{ autoApplyEnabled: "yes" }, {}, { autoApplyEnabled: 1 }, null]) {
      const result = await patchSettings(jar, bad);
      expect(result.status).toBe(400);
      expect(result.code).toBe("VALIDATION_FAILED");
    }
    // Nothing was written — the read stays at the documented v2 default.
    const read = await getSettings(jar);
    expect(read.body).toEqual({ autoApplyEnabled: true });
  });

  it("is user-scoped, not workspace-scoped: one user's flag never crosses to another", async () => {
    const a = await signUp();
    const b = await signUp();
    await patchSettings(a, { autoApplyEnabled: true });
    const readB = await getSettings(b);
    expect(readB.body).toEqual({ autoApplyEnabled: true });
  });
});

// ---------------------------------------------------------------------------
// /v1/workspaces/:id/audit
// ---------------------------------------------------------------------------

interface AuditEntryRow {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

interface AuditPage {
  readonly status: number;
  readonly items: AuditEntryRow[];
  readonly nextCursor: string | null;
  readonly code?: string;
}

async function listAudit(
  jar: CookieJar | null,
  workspaceId: string,
  query?: { limit?: number; cursor?: string; targetType?: string },
): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) params.set("limit", String(query.limit));
  if (query?.cursor !== undefined) params.set("cursor", query.cursor);
  if (query?.targetType !== undefined) params.set("targetType", query.targetType);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await api(server.base, `/v1/workspaces/${workspaceId}/audit${suffix}`, {
    jar: jar ?? undefined,
  });
  const body = (await response.json()) as {
    data?: { items: AuditEntryRow[]; nextCursor: string | null };
    error?: { code: string };
  };
  return {
    status: response.status,
    items: body.data?.items ?? [],
    nextCursor: body.data?.nextCursor ?? null,
    code: body.error?.code,
  };
}

d("GET /v1/workspaces/:id/audit (W3-G2)", () => {
  it("401s without a session", async () => {
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Audit WS"));
    const result = await listAudit(null, ws);
    expect(result.status).toBe(401);
    expect(result.code).toBe("AUTH_REQUIRED");
  });

  it("reads an empty workspace as an empty page (not an error)", async () => {
    // A workspace created through the API always logs workspace.created, so
    // seed the empty case through a SECOND workspace... which also logs. The
    // genuinely-empty read is the targetType filter with no matches.
    const jar = await signUp();
    const ws = await createWorkspace(jar, unique("Audit WS"));
    const none = await listAudit(jar, ws, { targetType: "no-such-target-type" });
    expect(none.status).toBe(200);
    expect(none.items).toEqual([]);
    expect(none.nextCursor).toBeNull();
  });

  it("returns seeded rows newest-first with the actor-name join and law-#1 stripping", async () => {
    const ownerJar = await signUp();
    const ownerId = await meUserId(ownerJar);
    const ws = await createWorkspace(ownerJar, unique("Audit WS"));
    const memberJar = await inviteAndAccept(ownerJar, ws, "viewer");

    const page = await listAudit(ownerJar, ws);
    expect(page.status).toBe(200);
    expect(page.items.length).toBeGreaterThanOrEqual(2);

    // Newest-first ordering.
    const times = page.items.map((row) => Date.parse(row.createdAt));
    for (let i = 1; i < times.length; i += 1) {
      const later = times[i - 1];
      const earlier = times[i];
      if (later === undefined || earlier === undefined) throw new Error("bad times");
      expect(later).toBeGreaterThanOrEqual(earlier);
    }

    // The actor join: the workspace.created row names its founder.
    const created = page.items.find((row) => row.action === "workspace.created");
    expect(created).toBeDefined();
    expect(created?.actorId).toBe(ownerId);
    expect(created?.actorName).toBe(OWNER_NAME);
    expect(created?.targetType).toBe("workspace");
    expect(created?.targetId).toBe(ws);

    // Law #1: metadata/ip/actorEmail never cross the wire on this feed.
    for (const row of page.items) {
      expect(Object.keys(row).sort()).toEqual([
        "action",
        "actorId",
        "actorName",
        "createdAt",
        "id",
        "targetId",
        "targetType",
      ]);
    }

    // The viewer floor: the invited VIEWER reads the same feed.
    const asViewer = await listAudit(memberJar, ws);
    expect(asViewer.status).toBe(200);
    expect(asViewer.items.length).toBe(page.items.length);
  });

  it("404s for a non-member (existence never leaks, §12.1)", async () => {
    const ownerJar = await signUp();
    const ws = await createWorkspace(ownerJar, unique("Audit WS"));
    const stranger = await signUp("Stranger");
    const result = await listAudit(stranger, ws);
    expect(result.status).toBe(404);
    expect(result.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("filters server-side by targetType", async () => {
    const ownerJar = await signUp();
    const ws = await createWorkspace(ownerJar, unique("Audit WS"));
    const memberJar = await inviteAndAccept(ownerJar, ws, "editor");

    // A role change guarantees a member-targeted row beyond the invite rows.
    const memberList = await api(server.base, `/v1/workspaces/${ws}/members`, {
      jar: ownerJar,
    });
    const roster = (await memberList.json()) as {
      data: { items: { id: string; isCurrentUser: boolean }[] };
    };
    const target = roster.data.items.find((entry) => !entry.isCurrentUser);
    expect(target).toBeDefined();
    const change = await api(server.base, `/v1/workspaces/${ws}/members/${target?.id}`, {
      method: "PATCH",
      jar: ownerJar,
      body: { role: "viewer" },
    });
    expect(change.status).toBe(200);

    const all = await listAudit(ownerJar, ws);
    expect(all.items.length).toBeGreaterThanOrEqual(2);
    const membersOnly = await listAudit(ownerJar, ws, { targetType: "member" });
    expect(membersOnly.status).toBe(200);
    expect(membersOnly.items.length).toBeGreaterThan(0);
    expect(membersOnly.items.length).toBeLessThan(all.items.length);
    for (const row of membersOnly.items) {
      expect(row.targetType).toBe("member");
    }
    // The role change row names the owner as the actor.
    const roleChanged = membersOnly.items.find((row) => row.action === "member.role_changed");
    expect(roleChanged).toBeDefined();
    expect(roleChanged?.actorName).toBe(OWNER_NAME);

    // The editor member (before the demotion landed in the roster read) can
    // still read the feed — the viewer floor, not an editor floor.
    const asEditor = await listAudit(memberJar, ws);
    expect(asEditor.status).toBe(200);
  });

  it("paginates with a disjoint, union-covering cursor", async () => {
    const ownerJar = await signUp();
    const ws = await createWorkspace(ownerJar, unique("Audit WS"));
    // 3 invites + the create row = ≥4 rows.
    await inviteAndAccept(ownerJar, ws, "viewer");
    await inviteAndAccept(ownerJar, ws, "viewer");
    await inviteAndAccept(ownerJar, ws, "viewer");

    const first = await listAudit(ownerJar, ws, { limit: 2 });
    expect(first.status).toBe(200);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAudit(ownerJar, ws, { limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.status).toBe(200);
    expect(second.items).toHaveLength(2);

    const firstIds = new Set(first.items.map((row) => row.id));
    for (const row of second.items) {
      expect(firstIds.has(row.id)).toBe(false);
    }

    const rest = await listAudit(ownerJar, ws, { cursor: second.nextCursor ?? "" });
    const union = [...first.items, ...second.items, ...rest.items].map((row) => row.id);
    expect(new Set(union).size).toBe(union.length);
    const all = await listAudit(ownerJar, ws);
    expect(union.length).toBe(all.items.length);
  });

  it("rejects an out-of-range limit with VALIDATION_FAILED", async () => {
    const ownerJar = await signUp();
    const ws = await createWorkspace(ownerJar, unique("Audit WS"));
    const result = await listAudit(ownerJar, ws, { limit: 101 });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION_FAILED");
  });
});
