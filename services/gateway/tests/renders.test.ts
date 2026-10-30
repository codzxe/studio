// M8-G — /v1/renders (the M8 render API v2) over live Postgres: the queue
// journey (entitlement-gate order: 415 disabled format → 422 plan size cap →
// 429 concurrency → 429 monthly render minutes → 402 insufficient credits →
// happy: row queued with the SERVER-pinned versionId, the pre-created §9.2
// objectKey, the µc ledger reserve and the D-12 whole-credit display), the
// idempotent re-queue, the PURE-READ estimate (idempotency-exempt, min-charge
// clamp, the estimate = reserve identity), cooperative cancel (queued/running
// flag, terminal CONFLICT) and the list/get history surface (D-11 vocabulary,
// progress mapping, signed resultUrl only while the artifact exists).
//
// DB-gated like every sibling route suite: real Postgres via bootServer
// (helpers), real HTTP, no worker process involved — the renders table IS the
// queue (D-25), so repo-level markRunning/heartbeat/markCompleted stand in for
// the worker where a terminal row is needed.

import { createHash } from "node:crypto";

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

// ───────────────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────────────

interface Workspace {
  readonly jar: CookieJar;
  readonly id: string;
  readonly userId: string;
}

async function newWorkspace(): Promise<Workspace> {
  const jar = new CookieJar();
  const email = uniqueEmail("rnd");
  const signUp = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: "Renderer" },
  });
  expect(signUp.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Renders WS"), slug: unique("rnd-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  const me = (await (await api(server.base, "/v1/me", { jar })).json()) as {
    data: { user: { id: string } };
  };
  return { jar, id: ws.data.id, userId: me.data.user.id };
}

/** 1 credit = 1_000_000 µc (D-12) — grants are RAW ledger µc. */
const MICRO = 1_000_000;

async function grant(ws: Workspace, credits: number): Promise<void> {
  await server.deps.repos.ledger.grant(ws.id, {
    amount: credits * MICRO,
    idempotencyKey: unique("grant"),
  });
}

async function createProject(ws: Workspace, name: string): Promise<string> {
  const project = await server.deps.repos.projects.create(ws.id, {
    name: unique(name),
    createdBy: ws.userId,
  });
  return project.id;
}

/** EffectCraft exact time: ticks at 254_016_000_000/s (editor/crates/time). */
const TICKS_PER_SECOND = 254_016_000_000;

const secondsToTicks = (seconds: number): number => seconds * TICKS_PER_SECOND;

/**
 * A REAL-shape .ecproj (verified against a browser-saved project):
 * items{"<id>": {id, name, kind:{type:"Comp", width, height,
 * frame_rate:{num,den}, duration(ticks)}}}. "Main Comp" is 1280×720@30fps for
 * 10s (mp4-good cost: 100_000 µc/s × 10s × ½ tier = 500_000 µc = 0.5 credits);
 * "Long Comp" is 1920×1080@24fps for 100s (the minutes-gate fixture).
 */
