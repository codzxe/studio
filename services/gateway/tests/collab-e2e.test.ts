// M7-J — the M7 EXIT-CRITERIA PROOF at the full-route JOURNEY level
// (BUILD_PLAN §M7 task 6 + exit criteria). Multi-user journeys against the
// REAL app + REAL Postgres, two or more real auth'd users per journey
// (owner + invited editor via the existing sign-up/invite fixtures).
//
// EXIT-CRITERIA SCORECARD (criterion → the journey that proves it):
//   * "Two users can review the same project; only the lease holder edits."
//       → journey 1 (presence from both perspectives, B's review comment
//         lands, every B write bounces 409 LEASE_HELD, B's chat is allowed
//         per D-23, the queue election hands B the baton, B's apply passes
//         only after the flip) + journey 6 (the gate-map table).
//   * "Comments survive reload and link to the right comp/time."
//       → journey 3 (anchor matrix across two users, replies 3 deep,
//         resolved by the OTHER user, a fresh GET returns the identical
//         tree, hostile anchor strings stay data, D-15 server filters).
//   * "Restore creates a new version and never rewrites history."
//       → journey 4 (B restores with confirmation → NEW row, head moves,
//         the original is byte-identical, the diff summarizes, both users'
//         activity feeds record it, labels audited).
//   * "Share links are revocable and scoped."
//       → journey 5 (anonymous review works: info + manifest + guest
//         comment + request access; password no/wrong/right; guest burst
//         429; members see guest attribution; revoke kills every public
//         route; expiry kills the rest).
//   * Expiry takeover (§M7 task 6 "expiry takeover") → journey 2: the
//     silent holder's stale presence row is swept and their expired lease
//     elects the queued reviewer; the OLD holder's writes now bounce.
//
// Harness (duplicated per the M5-K/M6-J house precedent — gateway tests
// never import sibling test files): SseStream + expectValidStream (the
// turn-wire form) so journey 1's read-only reviewer runs a REAL agent loop
// that PRODUCES a plan (ROUND-12: the client-driven turn wire — step 0 POST
// /v1/threads/:id/turn proposes the MOCK carriers, step 1 echoes the client's
// tool results and closes the loop, POST /v1/runs/:id/plan stores the merged
// plan + marks the run completed; MOCK_MODEL=true, the helpers default — no
// fake model server, no server runner). Lease expiry is time-traveled with a
// direct old-timestamp update (the share.test force-expiry precedent);
// presence staleness with an injected old last_seen_at (the presence.test
// sweep precedent). No sleeps beyond bounded 25ms waitFor polls.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EDIT_PLAN_SCHEMA,
  type RunRecord,
  STUDIO_STREAM_EVENT_SCHEMA,
  type StudioStreamEvent,
  type TurnMessage,
} from "@studio/contracts";
import { createDb, tablesFor } from "@studio/db";
import { eq } from "drizzle-orm";

import {
  CookieJar,
  DATABASE_URL,
  HAS_DATABASE,
  type RunningTestServer,
  TEST_APP_ORIGIN,
  api,
  bootServer,
  closeDb,
  envelope,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

// ---------------------------------------------------------------------------
// SSE wire reader (M5-K pattern, duplicated — keep-alive comment frames skip)
// ---------------------------------------------------------------------------
interface WireFrame {
  readonly raw: string;
  readonly id: number;
  readonly event: StudioStreamEvent;
}

function parseFrame(raw: string): WireFrame {
  const lines = raw.split("\n");
  const idLine = lines[0];
  const dataLine = lines[1];
  if (
    lines.length !== 2 ||
    idLine === undefined ||
    dataLine === undefined ||
    !idLine.startsWith("id: ") ||
    !dataLine.startsWith("data: ")
  ) {
    throw new Error(`malformed SSE frame on the wire: ${JSON.stringify(raw)}`);
  }
  const id = Number.parseInt(idLine.slice(4), 10);
  const event = JSON.parse(dataLine.slice(6)) as StudioStreamEvent;
  return { raw, id, event };
}

class SseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private eof = false;

  constructor(response: Response) {
    const body = response.body;
    if (body === null) throw new Error("chat response had no SSE body");
    this.reader = body.getReader();
  }

  async next(timeoutMs = 5000): Promise<WireFrame | null> {
    if (this.eof) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        if (raw.trim() === "" || raw.startsWith(":")) continue; // keep-alives
        return parseFrame(raw);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.cancel();
        throw new Error("timed out waiting for the next SSE frame");
      }
      const read = await Promise.race([
        this.reader.read(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("timed out waiting for the next SSE frame"));
          }, remaining);
          timer.unref?.();
        }),
      ]);
      if (read.done) {
        this.eof = true;
        const tail = this.buffer;
        this.buffer = "";
        if (tail.trim() === "") return null;
        return parseFrame(tail);
      }
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    this.eof = true;
    await this.reader.cancel().catch(() => undefined);
  }

  async rest(timeoutMs = 5000): Promise<WireFrame[]> {
    const frames: WireFrame[] = [];
    for (;;) {
      const wireFrame = await this.next(timeoutMs);
      if (wireFrame === null) return frames;
      frames.push(wireFrame);
    }
  }
}

// ---------------------------------------------------------------------------
// §7.4 wire-contract checks (M5-K pattern, duplicated)
// ---------------------------------------------------------------------------

const TERMINAL_TYPES = new Set(["turn.completed", "turn.failed"]);

/** The plan route's 200 payload (compile-enriched, authoritative). */
interface PlanRoutePayload {
  readonly runId: string;
  readonly plan: { readonly summary: string };
  readonly autoApply: unknown;
  readonly baseVersionId?: string;
  readonly compiledBatch?: {
    readonly label: string;
    readonly atomic: boolean;
    readonly steps: readonly unknown[];
  };
  readonly risk?: string;
  readonly estimatedCredits?: number;
  readonly resolutionRequests?: readonly {
    readonly requestId: string;
    readonly layerName: string;
    readonly disambiguation: readonly string[];
  }[];
}

function expectValidStream(frames: readonly WireFrame[]): StudioStreamEvent[] {
  expect(frames.length).toBeGreaterThan(0);
  let previousSeq: number | null = null;
  const events: StudioStreamEvent[] = [];
  let terminals = 0;
  for (const wireFrame of frames) {
    expect(wireFrame.raw).toBe(
      `id: ${wireFrame.event.seq}\ndata: ${JSON.stringify(wireFrame.event)}`,
    );
    expect(wireFrame.id).toBe(wireFrame.event.seq);
    if (previousSeq === null) expect(wireFrame.event.seq).toBe(0);
    else expect(wireFrame.event.seq).toBe(previousSeq + 1);
    previousSeq = wireFrame.event.seq;
    const checked = STUDIO_STREAM_EVENT_SCHEMA.safeParse(wireFrame.event);
    if (!checked.success) {
      throw new Error(
        `event seq ${wireFrame.event.seq} failed the §7.4 schema: ${checked.error.message}`,
      );
    }
    events.push(checked.data);
    if (TERMINAL_TYPES.has(checked.data.type)) terminals += 1;
  }
  expect(events[0]?.type).toBe("run.started");
  expect(terminals).toBe(1);
  const last = frames.at(-1)?.event;
  if (last === undefined || !TERMINAL_TYPES.has(last.type)) {
    throw new Error("the last frame on the wire must be the terminal event");
  }
  const runIds = new Set(events.map((event) => event.runId));
  expect(runIds.size).toBe(1);
  return events;
}

// ---------------------------------------------------------------------------
// The plan fixture — the client's MERGED plan for the mock carriers, posted
// to /v1/runs/:id/plan at run end (the route re-validates + RE-COMPILES it
// authoritatively; the apply-flow precedent). Hostile declared risk/credits:
// the server recomputes both from the compiled commands, never the model's.
// ---------------------------------------------------------------------------

const PLAN_SUMMARY = "Add two text layers";

const PLAN = {
  intent: "edit",
  summary: PLAN_SUMMARY,
  risk: "high",
  requiresApproval: false,
  affectedLayers: [
    { id: 0, name: "Headline", change: "Add a headline text layer" },
    { id: 1, name: "Sub", change: "Add a subheading text layer" },
  ],
  estimatedCredits: 99,
  steps: [
    {
      title: "Add the headline",
      tool: "studio.create_text",
      args: { text: "Hello", name: "Headline" },
      batch: {
        label: "Add the headline",
        steps: [{ command: "layer.newText", params: { text: "Hello", name: "Headline" } }],
      },
    },
    {
      title: "Add the subheading",
      tool: "studio.create_text",
      args: { text: "World", name: "Sub" },
      batch: {
        label: "Add the subheading",
        steps: [{ command: "layer.newText", params: { text: "World", name: "Sub" } }],
      },
    },
  ],
} as const;

// Fixture self-check: the scripted plan parses against the §8.6 schema the
// runner validates with — corpus sanity, fails loudly on fixture drift.
EDIT_PLAN_SCHEMA.parse(PLAN);

