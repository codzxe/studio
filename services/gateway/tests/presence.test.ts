// M7-B — presence over HTTP against live Postgres (BUILD_PLAN §M7 task 2,
// PRODUCT_ARCHITECTURE.md §11): the heartbeat IS the poll (beat upsert + one
// round-trip viewers list), TTL stale sweep, self flag, comp/playhead
// round-trip, the strict no-cursor body scope pin, tenant 404, per-user rate
// bucket and nonce idempotency (the (project,user) PK upsert).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "@studio/db";

import {
  CookieJar,
  DATABASE_URL,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

interface ViewerDto {
  readonly userId: string;
  readonly displayName: string;
  readonly compId: string | null;
  readonly playheadTicks: number | null;
  readonly lastSeenAgoMs: number;
  readonly self: boolean;
}

interface PresenceResponse {
  readonly status: number;
  readonly body: { viewers: ViewerDto[] };
  readonly errCode?: string;
  readonly replayed: boolean;
  readonly retryAfter: string | null;
}

let server: RunningTestServer;
/** Direct SQL handle (row-count pins + stale-row injection). Eager + lazy:
 * postgres.js connects on first query; when the DB is absent the suite skips. */
const pg = createDb(DATABASE_URL ?? "postgres://studio:studio@127.0.0.1:5432/studio").$client;

beforeAll(async () => {
  server = await bootServer();
}, 30_000);

afterAll(async () => {
  await pg.end({ timeout: 5 });
  await server?.close();
});

interface Workspace {
  readonly id: string;
  readonly ownerJar: CookieJar;
  readonly peerJar: CookieJar; // invited as VIEWER (presence is viewer+)
  readonly ownerId: string;
  readonly peerId: string;
}

/** Owner + an invited viewer — the viewer membership proves the viewer+ floor. */
async function newWorkspaceWithViewer(): Promise<Workspace> {
  const ownerJar = new CookieJar();
  let response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar: ownerJar,
    body: {
      email: uniqueEmail("presenceowner"),
      password: "Passw0rd!longenough",
      name: "Presence Owner",
    },
  });
  expect(response.status).toBe(200);
  const owner = (await response.json()) as { user: { id: string } };

  response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar: ownerJar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Presence WS"), slug: unique("presence-ws") },
  });
  expect(response.status).toBe(201);
  const ws = (await response.json()) as { data: { id: string } };

  const peerEmail = uniqueEmail("presencepeer");
  response = await api(server.base, `/v1/workspaces/${ws.data.id}/invites`, {
    method: "POST",
    jar: ownerJar,
    headers: { "idempotency-key": unique("invite") },
    body: { email: peerEmail, role: "viewer" },
  });
  expect(response.status).toBe(201);
  const invite = (await response.json()) as { data: { id: string } };

  const peerJar = new CookieJar();
  response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar: peerJar,
    body: {
      email: peerEmail,
      password: "Passw0rd!longenough",
      name: "Presence Peer",
    },
  });
  expect(response.status).toBe(200);
  const peer = (await response.json()) as { user: { id: string } };
  response = await api(server.base, `/v1/invites/${invite.data.id}/accept`, {
    method: "POST",
    jar: peerJar,
    headers: { "idempotency-key": unique("accept") },
  });
  expect(response.status).toBe(200);

  return {
    id: ws.data.id,
    ownerJar,
    peerJar,
    ownerId: owner.user.id,
    peerId: peer.user.id,
  };
}

async function createProject(ws: Workspace, jar: CookieJar): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Presence Project") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function beat(
  ws: Workspace,
  jar: CookieJar,
  projectId: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<PresenceResponse> {
  const response = await api(server.base, `/v1/projects/${projectId}/presence`, {
    method: "POST",
    jar,
    headers: {
      "x-workspace-id": ws.id,
      // §7.2: every POST /v1 mutation carries an Idempotency-Key (the
      // middleware enforces it); pass a fixed key to exercise the replay.
      "idempotency-key": idempotencyKey ?? unique("beat"),
    },
    body,
  });
  const parsed = (await response.json()) as {
    data?: { viewers?: ViewerDto[] };
    error?: { code: string };
  };
  return {
    status: response.status,
    body: { viewers: parsed.data?.viewers ?? [] },
    errCode: parsed.error?.code,
    replayed: response.headers.get("x-idempotent-replay") === "true",
    retryAfter: response.headers.get("retry-after"),
  };
}