function ecprojFixture(): { bytes: Buffer; sha256: string } {
  const project = {
    schema: 2,
    settings: {},
    items: {
      "1": {
        id: 1,
        name: "Main Comp",
        comment: "",
        label: "None",
        parent: null,
        kind: {
          type: "Comp",
          width: 1280,
          height: 720,
          pixel_aspect: 1.0,
          frame_rate: { num: 30, den: 1 },
          duration: secondsToTicks(10),
          display_start: 0,
          background: [0, 0, 0],
          work_area: [0, secondsToTicks(10)],
          layers: [],
          markers: [],
        },
      },
      "2": {
        id: 2,
        name: "Long Comp",
        comment: "",
        label: "None",
        parent: null,
        kind: {
          type: "Comp",
          width: 1920,
          height: 1080,
          pixel_aspect: 1.0,
          frame_rate: { num: 24, den: 1 },
          duration: secondsToTicks(100),
          display_start: 0,
          background: [0, 0, 0],
          work_area: [0, secondsToTicks(100)],
          layers: [],
          markers: [],
        },
      },
    },
    next_id: 3,
  };
  const bytes = Buffer.from(JSON.stringify(project), "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * BIL-06 fixture: a project whose one comp ("Hostile Comp") carries an
 * attacker-chosen duration + native frame rate — the worker-bill DoS shape
 * (unbounded seconds × fps) the frame ceiling and the fps clamp must tame.
 */
function hostileCompProject(
  durationSeconds: number,
  frameRate: { num: number; den: number },
): { bytes: Buffer; sha256: string } {
  const project = {
    schema: 2,
    settings: {},
    items: {
      "1": {
        id: 1,
        name: "Hostile Comp",
        comment: "",
        label: "None",
        parent: null,
        kind: {
          type: "Comp",
          width: 1280,
          height: 720,
          pixel_aspect: 1.0,
          frame_rate: frameRate,
          duration: secondsToTicks(durationSeconds),
          display_start: 0,
          background: [0, 0, 0],
          work_area: [0, secondsToTicks(durationSeconds)],
          layers: [],
          markers: [],
        },
      },
    },
    next_id: 2,
  };
  const bytes = Buffer.from(JSON.stringify(project), "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function uploadVersion(
  ws: Workspace,
  projectId: string,
  fixture: { bytes: Buffer; sha256: string },
  options: { baseVersionId?: string | null } = {},
): Promise<string> {
  const query = new URLSearchParams({
    sha256: fixture.sha256,
    sizeBytes: String(fixture.bytes.byteLength),
  });
  // A non-first snapshot must declare its base (§9.3 PROJECT_VERSION_CONFLICT);
  // null means an explicit first snapshot (no query param).
  if (typeof options.baseVersionId === "string") {
    query.set("baseVersionId", options.baseVersionId);
  }
  const response = await api(
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
      rawBody: new Uint8Array(fixture.bytes),
    },
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

interface JobView {
  readonly id: string;
  readonly projectId: string;
  readonly compId: string;
  readonly versionId: string;
  readonly format: string;
  readonly status: string;
  readonly cancelRequested: boolean;
  readonly progress: { framesDone: number; framesTotal: number; percent: number };
  readonly credits: number | null;
  readonly resultUrl: string | null;
  readonly errorCode: string | null;
  readonly error: string | null;
  readonly sizeBytes: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
}

interface EstimateView {
  readonly credits: number;
  readonly outputSeconds: number;
  readonly longEdgePx: number;
  readonly format: string;
  readonly quality: string;
  readonly minApplied: boolean;
}

interface Envelope<T> {
  readonly status: number;
  readonly data?: T;
  readonly error?: { code: string; message?: string };
}

async function call<T>(
  ws: Workspace,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> } = { method: "GET" },
): Promise<Envelope<T>> {
  const response = await api(server.base, path, {
    method: init.method,
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, ...init.headers },
    body: init.body,
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { data?: T; error?: { code: string } };
  return { status: response.status, data: parsed.data, error: parsed.error };
}

function queueBody(projectId: string, compId: string, settings: Record<string, unknown> = {}) {
  return {
    projectId,
    compId,
    format: "mp4",
    settings,
    idempotencyKey: unique("queue"),
  };
}

async function queue(
  ws: Workspace,
  projectId: string,
  compId: string,
  settings: Record<string, unknown> = {},
): Promise<Envelope<JobView>> {
  return call<JobView>(ws, "/v1/renders", {
    method: "POST",
    body: queueBody(projectId, compId, settings),
    headers: { "idempotency-key": unique("hdr") },
  });
}

async function estimate(
  ws: Workspace,
  projectId: string,
  compId: string,
  settings: Record<string, unknown> = {},
): Promise<Envelope<EstimateView>> {
  return call<EstimateView>(ws, "/v1/renders/estimate", {
    method: "POST",
    body: { projectId, compId, format: "mp4", settings },
  });
}

/**
 * A workspace with the ecproj fixture project uploaded; returns the project id
 * and the version id (the project head — what a queued row must pin).
 */
async function newRenderableWorkspace(): Promise<{
  ws: Workspace;
  projectId: string;
  versionId: string;
}> {
  const ws = await newWorkspace();
  const projectId = await createProject(ws, "Renderable");
  const versionId = await uploadVersion(ws, projectId, ecprojFixture());
  return { ws, projectId, versionId };
}

/** Seed COMPLETED render minutes this month (frames_total / frameRate). */
async function seedCompletedSeconds(
  ws: Workspace,
  projectId: string,
  seconds: number,
): Promise<void> {
  const version = await server.deps.repos.projects.get(ws.id, projectId);
  const render = await server.deps.repos.renders.create(ws.id, {
    projectId,
    versionId: version.currentVersionId ?? "ver_missing",
    compId: "seed",
    format: "mp4",
    settingsJson: { frameRate: 30 },
    createdBy: ws.userId,
  });
  await server.deps.repos.renders.markRunning(ws.id, render.id);
  await server.deps.repos.renders.heartbeat(ws.id, render.id, {
    framesTotal: seconds * 30,
  });
  await server.deps.repos.renders.markCompleted(ws.id, render.id, { objectKey: "seed/out.mp4" });
}

// ───────────────────────────────────────────────────────────────────────────
// Queue journey — the entitlement gates, in order
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/renders: entitlement gates fire in order, each typed", () => {
  it("(a) a declared-but-disabled format is 415 RENDER_UNSUPPORTED_FORMAT (D-2)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 10);
    const result = await call<JobView>(ws, "/v1/renders", {
      method: "POST",
      body: {
        projectId,
        compId: "Main Comp",
        format: "prores",
        settings: {},
        idempotencyKey: unique("queue"),
      },
      headers: { "idempotency-key": unique("hdr") },
    });
    expect(result.status).toBe(415);
    expect(result.error?.code).toBe("RENDER_UNSUPPORTED_FORMAT");
    // nothing was queued or held
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(10 * MICRO);
  });

  it("(b) a long edge over the plan cap is 422 VALIDATION_FAILED (pinned mapping)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 10);
    const result = await queue(ws, projectId, "Main Comp", { width: 2560 });
    // The catalog documents RENDER_QUOTA_EXCEEDED (429) as the MONTHLY-minutes
    // gate only; a size cap is validation-shaped → VALIDATION_FAILED, pinned
    // at 422 (see the route comment).
    expect(result.status).toBe(422);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
  });

  it("(b2) BIL-06: the per-job FRAME ceiling refuses long-and-fast comps (429, named)", async () => {
    // A hostile comp: 20,000s at 240fps = 4.8M frames — past the 1.5M
    // ceiling BEFORE the monthly-minutes gate (20,000s also exceeds trial
    // minutes; the frame guard fires first inside resolveRenderQuote).
    const { ws, projectId, versionId } = await newRenderableWorkspace();
    await grant(ws, 10);
    const hostile = hostileCompProject(20_000, { num: 240, den: 1 });
    await uploadVersion(ws, projectId, hostile, { baseVersionId: versionId });
    const result = await queue(ws, projectId, "Hostile Comp");
    expect(result.status).toBe(429);
    expect(result.error?.code).toBe("RENDER_QUOTA_EXCEEDED");
    // The estimate route shares resolveRenderQuote — the same guard fires.
    const quote = await estimate(ws, projectId, "Hostile Comp");
    expect(quote.status).toBe(429);
    expect(quote.error?.code).toBe("RENDER_QUOTA_EXCEEDED");
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
  });

  it("(b3) BIL-06: a hostile comp-NATIVE fps clamps to 240 before the frame math", async () => {
    // Native 1,000fps × 3,000s = 3M frames would trip the frame ceiling;
    // clamped to 240fps it is 720k (legal) and the NEXT gate — the monthly
    // minutes — is what refuses. The minutes copy (not the frames copy)
    // proves the clamp ran first.
    const { ws, projectId, versionId } = await newRenderableWorkspace();
    await grant(ws, 10);
    const hostile = hostileCompProject(3_000, { num: 1000, den: 1 });
    await uploadVersion(ws, projectId, hostile, { baseVersionId: versionId });
    const result = await queue(ws, projectId, "Hostile Comp");
    expect(result.status).toBe(429);
    expect(result.error?.code).toBe("RENDER_QUOTA_EXCEEDED");
    expect(result.error?.message).not.toContain("frames");
  });

  it("(c) the workspace concurrency cap is 429 RENDER_CONCURRENCY_LIMIT", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 10);
    const first = await queue(ws, projectId, "Main Comp");
    expect(first.status).toBe(201);
    const second = await queue(ws, projectId, "Main Comp");
    expect(second.status).toBe(429);
    expect(second.error?.code).toBe("RENDER_CONCURRENCY_LIMIT");
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(1);
  });

  it("(c) completing the active render frees the slot again", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 10);
    const first = await queue(ws, projectId, "Main Comp");
    expect(first.status).toBe(201);
    await server.deps.repos.renders.markRunning(ws.id, first.data?.id ?? "");
    await server.deps.repos.renders.markCompleted(ws.id, first.data?.id ?? "", {
      objectKey: "k/a.mp4",
    });
    const again = await queue(ws, projectId, "Main Comp");
    expect(again.status).toBe(201);
  });

  it("(d) out of monthly render minutes is 429 RENDER_QUOTA_EXCEEDED", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 10);
    // trial = 5 minutes (300s): seed the quota fully used this month.
    await seedCompletedSeconds(ws, projectId, 300);
    const result = await queue(ws, projectId, "Main Comp");
    expect(result.status).toBe(429);
    expect(result.error?.code).toBe("RENDER_QUOTA_EXCEEDED");
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
  });

  it("(d) a render that does not FIT the remaining minutes is refused", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 100);
    // 250s used → 50s remain; Long Comp renders 60s when asked 0..60.
    await seedCompletedSeconds(ws, projectId, 250);
    const result = await queue(ws, projectId, "Long Comp", { timeFrom: 0, timeTo: 60 });
    expect(result.status).toBe(429);
    expect(result.error?.code).toBe("RENDER_QUOTA_EXCEEDED");
    // …while a 10s render still fits.
    const fits = await queue(ws, projectId, "Main Comp");
    expect(fits.status).toBe(201);
  });

  it("(e) an uncoverable hold is 402 INSUFFICIENT_CREDITS with no row and no ledger write", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    // no grant at all
    const result = await queue(ws, projectId, "Main Comp");
    expect(result.status).toBe(402);
    expect(result.error?.code).toBe("INSUFFICIENT_CREDITS");
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
    const ledger = await server.deps.repos.ledger.list(ws.id, {});
    expect(ledger.items).toHaveLength(0);
    const history = await server.deps.repos.renders.list(ws.id, {});
    expect(history.items).toHaveLength(0);
  });

  it("a project with no versions is 400 RENDER_PROJECT_INVALID", async () => {
    const ws = await newWorkspace();
    await grant(ws, 10);
    const projectId = await createProject(ws, "Empty");
    const result = await queue(ws, projectId, "Main Comp");
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("RENDER_PROJECT_INVALID");
  });

  it("an unknown comp id is 400 RENDER_PROJECT_INVALID", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 10);
    const result = await queue(ws, projectId, "No Such Comp");
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("RENDER_PROJECT_INVALID");
  });
});

