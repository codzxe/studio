// M5-K — the M5 EXIT-CRITERIA PROOF at the gateway level (BUILD_PLAN §M5
// tasks 4-5 + exit criteria; PRODUCT_ARCHITECTURE §8.5-§8.8, §9.3;
// DECISIONS D-6/D-19/D-20). The FULL M5 loop E2E on the real wire:
//
//   model ──studio.plan_edit──▶ server-side plan-compiler (REAL registry +
//   REAL write-tool schemas) ──▶ {type:"plan"} event carrying compiledBatch +
//   resolutionRequests on the SSE wire ──▶ client executes ONE engine.batch,
//   saveNow("agent-apply") uploads the version through the REAL versions
//   route with agentRunId ──▶ POST /v1/runs/:id/apply ──▶ ONE version, ONE
//   commit (D-20), run row applied ──▶ undo ──▶ reapply gate.
//
// Boot: real buildApp over real Postgres + the REAL LiteLLM runner
// (MOCK_MODEL=false via createRunnerForEnv) against an in-process fake
// OpenAI-compatible SSE server on an ephemeral localhost port — exactly the
// M4-K chat-loop harness pattern, duplicated per its precedent (never
// imported from a sibling test file). Deterministic: no real sleeps, no fake
// timers; every scenario scripts its own model rounds.
//
// Scenarios (test names are the evidence): happy apply loop; idempotent
// replay; double-apply 409; version conflict 409 (+ the route's guard-order
// pin for post-apply reapply); undo (version immutable §9.3, ledger
// untouched); undo-before-apply 409 + idempotent undo replay; cross-tenant
// 404; unknown run / malformed body / non-hex sha; insufficient credits 402
// before any state change; the safety pins (compiledBatch allowlist,
// atomic, "Agent: <summary>", exactly 13 tools on the provider wire, the
// model never sees the compiled output); the write-tool propose path.
//
// PINS (documented for the M5 closeout — law #12, report-only):
//
// * PLAN SHAPE (contract drift accommodated): the mission brief suggested
//   "one set_properties step compiled to a prop.set batch against 2 layers".
//   Through the REAL compile seam (defaultCompileDeps: the M5-A contracts
//   write-tool schemas + the M5-J registry) that plan CANNOT compile — see
//   the next pin. The plan here uses two studio.create_text steps (both
//   compiled to the registry id layer.newText) with two DECLARED affected
//   layers, so the live route still emits a real compiledBatch AND real
//   resolutionRequests (lr-1/lr-2 for the declared layer names). Test 12
//   pins the drift itself at the live wire.
//
// * M5-A ⇄ M5-B ARGS-VOCABULARY DRIFT (test 12, live-wire proof):
//   plan-compiler.ts translate() reads the M5-B fixture vocabulary
//   (`updates: [{layer, path, value}]`, `layer`+`keyframes`, `targets`,
//   `layer`+`effect`), while the M5-A contracts schemas (the ones the live
//   runner validates args against) speak `layers: [{name}]` +
//   `properties|keys|effect|preset`. A studio.set_properties call with REAL
//   M5-A args therefore compiles to ZERO commands (fatal empty_batch) → the
//   tool answers PROPOSAL_INVALID on the live wire. Every layer-REFERENCING
//   write tool (set_properties/add_effect/set_keyframes/apply_preset) is
//   affected; create_composition/create_text/undo_run are not. Owner: M5-B
//   plan-compiler.ts (translate must accept the M5-A contracts shapes) or a
//   DECISIONS ruling; NOT fixed here (law #12).
//
// * D-20 IN THE LIVE LOOP (test 1): the chat finalize settles the run's
//   whole hold at run.completed (reserve −N, commit −M usage, refund +N per
//   D-20), so the apply's planSettlement sees outstanding 0 and commits 0 —
//   creditsCommitted is 0 in the FULL loop and the run nets exactly −M, its
//   single commit entry. The route documents this ("never a double charge");
//   the net = −planCredits reading is the seeded-hold world M5-E's
//   apply.test.ts proves. This file pins the live-loop side of D-20: exactly
//   ONE commit entry, no apply-time deduction, no double refund.
//
// * UNITS (M6-K µc unification, D-12): the pinned ledger magnitudes are
//   integer MICROcredits (reserve/commit/refund = whole credits × 1_000_000);
//   the SSE `credits` event, the run ROW and the apply response's
//   creditsCommitted stay whole credits (display units).
//
// * GUARD ORDER (test 5): a re-apply of an ALREADY-APPLIED run answers 409
//   RUN_ALREADY_APPLIED (lifecycle guard) BEFORE the §9.3 lineage checks
//   could answer VERSION_CONFLICT — one apply per run row (M5-D), re-running
//   the plan is the M5.5 "re-apply" path; the card explains, the gateway 409s.