/** sha256 of the exact engine payload (mirrors the client's saveNow path). */
function shaOfCompiledBatch(batch: { label: string; steps: readonly unknown[] }): string {
  const payload = { label: batch.label, atomic: true, steps: batch.steps };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ---------------------------------------------------------------------------
// Server boot: real app + real Postgres with the ROUND-12 mock model
// (MOCK_MODEL=true, the helpers default) — the deterministic two-carrier
// journey; no fake model server, no server runner.
// ---------------------------------------------------------------------------

let server: RunningTestServer;
/** Raw db handle for the time-travel updates (expiry pins). */
let rawDb: ReturnType<typeof createDb> | undefined;
/** Dialect-correct tables for rawDb (W4-GWI: tablesFor over the pg schema). */
let tables: ReturnType<typeof tablesFor> | undefined;

function db(): ReturnType<typeof createDb> {
  if (rawDb === undefined) throw new Error("rawDb not booted (no DATABASE_URL)");
  return rawDb;
}

/** The dialect-correct table registry for the raw handle (see db()). */
function t(): ReturnType<typeof tablesFor> {
  if (tables === undefined) throw new Error("rawDb not booted (no DATABASE_URL)");
  return tables;
}

beforeAll(async () => {
  server = await bootServer();
  if (DATABASE_URL !== null) {
    rawDb = createDb(DATABASE_URL, { max: 2 });
    tables = tablesFor(rawDb);
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
// Team fixtures — TWO real users per workspace: A (owner) + B (invited
// editor), mirrors the lease-ux/comments invite precedents.
// ---------------------------------------------------------------------------

interface Team {
  readonly wsId: string;
  readonly aJar: CookieJar;
  readonly bJar: CookieJar;
  readonly aId: string;
  readonly bId: string;
  readonly aName: string;
  readonly bName: string;
  readonly bEmail: string;
}

async function signUp(prefix: string, email: string, name: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name },
  });
  expect(response.status).toBe(200);
  return jar;
}

async function userIdOf(jar: CookieJar): Promise<string> {
  const response = await api(server.base, "/v1/me", { jar });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { user: { id: string } } };
  return body.data.user.id;
}

async function newTeam(prefix: string): Promise<Team> {
  const aName = `${prefix} Owner`;
  const bName = `${prefix} Editor`;
  const aEmail = uniqueEmail(prefix);
  const bEmail = uniqueEmail(`${prefix}Editor`);

  const aJar = await signUp(prefix, aEmail, aName);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar: aJar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique(`${prefix} WS`), slug: unique(`${prefix.toLowerCase()}-ws`) },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };

  const invite = await api(server.base, `/v1/workspaces/${ws.data.id}/invites`, {
    method: "POST",
    jar: aJar,
    headers: { "idempotency-key": unique("invite") },
    body: { email: bEmail, role: "editor" },
  });
  expect(invite.status).toBe(201);
  const inviteBody = (await invite.json()) as { data: { id: string } };

  const bJar = await signUp(prefix, bEmail, bName);
  const accept = await api(server.base, `/v1/invites/${inviteBody.data.id}/accept`, {
    method: "POST",
    jar: bJar,
    headers: { "idempotency-key": unique("accept") },
  });
  expect(accept.status).toBe(200);

  return {
    wsId: ws.data.id,
    aJar,
    bJar,
    aId: await userIdOf(aJar),
    bId: await userIdOf(bJar),
    aName,
    bName,
    bEmail,
  };
}

async function createProject(team: Team, prefix: string): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: team.aJar,
    headers: { "x-workspace-id": team.wsId, "idempotency-key": unique("prj") },
    body: { name: unique(`${prefix} Project`) },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/** D-12: the ledger stores integer MICROcredits — grants convert here. */
async function grantCredits(workspaceId: string, credits: number): Promise<void> {
  await server.deps.repos.ledger.grant(workspaceId, {
    amount: credits * 1_000_000,
    idempotencyKey: unique("grant"),
  });
}