d("POST /v1/renders: the happy path (pinned version, pre-created key, µc hold)", () => {
  it("queues with the server-pinned head version and the full v2 wire shape", async () => {
    const { ws, projectId, versionId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const result = await queue(ws, projectId, "Main Comp");
    expect(result.status).toBe(201);
    const job = result.data as JobView;
    expect(job.id).toMatch(/^rdr_/);
    expect(job.projectId).toBe(projectId);
    expect(job.compId).toBe("Main Comp");
    // The SERVER pinned the project head — never a client-supplied version.
    expect(job.versionId).toBe(versionId);
    expect(job.format).toBe("mp4");
    expect(job.status).toBe("queued"); // D-11 vocabulary
    expect(job.cancelRequested).toBe(false);
    expect(job.progress).toEqual({ framesDone: 0, framesTotal: 0, percent: 0 });
    // D-12 display of the 500_000 µc hold: 0.5 credits on the wire.
    expect(job.credits).toBe(0.5);
    expect(job.resultUrl).toBeNull();
    expect(job.errorCode).toBeNull();
    expect(job.error).toBeNull();
    expect(job.sizeBytes).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.expiresAt).toBeNull();
    expect(Number.isNaN(Date.parse(job.createdAt))).toBe(false);
    expect(job.createdBy).toBe(ws.userId);

    // The §9.2 output key was pre-created at queue time (worker never guesses).
    const row = await server.deps.repos.renders.get(ws.id, job.id);
    expect(row.objectKey).toBe(
      `workspaces/${ws.id}/projects/${projectId}/renders/${job.id}/output.mp4`,
    );
    // The credits COLUMN carries the integer µc cost (the reconciliation
    // dialect) — the wire display above is converted at the boundary.
    expect(row.credits).toBe(500_000);

    // The ledger hold: exactly one render-scoped reserve row.
    const entries = await server.deps.repos.ledger.list(ws.id, { renderId: job.id });
    expect(entries.items).toHaveLength(1);
    expect(entries.items[0]).toMatchObject({
      kind: "reserve",
      amount: -500_000,
      idempotencyKey: `render:reserve:${job.id}`,
    });
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(500_000);

    // audit: render.queued on the PROJECT feed (target = project, render id
    // in metadata — the feed resolves project-targeted rows by targetId)
    const feed = await server.deps.repos.audit.listForProject(ws.id, projectId, { limit: 10 });
    const audited = feed.items.find((entry) => entry.action === "render.queued");
    expect(audited?.targetId).toBe(projectId);
    expect((audited?.metadata as { renderId?: string } | null)?.renderId ?? undefined).toBe(job.id);
  });

  it("png-seq queues with the zip output key (spike §5)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const result = await call<JobView>(ws, "/v1/renders", {
      method: "POST",
      body: {
        projectId,
        compId: "Main Comp",
        format: "png-seq",
        settings: {},
        idempotencyKey: unique("queue"),
      },
      headers: { "idempotency-key": unique("hdr") },
    });
    expect(result.status).toBe(201);
    const row = await server.deps.repos.renders.get(ws.id, result.data?.id ?? "");
    expect(row.objectKey).toBe(
      `workspaces/${ws.id}/projects/${projectId}/renders/${row.id}/output.zip`,
    );
  });

  it("the comp matches by id OR name (tolerant), and ranges clamp to the comp timeline", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 5);
    // by numeric editor id ("1")
    const byId = await queue(ws, projectId, "1");
    expect(byId.status).toBe(201);
    await server.deps.repos.renders.markRunning(ws.id, byId.data?.id ?? "");
    await server.deps.repos.renders.markCompleted(ws.id, byId.data?.id ?? "", {
      objectKey: "k/a.mp4",
    });
    // by name, with an out-point BEYOND the comp duration → clamped to 10s
    // (the priced range == the stored range == the worker's range).
    const clamped = await queue(ws, projectId, "Main Comp", { timeFrom: 0, timeTo: 200 });
    expect(clamped.status).toBe(201);
    const row = await server.deps.repos.renders.get(ws.id, clamped.data?.id ?? "");
    expect((row.settingsJson as { timeTo?: number }).timeTo).toBe(10);
  });

  it("an in-point past the comp end is 400 VALIDATION_FAILED", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 5);
    // timeFrom 12 on a 10s comp: the schema accepts it, the range derivation
    // refuses the empty range (0 ≤ from ≤ to).
    const result = await queue(ws, projectId, "Main Comp", { timeFrom: 12 });
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });

  it("the stored settings carry the EFFECTIVE frameRate for the minutes accounting", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const result = await queue(ws, projectId, "Main Comp");
    expect(result.status).toBe(201);
    const row = await server.deps.repos.renders.get(ws.id, result.data?.id ?? "");
    // comp native 30fps materialized when the client omitted frameRate
    expect((row.settingsJson as { frameRate?: number }).frameRate).toBe(30);
  });

  it("re-queue with the SAME Idempotency-Key replays the SAME row (no double hold)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const body = queueBody(projectId, "Main Comp");
    const headerKey = unique("hdr");
    const first = await call<JobView>(ws, "/v1/renders", {
      method: "POST",
      body,
      headers: { "idempotency-key": headerKey },
    });
    expect(first.status).toBe(201);
    const replay = await call<JobView>(ws, "/v1/renders", {
      method: "POST",
      body,
      headers: { "idempotency-key": headerKey },
    });
    expect(replay.status).toBe(201);
    expect(replay.data?.id).toBe(first.data?.id);
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(1);
    const entries = await server.deps.repos.ledger.list(ws.id, {
      renderId: first.data?.id ?? "",
    });
    expect(entries.items).toHaveLength(1); // one hold, not two
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(500_000);
  });

  it("a FRESH key is a genuinely new queue attempt (counted by the concurrency gate)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 5);
    const first = await queue(ws, projectId, "Main Comp");
    expect(first.status).toBe(201);
    const second = await queue(ws, projectId, "Main Comp");
    // trial allows one active render — the fresh attempt hits the cap
    expect(second.status).toBe(429);
    expect(second.error?.code).toBe("RENDER_CONCURRENCY_LIMIT");
  });

  it("cross-tenant project ids are 404 (law #3)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    const stranger = await newWorkspace();
    await grant(stranger, 10);
    const result = await queue(stranger, projectId, "Main Comp");
    expect(result.status).toBe(404);
    expect(result.error?.code).toBe("PROJECT_NOT_FOUND");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Estimate — a PURE read with the one-formula identity
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/renders/estimate: pure read, idempotency-exempt", () => {
  it("works with NO Idempotency-Key and takes no hold", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    const result = await estimate(ws, projectId, "Main Comp");
    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      credits: 0.5,
      outputSeconds: 10,
      longEdgePx: 1280,
      format: "mp4",
      quality: "good",
      minApplied: false,
    });
    // NO side effects: no rows, no ledger entries.
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
    const ledger = await server.deps.repos.ledger.list(ws.id, {});
    expect(ledger.items).toHaveLength(0);
  });

  it("clamps to the platform minimum charge (minApplied)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    const result = await estimate(ws, projectId, "Main Comp", { timeFrom: 0, timeTo: 0.5 });
    expect(result.status).toBe(200);
    // raw 25_000 µc < RENDER_MIN_CHARGE_UC 250_000 → clamped to 0.25 credits.
    expect(result.data).toMatchObject({ credits: 0.25, minApplied: true, outputSeconds: 0.5 });
  });

  it("THE IDENTITY: the estimate display equals the queued row's display and the µc hold", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const settings = { quality: "best" };
    const quote = await estimate(ws, projectId, "Main Comp", settings);
    expect(quote.status).toBe(200);
    const queued = await call<JobView>(ws, "/v1/renders", {
      method: "POST",
      body: {
        projectId,
        compId: "Main Comp",
        format: "mp4",
        settings,
        idempotencyKey: unique("queue"),
      },
      headers: { "idempotency-key": unique("hdr") },
    });
    expect(queued.status).toBe(201);
    // The M8-B one-formula rule: the UI's number IS the hold IS the charge.
    expect(queued.data?.credits).toBe(quote.data?.credits);
    // best @ 1280px mp4: 100_000 × 10 × ½ × 7/5 = 700_000 µc = 0.7 credits.
    expect(quote.data?.credits).toBe(0.7);
    const entries = await server.deps.repos.ledger.list(ws.id, {
      renderId: queued.data?.id ?? "",
    });
    expect(entries.items[0]?.amount).toBe(-700_000);
  });

  it("prices the D-2 reserved formats (pricing and gating are separate seams)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    const result = await call<EstimateView>(ws, "/v1/renders/estimate", {
      method: "POST",
      body: { projectId, compId: "Main Comp", format: "prores", settings: {} },
    });
    expect(result.status).toBe(200);
    // prores 400_000 µc/s × 10s × ½ = 2_000_000 µc = 2 credits.
    expect(result.data).toMatchObject({ credits: 2, minApplied: false });
  });

  it("does not enforce plan gates — a pure read prices the over-cap size", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    const result = await estimate(ws, projectId, "Main Comp", { width: 2560 });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ longEdgePx: 2560, credits: 2 }); // 2× tier
  });

  it("unknown comp / bad range are typed 400s", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    const missing = await estimate(ws, projectId, "Nope");
    expect(missing.status).toBe(400);
    expect(missing.error?.code).toBe("RENDER_PROJECT_INVALID");
    const inverted = await estimate(ws, projectId, "Main Comp", { timeFrom: 8, timeTo: 3 });
    expect(inverted.status).toBe(400);
    expect(inverted.error?.code).toBe("VALIDATION_FAILED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Cancel — cooperative flag (the worker honors it)
// ───────────────────────────────────────────────────────────────────────────

d("POST /v1/renders/:id/cancel: the cooperative flag", () => {
  it("a QUEUED row keeps its status and carries the flag (claim-skip is row-level)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const queued = await queue(ws, projectId, "Main Comp");
    const id = queued.data?.id ?? "";
    const result = await call<JobView>(ws, `/v1/renders/${id}/cancel`, {
      method: "POST",
      body: { reason: "wrong comp" },
      headers: { "idempotency-key": unique("cancel") },
    });
    expect(result.status).toBe(200);
    expect(result.data?.cancelRequested).toBe(true);
    expect(result.data?.status).toBe("queued");
    const row = await server.deps.repos.renders.get(ws.id, id);
    expect(row.cancelRequested).toBe(true);
    expect(row.status).toBe("queued");
  });

  it("a RUNNING row carries the flag too (the worker terminal-transitions)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const queued = await queue(ws, projectId, "Main Comp");
    const id = queued.data?.id ?? "";
    await server.deps.repos.renders.markRunning(ws.id, id);
    const result = await call<JobView>(ws, `/v1/renders/${id}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": unique("cancel") },
    });
    expect(result.status).toBe(200);
    expect(result.data?.cancelRequested).toBe(true);
    expect(result.data?.status).toBe("running");
  });

  it("re-cancel with a fresh key is idempotent (repo-level)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const queued = await queue(ws, projectId, "Main Comp");
    const id = queued.data?.id ?? "";
    for (let i = 0; i < 2; i++) {
      const again = await call<JobView>(ws, `/v1/renders/${id}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": unique("cancel") },
      });
      expect(again.status).toBe(200);
      expect(again.data?.cancelRequested).toBe(true);
    }
  });

  it("a TERMINAL row is the repo's typed CONFLICT (409)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const queued = await queue(ws, projectId, "Main Comp");
    const id = queued.data?.id ?? "";
    await server.deps.repos.renders.markRunning(ws.id, id);
    await server.deps.repos.renders.markCompleted(ws.id, id, { objectKey: "k/a.mp4" });
    const result = await call<JobView>(ws, `/v1/renders/${id}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": unique("cancel") },
    });
    expect(result.status).toBe(409);
    expect(result.error?.code).toBe("CONFLICT");
  });

  it("cancel requires the Idempotency-Key header (the §7.2 POST gate)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const queued = await queue(ws, projectId, "Main Comp");
    const response = await api(server.base, `/v1/renders/${queued.data?.id}/cancel`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "content-type": "application/json" },
      body: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// List/get — the history surface
// ───────────────────────────────────────────────────────────────────────────

d("GET /v1/renders + /v1/renders/:id", () => {
  it("lists workspace-scoped history with cursor pages and both filters", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 5);
    const first = await queue(ws, projectId, "Main Comp");
    await server.deps.repos.renders.markRunning(ws.id, first.data?.id ?? "");
    await server.deps.repos.renders.markCompleted(ws.id, first.data?.id ?? "", {
      objectKey: "k/a.mp4",
    });
    const second = await queue(ws, projectId, "Long Comp", { timeFrom: 0, timeTo: 10 });
    expect(second.status).toBe(201);

    const all = await call<{ items: JobView[]; nextCursor: string | null }>(
      ws,
      "/v1/renders?limit=100",
    );
    expect(all.status).toBe(200);
    expect(all.data?.items).toHaveLength(2);
    // newest first
    expect(all.data?.items[0]?.id).toBe(second.data?.id);
    expect(all.data?.items[1]?.id).toBe(first.data?.id);

    // status filter speaks the D-11 vocabulary…
    const completed = await call<{ items: JobView[] }>(ws, "/v1/renders?status=completed");
    expect(completed.data?.items.map((item) => item.id)).toEqual([first.data?.id]);
    // …and rejects the dead v1 word
    const dead = await call(ws, "/v1/renders?status=succeeded");
    expect(dead.status).toBe(400);
    expect(dead.error?.code).toBe("VALIDATION_FAILED");

    // projectId filter
    const filtered = await call<{ items: JobView[] }>(
      ws,
      `/v1/renders?projectId=${projectId}&status=queued`,
    );
    expect(filtered.data?.items.map((item) => item.id)).toEqual([second.data?.id]);

    // cursor pagination
    const pageOne = await call<{ items: JobView[]; nextCursor: string | null }>(
      ws,
      "/v1/renders?limit=1",
    );
    expect(pageOne.data?.items).toHaveLength(1);
    expect(pageOne.data?.nextCursor).not.toBeNull();
    const pageTwo = await call<{ items: JobView[]; nextCursor: string | null }>(
      ws,
      `/v1/renders?limit=1&cursor=${pageOne.data?.nextCursor ?? ""}`,
    );
    expect(pageTwo.data?.items[0]?.id).toBe(all.data?.items[1]?.id);

    // another workspace's list is simply empty (tenant scope, law #3)
    const stranger = await newWorkspace();
    const strangerView = await call<{ items: JobView[] }>(stranger, "/v1/renders?limit=100");
    expect(strangerView.data?.items).toHaveLength(0);
  });

  it("maps worker progress to the wire percent", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const queued = await queue(ws, projectId, "Main Comp");
    const id = queued.data?.id ?? "";
    await server.deps.repos.renders.markRunning(ws.id, id);
    await server.deps.repos.renders.heartbeat(ws.id, id, { framesDone: 30, framesTotal: 100 });
    const job = await call<JobView>(ws, `/v1/renders/${id}`);
    expect(job.data?.progress).toEqual({ framesDone: 30, framesTotal: 100, percent: 30 });
    // markRunning is the plain transition — only a CLAIM (claimNext, the
    // worker path) stamps startedAt; the repo-level seeding here leaves it
    // null, and the wire stays honest about that.
    expect(job.data?.startedAt).toBeNull();
  });

  it("resultUrl is signed ONLY while completed AND the artifact exists", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    const queued = await queue(ws, projectId, "Main Comp");
    const id = queued.data?.id ?? "";

    // queued → no artifact, no URL
    const before = await call<JobView>(ws, `/v1/renders/${id}`);
    expect(before.data?.resultUrl).toBeNull();

    await server.deps.repos.renders.markRunning(ws.id, id);
    const row = await server.deps.repos.renders.get(ws.id, id);
    await server.deps.repos.renders.markCompleted(ws.id, id, {
      objectKey: row.objectKey ?? "k/a.mp4",
      sizeBytes: 1234,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const done = await call<JobView>(ws, `/v1/renders/${id}`);
    expect(done.data?.status).toBe("completed");
    expect(done.data?.resultUrl).toContain("v1/local-storage/");
    expect(done.data?.sizeBytes).toBe(1234);
    expect(done.data?.expiresAt).not.toBeNull();
    expect(done.data?.completedAt).not.toBeNull();

    // retention expiry clears the artifact → resultUrl goes null, row stays
    await server.deps.repos.renders.markOutputExpired(ws.id, id);
    const expired = await call<JobView>(ws, `/v1/renders/${id}`);
    expect(expired.data?.resultUrl).toBeNull();
    expect(expired.data?.sizeBytes).toBeNull();
    expect(expired.data?.expiresAt).toBeNull();
    expect(expired.data?.status).toBe("completed"); // history kept
  });

  it("unknown and cross-tenant ids are 404 RENDER_NOT_FOUND", async () => {
    const { ws } = await newRenderableWorkspace();
    const missing = await call<JobView>(ws, "/v1/renders/rdr_missing");
    expect(missing.status).toBe(404);
    expect(missing.error?.code).toBe("RENDER_NOT_FOUND");
    const stranger = await newWorkspace();
    const foreign = await call<JobView>(stranger, "/v1/renders/rdr_missing");
    expect(foreign.status).toBe(404);
  });

  it("viewers may read history but cannot queue (FORBIDDEN)", async () => {
    const { ws, projectId } = await newRenderableWorkspace();
    await grant(ws, 1);
    // owner queues one so the list has content for the viewer
    const queued = await queue(ws, projectId, "Main Comp");
    expect(queued.status).toBe(201);

    const email = uniqueEmail("viewer");
    const invite = await api(server.base, `/v1/workspaces/${ws.id}/invites`, {
      method: "POST",
      jar: ws.jar,
      headers: { "idempotency-key": unique("invite") },
      body: { email, role: "viewer" },
    });
    expect(invite.status).toBe(201);
    const inviteBody = (await invite.json()) as { data: { id: string } };
    const jar = new CookieJar();
    const signUp = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: { email, password: "Passw0rd!longenough", name: unique("Viewer") },
    });
    expect(signUp.status).toBe(200);
    const accept = await api(server.base, `/v1/invites/${inviteBody.data.id}/accept`, {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("accept") },
      body: {},
    });
    expect(accept.status).toBe(200);

    const list = await api(server.base, "/v1/renders?limit=100", {
      jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(list.status).toBe(200);
    const estimateView = await api(server.base, "/v1/renders/estimate", {
      method: "POST",
      jar,
      headers: { "x-workspace-id": ws.id, "content-type": "application/json" },
      body: { projectId, compId: "Main Comp", format: "mp4", settings: {} },
    });
    expect(estimateView.status).toBe(200);
    const queueView = await api(server.base, "/v1/renders", {
      method: "POST",
      jar,
      headers: {
        "x-workspace-id": ws.id,
        "idempotency-key": unique("hdr"),
        "content-type": "application/json",
      },
      body: queueBody(projectId, "Main Comp"),
    });
    expect(queueView.status).toBe(403);
  });
});