async function list(ws: Workspace, jar: CookieJar, projectId: string): Promise<PresenceResponse> {
  const response = await api(server.base, `/v1/projects/${projectId}/presence`, {
    method: "GET",
    jar,
    headers: { "x-workspace-id": ws.id },
  });
  const parsed = (await response.json()) as {
    data?: { viewers?: ViewerDto[] };
    error?: { code: string };
  };
  return {
    status: response.status,
    body: { viewers: parsed.data?.viewers ?? [] },
    errCode: parsed.error?.code,
    replayed: false,
    retryAfter: null,
  };
}

/** Row count for one project (direct SQL — the upsert pin). */
async function rowCount(projectId: string): Promise<number> {
  const rows = (await pg`select count(*)::int as count
    from presence_heartbeats where project_id = ${projectId}`) as unknown as Array<{
    count: number;
  }>;
  return Number(rows[0]?.count ?? -1);
}

async function storedRow(
  projectId: string,
  userId: string,
): Promise<{ compId: string | null; playheadTicks: number | null }> {
  const rows = (await pg`select comp_id, playhead_ticks::int as playhead_ticks
    from presence_heartbeats where project_id = ${projectId} and user_id = ${userId}`) as unknown as Array<{
    comp_id: string | null;
    playhead_ticks: number | null;
  }>;
  const row = rows[0];
  return { compId: row?.comp_id ?? null, playheadTicks: row?.playhead_ticks ?? null };
}

const viewerOf = (viewers: ViewerDto[], userId: string): ViewerDto | undefined =>
  viewers.find((viewer) => viewer.userId === userId);

d("presence beat — upsert + one round-trip poll", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithViewer();
    projectId = await createProject(ws, ws.ownerJar);
  });

  it("the first beat returns exactly self (self:true, fresh lastSeenAgoMs)", async () => {
    const first = await beat(ws, ws.ownerJar, projectId);
    expect(first.status).toBe(200);
    expect(first.body.viewers).toHaveLength(1);
    const self = first.body.viewers[0] as ViewerDto;
    expect(self.userId).toBe(ws.ownerId);
    expect(self.self).toBe(true);
    expect(self.displayName).toBe("Presence Owner");
    expect(self.compId).toBeNull();
    expect(self.playheadTicks).toBeNull();
    expect(self.lastSeenAgoMs).toBeGreaterThanOrEqual(0);
    expect(self.lastSeenAgoMs).toBeLessThan(60_000);
  });

  it("two beats by the same user = ONE row, newest wins (comp + playhead)", async () => {
    await beat(ws, ws.ownerJar, projectId, { compId: "comp_old", playheadTicks: 100 });
    const second = await beat(ws, ws.ownerJar, projectId, {
      compId: "comp_new",
      playheadTicks: 200,
    });
    expect(await rowCount(projectId)).toBe(1);
    const row = await storedRow(projectId, ws.ownerId);
    expect(row.compId).toBe("comp_new");
    expect(row.playheadTicks).toBe(200);
    expect((viewerOf(second.body.viewers, ws.ownerId) as ViewerDto).compId).toBe("comp_new");
    expect((viewerOf(second.body.viewers, ws.ownerId) as ViewerDto).playheadTicks).toBe(200);
  });

  it("comp + playhead round-trip exactness (boundary values included)", async () => {
    const roundTripped = await beat(ws, ws.ownerJar, projectId, {
      compId: "comp_intro_01",
      playheadTicks: 12_345,
    });
    const self = viewerOf(roundTripped.body.viewers, ws.ownerId) as ViewerDto;
    expect(self.compId).toBe("comp_intro_01");
    expect(self.playheadTicks).toBe(12_345); // exact integer round-trip

    // Upper bounds pass…
    const atBounds = await beat(ws, ws.ownerJar, projectId, {
      compId: "c".repeat(120),
      playheadTicks: 36_000_000,
    });
    expect(atBounds.status).toBe(200);
    expect((viewerOf(atBounds.body.viewers, ws.ownerId) as ViewerDto).playheadTicks).toBe(
      36_000_000,
    );
    // …one past them fails with VALIDATION_FAILED.
    const overTicks = await beat(ws, ws.ownerJar, projectId, { playheadTicks: 36_000_001 });
    expect(overTicks.status).toBe(400);
    expect(overTicks.errCode).toBe("VALIDATION_FAILED");
    const longComp = await beat(ws, ws.ownerJar, projectId, { compId: "c".repeat(121) });
    expect(longComp.status).toBe(400);
    expect(longComp.errCode).toBe("VALIDATION_FAILED");
    const negative = await beat(ws, ws.ownerJar, projectId, { playheadTicks: -1 });
    expect(negative.status).toBe(400);
  });

  it("STRICT BODY (scope pin): cursor/pointer/selection fields are rejected", async () => {
    for (const sneaky of [
      { cursorX: 0.5, cursorY: 0.5 },
      { mouse: { x: 1, y: 2 } },
      { selection: ["layer_1"] },
      { compId: "fine", pointer: "down" },
    ]) {
      const rejected = await beat(ws, ws.ownerJar, projectId, sneaky);
      expect(rejected.status).toBe(400);
      expect(rejected.errCode).toBe("VALIDATION_FAILED");
    }
    // The strict rejections never wrote telemetry rows.
    expect(await rowCount(projectId)).toBe(1);
  });
});

