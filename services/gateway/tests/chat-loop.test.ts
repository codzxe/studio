// M4-K — the gateway FULL-ROUTE agent-loop E2E, RE-POINTED to the ROUND-12
// client-driven TURN wire (BUILD_PLAN §M4 task 7 + exit criteria;
// PRODUCT_ARCHITECTURE §7.4/§8.8/§8.9). Real buildApp over real Postgres,
// the REAL turn engine (MOCK_MODEL=false, LITELLM_BASE_URL = the in-process
// fake OpenAI-compatible SSE server on an ephemeral localhost port —
// sanctioned: not a dev server), the real SSE wire per turn, and the client
// driving the loop: POST /v1/threads/:id/turn (Idempotency-Key
// `${runId}:${stepIndex}`) once per step, the tool round-trip riding the
// NEXT turn's transcript, POST /v1/runs/:id/plan {end:true} as the
// proposal-less stop, POST /v1/runs/:id/abandon as the give-up gesture.
//
// Scenarios: the happy loop with the client tool round-trip (+§7.4 frame
// contract), the durable idempotency replay, the mid-turn client abort, the
// abandon stop + full refund, model entitlements (403), zero credits (402),
// an invalid tool call resolving fail-closed, the §7.4 SSE frame contract,
// cross-tenant 404. All deterministic — no real network beyond the loopback
// fake server.
//
// ROUND-12 DELETIONS (the subject no longer exists server-side; one-line
// reasons, worklog Task ID 12-w7-r1):
//   * old test 3a (Last-Event-ID reconnect + a tool result landing
//     mid-reconnect) — the SSE replay/wait seam (the in-memory RunLog
//     registry, Last-Event-ID cursors, POST /v1/runs/:id/events) is DELETED
//     with the server loop; the turn wire is stateless per turn, and the
//     durable same-key replay (test 2) is its reconnect story.
//   * the old test 1/2 §7.4 "only the expected toolCallId may report a
//     result" 400 pin — that guard lived on the deleted events route; the
//     round-12 tool round-trip echoes results in the next turn's BODY.
//   * the run.cancelled-on-the-wire arm of old test 4 — nothing server-side
//     emits run.* terminals anymore; the stop gesture is the ABANDON route
//     (flat JSON), pinned below.
//   * the §8.9 server-side repair-turn protocol (unknown tool twice →
//     run.failed RUN_INVALID_TOOL) — re-pointed to the round-12 truth: the
//     turn resolves the bad call fail-closed into resultForModel, the client
//     mediates the "repair" by echoing the error with its next turn.
//   * the old test 5 "tool timeout" scenario had already been folded away
//     (TOOL_RESULT_TIMEOUT_MS pinned at the seam, M4-A); nothing remained.
//
// UNITS (M6-K µc unification, D-12): the ledger rows this file pins are
// integer MICROcredits — every turn-path hold/commit/refund magnitude is the
// whole-credit number × 1_000_000 (fixture grants included); the turn wire's
// turn.completed `credits` and the run ROW stay whole credits (display
// units). The per-turn reserve is prompt-size-derived (§8.8), so the ledger
// pins here are the per-run fingerprint: one commit row per turn (−1_000_000
// each), one hold per turn, and — CURRENT-TRUTH (12-w7-r1 BUG-1, pinned the
// same way in tests/apply-flow.test.ts test 1) — Σrefund = Σreserve − C₀ on
// a multi-turn run: the ledger hold is RUN-scoped while routes/turn.ts
// reserves + settles PER TURN, so the first turn's settle refunds the full
// outstanding hold and the second turn's settle strands the first turn's
// commit (the workspace overcharges by C₀ per two-turn run). A product fix
// (turn-scoped holds) flips those pins loudly.

import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type RunRecord,
  STUDIO_STREAM_EVENT_SCHEMA,
  type StudioStreamEvent,
  TOOL_LIST,
  type TurnMessage,
  WRITE_TOOL_IDS,
} from "@studio/contracts";
import type { AgentRun } from "@studio/db";

import { wireToolName } from "../src/litellm/openai.js";
import { createRunnerForEnv } from "../src/runner.js";
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
// Fake OpenAI-compatible SSE server (scripted; same wire shapes as M4-A's
// litellm tests, but a REAL localhost HTTP server because createRunnerForEnv
// wires the production fetch — no injectable seam at the route level).
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

/** The 13 curated tools on the provider wire (M5.1: 5 read + 8 write).
 * Registry ids carry dots; the wire grammar ^[a-zA-Z0-9_-]{1,64}$ forbids
 * them, so registrations are sanitized (openai.ts toolSeam). */
