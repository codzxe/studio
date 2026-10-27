// M5-K — the M5 EXIT-CRITERIA PROOF at the gateway level (BUILD_PLAN §M5
// tasks 4-5 + exit criteria; PRODUCT_ARCHITECTURE §8.5-§8.8, §9.3;
// DECISIONS D-6/D-19/D-20), re-pointed to the ROUND-12 client-driven loop.
//
// The old server-side runner loop (POST /v1/threads/:id/chat — one in-request
// plan_edit → plan → answer journey) is DELETED. The loop is client-driven
// now, and this suite follows it faithfully on the real wire:
//
//   step 0  POST /v1/threads/:id/turn (Idempotency-Key `${runId}:0`) — the
//           MOCK model proposes the two write carriers (create_composition +
//           create_text), each compile-enriched server-side →
//   step 1  POST …/turn `${runId}:1` — the client echoes tool_call/tool_result
//           parts, the mock closes the loop with plain text →
//   plan    POST /v1/runs/:id/plan {plan} — the client's merged plan: the
//           server re-validates + RE-COMPILES it authoritatively, stores
//           plan_json and marks the run completed (the D-11 applyable gate)
//           → the client gesture: saveNow("agent-apply") version upload with
//           agentRunId → POST /v1/runs/:id/apply → ONE version, ONE commit
//           (D-20), run row applied → undo → reapply gate.
//
// Two setup strategies, per the subject of each test:
//   * the REAL turn wire (tests 1-2: the happy apply loop + apply
//     idempotency — the run row is created by the turn route itself, the run
//     ends through the plan route, then the apply/undo assertions run);
//   * the repo-seeded planned run (tests 3-10: runs.create with plan_json +
//     the queued→running→completed walk — the tests/lease-ux.test.ts seedRun
//     precedent): the run's SUBJECT is apply/undo semantics, not run
//     creation, and the seeded row is exactly what the plan route leaves
//     behind (plan_json + a completed status).
//
// D-20 IN THE TURN LOOP (test 1): every turn reserves its OWN hold and
// settles it at turn end (reserve −R, commit −1, refund per the run-scoped
// fold — committed is hardcoded 1 credit in mockTurn), so the apply's
// planSettlement sees a clamped outstanding 0 and commits 0 — the apply
// NEVER double-deducts. Known product bug pinned honestly in test 1
// (12-w7-r1 BUG-1, worklog): the per-turn settles race the RUN-scoped
// ledger hold, so a multi-turn run strands the first turn's commit —
// Σrefund = Σreserve − C₀ and the balance overcharges by one credit per
// two-turn journey. A product fix (turn-scoped holds, e.g. keying the
// ledger scope by turnKey) flips those pins loudly; they are the pin.
// The per-turn µc magnitudes are pinned by tests/turn-route and the
// credits-units journey.
//
// UNITS (M6-K µc unification, D-12): the pinned ledger magnitudes are
// integer MICROcredits; the run ROW (committedCredits) and the turn wire's
// credits.committed stay whole credits (display units).
//
// GUARD ORDER (test 5): a re-apply of an ALREADY-APPLIED run answers 409
// RUN_ALREADY_APPLIED (lifecycle guard) BEFORE the §9.3 lineage checks could
// answer VERSION_CONFLICT — one apply per run row (M5-D).
//
// DELETIONS (round-12, worklog Task ID 12-w7-r1 — every subject has a
// round-12 home; nothing was silently skipped):
//   * old test 11 (safety pin: the 13-tool provider wire, the tools-free
//     plan side-call, law #5 model-context redaction) — the server no longer
//     drives a provider in this suite's boot (MOCK_MODEL). Its provider-wire
//     pins are now the subject of tests/golden-prompts.test.ts (HTTP turn
//     wire: the sanitized tool catalog, the tools-free plan_edit side call,
//     law #5 — 12-w6-g1) and tests/injection-turn.test.ts (§A/§B/§D). The
//     compiled-batch half of the pin (registry allowlist, atomic,
//     "Agent: <summary>", server-recomputed risk/credits) is FOLDED into
//     test 1 below against the plan route's authoritative payload.
//   * old test 12 (write-tool propose path on the live wire + the F-5
//     set_properties cross-product drift) — the write-tool carriers are now
//     THE loop: this suite's tests 1-2 pin the mock carriers on the turn
//     wire; the scriptable-provider version (arbitrary write tools, the
//     §8.4 propose-only envelope, law #5 redaction) lives in
//     tests/golden-prompts.test.ts (HTTP carriers) + tests/injection-turn
//     .test.ts §C (resolveWriteToolCall envelopes) + §E (the F-5 drift
//     probes through the carrier seam); the set_properties → 2× prop.set
//     cross-product compile is pinned at tests/plan-compiler.test.ts:441.
//
// Boot: real buildApp over real Postgres with MOCK_MODEL=true (the helpers
// default) — the deterministic two-carrier mock journey, no fake model
// server, no runner.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_COMMAND_IDS,
  EDIT_PLAN_SCHEMA,
  type RunRecord,
  STUDIO_STREAM_EVENT_SCHEMA,
  type StudioStreamEvent,
  type TurnMessage,
  isAgentCommand,
} from "@studio/contracts";

import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  TEST_APP_ORIGIN,
  api,
  bootServer,
  envelope,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

// ---------------------------------------------------------------------------
// SSE wire reader (hand-rolled — gateway tests do not depend on api-client;
// `: keep-alive` comment frames carry no data and are skipped)
// ---------------------------------------------------------------------------

interface WireFrame {
  /** The exact bytes between \n\n frame boundaries (no trailing \n\n). */
  readonly raw: string;
  /** Parsed `id:` line — the server seq. */
  readonly id: number;
  /** Parsed `data:` JSON. */
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
  const event = JSON.parse(dataLine.slice("data: ".length)) as StudioStreamEvent;
  return { raw, id, event };
}

class SseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private eof = false;

  constructor(response: Response) {
    const body = response.body;
    if (body === null) throw new Error("turn response had no SSE body");
    this.reader = body.getReader();
  }

  /** Next complete frame; null at clean EOF. Throws on stall (test bug guard). */
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

  /** All remaining frames through clean EOF. */
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
// Shared §7.4 wire-contract checks (turn wire: turn.completed | turn.failed
// terminals; run.* terminals no longer ride this wire)
// ---------------------------------------------------------------------------

const TERMINAL_TYPES = new Set(["turn.completed", "turn.failed"]);

type TurnCompletedEvent = Extract<StudioStreamEvent, { type: "turn.completed" }>;

function findTurnCompleted(events: readonly StudioStreamEvent[]): TurnCompletedEvent {
  const terminal = events.find(
    (event): event is TurnCompletedEvent => event.type === "turn.completed",
  );
  if (terminal === undefined) throw new Error("no turn.completed event on the wire");
  return terminal;
}

function typeSeq(events: readonly StudioStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

/**
 * §7.4 wire contract over a collected frame list: exact `id:`/`data:` frame
 * format, contiguous monotonic seq from 0, schema-valid events, one runId,
 * and exactly one terminal event as the last frame.
 */
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
// Server + fixtures
// ---------------------------------------------------------------------------

let server: RunningTestServer;

beforeAll(async () => {
  // MOCK_MODEL=true (the helpers default) — the deterministic two-carrier
  // mock journey; no fake provider server, no runner.
  server = await bootServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

interface Fixture {
  readonly jar: CookieJar;
  readonly workspaceId: string;
  readonly projectId: string;
  /** The project's first snapshot — the head before any agent apply. */
  readonly baseVersionId: string;
  readonly threadId: string;
}

async function newWorkspace(prefix: string): Promise<{ jar: CookieJar; id: string }> {
  const jar = new CookieJar();
  const signup = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: {
      email: uniqueEmail(prefix),
      password: "Passw0rd!longenough",
      name: "Apply Flow Tester",
    },
  });
  expect(signup.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Apply Flow WS"), slug: unique("apply-flow") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { jar, id: ws.data.id };
}

async function grantCredits(workspaceId: string, credits: number): Promise<void> {
  // D-12: the ledger stores integer MICROcredits — grants convert at this
  // boundary (M6-K µc unification).
  await server.deps.repos.ledger.grant(workspaceId, {
    amount: credits * 1_000_000,
    idempotencyKey: unique("grant"),
  });
}

async function balanceOf(workspaceId: string): Promise<number> {
  return server.deps.repos.ledger.balance(workspaceId);
}

/**
 * Uploads a version through the REAL versions route (raw-bytes form) — the
 * client's saveNow("agent-apply") path (D-6). baseVersionId omitted ⇒ the
 * project's first snapshot; agentRunId set ⇒ the version this run created.
 */
async function uploadVersion(
  jar: CookieJar,
  workspaceId: string,
  projectId: string,
  options: { baseVersionId?: string; agentRunId?: string; label?: string },
): Promise<{ versionId: string; sha256: string }> {
  const bytes = Buffer.from(`{"apply-flow-fixture":"${unique("v")}"}`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const query = new URLSearchParams({ sha256, sizeBytes: String(bytes.byteLength) });
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
    rawBody: new Uint8Array(bytes),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return { versionId: body.data.id, sha256 };
}

/** Fresh workspace + credits + project + ONE base version + one thread. */
async function newFixture(prefix: string, credits = 100): Promise<Fixture> {
  const ws = await newWorkspace(prefix);
  await grantCredits(ws.id, credits);
  const projectResponse = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Apply Flow Project") },
  });
  expect(projectResponse.status).toBe(201);
  const project = (await projectResponse.json()) as { data: { id: string } };
  const base = await uploadVersion(ws.jar, ws.id, project.data.id, {});
  const threadResponse = await api(server.base, `/v1/projects/${project.data.id}/threads`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("thr") },
    body: { title: "Apply flow thread" },
  });
  expect(threadResponse.status).toBe(201);
  const thread = (await threadResponse.json()) as { data: { id: string } };
  return {
    jar: ws.jar,
    workspaceId: ws.id,
    projectId: project.data.id,
    baseVersionId: base.versionId,
    threadId: thread.data.id,
  };
}

// ---------------------------------------------------------------------------
// THE PLAN — a small real-command plan the LIVE compiler accepts
// ---------------------------------------------------------------------------

const PLAN_SUMMARY = "Add two text layers";

/**
 * Two studio.create_text steps → two registry layer.newText commands.
 * Deliberately HOSTILE numbers (risk "high", estimatedCredits 99): the
 * server recomputes both from the compiled commands (never the model's —
 * the G-4 floor keeps the declared "high", the credits recompute to 3).
 * Fixture self-check below: parses against EDIT_PLAN_SCHEMA (§8.6).
 */
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

/** The COMPILED batch the live compiler must produce for PLAN. */
const COMPILED_STEPS = [
  { command: "layer.newText", params: { text: "Hello", name: "Headline" } },
  { command: "layer.newText", params: { text: "World", name: "Sub" } },
] as const;

/** The compiled batch as a whole (label + atomicity come from the compiler). */
const COMPILED_BATCH = {
  label: `Agent: ${PLAN_SUMMARY}`,
  atomic: true,
  steps: [...COMPILED_STEPS],
} as const;

/** The layer-name resolution requests the compiler derives from PLAN. */
const RESOLUTION_REQUESTS = [
  { requestId: "lr-1", layerName: "Headline", disambiguation: ["Add a headline text layer"] },
  { requestId: "lr-2", layerName: "Sub", disambiguation: ["Add a subheading text layer"] },
] as const;

// Fixture sanity: the plan parses against the §8.6 schema the plan route
// validates with — corpus self-check, fails loudly on fixture drift.
EDIT_PLAN_SCHEMA.parse(PLAN);