import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { z } from "zod";

import {
  AGENT_COMMAND_IDS,
  CONTEXT_SELECTION_SCHEMA,
  EDIT_PLAN_SCHEMA,
  PROPOSED_BATCH_NOTE,
  type RunRecord,
  STUDIO_STREAM_EVENT_SCHEMA,
  type StudioStreamEvent,
  TOOL_LIST,
  WRITE_TOOL_IDS,
  isAgentCommand,
} from "@studio/contracts";

import { createRunnerForEnv, estimateRunCredits, reserveAmountFor } from "../src/runner.js";
import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  TEST_APP_ORIGIN,
  api,
  bootServer,
  envelope,
  testEnv,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible SSE server (scripted; M4-K harness pattern,
// duplicated per its precedent — gateway tests never import test files).
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

type ChatCompletionBody = {
  readonly model: string;
  readonly messages: Array<Record<string, unknown>>;
  readonly tools?: Array<{ readonly function: { readonly name: string } }>;
};

/** One scripted model response: the request body decides the SSE frames. */
type ScriptEntry = (body: ChatCompletionBody) => string[];

function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
function textDelta(content: string): string {
  return frame({ choices: [{ delta: { content } }] });
}
function toolCallStart(index: number, id: string, name: string): string {
  return frame({
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
        },
      },
    ],
  });
}
function toolCallArgs(index: number, args: string): string {
  return frame({
    choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }],
  });
}
function finishReason(reason: string): string {
  return frame({ choices: [{ delta: {}, finish_reason: reason }] });
}
function usageChunk(promptTokens: number, completionTokens: number): string {
  return frame({
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}
const DONE = "data: [DONE]\n\n";

/** The 13 curated tool ids on the provider wire (M5.1: 5 read + 8 write). */
const WIRE_TOOL_IDS = [
  ...TOOL_LIST.filter((tool) => tool.kind === "read").map((tool) => tool.id),
  ...WRITE_TOOL_IDS.map((id) => `studio.${id}`),
].sort();

class FakeOpenAIServer {
  private readonly queue: ScriptEntry[] = [];
  private server: Server | null = null;
  url = "";
  /** Every /v1/chat/completions request the runner made, in order. */
  readonly calls: Array<{ body: ChatCompletionBody; authorization: string }> = [];

  enqueue(...entries: ScriptEntry[]): void {
    this.queue.push(...entries);
  }

  reset(): void {
    this.queue.length = 0;
    this.calls.length = 0;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === null) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Swallow socket errors from aborted runs — the runner's fetch is torn
    // down whenever a run cancels mid-round; the fake server must not crash.
    response.on("error", () => undefined);
    request.on("error", () => undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
      if (response.destroyed) return;
    }
    let body: ChatCompletionBody = { model: "", messages: [] };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionBody;
    } catch {
      body = { model: "", messages: [] };
    }
    const authorization = String(request.headers.authorization ?? "");
    this.calls.push({ body, authorization });

    const next = this.queue.shift();
    if (next === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fake script exhausted" } }));
      return;
    }
    const frames = next(body);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    });
    for (const wireFrame of frames) {
      if (response.destroyed) return;
      response.write(encoder.encode(wireFrame));
      await new Promise<void>((resolveTick) => {
        setImmediate(resolveTick);
      });
    }
    response.end();
  }
}

