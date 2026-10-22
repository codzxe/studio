// M4-K — the gateway FULL-ROUTE chat-loop E2E (BUILD_PLAN §M4 task 7 + exit
// criteria; PRODUCT_ARCHITECTURE §7.4/§8.8/§8.9). Real buildApp over real
// Postgres, the REAL LiteLLM runner (MOCK_MODEL=false via createRunnerForEnv)
// against an in-process fake OpenAI-compatible SSE server on an ephemeral
// localhost port (sanctioned: not a dev server), the real SSE wire both ways,
// and real client tool-result POSTs to /v1/runs/:id/events.
//
// Scenarios: happy loop with client tool round-trip (+§7.4 toolCallId rule),
// idempotency replay, Last-Event-ID reconnect, client-abort semantics, cancel
// + full refund, model entitlements (403), zero credits (402), invalid tool
// (repair turn → RUN_INVALID_TOOL), the §7.4 SSE frame contract, cross-tenant
// 404. All deterministic — no real network beyond the loopback fake server.
//
// PINNED DECISION (scenario "tool timeout", documented for M4 closeout):
// TOOL_RESULT_TIMEOUT_MS is a 30_000 ms CONSTANT in src/litellm/runner.ts —
// not env-injectable, and the chat route wires it directly
// (log.waitToolResult(id, TOOL_RESULT_TIMEOUT_MS)). A real-time E2E would
// sleep 30s in CI. The timeout→EDITOR_DISCONNECTED mapping is unit-proven by
// M4-A's litellm-runner.test.ts (FakeStream waitMode "timeout"); this file
// pins the CANCEL path's full reserve refund instead — the same ledger
// refundAll code path the timeout failure settles through. Do NOT add a 30s
// sleep here; an env knob (TOOL_RESULT_TIMEOUT_MS) would be a src/ change
// this task does not own (report, never fix).

import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { z } from "zod";

import {
  CONTEXT_SELECTION_SCHEMA,
  type RunRecord,
  STUDIO_STREAM_EVENT_SCHEMA,
  type StudioStreamEvent,
  TOOL_LIST,
} from "@studio/contracts";
import type { AgentRun } from "@studio/db";

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

/** The 5 read tool ids (M4.6 hard rule: no write tool is ever registered). */
const READ_TOOL_IDS = [...TOOL_LIST.filter((tool) => tool.kind === "read").map((t) => t.id)].sort();

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

const TERMINAL_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

type CreditsEvent = Extract<StudioStreamEvent, { type: "credits" }>;
type DeltaEvent = Extract<StudioStreamEvent, { type: "message.delta" }>;

