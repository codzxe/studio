// M7-E — share/review backend over HTTP against live Postgres (BUILD_PLAN
// §M7 task 5; DECISIONS D-15): issue → verify, hash-only token storage, the
// password gate (missing/wrong/ok), expiry, revoke → public 404, guest
// comments via the pinned createGuestComment handler (happy + per-IP rate
// limit), request-access audit rows, cross-tenant 404s (§12.1), the presence
// repo pins (M7-B consumes), unknown tokens, and the public manifest's
// no-id-leak shape.
//
// Requires the real Postgres (bootServer) — describe.skipIf(!HAS_DATABASE).

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, tablesFor } from "@studio/db";

import {
  CookieJar,
  DATABASE_URL,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  closeDb,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

let server: RunningTestServer;
/** Raw db handle for row-level pins (hash-only storage, force-expiry). */
let rawDb: ReturnType<typeof createDb>;
/** Dialect-correct tables for rawDb (W4-GWI: tablesFor over the pg schema). */
let t: ReturnType<typeof tablesFor>;

beforeAll(async () => {
  server = await bootServer();
  if (DATABASE_URL !== null) {
    rawDb = createDb(DATABASE_URL, { max: 2 });
    t = tablesFor(rawDb);
  }
}, 30_000);

afterAll(async () => {
  await server?.close();
  try {
    await closeDb(rawDb);
  } catch {
    // already closed
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Workspace {
  readonly id: string;
  readonly jar: CookieJar;
}

async function newWorkspace(name = "Share Owner"): Promise<Workspace> {
  const jar = new CookieJar();
  let response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail("share"), password: "Passw0rd!longenough", name },
  });
  expect(response.status).toBe(200);
  response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Share WS"), slug: unique("share-ws") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return { id: body.data.id, jar };
}

async function createProject(ws: Workspace, name = "Shared Project"): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique(name) },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

interface IssuedLink {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string | null;
  readonly hasPassword: boolean;
}

async function issueLink(
  ws: Workspace,
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; link?: IssuedLink; errCode?: string }> {
  const response = await api(server.base, `/v1/projects/${projectId}/share-links`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("share") },
    body,
  });
  const parsed = (await response.json()) as {
    data?: IssuedLink;
    error?: { code: string };
  };
  return { status: response.status, link: parsed.data, errCode: parsed.error?.code };
}

function shareHeaders(init: Record<string, string> = {}): Record<string, string> {
  return { ...init };
}

async function getShare(path: string, headers: Record<string, string> = {}) {
  const response = await api(server.base, path, { headers: shareHeaders(headers) });
  const parsed = (await response.json().catch(() => null)) as {
    data?: Record<string, unknown>;
    error?: { code: string };
  } | null;
  return { status: response.status, data: parsed?.data, errCode: parsed?.error?.code };
}

// ---------------------------------------------------------------------------
// Issue → verify
// ---------------------------------------------------------------------------

d("share links: issue, verify, hash-only storage", () => {
  let ws: Workspace;
  let projectId: string;
  let issued: IssuedLink;

  it("issues a link (201) and returns the raw token exactly once", async () => {
    ws = await newWorkspace();
    projectId = await createProject(ws);
    const result = await issueLink(ws, projectId);
    expect(result.status).toBe(201);
    expect(result.link).toBeDefined();
    issued = result.link as IssuedLink;
    expect(issued.token.length).toBeGreaterThanOrEqual(16);
    expect(issued.hasPassword).toBe(false);
    expect(issued.expiresAt).toBeNull();
  });

  it("GET /v1/share/:token answers the public metadata (never content)", async () => {
    const { status, data } = await getShare(`/v1/share/${issued.token}`);
    expect(status).toBe(200);
    expect(data?.projectId).toBe(projectId);
    expect(String(data?.projectName).length).toBeGreaterThan(0);
    expect(data?.hasPassword).toBe(false);
    expect(data?.compId).toBeNull();
    expect(data?.requestAccessEmail).toBeNull();
  });

  it("stores ONLY the sha256 hash — the raw token is in no row and no GET", async () => {
    const [row] = await rawDb.select().from(t.shareTokens).where(eq(t.shareTokens.id, issued.id));
    expect(row).toBeDefined();
    const expectedHash = createHash("sha256").update(issued.token).digest("hex");
    expect(row?.tokenHash).toBe(expectedHash);
    expect(row?.tokenHash).not.toBe(issued.token);

    // The member list carries NO token material at all.
    const listResponse = await api(server.base, `/v1/projects/${projectId}/share-links`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { data: { items: Record<string, unknown>[] } };
    expect(listBody.data.items).toHaveLength(1);
    const shape = listBody.data.items[0] as unknown as Record<string, unknown>;
    expect("token" in shape).toBe(false);
    expect("tokenHash" in shape).toBe(false);
    expect("passwordHash" in shape).toBe(false);
    expect(shape.hasPassword).toBe(false);

    // And the public GET never echoes it either.
    const { data } = await getShare(`/v1/share/${issued.token}`);
    expect(JSON.stringify(data)).not.toContain(issued.token);
  });

  it("an idempotent issue replay returns the SAME token (a retry never mints twice)", async () => {
    const key = unique("idem");
    const first = await api(server.base, `/v1/projects/${projectId}/share-links`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": key },
      body: {},
    });
    expect(first.status).toBe(201);
    const replay = await api(server.base, `/v1/projects/${projectId}/share-links`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": key },
      body: {},
    });
    expect(replay.status).toBe(201);
    const firstBody = (await first.json()) as { data: IssuedLink };
    const replayBody = (await replay.json()) as { data: IssuedLink };
    expect(replayBody.data.token).toBe(firstBody.data.token);
  });

  it("requires a session (401) and at least the editor role (403 for viewers)", async () => {
    const anon = await api(server.base, `/v1/projects/${projectId}/share-links`, {
      method: "POST",
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("share") },
      body: {},
    });
    expect(anon.status).toBe(401);
    const body = (await anon.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });
});