const WIRE_TOOL_IDS = [
  ...TOOL_LIST.filter((tool) => tool.kind === "read").map((tool) => wireToolName(tool.id)),
  ...WRITE_TOOL_IDS.map((id) => wireToolName(`studio.${id}`)),
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

/** Script: one get_context tool call round (aggregated fragments + finish). */
function getContextRound(toolCallId: string): ScriptEntry {
  return () => [
    toolCallStart(0, toolCallId, "studio.get_context"),
    toolCallArgs(0, JSON.stringify({ include: ["activeComp"] })),
    // usageChunk(40, 8) — the same deterministic usage as textRound, so the
    // §8.8 commit for this turn is the pinned 1 credit.
    usageChunk(40, 8),
    finishReason("tool_calls"),
    DONE,
  ];
}

/** Script: final text round whose answer depends on the client's tool result. */
function answerFromToolResult(): ScriptEntry {
  return (body) => {
    let compName = "Unknown";
    for (const message of body.messages) {
      if (
        message.role === "tool" &&
        typeof message.content === "string" &&
        message.content.includes("activeComp")
      ) {
        try {
          const parsed = JSON.parse(message.content) as { activeComp?: { name?: string } };
          if (typeof parsed.activeComp?.name === "string") compName = parsed.activeComp.name;
        } catch {
          // not JSON — keep Unknown
        }
      }
    }
    return [
      textDelta("The comp "),
      textDelta(`${compName} has 1 layer.`),
      usageChunk(50, 12),
      finishReason("stop"),
      DONE,
    ];
  };
}

/** Script: an unknown tool name (never in the registry — §8.9 repair path). */
function unknownToolRound(toolCallId: string, name: string): ScriptEntry {
  return () => [
    toolCallStart(0, toolCallId, name),
    toolCallArgs(0, "{}"),
    finishReason("tool_calls"),
    DONE,
  ];
}

/** Script: a plain text answer, no tools. */
function textRound(text: string): ScriptEntry {
  return () => [textDelta(text), usageChunk(40, 8), finishReason("stop"), DONE];
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

// The turn wire's terminals (§7.4): one turn.completed | turn.failed per
// stream; the run.* terminals left with the deleted server loop.
const TERMINAL_TYPES = new Set(["turn.completed", "turn.failed"]);

type TurnCompletedEvent = Extract<StudioStreamEvent, { type: "turn.completed" }>;
type DeltaEvent = Extract<StudioStreamEvent, { type: "message.delta" }>;

function completedOf(events: readonly StudioStreamEvent[]): TurnCompletedEvent {
  const terminal = events.find(
    (event): event is TurnCompletedEvent => event.type === "turn.completed",
  );
  if (terminal === undefined) throw new Error("no turn.completed event on the wire");
  return terminal;
}

function failedOf(
  events: readonly StudioStreamEvent[],
): Extract<StudioStreamEvent, { type: "turn.failed" }> {
  const terminal = events.find(
    (event): event is Extract<StudioStreamEvent, { type: "turn.failed" }> =>
      event.type === "turn.failed",
  );
  if (terminal === undefined) throw new Error("no turn.failed event on the wire");
  return terminal;
}

function joinedText(events: readonly StudioStreamEvent[]): string {
  return events
    .filter((event): event is DeltaEvent => event.type === "message.delta")
    .map((event) => event.delta)
    .join("");
}

/**
 * §7.4 wire contract over a collected frame list: exact `id:`/`data:` frame
 * format, contiguous monotonic seq from `firstSeq`, schema-valid events, one
 * runId, and (optionally) exactly one terminal event as the last frame.
 */
function expectValidStream(
  frames: readonly WireFrame[],
  options: { readonly requireTerminal?: boolean; readonly firstSeq?: number } = {},
): StudioStreamEvent[] {
  const requireTerminal = options.requireTerminal ?? true;
  const firstSeq = options.firstSeq ?? 0;
  expect(frames.length).toBeGreaterThan(0);
  let previousSeq: number | null = null;
  const events: StudioStreamEvent[] = [];
  let terminals = 0;
  for (const wireFrame of frames) {
    // Exact wire format: `id: <seq>\ndata: <json>` — byte-identical modulo
    // JSON key order, which JSON.parse/stringify round-trips losslessly here.
    expect(wireFrame.raw).toBe(
      `id: ${wireFrame.event.seq}\ndata: ${JSON.stringify(wireFrame.event)}`,
    );
    expect(wireFrame.id).toBe(wireFrame.event.seq);
    if (previousSeq === null) expect(wireFrame.event.seq).toBe(firstSeq);
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
  if (firstSeq === 0) expect(events[0]?.type).toBe("run.started");
  if (requireTerminal) {
    expect(terminals).toBe(1);
    const last = frames.at(-1)?.event;
    if (last === undefined || !TERMINAL_TYPES.has(last.type)) {
      throw new Error("the last frame on the wire must be the terminal event");
    }
  } else {
    expect(terminals).toBe(0);
  }
  // One run per stream: every event carries the same runId.
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
  readonly versionId: string;
  readonly threadId: string;
}

async function newWorkspace(prefix: string): Promise<{ jar: CookieJar; id: string }> {
  const jar = new CookieJar();
  const signup = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail(prefix), password: "Passw0rd!longenough", name: "Loop Tester" },
  });
  expect(signup.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Chat Loop WS"), slug: unique("chat-loop") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { jar, id: ws.data.id };
}

/** 1 credit = 1_000_000 µc (D-12) — the ledger-row multiplier in this file. */
const MICRO = 1_000_000;

async function grantCredits(workspaceId: string, credits: number): Promise<void> {
  await server.deps.repos.ledger.grant(workspaceId, {
    amount: credits * MICRO,
    idempotencyKey: unique("grant"),
  });
}

async function balanceOf(workspaceId: string): Promise<number> {
  return server.deps.repos.ledger.balance(workspaceId);
}

async function runsOfThread(workspaceId: string, threadId: string): Promise<readonly AgentRun[]> {
  const page = await server.deps.repos.runs.listByThread(workspaceId, threadId, {});
  return page.items;
}

/** Fresh workspace + credits + project + one version + one thread. */
async function newFixture(prefix: string, credits = 100): Promise<Fixture> {
  const ws = await newWorkspace(prefix);
  await grantCredits(ws.id, credits);
  const projectResponse = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Loop Project") },
  });
  expect(projectResponse.status).toBe(201);
  const project = (await projectResponse.json()) as { data: { id: string } };
  const bytes = Buffer.from(`{"fixture":"${unique("proj")}"}`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const versionResponse = await api(
    server.base,
    `/v1/projects/${project.data.id}/versions?sha256=${sha256}&sizeBytes=${bytes.byteLength}`,
    {
      method: "POST",
      jar: ws.jar,
      headers: {
        "x-workspace-id": ws.id,
        "idempotency-key": unique("ver"),
        "content-type": "application/octet-stream",
      },
      rawBody: new Uint8Array(bytes),
    },
  );
  expect(versionResponse.status).toBe(201);
  const version = (await versionResponse.json()) as { data: { id: string } };
  const threadResponse = await api(server.base, `/v1/projects/${project.data.id}/threads`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("thr") },
    body: { title: "Chat loop thread" },
  });
  expect(threadResponse.status).toBe(201);
  const thread = (await threadResponse.json()) as { data: { id: string } };
  return {
    jar: ws.jar,
    workspaceId: ws.id,
    projectId: project.data.id,
    versionId: version.data.id,
    threadId: thread.data.id,
  };
}