d("presence viewers — self flag, others, stale sweep, GET", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithViewer();
    projectId = await createProject(ws, ws.ownerJar);
    await beat(ws, ws.ownerJar, projectId, { compId: "comp_owner", playheadTicks: 7 });
    // The peer is a VIEWER — presence is a viewer+ capability.
    await beat(ws, ws.peerJar, projectId, { compId: "comp_peer", playheadTicks: 9 });
  });

  it("each caller sees themselves flagged self:true and the other self:false", async () => {
    const ownerView = await beat(ws, ws.ownerJar, projectId);
    expect(ownerView.body.viewers).toHaveLength(2);
    const self = viewerOf(ownerView.body.viewers, ws.ownerId) as ViewerDto;
    const peer = viewerOf(ownerView.body.viewers, ws.peerId) as ViewerDto;
    expect(self.self).toBe(true);
    expect(self.displayName).toBe("Presence Owner");
    expect(peer.self).toBe(false);
    expect(peer.displayName).toBe("Presence Peer");
    expect(peer.compId).toBe("comp_peer");
    expect(peer.playheadTicks).toBe(9);
    expect(peer.lastSeenAgoMs).toBeGreaterThanOrEqual(0);
    expect(peer.lastSeenAgoMs).toBeLessThan(60_000);

    const peerView = await list(ws, ws.peerJar, projectId);
    expect(peerView.body.viewers).toHaveLength(2);
    expect((viewerOf(peerView.body.viewers, ws.peerId) as ViewerDto).self).toBe(true);
    expect((viewerOf(peerView.body.viewers, ws.ownerId) as ViewerDto).self).toBe(false);
  });

  it("a stale heartbeat is swept out of every list (injected old last_seen_at)", async () => {
    expect(await rowCount(projectId)).toBe(2);
    // Inject a 10-minute-old heartbeat for the peer — far past the 240s TTL.
    await pg`update presence_heartbeats
      set last_seen_at = now() - interval '10 minutes'
      where project_id = ${projectId} and user_id = ${ws.peerId}`;

    const ownerView = await beat(ws, ws.ownerJar, projectId);
    expect(ownerView.body.viewers).toHaveLength(1);
    expect(viewerOf(ownerView.body.viewers, ws.peerId)).toBeUndefined();
    expect((ownerView.body.viewers[0] as ViewerDto).userId).toBe(ws.ownerId);

    const listView = await list(ws, ws.ownerJar, projectId);
    expect(listView.body.viewers).toHaveLength(1);

    // The sweep deletes ephemeral stale rows: only the owner's row remains.
    expect(await rowCount(projectId)).toBe(1);

    // The stale viewer comes back with their next beat — still ONE row.
    const back = await beat(ws, ws.peerJar, projectId, { compId: "comp_peer_back" });
    expect(back.body.viewers).toHaveLength(2);
    expect((viewerOf(back.body.viewers, ws.peerId) as ViewerDto).compId).toBe("comp_peer_back");
    expect(await rowCount(projectId)).toBe(2);
  });
});

