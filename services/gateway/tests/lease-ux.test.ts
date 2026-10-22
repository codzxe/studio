// M7-C — lease UX over HTTP against live Postgres (BUILD_PLAN §M7 task 3:
// "Alex is editing" banner; request edit; release on close; expiry; read-only
// blocks mutations at the API — D-23: chat stays ALLOWED, apply is gated).
//
// Race matrix (§M7 task 6):
//   * two tabs acquire — one wins, the loser opens read-only (§9.3)
//   * lease-state: holder/queue/youAre/canAcquire for every standing
//   * request queue: join, per-user dedupe (position preserved), order,
//     cancel, cap 20 (repo-direct fill + one HTTP 429 QUOTA_EXCEEDED)
//   * release-on-close → electNextHolder: the OLDEST queued requester is
//     returned by DELETE /lease and the queue pops
//   * expiry takeover: dead lease ⇒ holder null, canAcquire true, the oldest
//     queued requester is popped by the first state poll past the TTL; a
//     steal of the expired row acquires (atomic upsert unchanged)
//   * read-only enforcement per route: PATCH project / upload version /
//     restore / apply / undo / project-scoped asset upload all 409 LEASE_HELD
//     as a non-holder; the holder passes; after release the non-holder
//     passes; an expired lease never blocks; chat POST is NOT gated (D-23)
//   * law #1: the LEASE_HELD copy carries the holder's DISPLAY NAME, never id
//   * law #3: cross-tenant project ids 404 on every lease surface (never 403)
//
// Servers: `stable` (default 5-minute TTL) for the queue + enforcement blocks;
// `shortTtl` (LEASE_TTL_MS=1500) for the expiry blocks. Which server the wire
// helpers talk to is selected per describe block via `activeServer`.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EDIT_PLAN_SCHEMA } from "@studio/contracts";

import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  envelope,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

/** Short TTL for the expiry blocks (the leases repo enforces ≥1000ms). */
const SHORT_TTL_MS = 1500;
/** The dead-row observation needs the TTL fully elapsed, with clock-skew room. */
const EXPIRY_WAIT_MS = SHORT_TTL_MS + 700;

/** The trusted browser origin (chat POST needs it, exactly like the SPA). */
const ORIGIN = "http://localhost:3000";

let stable: RunningTestServer;
let shortTtl: RunningTestServer;

/** Which server the wire helpers talk to; each block sets it in beforeAll. */
let activeServer: RunningTestServer;

beforeAll(async () => {
  stable = await bootServer();
  shortTtl = await bootServer({
    env: { LEASE_TTL_MS: String(SHORT_TTL_MS), LEASE_HEARTBEAT_MS: "1000" },
  });
  activeServer = stable;
}, 60_000);

afterAll(async () => {
  await stable?.close();
  await shortTtl?.close();
});

// ---------------------------------------------------------------------------
// Fixtures (mirrors leases.test.ts + apply.test.ts patterns)
// ---------------------------------------------------------------------------

interface Workspace {
  readonly id: string;
  readonly jar: CookieJar;
}

interface Team {
  readonly ws: Workspace;
  readonly owner: Workspace;
  readonly editor: Workspace;
}

async function newWorkspace(prefix: string, server?: RunningTestServer): Promise<Workspace> {
  const target = server ?? activeServer;
  const jar = new CookieJar();
  const signup = await api(target.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: {
      email: uniqueEmail(prefix),
      password: "Passw0rd!longenough",
      name: `${prefix} Owner`,
    },
  });
  expect(signup.status).toBe(200);
  const wsResponse = await api(target.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique(`${prefix} WS`), slug: unique(`${prefix.toLowerCase()}-ws`) },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { id: ws.data.id, jar };
}

async function inviteEditor(
  ws: Workspace,
  prefix: string,
  server?: RunningTestServer,
): Promise<Workspace> {
  const target = server ?? activeServer;
  const email = uniqueEmail(prefix);
  const invite = await api(target.base, `/v1/workspaces/${ws.id}/invites`, {
    method: "POST",
    jar: ws.jar,
    headers: { "idempotency-key": unique("invite") },
    body: { email, role: "editor" },
  });
  expect(invite.status).toBe(201);
  const inviteBody = (await invite.json()) as { data: { id: string } };
  const jar = new CookieJar();
  const signup = await api(target.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: `${prefix} Editor` },
  });
  expect(signup.status).toBe(200);
  const accept = await api(target.base, `/v1/invites/${inviteBody.data.id}/accept`, {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("accept") },
  });
  expect(accept.status).toBe(200);
  return { id: ws.id, jar };
}

