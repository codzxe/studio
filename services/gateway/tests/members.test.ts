// W1-a — member management over HTTP against live Postgres + Better Auth
// (BUILD_PLAN §M1 task 2 / AUD-1 gap #1): list, role-change matrix, removal,
// self-removal, last-owner protection, ownership transfer and the
// active-workspace switch. Skips when no database is reachable (see
// helpers.resolveDatabaseUrl); the server is the REAL gateway (bootServer) —
// no mocks on the member path.
//
// Coverage map:
//   * list + membership gate — any member lists; strangers get the §12.1 404
//     (existence never leaks), never 403
//   * cursor pagination — limit=2 over 4 members, disjoint pages, union = all
//   * role-change matrix — viewer ✗ / editor ✗ / admin ✓ / owner ✓,
//     owner-target changes are owner-only, the last owner can't be demoted
//   * removal — admin ✓, editor ✗, self-removal ✓ (viewer), last owner ✗
//   * transfer — admin ✗, owner ✓ (old owner becomes admin), self 409,
//     non-member 404
//   * switch — the session's active workspace changes server-side (observed
//     through GET /v1/me's plan.creditsBalance, which reads the ACTIVE
//     workspace's ledger)
//   * audit rows — member.role_changed / member.removed /
//     workspace.ownership_transferred land in the workspace audit log

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
// Fixtures (mirrors auth-workspace.test.ts patterns)
// ---------------------------------------------------------------------------

async function signUp(): Promise<CookieJar> {
  const jar = new CookieJar();
  const response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail(), password: "Passw0rd!longenough", name: "W1A User" },
  });
  expect(response.status).toBe(200);
  return jar;
}

async function createWorkspace(
  jar: CookieJar,
  name: string,
): Promise<{ id: string; name: string; slug: string }> {
  const response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws-create") },
    body: { name, slug: unique("ws") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string; name: string; slug: string } };
  return body.data;
}

interface MemberRow {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly status: string;
  readonly lastActiveAt: string | null;
  readonly isCurrentUser: boolean;
}

async function listMembers(
  jar: CookieJar,
  workspaceId: string,
  query?: { limit?: number; cursor?: string },
): Promise<{ status: number; items: MemberRow[]; nextCursor: string | null; err?: { code: string } }> {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) params.set("limit", String(query.limit));
  if (query?.cursor !== undefined) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await api(server.base, `/v1/workspaces/${workspaceId}/members${suffix}`, {
    jar,
  });
  const body = (await response.json()) as {
    data?: { items: MemberRow[]; nextCursor: string | null };
    error?: { code: string };
  };
  return {
    status: response.status,
    items: body.data?.items ?? [],
    nextCursor: body.data?.nextCursor ?? null,
    err: body.error,
  };
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
  role: "owner" | "admin" | "editor" | "viewer",
): Promise<{ jar: CookieJar; userId: string }> {
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
  return { jar, userId: await meUserId(jar) };
}

/** A ready-to-use workspace with the owner + `roles.length` invited members. */
async function seededWorkspace(
  roles: readonly ("admin" | "editor" | "viewer")[],
): Promise<{
  workspaceId: string;
  ownerJar: CookieJar;
  ownerId: string;
  members: { jar: CookieJar; userId: string; role: string }[];
}> {
  const ownerJar = await signUp();
  const ws = await createWorkspace(ownerJar, unique("Members WS"));
  const ownerId = await meUserId(ownerJar);
  const members: { jar: CookieJar; userId: string; role: string }[] = [];
  for (const role of roles) {
    const seeded = await inviteAndAccept(ownerJar, ws.id, role);
    members.push({ jar: seeded.jar, userId: seeded.userId, role });
  }
  return { workspaceId: ws.id, ownerJar, ownerId, members };
}