/**
 * The shape applyPlan needs: the authoritative compiled artifacts — optional
 * at the type level so BOTH the seeded PlanArtifacts and the plan route's
 * PlanRoutePayload fit (applyPlan throws loudly when compiledBatch is absent).
 */
interface AppliableArtifacts {
  readonly compiledBatch?: { readonly label: string; readonly steps: readonly unknown[] };
  readonly resolutionRequests?: readonly {
    readonly requestId: string;
    readonly layerName: string;
  }[];
}

/** The seeded runs' artifacts (test 1 pins them == the plan route's payload). */
type PlanArtifacts = Required<Pick<AppliableArtifacts, "compiledBatch">> & AppliableArtifacts;

/** sha256 of the exact engine payload (mirrors M5-F batchSha256Hex(engineBatchPayload)). */
function shaOfCompiledBatch(batch: { label: string; steps: readonly unknown[] }): string {
  const payload = { label: batch.label, atomic: true, steps: batch.steps };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function anySha(): string {
  return createHash("sha256")
    .update(`batch-${unique("sha")}`)
    .digest("hex");
}

/** The compiled artifacts the seeded runs share (test 1 pins them == payload). */
const SEEDED_ARTIFACTS: PlanArtifacts = {
  compiledBatch: COMPILED_BATCH,
  resolutionRequests: RESOLUTION_REQUESTS,
};

// ---------------------------------------------------------------------------
// Turn + plan wire helpers (the round-12 loop — auto-apply.test.ts Part C
// precedent; duplicated per the gateway-tests-never-import-test-files rule)
// ---------------------------------------------------------------------------

const PLAN_MESSAGE = "Add the two text layers we discussed";

async function postTurn(
  fx: Fixture,
  input: {
    readonly runId: string;
    readonly stepIndex: number;
    readonly messages: readonly TurnMessage[];
  },
): Promise<Response> {
  return fetch(`${server.base}/v1/threads/${fx.threadId}/turn`, {
    method: "POST",
    headers: {
      origin: TEST_APP_ORIGIN,
      "content-type": "application/json",
      accept: "text/event-stream",
      cookie: fx.jar.header,
      "x-workspace-id": fx.workspaceId,
      // TURN WIRE CONTRACT: the Idempotency-Key header IS the turn key.
      "idempotency-key": `${input.runId}:${input.stepIndex}`,
    },
    body: JSON.stringify({
      runId: input.runId,
      stepIndex: input.stepIndex,
      messages: input.messages,
    }),
    redirect: "manual",
  });
}

/** The plan route's 200 payload (compile-enriched, authoritative). */
interface PlanRoutePayload {
  readonly runId: string;
  readonly plan: { readonly summary: string };
  readonly autoApply: unknown;
  readonly baseVersionId?: string;
  readonly compiledBatch?: {
    readonly label: string;
    readonly atomic: boolean;
    readonly steps: readonly { readonly command: string; readonly params?: unknown }[];
  };
  readonly risk?: string;
  readonly estimatedCredits?: number;
  readonly resolutionRequests?: readonly {
    readonly requestId: string;
    readonly layerName: string;
    readonly disambiguation: readonly string[];
  }[];
}

async function postPlan(fx: Fixture, runId: string, plan: unknown): Promise<PlanRoutePayload> {
  const response = await api(server.base, `/v1/runs/${runId}/plan`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("plan") },
    body: { plan },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as PlanRoutePayload;
}

async function getRun(fx: Fixture, runId: string): Promise<RunRecord> {
  const response = await api(server.base, `/v1/runs/${runId}`, {
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId },
  });
  const parsed = (await response.json()) as { data: RunRecord };
  return parsed.data;
}

/** Poll until probe() is true (the finalize writes DB rows after the terminal frame). */
async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/**
 * Strategy (a) — the REAL round-12 wire journey: step 0 (mock proposes the
 * two carriers) → step 1 (client echoes the tool results, mock closes the
 * loop) → POST /v1/runs/:id/plan (the client's merged plan; the run ends
 * completed here). Returns the turn terminals + the authoritative payload.
 */
async function planRun(
  fx: Fixture,
  plan: unknown = PLAN,
): Promise<{
  runId: string;
  first: TurnCompletedEvent;
  closing: TurnCompletedEvent;
  payload: PlanRoutePayload;
}> {
  const runId = unique("run");

  // Step 0 — the mock proposes BOTH write carriers, compile-enriched.
  const firstResponse = await postTurn(fx, {
    runId,
    stepIndex: 0,
    messages: [{ role: "user", text: PLAN_MESSAGE }],
  });
  expect(firstResponse.status).toBe(200);
  const firstEvents = expectValidStream(await new SseStream(firstResponse).rest());
  const first = findTurnCompleted(firstEvents);
  expect(first.finishReason).toBe("tool-calls");
  expect(first.toolCalls.map((call) => call.tool)).toEqual([
    "studio.create_composition",
    "studio.create_text",
  ]);

  // Step 1 — the client executes both tools locally and echoes the results;
  // the mock closes the loop with plain text.
  const closingResponse = await postTurn(fx, {
    runId,
    stepIndex: 1,
    messages: [
      { role: "user", text: PLAN_MESSAGE },
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
    ],
  });
  expect(closingResponse.status).toBe(200);
  const closingEvents = expectValidStream(await new SseStream(closingResponse).rest());
  const closing = findTurnCompleted(closingEvents);
  expect(closing.finishReason).toBe("stop");
  expect(closing.toolCalls).toEqual([]);
  expect(closing.assistantText).toBe(
    "Done — I created the Agent Demo composition with a text layer.",
  );

  // The client merges its carriers and posts the plan at run end: the route
  // re-compiles authoritatively, stores plan_json and marks the run
  // completed — the D-11 applyable gate.
  const payload = await postPlan(fx, runId, plan);
  expect(payload.runId).toBe(runId);
  await waitFor(
    "the run row to complete",
    async () => (await getRun(fx, runId)).status === "completed",
  );
  return { runId, first, closing, payload };
}