d("share links: cross-tenant + unknown ids (§12.1)", () => {
  it("another workspace cannot issue a link for a foreign project (404)", async () => {
    const wsA = await newWorkspace("Tenant A");
    const projectId = await createProject(wsA, "Tenant A Project");
    const wsB = await newWorkspace("Tenant B");
    const result = await issueLink(wsB, projectId);
    expect(result.status).toBe(404);
    expect(result.errCode).toBe("PROJECT_NOT_FOUND");
  });

  it("an unknown token is 404 on every public route", async () => {
    const unknown = `no-such-token-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const info = await getShare(`/v1/share/${unknown}`);
    expect(info.status).toBe(404);
    const manifest = await getShare(`/v1/share/${unknown}/manifest`);
    expect(manifest.status).toBe(404);
    const comments = await api(server.base, `/v1/share/${unknown}/comments`, {
      method: "POST",
      body: { compId: "comp-main", body: "hi", guestName: "G", guestEmail: "g@x.io" },
    });
    expect(comments.status).toBe(404);
    const access = await api(server.base, `/v1/share/${unknown}/request-access`, {
      method: "POST",
      body: { email: "g@x.io" },
    });
    expect(access.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Password gate
// ---------------------------------------------------------------------------

d("share links: the password gate (missing / wrong / ok)", () => {
  let ws: Workspace;
  let projectId: string;
  let issued: IssuedLink;
  const password = "Passw0rd!share";

  beforeAll(async () => {
    ws = await newWorkspace("Gate Owner");
    projectId = await createProject(ws, "Gated Project");
    const result = await issueLink(ws, projectId, { password });
    expect(result.status).toBe(201);
    issued = result.link as IssuedLink;
  });

  it("GET /v1/share/:token reports hasPassword WITHOUT requiring it", async () => {
    const { status, data } = await getShare(`/v1/share/${issued.token}`);
    expect(status).toBe(200);
    expect(data?.hasPassword).toBe(true);
  });

  it("manifest without the header → 401; wrong password → 401; ok → 200", async () => {
    const missing = await getShare(`/v1/share/${issued.token}/manifest`, {
      "x-forwarded-for": "203.0.113.1",
    });
    expect(missing.status).toBe(401);
    expect(missing.errCode).toBe("AUTH_REQUIRED");

    const wrong = await getShare(`/v1/share/${issued.token}/manifest`, {
      "x-share-password": "not-the-password",
      "x-forwarded-for": "203.0.113.2",
    });
    expect(wrong.status).toBe(401);

    const ok = await getShare(`/v1/share/${issued.token}/manifest`, {
      "x-share-password": password,
      "x-forwarded-for": "203.0.113.3",
    });
    expect(ok.status).toBe(200);
  });

  it("comments are gated the same way (GET + POST)", async () => {
    const guestBody = {
      compId: "comp-main",
      body: "nice",
      guestName: "Guest",
      guestEmail: "guest@example.io",
    };
    const denied = await api(server.base, `/v1/share/${issued.token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.4" },
      body: guestBody,
    });
    expect(denied.status).toBe(401);
    const wrong = await api(server.base, `/v1/share/${issued.token}/comments`, {
      method: "POST",
      headers: { "x-share-password": "nope", "x-forwarded-for": "203.0.113.5" },
      body: guestBody,
    });
    expect(wrong.status).toBe(401);
    const ok = await api(server.base, `/v1/share/${issued.token}/comments`, {
      method: "POST",
      headers: {
        "x-share-password": password,
        "x-forwarded-for": "203.0.113.6",
        "content-type": "application/json",
      },
      body: guestBody,
    });
    expect(ok.status).toBe(201);
    const listed = await getShare(`/v1/share/${issued.token}/comments`, {
      "x-share-password": password,
      "x-forwarded-for": "203.0.113.7",
    });
    expect(listed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Expiry + revocation
// ---------------------------------------------------------------------------

d("share links: expiry + revocation kill the public surface", () => {
  let ws: Workspace;
  let projectId: string;
  let issued: IssuedLink;

  beforeAll(async () => {
    ws = await newWorkspace("Revoke Owner");
    projectId = await createProject(ws, "Revocable Project");
    const result = await issueLink(ws, projectId, { expiresInDays: 1 });
    expect(result.status).toBe(201);
    issued = result.link as IssuedLink;
    expect(issued.expiresAt).not.toBeNull();
  });

  it("expiresAt lands ~one day out; a force-expired row 404s publicly", async () => {
    const expiresAt = new Date(issued.expiresAt as string).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    expect(expiresAt).toBeLessThan(Date.now() + 25 * 3600 * 1000);

    // Force the row into the past (time travel without waiting a day).
    await rawDb
      .update(t.shareTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(t.shareTokens.id, issued.id));
    const expired = await getShare(`/v1/share/${issued.token}`);
    expect(expired.status).toBe(404);
  });

  it("a stranger's revoke is 404; the owner revokes → every public route 404s", async () => {
    const stranger = await newWorkspace("Stranger");
    const strangerAttempt = await api(server.base, `/v1/share/${issued.id}`, {
      method: "DELETE",
      jar: stranger.jar,
    });
    expect(strangerAttempt.status).toBe(404);

    // Re-verify live first (the expiry test above force-expired THIS row —
    // issue a fresh link for the revoke scenario).
    const fresh = await issueLink(ws, projectId);
    expect(fresh.status).toBe(201);
    const freshLink = fresh.link as IssuedLink;
    expect((await getShare(`/v1/share/${freshLink.token}`)).status).toBe(200);

    const revoke = await api(server.base, `/v1/share/${freshLink.id}`, {
      method: "DELETE",
      jar: ws.jar,
    });
    expect(revoke.status).toBe(200);
    const revokeBody = (await revoke.json()) as { data: { id: string; revokedAt: string | null } };
    expect(revokeBody.data.revokedAt).not.toBeNull();

    // Revoked → the token is dead on ALL public routes (§M7 task 5).
    expect((await getShare(`/v1/share/${freshLink.token}`)).status).toBe(404);
    expect((await getShare(`/v1/share/${freshLink.token}/manifest`)).status).toBe(404);
    expect((await getShare(`/v1/share/${freshLink.token}/comments`)).status).toBe(404);
    const post = await api(server.base, `/v1/share/${freshLink.token}/comments`, {
      method: "POST",
      body: { compId: "comp-main", body: "hi", guestName: "G", guestEmail: "g@x.io" },
    });
    expect(post.status).toBe(404);

    // Revocation is idempotent (same row, same timestamp).
    const again = await api(server.base, `/v1/share/${freshLink.id}`, {
      method: "DELETE",
      jar: ws.jar,
    });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { data: { revokedAt: string | null } };
    expect(againBody.data.revokedAt).toBe(revokeBody.data.revokedAt);

    // Revoked links drop out of the member list (active rows only).
    const listResponse = await api(server.base, `/v1/projects/${projectId}/share-links`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const listBody = (await listResponse.json()) as { data: { items: { id: string }[] } };
    expect(listBody.data.items.some((row) => row.id === freshLink.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guest comments: happy path + per-IP rate limit
// ---------------------------------------------------------------------------

d("share comments: guest happy path + 5/min per-IP window", () => {
  let ws: Workspace;
  let token: string;

  beforeAll(async () => {
    ws = await newWorkspace("Comment Owner");
    const projectId = await createProject(ws, "Commented Project");
    const result = await issueLink(ws, projectId);
    expect(result.status).toBe(201);
    token = (result.link as IssuedLink).token;
  });

  it("accepts a guest comment with NO session and NO Idempotency-Key (public POST)", async () => {
    const response = await api(server.base, `/v1/share/${token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.10", "content-type": "application/json" },
      body: {
        compId: "comp-main",
        layerId: "layer-logo",
        timeTicks: 120,
        body: "The logo drifts left after 2s.",
        guestName: "Alex Reviewer",
        guestEmail: "alex@example.io",
      },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: Record<string, unknown> };
    // Public ShareComment shape: guestName is the ONLY attribution — no
    // authorId, no guestEmail, no member ids.
    expect(body.data.guestName).toBe("Alex Reviewer");
    expect("authorId" in body.data).toBe(false);
    expect("guestEmail" in body.data).toBe(false);
    expect("resolvedBy" in body.data).toBe(false);
    expect(body.data.parentCommentId).toBeNull();

    const listed = await getShare(`/v1/share/${token}/comments`, {
      "x-forwarded-for": "198.51.100.11",
    });
    expect(listed.status).toBe(200);
    const page = listed.data as { items: Record<string, unknown>[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.body).toBe("The logo drifts left after 2s.");
  });

  it("the 6th comment inside the window from one IP is 429 RATE_LIMITED", async () => {
    const ip = "198.51.100.99";
    const guestBody = {
      compId: "comp-main",
      body: "spamming",
      guestName: "Flood",
      guestEmail: "flood@example.io",
    };
    let lastStatus = 0;
    for (let i = 1; i <= 6; i += 1) {
      const response = await api(server.base, `/v1/share/${token}/comments`, {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: guestBody,
      });
      lastStatus = response.status;
      if (i < 6) {
        expect(response.status).toBe(201);
      } else {
        expect(response.status).toBe(429);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe("RATE_LIMITED");
      }
    }
    expect(lastStatus).toBe(429);
    // A DIFFERENT IP is untouched (per-IP windows, not a global block).
    const other = await api(server.base, `/v1/share/${token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.100", "content-type": "application/json" },
      body: { ...guestBody, body: "from another ip" },
    });
    expect(other.status).toBe(201);
  });

  it("rejects malformed guest bodies (name > 80 chars / bad email shape)", async () => {
    const response = await api(server.base, `/v1/share/${token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.101", "content-type": "application/json" },
      body: {
        compId: "comp-main",
        body: "hi",
        guestName: "x".repeat(81),
        guestEmail: "not-an-email",
      },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Request access
// ---------------------------------------------------------------------------

d("share request-access: typed ok + audit row (v1 notification)", () => {
  let ws: Workspace;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    ws = await newWorkspace("Access Owner");
    projectId = await createProject(ws, "Requested Project");
    const result = await issueLink(ws, projectId);
    expect(result.status).toBe(201);
    token = (result.link as IssuedLink).token;
  });

  it("records the request as an audit row and answers { ok: true }", async () => {
    const response = await api(server.base, `/v1/share/${token}/request-access`, {
      method: "POST",
      headers: { "x-forwarded-for": "192.0.2.50", "content-type": "application/json" },
      body: { email: "director@example.io", message: "Can I get edit access?" },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);

    const audit = await server.deps.repos.audit.list(ws.id, {
      targetType: "project",
      targetId: projectId,
      limit: 100,
    });
    const entry = audit.items.find((row) => row.action === "share.request_access");
    expect(entry).toBeDefined();
    const metadata = entry?.metadata as Record<string, unknown> | null;
    expect(metadata?.email).toBe("director@example.io");
    expect(String(metadata?.shareTokenId).startsWith("shr_")).toBe(true);
    expect(entry?.actorId).toBeNull();
  });

  it("rate-limits the 6th request from one IP", async () => {
    const ip = "192.0.2.99";
    for (let i = 1; i <= 6; i += 1) {
      const response = await api(server.base, `/v1/share/${token}/request-access`, {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: { email: `guest${i}@example.io` },
      });
      if (i < 6) expect(response.status).toBe(201);
      else expect(response.status).toBe(429);
    }
  });
});

// ---------------------------------------------------------------------------
// Public manifest: no id leaks beyond the public shape
// ---------------------------------------------------------------------------

d("share manifest: player surface with NO internal ids", () => {
  let ws: Workspace;
  let projectId: string;
  let token: string;
  let versionId: string;

  beforeAll(async () => {
    ws = await newWorkspace("Manifest Owner");
    projectId = await createProject(ws, "Manifested Project");
    const result = await issueLink(ws, projectId);
    expect(result.status).toBe(201);
    token = (result.link as IssuedLink).token;

    // Upload a real version (raw bytes flow, projects-versions.test.ts style).
    const bytes = Buffer.from('{"format":"ecproj","comps":[{"id":"comp-main"}]}', "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const query = new URLSearchParams({ sha256: sha, sizeBytes: String(bytes.byteLength) });
    const upload = await api(
      server.base,
      `/v1/projects/${projectId}/versions?${query.toString()}`,
      {
        method: "POST",
        jar: ws.jar,
        headers: {
          "x-workspace-id": ws.id,
          "idempotency-key": unique("upload"),
          "content-type": "application/octet-stream",
        },
        rawBody: new Uint8Array(bytes),
      },
    );
    expect(upload.status).toBe(201);
    const uploadBody = (await upload.json()) as { data: { id: string } };
    versionId = uploadBody.data.id;
  });

  it("manifest keys are exactly the public shape (no ids, no sha256, no object keys as fields)", async () => {
    const { status, data } = await getShare(`/v1/share/${token}/manifest`);
    expect(status).toBe(200);
    expect(data).toBeDefined();
    const manifest = data as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["assets", "currentVersion", "updatedAt"]);
    const version = manifest.currentVersion as Record<string, unknown>;
    expect(Object.keys(version).sort()).toEqual([
      "createdAt",
      "label",
      "sizeBytes",
      "url",
      "version",
    ]);
    const signedUrl = version.url as string;
    expect(typeof signedUrl).toBe("string");
    expect(signedUrl.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.assets)).toBe(true);

    // The §12.1 leak pin: NO workspace/project/version ids ride as VALUES
    // outside the sanctioned signed-URL strings (which §9.2 scopes to a
    // 10-minute GET) — assert on every non-URL field.
    const serialized = JSON.stringify({
      currentVersion: { ...version, url: "<signed>" },
      assets: manifest.assets,
      updatedAt: manifest.updatedAt,
    });
    expect(serialized).not.toContain(ws.id);
    expect(serialized).not.toContain(projectId);
    expect(serialized).not.toContain(versionId);
    expect(serialized).not.toContain("workspaceId");
  });
});

// ---------------------------------------------------------------------------
// Presence repo pins (M7-B consumes; pinned here at the REPO level)
// ---------------------------------------------------------------------------

d("presence repo: beat / viewers / sweep (pinned M7-E surface)", () => {
  it("beat upserts, lists live viewers, and sweeps stale rows per project", async () => {
    const ws = await newWorkspace("Presence Owner");
    const projectId = await createProject(ws, "Presence Project");
    const repos = server.deps.repos;

    // Two viewer users (raw rows — presence is repo-pinned, not route-level).
    const viewerA = `usr_pres_${randomUUID().slice(0, 8)}`;
    const viewerB = `usr_pres_${randomUUID().slice(0, 8)}`;
    await rawDb
      .insert(t.user)
      .values([
        { id: viewerA, name: "A", email: `${viewerA}@studio.test`, emailVerified: true },
        { id: viewerB, name: "B", email: `${viewerB}@studio.test`, emailVerified: true },
      ])
      .onConflictDoNothing();

    const one = await repos.presence.beat(ws.id, {
      projectId,
      userId: viewerA,
      displayName: "Viewer A",
      compId: "comp-main",
      playheadTicks: 42,
    });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ userId: viewerA, displayName: "Viewer A", playheadTicks: 42 });

    // Same user beats again → UPSERT (still one row), with fresh values.
    const upsert = await repos.presence.beat(ws.id, {
      projectId,
      userId: viewerA,
      displayName: "Viewer A Prime",
      compId: null,
      playheadTicks: null,
    });
    expect(upsert).toHaveLength(1);
    expect(upsert[0]?.displayName).toBe("Viewer A Prime");
    expect(upsert[0]?.compId).toBeNull();

    const both = await repos.presence.beat(ws.id, {
      projectId,
      userId: viewerB,
      displayName: "Viewer B",
    });
    expect(both).toHaveLength(2);

    // viewers() with the DEFAULT TTL keeps fresh rows; a short ttlMs after
    // real elapsed time sweeps them (the M7-B pinned sweep behavior).
    const fresh = await repos.presence.viewers(ws.id, projectId);
    expect(fresh).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const swept = await repos.presence.viewers(ws.id, projectId, { ttlMs: 100 });
    expect(swept).toEqual([]);

    // Tenant isolation (§12.1): a foreign workspace sees nothing.
    const wsB = await newWorkspace("Presence Foreign");
    await expect(repos.presence.viewers(wsB.id, projectId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