function findCredits(events: readonly StudioStreamEvent[]): CreditsEvent {
  const credits = events.find((event): event is CreditsEvent => event.type === "credits");
  if (credits === undefined) throw new Error("no credits event on the wire");
  return credits;
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

async function grantCredits(workspaceId: string, amount: number): Promise<void> {
  await server.deps.repos.ledger.grant(workspaceId, {
    amount,
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

interface ChatBody {
  readonly message: string;
  /** ContextSelection BEFORE schema defaults (the chat route parses it). */
  readonly context: z.input<typeof CONTEXT_SELECTION_SCHEMA>;
  readonly idempotencyKey: string;
  readonly pinned: unknown[];
  readonly model?: "studio-fast" | "studio-smart" | "studio-vision";
}

interface ChatCallOptions {
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
}

/** Raw chat POST (the api() helper has no abort/signal seam). */
async function chatStream(
  fx: Fixture,
  body: ChatBody,
  options: ChatCallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: TEST_APP_ORIGIN,
    "content-type": "application/json",
    accept: "text/event-stream",
    cookie: fx.jar.header,
    "x-workspace-id": fx.workspaceId,
  };
  if (options.lastEventId !== undefined) headers["last-event-id"] = options.lastEventId;
  return fetch(`${server.base}/v1/threads/${fx.threadId}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
    redirect: "manual",
  });
}

async function postToolResult(
  fx: Fixture,
  runId: string,
  toolCallId: string,
  result: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api(server.base, `/v1/runs/${runId}/events`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("toolresult") },
    body: { type: "tool.result", toolCallId, result },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postCancel(
  fx: Fixture,
  runId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api(server.base, `/v1/runs/${runId}/cancel`, {
    method: "POST",
    jar: fx.jar,
    headers: { "x-workspace-id": fx.workspaceId, "idempotency-key": unique("cancel") },
    body: { reason: "test" },
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

d("M4-K gateway chat-loop E2E — real LiteLLM runner over the real SSE wire", () => {
  it("1. happy loop: client tool round-trip drives the answer; ledger settles; run + steps + messages persist", async () => {
    const fx = await newFixture("happy");
    const idempotencyKey = unique("chat");
    const message = "what's on this comp?";
    const context = CONTEXT_SELECTION_SCHEMA.parse({
      projectSummary: true,
      activeComp: true,
      selection: true,
    });
    const expectedReserve = reserveAmountFor(estimateRunCredits({ message, context, pinned: [] }));

    fake.enqueue(getContextRound("call_e2e_happy_1"), answerFromToolResult());

    const response = await chatStream(fx, { message, context, idempotencyKey, pinned: [] });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const stream = new SseStream(response);
    const head = await stream.until(
      (event) => event.type === "tool.started",
      "tool.started (studio.get_context)",
    );
    const events = expectValidStream(head, { requireTerminal: false });
    expect(typeSeq(events)).toEqual(["run.started", "tool.started"]);
    const runId = events[0]?.runId;
    if (runId === undefined) throw new Error("no run.started event");
    expect(events[0]).toMatchObject({ type: "run.started", model: "studio-fast" });
    expect(events[1]).toMatchObject({
      type: "tool.started",
      toolCallId: "call_e2e_happy_1",
      name: "studio.get_context",
      args: { include: ["activeComp"] },
    });

    // §7.4 rule: only the expected toolCallId may report a result.
    const stranger = await postToolResult(fx, runId, "call_not_expected", { nope: true });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error).toMatchObject({ code: "VALIDATION_FAILED" });

    // The "client" (bridge executor stand-in) reports the tool result.
    const posted = await postToolResult(fx, runId, "call_e2e_happy_1", {
      activeComp: { name: "Main" },
    });
    expect(posted.status).toBe(200);
    expect(posted.body.data).toMatchObject({ runId, recorded: true });

    const tail = await stream.rest();
    const all = expectValidStream([...head, ...tail]);
    expect(typeSeq(all)).toEqual([
      "run.started",
      "tool.started",
      "tool.result",
      "message.delta",
      "message.delta",
      "credits",
      "run.completed",
    ]);
    expect(all[2]).toMatchObject({
      type: "tool.result",
      toolCallId: "call_e2e_happy_1",
      result: { activeComp: { name: "Main" } },
    });
    // The answer names the comp from the CLIENT's tool result — proving the
    // POST /v1/runs/:id/events payload reached the model conversation.
    expect(joinedText(all)).toBe("The comp Main has 1 layer.");
    const credits = findCredits(all);
    expect(credits).toMatchObject({
      reserved: expectedReserve,
      committed: 1,
    });
    // §8.8 exit criterion: commit ≥ 1 and capped by the reserve.
    expect(credits.committed).toBeGreaterThanOrEqual(1);
    expect(credits.committed).toBeLessThanOrEqual(credits.reserved);
    // LEDGER BUG PIN (reported to the fleet, NOT fixed here — law #12): the
    // current settle refunds `outstanding − commit` instead of releasing the
    // full hold, so a completed run nets −2×commit rather than −commit
    // (§8.8 "refund the difference on success"). packages/db's own
    // integration test pins the doc-correct balance (82) and observes 64 —
    // RED whenever DATABASE_URL is a postgres URL. This E2E pins the
    // OBSERVED entry arithmetic: balance = grant − reserve − commit +
    // (reserve − commit).
    expect(credits.balance).toBe(100 - expectedReserve - 1 + (expectedReserve - 1));

    // The runner only ever registered the 5 read tools (M4.6: no write path).
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0]?.authorization).toBe("Bearer sk-test-litellm-fake");
    const toolNames = (fake.calls[0]?.body.tools ?? []).map((tool) => tool.function.name).sort();
    expect(toolNames).toEqual(READ_TOOL_IDS);

    // Ledger: reserve −N, commit −1, refund +(N−1) — see the LEDGER BUG PIN
    // above (a completed run currently nets −2×commit; the entries below are
    // the planSettlement contract as built).
    await waitFor(
      "the run row to complete",
      async () => (await getRun(fx, runId)).status === "completed",
    );
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    const runEntries = ledger.items.filter((entry) => entry.runId === runId);
    const byKind: Record<string, number[]> = {};
    for (const entry of runEntries) {
      byKind[entry.kind] = [...(byKind[entry.kind] ?? []), entry.amount];
    }
    expect(byKind.reserve).toEqual([-expectedReserve]);
    expect(byKind.commit).toEqual([-1]);
    expect(byKind.refund).toEqual([expectedReserve - 1]);
    expect(await balanceOf(fx.workspaceId)).toBe(100 - expectedReserve - 1 + (expectedReserve - 1));

    // Run row.
    const record = await getRun(fx, runId);
    expect(record.status).toBe("completed");
    expect(record.model).toBe("studio-fast");
    expect(record.reservedCredits).toBe(expectedReserve);
    expect(record.committedCredits).toBe(1);
    expect(record.baseVersionId).toBe(fx.versionId);
    expect(record.errorCode).toBeNull();
    expect(record.completedAt).not.toBeNull();

    // Steps: rows exist for the tool. TOLERANT COUNT — see the M4-A flagged
    // quirk: runs.ts records a tool.result step row AND chat.ts finalize's
    // recordSteps re-records tool.started/tool.result with the LOG seqs, so
    // one tool call yields 3 rows (seq 0 result + seq 1 started + seq 2
    // result). Assert semantics, not row count; (runId, seq) stays unique.
    const steps = record.steps;
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.every((step) => step.tool === "studio.get_context")).toBe(true);
    expect(new Set(steps.map((step) => step.seq)).size).toBe(steps.length);
    const rawRun = await server.deps.repos.runs.get(fx.workspaceId, runId);
    const withResult = rawRun.steps.filter(
      (step) =>
        (step.resultJson as { activeComp?: { name?: string } } | null)?.activeComp?.name === "Main",
    );
    expect(withResult.length).toBeGreaterThanOrEqual(1);
    expect(rawRun.steps.some((step) => step.argsJson !== null)).toBe(true);

    // Messages persisted: the user turn + the assistant answer (§9.1).
    const messages = await listMessages(fx);
    expect(messages.length).toBe(2);
    const assistant = messages.find((row) => row.role === "assistant");
    const user = messages.find((row) => row.role === "user");
    if (assistant === undefined || user === undefined) throw new Error("missing message rows");
    expect(user.content).toMatchObject({ message });
    expect(assistant.content).toMatchObject({ text: "The comp Main has 1 layer." });
    expect(assistant.runId).toBe(runId);
  });

  it("2. replay: the same idempotencyKey re-POSTs the SAME run from seq 0 — no second run, no double reserve", async () => {
    const fx = await newFixture("replay");
    const idempotencyKey = unique("chat");
    const body: ChatBody = {
      message: "what's on this comp?",
      context: {},
      idempotencyKey,
      pinned: [],
    };
    fake.enqueue(getContextRound("call_e2e_replay_1"), answerFromToolResult());

    const first = await chatStream(fx, body);
    const firstStream = new SseStream(first);
    const head = await firstStream.until((event) => event.type === "tool.started", "tool.started");
    const runId = (await runsOfThread(fx.workspaceId, fx.threadId))[0]?.id;
    if (runId === undefined) throw new Error("no run row");
    await postToolResult(fx, runId, "call_e2e_replay_1", { activeComp: { name: "Main" } });
    const firstFrames = [...head, ...(await firstStream.rest())];
    const firstEvents = expectValidStream(firstFrames);
    await waitFor("run completion", async () => (await getRun(fx, runId)).status === "completed");

    // Duplicate POST (network retry): replays the same run's log from seq 0.
    const second = await chatStream(fx, body);
    expect(second.status).toBe(200);
    const secondStream = new SseStream(second);
    const secondFrames = await secondStream.rest();
    const secondEvents = expectValidStream(secondFrames);
    expect(secondEvents).toEqual(firstEvents);
    expect(secondEvents[0]?.seq).toBe(0);

    // One run, one reserve.
    const runs = await runsOfThread(fx.workspaceId, fx.threadId);
    expect(runs.length).toBe(1);
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    const reserves = ledger.items.filter(
      (entry) => entry.runId === runId && entry.kind === "reserve",
    );
    expect(reserves.length).toBe(1);
    // Observed ledger arithmetic (see the LEDGER BUG PIN in test 1).
    expect(await balanceOf(fx.workspaceId)).toBe(98);
  });

  it("3a. reconnect: a live run resumes after Last-Event-ID; the tool result posted mid-reconnect lands once", async () => {
    const fx = await newFixture("reconnect");
    const idempotencyKey = unique("chat");
    const body: ChatBody = {
      message: "what's on this comp?",
      context: {},
      idempotencyKey,
      pinned: [],
    };
    fake.enqueue(getContextRound("call_e2e_rec_1"), answerFromToolResult());

    const first = await chatStream(fx, body);
    const firstStream = new SseStream(first);
    const head = await firstStream.until((event) => event.type === "tool.started", "tool.started");
    const cursor = head.at(-1)?.event.seq;
    if (cursor === undefined) throw new Error("no cursor");
    const runId = head[0]?.event.runId;
    if (runId === undefined) throw new Error("no runId");

    // "Reconnect": same body + Last-Event-ID cursor — a SECOND SSE segment
    // over the same live run while the first is still open.
    const second = await chatStream(fx, body, { lastEventId: String(cursor) });
    expect(second.status).toBe(200);
    const secondStream = new SseStream(second);

    // The client executes the tool and reports the result mid-reconnect.
    await postToolResult(fx, runId, "call_e2e_rec_1", { activeComp: { name: "Main" } });

    const secondFrames = await secondStream.rest();
    const secondEvents = expectValidStream(secondFrames, { firstSeq: cursor + 1 });
    // Replay semantics: strictly after the cursor, nothing re-delivered.
    expect(secondEvents.map((event) => event.seq)).toEqual(
      secondEvents.map((_event, index) => cursor + 1 + index),
    );
    expect(typeSeq(secondEvents)).toEqual([
      "tool.result",
      "message.delta",
      "message.delta",
      "credits",
      "run.completed",
    ]);
    expect(secondEvents.filter((event) => event.type === "tool.result").length).toBe(1);

    // The original segment saw the same tail — each event lands once per stream.
    const firstTail = await firstStream.rest();
    const firstEvents = expectValidStream([...head, ...firstTail]);
    expect(firstEvents.filter((event) => event.type === "tool.result").length).toBe(1);
    expect(joinedText(firstEvents)).toBe("The comp Main has 1 layer.");

    await waitFor("run completion", async () => (await getRun(fx, runId)).status === "completed");
    expect((await runsOfThread(fx.workspaceId, fx.threadId)).length).toBe(1);
  });

  it("3b. client abort mid-run cancels the live run server-side (pinned actual behavior) and refunds the reserve", async () => {
    // ACTUAL-BEHAVIOR PIN (report, never fix): chat.ts wires the hono request
    // abort signal AND the SSE ReadableStream cancel() to cancelRun(), and
    // @hono/node-server aborts the request signal when the client connection
    // drops mid-response — so a mid-run disconnect CANCELS the live run
    // (run row cancelled + run.cancelled + full refund) rather than letting
    // it stream on for Last-Event-ID replay. The reconnect semantics are
    // therefore replay-of-record (3a covers the live-parallel case); a real
    // network flap ends the run under the current gateway.
    const fx = await newFixture("abort");
    const idempotencyKey = unique("chat");
    fake.enqueue(getContextRound("call_e2e_abort_1"), answerFromToolResult());

    const controller = new AbortController();
    const response = await chatStream(
      fx,
      { message: "what's on this comp?", context: {}, idempotencyKey, pinned: [] },
      { signal: controller.signal },
    );
    const stream = new SseStream(response);
    const head = await stream.until((event) => event.type === "tool.started", "tool.started");
    const runId = head[0]?.event.runId;
    if (runId === undefined) throw new Error("no runId");

    controller.abort();
    await stream.cancel();

    await waitFor(
      "the aborted run to cancel",
      async () => (await getRun(fx, runId)).status === "cancelled",
    );
    expect(await balanceOf(fx.workspaceId)).toBe(100); // full refund
    const record = await getRun(fx, runId);
    expect(record.errorCode).toBe("RUN_CANCELLED");

    // The replay of the same idempotencyKey shows the terminal log from seq 0.
    const replayResponse = await chatStream(fx, {
      message: "what's on this comp?",
      context: {},
      idempotencyKey,
      pinned: [],
    });
    const replay = new SseStream(replayResponse);
    const replayEvents = expectValidStream(await replay.rest());
    expect(typeSeq(replayEvents)).toEqual(["run.started", "tool.started", "run.cancelled"]);

    // A late tool result is refused — the run is terminal (§7.4).
    const late = await postToolResult(fx, runId, "call_e2e_abort_1", {
      activeComp: { name: "Main" },
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: "RUN_NOT_ACTIVE" });

    // Only the user turn persists (cancelled runs never write an assistant row).
    const messages = await listMessages(fx);
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
  });

  it("4. cancel: POST /v1/runs/:id/cancel emits run.cancelled on the wire and refunds the full reserve", async () => {
    const fx = await newFixture("cancel");
    fake.enqueue(getContextRound("call_e2e_cancel_1"), answerFromToolResult());

    const response = await chatStream(fx, {
      message: "what's on this comp?",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    const stream = new SseStream(response);
    const head = await stream.until((event) => event.type === "tool.started", "tool.started");
    const runId = head[0]?.event.runId;
    if (runId === undefined) throw new Error("no runId");

    const cancel = await postCancel(fx, runId);
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({ runId, cancelled: true });

    const tail = await stream.rest();
    const events = expectValidStream([...head, ...tail]);
    expect(events.at(-1)).toMatchObject({ type: "run.cancelled" });
    expect(events.filter((event) => TERMINAL_TYPES.has(event.type)).length).toBe(1);

    await waitFor(
      "the cancelled run row",
      async () => (await getRun(fx, runId)).status === "cancelled",
    );
    const record = await getRun(fx, runId);
    expect(record.errorCode).toBe("RUN_CANCELLED");
    expect(record.committedCredits).toBe(0);
    expect(record.completedAt).not.toBeNull();

    // Full refund: ledger balance is back to the pre-run grant.
    expect(await balanceOf(fx.workspaceId)).toBe(100);
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    const runEntries = ledger.items.filter((entry) => entry.runId === runId);
    expect(runEntries.filter((entry) => entry.kind === "reserve").length).toBe(1);
    expect(runEntries.filter((entry) => entry.kind === "refund").length).toBe(1);
    expect(runEntries.filter((entry) => entry.kind === "commit").length).toBe(0);
  });

  it("6. model entitlements: studio-smart on trial → 403 MODEL_NOT_ENTITLED, no run, no ledger movement, no user message", async () => {
    const fx = await newFixture("entitled");
    fake.enqueue(textRound("unused")); // must never be called

    const response = await chatStream(fx, {
      message: "make it fancy",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
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
    expect(await balanceOf(fx.workspaceId)).toBe(100);
    const ledger = await server.deps.repos.ledger.list(fx.workspaceId, {});
    expect(ledger.items.filter((entry) => entry.kind !== "grant").length).toBe(0);
    expect((await listMessages(fx)).length).toBe(0); // the 403 fires before the user turn persists
  });

  it("7. insufficient credits: a zero balance → 402 INSUFFICIENT_CREDITS before any run.started", async () => {
    const fx = await newFixture("broke", 5);
    // Drain the balance via the ledger repo (append-only adjust, §8.8).
    await server.deps.repos.ledger.adjust(fx.workspaceId, {
      amount: -5,
      idempotencyKey: unique("drain"),
    });
    expect(await balanceOf(fx.workspaceId)).toBe(0);
    fake.enqueue(textRound("unused"));

    const response = await chatStream(fx, {
      message: "what's on this comp?",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
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

  it("8. invalid tool: an unknown tool twice → run.failed RUN_INVALID_TOOL after one repair turn + full refund", async () => {
    const fx = await newFixture("invalid");
    fake.enqueue(
      unknownToolRound("call_bad_1", "studio.delete_everything"),
      unknownToolRound("call_bad_2", "studio.delete_everything"),
    );

    const response = await chatStream(fx, {
      message: "delete everything",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    const stream = new SseStream(response);
    const frames = await stream.rest();
    const events = expectValidStream(frames);
    expect(typeSeq(events)).toEqual(["run.started", "run.failed"]);
    const failed = events[1];
    if (failed?.type !== "run.failed") throw new Error("expected run.failed");
    expect(failed).toMatchObject({
      code: "RUN_INVALID_TOOL",
      message: "The agent requested a tool call we can't validate.",
      retryable: false,
    });
    const runId = events[0]?.runId;

    // One repair turn (§8.9): the model saw the validation error as the tool
    // result before the second offense failed the run.
    expect(fake.calls.length).toBe(2);
    const repairContent = (fake.calls[1]?.body.messages ?? [])
      .filter((message) => message.role === "tool" && typeof message.content === "string")
      .map((message) => String(message.content))
      .join(" ");
    expect(repairContent).toContain("VALIDATION_FAILED");
    expect(repairContent).toContain("Unknown tool");

    if (runId === undefined) throw new Error("no runId");
    await waitFor("the failed run row", async () => (await getRun(fx, runId)).status === "failed");
    const record = await getRun(fx, runId);
    expect(record.errorCode).toBe("RUN_INVALID_TOOL");
    expect(record.committedCredits).toBe(0);
    expect(await balanceOf(fx.workspaceId)).toBe(100); // full refund
    const rawRun = await server.deps.repos.runs.get(fx.workspaceId, runId);
    expect(rawRun.steps.length).toBe(0); // invalid calls never started a tool
    expect((await listMessages(fx)).length).toBe(1); // the user turn only
  });

  it("9. SSE contract: id/data frames, seq monotonic from 0, first run.started, one terminal, §7.4 schemas parse", async () => {
    const fx = await newFixture("contract");
    fake.enqueue(textRound("Short answer."));

    const response = await chatStream(fx, {
      message: "say something",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const stream = new SseStream(response);
    const frames = await stream.rest();
    const events = expectValidStream(frames); // every §7.4 rule asserted inside
    expect(typeSeq(events)).toEqual(["run.started", "message.delta", "credits", "run.completed"]);
    expect(events[0]).toMatchObject({ type: "run.started", model: "studio-fast" });
    expect(events[1]).toMatchObject({ type: "message.delta", delta: "Short answer." });
    expect(findCredits(events).committed).toBe(1); // usageChunk(40, 8) on studio-fast → ceil → 1
    const runId = events[0]?.runId;
    if (runId === undefined) throw new Error("no runId");
    await waitFor("run completion", async () => (await getRun(fx, runId)).status === "completed");
  });

  it("10. cross-tenant: another workspace's chat POST on this thread → 404 THREAD_NOT_FOUND, never 403", async () => {
    const fx = await newFixture("tenant-a");
    const intruder = await newWorkspace("tenant-b"); // a member of a DIFFERENT workspace
    fake.enqueue(textRound("unused"));

    const response = await api(server.base, `/v1/threads/${fx.threadId}/chat`, {
      method: "POST",
      jar: intruder.jar,
      headers: { "x-workspace-id": intruder.id },
      body: {
        message: "what's on this comp?",
        context: {},
        idempotencyKey: unique("chat"),
        pinned: [],
      },
    });
    expect(response.status).toBe(404); // law #3: cross-tenant = 404
    const parsed = await envelope(response);
    expect(parsed.err).toMatchObject({ code: "THREAD_NOT_FOUND" });
    expect(fake.calls.length).toBe(0);
    expect((await runsOfThread(fx.workspaceId, fx.threadId)).length).toBe(0);
  });
});