interface TurnCall {
  readonly runId: string;
  readonly stepIndex: number;
  readonly messages: readonly TurnMessage[];
  readonly model?: "studio-fast" | "studio-smart" | "studio-vision";
  readonly signal?: AbortSignal;
}

/** Raw turn POST (the api() helper has no abort/signal seam). */
async function turnStream(fx: Fixture, input: TurnCall): Promise<Response> {
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
      ...(input.model === undefined ? {} : { model: input.model }),
    }),
    signal: input.signal,
    redirect: "manual",
  });
}

/** The client's proposal-less stop gesture: the {end:true} end marker. */
async function postPlanEnd(
  fx: Fixture,
  runId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api(server.base, `/v1/runs/${runId}/plan`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("end") },
    body: { end: true },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The client's give-up gesture (tab closed, loop aborted). */
async function postAbandon(
  fx: Fixture,
  runId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api(server.base, `/v1/runs/${runId}/abandon`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("abandon") },
    body: {},
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getRun(fx: Fixture, runId: string): Promise<RunRecord> {
  const response = await api(server.base, `/v1/runs/${runId}`, {
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId },
  });
  const parsed = (await response.json()) as { data: RunRecord };
  return parsed.data;
}

async function listMessages(
  fx: Fixture,
): Promise<Array<{ role: string; content: Record<string, unknown>; runId: string | null }>> {
  const response = await api(server.base, `/v1/threads/${fx.threadId}/messages`, {
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId },
  });
  const parsed = (await response.json()) as {
    data: {
      items: Array<{ role: string; content: Record<string, unknown>; runId: string | null }>;
    };
  };
  return parsed.data.items;
}

/** Poll until probe() is true (the route emits run.completed BEFORE its DB writes). */
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