async function createProject(ws: Workspace, server?: RunningTestServer): Promise<string> {
  const target = server ?? activeServer;
  const response = await api(target.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Lease UX Project") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/** Owner + one invited editor; display names derive from `prefix`. */
async function newTeam(prefix: string, server?: RunningTestServer): Promise<Team> {
  const owner = await newWorkspace(prefix, server);
  const editor = await inviteEditor(owner, `${prefix}Editor`, server);
  return { ws: owner, owner, editor };
}

// ---------------------------------------------------------------------------
// Lease wire helpers
// ---------------------------------------------------------------------------

interface AcquireOutcome {
  readonly acquired: boolean;
  readonly holderName: string;
  readonly expiresAt: string;
  readonly readOnly: boolean;
}

async function acquire(
  ws: Workspace,
  projectId: string,
  sessionId: string,
): Promise<AcquireOutcome> {
  const response = await api(activeServer.base, `/v1/projects/${projectId}/lease`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("lease") },
    body: { sessionId },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: AcquireOutcome };
  return parsed.data;
}

interface QueueEntryDto {
  readonly userId: string;
  readonly displayName: string;
  readonly queuedAt: string;
}

interface ReleaseOutcome {
  readonly released: boolean;
  readonly nextHolder: QueueEntryDto | null;
}

async function release(ws: Workspace, projectId: string): Promise<ReleaseOutcome> {
  const response = await api(activeServer.base, `/v1/projects/${projectId}/lease`, {
    method: "DELETE",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: ReleaseOutcome };
  return parsed.data;
}

interface RequestOutcome {
  readonly queued: boolean;
  readonly position: number;
  readonly queueLength: number;
  readonly queuedAt: string;
  readonly duplicate: boolean;
}

async function leaseRequest(ws: Workspace, projectId: string): Promise<RequestOutcome> {
  const response = await api(activeServer.base, `/v1/projects/${projectId}/lease-request`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("lease-req") },
    body: {},
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: RequestOutcome };
  return parsed.data;
}

async function cancelLeaseRequest(
  ws: Workspace,
  projectId: string,
): Promise<{ cancelled: boolean }> {
  const response = await api(activeServer.base, `/v1/projects/${projectId}/lease-request`, {
    method: "DELETE",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: { cancelled: boolean } };
  return parsed.data;
}

interface LeaseStateDto {
  readonly holder: {
    readonly userId: string;
    readonly displayName: string;
    readonly acquiredAt: string;
    readonly expiresAt: string;
  } | null;
  readonly queue: readonly QueueEntryDto[];
  readonly youAre: "holder" | "queued" | "viewer";
  readonly canAcquire: boolean;
}

async function leaseState(ws: Workspace, projectId: string): Promise<LeaseStateDto> {
  const response = await api(activeServer.base, `/v1/projects/${projectId}/lease-state`, {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: LeaseStateDto };
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Version / run seeding (apply.test.ts patterns)
// ---------------------------------------------------------------------------

function contentBytes(text: string): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(text, "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

interface UploadOutcome {
  readonly status: number;
  readonly versionId: string | null;
  readonly code?: string;
}

async function uploadVersion(
  ws: Workspace,
  projectId: string,
  options: { baseVersionId?: string | null; agentRunId?: string } = {},
): Promise<UploadOutcome> {
  const fixture = contentBytes(`{"lease-ux":"${unique("v")}"}`);
  const query = new URLSearchParams({
    sha256: fixture.sha256,
    sizeBytes: String(fixture.bytes.byteLength),
  });
  if (typeof options.baseVersionId === "string") query.set("baseVersionId", options.baseVersionId);
  if (options.agentRunId !== undefined) query.set("agentRunId", options.agentRunId);
  const response = await api(activeServer.base, `/v1/projects/${projectId}/versions?${query}`, {
    method: "POST",
    jar: ws.jar,
    headers: {
      "x-workspace-id": ws.id,
      "idempotency-key": unique("ver"),
      "content-type": "application/octet-stream",
    },
    rawBody: new Uint8Array(fixture.bytes),
  });
  if (response.status !== 201) {
    const parsed = (await response.json()) as { error: { code: string } };
    return { status: response.status, versionId: null, code: parsed.error.code };
  }
  const parsed = (await response.json()) as { data: { id: string } };
  return { status: 201, versionId: parsed.data.id };
}

function agentPlan(estimatedCredits: number): unknown {
  return EDIT_PLAN_SCHEMA.parse({
    intent: "edit",
    summary: "Rename the headline layer",
    risk: "low",
    requiresApproval: false,
    affectedLayers: [{ id: 0, name: "Headline", change: "Rename to Subtitle" }],
    estimatedCredits,
    steps: [
      {
        title: "Rename layer",
        tool: "studio.set_properties",
        args: { layerId: 0, name: "Subtitle" },
        batch: {
          label: "Rename layer",
          steps: [{ command: "layer.rename", params: { id: 0, name: "Subtitle" } }],
        },
      },
    ],
  });
}

async function grantCredits(workspaceId: string, amount: number): Promise<void> {
  await activeServer.deps.repos.ledger.grant(workspaceId, {
    amount,
    idempotencyKey: unique("grant"),
  });
}

async function seedRun(
  server: RunningTestServer,
  ws: Workspace,
  projectId: string,
  baseVersionId: string,
): Promise<string> {
  const threadResponse = await api(server.base, `/v1/projects/${projectId}/threads`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("thr") },
    body: { title: "Lease UX thread" },
  });
  expect(threadResponse.status).toBe(201);
  const thread = (await threadResponse.json()) as { data: { id: string } };

  const run = await server.deps.repos.runs.create(ws.id, {
    threadId: thread.data.id,
    projectId,
    model: "studio-fast",
    baseVersionId,
    reservedCredits: 0,
    planJson: agentPlan(2),
  });
  await server.deps.repos.ledger.reserve(ws.id, {
    runId: run.id,
    amount: 10,
    idempotencyKey: unique("rsv"),
  });
  await server.deps.repos.runs.update(ws.id, run.id, { reservedCredits: 10 });
  await server.deps.repos.runs.update(ws.id, run.id, { status: "running" });
  await server.deps.repos.runs.update(ws.id, run.id, { status: "completed" });
  return run.id;
}

// ---------------------------------------------------------------------------
// 1. Two tabs + the banner endpoint (§9.3, §M7 task 3)
// ---------------------------------------------------------------------------

d("lease UX: two tabs and lease-state", () => {
  let team: Team;
  let projectId: string;

  beforeAll(async () => {
    activeServer = stable;
    team = await newTeam("LeaseUxOne");
    projectId = await createProject(team.owner);
  });

  it("two tabs: the first editor acquires; the second is refused read-only", async () => {
    const first = await acquire(team.owner, projectId, "session-tab-one-0001");
    expect(first.acquired).toBe(true);
    expect(first.readOnly).toBe(false);
    expect(first.holderName).toBe("LeaseUxOne Owner");

    const second = await acquire(team.editor, projectId, "session-tab-two-0002");
    expect(second.acquired).toBe(false);
    expect(second.readOnly).toBe(true);
    expect(second.holderName).toBe("LeaseUxOne Owner");
  });

  it("lease-state as the non-holder: holder + viewer standing, canAcquire false", async () => {
    const state = await leaseState(team.editor, projectId);
    expect(state.holder).not.toBeNull();
    expect(state.holder?.displayName).toBe("LeaseUxOne Owner");
    expect(state.holder?.userId).not.toBe(""); // ids are fine in DATA; never in copy
    expect(new Date(state.holder?.acquiredAt ?? "").getTime()).toBeLessThan(
      new Date(state.holder?.expiresAt ?? "").getTime(),
    );
    expect(state.queue).toEqual([]);
    expect(state.youAre).toBe("viewer");
    expect(state.canAcquire).toBe(false);
  });

  it("lease-state as the holder: youAre holder, canAcquire true (re-acquire renews)", async () => {
    const state = await leaseState(team.owner, projectId);
    expect(state.youAre).toBe("holder");
    expect(state.canAcquire).toBe(true);
  });

  it("lease-state on a never-leased project: holder null, canAcquire true", async () => {
    const fresh = await createProject(team.owner);
    const state = await leaseState(team.editor, fresh);
    expect(state.holder).toBeNull();
    expect(state.queue).toEqual([]);
    expect(state.youAre).toBe("viewer");
    expect(state.canAcquire).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Request queue: join, dedupe, order, cancel (§M7 task 3)
// ---------------------------------------------------------------------------

d("lease UX: request queue join/dedupe/cancel", () => {
  let team: Team;
  let projectId: string;
  let secondMember: Workspace;

  beforeAll(async () => {
    activeServer = stable;
    team = await newTeam("LeaseUxTwo");
    projectId = await createProject(team.owner);
    const held = await acquire(team.owner, projectId, "session-queue-holder-01");
    expect(held.acquired).toBe(true);
  });

  it("joins, dedupes per user (position preserved) and keeps order", async () => {
    const first = await leaseRequest(team.editor, projectId);
    expect(first.queued).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.position).toBe(1);
    expect(first.queueLength).toBe(1);

    // A second member joins behind them.
    secondMember = await inviteEditor(team.ws, "LeaseUxTwoSecond");
    const second = await leaseRequest(secondMember, projectId);
    expect(second.position).toBe(2);

    // Re-request: dedupe — original position and queuedAt survive.
    const again = await leaseRequest(team.editor, projectId);
    expect(again.duplicate).toBe(true);
    expect(again.position).toBe(1);
    expect(again.queuedAt).toBe(first.queuedAt);
    expect(again.queueLength).toBe(2);

    const state = await leaseState(team.editor, projectId);
    expect(state.youAre).toBe("queued");
    expect(state.canAcquire).toBe(false); // still held by another member
    expect(state.queue).toHaveLength(2);
    expect(state.queue[0]?.displayName).toBe("LeaseUxTwoEditor Editor");
    expect(new Date(state.queue[0]?.queuedAt ?? 0).getTime()).toBeLessThanOrEqual(
      new Date(state.queue[1]?.queuedAt ?? 0).getTime(),
    );
  });

  it("cancel leaves the queue; a second cancel reports cancelled:false", async () => {
    const cancelled = await cancelLeaseRequest(team.editor, projectId);
    expect(cancelled.cancelled).toBe(true);
    const state = await leaseState(team.editor, projectId);
    expect(state.youAre).toBe("viewer");
    expect(state.queue).toHaveLength(1);
    const again = await cancelLeaseRequest(team.editor, projectId);
    expect(again.cancelled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Queue cap (§M7 task 3): repo-direct fill + one HTTP 429 proof
// ---------------------------------------------------------------------------

d("lease UX: queue cap 20 (repo + HTTP)", () => {
  let team: Team;
  let projectId: string;
  let oldestUserId: string;

  beforeAll(async () => {
    activeServer = stable;
    team = await newTeam("LeaseUxThree");
    projectId = await createProject(team.owner);
    const held = await acquire(team.owner, projectId, "session-cap-holder-001");
    expect(held.acquired).toBe(true);
  });

  it("fills to the cap at the repo, then refuses the 21st with QUOTA_EXCEEDED", async () => {
    const leases = stable.deps.repos.leases;
    const ids: string[] = [];
    for (let i = 1; i <= 20; i += 1) {
      const userId = `usr_capper_${i}_${unique("cap")}`;
      ids.push(userId);
      const result = await leases.queueRequest(team.ws.id, { projectId, userId });
      expect(result.position).toBe(i);
      expect(result.duplicate).toBe(false);
    }
    oldestUserId = ids[0] as string;

    // Dedupe at the cap: an EXISTING waiter still re-reads their position.
    const existing = await leases.queueRequest(team.ws.id, {
      projectId,
      userId: oldestUserId,
    });
    expect(existing.duplicate).toBe(true);
    expect(existing.position).toBe(1);

    // The 21st distinct member is typed QUOTA_EXCEEDED (429 upstream).
    await expect(
      leases.queueRequest(team.ws.id, {
        projectId,
        userId: `usr_capper_21_${unique("cap")}`,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", status: 429 });

    // The real member joining over HTTP gets the typed 429 envelope.
    const response = await api(stable.base, `/v1/projects/${projectId}/lease-request`, {
      method: "POST",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("lease-req") },
      body: {},
    });
    expect(response.status).toBe(429);
    const parsed = await envelope(response);
    expect(parsed.err?.code).toBe("QUOTA_EXCEEDED");
  });

  it("the cap does not wedge the queue: release still elects the oldest", async () => {
    const released = await release(team.owner, projectId);
    expect(released.released).toBe(true);
    expect(released.nextHolder?.userId).toBe(oldestUserId);
  });
});

// ---------------------------------------------------------------------------
// 4. Release-on-close → next holder elected (§M7 task 3)
// ---------------------------------------------------------------------------

d("lease UX: release-on-close elects the oldest queued requester", () => {
  let team: Team;
  let projectId: string;
  let secondMember: Workspace;

  beforeAll(async () => {
    activeServer = stable;
    team = await newTeam("LeaseUxFour");
    projectId = await createProject(team.owner);
    secondMember = await inviteEditor(team.ws, "LeaseUxFourSecond");
    const held = await acquire(team.owner, projectId, "session-release-hold-01");
    expect(held.acquired).toBe(true);
    await leaseRequest(team.editor, projectId);
    await leaseRequest(secondMember, projectId);
  });

  it("DELETE /lease returns the oldest requester as nextHolder and pops the queue", async () => {
    const outcome = await release(team.owner, projectId);
    expect(outcome.released).toBe(true);
    expect(outcome.nextHolder?.displayName).toBe("LeaseUxFourEditor Editor");
    expect(outcome.nextHolder?.userId).not.toBe("");

    // The queue moved up: only the second member remains, and the project is free.
    const state = await leaseState(secondMember, projectId);
    expect(state.queue).toHaveLength(1);
    expect(state.youAre).toBe("queued");
    expect(state.canAcquire).toBe(true);
  });

  it("the elected user acquires instantly; their own wait is consumed", async () => {
    const taken = await acquire(team.editor, projectId, "session-elected-0001");
    expect(taken.acquired).toBe(true);
    // The editor's acquire consumed their queue entry — only the second member waits.
    const state = await leaseState(secondMember, projectId);
    expect(state.queue).toHaveLength(1);
    expect(state.youAre).toBe("queued");
    expect(state.canAcquire).toBe(false); // held by the new holder now
  });

  it("a second release elects the NEXT oldest (the queue is fair)", async () => {
    const outcome = await release(team.editor, projectId);
    expect(outcome.released).toBe(true);
    expect(outcome.nextHolder?.displayName).toBe("LeaseUxFourSecond Editor");
    const taken = await acquire(secondMember, projectId, "session-elected-0002");
    expect(taken.acquired).toBe(true);
    const empty = await release(secondMember, projectId);
    expect(empty.released).toBe(true);
    expect(empty.nextHolder).toBeNull(); // nobody waits anymore
  });
});

// ---------------------------------------------------------------------------
// 5. Expiry takeover (short-TTL server; §M7 task 3 "expiry")
// ---------------------------------------------------------------------------

d("lease UX: expiry takeover (short TTL)", () => {
  let team: Team;
  let projectId: string;
  let secondMember: Workspace;

  beforeAll(async () => {
    activeServer = shortTtl;
    team = await newTeam("LeaseUxFive", shortTtl);
    projectId = await createProject(team.owner, shortTtl);
    secondMember = await inviteEditor(team.ws, "LeaseUxFiveSecond", shortTtl);
    const held = await acquire(team.owner, projectId, "session-expiry-hold-1");
    expect(held.acquired).toBe(true);
    await leaseRequest(team.editor, projectId);
    await leaseRequest(secondMember, projectId);
  }, 30_000);

  it("past the TTL the first state poll shows no holder, canAcquire, and pops the oldest", async () => {
    await new Promise((resolve) => setTimeout(resolve, EXPIRY_WAIT_MS));

    const state = await leaseState(team.editor, projectId);
    expect(state.holder).toBeNull(); // the dead row is never a holder
    expect(state.canAcquire).toBe(true); // expired ⇒ anyone may take over
    // The expiry election popped the OLDEST requester (the editor); only the
    // second member still waits.
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]?.displayName).toBe("LeaseUxFiveSecond Editor");
    expect(state.youAre).toBe("viewer"); // popped = no longer queued
  }, 30_000);

  it("the popped user takes over the expired lease instantly", async () => {
    const stolen = await acquire(team.editor, projectId, "session-expiry-take-1");
    expect(stolen.acquired).toBe(true);
    expect(stolen.holderName).toBe("LeaseUxFiveEditor Editor");
  }, 30_000);

  it("electNextHolder pops strictly oldest-first until the queue is empty (repo pin)", async () => {
    const fresh = await createProject(team.owner, shortTtl);
    const leases = shortTtl.deps.repos.leases;
    const ids = ["q1", "q2", "q3"].map((id) => `${id}_${unique("pop")}`);
    for (const userId of ids) {
      await leases.queueRequest(team.ws.id, { projectId: fresh, userId });
    }
    const first = await leases.electNextHolder(team.ws.id, fresh);
    expect(first?.userId).toBe(ids[0]);
    const second = await leases.electNextHolder(team.ws.id, fresh);
    expect(second?.userId).toBe(ids[1]);
    const third = await leases.electNextHolder(team.ws.id, fresh);
    expect(third?.userId).toBe(ids[2]);
    const drained = await leases.electNextHolder(team.ws.id, fresh);
    expect(drained).toBeNull();
    const remaining = await leases.requestQueue(team.ws.id, fresh);
    expect(remaining).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. Read-only enforcement per route (§M7 task 3; D-23)
// ---------------------------------------------------------------------------

d("lease UX: read-only enforcement (PATCH/upload/restore/apply/undo/assets)", () => {
  let team: Team;
  let projectId: string;
  let runId: string;
  let appliedVersionId: string;
  let baseVersionId: string;
  /** The project head as the tests advance it (uploads must chain onto it). */
  let headVersionId: string;

  beforeAll(async () => {
    activeServer = stable;
    team = await newTeam("LeaseUxSix");
    projectId = await createProject(team.owner);
    // The OWNER holds the lease; the EDITOR is the read-only member.
    const held = await acquire(team.owner, projectId, "session-ro-holder-01");
    expect(held.acquired).toBe(true);

    await grantCredits(team.ws.id, 100);
    const base = await uploadVersion(team.owner, projectId);
    expect(base.status).toBe(201);
    baseVersionId = base.versionId as string;

    runId = await seedRun(stable, team.owner, projectId, baseVersionId);
    const applied = await uploadVersion(team.owner, projectId, {
      baseVersionId,
      agentRunId: runId,
    });
    expect(applied.status).toBe(201);
    appliedVersionId = applied.versionId as string;
  }, 30_000);

  it("PATCH project as the non-holder: 409 LEASE_HELD with the holder's NAME, never an id", async () => {
    const response = await api(stable.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id },
      body: { name: unique("Read-only Rename") },
    });
    expect(response.status).toBe(409);
    const parsed = await envelope(response);
    expect(parsed.err?.code).toBe("LEASE_HELD");
    expect(parsed.err?.message).toBe("LeaseUxSix Owner is editing this project right now.");
    expect(parsed.err?.message).not.toContain(team.owner.id); // law #1: no ids in copy
    expect(parsed.err?.retryable).toBe(true);
    expect(parsed.err?.hint).toBeDefined();
  });

  it("version upload as the non-holder: 409 LEASE_HELD (blocked before any byte is stored)", async () => {
    const outcome = await uploadVersion(team.editor, projectId, { baseVersionId });
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe("LEASE_HELD");
  });

  it("version restore as the non-holder: 409 LEASE_HELD (a restore is a project write)", async () => {
    const response = await api(
      stable.base,
      `/v1/projects/${projectId}/versions/${baseVersionId}/restore`,
      {
        method: "POST",
        jar: team.editor.jar,
        headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("restore") },
        // confirmLabel: the restore confirmation field (BP §M7 task 4).
        body: { confirmLabel: "restore", note: "read-only should refuse" },
      },
    );
    expect(response.status).toBe(409);
    const parsed = await envelope(response);
    expect(parsed.err?.code).toBe("LEASE_HELD");
  });

  it("apply as the non-holder: 409 LEASE_HELD, no state change, no ledger commit", async () => {
    const response = await api(stable.base, `/v1/runs/${runId}/apply`, {
      method: "POST",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("apply") },
      body: {
        batchSha256: createHash("sha256").update(unique("batch")).digest("hex"),
        versionId: appliedVersionId,
        idempotencyKey: unique("applybody"),
      },
    });
    expect(response.status).toBe(409);
    const parsed = await envelope(response);
    expect(parsed.err?.code).toBe("LEASE_HELD");

    const planState = await stable.deps.repos.runs.getPlanState(team.ws.id, runId);
    expect(planState.status).toBe("proposed"); // untouched
    const ledger = await stable.deps.repos.ledger.list(team.ws.id, { runId, limit: 100 });
    expect(ledger.items.some((entry) => entry.kind === "commit")).toBe(false);
  });

  it("undo as the non-holder is gated too, even before its own state checks", async () => {
    const response = await api(stable.base, `/v1/runs/${runId}/undo`, {
      method: "POST",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("undo") },
      body: { idempotencyKey: unique("undobody") },
    });
    expect(response.status).toBe(409);
    const parsed = await envelope(response);
    expect(parsed.err?.code).toBe("LEASE_HELD"); // the gate precedes RUN_NOT_APPLIED
  });

  it("project-scoped asset upload as the non-holder: 409; unscoped library upload passes", async () => {
    const descriptor = {
      name: "blocked.png",
      mime: "image/png",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      width: 10,
      height: 10,
    };
    const scoped = await api(stable.base, `/v1/assets?projectId=${projectId}`, {
      method: "POST",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("asset") },
      body: descriptor,
    });
    expect(scoped.status).toBe(409);
    expect(((await scoped.json()) as { error: { code: string } }).error.code).toBe("LEASE_HELD");

    const library = await api(stable.base, "/v1/assets", {
      method: "POST",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("asset") },
      body: descriptor,
    });
    expect(library.status).toBe(201); // the shared library is not lease-governed
  });

  it("the HOLDER passes every gate: PATCH + apply + upload", async () => {
    const patch = await api(stable.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: team.owner.jar,
      headers: { "x-workspace-id": team.ws.id },
      body: { name: unique("Holder Rename") },
    });
    expect(patch.status).toBe(200);

    // Apply FIRST, while the run's version (v2, agentRunId = runId) is still
    // the project head — §8.7: the applied version must descend from the
    // plan's base AND be current.
    const apply = await api(stable.base, `/v1/runs/${runId}/apply`, {
      method: "POST",
      jar: team.owner.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("apply") },
      body: {
        batchSha256: createHash("sha256").update(unique("batch")).digest("hex"),
        versionId: appliedVersionId,
        idempotencyKey: unique("applybody"),
      },
    });
    expect(apply.status).toBe(200);
    const applied = (await apply.json()) as {
      data: { applied: boolean; creditsCommitted: number };
    };
    expect(applied.data.applied).toBe(true);

    // Then a fresh holder upload (autosave) — also gated, also passes.
    const upload = await uploadVersion(team.owner, projectId, {
      baseVersionId: appliedVersionId,
    });
    expect(upload.status).toBe(201);
    headVersionId = upload.versionId as string;
  });

  it("undo as the non-holder stays gated AFTER the holder applied; the holder undoes", async () => {
    const blocked = await api(stable.base, `/v1/runs/${runId}/undo`, {
      method: "POST",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("undo") },
      body: { idempotencyKey: unique("undobody") },
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("LEASE_HELD");

    const undo = await api(stable.base, `/v1/runs/${runId}/undo`, {
      method: "POST",
      jar: team.owner.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("undo") },
      body: { idempotencyKey: unique("undobody") },
    });
    expect(undo.status).toBe(200);
    expect(((await undo.json()) as { data: { undone: boolean } }).data.undone).toBe(true);
  });

  it("chat POST is NOT gated (D-23): the non-holder's agent may look and propose", async () => {
    const thread = await api(stable.base, `/v1/projects/${projectId}/threads`, {
      method: "POST",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id, "idempotency-key": unique("thr") },
      body: { title: "Read-only review thread" },
    });
    expect(thread.status).toBe(201);
    const threadBody = (await thread.json()) as { data: { id: string } };

    const response = await fetch(`${stable.base}/v1/threads/${threadBody.data.id}/chat`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        accept: "text/event-stream",
        cookie: team.editor.jar.header,
        "x-workspace-id": team.ws.id,
      },
      body: JSON.stringify({
        message: "What's on this comp?",
        context: {},
        idempotencyKey: unique("chat"),
        pinned: [],
      }),
    });
    expect(response.status).toBe(200); // the SSE route, NOT a LEASE_HELD 409
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).not.toContain("LEASE_HELD");
    expect(text).toContain("run.");
  });

  it("after release the non-holder passes the gates; a re-acquire re-arms them", async () => {
    const outcome = await release(team.owner, projectId);
    expect(outcome.released).toBe(true);

    const patch = await api(stable.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id },
      body: { name: unique("Free Rename") },
    });
    expect(patch.status).toBe(200);

    const upload = await uploadVersion(team.editor, projectId, {
      baseVersionId: headVersionId,
    });
    expect(upload.status).toBe(201);

    // And the gate re-arms once someone holds again.
    const held = await acquire(team.editor, projectId, "session-ro-rearm-001");
    expect(held.acquired).toBe(true);
    const blocked = await api(stable.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: team.owner.jar,
      headers: { "x-workspace-id": team.ws.id },
      body: { name: unique("Blocked Rename") },
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("LEASE_HELD");
    await release(team.editor, projectId);
  });
});

// ---------------------------------------------------------------------------
// 7. An expired lease never blocks (short-TTL server)
// ---------------------------------------------------------------------------

d("lease UX: an expired lease blocks nobody", () => {
  let team: Team;
  let projectId: string;

  beforeAll(async () => {
    activeServer = shortTtl;
    team = await newTeam("LeaseUxSeven", shortTtl);
    projectId = await createProject(team.owner, shortTtl);
    const held = await acquire(team.owner, projectId, "session-dead-row-001");
    expect(held.acquired).toBe(true);
  }, 30_000);

  it("once the TTL passes, the non-holder writes freely (dead rows never gate)", async () => {
    await new Promise((resolve) => setTimeout(resolve, EXPIRY_WAIT_MS));
    const response = await api(shortTtl.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: team.editor.jar,
      headers: { "x-workspace-id": team.ws.id },
      body: { name: unique("Post-expiry Rename") },
    });
    expect(response.status).toBe(200);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. Cross-tenant isolation (law #3: 404, never 403/409)
// ---------------------------------------------------------------------------

d("lease UX: cross-tenant ids read as 404 on every lease surface", () => {
  let teamA: Team;
  let projectIdA: string;
  let stranger: Workspace;

  beforeAll(async () => {
    activeServer = stable;
    teamA = await newTeam("LeaseUxEight");
    projectIdA = await createProject(teamA.owner);
    const held = await acquire(teamA.owner, projectIdA, "session-tenant-hold-1");
    expect(held.acquired).toBe(true);
    stranger = await newWorkspace("LeaseUxStranger");
  }, 30_000);

  it("PATCH of a foreign project: 404 PROJECT_NOT_FOUND (not LEASE_HELD, not 403)", async () => {
    const response = await api(stable.base, `/v1/projects/${projectIdA}`, {
      method: "PATCH",
      jar: stranger.jar,
      headers: { "x-workspace-id": stranger.id },
      body: { name: unique("Foreign Rename") },
    });
    expect(response.status).toBe(404);
    const parsed = await envelope(response);
    expect(parsed.err?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("lease-state of a foreign project: 404", async () => {
    const response = await api(stable.base, `/v1/projects/${projectIdA}/lease-state`, {
      jar: stranger.jar,
      headers: { "x-workspace-id": stranger.id },
    });
    expect(response.status).toBe(404);
  });

  it("lease-request of a foreign project: 404 (never a queue entry)", async () => {
    const response = await api(stable.base, `/v1/projects/${projectIdA}/lease-request`, {
      method: "POST",
      jar: stranger.jar,
      headers: { "x-workspace-id": stranger.id, "idempotency-key": unique("lease-req") },
      body: {},
    });
    expect(response.status).toBe(404);
    const queue = await stable.deps.repos.leases.requestQueue(teamA.ws.id, projectIdA);
    expect(queue).toEqual([]); // nothing leaked into the real workspace's queue
  });
});
