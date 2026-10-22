// M6-J — the M6 EXIT-CRITERIA proofs at the full-route JOURNEY level
// (BUILD_PLAN §M6 tasks 5-6 + exit criteria; BP §M6.6 "Stripe test clocks for
// trial/renewal/past due"). One test = one exit criterion, each walking a
// real user's whole journey against real Postgres + the REAL LiteLLM runner
// (in-process FakeOpenAI SSE server, the M4-K/M5-K harness pattern) and the
// M6-B FakeStripe harness injected as deps.stripe (the M6-C seam mode).
//
// Scorecard (exit criterion → test):
//  1. "A new user must add a card to start the trial; no permanent free
//     path" ......................... journey 1 (trial refuses without a
//     card → card on file → 14-day trial row → [studio-fast] gate → a
//     studio-smart RUN is 403) + journey 5's tail (canceled gates as trial).
//  2. "Billing state gates models, seats, storage and renders server-side"
//     ................................. journey 2 (checkout → webhook → test
//     clock conversion → the /v1/models picker widens to the paid catalog;
//     seats/storage/render entitlements from entitlementsFor; the RUN-level
//     model gate flips) — the seats pre-check matrix is M6-C's, complemented
//     here at run level.
//  3. "Credits cannot go negative; every entry reconciles" ... journey 3
//     (402 before run.started at zero balance; the ledger reserve gate at
//     balance < reserve; every balanceAfter ≥ 0) + journey 7 (the ledger
//     endpoint walk: every entry parses, kinds reconcile).
//  4. "A failed/cancelled run refunds fully; a successful run commits actual
//     usage" ........................... journey 3 (completed run nets
//     exactly −commit with the FULL hold released, D-20; cancelled run nets
//     exactly 0).
//  5. "Invoices and ledger are visible and correct" .......... journey 7
//     (ledger visible via GET /v1/credits/ledger + correct; invoice.paid
//     recorded + listed via the repo).
//
// COMPLEMENT LANE (never duplicates M6-C's billing-routes matrix): their
// file covers checkout/topup/portal/state route shapes, same-event-id
// replay, past_due-before-renewal staleness, the seat pre-check and the trial
// abuse rules. THIS file adds: the card-gated trial JOURNEY with a live
// model-run entitlement 403, the clock-driven conversion + dunning arc (the
// fake's test clocks at the ROUTE level for the first time), money
// conservation with real chat runs, the top-up → run-succeeds journey, the
// fresh-event-id double-apply guard, the out-of-order
// renewal-before-conversion period regression, wrong-secret/forged-v1/
// stale-timestamp signature tamper, and the reconciliation ledger walk.
//
// Harness notes (house precedent — helpers are DUPLICATED per file, never
// imported across test files): FakeOpenAIServer + SseStream +
// expectValidStream mirror chat-loop.test.ts; the billing helpers mirror
// billing-routes.test.ts; FakeStripe comes from tests/helpers/ (shared).
//
// PINS + FINDINGS documented in the header of each journey (law #12 — src/
// is never edited by this task):
//  - F-J1 (UNITS, pre-existing, M6-E's consumer note): the chat run path
//    writes WHOLE-credit magnitudes (reserve −2 / commit −1) while the
//    billing webhook grants write D-12 µc (100 credits = 100_000_000). The
//    ledger reconciles arithmetically across both; the conversion of the
//    run path to µc is the M6 tail's owner's change.
//  - F-J2 (CONTRACTS DRIFT, pre-existing, M6-A finding 2): contracts'
//    PLAN_MODEL_ENTITLEMENTS still says starter→[studio-fast] while the
//    @studio/config catalog says starter→[fast,smart]. Journey 2 converts
//    to PRO (both sources agree there) and pins the drift as a finding.
//  - F-J3 (VISIBILITY GAP, LANDED by M6-K): invoices are persisted (M6-D
//    repo) and NOW wire-readable — GET /v1/billing/invoices (cursor
//    pagination, workspace-scoped) is walked in journey 7.
//  - F-J4 (RECONCILIATION JOB): no reconciliation report endpoint is landed
//    at this tree yet — journey 7 uses direct ledger sums via the
//    /v1/credits/ledger endpoint walk, the documented fallback.
//  - F-J5 (RUN-ROW ORPHAN, pinned in journey 3): when the LEDGER refuses the
//    hold (balance < reserve), the chat route's catch tries
//    runs.update {status: "failed"} while the row is still "queued" (it
//    only moves to "running" AFTER a successful reserve), and
//    packages/db/src/statuses.ts RUN_TRANSITIONS forbids queued→failed —
//    the typed CONFLICT is swallowed by the route's .catch(() => undefined),
//    so the refused-hold run row is orphaned as "queued" with NO errorCode.
//    MONEY IS SAFE (no reserve row, balance unchanged, never negative);
//    the row state is the drift. Suggested fix (statuses.ts owner): allow
//    queued→failed — a refused hold IS a failed run. (Law #12: not fixed
//    here; pinned as actual behavior.)

import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  LEDGER_KIND_SCHEMA,
  type RunRecord,
  STUDIO_STREAM_EVENT_SCHEMA,
  type StudioStreamEvent,
} from "@studio/contracts";

import type { AgentRun, Repos } from "@studio/db";

import type { StripeSeam } from "../src/context.js";
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
import {
  FAKE_NOW_MS,
  FAKE_STRIPE_SECRET_KEY,
  FAKE_WEBHOOK_SECRET,
  FakeStripe,
  type FakeStripeEvent,
} from "./helpers/fake-stripe.js";

const d = describe.skipIf(!HAS_DATABASE);

/** Distinct price ids so the reverse price→plan map is unambiguous. */
const PRICE_IDS = JSON.stringify({
  starter: "price_test_starter",
  pro: "price_test_pro",
  studio: "price_test_studio",
  "pack:credits100": "price_test_pack100",
  "pack:credits500": "price_test_pack500",
  "pack:credits2000": "price_test_pack2000",
});

const DAY = 86_400;
const DAY_MS = 86_400_000;

/** The fake's fixed epoch, in unix seconds. */
const FAKE_NOW_SECONDS = FAKE_NOW_MS / 1000;

// ---------------------------------------------------------------------------
// FakeOpenAIServer (duplicated from tests/chat-loop.test.ts — never imported
// across test files; same wire shapes as the litellm runner expects).
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
    // Swallow socket errors from aborted runs (cancelled mid-round).
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

/** Script: a plain text answer, no tools. */
function textRound(text: string): ScriptEntry {
  return () => [textDelta(text), usageChunk(40, 8), finishReason("stop"), DONE];
}

// ---------------------------------------------------------------------------
// SSE wire reader (duplicated from tests/chat-loop.test.ts)
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

  async rest(timeoutMs = 5000): Promise<WireFrame[]> {
    const frames: WireFrame[] = [];
    for (;;) {
      const wireFrame = await this.next(timeoutMs);
      if (wireFrame === null) return frames;
      frames.push(wireFrame);
    }
  }
}

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

/** §7.4 wire contract over a collected frame list (duplicated from M4-K). */
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
  const runIds = new Set(events.map((event) => event.runId));
  expect(runIds.size).toBe(1);
  return events;
}