function typeSeq(events: readonly StudioStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

d("M4-K gateway agent-loop E2E — the real turn engine over the real SSE wire", () => {
  it("1. happy loop: client tool round-trip drives the answer; ledger settles; run + steps + messages persist", async () => {
    const fx = await newFixture("happy");
    const runId = unique("run");
    const message = "what's on this comp?";

    // STEP 0 — the turn engine streams the model's get_context call to the
    // client (§8.4: read/generative tools return for LOCAL execution).
    fake.enqueue(getContextRound("call_e2e_happy_1"), answerFromToolResult());
    const step0Response = await turnStream(fx, {
      runId,
      stepIndex: 0,
      messages: [{ role: "user", text: message }],
    });
    expect(step0Response.status).toBe(200);
    expect(step0Response.headers.get("content-type")).toContain("text/event-stream");
    expect(step0Response.headers.get("cache-control")).toBe("no-store");
    const step0Events = expectValidStream(await new SseStream(step0Response).rest());
    expect(typeSeq(step0Events)).toEqual([
      "run.started",
      "turn.started",
      "tool.started",
      "turn.completed",
    ]);
    expect(step0Events[0]).toMatchObject({ type: "run.started", model: "studio-fast" });
    expect(step0Events[2]).toMatchObject({
      type: "tool.started",
      toolCallId: "call_e2e_happy_1",
      name: "studio.get_context",
      args: { include: ["activeComp"] },
    });
    const step0 = completedOf(step0Events);
    expect(step0.finishReason).toBe("tool-calls");
    expect(step0.credits).toEqual({ committed: 1 }); // usageChunk(40, 8) → 1 credit
    const proposed = step0.toolCalls[0];
    expect(proposed).toMatchObject({
      toolCallId: "call_e2e_happy_1",
      tool: "studio.get_context",
      args: { include: ["activeComp"] },
    });
    expect(proposed?.resultForModel).toMatchObject({
      note: "Execute this tool locally and report the result with the next turn.",
    });

    // STEP 1 — the "client" (bridge executor stand-in) executes the tool
    // LOCALLY and reports the result with the next turn's transcript — the
    // round-12 tool round-trip.
    const step1Response = await turnStream(fx, {
      runId,
      stepIndex: 1,
      messages: [
        { role: "user", text: message },
        { role: "assistant", text: "" },
        {
          role: "tool_call",
          toolCallId: "call_e2e_happy_1",
          tool: "studio.get_context",
          args: { include: ["activeComp"] },
        },
        {
          role: "tool_result",
          toolCallId: "call_e2e_happy_1",
          tool: "studio.get_context",
          result: { activeComp: { name: "Main" } },
        },
      ],
    });
    expect(step1Response.status).toBe(200);
    const step1Events = expectValidStream(await new SseStream(step1Response).rest());
    expect(typeSeq(step1Events)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "message.delta",
      "turn.completed",
    ]);
    // The answer names the comp from the CLIENT's tool result — proving the
    // echoed tool_result reached the model conversation.
    expect(joinedText(step1Events)).toBe("The comp Main has 1 layer.");
    const step1 = completedOf(step1Events);
    expect(step1.finishReason).toBe("stop");
    expect(step1.credits).toEqual({ committed: 1 });

    // The turn engine registers exactly the curated v3 tool catalog on the
    // provider wire (M5.1's 13-tool catalog grew with the read/generative
    // tools — the 21-tool sanitized set tests/golden-prompts pins), one
    // model call per turn, the sanitized names + Bearer key.
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0]?.authorization).toBe("Bearer sk-test-litellm-fake");
    const toolNames = (fake.calls[0]?.body.tools ?? []).map((tool) => tool.function.name).sort();
    expect(toolNames).toEqual(WIRE_TOOL_IDS);
    expect(WIRE_TOOL_IDS).toHaveLength(21);

    // §8.8 ledger (µc, D-12): one HOLD per turn (prompt-derived whole-credit
    // multiples) and one −1_000_000 commit per turn — the usage-based commit
    // is the ONLY authoritative charge. CURRENT-TRUTH fingerprint (12-w7-r1
    // BUG-1, header): the hold scope is the RUN while the route settles per
    // turn, so Σrefund = Σreserve − C₀ — the workspace overcharges by the
    // first turn's commit (2 commits + 1 stranded credit here).
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    const runEntries = ledger.items.filter((entry) => entry.runId === runId);
    const byKind: Record<string, number[]> = {};
    for (const entry of runEntries) {
      byKind[entry.kind] = [...(byKind[entry.kind] ?? []), entry.amount];
    }
    const reserves = byKind.reserve ?? [];
    expect(reserves).toHaveLength(2); // one hold per turn
    for (const amount of reserves) {
      expect(amount).toBeLessThanOrEqual(-1 * MICRO); // ≥ 1 credit, µc-honest
      expect(Math.abs(amount) % MICRO).toBe(0); // whole-credit multiple
    }
    expect(byKind.commit).toEqual([-1 * MICRO, -1 * MICRO]);
    const reserveSum = reserves.reduce((total, amount) => total - amount, 0);
    const refundSum = (byKind.refund ?? []).reduce((total, amount) => total + amount, 0);
    expect(refundSum).toBe(reserveSum); // 12-w7 BUG-1 FIXED: holds pair off exactly
    expect(await balanceOf(fx.workspaceId)).toBe(98 * MICRO); // exactly the 2 commits

    // The client ends the loop: no carriers were proposed, so the stop is
    // the {end:true} end marker — the run row lands completed.
    const end = await postPlanEnd(fx, runId);
    expect(end.status).toBe(200);
    await waitFor(
      "the run row to complete",
      async () => (await getRun(fx, runId)).status === "completed",
    );

    // Run row (whole credits per the D-12 row ruling; per-turn holds never
    // ride the row — reservedCredits stays 0).
    const record = await getRun(fx, runId);
    expect(record.model).toBe("studio-fast");
    expect(record.reservedCredits).toBe(0);
    expect(record.committedCredits).toBe(2); // one committed credit per turn
    expect(record.baseVersionId).toBe(fx.versionId);
    expect(record.errorCode).toBeNull();
    expect(record.completedAt).not.toBeNull();

    // Steps — ONE row per tool call: issued by the turn (step 0), completed
    // by the echoed tool_result (settleEchoedToolResults on step 1), the
    // client's result stored verbatim (the wire record maps the DB status to
    // the §7.2 vocabulary; the raw row keeps the payload).
    expect(record.steps.length).toBe(1);
    expect(record.steps[0]?.tool).toBe("studio.get_context");
    expect(record.steps[0]?.status).toBe("succeeded");
    const rawRun = await server.deps.repos.runs.get(fx.workspaceId, runId);
    expect(rawRun.steps[0]?.seq).toBe(0);
    expect(rawRun.steps[0]?.status).toBe("success");
    expect(rawRun.steps[0]?.resultJson).toEqual({ activeComp: { name: "Main" } });

    // Messages persisted (§9.1): the user turn, the tool-call turn's
    // assistant row (empty text), the TOOL row — the client execution's
    // transcript record: {args, result} together — and the closing answer.
    const messages = await listMessages(fx);
    expect(messages.length).toBe(4);
    const user = messages.find((row) => (row.content as { message?: string }).message === message);
    const assistants = messages.filter((row) => row.role === "assistant");
    // The tool row is identified by its content (the wire serializer flattens
    // every non-assistant/system role to "user" — routes/threads.ts:35 — so
    // role "tool" reads "user" here; content.kind carries the truth).
    const toolRow = messages.find((row) => (row.content as { kind?: string }).kind === "tool");
    if (user === undefined || assistants.length !== 2 || toolRow === undefined) {
      throw new Error("missing message rows");
    }
    expect(toolRow.role).toBe("user"); // the flattened wire vocabulary (obs, worklog)
    expect(user.content).toMatchObject({ message });
    expect(assistants.every((row) => row.runId === runId)).toBe(true);
    // listMessages is newest-first: order by the persisted stepIndex.
    const ordered = [...assistants].sort(
      (a, b) =>
        ((a.content as { stepIndex?: number }).stepIndex ?? 0) -
        ((b.content as { stepIndex?: number }).stepIndex ?? 0),
    );
    expect(ordered.map((row) => (row.content as { message?: string }).message)).toEqual([
      "",
      "The comp Main has 1 layer.",
    ]);
    expect(toolRow.runId).toBe(runId);
    expect(toolRow.content).toMatchObject({
      kind: "tool",
      toolCallId: "call_e2e_happy_1",
      tool: "studio.get_context",
      payload: { args: { include: ["activeComp"] }, result: { activeComp: { name: "Main" } } },
    });
  });

  it("2. replay: the same Idempotency-Key re-POSTs the SAME durable turn outcome — no second run, no double reserve, no double settle", async () => {
    const fx = await newFixture("replay");
    const runId = unique("run");
    const messages: readonly TurnMessage[] = [{ role: "user", text: "what's on this comp?" }];
    fake.enqueue(textRound("The comp Main has 1 layer."));

    const first = await turnStream(fx, { runId, stepIndex: 0, messages });
    const firstEvents = expectValidStream(await new SseStream(first).rest());
    expect(typeSeq(firstEvents)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "turn.completed",
    ]);
    expect(joinedText(firstEvents)).toBe("The comp Main has 1 layer.");
    expect(completedOf(firstEvents).credits).toEqual({ committed: 1 });

    // Duplicate POST (network retry): the DURABLE replay — the turn's
    // persisted outcome re-emits from seq 0; the model NEVER re-runs.
    const second = await turnStream(fx, { runId, stepIndex: 0, messages });
    expect(second.status).toBe(200);
    const secondEvents = expectValidStream(await new SseStream(second).rest());
    expect(typeSeq(secondEvents)).toEqual(["run.started", "turn.started", "turn.completed"]);
    expect(secondEvents[0]?.seq).toBe(0);
    const replay = completedOf(secondEvents);
    expect(replay.assistantText).toBe("The comp Main has 1 layer.");
    expect(replay.usage).toEqual({ inputTokens: 40, outputTokens: 8 });
    expect(replay.credits).toEqual({ committed: 0 }); // already committed by the original turn
    expect(fake.calls.length).toBe(1); // exactly one model call ever happened

    // One run, one reserve, one settle — the run nets exactly −1 credit.
    const runs = await runsOfThread(fx.workspaceId, fx.threadId);
    expect(runs.length).toBe(1);
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    const runEntries = ledger.items.filter((entry) => entry.runId === runId);
    expect(runEntries.filter((entry) => entry.kind === "reserve").length).toBe(1);
    expect(runEntries.filter((entry) => entry.kind === "commit")).toEqual([
      expect.objectContaining({ amount: -1 * MICRO }),
    ]);
    expect(await balanceOf(fx.workspaceId)).toBe(99 * MICRO);
  });

  it("3b. client abort mid-turn cancels the TURN server-side (refund, no durable outcome); the run ends by the client's ABANDON", async () => {
    // ACTUAL-BEHAVIOR PIN (round-12): the turn route wires the request abort
    // signal to the model call, so a mid-turn disconnect cancels the TURN —
    // refundAll + NO persisted turnKey (a same-key retry re-runs the model,
    // bounded to ONE re-execution) — but NOT the run: the browser owns the
    // loop, so the run row stays live until the client's ABANDON gesture.
    const fx = await newFixture("abort");
    const runId = unique("run");

    // Empty script → the fake 500s → the §8.9 retry loop (real 1s/2s
    // backoff) keeps the turn in flight: a deterministic abort window.
    const controller = new AbortController();
    const response = await turnStream(fx, {
      runId,
      stepIndex: 0,
      messages: [{ role: "user", text: "what's on this comp?" }],
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();
    await new SseStream(response).cancel();

    // The aborted turn refunds its whole hold and persists nothing.
    await waitFor(
      "the aborted turn's refund",
      async () => (await balanceOf(fx.workspaceId)) === 100 * MICRO,
    );
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    const runEntries = ledger.items.filter((entry) => entry.runId === runId);
    expect(runEntries.filter((entry) => entry.kind === "reserve").length).toBe(1);
    expect(runEntries.filter((entry) => entry.kind === "refund").length).toBe(1);
    expect(runEntries.filter((entry) => entry.kind === "commit").length).toBe(0);

    const record = await getRun(fx, runId);
    // 12-w7 BUG-2a FIXED: the DB row is RUNNING (the turn route heartbeats
    // it) and GET /v1/runs/:id now maps it onto the wire's "streaming" —
    // a live turn-world run reads live on the wire, never "queued".
    expect(record.status).toBe("streaming"); // the honest live-run mapping
    expect((await server.deps.repos.runs.get(fx.workspaceId, runId)).run.status).toBe(
      "running", // the TURN is cancelled, not the run
    );
    expect(record.errorCode).toBeNull();
    // Only the user turn persists (aborted turns never write an assistant row).
    const messages = await listMessages(fx);
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");

    // The client's give-up gesture lands the run row.
    const abandon = await postAbandon(fx, runId);
    expect(abandon.status).toBe(200);
    expect(abandon.body).toEqual({ runId, status: "abandoned" });
    await waitFor(
      "the abandoned run row",
      async () => (await getRun(fx, runId)).status === "cancelled",
    );
    const final = await getRun(fx, runId);
    expect(final.errorCode).toBe("RUN_ABANDONED");
    expect(final.committedCredits).toBe(0);
  });

  it("4. stop: the client's ABANDON on a mid-flight run cancels it and refunds the outstanding per-turn hold", async () => {
    // The round-12 stop gesture (the retired run.cancelled-on-the-wire arm
    // died with the server loop — see the header deletions): POST
    // /v1/runs/:id/abandon lands the run cancelled + refunds the hold.
    const fx = await newFixture("stop");
    const runId = unique("run");

    // Empty script → 500s → the §8.9 retry loop holds the turn open with the
    // per-turn hold outstanding — the abandon lands inside that window.
    const response = await turnStream(fx, {
      runId,
      stepIndex: 0,
      messages: [{ role: "user", text: "what's on this comp?" }],
    });
    expect(response.status).toBe(200);

    const abandon = await postAbandon(fx, runId);
    expect(abandon.status).toBe(200);
    expect(abandon.body).toEqual({ runId, status: "abandoned" });
    await waitFor(
      "the cancelled run row",
      async () => (await getRun(fx, runId)).status === "cancelled",
    );
    const record = await getRun(fx, runId);
    expect(record.errorCode).toBe("RUN_ABANDONED");
    expect(record.committedCredits).toBe(0);
    expect(record.completedAt).not.toBeNull();

    // The turn's own stream still ends with its §8.9 terminal: the model
    // call burned its retry budget → turn.failed RUN_MODEL_UNAVAILABLE.
    const events = expectValidStream(await new SseStream(response).rest());
    const failed = failedOf(events);
    expect(failed).toMatchObject({ code: "RUN_MODEL_UNAVAILABLE", retryable: true });
    expect(failed.credits).toEqual({ committed: 0 });

    // Full refund: the ABANDON refunded the outstanding hold
    // (turn:${runId}:abandon:refund); the failed turn's own refundAll was a
    // no-op (outstanding already 0). One reserve, one refund, no commits.
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    const runEntries = ledger.items.filter((entry) => entry.runId === runId);
    expect(runEntries.filter((entry) => entry.kind === "reserve").length).toBe(1);
    const refunds = runEntries.filter((entry) => entry.kind === "refund");
    expect(refunds.length).toBe(1);
    expect(refunds[0]?.idempotencyKey).toBe(`turn:${runId}:abandon:refund`);
    expect(runEntries.filter((entry) => entry.kind === "commit").length).toBe(0);
    expect(await balanceOf(fx.workspaceId)).toBe(100 * MICRO); // full refund
  });

  it("6. model entitlements: studio-smart on trial → 403 MODEL_NOT_ENTITLED, no run, no ledger movement, no user message", async () => {
    const fx = await newFixture("entitled");
    fake.enqueue(textRound("unused")); // must never be called

    const response = await turnStream(fx, {
      runId: unique("run"),
      stepIndex: 0,
      messages: [{ role: "user", text: "make it fancy" }],
      model: "studio-smart",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    const parsed = await envelope(response);
    expect(parsed.err).toMatchObject({
      code: "MODEL_NOT_ENTITLED",
      message: "That model isn't available on your plan.",
      retryable: false,
    });
    expect(parsed.requestId).not.toBe("");

    expect(fake.calls.length).toBe(0); // no model call was ever made
    expect((await runsOfThread(fx.workspaceId, fx.threadId)).length).toBe(0);
    expect(await balanceOf(fx.workspaceId)).toBe(100 * MICRO);
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    expect(ledger.items.filter((entry) => entry.kind !== "grant").length).toBe(0);
    expect((await listMessages(fx)).length).toBe(0); // the 403 fires before the user turn persists
  });

  it("7. insufficient credits: a zero balance → 402 INSUFFICIENT_CREDITS before any run.started", async () => {
    const fx = await newFixture("broke", 5);
    // Drain the balance via the ledger repo (append-only adjust, §8.8).
    await server.deps.repos.ledger.adjust(fx.workspaceId, {
      amount: -5 * MICRO,
      idempotencyKey: unique("drain"),
    });
    expect(await balanceOf(fx.workspaceId)).toBe(0);
    fake.enqueue(textRound("unused"));

    const response = await turnStream(fx, {
      runId: unique("run"),
      stepIndex: 0,
      messages: [{ role: "user", text: "what's on this comp?" }],
    });
    expect(response.status).toBe(402);
    expect(response.headers.get("content-type")).toContain("application/json");
    const parsed = await envelope(response);
    expect(parsed.err).toMatchObject({ code: "INSUFFICIENT_CREDITS", retryable: false });

    expect(fake.calls.length).toBe(0);
    expect((await runsOfThread(fx.workspaceId, fx.threadId)).length).toBe(0);
    expect(await balanceOf(fx.workspaceId)).toBe(0);
    expect((await listMessages(fx)).length).toBe(0);
  });

  it("8. invalid tool: an unknown tool call resolves FAIL-CLOSED to the client; the echoed error reaches the model on the next turn", async () => {
    // ROUND-12 re-point (the retired §8.9 server-side repair-turn protocol is
    // deleted — header): the turn engine resolves the bad call fail-closed —
    // a typed INVALID_TOOL_CALL envelope rides the toolCall's resultForModel
    // (§8.4/§8.9), the CLIENT decides — and a client that keeps looping
    // hands the error to the model as the next turn's tool_result: the old
    // repair-turn subject, now client-mediated.
    const fx = await newFixture("invalid");
    const runId = unique("run");
    const message = "delete everything";
    fake.enqueue(
      unknownToolRound("call_bad_1", "studio.delete_everything"),
      textRound("I can't use that tool."),
    );

    const step0Response = await turnStream(fx, {
      runId,
      stepIndex: 0,
      messages: [{ role: "user", text: message }],
    });
    const step0Events = expectValidStream(await new SseStream(step0Response).rest());
    expect(typeSeq(step0Events)).toEqual([
      "run.started",
      "turn.started",
      "tool.started",
      "turn.completed",
    ]);
    const step0 = completedOf(step0Events);
    expect(step0.finishReason).toBe("tool-calls");
    const bad = step0.toolCalls[0];
    expect(bad).toMatchObject({
      toolCallId: "call_bad_1",
      tool: "studio.delete_everything",
      args: {},
    });
    expect(bad?.resultForModel).toMatchObject({ error: "INVALID_TOOL_CALL" });
    expect(String((bad?.resultForModel as { message?: unknown }).message)).toContain(
      'Unknown tool "studio.delete_everything"',
    );

    // The client echoes the failure as the tool result → the NEXT model call
    // sees it (the repair), then wraps up.
    const step1Response = await turnStream(fx, {
      runId,
      stepIndex: 1,
      messages: [
        { role: "user", text: message },
        { role: "assistant", text: "" },
        {
          role: "tool_call",
          toolCallId: "call_bad_1",
          tool: "studio.delete_everything",
          args: {},
        },
        {
          role: "tool_result",
          toolCallId: "call_bad_1",
          tool: "studio.delete_everything",
          result: bad?.resultForModel,
        },
      ],
    });
    const step1Events = expectValidStream(await new SseStream(step1Response).rest());
    expect(joinedText(step1Events)).toBe("I can't use that tool.");

    // The model's step-1 prompt carried the validation error — the same
    // repair-content pin the old server-side protocol had.
    expect(fake.calls.length).toBe(2);
    const repairContent = (fake.calls[1]?.body.messages ?? [])
      .filter((m) => m.role === "tool" && typeof m.content === "string")
      .map((m) => String(m.content))
      .join(" ");
    expect(repairContent).toContain("Unknown tool");
    expect(repairContent).toContain("studio.delete_everything");

    // The run is NOT failed server-side — the turn completed normally and
    // the client ends the loop with the marker.
    const end = await postPlanEnd(fx, runId);
    expect(end.status).toBe(200);
    await waitFor(
      "the run row to complete",
      async () => (await getRun(fx, runId)).status === "completed",
    );
    const record = await getRun(fx, runId);
    expect(record.errorCode).toBeNull();
    expect(record.committedCredits).toBe(2); // both turns billed their usage
  });

  it("9. SSE contract: id/data frames, seq monotonic from 0, first run.started, one terminal, §7.4 schemas parse", async () => {
    const fx = await newFixture("contract");
    fake.enqueue(textRound("Short answer."));

    const response = await turnStream(fx, {
      runId: unique("run"),
      stepIndex: 0,
      messages: [{ role: "user", text: "say something" }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const stream = new SseStream(response);
    const frames = await stream.rest();
    const events = expectValidStream(frames); // every §7.4 rule asserted inside
    expect(typeSeq(events)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "turn.completed",
    ]);
    expect(events[0]).toMatchObject({ type: "run.started", model: "studio-fast" });
    expect(events[1]).toMatchObject({ type: "turn.started", stepIndex: 0 });
    expect(events[2]).toMatchObject({ type: "message.delta", delta: "Short answer." });
    expect(completedOf(events).credits).toEqual({ committed: 1 }); // usageChunk(40, 8) → 1
    const runId = events[0]?.runId;
    if (runId === undefined) throw new Error("no runId");
    const end = await postPlanEnd(fx, runId);
    expect(end.status).toBe(200);
    await waitFor("run completion", async () => (await getRun(fx, runId)).status === "completed");
  });

  it("10. cross-tenant: another workspace's turn POST on this thread → 404 THREAD_NOT_FOUND, never 403", async () => {
    const fx = await newFixture("tenant-a");
    const intruder = await newWorkspace("tenant-b"); // a member of a DIFFERENT workspace
    fake.enqueue(textRound("unused"));

    const runId = unique("run");
    const response = await fetch(`${server.base}/v1/threads/${fx.threadId}/turn`, {
      method: "POST",
      headers: {
        origin: TEST_APP_ORIGIN,
        "content-type": "application/json",
        accept: "text/event-stream",
        cookie: intruder.jar.header,
        "x-workspace-id": intruder.id,
        "idempotency-key": `${runId}:0`,
      },
      body: JSON.stringify({
        runId,
        stepIndex: 0,
        messages: [{ role: "user", text: "what's on this comp?" }],
      }),
      redirect: "manual",
    });
    expect(response.status).toBe(404); // law #3: cross-tenant = 404
    const parsed = await envelope(response);
    expect(parsed.err).toMatchObject({ code: "THREAD_NOT_FOUND" });
    expect(fake.calls.length).toBe(0);
    expect((await runsOfThread(fx.workspaceId, fx.threadId)).length).toBe(0);
  });
});