async function changeRole(
  jar: CookieJar,
  workspaceId: string,
  memberId: string,
  role: string,
): Promise<{ status: number; body: { data?: MemberRow; error?: { code: string } } }> {
  const response = await api(
    server.base,
    `/v1/workspaces/${workspaceId}/members/${encodeURIComponent(memberId)}`,
    { method: "PATCH", jar, body: { role } },
  );
  return { status: response.status, body: (await response.json()) as never };
}

async function removeMember(
  jar: CookieJar,
  workspaceId: string,
  memberId: string,
): Promise<{ status: number; body: { data?: { id: string; removed: boolean }; error?: { code: string } } }> {
  const response = await api(
    server.base,
    `/v1/workspaces/${workspaceId}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE", jar },
  );
  return { status: response.status, body: (await response.json()) as never };
}

async function transferOwnership(
  jar: CookieJar,
  workspaceId: string,
  memberId: string,
): Promise<{
  status: number;
  body: {
    data?: { workspaceId: string; ownerId: string; previousOwnerId: string };
    error?: { code: string };
  };
}> {
  const response = await api(server.base, `/v1/workspaces/${workspaceId}/transfer-ownership`, {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("transfer") },
    body: { memberId },
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function switchWorkspace(
  jar: CookieJar,
  workspaceId: string,
): Promise<{
  status: number;
  body: { data?: { workspaceId: string; name: string; slug: string }; error?: { code: string } };
}> {
  const response = await api(server.base, `/v1/workspaces/${workspaceId}/switch`, {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("switch") },
  });
  return { status: response.status, body: (await response.json()) as never };
}

interface AuditRow {
  readonly action: string;
  readonly targetId: string | null;
  readonly metadata: unknown;
}

async function auditRows(workspaceId: string): Promise<AuditRow[]> {
  const result = await server.deps.repos.audit.list(workspaceId, { limit: 100 });
  return result.items.map((row) => ({
    action: row.action,
    targetId: row.targetId,
    metadata: row.metadata,
  }));
}

// ---------------------------------------------------------------------------
// GET /v1/workspaces/:id/members
// ---------------------------------------------------------------------------

d("member list (§7.2 list, §12.1 gate)", () => {
  it("lists the owner with the full member shape", async () => {
    const ownerJar = await signUp();
    const ws = await createWorkspace(ownerJar, unique("List WS"));
    const ownerId = await meUserId(ownerJar);

    const result = await listMembers(ownerJar, ws.id);
    expect(result.status).toBe(200);
    expect(result.items).toHaveLength(1);
    const [owner] = result.items;
    expect(owner).toBeDefined();
    expect(owner?.id).toBe(ownerId);
    expect(owner?.role).toBe("owner");
    expect(owner?.status).toBe("active");
    expect(owner?.lastActiveAt).toBeNull();
    expect(owner?.isCurrentUser).toBe(true);
    expect(Object.keys(owner ?? {}).sort()).toEqual([
      "email",
      "id",
      "isCurrentUser",
      "lastActiveAt",
      "name",
      "role",
      "status",
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("404s for a non-member (existence never leaks, §12.1)", async () => {
    const ownerJar = await signUp();
    const ws = await createWorkspace(ownerJar, unique("Private WS"));
    const stranger = await signUp();
    const result = await listMembers(stranger, ws.id);
    expect(result.status).toBe(404);
    expect(result.err?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("lets any member list — a viewer sees themselves flagged", async () => {
    const { workspaceId, members } = await seededWorkspace(["viewer"]);
    const viewer = members[0];
    expect(viewer).toBeDefined();
    const result = await listMembers(viewer?.jar ?? new CookieJar(), workspaceId);
    expect(result.status).toBe(200);
    const self = result.items.find((row) => row.id === viewer?.userId);
    expect(self?.role).toBe("viewer");
    expect(self?.isCurrentUser).toBe(true);
  });

  it("paginates with a cursor (disjoint pages, union = everyone)", async () => {
    const { workspaceId, ownerJar, ownerId, members } = await seededWorkspace([
      "admin",
      "editor",
      "viewer",
    ]);
    const expected = new Set([ownerId, ...members.map((member) => member.userId)]);

    const firstPage = await listMembers(ownerJar, workspaceId, { limit: 2 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTruthy();
    // Stable order: the workspace founder (first member row) leads page 1.
    expect(firstPage.items[0]?.id).toBe(ownerId);

    const secondPage = await listMembers(ownerJar, workspaceId, {
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.status).toBe(200);
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();

    const seen = new Set([...firstPage.items, ...secondPage.items].map((row) => row.id));
    expect(seen).toEqual(expected);
    const firstIds = firstPage.items.map((row) => row.id);
    for (const row of secondPage.items) {
      expect(firstIds).not.toContain(row.id);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/workspaces/:id/members/:memberId
// ---------------------------------------------------------------------------

d("role change (§3.3 matrix, §7.1 audit)", () => {
  it("viewer cannot change roles — 403 FORBIDDEN", async () => {
    const { workspaceId, members } = await seededWorkspace(["viewer", "editor"]);
    const viewer = members[0];
    const editor = members[1];
    const result = await changeRole(viewer?.jar ?? new CookieJar(), workspaceId, editor?.userId ?? "", "viewer");
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("FORBIDDEN");
  });

  it("editor cannot change roles — 403 FORBIDDEN", async () => {
    const { workspaceId, members } = await seededWorkspace(["editor", "viewer"]);
    const editor = members[0];
    const viewer = members[1];
    const result = await changeRole(editor?.jar ?? new CookieJar(), workspaceId, viewer?.userId ?? "", "viewer");
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("FORBIDDEN");
  });

  it("admin changes a member's role and it persists (audit: member.role_changed)", async () => {
    const { workspaceId, members } = await seededWorkspace(["admin", "editor"]);
    const admin = members[0];
    const editor = members[1];
    const result = await changeRole(
      admin?.jar ?? new CookieJar(),
      workspaceId,
      editor?.userId ?? "",
      "viewer",
    );
    expect(result.status).toBe(200);
    expect(result.body.data?.role).toBe("viewer");
    expect(result.body.data?.id).toBe(editor?.userId);

    const owner = await listMembers(admin?.jar ?? new CookieJar(), workspaceId);
    const row = owner.items.find((entry) => entry.id === editor?.userId);
    expect(row?.role).toBe("viewer");

    const rows = await auditRows(workspaceId);
    const audited = rows.find(
      (row) => row.action === "member.role_changed" && row.targetId === editor?.userId,
    );
    expect(audited).toBeDefined();
    expect((audited?.metadata as { from?: string; to?: string } | undefined)?.from).toBe("editor");
    expect((audited?.metadata as { from?: string; to?: string } | undefined)?.to).toBe("viewer");
  });

  it("admin cannot change the owner's role — owner-target changes are owner-only", async () => {
    const { workspaceId, ownerId, members } = await seededWorkspace(["admin"]);
    const admin = members[0];
    const result = await changeRole(admin?.jar ?? new CookieJar(), workspaceId, ownerId, "admin");
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("FORBIDDEN");
  });

  it("the last owner cannot be demoted — 409 CONFLICT (owner self-demotion)", async () => {
    const { workspaceId, ownerJar, ownerId, members } = await seededWorkspace(["editor"]);
    const result = await changeRole(ownerJar, workspaceId, ownerId, "admin");
    expect(result.status).toBe(409);
    expect(result.body.error?.code).toBe("CONFLICT");
    // The editor was untouched by the failed demotion.
    const rows = await listMembers(ownerJar, workspaceId);
    expect(rows.items.find((row) => row.id === members[0]?.userId)?.role).toBe("editor");
  });

  it("owner promotes a member to admin (owner<->admin transitions)", async () => {
    const { workspaceId, ownerJar, members } = await seededWorkspace(["editor"]);
    const editor = members[0];
    const result = await changeRole(ownerJar, workspaceId, editor?.userId ?? "", "admin");
    expect(result.status).toBe(200);
    expect(result.body.data?.role).toBe("admin");
    const rows = await listMembers(ownerJar, workspaceId);
    expect(rows.items.find((row) => row.id === editor?.userId)?.role).toBe("admin");
  });

  it("an unknown member id reads as 404", async () => {
    const { workspaceId, ownerJar } = await seededWorkspace([]);
    const result = await changeRole(ownerJar, workspaceId, "usr_missing_member", "viewer");
    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/workspaces/:id/members/:memberId
// ---------------------------------------------------------------------------

d("member removal (§7.1 audit, last-owner protection)", () => {
  it("admin removes a member; the row disappears and member.removed is audited", async () => {
    const { workspaceId, members } = await seededWorkspace(["admin", "viewer"]);
    const admin = members[0];
    const viewer = members[1];
    const result = await removeMember(
      admin?.jar ?? new CookieJar(),
      workspaceId,
      viewer?.userId ?? "",
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ id: viewer?.userId, removed: true });

    const rows = await listMembers(admin?.jar ?? new CookieJar(), workspaceId);
    expect(rows.items.some((row) => row.id === viewer?.userId)).toBe(false);

    const audited = await auditRows(workspaceId);
    const row = audited.find(
      (entry) => entry.action === "member.removed" && entry.targetId === viewer?.userId,
    );
    expect(row).toBeDefined();
    expect((row?.metadata as { self?: boolean } | undefined)?.self).toBe(false);
  });

  it("editor cannot remove someone else — 403", async () => {
    const { workspaceId, members } = await seededWorkspace(["editor", "viewer"]);
    const editor = members[0];
    const viewer = members[1];
    const result = await removeMember(
      editor?.jar ?? new CookieJar(),
      workspaceId,
      viewer?.userId ?? "",
    );
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("FORBIDDEN");
  });

  it("self-removal works for a viewer; the membership is gone from /v1/me", async () => {
    const { workspaceId, members } = await seededWorkspace(["viewer"]);
    const viewer = members[0];
    const result = await removeMember(
      viewer?.jar ?? new CookieJar(),
      workspaceId,
      viewer?.userId ?? "",
    );
    expect(result.status).toBe(200);
    expect(result.body.data?.removed).toBe(true);

    const meResponse = await api(server.base, "/v1/me", { jar: viewer?.jar ?? new CookieJar() });
    const me = (await meResponse.json()) as {
      data: { memberships: { workspaceId: string }[] };
    };
    expect(me.data.memberships.some((row) => row.workspaceId === workspaceId)).toBe(false);
  });

  it("the last owner cannot remove themselves — 409 CONFLICT", async () => {
    const { workspaceId, ownerJar, ownerId } = await seededWorkspace([]);
    const result = await removeMember(ownerJar, workspaceId, ownerId);
    expect(result.status).toBe(409);
    expect(result.body.error?.code).toBe("CONFLICT");
    const rows = await listMembers(ownerJar, workspaceId);
    expect(rows.items.some((row) => row.id === ownerId)).toBe(true);
  });

  it("an unknown member id reads as 404", async () => {
    const { workspaceId, ownerJar } = await seededWorkspace([]);
    const result = await removeMember(ownerJar, workspaceId, "usr_missing_member");
    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/workspaces/:id/transfer-ownership
// ---------------------------------------------------------------------------

d("ownership transfer (owner only; old owner becomes admin)", () => {
  it("admin cannot transfer ownership — 403", async () => {
    const { workspaceId, members } = await seededWorkspace(["admin", "editor"]);
    const admin = members[0];
    const editor = members[1];
    const result = await transferOwnership(
      admin?.jar ?? new CookieJar(),
      workspaceId,
      editor?.userId ?? "",
    );
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("FORBIDDEN");
  });

  it("owner transfers; roles swap and workspace.ownership_transferred is audited", async () => {
    const { workspaceId, ownerJar, ownerId, members } = await seededWorkspace(["admin"]);
    const heir = members[0];

    const result = await transferOwnership(ownerJar, workspaceId, heir?.userId ?? "");
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({
      workspaceId,
      ownerId: heir?.userId,
      previousOwnerId: ownerId,
    });

    const rows = await listMembers(ownerJar, workspaceId);
    expect(rows.items.find((row) => row.id === heir?.userId)?.role).toBe("owner");
    expect(rows.items.find((row) => row.id === ownerId)?.role).toBe("admin");

    const audited = await auditRows(workspaceId);
    const row = audited.find((entry) => entry.action === "workspace.ownership_transferred");
    expect(row).toBeDefined();
    const metadata = row?.metadata as { fromUserId?: string; toUserId?: string } | undefined;
    expect(metadata?.fromUserId).toBe(ownerId);
    expect(metadata?.toUserId).toBe(heir?.userId);

    // The previous owner (now admin) loses owner-target powers: changing the
    // new owner's role is owner-only, and the last owner can't be demoted —
    // the demote attempt lands as a typed 403 (owner-target, non-owner actor).
    const touchHeir = await changeRole(ownerJar, workspaceId, heir?.userId ?? "", "admin");
    expect(touchHeir.status).toBe(403);
    expect(touchHeir.body.error?.code).toBe("FORBIDDEN");
  });

  it("transfer to yourself reads as 409 CONFLICT", async () => {
    const { workspaceId, ownerJar, ownerId } = await seededWorkspace([]);
    const result = await transferOwnership(ownerJar, workspaceId, ownerId);
    expect(result.status).toBe(409);
    expect(result.body.error?.code).toBe("CONFLICT");
  });

  it("transfer to a non-member reads as 404", async () => {
    const { workspaceId, ownerJar } = await seededWorkspace([]);
    const result = await transferOwnership(ownerJar, workspaceId, "usr_stranger");
    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/workspaces/:id/switch
// ---------------------------------------------------------------------------

d("active-workspace switch (session scope)", () => {
  it("changes the caller's active workspace server-side", async () => {
    const ownerJar = await signUp();
    const wsA = await createWorkspace(ownerJar, unique("Switch A"));
    const wsB = await createWorkspace(ownerJar, unique("Switch B"));
    // Only B has credits; /v1/me's plan.creditsBalance reads the ACTIVE
    // workspace's ledger (routes/me.ts), so the balance proves the switch.
    await server.deps.repos.ledger.grant(wsB.id, {
      amount: 500,
      idempotencyKey: unique("led-grant"),
    });

    const switchToA = await switchWorkspace(ownerJar, wsA.id);
    expect(switchToA.status).toBe(200);
    expect(switchToA.body.data).toEqual({
      workspaceId: wsA.id,
      name: wsA.name,
      slug: wsA.slug,
    });

    const meA = await api(server.base, "/v1/me", { jar: ownerJar });
    const meABody = (await meA.json()) as { data: { plan: { creditsBalance: number } } };
    expect(meABody.data.plan.creditsBalance).toBe(0);

    const switchToB = await switchWorkspace(ownerJar, wsB.id);
    expect(switchToB.status).toBe(200);
    expect(switchToB.body.data?.workspaceId).toBe(wsB.id);

    const meB = await api(server.base, "/v1/me", { jar: ownerJar });
    const meBBody = (await meB.json()) as { data: { plan: { creditsBalance: number } } };
    expect(meBBody.data.plan.creditsBalance).toBe(500);
  });

  it("switching to a non-member workspace reads as 404 (§12.1)", async () => {
    const ownerJar = await signUp();
    const strangerJar = await signUp();
    const ws = await createWorkspace(strangerJar, unique("Foreign WS"));
    const result = await switchWorkspace(ownerJar, ws.id);
    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("WORKSPACE_NOT_FOUND");
  });
});