// ---------------------------------------------------------------------------
// Scripted model rounds (the M5 flow: plan_edit → plan JSON → final answer)
// ---------------------------------------------------------------------------

/** Round 1: the model calls studio.plan_edit with a goal. */
function planEditRound(toolCallId: string, goal: string): ScriptEntry {
  return () => [
    toolCallStart(0, toolCallId, "studio.plan_edit"),
    toolCallArgs(0, JSON.stringify({ goal })),
    finishReason("tool_calls"),
    DONE,
  ];
}

/**
 * Round 2 (server-side structured output, NO tools on the request): the
 * model returns the strict-JSON EditPlan. The model LIES on purpose —
 * risk "high" + estimatedCredits 99 — the server recomputes both.
 */
function planJsonRound(plan: unknown): ScriptEntry {
  return () => [textDelta(JSON.stringify(plan)), usageChunk(50, 12), finishReason("stop"), DONE];
}

/** A plain final text answer, no tool calls. */
function finalAnswerRound(text: string): ScriptEntry {
  return () => [textDelta(text), usageChunk(40, 8), finishReason("stop"), DONE];
}

/** Round 1 (write-tool propose path): one direct write-tool call. */
function writeToolRound(toolCallId: string, tool: string, args: unknown): ScriptEntry {
  return () => [
    toolCallStart(0, toolCallId, tool),
    toolCallArgs(0, JSON.stringify(args)),
    finishReason("tool_calls"),
    DONE,
  ];
}