function typeSeq(events: readonly StudioStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

// ---------------------------------------------------------------------------
// Server + shared fixtures
// ---------------------------------------------------------------------------

const openai = new FakeOpenAIServer();

let server: RunningTestServer;

beforeAll(async () => {
  await openai.start();
  const envSource = {
    MOCK_MODEL: "false",
    LITELLM_BASE_URL: openai.url,
    LITELLM_API_KEY: "sk-test-litellm-fake",
    CHAT_MAX_STEPS: "6",
    STRIPE_SECRET_KEY: FAKE_STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    STRIPE_PRICE_IDS: PRICE_IDS,
  };
  const env = testEnv(envSource);
  // Production wiring (src/index.ts): the runner is selected FROM the parsed
  // env — MOCK_MODEL=false ⇒ the real LiteLLM runner against the fake model
  // server; billing reads the fake seam injected per test (deps.stripe).
  server = await bootServer({ env: envSource, runner: createRunnerForEnv(env) });
}, 30_000);

afterAll(async () => {
  await server?.close();
  await openai.stop();
});

afterEach(() => {
  openai.reset();
});

// ---------------------------------------------------------------------------
// Billing harness (duplicated from tests/billing-routes.test.ts)
// ---------------------------------------------------------------------------

interface Workspace {
  readonly jar: CookieJar;
  readonly id: string;
  readonly email: string;
}

async function okData(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toHaveProperty("data");
  return body.data as Record<string, unknown>;
}

async function errOf(response: Response): Promise<{ code: string; hint?: string }> {
  const body = (await response.json()) as { error: { code: string; hint?: string } };
  expect(body.error).toBeDefined();
  return { code: body.error.code, hint: body.error.hint };
}

async function newWorkspace(target: RunningTestServer = server): Promise<Workspace> {
  const jar = new CookieJar();
  const email = uniqueEmail();
  const response = await api(target.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: "Journey" },
  });
  expect(response.status).toBe(200);
  const wsResponse = await api(target.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("M6-J WS"), slug: unique("m6j-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { jar, id: ws.data.id, email };
}

/** Injects a Stripe seam as deps.stripe (the fleet-precedent live mutation). */
function setStripeSeam(target: RunningTestServer, seam: StripeSeam): void {
  (target.deps as unknown as { stripe: StripeSeam | null }).stripe = seam;
}

/** Injects the fake's ready-made seam as deps.stripe. */
function setStripe(target: RunningTestServer, fake: FakeStripe): void {
  setStripeSeam(target, fake.seam);
}

/** Fresh fake bound to the boot env's webhook secret. */
function freshFake(): FakeStripe {
  return new FakeStripe({ webhookSecret: FAKE_WEBHOOK_SECRET });
}

/**
 * The fake mints DETERMINISTIC event ids (evt_fake_N) — the durable
 * webhook_events store and the ledger's globally-unique idempotency keys
 * survive tests AND runs, so every scripted or harness-created event gets a
 * run-unique id BEFORE signing (the signature covers the final bytes).
 */
function script(fake: FakeStripe, type: string, object: Record<string, unknown>): FakeStripeEvent {
  const event = fake.scriptEvent(type, object);
  return { ...event, id: `${event.id}_${unique("e")}` };
}

function reid(events: readonly FakeStripeEvent[]): FakeStripeEvent[] {
  return events.map((event) => ({ ...event, id: `${event.id}_${unique("e")}` }));
}

/** Non-null array access without the `!` (noNonNullAssertion is repo-error). */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} is missing`);
  return item;
}

function repos(): Repos {
  return server.deps.repos;
}

/** Signs + delivers a webhook event to POST /v1/webhooks/stripe. */
async function deliver(
  fake: FakeStripe,
  event: FakeStripeEvent,
  target: RunningTestServer = server,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const { payload, signature } = fake.signWebhook(event);
  const response = await api(target.base, "/v1/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    rawBody: new Uint8Array(payload),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    data: (body.data as Record<string, unknown>) ?? { ...(body as Record<string, unknown>) },
  };
}

async function billingState(ws: Workspace): Promise<Record<string, unknown>> {
  const response = await api(server.base, "/v1/billing/state", {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  return okData(response);
}

async function subscriptionRow(workspaceId: string) {
  return repos().subscriptions.getByOrganization(workspaceId);
}

/** POSTs a billing mutation with a fresh Idempotency-Key (law #4, §7.2). */
async function billingPost(
  path: string,
  ws: Workspace,
  body: unknown,
  key: string = unique("bill"),
): Promise<Response> {
  return api(server.base, path, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": key },
    body,
  });
}

/** The workspace's current ledger balance (µc, D-12). */
async function balanceOf(workspaceId: string): Promise<number> {
  return repos().ledger.balance(workspaceId);
}

/** Creates a project in the workspace (the "work" that must never be deleted). */
async function createProject(ws: Workspace): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("M6-J Project") },
  });
  expect(response.status).toBe(201);
  const project = (await okData(response)) as { id: string };
  return project.id;
}

/** GET /v1/models through the real route (the picker's server-side gate). */
async function modelsOf(ws: Workspace): Promise<{ plan: string; models: string[] }> {
  const response = await api(server.base, "/v1/models", {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const body = (await okData(response)) as { plan: string; models: { id: string }[] };
  return { plan: body.plan, models: body.models.map((model) => model.id) };
}

/** GET /v1/credits through the real route. */
async function creditsOf(
  ws: Workspace,
): Promise<{ balance: number; includedCredits: number; reserved: number; plan: string }> {
  const response = await api(server.base, "/v1/credits", {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const body = (await okData(response)) as {
    balance: number;
    includedCredits: number;
    reserved: number;
    plan: string;
  };
  return body;
}

interface SubscriptionFlow {
  readonly fake: FakeStripe;
  readonly wire: Record<string, unknown>;
  readonly subId: string;
  readonly customer: string;
  readonly trialEnd: number;
  readonly periodEnd: number;
}

/** Full subscribe flow on a PLAIN fake (no test clock): checkout → complete → deliver both events. */
async function subscribeWorkspace(
  ws: Workspace,
  planId: "starter" | "pro" = "starter",
): Promise<SubscriptionFlow> {
  const fake = freshFake();
  setStripe(server, fake);
  const response = await billingPost("/v1/billing/checkout", ws, { planId });
  expect(response.status).toBe(201);
  const session = (await okData(response)) as { sessionId: string };
  const events = reid(fake.completeCheckout(session.sessionId));
  expect(events).toHaveLength(2);
  const created = await deliver(fake, at(events, 0));
  expect(created.status).toBe(200);
  const completed = await deliver(fake, at(events, 1));
  expect(completed.status).toBe(200);
  expect(completed.data).toMatchObject({ received: true, handled: "subscription.synced" });
  const wire = at(events, 0).data.object as Record<string, unknown>;
  const item = at((wire.items as { data: Record<string, unknown>[] }).data, 0);
  return {
    fake,
    wire,
    subId: wire.id as string,
    customer: wire.customer as string,
    trialEnd: wire.trial_end as number,
    periodEnd: item.current_period_end as number,
  };
}

/** Builds a customer.subscription.* wire object from the created subscription. */
function subscriptionObject(
  flow: SubscriptionFlow,
  overrides: { status?: string; periodEnd?: number },
): Record<string, unknown> {
  const items = flow.wire.items as { data: Record<string, unknown>[] };
  const periodEnd = overrides.periodEnd ?? (at(items.data, 0).current_period_end as number);
  return {
    ...flow.wire,
    ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    current_period_end: periodEnd,
    items: { ...items, data: [{ ...at(items.data, 0), current_period_end: periodEnd }] },
  };
}

/** Delivers a scripted lifecycle event on the flow's fake. */
async function lifecycle(
  flow: SubscriptionFlow,
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  object: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return deliver(flow.fake, script(flow.fake, type, object));
}

/** Delivers a scripted completed checkout that carries a card fingerprint. */
async function deliverCardCheckout(ws: Workspace, fingerprint: string): Promise<void> {
  const fake = freshFake();
  setStripe(server, fake);
  const delivered = await deliver(
    fake,
    script(fake, "checkout.session.completed", {
      id: `cs_card_${unique("s")}`,
      object: "checkout_session",
      mode: "payment",
      customer: `cus_card_${unique("c")}`,
      subscription: null,
      status: "complete",
      payment_status: "paid",
      metadata: {
        organizationId: ws.id,
        kind: "topup",
        packId: "credits100",
        microcredits: "1000000",
        cardFingerprint: fingerprint,
      },
    }),
  );
  expect(delivered.status).toBe(200);
  expect(delivered.data).toMatchObject({ handled: "topup.granted" });
  const customer = await repos().subscriptions.findStripeCustomer(ws.id);
  expect(customer?.cardFingerprint).toBe(fingerprint);
}

// ---------------------------------------------------------------------------
// Clocked subscribe (the fake's test clocks at the ROUTE level — new in M6-J)
// ---------------------------------------------------------------------------

interface ClockFlow extends SubscriptionFlow {
  readonly clockId: string;
}

/**
 * Full subscribe flow where the workspace's Stripe customer rides a TEST
 * CLOCK: the clocked seam is injected BEFORE any customer exists, so the
 * customer the checkout route creates is clock-attached and every lifecycle
 * timestamp is anchored to the fake's deterministic epoch (never the wall).
 */
async function clockedSubscribe(ws: Workspace, planId: "starter" | "pro"): Promise<ClockFlow> {
  const fake = freshFake();
  const clock = await fake.seam.createTestClock({ frozenTime: FAKE_NOW_SECONDS });
  if (!clock.ok) throw new Error("test bug: fake test clock unavailable");
  const clocked = fake.seam.withTestClock(clock.data.id);
  if (!clocked.ok) throw new Error("test bug: withTestClock failed");
  setStripeSeam(server, clocked.data);

  const response = await billingPost("/v1/billing/checkout", ws, { planId });
  expect(response.status).toBe(201);
  const session = (await okData(response)) as { sessionId: string };
  const events = reid(fake.completeCheckout(session.sessionId));
  expect(events).toHaveLength(2);
  const created = await deliver(fake, at(events, 0));
  expect(created.status).toBe(200);
  const completed = await deliver(fake, at(events, 1));
  expect(completed.status).toBe(200);
  expect(completed.data).toMatchObject({ received: true, handled: "subscription.synced" });

  const wire = at(events, 0).data.object as Record<string, unknown>;
  const item = at((wire.items as { data: Record<string, unknown>[] }).data, 0);
  const subId = wire.id as string;
  const sub = fake.subscriptions.get(subId);
  if (sub === undefined) throw new Error("test bug: fake subscription missing");
  return {
    fake,
    clockId: clock.data.id,
    wire,
    subId,
    customer: wire.customer as string,
    trialEnd: sub.trialEnd ?? 0,
    periodEnd: sub.currentPeriodEnd,
  };
}

/** Advances the flow's clock and returns the re-id'd emitted events. */
function clockAdvance(flow: ClockFlow, toSeconds: number): FakeStripeEvent[] {
  return reid(flow.fake.advanceTestClock(flow.clockId, toSeconds));
}

// ---------------------------------------------------------------------------
// Chat journey fixtures (duplicated in shape from tests/chat-loop.test.ts)
// ---------------------------------------------------------------------------

interface ChatFixture {
  readonly ws: Workspace;
  readonly projectId: string;
  readonly versionId: string;
  readonly threadId: string;
}

/** Seeds whole-credit chat fixtures straight through the ledger repo as D-12 µc. */
async function grantChatCredits(workspaceId: string, credits: number): Promise<void> {
  const microcredits = credits * 1_000_000; // D-12: 1 credit = 1_000_000 µc
  const seeded = await repos().ledger.grant(workspaceId, {
    amount: microcredits,
    idempotencyKey: unique("seed"),
  });
  expect(seeded.entry.amount).toBe(microcredits);
}

/** A workspace's project + ONE uploaded version + ONE thread. */
async function newChatFixture(ws: Workspace): Promise<ChatFixture> {
  const projectId = await createProject(ws);
  const bytes = Buffer.from(`{"m6j":"${unique("fx")}"}`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const versionResponse = await api(
    server.base,
    `/v1/projects/${projectId}/versions?sha256=${sha256}&sizeBytes=${bytes.byteLength}`,
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
  const threadResponse = await api(server.base, `/v1/projects/${projectId}/threads`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("thr") },
    body: { title: "M6-J journey thread" },
  });
  expect(threadResponse.status).toBe(201);
  const thread = (await threadResponse.json()) as { data: { id: string } };
  return { ws, projectId, versionId: version.data.id, threadId: thread.data.id };
}

interface ChatBody {
  readonly message: string;
  readonly context: Record<string, never>;
  readonly idempotencyKey: string;
  readonly pinned: readonly unknown[];
  readonly model?: "studio-fast" | "studio-smart";
}

/** Raw chat POST (the api() helper has no signal seam). */
async function chatStream(fx: ChatFixture, body: ChatBody): Promise<Response> {
  const headers: Record<string, string> = {
    origin: TEST_APP_ORIGIN,
    "content-type": "application/json",
    accept: "text/event-stream",
    cookie: fx.ws.jar.header,
    "x-workspace-id": fx.ws.id,
  };
  return fetch(`${server.base}/v1/threads/${fx.threadId}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function postToolResult(
  fx: ChatFixture,
  runId: string,
  toolCallId: string,
  result: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api(server.base, `/v1/runs/${runId}/events`, {
    method: "POST",
    jar: fx.ws.jar,
    headers: { "x-workspace-id": fx.ws.id, "idempotency-key": unique("toolresult") },
    body: { type: "tool.result", toolCallId, result },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postCancel(
  fx: ChatFixture,
  runId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api(server.base, `/v1/runs/${runId}/cancel`, {
    method: "POST",
    jar: fx.ws.jar,
    headers: { "x-workspace-id": fx.ws.id, "idempotency-key": unique("cancel") },
    body: { reason: "test" },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getRun(fx: ChatFixture, runId: string): Promise<RunRecord> {
  const response = await api(server.base, `/v1/runs/${runId}`, {
    jar: fx.ws.jar,
    headers: { "x-workspace-id": fx.ws.id },
  });
  const parsed = (await response.json()) as { data: RunRecord };
  return parsed.data;
}

async function runsOfThread(workspaceId: string, threadId: string): Promise<readonly AgentRun[]> {
  const page = await repos().runs.listByThread(workspaceId, threadId, {});
  return page.items;
}

/** Poll until probe() is true (the route emits terminal events BEFORE its DB writes). */
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

/** The ledger entries of one run (repo read; the endpoint walk is journey 7). */
async function ledgerOfRun(
  workspaceId: string,
  runId: string,
): Promise<readonly { kind: string; amount: number }[]> {
  const page = await repos().ledger.list(workspaceId, { runId });
  return page.items;
}

function kindsOf(entries: readonly { kind: string; amount: number }[]): Record<string, number[]> {
  const byKind: Record<string, number[]> = {};
  for (const entry of entries) {
    byKind[entry.kind] = [...(byKind[entry.kind] ?? []), entry.amount];
  }
  return byKind;
}

function sumAmounts(entries: readonly { amount: number }[]): number {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

/** The wire shape of GET /v1/credits/ledger entries (contracts LedgerEntry). */
interface LedgerEntryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly runId: string | null;
  readonly idempotencyKey: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

/** Walks GET /v1/credits/ledger through every cursor page. */
async function walkLedgerEndpoint(ws: Workspace, limit: number): Promise<LedgerEntryDto[]> {
  const entries: LedgerEntryDto[] = [];
  let cursor: string | null = null;
  for (;;) {
    const path =
      cursor === null
        ? `/v1/credits/ledger?limit=${limit}`
        : `/v1/credits/ledger?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
    const response = await api(server.base, path, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(response.status).toBe(200);
    const body = (await okData(response)) as { items: LedgerEntryDto[]; nextCursor: string | null };
    entries.push(...body.items);
    if (body.nextCursor === null) break;
    cursor = body.nextCursor;
  }
  return entries;
}

/** The wire shape of GET /v1/billing/invoices rows (contracts InvoiceRecord). */
interface InvoiceEntryDto {
  readonly id: string;
  readonly stripeInvoiceId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly hostedUrl: string | null;
  readonly pdfUrl: string | null;
  readonly createdAt: string;
}

/** Walks GET /v1/billing/invoices through every cursor page (F-J3 wire read). */
async function walkInvoicesEndpoint(ws: Workspace, limit: number): Promise<InvoiceEntryDto[]> {
  const rows: InvoiceEntryDto[] = [];
  let cursor: string | null = null;
  for (;;) {
    const path =
      cursor === null
        ? `/v1/billing/invoices?limit=${limit}`
        : `/v1/billing/invoices?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
    const response = await api(server.base, path, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(response.status).toBe(200);
    const body = (await okData(response)) as {
      items: InvoiceEntryDto[];
      nextCursor: string | null;
    };
    rows.push(...body.items);
    if (body.nextCursor === null) break;
    cursor = body.nextCursor;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Journey 1 — no permanent free path (exit criterion: card-required trial)
// ---------------------------------------------------------------------------

d("M6-J journey 1 — no permanent free path", () => {
  it("a brand-new workspace cannot start a trial without a card; WITH a card the 14-day trial starts on the Starter row and gates /v1/models to exactly [studio-fast] — and a studio-smart RUN is 403", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);

    // (1) No card on file → the trial REFUSES to start (the fake models no
    // payment method for a brand-new workspace: there is no customer row).
    const refused = await billingPost("/v1/billing/trial", ws, {});
    expect(refused.status).toBe(400);
    expect((await errOf(refused)).code).toBe("VALIDATION_FAILED");
    expect(await subscriptionRow(ws.id)).toBeNull();

    // (2) The refusal opened no free path: the workspace still gates as the
    // trial tier with exactly the trial catalog models.
    const before = await modelsOf(ws);
    expect(before.plan).toBe("trial");
    expect(before.models).toEqual(["studio-fast"]);

    // (3) Add a card (the fake's card model: the fingerprint rides checkout
    // metadata; real Stripe attaches it with the payment method).
    await deliverCardCheckout(ws, unique("fp"));

    // (4) The trial starts: row on the STARTER row (D-4), trialEnd = 14 days.
    const response = await billingPost("/v1/billing/trial", ws, {});
    expect(response.status).toBe(201);
    const body = (await okData(response)) as { trialStarted: boolean; trialEnd: string };
    expect(body.trialStarted).toBe(true);
    const expectedEnd = Date.now() + 14 * DAY_MS;
    expect(Math.abs(new Date(body.trialEnd).getTime() - expectedEnd)).toBeLessThan(5 * 60 * 1000);

    const row = await subscriptionRow(ws.id);
    expect(row?.planId).toBe("starter"); // D-4: the state lives on the Starter row
    expect(row?.status).toBe("trialing");
    expect(row?.trialEnd?.toISOString()).toBe(body.trialEnd);

    // (5) Entitlements from the catalog gate the model surface (trial tier).
    const state = await billingState(ws);
    expect(state).toMatchObject({ plan: "trial", status: "trialing" });
    const entitlements = state.entitlements as Record<string, unknown>;
    expect(entitlements.models).toEqual(["studio-fast"]);
    expect(entitlements.seats).toBe(1);
    expect(entitlements.monthlyCreditAllowance).toBe(50_000_000); // 50 credits, µc (D-12)
    const after = await modelsOf(ws);
    expect(after.plan).toBe("trial");
    expect(after.models).toEqual(["studio-fast"]);

    // (6) The RUN-level gate (the picker is advisory; this is the server-side
    // enforcement): studio-smart on the trial tier → 403 before any model
    // call. The card-checkout grant left a 1 µc balance, so the credit
    // precheck passes and the MODEL gate is what fires.
    const fx = await newChatFixture(ws);
    const chat = await chatStream(fx, {
      message: "make it cinematic",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
      model: "studio-smart",
    });
    expect(chat.status).toBe(403);
    const parsed = await envelope(chat);
    expect(parsed.err).toMatchObject({ code: "MODEL_NOT_ENTITLED", retryable: false });
    expect(openai.calls.length).toBe(0); // no model call was ever made
    expect((await runsOfThread(ws.id, fx.threadId)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — trial→paid conversion (exit criterion: billing state gates
// models/seats/storage/renders server-side)
// ---------------------------------------------------------------------------

d("M6-J journey 2 — trial→paid conversion", () => {
  it("checkout → webhook completes → test-clock conversion → active: the models picker widens to [studio-fast, studio-smart], seats/storage/render gates come from entitlementsFor, and the studio-smart RUN gate flips", async () => {
    const ws = await newWorkspace();
    const flow = await clockedSubscribe(ws, "pro");

    // While TRIALING the workspace gates as the TRIAL tier (D-4) — even on
    // the pro row, the picker stays [studio-fast].
    const row = await subscriptionRow(ws.id);
    expect(row?.planId).toBe("pro");
    expect(row?.status).toBe("trialing");
    expect((await modelsOf(ws)).models).toEqual(["studio-fast"]);

    // Stripe test clock: past trialEnd the subscription converts (the
    // customer.subscription.updated webhook lands the transition).
    const conversion = clockAdvance(flow, flow.trialEnd + 1);
    expect(conversion).toHaveLength(1);
    expect(at(conversion, 0).type).toBe("customer.subscription.updated");
    const delivered = await deliver(flow.fake, at(conversion, 0));
    expect(delivered.status).toBe(200);
    expect(delivered.data).toMatchObject({ handled: "subscription.active" });
    expect((await subscriptionRow(ws.id))?.status).toBe("active");

    // The picker WIDENS server-side — exactly the paid catalog pair.
    const models = await modelsOf(ws);
    expect(models.plan).toBe("pro");
    expect(models.models).toEqual(["studio-fast", "studio-smart"]);

    // Seats/storage/render gates come from entitlementsFor — the catalog,
    // never a route-local table (M6-A numbers pinned).
    const state = await billingState(ws);
    expect(state).toMatchObject({ plan: "pro", status: "active" });
    expect(state.entitlements).toEqual({
      seats: 5,
      models: ["studio-fast", "studio-smart"],
      maxProjects: 50,
      storageBytes: 200 * 1024 ** 3,
      renderMinutesPerMonth: 600,
      monthlyCreditAllowance: 2_000_000_000,
    });

    // /v1/credits reads the paid plan + its integer-µc allowance (D-12).
    const credits = await creditsOf(ws);
    expect(credits.plan).toBe("pro");
    expect(credits.includedCredits).toBe(2_000_000_000);

    // The RUN-level gate flips with billing state: studio-smart — 403 on the
    // trial tier (journey 1) — now streams and completes.
    await grantChatCredits(ws.id, 100);
    const fx = await newChatFixture(ws);
    openai.enqueue(textRound("Smart is online."));
    const chat = await chatStream(fx, {
      message: "plan a fancy intro",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
      model: "studio-smart",
    });
    expect(chat.status).toBe(200);
    const stream = new SseStream(chat);
    const frames = await stream.rest();
    const events = expectValidStream(frames);
    expect(events[0]).toMatchObject({ type: "run.started", model: "studio-smart" });
    expect(typeSeq(events)).toEqual(["run.started", "message.delta", "credits", "run.completed"]);
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — money conservation (exit criteria: no negative balance; a
// failed/cancelled run refunds fully; a successful run commits actual usage)
// ---------------------------------------------------------------------------

d("M6-J journey 3 — money conservation across runs", () => {
  it("grant 50 credits (µc) → a completed tool-round-trip run nets EXACTLY the usage commit (D-20 full-hold release); a cancelled run refunds fully; zero/near-zero runs 402 BEFORE run.started and the balance never goes negative", async () => {
    const ws = await newWorkspace();
    const GRANT = 50_000_000; // 50 credits, integer µc (D-12)
    const seeded = await repos().ledger.grant(ws.id, {
      amount: GRANT,
      idempotencyKey: unique("grant"),
    });
    expect(seeded.entry.amount).toBe(GRANT);
    expect(seeded.entry.balanceAfter).toBe(GRANT);
    const fx = await newChatFixture(ws);

    // ── a completed run with a real client tool round-trip ────────────────
    openai.enqueue(getContextRound("call_m6j_money_1"), answerFromToolResult());
    const first = await chatStream(fx, {
      message: "what's on this comp?",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    expect(first.status).toBe(200);
    const firstStream = new SseStream(first);
    const head = await firstStream.until((event) => event.type === "tool.started", "tool.started");
    const headEvents = expectValidStream(head, { requireTerminal: false });
    const runId = headEvents[0]?.runId;
    if (runId === undefined) throw new Error("no run.started event");
    const posted = await postToolResult(fx, runId, "call_m6j_money_1", {
      activeComp: { name: "Main" },
    });
    expect(posted.status).toBe(200);
    const tail = await firstStream.rest();
    const all = expectValidStream([...head, ...tail]);
    expect(joinedText(all)).toBe("The comp Main has 1 layer.");
    expect(findCredits(all)).toMatchObject({
      reserved: 2,
      committed: 1,
      // DISPLAY units (D-12): the µc ledger balance (49_000_000) shown as
      // whole credits — the SSE event conversion M6-K landed.
      balance: 49,
    });
    await waitFor("run completion", async () => (await getRun(fx, runId)).status === "completed");

    // D-20 settle semantics (µc, D-12): entries reserve −2_000_000 /
    // commit −1_000_000 / refund +2_000_000 — the FULL hold is released, so
    // the run nets exactly the usage commit (1 credit).
    const runEntries = await ledgerOfRun(ws.id, runId);
    const byKind = kindsOf(runEntries);
    expect(byKind.reserve).toEqual([-2 * 1_000_000]);
    expect(byKind.commit).toEqual([-1 * 1_000_000]);
    expect(byKind.refund).toEqual([2 * 1_000_000]);
    expect(sumAmounts(runEntries)).toBe(-1 * 1_000_000);
    expect(await balanceOf(ws.id)).toBe(GRANT - 1 * 1_000_000);

    // ── a cancelled run refunds fully (nets exactly 0) ────────────────────
    openai.enqueue(getContextRound("call_m6j_money_2"), answerFromToolResult());
    const second = await chatStream(fx, {
      message: "and now?",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    const secondStream = new SseStream(second);
    const secondHead = await secondStream.until(
      (event) => event.type === "tool.started",
      "tool.started",
    );
    const cancelledRunId = expectValidStream(secondHead, { requireTerminal: false })[0]?.runId;
    if (cancelledRunId === undefined) throw new Error("no run.started event");
    const cancel = await postCancel(fx, cancelledRunId);
    expect(cancel.status).toBe(200);
    const secondTail = await secondStream.rest();
    const secondAll = expectValidStream([...secondHead, ...secondTail]);
    expect(secondAll.at(-1)).toMatchObject({ type: "run.cancelled" });
    await waitFor(
      "the cancelled run row",
      async () => (await getRun(fx, cancelledRunId)).status === "cancelled",
    );
    const cancelEntries = await ledgerOfRun(ws.id, cancelledRunId);
    const cancelKinds = kindsOf(cancelEntries);
    expect(cancelKinds.reserve).toEqual([-2 * 1_000_000]);
    expect(cancelKinds.refund).toEqual([2 * 1_000_000]);
    expect(cancelKinds.commit).toBeUndefined(); // usage never committed
    expect(sumAmounts(cancelEntries)).toBe(0);
    expect(await balanceOf(ws.id)).toBe(GRANT - 1 * 1_000_000); // unchanged: full refund

    // ── never negative, part 1: EXACT ZERO → the route gate 402s before any
    // run.started — no run row, no ledger row, no model call ───────────────
    await repos().ledger.adjust(ws.id, {
      amount: -(GRANT - 1 * 1_000_000),
      idempotencyKey: unique("drain"),
    });
    expect(await balanceOf(ws.id)).toBe(0);
    const runsBefore = (await runsOfThread(ws.id, fx.threadId)).length;
    const entriesBefore = (await repos().ledger.list(ws.id, {})).items.length;
    openai.enqueue(textRound("unused"));
    const third = await chatStream(fx, {
      message: "one more thing",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    expect(third.status).toBe(402);
    expect((await envelope(third)).err).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      retryable: false,
    });
    expect(openai.calls.length).toBe(3); // only the two settled runs above
    expect((await runsOfThread(ws.id, fx.threadId)).length).toBe(runsBefore);
    expect((await repos().ledger.list(ws.id, {})).items.length).toBe(entriesBefore);
    expect(await balanceOf(ws.id)).toBe(0);

    // ── never negative, part 2: balance 1 credit < reserve 2 credits → the
    // LEDGER reserve gate refuses the hold (1_000_000 µc < 2_000_000 µc) —
    // 402, the run row records the failure, and the balance stays ≥ 0 ─────
    await grantChatCredits(ws.id, 1);
    openai.enqueue(textRound("unused"));
    const fourth = await chatStream(fx, {
      message: "still one more",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    expect(fourth.status).toBe(402);
    expect((await envelope(fourth)).err).toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    const threadRuns = await runsOfThread(ws.id, fx.threadId);
    // listByThread is newest-first: the refused hold is the newest row.
    const refusedRun = at(threadRuns, 0);
    // F-J5 FIXED (2026-10-24): queued→failed is legal, so the refused hold
    // lands an HONEST terminal row (failed + INSUFFICIENT_CREDITS) instead of
    // the pre-fix orphaned-queued drift. No ledger row for the hold, still.
    expect(refusedRun.status).toBe("failed");
    expect(refusedRun.errorCode).toBe("INSUFFICIENT_CREDITS");
    expect(await balanceOf(ws.id)).toBe(1 * 1_000_000); // never negative

    // The invariant across EVERY entry written by the journey so far.
    const everyEntry = (await repos().ledger.list(ws.id, {})).items;
    expect(everyEntry.length).toBeGreaterThan(0);
    for (const entry of everyEntry) {
      expect(Number.isInteger(entry.balanceAfter)).toBe(true);
      expect(entry.balanceAfter).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Journey 4 — the top-up journey (BP §M6 task 2; D-12)
// ---------------------------------------------------------------------------

d("M6-J journey 4 — top-up journey", () => {
  it("zero balance 402s → pack checkout → webhook grants the INTEGER µc (D-12) → a run that would have 402'd before now completes", async () => {
    const ws = await newWorkspace();
    const fx = await newChatFixture(ws);
    expect(await balanceOf(ws.id)).toBe(0);

    // (1) The would-be run is refused at zero balance (the before picture).
    openai.enqueue(textRound("unused"));
    const refused = await chatStream(fx, {
      message: "what's on this comp?",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    expect(refused.status).toBe(402);
    expect((await envelope(refused)).err).toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(openai.calls.length).toBe(0);

    // (2) Buy the pack through the real topup route + the fake Checkout.
    const fake = freshFake();
    setStripe(server, fake);
    const response = await billingPost("/v1/billing/topup", ws, { packId: "credits100" });
    expect(response.status).toBe(201);
    const session = (await okData(response)) as { sessionId: string; url: string };
    expect(session.url).toContain("checkout.stripe.com/fake/");
    const events = reid(fake.completeCheckout(session.sessionId));
    expect(events).toHaveLength(1);
    const delivered = await deliver(fake, at(events, 0));
    expect(delivered.status).toBe(200);
    expect(delivered.data).toMatchObject({ received: true, handled: "topup.granted" });

    // (3) The grant is an INTEGER microcredit amount (D-12:
    // 100 credits = exactly 100_000_000 µc), with its Stripe provenance.
    expect(await balanceOf(ws.id)).toBe(100_000_000);
    const entries = (await repos().ledger.list(ws.id, {})).items;
    const grantEntry = entries.find((entry) => entry.kind === "grant");
    expect(grantEntry?.amount).toBe(100_000_000);
    expect(Number.isInteger(grantEntry?.amount ?? 0)).toBe(true);
    const grantMetadata = (grantEntry?.metadata as Record<string, unknown> | null) ?? {};
    expect(grantMetadata.kind).toBe("topup");
    expect(grantMetadata.packId).toBe("credits100");
    expect(typeof grantMetadata.stripeEventId).toBe("string");

    // Visible on both read surfaces.
    const credits = await creditsOf(ws);
    expect(credits.balance).toBe(100_000_000);
    const state = await billingState(ws);
    expect((state.credits as Record<string, unknown>).balance).toBe(100_000_000);

    // (4) The journey's run now goes through — same request shape that 402'd.
    openai.enqueue(textRound("Back in business."));
    const second = await chatStream(fx, {
      message: "what's on this comp?",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    expect(second.status).toBe(200);
    const stream = new SseStream(second);
    const frames = await stream.rest();
    const events2 = expectValidStream(frames);
    expect(events2.at(-1)).toMatchObject({ type: "run.completed" });
    expect(findCredits(events2).committed).toBe(1);
    expect(await balanceOf(ws.id)).toBe(100_000_000 - 1_000_000);
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — past-due grace via the test clock (BP §M6 task 2 + §M6.6;
// exit criteria: no work deletion on cancel; no permanent free path)
// ---------------------------------------------------------------------------

d("M6-J journey 5 — past-due grace (test clock)", () => {
  it("clock: failing renewal → past_due → grace with graceEnd, entitlements honored (a studio-smart run completes) → cancel at the grace period end → canceled, and projects/versions/ledger counts are INTACT", async () => {
    const ws = await newWorkspace();
    const flow = await clockedSubscribe(ws, "pro");
    await grantChatCredits(ws.id, 100);
    const fx = await newChatFixture(ws);

    // (1) Conversion: the clock passes trialEnd → active (the pro plan).
    const conversion = clockAdvance(flow, flow.trialEnd + 1);
    expect(conversion).toHaveLength(1);
    const conversionDelivered = await deliver(flow.fake, at(conversion, 0));
    expect(conversionDelivered.data).toMatchObject({ handled: "subscription.active" });
    expect((await subscriptionRow(ws.id))?.status).toBe("active");

    // (2) Real work exists before the dunning arc: a completed run + the
    // project/version/thread rows.
    openai.enqueue(textRound("Pre-dunning answer."));
    const seededRun = await chatStream(fx, {
      message: "describe the comp",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
      model: "studio-smart",
    });
    expect(seededRun.status).toBe(200);
    const seededStream = new SseStream(seededRun);
    const seededFrames = await seededStream.rest();
    expectValidStream(seededFrames);
    const seededRunId = (seededFrames[0]?.event as { runId?: string }).runId;
    if (seededRunId === undefined) throw new Error("no seeded runId");
    await waitFor(
      "seed run completion",
      async () => (await getRun(fx, seededRunId)).status === "completed",
    );

    // (3) Failing renewal at the period end → past_due → GRACE with graceEnd.
    flow.fake.setPaymentFailing(flow.customer, true);
    const graceEvents = clockAdvance(flow, flow.periodEnd + 1);
    expect(graceEvents).toHaveLength(1);
    const graceDelivered = await deliver(flow.fake, at(graceEvents, 0));
    expect(graceDelivered.status).toBe(200);
    expect(graceDelivered.data).toMatchObject({ handled: "subscription.grace" });
    const row = await subscriptionRow(ws.id);
    expect(row?.status).toBe("grace");
    expect(row?.planId).toBe("pro"); // dunning keeps the paid plan
    const expectedGraceEnd = new Date((flow.periodEnd + 30 * DAY) * 1000);
    expect(row?.graceEnd?.getTime()).toBe(expectedGraceEnd.getTime());

    // (4) Entitlements are STILL honored during grace: the state gates as
    // the row's plan, the picker stays wide, and a studio-smart RUN
    // completes (dunning never strips paid entitlements mid-grace).
    const state = await billingState(ws);
    expect(state).toMatchObject({
      plan: "pro",
      status: "grace",
      graceEnd: expectedGraceEnd.toISOString(),
    });
    expect((state.entitlements as Record<string, unknown>).models).toEqual([
      "studio-fast",
      "studio-smart",
    ]);
    expect((await modelsOf(ws)).models).toEqual(["studio-fast", "studio-smart"]);
    openai.enqueue(textRound("Dunning, but still editing."));
    const duringGrace = await chatStream(fx, {
      message: "one small tweak",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
      model: "studio-smart",
    });
    expect(duringGrace.status).toBe(200);
    const graceStream = new SseStream(duringGrace);
    const graceRunFrames = await graceStream.rest();
    const graceRunEvents = expectValidStream(graceRunFrames);
    expect(graceRunEvents.at(-1)).toMatchObject({ type: "run.completed" });
    const graceRunId = graceRunEvents[0]?.runId;
    if (graceRunId === undefined) throw new Error("no grace runId");
    await waitFor(
      "grace run completion",
      async () => (await getRun(fx, graceRunId)).status === "completed",
    );

    // Snapshot every count RIGHT BEFORE the cancellation (the run rows above
    // are part of the work that must survive).
    const projectsBefore = (
      (await okData(
        await api(server.base, "/v1/projects", {
          jar: ws.jar,
          headers: { "x-workspace-id": ws.id },
        }),
      )) as { items: unknown[] }
    ).items.length;
    const versionsBefore = (await repos().versions.list(ws.id, fx.projectId, {})).items.length;
    const ledgerBefore = (await repos().ledger.list(ws.id, {})).items.length;
    const balanceBefore = await balanceOf(ws.id);

    // (5) The clock passes the grace period end → customer.subscription.
    // deleted → status canceled (BP §M6.2: STATUS ONLY — no work deletion).
    const cancelEvents = clockAdvance(flow, flow.periodEnd + 30 * DAY + 1);
    expect(cancelEvents).toHaveLength(1);
    expect(at(cancelEvents, 0).type).toBe("customer.subscription.deleted");
    const cancelDelivered = await deliver(flow.fake, at(cancelEvents, 0));
    expect(cancelDelivered.status).toBe(200);
    expect(cancelDelivered.data).toMatchObject({ handled: "subscription.canceled" });
    const canceledRow = await subscriptionRow(ws.id);
    expect(canceledRow?.status).toBe("canceled");
    expect(canceledRow?.graceEnd).toBeNull();

    // (6) The work is INTACT — same counts, same version head, same money.
    const projectsAfter = (
      (await okData(
        await api(server.base, "/v1/projects", {
          jar: ws.jar,
          headers: { "x-workspace-id": ws.id },
        }),
      )) as { items: unknown[] }
    ).items.length;
    expect(projectsAfter).toBe(projectsBefore);
    const projectGet = await api(server.base, `/v1/projects/${fx.projectId}`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(projectGet.status).toBe(200);
    const project = (await okData(projectGet)) as { currentVersionId: string | null };
    expect(project.currentVersionId).toBe(fx.versionId);
    expect((await repos().versions.list(ws.id, fx.projectId, {})).items.length).toBe(
      versionsBefore,
    );
    expect((await repos().ledger.list(ws.id, {})).items.length).toBe(ledgerBefore);
    expect(await balanceOf(ws.id)).toBe(balanceBefore);

    // (7) No permanent free path: a canceled workspace gates as TRIAL —
    // the picker narrows and a studio-smart RUN is 403 again.
    const afterState = await billingState(ws);
    expect(afterState).toMatchObject({ plan: "trial", status: "canceled" });
    expect((await modelsOf(ws)).models).toEqual(["studio-fast"]);
    openai.enqueue(textRound("unused"));
    const refused = await chatStream(fx, {
      message: "one more smart thing",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
      model: "studio-smart",
    });
    expect(refused.status).toBe(403);
    expect((await envelope(refused)).err).toMatchObject({ code: "MODEL_NOT_ENTITLED" });
  });
});

// ---------------------------------------------------------------------------
// Journey 6 — adversarial webhook tail (the M6-C matrix complement)
// ---------------------------------------------------------------------------

d("M6-J journey 6 — adversarial webhook tail", () => {
  it("replay under a FRESH event id with the SAME payload object after a transition: the from-guard rejects the double-apply — never flagged duplicate, never resurrects", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "pro");

    // The live arc: conversion → active, cancellation → canceled.
    const converted = await lifecycle(
      flow,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    expect(converted.data).toMatchObject({ handled: "subscription.active" });
    const canceled = await lifecycle(
      flow,
      "customer.subscription.deleted",
      subscriptionObject(flow, { status: "canceled" }),
    );
    expect(canceled.data).toMatchObject({ handled: "subscription.canceled" });
    expect((await subscriptionRow(ws.id))?.status).toBe("canceled");
    const balance = await balanceOf(ws.id);

    // (a) The SAME conversion object re-delivered under a FRESH event id:
    // the durable dedup cannot catch it (new id), so the from-guard must —
    // canceled ∉ active's from-list. Audited 200, never duplicate:true.
    const replayConversion = script(
      flow.fake,
      "customer.subscription.updated",
      subscriptionObject(flow, { status: "active" }),
    );
    const replayedConversion = await deliver(flow.fake, replayConversion);
    expect(replayedConversion.status).toBe(200);
    expect(replayedConversion.data).toMatchObject({ ignored: "transition-guarded" });
    expect(replayedConversion.data.duplicate).toBeUndefined();

    // (b) The SAME deleted object under a FRESH id: also guarded (canceled
    // ∉ canceled's from-list) — the terminal state is never re-applied.
    const replayCancel = script(
      flow.fake,
      "customer.subscription.deleted",
      subscriptionObject(flow, { status: "canceled" }),
    );
    const replayedCancel = await deliver(flow.fake, replayCancel);
    expect(replayedCancel.status).toBe(200);
    expect(replayedCancel.data).toMatchObject({ ignored: "transition-guarded" });

    // The row stays canceled; the money is untouched.
    expect((await subscriptionRow(ws.id))?.status).toBe("canceled");
    expect(await balanceOf(ws.id)).toBe(balance);
  });

  it("out-of-order renewal-before-conversion: the late conversion's OLDER period is rejected — the row's period never moves backwards", async () => {
    const ws = await newWorkspace();
    const flow = await subscribeWorkspace(ws, "starter");
    const nextPeriod = flow.periodEnd + 30 * DAY;

    // The RENEWAL (real time: later — active, period P2) delivered FIRST:
    // converts the trialing row early and advances the period.
    const renewal = await deliver(
      flow.fake,
      script(
        flow.fake,
        "customer.subscription.updated",
        subscriptionObject(flow, { status: "active", periodEnd: nextPeriod }),
      ),
    );
    expect(renewal.data).toMatchObject({ handled: "subscription.active" });
    const row = await subscriptionRow(ws.id);
    expect(row?.status).toBe("active");
    expect(row?.currentPeriodEnd?.getTime()).toBe(nextPeriod * 1000);

    // The CONVERSION (real time: EARLIER — active, the ORIGINAL period P1)
    // arrives late. The from-list allows active←active (idempotent re-pin)
    // but the period-backwards regression is REJECTED: P1 < P2 never lands.
    const conversion = await deliver(
      flow.fake,
      script(
        flow.fake,
        "customer.subscription.updated",
        subscriptionObject(flow, { status: "active" }),
      ),
    );
    expect(conversion.status).toBe(200);
    const after = await subscriptionRow(ws.id);
    expect(after?.status).toBe("active");
    expect(after?.currentPeriodEnd?.getTime()).toBe(nextPeriod * 1000); // NOT P1
  });

  it("signature tamper at the route: wrong secret / forged v1 / stale timestamp → 400 VALIDATION_FAILED, zero state change", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);
    const event = script(fake, "checkout.session.completed", {
      id: `cs_sig_${unique("s")}`,
      object: "checkout_session",
      mode: "payment",
      customer: `cus_sig_${unique("c")}`,
      subscription: null,
      status: "complete",
      payment_status: "paid",
      metadata: {
        organizationId: ws.id,
        kind: "topup",
        packId: "credits100",
        microcredits: "100000000",
      },
    });

    // (a) Correct format, WRONG secret — an attacker with the payload but
    // not the signing key.
    const wrongSecret = fake.signWebhook(event, { secret: "whsec_attacker_secret" });
    const wrongSecretResponse = await api(server.base, "/v1/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": wrongSecret.signature },
      rawBody: new Uint8Array(wrongSecret.payload),
    });
    expect(wrongSecretResponse.status).toBe(400);
    expect((await errOf(wrongSecretResponse)).code).toBe("VALIDATION_FAILED");

    // (b) Valid payload + timestamp, FORGED v1 digest.
    const signed = fake.signWebhook(event);
    const forged = signed.signature.replace(/v1=[0-9a-f]+/, "v1=deadbeef");
    const forgedResponse = await api(server.base, "/v1/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": forged },
      rawBody: new Uint8Array(signed.payload),
    });
    expect(forgedResponse.status).toBe(400);
    expect((await errOf(forgedResponse)).code).toBe("VALIDATION_FAILED");

    // (c) Correctly signed but STALE (outside the 300s tolerance).
    const stale = fake.signWebhook(event, { timestampSeconds: FAKE_NOW_SECONDS - 3600 });
    const staleResponse = await api(server.base, "/v1/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": stale.signature },
      rawBody: new Uint8Array(stale.payload),
    });
    expect(staleResponse.status).toBe(400);
    expect((await errOf(staleResponse)).code).toBe("VALIDATION_FAILED");

    // Zero state change: no grant, no subscription row.
    expect(await balanceOf(ws.id)).toBe(0);
    expect(await subscriptionRow(ws.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Journey 7 — reconciliation visibility (exit criterion: invoices and the
// ledger are visible and correct)
// ---------------------------------------------------------------------------

d("M6-J journey 7 — reconciliation visibility", () => {
  it("after the journey, GET /v1/credits/ledger surfaces EVERY entry (cursor walk), all parse against the wire kind schema, and the kinds reconcile (Σ = balance = newest balanceAfter; Σ|commit| = committed usage); invoice.paid is recorded and listed", async () => {
    const ws = await newWorkspace();
    const fake = freshFake();
    setStripe(server, fake);

    // The journey: a top-up grant, one completed run, one cancelled run,
    // one paid invoice.
    const topup = await billingPost("/v1/billing/topup", ws, { packId: "credits100" });
    expect(topup.status).toBe(201);
    const session = (await okData(topup)) as { sessionId: string };
    const topupEvents = reid(fake.completeCheckout(session.sessionId));
    const topupDelivered = await deliver(fake, at(topupEvents, 0));
    expect(topupDelivered.data).toMatchObject({ handled: "topup.granted" });

    const fx = await newChatFixture(ws);

    // Completed run (actual usage commits).
    openai.enqueue(textRound("Reconciliation run."));
    const first = await chatStream(fx, {
      message: "summarize the comp",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    expect(first.status).toBe(200);
    const firstStream = new SseStream(first);
    const firstFrames = await firstStream.rest();
    const firstEvents = expectValidStream(firstFrames);
    const completedRunId = firstEvents[0]?.runId;
    if (completedRunId === undefined) throw new Error("no completed runId");
    expect(findCredits(firstEvents).committed).toBe(1);
    await waitFor(
      "completed run row",
      async () => (await getRun(fx, completedRunId)).status === "completed",
    );

    // Cancelled run (full refund).
    openai.enqueue(getContextRound("call_m6j_recon_1"), answerFromToolResult());
    const second = await chatStream(fx, {
      message: "what's on this comp?",
      context: {},
      idempotencyKey: unique("chat"),
      pinned: [],
    });
    const secondStream = new SseStream(second);
    const secondHead = await secondStream.until(
      (event) => event.type === "tool.started",
      "tool.started",
    );
    const cancelledRunId = expectValidStream(secondHead, { requireTerminal: false })[0]?.runId;
    if (cancelledRunId === undefined) throw new Error("no cancelled runId");
    const cancel = await postCancel(fx, cancelledRunId);
    expect(cancel.status).toBe(200);
    await waitFor(
      "cancelled run row",
      async () => (await getRun(fx, cancelledRunId)).status === "cancelled",
    );
    const completedRun = await getRun(fx, completedRunId);
    const cancelledRun = await getRun(fx, cancelledRunId);
    expect(completedRun.committedCredits).toBe(1);
    expect(cancelledRun.committedCredits).toBe(0);

    // A paid invoice for the workspace (recorded + listed — M6-D repo) and
    // WIRE-READABLE (F-J3, landed by M6-K: GET /v1/billing/invoices below).
    const invoiceDelivered = await deliver(
      fake,
      script(fake, "invoice.paid", {
        id: `in_m6j_${unique("i")}`,
        object: "invoice",
        customer: `cus_m6j_${unique("c")}`,
        subscription: null,
        amount_paid: 1200,
        currency: "usd",
        status: "paid",
        metadata: { organizationId: ws.id, kind: "subscription" },
      }),
    );
    expect(invoiceDelivered.status).toBe(200);
    expect(invoiceDelivered.data).toMatchObject({ handled: "invoice.paid" });
    const invoices = await repos().invoices.list(ws.id, { limit: 10 });
    expect(invoices.items).toHaveLength(1);
    expect(invoices.items[0]?.amountCents).toBe(1200);
    expect(invoices.items[0]?.currency).toBe("usd");
    expect(invoices.items[0]?.status).toBe("paid");

    // (0) F-J3 wire read: GET /v1/billing/invoices walks the SAME row through
    // the real route — limit 1 forces the cursor walk — with the exact wire
    // shape (money in cents, never credits) and NO extra fields.
    const invoiceRows = await walkInvoicesEndpoint(ws, 1);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0]).toEqual({
      id: invoices.items[0]?.id,
      stripeInvoiceId: invoices.items[0]?.stripeInvoiceId,
      amountCents: 1200,
      currency: "usd",
      status: "paid",
      periodStart: null,
      periodEnd: null,
      hostedUrl: null,
      pdfUrl: null,
      createdAt: invoices.items[0]?.createdAt.toISOString(),
    });
    // Tenant isolation (law #3): a stranger's workspace sees an empty page,
    // never this workspace's rows.
    const stranger = await newWorkspace();
    expect(await walkInvoicesEndpoint(stranger, 10)).toEqual([]);

    // (1) The ledger is VISIBLE: walk the endpoint through every cursor
    // page (limit 2 forces multiple pages over the journey's entries).
    const entries = await walkLedgerEndpoint(ws, 2);
    expect(entries.length).toBeGreaterThanOrEqual(6); // grant + 3 + 2 run entries
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);

    // (2) Every entry PARSES against the wire shape (law #1 — contracts'
    // LedgerEntry is interface-typed, so the kind enum is schema-checked and
    // every field is shape-checked here).
    for (const entry of entries) {
      expect(LEDGER_KIND_SCHEMA.safeParse(entry.kind).success).toBe(true);
      expect(typeof entry.id).toBe("string");
      expect(entry.id).not.toBe("");
      expect(typeof entry.workspaceId).toBe("string");
      expect(Number.isInteger(entry.amount)).toBe(true);
      expect(Number.isInteger(entry.balanceAfter)).toBe(true);
      expect(entry.balanceAfter).toBeGreaterThanOrEqual(0);
      expect(entry.runId === null || typeof entry.runId === "string").toBe(true);
      expect(typeof entry.idempotencyKey).toBe("string");
      expect(entry.metadata).not.toBeNull();
      expect(typeof entry.metadata).toBe("object");
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
    }

    // (3) The kinds RECONCILE: the sum of every amount equals the balance
    // on every surface, and the newest entry's balanceAfter is that sum.
    const total = sumAmounts(entries);
    expect(total).toBe(100_000_000 - 1_000_000); // the top-up grant minus the one commit
    const balance = await balanceOf(ws.id);
    expect(total).toBe(balance);
    const credits = await creditsOf(ws);
    expect(credits.balance).toBe(balance);
    expect(credits.reserved).toBe(0); // D-20: no live holds after settle/refund
    const state = await billingState(ws);
    expect((state.credits as Record<string, unknown>).balance).toBe(balance);
    expect(at(entries, 0).balanceAfter).toBe(balance); // newest-first

    // Σ|commit| equals the committed usage the runs recorded (the row is
    // whole credits, the ledger µc — ×1_000_000 reconciles the dialects).
    const commits = entries.filter((entry) => entry.kind === "commit");
    expect(commits).toHaveLength(1);
    expect(Math.abs(sumAmounts(commits))).toBe((completedRun.committedCredits ?? 0) * 1_000_000);

    // Per-run conservation: completed nets exactly −commit; cancelled nets 0.
    const completedEntries = entries.filter((entry) => entry.runId === completedRunId);
    expect(completedEntries.length).toBe(3); // reserve + commit + refund
    expect(sumAmounts(completedEntries)).toBe(-(completedRun.committedCredits ?? 0) * 1_000_000);
    const cancelledEntries = entries.filter((entry) => entry.runId === cancelledRunId);
    expect(cancelledEntries.length).toBe(2); // reserve + refund
    expect(sumAmounts(cancelledEntries)).toBe(0);

    // The top-up grant row is visible with its Stripe provenance.
    const grantEntry = entries.find((entry) => entry.kind === "grant");
    expect(grantEntry?.amount).toBe(100_000_000);
    const grantMetadata = (grantEntry?.metadata as Record<string, unknown> | null) ?? {};
    expect(grantMetadata.kind).toBe("topup");
    expect(typeof grantMetadata.stripeEventId).toBe("string");
  });
});