function ecprojBytes(text: string): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(text, "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

interface UploadOutcome {
  readonly status: number;
  readonly versionId: string | null;
  readonly code?: string;
}

async function uploadVersion(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  options: {
    baseVersionId?: string | null;
    agentRunId?: string;
    label?: string;
    text?: string;
  } = {},
): Promise<UploadOutcome> {
  const fixture = ecprojBytes(options.text ?? `{"collab-e2e":"${unique("v")}"}`);
  const query = new URLSearchParams({
    sha256: fixture.sha256,
    sizeBytes: String(fixture.bytes.byteLength),
  });
  if (typeof options.baseVersionId === "string") query.set("baseVersionId", options.baseVersionId);
  if (options.agentRunId !== undefined) query.set("agentRunId", options.agentRunId);
  if (options.label !== undefined) query.set("label", options.label);
  const response = await api(server.base, `/v1/projects/${projectId}/versions?${query}`, {
    method: "POST",
    jar,
    headers: {
      "x-workspace-id": workspaceId,
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

/** Bounded poll (25ms ticks) — the M5-K waitFor precedent. */
async function waitFor(description: string, probe: () => Promise<boolean>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

// ---------------------------------------------------------------------------
// Chat driving (the read-only reviewer's D-23 surface)
// ---------------------------------------------------------------------------

async function createThread(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  const response = await api(server.base, `/v1/projects/${projectId}/threads`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("thr") },
    body: { title: unique("Collab review thread") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/**
 * POST /v1/threads/:id/turn (the ROUND-12 wire — the idempotency header IS
 * the turn key `${runId}:${stepIndex}`).
 */
async function turnStream(
  jar: CookieJar,
  workspaceId: string,
  threadId: string,
  runId: string,
  stepIndex: number,
  messages: readonly TurnMessage[],
): Promise<Response> {
  return fetch(`${server.base}/v1/threads/${threadId}/turn`, {
    method: "POST",
    headers: {
      origin: TEST_APP_ORIGIN,
      "content-type": "application/json",
      accept: "text/event-stream",
      cookie: jar.header,
      "x-workspace-id": workspaceId,
      "idempotency-key": `${runId}:${stepIndex}`,
    },
    body: JSON.stringify({ runId, stepIndex, messages }),
    redirect: "manual",
  });
}

async function getRun(jar: CookieJar, workspaceId: string, runId: string): Promise<RunRecord> {
  const response = await api(server.base, `/v1/runs/${runId}`, {
    jar,
    headers: { "x-workspace-id": workspaceId },
  });
  const parsed = (await response.json()) as { data: RunRecord };
  return parsed.data;
}

const PLAN_MESSAGE = "Add the two text layers we discussed";

type TurnCompletedEvent = Extract<StudioStreamEvent, { type: "turn.completed" }>;

function completedOf(events: readonly StudioStreamEvent[]): TurnCompletedEvent {
  const terminal = events.find(
    (event): event is TurnCompletedEvent => event.type === "turn.completed",
  );
  if (terminal === undefined) throw new Error("no turn.completed event on the wire");
  return terminal;
}

/** POST /v1/runs/:id/plan — the client's merged plan at run end. */
async function postPlan(
  jar: CookieJar,
  workspaceId: string,
  runId: string,
  plan: unknown,
): Promise<PlanRoutePayload> {
  const response = await api(server.base, `/v1/runs/${runId}/plan`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("plan") },
    body: { plan },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as PlanRoutePayload;
}

/**
 * Drives ONE full agent loop through the real turn route (the ROUND-12
 * mock journey): step 0 proposes the two write carriers, step 1 echoes the
 * client's tool results and closes with text, then the client posts its
 * MERGED plan — the route re-compiles it authoritatively, stores plan_json
 * and marks the run completed (the D-11 applyable gate).
 */
async function planRun(
  jar: CookieJar,
  workspaceId: string,
  threadId: string,
  message = PLAN_MESSAGE,
): Promise<{ runId: string; payload: PlanRoutePayload; first: TurnCompletedEvent }> {
  const runId = unique("run");

  const firstResponse = await turnStream(jar, workspaceId, threadId, runId, 0, [
    { role: "user", text: message },
  ]);
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers.get("content-type")).toContain("text/event-stream");
  const firstEvents = expectValidStream(await new SseStream(firstResponse).rest());
  const first = completedOf(firstEvents);
  expect(first.finishReason).toBe("tool-calls");
  expect(first.toolCalls.map((call) => call.tool)).toEqual([
    "studio.create_composition",
    "studio.create_text",
  ]);

  const closingResponse = await turnStream(jar, workspaceId, threadId, runId, 1, [
    { role: "user", text: message },
    { role: "assistant", text: "" },
    ...first.toolCalls.map(
      (call): TurnMessage => ({
        role: "tool_call",
        toolCallId: call.toolCallId,
        tool: call.tool,
        args: call.args,
      }),
    ),
    ...first.toolCalls.map(
      (call): TurnMessage => ({
        role: "tool_result",
        toolCallId: call.toolCallId,
        tool: call.tool,
        result: { ok: true },
      }),
    ),
  ]);
  expect(closingResponse.status).toBe(200);
  const closingEvents = expectValidStream(await new SseStream(closingResponse).rest());
  const closing = completedOf(closingEvents);
  expect(closing.finishReason).toBe("stop");
  expect(closing.toolCalls).toEqual([]);
  expect(closing.assistantText).toBe(
    "Done — I created the Agent Demo composition with a text layer.",
  );

  const payload = await postPlan(jar, workspaceId, runId, PLAN);
  expect(payload.runId).toBe(runId);
  await waitFor("the run row to complete", async () => {
    const run = await getRun(jar, workspaceId, runId);
    return run.status === "completed";
  });
  return { runId, payload, first };
}

/**
 * The caller's full apply gesture (the client's saveNow + apply): upload the
 * post-batch snapshot chained on the plan's base, then POST the apply with
 * the compiled batch's sha + the resolved layer ids.
 */
async function applyPlan(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  runId: string,
  plan: PlanRoutePayload,
  transportKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const batch = plan.compiledBatch;
  if (batch === undefined) throw new Error("the plan payload carried no compiledBatch");
  const baseVersionId = plan.baseVersionId;
  if (typeof baseVersionId !== "string" || baseVersionId === null) {
    throw new Error("the plan payload carried no baseVersionId");
  }
  const upload = await uploadVersion(jar, workspaceId, projectId, {
    baseVersionId,
    agentRunId: runId,
    label: "agent-apply",
  });
  if (upload.status !== 201) {
    return { status: upload.status, body: { error: { code: upload.code ?? "UPLOAD_FAILED" } } };
  }
  const resolved =
    plan.resolutionRequests?.map((request, index) => ({
      requestId: request.requestId,
      layerId: `layer-${index + 1}`,
    })) ?? [];
  const response = await api(server.base, `/v1/runs/${runId}/apply`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": transportKey },
    body: {
      batchSha256: shaOfCompiledBatch(batch),
      versionId: upload.versionId,
      idempotencyKey: transportKey,
      resolvedLayers: resolved,
    },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Lease + presence wire helpers (lease-ux shapes)
// ---------------------------------------------------------------------------

interface AcquireOutcome {
  readonly acquired: boolean;
  readonly holderName: string;
  readonly expiresAt: string;
  readonly readOnly: boolean;
}

async function acquireLease(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  sessionId: string,
): Promise<AcquireOutcome> {
  const response = await api(server.base, `/v1/projects/${projectId}/lease`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("lease") },
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

async function releaseLease(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
): Promise<{ released: boolean; nextHolder: QueueEntryDto | null }> {
  const response = await api(server.base, `/v1/projects/${projectId}/lease`, {
    method: "DELETE",
    jar,
    headers: { "x-workspace-id": workspaceId },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as {
    data: { released: boolean; nextHolder: QueueEntryDto | null };
  };
  return parsed.data;
}

async function queueLeaseRequest(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
): Promise<{ queued: boolean; position: number; queueLength: number; duplicate: boolean }> {
  const response = await api(server.base, `/v1/projects/${projectId}/lease-request`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("lease-req") },
    body: {},
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as {
    data: { queued: boolean; position: number; queueLength: number; duplicate: boolean };
  };
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

async function leaseState(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
): Promise<LeaseStateDto> {
  const response = await api(server.base, `/v1/projects/${projectId}/lease-state`, {
    jar,
    headers: { "x-workspace-id": workspaceId },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: LeaseStateDto };
  return parsed.data;
}

interface ViewerDto {
  readonly userId: string;
  readonly displayName: string;
  readonly compId: string | null;
  readonly playheadTicks: number | null;
  readonly lastSeenAgoMs: number;
  readonly self: boolean;
}

async function beatPresence(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  body: { compId?: string; playheadTicks?: number; clientNonce?: string } = {},
): Promise<ViewerDto[]> {
  const response = await api(server.base, `/v1/projects/${projectId}/presence`, {
    method: "POST",
    jar,
    headers: {
      "x-workspace-id": workspaceId,
      // §7.2: the idempotency middleware enforces a key on every POST.
      "idempotency-key": unique("beat"),
    },
    body,
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: { viewers: ViewerDto[] } };
  return parsed.data.viewers;
}

function viewerOf(viewers: readonly ViewerDto[], userId: string): ViewerDto | undefined {
  return viewers.find((row) => row.userId === userId);
}

// ---------------------------------------------------------------------------
// Comment wire helpers (comments.test shapes)
// ---------------------------------------------------------------------------

interface CommentDto {
  readonly id: string;
  readonly projectId: string;
  readonly compId: string;
  readonly layerId: string | null;
  readonly timeTicks: number | null;
  readonly parentCommentId: string | null;
  readonly body: string;
  readonly authorId: string | null;
  readonly guestName: string | null;
  readonly guestEmail: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly createdAt: string;
}

async function createComment(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; comment?: CommentDto; code?: string }> {
  const response = await api(server.base, `/v1/projects/${projectId}/comments`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("cmt") },
    body,
  });
  const parsed = (await response.json()) as { data?: CommentDto; error?: { code: string } };
  return { status: response.status, comment: parsed.data, code: parsed.error?.code };
}

function expectComment(result: {
  status: number;
  comment?: CommentDto;
  code?: string;
}): CommentDto {
  expect(result.comment).toBeDefined();
  return result.comment as CommentDto;
}

async function replyComment(
  jar: CookieJar,
  workspaceId: string,
  commentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; comment?: CommentDto; code?: string }> {
  const response = await api(server.base, `/v1/comments/${commentId}/replies`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("rpl") },
    body,
  });
  const parsed = (await response.json()) as { data?: CommentDto; error?: { code: string } };
  return { status: response.status, comment: parsed.data, code: parsed.error?.code };
}

async function resolveComment(
  jar: CookieJar,
  workspaceId: string,
  commentId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; comment?: CommentDto; code?: string }> {
  const response = await api(server.base, `/v1/comments/${commentId}/resolve`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("res") },
    body,
  });
  const parsed = (await response.json()) as { data?: CommentDto; error?: { code: string } };
  return { status: response.status, comment: parsed.data, code: parsed.error?.code };
}

async function listComments(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  query = "",
): Promise<CommentDto[]> {
  const response = await api(
    server.base,
    `/v1/projects/${projectId}/comments${query === "" ? "" : `?${query}`}`,
    { jar, headers: { "x-workspace-id": workspaceId } },
  );
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: { items: CommentDto[] } };
  return parsed.data.items;
}

// ---------------------------------------------------------------------------
// Version / activity wire helpers (versions-activity shapes)
// ---------------------------------------------------------------------------

interface VersionRow {
  readonly id: string;
  readonly version: number;
  readonly parentVersionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly label: string | null;
}

interface TimelineEntry extends VersionRow {
  readonly createdByName: string | null;
  readonly isAgent: boolean;
}

async function listTimeline(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
): Promise<TimelineEntry[]> {
  const response = await api(server.base, `/v1/projects/${projectId}/versions?limit=100`, {
    jar,
    headers: { "x-workspace-id": workspaceId },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: { items: TimelineEntry[] } };
  return parsed.data.items;
}

async function restoreVersion(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  versionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; row?: VersionRow; code?: string }> {
  const response = await api(
    server.base,
    `/v1/projects/${projectId}/versions/${versionId}/restore`,
    {
      method: "POST",
      jar,
      headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("restore") },
      body,
    },
  );
  const parsed = (await response.json()) as { data?: VersionRow; error?: { code: string } };
  return { status: response.status, row: parsed.data, code: parsed.error?.code };
}

interface DiffResponse {
  readonly fromParent: {
    readonly parentVersionId: string;
    readonly parentVersion: number;
    readonly sizeDeltaBytes: number;
    readonly labelChanged: boolean;
    readonly authorChanged: boolean;
    readonly createdGapMs: number;
  } | null;
  readonly summary: string;
}

async function getDiff(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  versionId: string,
): Promise<DiffResponse> {
  const response = await api(server.base, `/v1/projects/${projectId}/versions/${versionId}/diff`, {
    jar,
    headers: { "x-workspace-id": workspaceId },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: DiffResponse };
  return parsed.data;
}

interface ActivityEntry {
  readonly id: string;
  readonly projectId: string | null;
  /** The route coalesces an actorless row to "" (ids are never null here). */
  readonly actorId: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

async function listActivity(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
): Promise<ActivityEntry[]> {
  const response = await api(server.base, `/v1/projects/${projectId}/activity?limit=100`, {
    jar,
    headers: { "x-workspace-id": workspaceId },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: { items: ActivityEntry[] } };
  return parsed.data.items;
}

async function errorCodeOf(response: Response): Promise<string> {
  const parsed = await envelope(response);
  if (parsed.err === undefined) throw new Error("expected an error envelope");
  return parsed.err.code;
}

// ---------------------------------------------------------------------------
// Share wire helpers + unique guest IPs (the fixed windows are per-IP)
// ---------------------------------------------------------------------------

interface ShareIssued {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string | null;
  readonly hasPassword: boolean;
}

async function issueLink(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<ShareIssued> {
  const response = await api(server.base, `/v1/projects/${projectId}/share-links`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("share") },
    body,
  });
  expect(response.status).toBe(201);
  const parsed = (await response.json()) as { data: ShareIssued };
  return parsed.data;
}

let ipCounter = 0;

/** A fresh IPv4 per call — each public per-IP window starts empty. */
function guestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 200) + 1}`;
}

// ===========================================================================
// JOURNEY 1 — two users review one project; only the lease holder edits
// (exit criterion 1; §M7 task 3, D-23)
// ===========================================================================

d("journey 1 — two users review one project; only the lease holder edits", () => {
  let team: Team;
  let projectId: string;
  let baseVersionId: string;
  let threadId: string;
  let bPlanRunId = "";
  let bPlan: PlanRoutePayload | undefined;

  beforeAll(async () => {
    team = await newTeam("J1TwoUsers");
    projectId = await createProject(team, "J1");
    await grantCredits(team.wsId, 100);
    // The project's first snapshot — the head B's plan will descend from.
    const base = await uploadVersion(team.aJar, team.wsId, projectId, {
      label: "review baseline",
    });
    expect(base.status).toBe(201);
    baseVersionId = base.versionId as string;
    threadId = await createThread(team.bJar, team.wsId, projectId);
  }, 30_000);

  it("both users presence-beat: each sees BOTH viewers, self-flagged per perspective", async () => {
    const aFirst = await beatPresence(team.aJar, team.wsId, projectId, {
      compId: "comp_main",
      playheadTicks: 1200,
      clientNonce: "j1-a-beat-0001",
    });
    expect(aFirst).toHaveLength(1);
    const aRow = viewerOf(aFirst, team.aId);
    expect(aRow?.self).toBe(true);
    expect(aRow?.displayName).toBe(team.aName);
    expect(aRow?.compId).toBe("comp_main");
    expect(aRow?.playheadTicks).toBe(1200);

    const bView = await beatPresence(team.bJar, team.wsId, projectId, {
      compId: "comp_intro",
      playheadTicks: 300,
      clientNonce: "j1-b-beat-0001",
    });
    expect(bView).toHaveLength(2);
    expect(viewerOf(bView, team.aId)?.self).toBe(false); // A from B's perspective
    expect(viewerOf(bView, team.aId)?.compId).toBe("comp_main");
    expect(viewerOf(bView, team.bId)?.self).toBe(true); // B from B's perspective
    expect(viewerOf(bView, team.bId)?.displayName).toBe(team.bName);

    const aAgain = await beatPresence(team.aJar, team.wsId, projectId, {
      clientNonce: "j1-a-beat-0002",
    });
    expect(aAgain).toHaveLength(2);
    expect(viewerOf(aAgain, team.aId)?.self).toBe(true); // A from A's perspective
    expect(viewerOf(aAgain, team.bId)?.self).toBe(false); // B from A's perspective
    expect(viewerOf(aAgain, team.bId)?.playheadTicks).toBe(300);
  });

  it("A acquires; B's lease-state shows holder=A and canAcquire=false", async () => {
    const acquired = await acquireLease(team.aJar, team.wsId, projectId, "session-j1-a-000001");
    expect(acquired.acquired).toBe(true);
    expect(acquired.readOnly).toBe(false);
    expect(acquired.holderName).toBe(team.aName);

    const bState = await leaseState(team.bJar, team.wsId, projectId);
    expect(bState.holder?.userId).toBe(team.aId);
    expect(bState.holder?.displayName).toBe(team.aName);
    expect(bState.youAre).toBe("viewer");
    expect(bState.canAcquire).toBe(false);
    expect(bState.queue).toEqual([]);
  });

  it("B reviews while read-only: a comment lands — commenting is never lease-gated", async () => {
    const result = await createComment(team.bJar, team.wsId, projectId, {
      compId: "comp_main",
      layerId: "layer_logo",
      timeTicks: 1800,
      body: "B: the logo should land here — check the overlap at 1.8s",
    });
    expect(result.status).toBe(201);
    const row = expectComment(result);
    expect(row.authorId).toBe(team.bId);
    expect(row.compId).toBe("comp_main");
    expect(row.layerId).toBe("layer_logo");
    expect(row.timeTicks).toBe(1800);
  });

  it("B's writes all bounce: project PATCH + version upload → 409 LEASE_HELD", async () => {
    const patch = await api(server.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: team.bJar,
      headers: { "x-workspace-id": team.wsId },
      body: { name: unique("B should not rename") },
    });
    expect(patch.status).toBe(409);
    const patchError = await envelope(patch);
    expect(patchError.err?.code).toBe("LEASE_HELD");
    // Law #1: the holder's DISPLAY NAME in the copy, never an id.
    expect(patchError.err?.message).toBe(`${team.aName} is editing this project right now.`);
    expect(patchError.err?.message).not.toContain(team.aId);
    expect(patchError.err?.retryable).toBe(true);

    const upload = await uploadVersion(team.bJar, team.wsId, projectId, {
      baseVersionId,
    });
    expect(upload.status).toBe(409);
    expect(upload.code).toBe("LEASE_HELD");
  });

  it("B's chat is ALLOWED (D-23): the read-only reviewer's agent proposes a real plan", async () => {
    const { runId, payload } = await planRun(team.bJar, team.wsId, threadId);
    bPlanRunId = runId;
    bPlan = payload;
    // The plan is real: the plan route re-compiled the merged batch
    // server-side (authoritative), derived the layer resolution requests,
    // and echoed the base version the client was on (M5-Q) — all proposed
    // while B was read-only (the two-carrier journey is planRun's own pins).
    expect(payload.plan.summary).toBe(PLAN_SUMMARY);
    expect(payload.compiledBatch).toMatchObject({ label: `Agent: ${PLAN_SUMMARY}`, atomic: true });
    expect(payload.resolutionRequests).toHaveLength(2);
    expect(payload.baseVersionId).toBe(baseVersionId);
  });

  it("B's apply of its OWN plan is still gated: 409 LEASE_HELD (the gate follows the lease, not the author)", async () => {
    expect(bPlan).toBeDefined();
    const batch = (bPlan as PlanRoutePayload).compiledBatch;
    if (batch === undefined) throw new Error("no compiledBatch on the plan payload");
    const response = await api(server.base, `/v1/runs/${bPlanRunId}/apply`, {
      method: "POST",
      jar: team.bJar,
      headers: { "x-workspace-id": team.wsId, "idempotency-key": unique("apply") },
      body: {
        batchSha256: shaOfCompiledBatch(batch),
        // B could never upload (blocked above) — the gate fires BEFORE any
        // version lookup, which is exactly the read-only ordering pin.
        versionId: "ver_b_never_uploaded",
        idempotencyKey: unique("applybody"),
      },
    });
    expect(response.status).toBe(409);
    const parsed = await envelope(response);
    expect(parsed.err?.code).toBe("LEASE_HELD");
    // The plan row was untouched by the refused gesture.
    const planState = await server.deps.repos.runs.getPlanState(team.wsId, bPlanRunId);
    expect(planState.status).toBe("proposed");
  });

  it("A releases → B (queued) is elected and acquires instantly", async () => {
    const queued = await queueLeaseRequest(team.bJar, team.wsId, projectId);
    expect(queued.queued).toBe(true);
    expect(queued.position).toBe(1);

    const released = await releaseLease(team.aJar, team.wsId, projectId);
    expect(released.released).toBe(true);
    expect(released.nextHolder?.userId).toBe(team.bId);
    expect(released.nextHolder?.displayName).toBe(team.bName);

    // The elected reviewer may take over immediately (fairness UX; the
    // atomic upsert stays the single-writer arbiter).
    const taken = await acquireLease(team.bJar, team.wsId, projectId, "session-j1-b-000001");
    expect(taken.acquired).toBe(true);
    expect(taken.holderName).toBe(team.bName);
    expect(taken.readOnly).toBe(false);
  });

  it("B's apply now passes: upload + apply → 200, run row applied (the gate flip)", async () => {
    expect(bPlan).toBeDefined();
    const result = await applyPlan(
      team.bJar,
      team.wsId,
      projectId,
      bPlanRunId,
      bPlan as PlanRoutePayload,
      unique("apply"),
    );
    // The apply gesture includes the version upload, which now passes too.
    expect(result.status).toBe(200);
    const data = result.body.data as { applied: boolean; versionId: string };
    expect(data.applied).toBe(true);

    const planState = await server.deps.repos.runs.getPlanState(team.wsId, bPlanRunId);
    expect(planState.status).toBe("applied");
    expect(planState.appliedVersionId).toBe(data.versionId);

    // The flip's mirror: A's session is now the read-only one.
    const aPatch = await api(server.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: team.aJar,
      headers: { "x-workspace-id": team.wsId },
      body: { name: unique("A is read-only now") },
    });
    expect(aPatch.status).toBe(409);
    const aError = await envelope(aPatch);
    expect(aError.err?.code).toBe("LEASE_HELD");
    expect(aError.err?.message).toBe(`${team.bName} is editing this project right now.`);
  });
});

// ===========================================================================
// JOURNEY 2 — expiry takeover: the silent holder loses the lease; the
// queued reviewer takes it; the OLD holder's writes bounce
// (§M7 task 6 "expiry takeover", §11 LEASE_TTL_MS)
// ===========================================================================

d(
  "journey 2 — expiry takeover: a silent, expired holder hands the lease to the queued reviewer",
  () => {
    let team: Team;
    let projectId: string;

    beforeAll(async () => {
      team = await newTeam("J2Expiry");
      projectId = await createProject(team, "J2");
    }, 30_000);

    it("A holds + queues B; both are visible in presence", async () => {
      await beatPresence(team.aJar, team.wsId, projectId, {
        compId: "comp_main",
        playheadTicks: 900,
        clientNonce: "j2-a-beat-0001",
      });
      const bView = await beatPresence(team.bJar, team.wsId, projectId, {
        compId: "comp_main",
        playheadTicks: 950,
        clientNonce: "j2-b-beat-0001",
      });
      expect(bView).toHaveLength(2);

      const held = await acquireLease(team.aJar, team.wsId, projectId, "session-j2-a-000001");
      expect(held.acquired).toBe(true);

      const queued = await queueLeaseRequest(team.bJar, team.wsId, projectId);
      expect(queued.queued).toBe(true);
      expect(queued.position).toBe(1);

      const bState = await leaseState(team.bJar, team.wsId, projectId);
      expect(bState.holder?.displayName).toBe(team.aName);
      expect(bState.youAre).toBe("queued");
      expect(bState.canAcquire).toBe(false);
    });

    it("A goes silent: the stale heartbeat row is swept out of B's view (PRESENCE_TTL_MS)", async () => {
      // Time travel (presence.test precedent): A's heartbeat row is 10 minutes
      // old — far past the 240s TTL — so the repo sweep drops A from every list.
      await db()
        .update(t().presenceHeartbeats)
        .set({ lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) })
        .where(eq(t().presenceHeartbeats.projectId, projectId));

      const bBeat = await beatPresence(team.bJar, team.wsId, projectId, {
        clientNonce: "j2-b-beat-0002",
      });
      expect(bBeat).toHaveLength(1);
      expect(viewerOf(bBeat, team.aId)).toBeUndefined();
      expect(viewerOf(bBeat, team.bId)?.self).toBe(true);
    });

    it("the expired lease reads as free: B's state poll pops the queue and B takes over", async () => {
      // Time travel (share.test force-expiry precedent): the lease row's
      // expires_at is 1s in the past — lease-logic classifies it as free.
      await db()
        .update(t().projectLeases)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(t().projectLeases.projectId, projectId));

      const bState = await leaseState(team.bJar, team.wsId, projectId);
      expect(bState.holder).toBeNull(); // the dead row is never a holder
      expect(bState.canAcquire).toBe(true); // expired ⇒ takeover is allowed
      expect(bState.queue).toEqual([]); // the expiry election popped B
      expect(bState.youAre).toBe("viewer");

      const taken = await acquireLease(team.bJar, team.wsId, projectId, "session-j2-b-000001");
      expect(taken.acquired).toBe(true);
      expect(taken.holderName).toBe(team.bName);
    });

    it("A's OLD session attempting a mutation now gets 409 LEASE_HELD", async () => {
      const patch = await api(server.base, `/v1/projects/${projectId}`, {
        method: "PATCH",
        jar: team.aJar,
        headers: { "x-workspace-id": team.wsId },
        body: { name: unique("A stale edit attempt") },
      });
      expect(patch.status).toBe(409);
      const patchError = await envelope(patch);
      expect(patchError.err?.code).toBe("LEASE_HELD");
      expect(patchError.err?.message).toBe(`${team.bName} is editing this project right now.`);

      const upload = await uploadVersion(team.aJar, team.wsId, projectId);
      expect(upload.status).toBe(409);
      expect(upload.code).toBe("LEASE_HELD");

      const aState = await leaseState(team.aJar, team.wsId, projectId);
      expect(aState.holder?.userId).toBe(team.bId);
      expect(aState.youAre).toBe("viewer");
      expect(aState.canAcquire).toBe(false);
    });
  },
);

// ===========================================================================
// JOURNEY 3 — comments survive reload and link to the right comp/time
// (exit criterion 2; §M7 task 1; D-15)
// ===========================================================================

d("journey 3 — the comment conversation: anchors, threads, resolution, reload", () => {
  let team: Team;
  let projectId: string;
  let root1: CommentDto;
  let reply1: CommentDto;
  let reply2: CommentDto;
  let root3: CommentDto;

  beforeAll(async () => {
    team = await newTeam("J3Comments");
    projectId = await createProject(team, "J3");
  }, 30_000);

  it("a two-user threaded conversation: full + comp-only anchors, replies 3 deep, resolved by the OTHER user", async () => {
    // A anchors to comp+layer+time (the full §9.1 matrix cell).
    const root1Result = await createComment(team.aJar, team.wsId, projectId, {
      compId: "comp_main",
      layerId: "layer_logo",
      timeTicks: 1800,
      body: "A: does the logo land at 1.8s?",
    });
    root1 = expectComment(root1Result);
    expect(root1.layerId).toBe("layer_logo");
    expect(root1.timeTicks).toBe(1800);
    expect(root1.parentCommentId).toBeNull();

    // B replies (inheritance: same comp/layer/time as the thread root).
    const reply1Result = await replyComment(team.bJar, team.wsId, root1.id, {
      body: "B: it does on my side — the anchor is right",
    });
    reply1 = expectComment(reply1Result);
    expect(reply1.parentCommentId).toBe(root1.id);
    expect(reply1.compId).toBe("comp_main");
    expect(reply1.layerId).toBe("layer_logo");
    expect(reply1.timeTicks).toBe(1800);

    // A replies deeper — 3 levels total (root → reply → reply-to-reply).
    const reply2Result = await replyComment(team.aJar, team.wsId, reply1.id, {
      body: "A: perfect, leaving it anchored there",
    });
    reply2 = expectComment(reply2Result);
    expect(reply2.parentCommentId).toBe(reply1.id);
    expect(reply2.compId).toBe("comp_main");

    // The 4th level is the boundary: the server refuses it (depth ≤ 3).
    const tooDeep = await replyComment(team.bJar, team.wsId, reply2.id, {
      body: "B: this one must not thread",
    });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.code).toBe("VALIDATION_FAILED");

    // A comp-only anchor (no layer, no time).
    const root2 = expectComment(
      await createComment(team.aJar, team.wsId, projectId, {
        compId: "comp_titles",
        body: "A: comp-only anchor for the titles",
      }),
    );
    expect(root2.layerId).toBeNull();
    expect(root2.timeTicks).toBeNull();

    // B leaves an open comment for the filter matrix below.
    const root3Result = await createComment(team.bJar, team.wsId, projectId, {
      compId: "comp_main",
      body: "B: unresolved by design",
    });
    root3 = expectComment(root3Result);

    // The OTHER user resolves A's thread — resolution is a member-wide
    // capability and the first resolver is recorded (idempotent).
    const resolved = await resolveComment(team.bJar, team.wsId, root1.id);
    expect(resolved.status).toBe(200);
    const resolvedRow = expectComment(resolved);
    expect(resolvedRow.resolvedAt).not.toBeNull();
    expect(resolvedRow.resolvedBy).toBe(team.bId);
  });

  it("reload-simulation: a fresh GET returns the byte-identical tree (persistence pin)", async () => {
    const first = await listComments(team.aJar, team.wsId, projectId, "limit=100");
    const second = await listComments(team.bJar, team.wsId, projectId, "limit=100");
    expect(second).toEqual(first); // the same tree from the other user's session

    // The threading chain + the resolution state survived the "reload".
    const rows = new Map(second.map((row) => [row.id, row]));
    expect(rows.get(root1.id)?.resolvedBy).toBe(team.bId);
    expect(rows.get(reply1.id)?.parentCommentId).toBe(root1.id);
    expect(rows.get(reply2.id)?.parentCommentId).toBe(reply1.id);
    expect(rows.get(root1.id)?.layerId).toBe("layer_logo");
    expect(rows.get(root1.id)?.timeTicks).toBe(1800);
    expect(rows.get(root3.id)?.resolvedAt).toBeNull();
  });

  it("the D-15 filters are server-side: compId, resolved=true/false", async () => {
    // *Update 2026-10-24 (thread-aware resolved filter):* the original
    // assertions pinned the ROW-level behavior the first live m7-collab
    // run exposed as a bug — a resolved root came back WITHOUT its replies
    // under resolved=true, and an unresolved reply was orphaned from its
    // resolved root under resolved=false ("replies stay open threads of
    // their own"). The thread ROOT's resolvedAt now decides every row, so
    // the assertions below follow the WHOLE thread.
    const resolvedMain = await listComments(
      team.bJar,
      team.wsId,
      projectId,
      "compId=comp_main&resolved=true&limit=100",
    );
    // root1's whole thread — root + both replies (they inherit the
    // comp_main anchor) — follows the root under the Resolved filter;
    // root3 stays out. A filter never splits a thread.
    expect(resolvedMain).toHaveLength(3);
    expect(new Set(resolvedMain.map((row) => row.id))).toEqual(
      new Set([root1.id, reply1.id, reply2.id]),
    );

    const open = await listComments(team.bJar, team.wsId, projectId, "resolved=false&limit=100");
    const openIds = open.map((row) => row.id);
    expect(openIds).toContain(root3.id);
    // root1's resolved thread leaves "Open" WHOLE — no orphaned replies.
    expect(openIds).not.toContain(root1.id);
    expect(openIds).not.toContain(reply1.id);
    expect(openIds).not.toContain(reply2.id);

    const titlesOnly = await listComments(
      team.aJar,
      team.wsId,
      projectId,
      "compId=comp_titles&limit=100",
    );
    expect(titlesOnly).toHaveLength(1);
    expect(titlesOnly[0]?.compId).toBe("comp_titles");
  });

  it("hostile anchor strings stay data: byte-identical round-trip", async () => {
    const hostileCompId = "comp_evil‮<script>alert(1)</script>";
    const hostileLayerId = "layer_constructor][__proto__";
    const made = await createComment(team.aJar, team.wsId, projectId, {
      compId: hostileCompId,
      layerId: hostileLayerId,
      timeTicks: 0,
      body: "A: anchors are inert data, not markup",
    });
    expect(made.status).toBe(201);
    const row = expectComment(made);
    expect(row.compId).toBe(hostileCompId);
    expect(row.layerId).toBe(hostileLayerId);

    const back = await listComments(team.bJar, team.wsId, projectId, "limit=100");
    const echoed = back.find((entry) => entry.id === row.id);
    expect(echoed?.compId).toBe(hostileCompId);
    expect(echoed?.layerId).toBe(hostileLayerId);
  });
});

// ===========================================================================
// JOURNEY 4 — restore creates a NEW version and never rewrites history
// (exit criterion 3; §9.3; D-24 labels)
// ===========================================================================

d("journey 4 — the version journey: restore-with-confirm, head moves, feeds record it", () => {
  let team: Team;
  let projectId: string;
  const v1Text = '{"format":"ecproj","version":1,"comps":[]}';
  const v2Text = '{"format":"ecproj","version":2,"comps":[{"id":"comp-main"}]}';
  const v1 = ecprojBytes(v1Text);
  const v2 = ecprojBytes(v2Text);
  let v1Id = "";
  let v2Id = "";
  let restoredId = "";

  beforeAll(async () => {
    team = await newTeam("J4Versions");
    projectId = await createProject(team, "J4");
    const first = await uploadVersion(team.aJar, team.wsId, projectId, {
      baseVersionId: null,
      label: "first cut",
      text: v1Text,
    });
    expect(first.status).toBe(201);
    v1Id = first.versionId as string;
    const second = await uploadVersion(team.aJar, team.wsId, projectId, {
      baseVersionId: v1Id,
      text: v2Text,
    });
    expect(second.status).toBe(201);
    v2Id = second.versionId as string;
  }, 30_000);

  it("B restores v1 with confirmation → a NEW version row; head moves; the original is untouched", async () => {
    const restored = await restoreVersion(team.bJar, team.wsId, projectId, v1Id, {
      confirmLabel: "first cut",
      note: "the client wants the old opening back",
    });
    expect(restored.status).toBe(201);
    const row = restored.row as VersionRow;
    expect(row.version).toBe(3); // head + 1 — history only appends
    expect(row.parentVersionId).toBe(v1Id); // content lineage: the restored one
    expect(row.sha256).toBe(v1.sha256);
    expect(row.sizeBytes).toBe(v1.bytes.byteLength);
    expect(row.label).toBe("Restored from v1");
    restoredId = row.id;

    // The head moved to the new row.
    const project = await api(server.base, `/v1/projects/${projectId}`, {
      jar: team.aJar,
      headers: { "x-workspace-id": team.wsId },
    });
    const projectBody = (await project.json()) as { data: { currentVersionId: string | null } };
    expect(projectBody.data.currentVersionId).toBe(restoredId);

    // §9.3 immutability pin: v1 and v2 are byte-identical rows, still
    // numbered 1 and 2 — the restore NEVER rewrote them.
    const timeline = await listTimeline(team.aJar, team.wsId, projectId);
    expect(timeline).toHaveLength(3);
    const original = timeline.find((entry) => entry.version === 1);
    expect(original?.id).toBe(v1Id);
    expect(original?.sha256).toBe(v1.sha256);
    expect(original?.label).toBe("first cut");
    expect(original?.parentVersionId).toBeNull();
    const middle = timeline.find((entry) => entry.version === 2);
    expect(middle?.id).toBe(v2Id);
    expect(middle?.sha256).toBe(v2.sha256);
  });

  it("the diff endpoint summarizes the restore (identical snapshot) and the v2 delta", async () => {
    const restoredDiff = await getDiff(team.bJar, team.wsId, projectId, restoredId);
    expect(restoredDiff.fromParent?.parentVersionId).toBe(v1Id);
    expect(restoredDiff.fromParent?.parentVersion).toBe(1);
    expect(restoredDiff.fromParent?.sizeDeltaBytes).toBe(0);
    expect(restoredDiff.fromParent?.labelChanged).toBe(true); // "Restored from v1" vs "first cut"
    expect(restoredDiff.summary).toContain("Identical snapshot");
    expect(restoredDiff.summary).not.toContain(v1.sha256); // never the raw hash

    const v2Diff = await getDiff(team.aJar, team.wsId, projectId, v2Id);
    expect(v2Diff.fromParent?.parentVersionId).toBe(v1Id);
    expect(v2Diff.fromParent?.sizeDeltaBytes).toBe(v2.bytes.byteLength - v1.bytes.byteLength);
  });

  it("the restore + label land in BOTH users' activity feeds; label edits are audited", async () => {
    // B (the other user) labels v2 — labels are the only mutable field (D-24).
    const label = await api(server.base, `/v1/projects/${projectId}/versions/${v2Id}/label`, {
      method: "POST",
      jar: team.bJar,
      headers: { "x-workspace-id": team.wsId, "idempotency-key": unique("label") },
      body: { label: "shipped cut" },
    });
    expect(label.status).toBe(200);
    const labeled = ((await label.json()) as { data: VersionRow }).data;
    expect(labeled.label).toBe("shipped cut");
    expect(labeled.sha256).toBe(v2.sha256); // everything else immutable

    // BOTH users' feeds record the restore (actor = B) + the label + the
    // original uploads, newest first.
    for (const jar of [team.aJar, team.bJar]) {
      const feed = await listActivity(jar, team.wsId, projectId);
      const actions = feed.map((entry) => entry.action).sort();
      expect(actions).toEqual(
        [
          "project.created",
          "version.labeled",
          "version.restored",
          "version.uploaded",
          "version.uploaded",
        ].sort(),
      );
      const restoredRow = feed.find((entry) => entry.action === "version.restored");
      expect(restoredRow?.actorName).toBe(team.bName);
      expect(restoredRow?.actorId).toBe(team.bId);
      expect(restoredRow?.targetType).toBe("version");
      expect(restoredRow?.targetId).toBe(restoredId);
      const labeledRow = feed.find((entry) => entry.action === "version.labeled");
      expect(labeledRow?.actorName).toBe(team.bName);
    }

    // The timeline surfaces the other user's name on the restored row.
    const timeline = await listTimeline(team.aJar, team.wsId, projectId);
    expect(timeline.find((entry) => entry.id === restoredId)?.createdByName).toBe(team.bName);

    // The audit export (admin/owner surface) records both actions by B.
    // (better-auth lowercases emails at sign-up — compare lowercased.)
    const exportResponse = await api(server.base, `/v1/projects/${projectId}/audit-export`, {
      jar: team.aJar,
      headers: { "x-workspace-id": team.wsId },
    });
    expect(exportResponse.status).toBe(200);
    const exported = (await exportResponse.json()) as {
      data: { rows: { action: string; actorEmail: string | null; metadata: unknown }[] };
    };
    const restoredExport = exported.data.rows.find((row) => row.action === "version.restored");
    expect(restoredExport?.actorEmail).toBe(team.bEmail.toLowerCase());
    const labeledExport = exported.data.rows.find((row) => row.action === "version.labeled");
    expect(labeledExport?.actorEmail).toBe(team.bEmail.toLowerCase());
  });
});

// ===========================================================================
// JOURNEY 5 — share links are revocable and scoped
// (exit criterion 4; §M7 task 5; §12.1)
// ===========================================================================

d("journey 5 — the share journey: anonymous review, password, abuse, revoke, expiry", () => {
  let team: Team;
  let projectId: string;
  let openLink: ShareIssued;
  let openIp: string;

  beforeAll(async () => {
    team = await newTeam("J5Share");
    projectId = await createProject(team, "J5");
    const base = await uploadVersion(team.aJar, team.wsId, projectId, {
      baseVersionId: null,
      label: "review cut",
    });
    expect(base.status).toBe(201);
  }, 30_000);

  it("A issues an open link: anonymous review works (info + manifest + guest comment + request access)", async () => {
    openLink = await issueLink(team.aJar, team.wsId, projectId);
    expect(openLink.token.length).toBeGreaterThanOrEqual(16);
    expect(openLink.hasPassword).toBe(false);

    // Anonymous GET: metadata only, never content.
    const info = await api(server.base, `/v1/share/${openLink.token}`);
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as { data: { projectId: string; hasPassword: boolean } };
    expect(infoBody.data.projectId).toBe(projectId);
    expect(infoBody.data.hasPassword).toBe(false);

    // The player surface: scoped — the manifest carries the version, no editor.
    const manifest = await api(server.base, `/v1/share/${openLink.token}/manifest`);
    expect(manifest.status).toBe(200);
    const manifestBody = (await manifest.json()) as {
      data: { currentVersion: { version: number } | null };
    };
    expect(manifestBody.data.currentVersion?.version).toBe(1);

    // A guest comment lands with NO session and NO Idempotency-Key.
    openIp = guestIp();
    const guest = await api(server.base, `/v1/share/${openLink.token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": openIp, "content-type": "application/json" },
      body: {
        compId: "comp_main",
        layerId: "layer_logo",
        timeTicks: 120,
        body: "The logo drifts left after 2s — from your client",
        guestName: "Alex Reviewer",
        guestEmail: "alex@client.test",
      },
    });
    expect(guest.status).toBe(201);
    const guestBody = (await guest.json()) as { data: Record<string, unknown> };
    // Public shape: the guest name is the ONLY attribution.
    expect(guestBody.data.guestName).toBe("Alex Reviewer");
    expect("authorId" in guestBody.data).toBe(false);
    expect("guestEmail" in guestBody.data).toBe(false);

    // The public list shows it to the NEXT anonymous visitor.
    const publicList = await api(server.base, `/v1/share/${openLink.token}/comments`, {
      headers: { "x-forwarded-for": guestIp() },
    });
    expect(publicList.status).toBe(200);
    const listed = (await publicList.json()) as { data: { items: Record<string, unknown>[] } };
    expect(listed.data.items).toHaveLength(1);
    expect(listed.data.items[0]?.body).toContain("logo drifts left");
    expect("guestEmail" in (listed.data.items[0] as Record<string, unknown>)).toBe(false);

    // Request access records the (actorless) notification row.
    const access = await api(server.base, `/v1/share/${openLink.token}/request-access`, {
      method: "POST",
      headers: { "x-forwarded-for": guestIp(), "content-type": "application/json" },
      body: { email: "director@client.test", message: "Can I get edit access?" },
    });
    expect(access.status).toBe(201);
    const aFeed = await listActivity(team.aJar, team.wsId, projectId);
    const requested = aFeed.find((entry) => entry.action === "share.request_access");
    expect(requested).toBeDefined();
    // Actorless on the wire: the route coalesces the null actor to "".
    expect(requested?.actorId).toBe("");
  });

  it("the guest comment is visible to MEMBERS with guest attribution (authorId null)", async () => {
    const memberList = await listComments(team.aJar, team.wsId, projectId, "limit=100");
    const guestRows = memberList.filter((row) => row.guestName !== null);
    expect(guestRows).toHaveLength(1);
    expect(guestRows[0]?.guestName).toBe("Alex Reviewer");
    expect(guestRows[0]?.guestEmail).toBe("alex@client.test");
    expect(guestRows[0]?.authorId).toBeNull();
    expect(guestRows[0]?.timeTicks).toBe(120);
  });

  it("the password variant: no password 401, wrong 401, right 200/201", async () => {
    const password = "Passw0rd!share";
    const gated = await issueLink(team.aJar, team.wsId, projectId, { password });
    expect(gated.hasPassword).toBe(true);

    const info = await api(server.base, `/v1/share/${gated.token}`);
    expect(info.status).toBe(200); // metadata reports the gate without asking

    const missing = await api(server.base, `/v1/share/${gated.token}/manifest`, {
      headers: { "x-forwarded-for": guestIp() },
    });
    expect(missing.status).toBe(401);
    expect(await errorCodeOf(missing)).toBe("AUTH_REQUIRED");

    const wrong = await api(server.base, `/v1/share/${gated.token}/manifest`, {
      headers: { "x-share-password": "not-the-password", "x-forwarded-for": guestIp() },
    });
    expect(wrong.status).toBe(401);

    const right = await api(server.base, `/v1/share/${gated.token}/manifest`, {
      headers: { "x-share-password": password, "x-forwarded-for": guestIp() },
    });
    expect(right.status).toBe(200);

    const gatedComment = {
      compId: "comp_main",
      body: "reviewing with the password",
      guestName: "Pat Protected",
      guestEmail: "pat@client.test",
    };
    const denied = await api(server.base, `/v1/share/${gated.token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": guestIp(), "content-type": "application/json" },
      body: gatedComment,
    });
    expect(denied.status).toBe(401);
    const allowed = await api(server.base, `/v1/share/${gated.token}/comments`, {
      method: "POST",
      headers: {
        "x-share-password": password,
        "x-forwarded-for": guestIp(),
        "content-type": "application/json",
      },
      body: gatedComment,
    });
    expect(allowed.status).toBe(201);
  });

  it("guest abuse limits: the 6th burst comment from one IP is 429; another IP is untouched", async () => {
    const burstIp = guestIp();
    const burstBody = {
      compId: "comp_main",
      body: "share burst",
      guestName: "Flood Guest",
      guestEmail: "flood@client.test",
    };
    for (let i = 1; i <= 6; i += 1) {
      const response = await api(server.base, `/v1/share/${openLink.token}/comments`, {
        method: "POST",
        headers: { "x-forwarded-for": burstIp, "content-type": "application/json" },
        body: burstBody,
      });
      if (i < 6) {
        expect(response.status, `burst comment ${i}`).toBe(201);
      } else {
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).not.toBeNull();
        const parsed = (await response.json()) as { error: { code: string } };
        expect(parsed.error.code).toBe("RATE_LIMITED");
      }
    }

    // A different IP has its own window — and every burst row that DID land
    // is attributable on the member surface.
    const other = await api(server.base, `/v1/share/${openLink.token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": guestIp(), "content-type": "application/json" },
      body: { ...burstBody, body: "from another ip" },
    });
    expect(other.status).toBe(201);

    const memberList = await listComments(team.bJar, team.wsId, projectId, "limit=100");
    const landed = memberList.filter((row) => row.body === "share burst");
    expect(landed).toHaveLength(5); // the refused 6th never became a row
    expect(landed.every((row) => row.authorId === null && row.guestName === "Flood Guest")).toBe(
      true,
    );
  });

  it("A revokes → every public route 404s; an expired token 404s too", async () => {
    const revoke = await api(server.base, `/v1/share/${openLink.id}`, {
      method: "DELETE",
      jar: team.aJar,
    });
    expect(revoke.status).toBe(200);
    const revokedAt = ((await revoke.json()) as { data: { revokedAt: string | null } }).data
      .revokedAt;
    expect(revokedAt).not.toBeNull();

    // The token is dead on every public surface — info, player, comments,
    // request access: revocation is the kill switch (§M7 task 5).
    expect((await api(server.base, `/v1/share/${openLink.token}`)).status).toBe(404);
    expect((await api(server.base, `/v1/share/${openLink.token}/manifest`)).status).toBe(404);
    expect((await api(server.base, `/v1/share/${openLink.token}/comments`)).status).toBe(404);
    const post = await api(server.base, `/v1/share/${openLink.token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": guestIp(), "content-type": "application/json" },
      body: {
        compId: "comp_main",
        body: "posted after revoke",
        guestName: "Late Guest",
        guestEmail: "late@client.test",
      },
    });
    expect(post.status).toBe(404);
    const access = await api(server.base, `/v1/share/${openLink.token}/request-access`, {
      method: "POST",
      headers: { "x-forwarded-for": guestIp(), "content-type": "application/json" },
      body: { email: "late@client.test" },
    });
    expect(access.status).toBe(404);

    // Expiry kills the same way: a 1-day link force-expired (time travel —
    // the share.test precedent) reads as 404, never as live.
    const expiring = await issueLink(team.aJar, team.wsId, projectId, { expiresInDays: 1 });
    expect(expiring.expiresAt).not.toBeNull();
    expect((await api(server.base, `/v1/share/${expiring.token}`)).status).toBe(200);
    await db()
      .update(t().shareTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(t().shareTokens.id, expiring.id));
    expect((await api(server.base, `/v1/share/${expiring.token}`)).status).toBe(404);
    expect((await api(server.base, `/v1/share/${expiring.token}/manifest`)).status).toBe(404);
  });
});

// ===========================================================================
// JOURNEY 6 — the read-only bridge-mirror pin: the M7-C API gate map as a
// TABLE (mutation surfaces gated; read/chat/comment/presence surfaces pass)
// ===========================================================================

d("journey 6 — the read-only gate map (M7-C) as a table while A holds", () => {
  let team: Team;
  let projectId: string;
  let baseVersionId: string;
  let runId: string;
  let threadId: string;
  let rootCommentId = "";

  /** A minimal appliable run row (the lease-ux seedRun pattern). */
  async function seedRun(workspaceId: string, base: string): Promise<string> {
    const plan = EDIT_PLAN_SCHEMA.parse({
      intent: "edit",
      summary: "Rename the headline layer",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ id: 0, name: "Headline", change: "Rename to Subtitle" }],
      estimatedCredits: 2,
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
    const run = await server.deps.repos.runs.create(workspaceId, {
      threadId,
      projectId,
      model: "studio-fast",
      baseVersionId: base,
      reservedCredits: 0,
      planJson: plan,
    });
    await server.deps.repos.runs.update(workspaceId, run.id, { reservedCredits: 10 });
    await server.deps.repos.runs.update(workspaceId, run.id, { status: "running" });
    await server.deps.repos.runs.update(workspaceId, run.id, { status: "completed" });
    return run.id;
  }

  beforeAll(async () => {
    team = await newTeam("J6GateMap");
    projectId = await createProject(team, "J6");
    await grantCredits(team.wsId, 100);
    threadId = await createThread(team.bJar, team.wsId, projectId);
    const base = await uploadVersion(team.aJar, team.wsId, projectId, { baseVersionId: null });
    expect(base.status).toBe(201);
    baseVersionId = base.versionId as string;
    runId = await seedRun(team.wsId, baseVersionId);
    // A root comment the read-only reviewer can reply to + resolve.
    const root = await createComment(team.aJar, team.wsId, projectId, {
      compId: "comp_main",
      body: "A: gate-map root comment",
    });
    rootCommentId = expectComment(root).id;
    // A HOLDS the lease for the whole block; B is the read-only reviewer.
    const held = await acquireLease(team.aJar, team.wsId, projectId, "session-j6-a-000001");
    expect(held.acquired).toBe(true);
  }, 30_000);

  it("the gate map: every mutation 409 LEASE_HELD; every read surface passes", async () => {
    const fixture = ecprojBytes('{"gate-map":"upload"}');
    const descriptor = {
      name: "blocked.png",
      mime: "image/png",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      width: 10,
      height: 10,
    };

    interface GateRow {
      readonly name: string;
      readonly call: () => Promise<Response>;
      readonly expectStatus: number;
      readonly expectCode?: string;
    }

    const rows: readonly GateRow[] = [
      {
        name: "PATCH project (metadata edit)",
        call: () =>
          api(server.base, `/v1/projects/${projectId}`, {
            method: "PATCH",
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
            body: { name: unique("Blocked rename") },
          }),
        expectStatus: 409,
        expectCode: "LEASE_HELD",
      },
      {
        name: "POST version upload (autosave)",
        call: () =>
          api(
            server.base,
            `/v1/projects/${projectId}/versions?sha256=${fixture.sha256}&sizeBytes=${fixture.bytes.byteLength}`,
            {
              method: "POST",
              jar: team.bJar,
              headers: {
                "x-workspace-id": team.wsId,
                "idempotency-key": unique("ver"),
                "content-type": "application/octet-stream",
              },
              rawBody: new Uint8Array(fixture.bytes),
            },
          ),
        expectStatus: 409,
        expectCode: "LEASE_HELD",
      },
      {
        name: "POST version restore (§9.3 write)",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/versions/${baseVersionId}/restore`, {
            method: "POST",
            jar: team.bJar,
            headers: {
              "x-workspace-id": team.wsId,
              "idempotency-key": unique("restore"),
            },
            body: { confirmLabel: "restore" },
          }),
        expectStatus: 409,
        expectCode: "LEASE_HELD",
      },
      {
        name: "POST agent apply",
        call: () =>
          api(server.base, `/v1/runs/${runId}/apply`, {
            method: "POST",
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId, "idempotency-key": unique("apply") },
            body: {
              batchSha256: createHash("sha256").update(unique("batch")).digest("hex"),
              versionId: baseVersionId,
              idempotencyKey: unique("applybody"),
            },
          }),
        expectStatus: 409,
        expectCode: "LEASE_HELD",
      },
      {
        name: "POST agent undo",
        call: () =>
          api(server.base, `/v1/runs/${runId}/undo`, {
            method: "POST",
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId, "idempotency-key": unique("undo") },
            body: { idempotencyKey: unique("undobody") },
          }),
        expectStatus: 409,
        expectCode: "LEASE_HELD",
      },
      {
        name: "POST project-scoped asset upload",
        call: () =>
          api(server.base, `/v1/assets?projectId=${projectId}`, {
            method: "POST",
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId, "idempotency-key": unique("asset") },
            body: descriptor,
          }),
        expectStatus: 409,
        expectCode: "LEASE_HELD",
      },
      // ---- the allowed half of the map: reads + review surfaces ----
      {
        name: "GET project",
        call: () =>
          api(server.base, `/v1/projects/${projectId}`, {
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
          }),
        expectStatus: 200,
      },
      {
        name: "GET versions timeline",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/versions?limit=10`, {
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
          }),
        expectStatus: 200,
      },
      {
        name: "GET run record",
        call: () =>
          api(server.base, `/v1/runs/${runId}`, {
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
          }),
        expectStatus: 200,
      },
      {
        name: "GET comments",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/comments`, {
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
          }),
        expectStatus: 200,
      },
      {
        name: "POST comment (review pin)",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/comments`, {
            method: "POST",
            jar: team.bJar,
            headers: {
              "x-workspace-id": team.wsId,
              "idempotency-key": unique("cmt"),
            },
            body: { compId: "comp_main", body: "B: reviewing while read-only" },
          }),
        expectStatus: 201,
      },
      {
        name: "POST comment reply",
        call: () =>
          api(server.base, `/v1/comments/${rootCommentId}/replies`, {
            method: "POST",
            jar: team.bJar,
            headers: {
              "x-workspace-id": team.wsId,
              "idempotency-key": unique("rpl"),
            },
            body: { body: "B: reply while read-only" },
          }),
        expectStatus: 201,
      },
      {
        name: "POST comment resolve",
        call: () =>
          api(server.base, `/v1/comments/${rootCommentId}/resolve`, {
            method: "POST",
            jar: team.bJar,
            headers: {
              "x-workspace-id": team.wsId,
              "idempotency-key": unique("res"),
            },
            body: {},
          }),
        expectStatus: 200,
      },
      {
        name: "POST presence beat",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/presence`, {
            method: "POST",
            jar: team.bJar,
            headers: {
              "x-workspace-id": team.wsId,
              "idempotency-key": unique("beat"),
            },
            body: { compId: "comp_main", playheadTicks: 1, clientNonce: "j6-b-beat-01" },
          }),
        expectStatus: 200,
      },
      {
        name: "GET presence viewers",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/presence`, {
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
          }),
        expectStatus: 200,
      },
      {
        name: "GET lease-state (the banner poll)",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/lease-state`, {
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
          }),
        expectStatus: 200,
      },
      {
        name: "GET activity feed",
        call: () =>
          api(server.base, `/v1/projects/${projectId}/activity?limit=10`, {
            jar: team.bJar,
            headers: { "x-workspace-id": team.wsId },
          }),
        expectStatus: 200,
      },
    ];

    for (const row of rows) {
      const response = await row.call();
      expect(response.status, row.name).toBe(row.expectStatus);
      if (row.expectCode !== undefined) {
        const parsed = await envelope(response);
        expect(parsed.err?.code, row.name).toBe(row.expectCode);
      }
    }

    // The map's verdict for B matches the banner endpoint's story.
    const state = await leaseState(team.bJar, team.wsId, projectId);
    expect(state.youAre).toBe("viewer");
    expect(state.canAcquire).toBe(false);
  });

  it("the turn POST is the ONE allowed agent POST (D-23): the read-only reviewer's agent still runs", async () => {
    const runId = unique("run");
    const response = await turnStream(team.bJar, team.wsId, threadId, runId, 0, [
      { role: "user", text: "Quick look at this comp" },
    ]);
    expect(response.status).toBe(200); // NOT a LEASE_HELD 409
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = new SseStream(response);
    const frames = await stream.rest();
    const events = expectValidStream(frames);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("turn.completed");
    // The propose-only envelope: plans never ride the SSE wire (the client
    // merges + POSTs them separately) — and no lease error ever does.
    expect(types).not.toContain("plan");
    expect(types).not.toContain("LEASE_HELD");
    // The read-only reviewer declines to execute the proposals: the
    // end-marker gesture lands the run completed without any write.
    const end = await api(server.base, `/v1/runs/${runId}/plan`, {
      method: "POST",
      jar: team.bJar,
      headers: { "x-workspace-id": team.wsId, "idempotency-key": unique("end") },
      body: { end: true },
    });
    expect(end.status).toBe(200);
    await waitFor("the ended run row", async () => {
      const run = await getRun(team.bJar, team.wsId, runId);
      return run.status === "completed";
    });
  });
});