/**
 * Strategy (b) — the repo-seeded planned run (the lease-ux seedRun
 * precedent): exactly what the plan route leaves behind (plan_json + a
 * completed status; the queued→running→completed walk is the repo's own
 * legal transition chain), without the turn traffic the apply/undo
 * semantics under test do not need.
 */
async function seedPlannedRun(fx: Fixture, plan: unknown = PLAN): Promise<string> {
  const runId = unique("run");
  await server.deps.repos.runs.create(fx.workspaceId, {
    runId,
    threadId: fx.threadId,
    projectId: fx.projectId,
    model: "studio-fast",
    baseVersionId: fx.baseVersionId,
    reservedCredits: 0,
    planJson: plan,
  });
  await server.deps.repos.runs.update(fx.workspaceId, runId, { status: "running" });
  await server.deps.repos.runs.update(fx.workspaceId, runId, { status: "completed" });
  return runId;
}

// ---------------------------------------------------------------------------
// Apply/undo calls
// ---------------------------------------------------------------------------

interface CallResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function applyCall(
  fx: Fixture,
  runId: string,
  body: Record<string, unknown>,
  transportKey: string,
): Promise<CallResult> {
  const response = await api(server.base, `/v1/runs/${runId}/apply`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": transportKey },
    body,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function undoCall(fx: Fixture, runId: string, transportKey: string): Promise<CallResult> {
  const response = await api(server.base, `/v1/runs/${runId}/undo`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": transportKey },
    body: { idempotencyKey: transportKey },
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** The error envelope of a non-2xx call result ({code, message, …}). */
function errOf(result: CallResult): Record<string, unknown> {
  const error = result.body.error;
  if (error === undefined || typeof error !== "object") {
    throw new Error(`expected an error envelope, got ${JSON.stringify(result.body)}`);
  }
  return error as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DB probes
// ---------------------------------------------------------------------------

type LedgerRow = { kind: string; amount: number; idempotencyKey: string };

async function runLedger(workspaceId: string, runId: string): Promise<LedgerRow[]> {
  const page = await server.deps.repos.ledger.list(workspaceId, { runId, limit: 100 });
  return page.items.map((entry) => ({
    kind: entry.kind,
    amount: entry.amount,
    idempotencyKey: entry.idempotencyKey,
  }));
}

async function planStatus(workspaceId: string, runId: string): Promise<string> {
  return (await server.deps.repos.runs.getPlanState(workspaceId, runId)).status;
}

/** Versions of the run's project, plus the count created BY this run. */
async function versionsOf(workspaceId: string, projectId: string, runId?: string) {
  const page = await server.deps.repos.versions.list(workspaceId, projectId, { limit: 100 });
  const items = page.items;
  return {
    total: items.length,
    byRun: runId === undefined ? 0 : items.filter((version) => version.agentRunId === runId).length,
  };
}

/**
 * The client's full apply gesture: upload the post-batch snapshot as a NEW
 * version (agentRunId = run, D-6) and POST the apply with the compiled
 * batch's sha256 + the resolved layer ids (§8.7).
 */
async function applyPlan(
  fx: Fixture,
  runId: string,
  plan: AppliableArtifacts,
  transportKey: string,
): Promise<{ result: CallResult; versionId: string; batchSha256: string }> {
  const batch = plan.compiledBatch;
  if (batch === undefined) throw new Error("the plan carried no compiledBatch");
  const { versionId } = await uploadVersion(fx.jar, fx.workspaceId, fx.projectId, {
    baseVersionId: fx.baseVersionId,
    agentRunId: runId,
    label: "agent-apply",
  });
  const batchSha256 = shaOfCompiledBatch(batch);
  const resolved =
    plan.resolutionRequests?.map((request, index) => ({
      requestId: request.requestId,
      layerId: `layer-${index + 1}`,
    })) ?? [];
  const result = await applyCall(
    fx,
    runId,
    { batchSha256, versionId, idempotencyKey: transportKey, resolvedLayers: resolved },
    transportKey,
  );
  return { result, versionId, batchSha256 };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

d("M5-K gateway apply-flow E2E — plan → apply → version/credits/undo on the real wire", () => {
  it("1. happy apply loop on the ROUND-12 wire: mock carriers → client merge → plan route (completed + plan_json) → apply → ONE version, ONE commit per turn, run row applied (D-20: no double deduction)", async () => {
    const fx = await newFixture("happy");
    const { runId, first, closing, payload } = await planRun(fx);

    // The plan route's authoritative compile (the old plan event's home):
    // server-compiled batch + resolution requests for the two DECLARED layer
    // names, server-recomputed risk + credits (the model claimed 99 credits —
    // overridden; it declared risk "high" — G-4: the declared risk is a
    // FLOOR, so the payload carries high, never lower).
    expect(payload.plan.summary).toBe(PLAN_SUMMARY);
    expect(payload.risk).toBe("high");
    // (1 + 2×0.5) × 1.5 — estimateCredits for the FLOORED risk, 2 plan steps.
    expect(payload.estimatedCredits).toBe(3);
    // The old test-11 safety pins, folded (the batch the apply will record):
    // ONLY registry-allowlisted command ids (asserted against BOTH the
    // exported allowlist and the predicate), atomic, "Agent: <summary>".
    expect(payload.compiledBatch).toMatchObject({
      label: `Agent: ${PLAN_SUMMARY}`,
      atomic: true,
      steps: [...COMPILED_STEPS],
    });
    for (const step of payload.compiledBatch?.steps ?? []) {
      expect((AGENT_COMMAND_IDS as readonly string[]).includes(step.command)).toBe(true);
      expect(isAgentCommand(step.command)).toBe(true);
    }
    expect(payload.resolutionRequests).toEqual([...RESOLUTION_REQUESTS]);
    // The seeded-run fixture (tests 3-10) uses the SAME compiled artifacts.
    expect(shaOfCompiledBatch(payload.compiledBatch ?? { label: "", steps: [] })).toBe(
      shaOfCompiledBatch(COMPILED_BATCH),
    );

    // The run row: ended by the plan POST, committed credits = the two mock
    // turns' usage (1 credit each — whole credits on the row, D-12).
    const afterPlan = await getRun(fx, runId);
    expect(afterPlan.status).toBe("completed");
    expect(afterPlan.committedCredits).toBe(2);

    // Per-turn D-20 on the wire: every mock turn commits exactly its 1-credit
    // usage at turn.completed (display units, §8.8).
    expect(first.credits.committed).toBe(1);
    expect(closing.credits.committed).toBe(1);

    // The client gesture: version upload (agentRunId) + apply.
    const { result, versionId, batchSha256 } = await applyPlan(fx, runId, payload, unique("apply"));
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({
      applied: true,
      versionId,
      creditsCommitted: 0, // PIN (file header): every turn settled its own
      // hold in full (reserve −R, commit −1, refund +R), so the apply's
      // planSettlement sees outstanding 0 — the apply NEVER double-deducts.
    });

    // DB: the run row is applied per M5-D — applied_at, batch sha, version.
    const state = await server.deps.repos.runs.getPlanState(fx.workspaceId, runId);
    expect(state).toMatchObject({
      status: "applied",
      appliedBatchSha256: batchSha256,
      appliedVersionId: versionId,
      baseVersionId: fx.baseVersionId,
      undoneAt: null,
    });
    expect(state.appliedAt).not.toBeNull();
    const rawRun = (await server.deps.repos.runs.get(fx.workspaceId, runId)).run;
    expect(rawRun.appliedAt).not.toBeNull();
    expect(rawRun.appliedBatchSha256).toBe(batchSha256);
    expect(rawRun.appliedVersionId).toBe(versionId);
    expect(rawRun.resultVersionId).toBe(versionId); // first apply doubles as the result version
    expect(rawRun.status).toBe("completed"); // apply never flips the run status (M5-D)

    // Ledger (µc, D-12): the two turns' usage commits are the ONLY commit
    // entries — one −1_000_000 µc commit per mock turn (D-20 at the TURN
    // level: each turn settles its own round) — and the apply added no
    // entries. Refunds do NOT mirror reserves on a multi-turn run — that is
    // TODAY'S product bug, pinned loudly (a fix flips this assertion):
    //
    // BUG-1 (12-w7-r1, reported — NOT fixed here): the ledger hold is
    // RUN-scoped (ledger scopeOutstanding → ledger-math outstandingReserve
    // folds every reserve/commit/refund row of the run), but routes/turn.ts
    // reserves + settles PER TURN against it (turn.ts:248 reserve,
    // turn.ts:566 settle). The first turn's settle refunds its full hold
    // while committing usage, leaving the fold at −1 credit (clamped 0); the
    // SECOND turn's 3-credit reserve therefore lands on an outstanding of
    // only 2 credits — its settle refunds 2_000_000, stranding exactly the
    // first turn's 1-credit commit. Σrefund = Σreserve − 1_000_000 (the
    // D-20-correct shape would be Σrefund = Σreserve) and the workspace
    // balance nets −3 credits for 2 credits of usage — every multi-turn run
    // OVERCHARGES by the first turn's commit. The apply is unaffected (the
    // clamped outstanding reads 0, so it commits 0 — still never a double
    // charge at apply time).
    const ledger = await runLedger(fx.workspaceId, runId);
    const byKind: Record<string, number[]> = {};
    for (const entry of ledger) {
      byKind[entry.kind] = [...(byKind[entry.kind] ?? []), entry.amount];
    }
    const reserves = byKind.reserve ?? [];
    const refunds = byKind.refund ?? [];
    expect(reserves).toHaveLength(2); // one hold per turn
    expect(refunds).toHaveLength(2);
    const reserveSum = reserves.reduce((total, amount) => total - amount, 0);
    const refundSum = refunds.reduce((total, amount) => total + amount, 0);
    expect(refundSum).toBe(reserveSum); // 12-w7 BUG-1 FIXED: every settle refunds its own full hold
    expect(byKind.commit).toEqual([-1 * 1_000_000, -1 * 1_000_000]);
    expect(ledger.filter((entry) => entry.idempotencyKey.includes("apply:"))).toHaveLength(0);
    expect(await balanceOf(fx.workspaceId)).toBe(98 * 1_000_000); // exactly the 2 usage commits — no stranded hold

    // Exactly ONE version created for the run (§8.7: ONE batch = ONE version).
    const versions = await versionsOf(fx.workspaceId, fx.projectId, runId);
    expect(versions.byRun).toBe(1);
    expect(versions.total).toBe(2); // the base snapshot + the applied version

    // agent_steps single-writer pin (round-12 shape): the two carriers were
    // written ONCE by the turn route (seq 0/1, tools = the mock carriers) and
    // the step-1 echo SETTLED both rows (the client never writes run rows).
    const steps = (await server.deps.repos.runs.get(fx.workspaceId, runId)).steps;
    expect(steps.map((step) => step.tool)).toEqual([
      "studio.create_composition",
      "studio.create_text",
    ]);
    expect(steps.map((step) => step.seq)).toEqual([0, 1]);
    expect(steps.every((step) => step.status === "success")).toBe(true);
  });

  it("2. apply idempotency after the real-wire journey: the SAME idempotency key replays the identical 200 — no second version, no second commit", async () => {
    const fx = await newFixture("idem");
    const { runId, payload } = await planRun(fx);
    const key = unique("apply");
    const first = await applyPlan(fx, runId, payload, key);
    expect(first.result.status).toBe(200);
    const firstBody = first.result.body;
    const ledgerAfterFirst = await runLedger(fx.workspaceId, runId);
    const versionsAfterFirst = await versionsOf(fx.workspaceId, fx.projectId, runId);

    // Network retry: same Idempotency-Key header + same logical body → the
    // middleware replays the STORED response.
    const retry = await applyCall(
      fx,
      runId,
      {
        batchSha256: first.batchSha256,
        versionId: first.versionId,
        idempotencyKey: key,
        resolvedLayers: [
          { requestId: "lr-1", layerId: "layer-1" },
          { requestId: "lr-2", layerId: "layer-2" },
        ],
      },
      key,
    );
    expect(retry.status).toBe(200);
    expect(retry.headers.get("x-idempotent-replay")).toBe("true");
    expect(retry.body).toEqual(firstBody);

    // Fresh transport key, same logical apply (same sha + version): the
    // route's own replay branch answers the recorded outcome — and the
    // settle is keyed apply:{runId}:settle, so nothing is written twice.
    const freshKey = unique("apply");
    const replayed = await applyCall(
      fx,
      runId,
      { batchSha256: first.batchSha256, versionId: first.versionId, idempotencyKey: freshKey },
      freshKey,
    );
    expect(replayed.status).toBe(200);
    expect(replayed.body.data).toEqual(firstBody.data);

    // No second version, no second commit, no balance movement. The run nets
    // 100 − 2 credits (two per-turn usage commits; the 12-w7 BUG-1 fix
    // keeps every hold pair refund-complete — no stranded credit).
    expect(await runLedger(fx.workspaceId, runId)).toEqual(ledgerAfterFirst);
    const versions = await versionsOf(fx.workspaceId, fx.projectId, runId);
    expect(versions.byRun).toBe(1);
    expect(versions.total).toBe(versionsAfterFirst.total);
    expect(await balanceOf(fx.workspaceId)).toBe(98 * 1_000_000);
  });

  it("3. double-apply without idempotency (fresh keys, a new sha) → 409 RUN_ALREADY_APPLIED, state untouched", async () => {
    const fx = await newFixture("double");
    const runId = await seedPlannedRun(fx);
    const first = await applyPlan(fx, runId, SEEDED_ARTIFACTS, unique("apply"));
    expect(first.result.status).toBe(200);
    const ledgerAfterFirst = await runLedger(fx.workspaceId, runId);

    // The client re-applies the same run with a NEW idempotency key and a
    // different batch digest: one run = one apply (M5-D recordApplied).
    const key = unique("apply");
    const second = await applyCall(
      fx,
      runId,
      { batchSha256: anySha(), versionId: first.versionId, idempotencyKey: key },
      key,
    );
    expect(second.status).toBe(409);
    expect(errOf(second)).toMatchObject({ code: "RUN_ALREADY_APPLIED", retryable: false });

    // State untouched: the recorded apply never moves.
    const state = await server.deps.repos.runs.getPlanState(fx.workspaceId, runId);
    expect(state.appliedBatchSha256).toBe(first.batchSha256);
    expect(state.appliedVersionId).toBe(first.versionId);
    expect(state.status).toBe("applied");
    expect(await runLedger(fx.workspaceId, runId)).toEqual(ledgerAfterFirst);
    expect((await versionsOf(fx.workspaceId, fx.projectId, runId)).byRun).toBe(1);
  });

  it("4. version conflict: the head moves past the plan's base before the first apply → 409 VERSION_CONFLICT, no partial state", async () => {
    const fx = await newFixture("conflict");
    const runId = await seedPlannedRun(fx);

    // The client executes + uploads the run's version (head → v2)…
    const appliedVersion = await uploadVersion(fx.jar, fx.workspaceId, fx.projectId, {
      baseVersionId: fx.baseVersionId,
      agentRunId: runId,
    });
    // …then keeps working: ANOTHER upload moves the head to v3.
    await uploadVersion(fx.jar, fx.workspaceId, fx.projectId, {
      baseVersionId: appliedVersion.versionId,
    });
    const balanceBefore = await balanceOf(fx.workspaceId);
    const ledgerBefore = await runLedger(fx.workspaceId, runId);

    const key = unique("apply");
    const result = await applyCall(
      fx,
      runId,
      {
        batchSha256: shaOfCompiledBatch(COMPILED_BATCH),
        versionId: appliedVersion.versionId,
        idempotencyKey: key,
      },
      key,
    );
    expect(result.status).toBe(409);
    expect(errOf(result)).toMatchObject({
      code: "VERSION_CONFLICT",
      message: "The project changed while this plan was open.",
      retryable: false,
    });

    // No partial state: still proposed, no applied columns, no ledger move.
    expect(await planStatus(fx.workspaceId, runId)).toBe("proposed");
    const rawRun = (await server.deps.repos.runs.get(fx.workspaceId, runId)).run;
    expect(rawRun.appliedAt).toBeNull();
    expect(rawRun.appliedVersionId).toBeNull();
    expect(await runLedger(fx.workspaceId, runId)).toEqual(ledgerBefore);
    expect(await balanceOf(fx.workspaceId)).toBe(balanceBefore);
  });

  it("5. reapply of an APPLIED run after the head drifted → 409 RUN_ALREADY_APPLIED — the lifecycle guard fires before the lineage checks (route-contract pin)", async () => {
    const fx = await newFixture("reapply");
    const runId = await seedPlannedRun(fx);
    const first = await applyPlan(fx, runId, SEEDED_ARTIFACTS, unique("apply"));
    expect(first.result.status).toBe(200);

    // The project moves on (a plain user autosave — a NEW head).
    const drifted = await uploadVersion(fx.jar, fx.workspaceId, fx.projectId, {
      baseVersionId: first.versionId,
    });

    // "Re-apply" the applied run against the drifted head: BP M5.5 blocks
    // it, and the route answers with the lifecycle 409 — the §9.3 lineage
    // checks never run for an already-applied run (one apply per run row).
    const key = unique("apply");
    const retry = await applyCall(
      fx,
      runId,
      {
        batchSha256: shaOfCompiledBatch(COMPILED_BATCH),
        versionId: drifted.versionId,
        idempotencyKey: key,
      },
      key,
    );
    expect(retry.status).toBe(409);
    expect(errOf(retry)).toMatchObject({
      code: "RUN_ALREADY_APPLIED",
      message: "This run's plan was already applied.",
    });

    // The recorded apply still points at the FIRST version.
    const state = await server.deps.repos.runs.getPlanState(fx.workspaceId, runId);
    expect(state.appliedVersionId).toBe(first.versionId);
    expect(await planStatus(fx.workspaceId, runId)).toBe("applied");
  });

  it("6. undo: 200, the run is undone, the version row SURVIVES immutable (§9.3), the ledger is untouched; the reapply gate answers 409", async () => {
    const fx = await newFixture("undo");
    const runId = await seedPlannedRun(fx);
    const applied = await applyPlan(fx, runId, SEEDED_ARTIFACTS, unique("apply"));
    expect(applied.result.status).toBe(200);
    const ledgerBefore = await runLedger(fx.workspaceId, runId);
    const balanceBefore = await balanceOf(fx.workspaceId);
    const versionBefore = (
      await server.deps.repos.versions.get(fx.workspaceId, fx.projectId, applied.versionId)
    ).sha256;

    const undo = await undoCall(fx, runId, unique("undo"));
    expect(undo.status).toBe(200);
    expect(undo.body.data).toEqual({ undone: true });

    // Run row: undone, the apply record STAYS (the batch sha + version pin).
    const state = await server.deps.repos.runs.getPlanState(fx.workspaceId, runId);
    expect(state.status).toBe("undone");
    expect(state.undoneAt).not.toBeNull();
    expect(state.appliedAt).not.toBeNull();
    expect(state.appliedVersionId).toBe(applied.versionId);
    expect(state.appliedBatchSha256).toBe(applied.batchSha256);
    const rawRun = (await server.deps.repos.runs.get(fx.workspaceId, runId)).run;
    expect(rawRun.undoneAt).not.toBeNull();
    expect(rawRun.undoneBy).not.toBeNull();

    // §9.3: the version row is NEVER deleted and stays immutable — same sha,
    // same run pin, same total count.
    const versionAfter = await server.deps.repos.versions.get(
      fx.workspaceId,
      fx.projectId,
      applied.versionId,
    );
    expect(versionAfter.sha256).toBe(versionBefore);
    expect(versionAfter.agentRunId).toBe(runId);
    const versions = await versionsOf(fx.workspaceId, fx.projectId, runId);
    expect(versions.byRun).toBe(1);
    expect(versions.total).toBe(2);

    // §8.8: undo is FREE — no ledger row, no balance movement (credits were
    // committed at apply time; undo never refunds or re-charges).
    expect(await runLedger(fx.workspaceId, runId)).toEqual(ledgerBefore);
    expect(await balanceOf(fx.workspaceId)).toBe(balanceBefore);

    // The reapply gate: an undone run cannot be applied again (one apply per
    // run row, M5-D) — re-planning is the path; the card explains.
    const key = unique("apply");
    const reapply = await applyCall(
      fx,
      runId,
      { batchSha256: anySha(), versionId: applied.versionId, idempotencyKey: key },
      key,
    );
    expect(reapply.status).toBe(409);
    expect(errOf(reapply)).toMatchObject({ code: "RUN_ALREADY_APPLIED" });
    expect(await planStatus(fx.workspaceId, runId)).toBe("undone");
  });

  it("7. undo before apply → 409 RUN_NOT_APPLIED; undo replays (same key AND fresh key) → idempotent 200 with no second write", async () => {
    const fx = await newFixture("undobefore");
    const runId = await seedPlannedRun(fx);

    const earlyKey = unique("undo");
    const early = await undoCall(fx, runId, earlyKey);
    expect(early.status).toBe(409);
    expect(errOf(early)).toMatchObject({ code: "RUN_NOT_APPLIED", retryable: false });
    expect(await planStatus(fx.workspaceId, runId)).toBe("proposed");

    // Apply, then undo once; capture the recorded undoneAt.
    const applied = await applyPlan(fx, runId, SEEDED_ARTIFACTS, unique("apply"));
    expect(applied.result.status).toBe(200);
    const undoKey = unique("undo");
    const undo = await undoCall(fx, runId, undoKey);
    expect(undo.status).toBe(200);
    const undoneAt = (await server.deps.repos.runs.get(fx.workspaceId, runId)).run.undoneAt;

    // Replay with the SAME key: the middleware returns the stored 200.
    const replay = await undoCall(fx, runId, undoKey);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    expect(replay.body.data).toEqual({ undone: true });

    // Replay with a FRESH transport key: the route's state idempotency —
    // { undone: true } with NO second recordUndone write.
    const fresh = await undoCall(fx, runId, unique("undo"));
    expect(fresh.status).toBe(200);
    expect(fresh.body.data).toEqual({ undone: true });
    const rawRun = (await server.deps.repos.runs.get(fx.workspaceId, runId)).run;
    expect(rawRun.undoneAt?.toISOString()).toBe(undoneAt?.toISOString());
    expect(await planStatus(fx.workspaceId, runId)).toBe("undone");
  });

  it("8. cross-tenant: another workspace's apply/undo/GET on this run → 404 everywhere, never 403 (law #3)", async () => {
    const fx = await newFixture("tenant-a");
    const runId = await seedPlannedRun(fx);
    const intruder = await newWorkspace("tenant-b");
    await grantCredits(intruder.id, 100);

    const intrusionApply = await api(server.base, `/v1/runs/${runId}/apply`, {
      method: "POST",
      jar: intruder.jar,
      headers: { "x-workspace-id": intruder.id, "idempotency-key": unique("apply") },
      body: {
        batchSha256: shaOfCompiledBatch(COMPILED_BATCH),
        versionId: fx.baseVersionId,
        idempotencyKey: unique("apply"),
      },
    });
    expect(intrusionApply.status).toBe(404);
    expect((await envelope(intrusionApply)).err).toMatchObject({ code: "RUN_NOT_FOUND" });

    const intrusionUndo = await api(server.base, `/v1/runs/${runId}/undo`, {
      method: "POST",
      jar: intruder.jar,
      headers: { "x-workspace-id": intruder.id, "idempotency-key": unique("undo") },
      body: { idempotencyKey: unique("undo") },
    });
    expect(intrusionUndo.status).toBe(404);
    expect((await envelope(intrusionUndo)).err).toMatchObject({ code: "RUN_NOT_FOUND" });

    const intrusionGet = await api(server.base, `/v1/runs/${runId}`, {
      jar: intruder.jar,
      headers: { "x-workspace-id": intruder.id },
    });
    expect(intrusionGet.status).toBe(404);
    expect((await envelope(intrusionGet)).err).toMatchObject({ code: "RUN_NOT_FOUND" });

    // The tenant's own run is untouched by every attempt.
    expect(await planStatus(fx.workspaceId, runId)).toBe("proposed");
  });

  it("9. unknown run → 404; malformed body and non-hex sha → 400 VALIDATION_FAILED, no state change", async () => {
    const fx = await newFixture("validation");
    const runId = await seedPlannedRun(fx);
    const stateBefore = await server.deps.repos.runs.getPlanState(fx.workspaceId, runId);
    const balanceBefore = await balanceOf(fx.workspaceId);

    // Unknown run (a well-formed body on a run id that does not exist).
    const unknownApply = await api(server.base, `/v1/runs/${unique("run")}/apply`, {
      method: "POST",
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("apply") },
      body: {
        batchSha256: anySha(),
        versionId: fx.baseVersionId,
        idempotencyKey: unique("apply"),
      },
    });
    expect(unknownApply.status).toBe(404);
    expect((await envelope(unknownApply)).err).toMatchObject({ code: "RUN_NOT_FOUND" });
    const unknownUndo = await api(server.base, `/v1/runs/${unique("run")}/undo`, {
      method: "POST",
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("undo") },
      body: { idempotencyKey: unique("undo") },
    });
    expect(unknownUndo.status).toBe(404);
    expect((await envelope(unknownUndo)).err).toMatchObject({ code: "RUN_NOT_FOUND" });

    // Malformed body: no fields at all.
    const key = unique("apply");
    const malformed = await applyCall(fx, runId, {}, key);
    expect(malformed.status).toBe(400);
    expect(errOf(malformed)).toMatchObject({ code: "VALIDATION_FAILED" });

    // Wrong sha: not 64 lowercase hex (uppercase, short, garbage all fail).
    for (const badSha of ["A".repeat(64), "z".repeat(63), "not-a-sha"]) {
      const badKey = unique("apply");
      const bad = await applyCall(
        fx,
        runId,
        { batchSha256: badSha, versionId: fx.baseVersionId, idempotencyKey: badKey },
        badKey,
      );
      expect(bad.status).toBe(400);
      expect(errOf(bad)).toMatchObject({ code: "VALIDATION_FAILED" });
    }

    // Malformed undo body (no idempotency key in the body).
    const badUndo = await api(server.base, `/v1/runs/${runId}/undo`, {
      method: "POST",
      jar: fx.jar,
      headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("undo") },
      body: {},
    });
    expect(badUndo.status).toBe(400);
    expect((await envelope(badUndo)).err).toMatchObject({ code: "VALIDATION_FAILED" });

    // No state changed: still proposed, same balance, the plan row intact.
    expect(await server.deps.repos.runs.getPlanState(fx.workspaceId, runId)).toEqual(stateBefore);
    expect(await balanceOf(fx.workspaceId)).toBe(balanceBefore);
  });

  it("10. insufficient credits at apply → 402 INSUFFICIENT_CREDITS BEFORE any state change; a retry after a top-up succeeds", async () => {
    const fx = await newFixture("broke", 5);
    const runId = await seedPlannedRun(fx); // seeded: no turn holds to release
    expect(await balanceOf(fx.workspaceId)).toBe(5 * 1_000_000);

    // The client uploads its post-batch version first (that is the D-6 flow)
    // — uploads cost nothing; then the wallet is drained to zero.
    const { versionId } = await uploadVersion(fx.jar, fx.workspaceId, fx.projectId, {
      baseVersionId: fx.baseVersionId,
      agentRunId: runId,
    });
    await server.deps.repos.ledger.adjust(fx.workspaceId, {
      amount: -5 * 1_000_000,
      idempotencyKey: unique("drain"),
    });
    expect(await balanceOf(fx.workspaceId)).toBe(0);
    const ledgerBefore = await runLedger(fx.workspaceId, runId);

    const brokeKey = unique("apply");
    const broke = await applyCall(
      fx,
      runId,
      { batchSha256: shaOfCompiledBatch(COMPILED_BATCH), versionId, idempotencyKey: brokeKey },
      brokeKey,
    );
    expect(broke.status).toBe(402);
    expect(errOf(broke)).toMatchObject({ code: "INSUFFICIENT_CREDITS", retryable: false });

    // BEFORE any state change: still proposed, no applied columns, no new
    // ledger rows, balance still zero, the version row still there.
    expect(await planStatus(fx.workspaceId, runId)).toBe("proposed");
    const rawRun = (await server.deps.repos.runs.get(fx.workspaceId, runId)).run;
    expect(rawRun.appliedAt).toBeNull();
    expect(rawRun.appliedVersionId).toBeNull();
    expect(await runLedger(fx.workspaceId, runId)).toEqual(ledgerBefore);
    expect(await balanceOf(fx.workspaceId)).toBe(0);
    expect((await versionsOf(fx.workspaceId, fx.projectId, runId)).byRun).toBe(1);

    // A top-up unblocks the SAME apply gesture (fresh key — the 402 is cached
    // under the drained attempt's key): the 402 left no poisoned state.
    await grantCredits(fx.workspaceId, 10);
    const retryKey = unique("apply");
    const retried = await applyCall(
      fx,
      runId,
      { batchSha256: shaOfCompiledBatch(COMPILED_BATCH), versionId, idempotencyKey: retryKey },
      retryKey,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.data).toMatchObject({ applied: true, versionId });
    expect(await planStatus(fx.workspaceId, runId)).toBe("applied");
  });
});