// ---------------------------------------------------------------------------
// SSE wire reader (hand-rolled — gateway tests do not depend on api-client)
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
    if (body === null) throw new Error("chat response had no SSE body");
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
        if (raw.trim() === "") continue;
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

  /** Reads frames until predicate(event) is true (inclusive) and returns them. */
  async until(
    predicate: (event: StudioStreamEvent) => boolean,
    description: string,
    timeoutMs = 5000,
  ): Promise<WireFrame[]> {
    const frames: WireFrame[] = [];
    for (;;) {
      const wireFrame = await this.next(timeoutMs);
      if (wireFrame === null) {
        throw new Error(`SSE stream ended before ${description}`);
      }
      frames.push(wireFrame);
      if (predicate(wireFrame.event)) return frames;
    }
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
// Shared §7.4 wire-contract checks
// ---------------------------------------------------------------------------

const TERMINAL_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

type PlanEvent = Extract<StudioStreamEvent, { type: "plan" }>;
type ToolResultEvent = Extract<StudioStreamEvent, { type: "tool.result" }>;
type CreditsEvent = Extract<StudioStreamEvent, { type: "credits" }>;

function findPlan(events: readonly StudioStreamEvent[]): PlanEvent {
  const plan = events.find((event): event is PlanEvent => event.type === "plan");
  if (plan === undefined) throw new Error("no plan event on the wire");
  return plan;
}

function findCredits(events: readonly StudioStreamEvent[]): CreditsEvent {
  const credits = events.find((event): event is CreditsEvent => event.type === "credits");
  if (credits === undefined) throw new Error("no credits event on the wire");
  return credits;
}

function findToolResult(events: readonly StudioStreamEvent[]): ToolResultEvent {
  const result = events.find((event): event is ToolResultEvent => event.type === "tool.result");
  if (result === undefined) throw new Error("no tool.result event on the wire");
  return result;
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

const fake = new FakeOpenAIServer();

let server: RunningTestServer;

beforeAll(async () => {
  await fake.start();
  const envSource = {
    MOCK_MODEL: "false",
    LITELLM_BASE_URL: fake.url,
    LITELLM_API_KEY: "sk-test-litellm-fake",
    CHAT_MAX_STEPS: "6",
  };
  const env = testEnv(envSource);
  // Production wiring (src/index.ts): the runner is selected FROM the parsed
  // env — MOCK_MODEL=false ⇒ the real LiteLLM runner against env.litellm.*.
  server = await bootServer({ env: envSource, runner: createRunnerForEnv(env) });
}, 30_000);

afterAll(async () => {
  await server?.close();
  await fake.stop();
});

afterEach(() => {
  fake.reset();
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
 * server recomputes both from the compiled commands (never the model's).
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

// Fixture sanity: the scripted plan parses against the §8.6 schema the
// runner validates with — corpus self-check, fails loudly on fixture drift.
EDIT_PLAN_SCHEMA.parse(PLAN);

/** sha256 of the exact engine payload (mirrors M5-F batchSha256Hex(engineBatchPayload)). */
function shaOfCompiledBatch(batch: { label: string; steps: unknown[] }): string {
  const payload = { label: batch.label, atomic: true, steps: batch.steps };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function anySha(): string {
  return createHash("sha256")
    .update(`batch-${unique("sha")}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Chat driving + apply/undo calls
// ---------------------------------------------------------------------------

interface ChatBody {
  readonly message: string;
  readonly context: z.input<typeof CONTEXT_SELECTION_SCHEMA>;
  readonly idempotencyKey: string;
  readonly pinned: unknown[];
}

/** Raw chat POST (the api() helper has no SSE/body-stream seam). */
async function chatStream(fx: Fixture, body: ChatBody): Promise<Response> {
  return fetch(`${server.base}/v1/threads/${fx.threadId}/chat`, {
    method: "POST",
    headers: {
      origin: TEST_APP_ORIGIN,
      "content-type": "application/json",
      accept: "text/event-stream",
      cookie: fx.jar.header,
      "x-workspace-id": fx.workspaceId,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
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

const PLAN_MESSAGE = "Add the two text layers we discussed";

/**
 * Drives ONE full planning run through the real chat route: the model calls
 * studio.plan_edit (round 1), the server-side structured-output round returns
 * the plan (round 2), the compiler enriches the plan event, the model wraps
 * up (round 3). Returns the parsed stream + the plan event.
 */
async function planRun(
  fx: Fixture,
  message = PLAN_MESSAGE,
): Promise<{ runId: string; events: StudioStreamEvent[]; plan: PlanEvent }> {
  fake.enqueue(
    planEditRound("call_apply_flow_plan", message),
    planJsonRound(PLAN),
    finalAnswerRound("Planned — apply it from the card whenever you're ready."),
  );
  const response = await chatStream(fx, {
    message,
    context: {},
    idempotencyKey: unique("chat"),
    pinned: [],
  });
  expect(response.status).toBe(200);
  const stream = new SseStream(response);
  const frames = await stream.rest();
  const events = expectValidStream(frames);
  expect(typeSeq(events)).toEqual([
    "run.started",
    "tool.started",
    "plan",
    "tool.result",
    "message.delta",
    "credits",
    "run.completed",
  ]);
  const runId = events[0]?.runId;
  if (runId === undefined) throw new Error("no run.started event");
  await waitFor(
    "the run row to complete",
    async () => (await getRun(fx, runId)).status === "completed",
  );
  return { runId, events, plan: findPlan(events) };
}

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
  plan: PlanEvent,
  transportKey: string,
): Promise<{ result: CallResult; versionId: string; batchSha256: string }> {
  const batch = plan.compiledBatch;
  if (batch === undefined) throw new Error("the plan event carried no compiledBatch");
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
  it("1. happy apply loop: plan_edit compiles server-side → apply → ONE version, ONE commit, run row applied (D-20: no double deduction)", async () => {
    const fx = await newFixture("happy");
    const expectedReserve = reserveAmountFor(
      estimateRunCredits({
        message: PLAN_MESSAGE,
        context: CONTEXT_SELECTION_SCHEMA.parse({}),
        pinned: [],
      }),
    );
    const { runId, events, plan } = await planRun(fx);

    // The plan event: server-compiled batch + resolution requests for the
    // two DECLARED layer names, server-recomputed risk + credits (the model
    // claimed 99 credits — overridden; it declared risk "high" — G-4: the
    // declared risk is a FLOOR, so the wire carries high, never lower).
    expect(plan.plan.summary).toBe(PLAN_SUMMARY);
    expect(plan.risk).toBe("high");
    // (1 + 2×0.5) × 1.5 — estimateCredits for the FLOORED risk, 2 plan steps.
    expect(plan.estimatedCredits).toBe(3);
    expect(plan.compiledBatch).toMatchObject({
      label: `Agent: ${PLAN_SUMMARY}`,
      atomic: true,
      steps: [...COMPILED_STEPS],
    });
    expect(plan.resolutionRequests).toEqual([
      { requestId: "lr-1", layerName: "Headline", disambiguation: ["Add a headline text layer"] },
      {
        requestId: "lr-2",
        layerName: "Sub",
        disambiguation: ["Add a subheading text layer"],
      },
    ]);

    // The chat loop settled usage per D-20 at run.completed: reserve −N,
    // commit −M, refund +N — the run's hold is already released.
    const credits = findCredits(events);
    expect(credits).toMatchObject({ reserved: expectedReserve, committed: 1 });

    // The client gesture: version upload (agentRunId) + apply.
    const { result, versionId, batchSha256 } = await applyPlan(fx, runId, plan, unique("apply"));
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({
      applied: true,
      versionId,
      creditsCommitted: 0, // PIN (file header): the stream finalize already
      // settled the run's whole hold per D-20, so the apply's planSettlement
      // sees outstanding 0 — the apply NEVER double-deducts. The run nets
      // exactly its single usage commit (−1 below).
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

    // Ledger (µc, D-12): exactly ONE commit entry — the chat finalize's usage
    // commit; the apply added no entries (outstanding was 0) and no second
    // deduction exists. The run nets −1 credit = its single commit.
    const ledger = await runLedger(fx.workspaceId, runId);
    const byKind: Record<string, number[]> = {};
    for (const entry of ledger) {
      byKind[entry.kind] = [...(byKind[entry.kind] ?? []), entry.amount];
    }
    expect(byKind.reserve).toEqual([-expectedReserve * 1_000_000]);
    expect(byKind.commit).toEqual([-1 * 1_000_000]);
    expect(byKind.refund).toEqual([expectedReserve * 1_000_000]);
    expect(ledger.filter((entry) => entry.idempotencyKey.includes("apply:"))).toHaveLength(0);
    expect(await balanceOf(fx.workspaceId)).toBe((100 - 1) * 1_000_000);

    // Exactly ONE version created for the run (§8.7: ONE batch = ONE version).
    const versions = await versionsOf(fx.workspaceId, fx.projectId, runId);
    expect(versions.byRun).toBe(1);
    expect(versions.total).toBe(2); // the base snapshot + the applied version

    // agent_steps single-writer pin (M4 tail #2): the server-resolved
    // studio.plan_edit call is exactly TWO rows (args + result).
    const steps = (await server.deps.repos.runs.get(fx.workspaceId, runId)).steps;
    expect(steps.length).toBe(2);
    expect(steps.every((step) => step.tool === "studio.plan_edit")).toBe(true);
    expect(steps.map((step) => step.seq)).toEqual([1, 3]);
  });

  it("2. apply idempotency: the SAME idempotency key replays the identical 200 — no second version, no second commit", async () => {
    const fx = await newFixture("idem");
    const { runId, plan } = await planRun(fx);
    const key = unique("apply");
    const first = await applyPlan(fx, runId, plan, key);
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

    // No second version, no second commit, no balance movement.
    expect(await runLedger(fx.workspaceId, runId)).toEqual(ledgerAfterFirst);
    const versions = await versionsOf(fx.workspaceId, fx.projectId, runId);
    expect(versions.byRun).toBe(1);
    expect(versions.total).toBe(versionsAfterFirst.total);
    expect(await balanceOf(fx.workspaceId)).toBe(99 * 1_000_000);
  });

  it("3. double-apply without idempotency (fresh keys, a new sha) → 409 RUN_ALREADY_APPLIED, state untouched", async () => {
    const fx = await newFixture("double");
    const { runId, plan } = await planRun(fx);
    const first = await applyPlan(fx, runId, plan, unique("apply"));
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
    const { runId, plan } = await planRun(fx);
    const batch = plan.compiledBatch;
    if (batch === undefined) throw new Error("no compiledBatch");

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
        batchSha256: shaOfCompiledBatch(batch),
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
    const { runId, plan } = await planRun(fx);
    const first = await applyPlan(fx, runId, plan, unique("apply"));
    expect(first.result.status).toBe(200);

    // The project moves on (a plain user autosave — a NEW head).
    const drifted = await uploadVersion(fx.jar, fx.workspaceId, fx.projectId, {
      baseVersionId: first.versionId,
    });

    // "Re-apply" the applied run against the drifted head: BP M5.5 blocks
    // it, and the route answers with the lifecycle 409 — the §9.3 lineage
    // checks never run for an already-applied run (one apply per run row).
    const batch = plan.compiledBatch;
    if (batch === undefined) throw new Error("no compiledBatch");
    const key = unique("apply");
    const retry = await applyCall(
      fx,
      runId,
      {
        batchSha256: shaOfCompiledBatch(batch),
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
    const { runId, plan } = await planRun(fx);
    const applied = await applyPlan(fx, runId, plan, unique("apply"));
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
    const { runId, plan } = await planRun(fx);

    const earlyKey = unique("undo");
    const early = await undoCall(fx, runId, earlyKey);
    expect(early.status).toBe(409);
    expect(errOf(early)).toMatchObject({ code: "RUN_NOT_APPLIED", retryable: false });
    expect(await planStatus(fx.workspaceId, runId)).toBe("proposed");

    // Apply, then undo once; capture the recorded undoneAt.
    const applied = await applyPlan(fx, runId, plan, unique("apply"));
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
    const { runId, plan } = await planRun(fx);
    const intruder = await newWorkspace("tenant-b");
    await grantCredits(intruder.id, 100);
    const batch = plan.compiledBatch;
    if (batch === undefined) throw new Error("no compiledBatch");

    const intrusionApply = await api(server.base, `/v1/runs/${runId}/apply`, {
      method: "POST",
      jar: intruder.jar,
      headers: { "x-workspace-id": intruder.id, "idempotency-key": unique("apply") },
      body: {
        batchSha256: shaOfCompiledBatch(batch),
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
    const { runId, plan } = await planRun(fx);
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
    expect(plan.compiledBatch).toBeDefined();
  });

  it("10. insufficient credits at apply → 402 INSUFFICIENT_CREDITS BEFORE any state change; a retry after a top-up succeeds", async () => {
    const fx = await newFixture("broke", 5);
    const { runId, plan } = await planRun(fx); // reserve −2 credits, chat settle → balance 4 credits
    expect(await balanceOf(fx.workspaceId)).toBe(4 * 1_000_000);

    // The client uploads its post-batch version first (that is the D-6 flow)
    // — uploads cost nothing; then the wallet is drained to zero.
    const batch = plan.compiledBatch;
    if (batch === undefined) throw new Error("no compiledBatch");
    const { versionId } = await uploadVersion(fx.jar, fx.workspaceId, fx.projectId, {
      baseVersionId: fx.baseVersionId,
      agentRunId: runId,
    });
    await server.deps.repos.ledger.adjust(fx.workspaceId, {
      amount: -4 * 1_000_000,
      idempotencyKey: unique("drain"),
    });
    expect(await balanceOf(fx.workspaceId)).toBe(0);
    const ledgerBefore = await runLedger(fx.workspaceId, runId);

    const brokeKey = unique("apply");
    const broke = await applyCall(
      fx,
      runId,
      { batchSha256: shaOfCompiledBatch(batch), versionId, idempotencyKey: brokeKey },
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
      { batchSha256: shaOfCompiledBatch(batch), versionId, idempotencyKey: retryKey },
      retryKey,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.data).toMatchObject({ applied: true, versionId });
    expect(await planStatus(fx.workspaceId, runId)).toBe("applied");
  });

  it("11. safety pin: the compiled batch is registry-allowlisted, atomic, 'Agent: <summary>'; the provider wire carries exactly 13 tools; the plan round is tools-free; the model never sees the compiled output", async () => {
    const fx = await newFixture("safety");
    const { events, plan } = await planRun(fx);

    // compiledBatch: ONLY registry-allowlisted command ids (asserted against
    // BOTH the exported allowlist and the predicate), atomic, prefixed label.
    const batch = plan.compiledBatch;
    if (batch === undefined) throw new Error("no compiledBatch");
    expect(batch.atomic).toBe(true);
    expect(batch.label).toBe(`Agent: ${PLAN_SUMMARY}`);
    expect(batch.steps.length).toBe(2);
    for (const step of batch.steps) {
      expect((AGENT_COMMAND_IDS as readonly string[]).includes(step.command)).toBe(true);
      expect(isAgentCommand(step.command)).toBe(true);
    }
    expect(plan.compiledBatch?.steps).toEqual([...COMPILED_STEPS]);

    // The provider wire: exactly the 13 curated ids — the 5 read tools plus
    // the 8 PROPOSE-ONLY write tools, nothing else (no raw engine ids ever
    // register as callable functions).
    expect(fake.calls.length).toBe(3); // plan_edit round + plan round + final answer
    expect(fake.calls[0]?.authorization).toBe("Bearer sk-test-litellm-fake");
    const toolNames = (fake.calls[0]?.body.tools ?? []).map((tool) => tool.function.name).sort();
    expect(toolNames).toEqual(WIRE_TOOL_IDS);
    expect(WIRE_TOOL_IDS).toHaveLength(13);

    // The server-side plan round is a TOOLS-FREE structured-output call.
    expect(fake.calls[1]?.body.tools).toBeUndefined();

    // Law #5 at the plan seam: the model-facing tool result is the BARE plan
    // — the compiled batch, resolution requests and recomputed risk/credits
    // never enter the model conversation (they ride the plan EVENT only).
    const finalRound = fake.calls[2]?.body.messages ?? [];
    const toolMessages = finalRound.filter((message) => message.role === "tool");
    const rawFeedback = String(toolMessages.at(-1)?.content ?? "");
    expect(JSON.parse(rawFeedback)).toEqual(PLAN);
    expect(rawFeedback).not.toContain("compiledBatch");
    expect(rawFeedback).not.toContain("resolutionRequests");

    // The server-resolved plan call produced exactly ONE tool.result event.
    expect(events.filter((event) => event.type === "tool.result")).toHaveLength(1);
  });

  it("12. write-tool propose path on the live wire: create_text + set_properties → proposedBatch envelopes + redacted model feedback (F-5 fixed: both compile)", async () => {
    const fx = await newFixture("propose");
    fake.enqueue(
      writeToolRound("call_propose_1", "studio.create_text", { text: "Hello", name: "Headline" }),
      finalAnswerRound("Proposed the text layer — apply it from the card."),
    );
    const response = await chatStream(fx, {
      message: "add a headline",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    const stream = new SseStream(response);
    const events = expectValidStream(await stream.rest());
    expect(typeSeq(events)).toEqual([
      "run.started",
      "tool.started",
      "tool.result",
      "message.delta",
      "credits",
      "run.completed",
    ]);
    // The propose-only path emits NO plan event (write tools are proposals,
    // not plans — the run row carries no planJson).
    expect(events.filter((event) => event.type === "plan")).toHaveLength(0);

    // The tool result is the pinned WRITE_TOOL_RESULT_SCHEMA envelope: ONLY
    // the proposed batch + the canonical proposed-only note (§8.4 rule 3).
    const proposed = findToolResult(events);
    expect(proposed.result).toEqual({
      proposedBatch: {
        label: 'Agent: Add text layer "Headline"',
        steps: [{ command: "layer.newText", params: { text: "Hello", name: "Headline" } }],
      },
      note: PROPOSED_BATCH_NOTE,
    });

    // Law #5: the model is fed the REDACTED envelope — summary + step count
    // + note ONLY; the compiled registry command id never enters its context.
    const feedback = (fake.calls[1]?.body.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    const rawFeedback = String(feedback.at(-1)?.content);
    expect(rawFeedback).not.toContain("layer.newText");
    expect(JSON.parse(rawFeedback)).toEqual({
      proposed: true,
      summary: 'Add text layer "Headline"',
      note: PROPOSED_BATCH_NOTE,
      stepCount: 1,
    });

    // The F-5 FIX at the live wire (M5-S flip): the REAL contracts schema for
    // set_properties speaks {layers: [{name}], properties: [{path, value}]}
    // and the FIXED compiler translates exactly that — the call now PROPOSES
    // the cross-product batch (2 layers × 1 property ⇒ 2 prop.set commands)
    // instead of answering PROPOSAL_INVALID. The run SURVIVES either way.
    const fx2 = await newFixture("drift");
    fake.enqueue(
      writeToolRound("call_drift_1", "studio.set_properties", {
        layers: [{ name: "Headline" }, { name: "Sub" }],
        properties: [{ path: "transform/opacity", value: 40 }],
      }),
      finalAnswerRound("Proposed the opacity change — apply it from the card."),
    );
    const driftResponse = await chatStream(fx2, {
      message: "dim the two layers",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    const driftStream = new SseStream(driftResponse);
    const driftEvents = expectValidStream(await driftStream.rest());
    expect(typeSeq(driftEvents)).toEqual([
      "run.started",
      "tool.started",
      "tool.result",
      "message.delta",
      "credits",
      "run.completed",
    ]);
    // Still NO plan event for a write-tool proposal (proposals, not plans).
    expect(driftEvents.filter((event) => event.type === "plan")).toHaveLength(0);
    expect(findToolResult(driftEvents).result).toEqual({
      proposedBatch: {
        label: "Agent: Set 1 property on 2 layers",
        steps: [
          {
            command: "prop.set",
            params: { layer: "Headline", path: "transform/opacity", value: 40 },
          },
          {
            command: "prop.set",
            params: { layer: "Sub", path: "transform/opacity", value: 40 },
          },
        ],
      },
      note: PROPOSED_BATCH_NOTE,
    });
    // Law #5 again, second arm: the model is fed the REDACTED envelope — the
    // compiled registry command ids never enter its context.
    const driftFeedback = (fake.calls[3]?.body.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    const rawDriftFeedback = String(driftFeedback.at(-1)?.content);
    expect(rawDriftFeedback).not.toContain("prop.set");
    expect(JSON.parse(rawDriftFeedback)).toEqual({
      proposed: true,
      summary: "Set 1 property on 2 layers",
      note: PROPOSED_BATCH_NOTE,
      stepCount: 2,
    });
  });
});