d("presence — tenant isolation (§12.1)", () => {
  it("another workspace cannot beat or list a foreign project (404, never a leak)", async () => {
    const wsA = await newWorkspaceWithViewer();
    const projectId = await createProject(wsA, wsA.ownerJar);
    const wsB = await newWorkspaceWithViewer();

    const foreignBeat = await beat(wsB, wsB.ownerJar, projectId, { compId: "comp_evil" });
    expect(foreignBeat.status).toBe(404);
    expect(foreignBeat.errCode).toBe("PROJECT_NOT_FOUND");

    const foreignList = await list(wsB, wsB.ownerJar, projectId);
    expect(foreignList.status).toBe(404);
    expect(foreignList.errCode).toBe("PROJECT_NOT_FOUND");

    // And nothing was written cross-tenant.
    expect(await rowCount(projectId)).toBe(0);
  });
});

d("presence beat — idempotent nonce (pinned repo upsert semantics)", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithViewer();
    projectId = await createProject(ws, ws.ownerJar);
  });

  it("the same nonce replayed within the minute never duplicates the row", async () => {
    const nonce = "tab-1-nonce-0001";
    const key = unique("beat");
    const first = await beat(
      ws,
      ws.ownerJar,
      projectId,
      { compId: "comp_nonce", playheadTicks: 1, clientNonce: nonce },
      key,
    );
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);

    // Same Idempotency-Key + same payload → the stored result is replayed
    // (x-idempotent-replay: true), and NO second write happens.
    const replay = await beat(
      ws,
      ws.ownerJar,
      projectId,
      { compId: "comp_nonce", playheadTicks: 1, clientNonce: nonce },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.replayed).toBe(true);
    expect(await rowCount(projectId)).toBe(1);

    // Same nonce with a FRESH key (a client retry that missed the replay
    // path): the (project,user) PK upsert still keeps exactly one row.
    const freshKey = await beat(
      ws,
      ws.ownerJar,
      projectId,
      { compId: "comp_nonce", playheadTicks: 2, clientNonce: nonce },
      unique("beat"),
    );
    expect(freshKey.status).toBe(200);
    expect(await rowCount(projectId)).toBe(1);
    const row = await storedRow(projectId, ws.ownerId);
    expect(row.playheadTicks).toBe(2); // newest wins
  });

  it("nonce bound: > 64 chars is rejected at the boundary", async () => {
    const tooLong = await beat(ws, ws.ownerJar, projectId, {
      clientNonce: "n".repeat(65),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.errCode).toBe("VALIDATION_FAILED");
    const atBound = await beat(ws, ws.ownerJar, projectId, { clientNonce: "n".repeat(64) });
    expect(atBound.status).toBe(200);
  });
});

d("presence beat — per-user rate limit (reuses rate-limit.ts's in-memory limiter)", () => {
  it("bursts past 60/min for ONE user; another user is unaffected; refill recovers", async () => {
    const ws = await newWorkspaceWithViewer();
    const projectId = await createProject(ws, ws.ownerJar);

    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 70; i += 1) {
      const result = await beat(ws, ws.ownerJar, projectId, { playheadTicks: i }, unique("beat"));
      statuses.push(result.status);
      if (result.status === 429 && retryAfter === null) retryAfter = result.retryAfter;
    }
    // Well under the bucket: the first 50 all pass.
    for (let i = 0; i < 50; i += 1) expect(statuses[i]).toBe(200);
    // The burst exhausts the 60/min bucket (linear refill adds < 2 tokens
    // over the burst): a 429 shows up in the 70…
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    // …carries a Retry-After (whole seconds ≥ 1)…
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

    // PER-USER bucket: the peer (a different user, same project) beats fine
    // while the owner is throttled.
    const peerBeat = await beat(ws, ws.peerJar, projectId, { compId: "comp_peer_ok" });
    expect(peerBeat.status).toBe(200);

    // One refill interval later the owner may beat again (Retry-After honors).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const recovered = await beat(ws, ws.ownerJar, projectId, { compId: "comp_owner_back" });
    expect(recovered.status).toBe(200);
  });
});
