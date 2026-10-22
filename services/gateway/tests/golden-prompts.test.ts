// M5-M — the GOLDEN PROMPTS evidence suite (BUILD_PLAN §M5 task 8 + exit
// criterion "At least 10 representative prompts apply successfully on the
// corpus project"). Drives every fixture in ./golden-plans.ts through the
// REAL pipeline three ways:
//
//   1. FIXTURE SELF-CHECKS (M4-N corpus precedent): every scriptedModelPlan
//      PASSES EDIT_PLAN_SCHEMA.parse, every expected command id is in
//      AGENT_COMMAND_IDS (and never a META transport id), credits match
//      estimateCredits for the server-recomputed risk, all 10 required
//      §M5-task-8 scenarios are covered, and every layer reference is BY NAME.
//
//   2. DIRECT COMPILE (compiler coverage): compilePlan(plan,
//      defaultCompileDeps()) — the REAL plan compiler against the REAL curated
//      registry + the REAL write-tool args schemas (M5-J + M5-A surfaces, no
//      injected fixtures — that is plan-compiler.test.ts's turf; this file
//      complements it by proving the production deps pair). Complements M5-B's
//      goldens; never duplicates them.
//
//   3. THE WIRE PROOF (chat-loop harness technique, M4-K): 5 fixtures through
//      the FULL chat route — real Postgres, real SSE wire, the REAL LiteLLM
//      runner against a scripted fake OpenAI-compatible SSE server — asserting
//      the `plan` event carries the compiledBatch whose commands match
//      expected, plus the §8.6/§8.7 properties (server-recomputed risk and
//      credits, layer-name resolution requests, save_version annotation) and
//      law #5 (the compiled registry command ids NEVER enter the provider
//      conversation).
//
// DEVIATION, documented: the brief says "MOCK_MODEL scripted to emit the
// plan". The MockRunner (src/runner.ts, MOCK_MODEL=true) is NOT scriptable —
// it hardcodes mockEditPlan() ("rename the selected layer"). The chat-loop
// harness (M4-K, tests/chat-loop.test.ts) scripts per-fixture model behavior
// the sanctioned way: MOCK_MODEL=false + createRunnerForEnv against an
// in-process fake OpenAI-compatible SSE server. That is the technique used
// here, per fixture: (1) the model calls studio.plan_edit with the user's
// goal, (2) the structured-output round returns the fixture's plan JSON, (3)
// the run answers.
//
// FINDINGS G-1..G-8 (documented in ./golden-plans.ts) are PINNED here as
// today's actual behavior: 6 fixtures compile to a typed fail-closed
// `empty_batch` fatal (args-shape divergence between the M5-A write-tool
// schemas and the M5-B compiler translation), gp-11 pins the G-3 partial
// drop, gp-06 pins the G-2 silent typography drop. Fix the seam, flip
// `expected.compile`, and this suite becomes the acceptance test.
//
// Deterministic: fake loopback SSE only; DB-gated wire block skipped without
// Postgres (same gate as chat-loop). Full file well under 30 s with the DB.

import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  AGENT_COMMAND_IDS,
  type AgentBatch,
  CHAT_MESSAGE_SCHEMA,
  CONTEXT_SELECTION_SCHEMA,
  EDIT_PLAN_SCHEMA,
  META_COMMAND_IDS,
  type EditPlan,
  PINNED_CONTEXT_ITEM_SCHEMA,
  PLAN_RISK_SCHEMA,
  STUDIO_STREAM_EVENT_SCHEMA,
  type StudioStreamEvent,
  TOOL_LIST,
  WRITE_TOOL_IDS,
  estimateCredits,
} from "@studio/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { compilePlan, defaultCompileDeps } from "../src/plan-compiler.js";
import { createRunnerForEnv } from "../src/runner.js";
import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  TEST_APP_ORIGIN,
  api,
  bootServer,
  testEnv,
  unique,
  uniqueEmail,
} from "./helpers.js";
import {
  type GoldenPromptFixture,
  GOLDEN_PROMPT_FIXTURES,
  REQUIRED_SCENARIOS,
} from "./golden-plans.js";

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible SSE server — the chat-loop harness technique (M4-K);
// a REAL localhost server because createRunnerForEnv wires the production fetch.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

type ChatCompletionBody = {
  readonly model: string;
  readonly messages: Array<Record<string, unknown>>;
  readonly tools?: Array<{ readonly function: { readonly name: string } }>;
};

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
    await new Promise<void>((resolve) => {
      const server = this.server;
      if (server === null) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    this.calls.push({ body, authorization: String(request.headers.authorization ?? "") });
    const next = this.queue.shift();
    if (next === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fake script exhausted" } }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    });
    for (const wireFrame of next(body)) {
      if (response.destroyed) return;
      response.write(encoder.encode(wireFrame));
      await new Promise<void>((resolveTick) => {
        setImmediate(resolveTick);
      });
    }
    response.end();
  }
}

// The three scripted model rounds every golden wire run needs.
function planEditRound(toolCallId: string, goal: string): ScriptEntry {
  return () => [
    toolCallStart(0, toolCallId, "studio.plan_edit"),
    toolCallArgs(0, JSON.stringify({ goal })),
    finishReason("tool_calls"),
    usageChunk(90, 20),
    DONE,
  ];
}
function structuredPlanRound(plan: EditPlan): ScriptEntry {
  return () => [
    textDelta(JSON.stringify(plan)),
    finishReason("stop"),
    usageChunk(140, 60),
    DONE,
  ];
}
function finalAnswerRound(text: string): ScriptEntry {
  return () => [textDelta(text), usageChunk(60, 15), finishReason("stop"), DONE];
}

// ---------------------------------------------------------------------------
// SSE wire reader (light: §7.4 schema-valid events + contiguous seq + one
// terminal — the BYTE contract is chat-loop scenario 8's turf, not repeated).
// ---------------------------------------------------------------------------

/** Read every §7.4 event off the SSE wire through clean EOF (never cancels —
 * §7.4 disconnect semantics cancel the live run; the server ends the stream
 * after the terminal event, so a clean EOF read is race-free). */
async function readAllEvents(response: Response): Promise<StudioStreamEvent[]> {
  const body = response.body;
  if (body === null) throw new Error("chat response had no SSE body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: StudioStreamEvent[] = [];
  const deadline = Date.now() + 15_000;
  for (;;) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine === undefined) continue;
      const parsed = JSON.parse(dataLine.slice("data: ".length));
      const checked = STUDIO_STREAM_EVENT_SCHEMA.safeParse(parsed);
      if (!checked.success) {
        throw new Error(`wire event failed the §7.4 schema: ${checked.error.message}`);
      }
      events.push(checked.data);
      continue;
    }
    if (Date.now() > deadline) throw new Error("timed out reading the SSE wire");
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

type PlanEvent = Extract<StudioStreamEvent, { type: "plan" }>;
type CompileOk = Extract<ReturnType<typeof compilePlan>, { ok: true }>;
type CompileFatal = Extract<ReturnType<typeof compilePlan>, { ok: false }>;

function parsePlan(fx: GoldenPromptFixture): EditPlan {
  return EDIT_PLAN_SCHEMA.parse(fx.scriptedModelPlan);
}

function compileFixture(fx: GoldenPromptFixture): ReturnType<typeof compilePlan> {
  return compilePlan(parsePlan(fx), defaultCompileDeps());
}

function expectOk(result: ReturnType<typeof compilePlan>): CompileOk {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected a compiled plan: ${JSON.stringify(result.issues)}`);
  return result;
}

function expectFatal(result: ReturnType<typeof compilePlan>): CompileFatal {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a typed fatal, got a compiled batch");
  return result;
}

/** Batch command ids in compiled order. */
function commandIds(batch: AgentBatch): string[] {
  return batch.steps.map((step) => step.command);
}

/** UNIQUE warn issue codes on a compiled result (per-step repeats collapse). */
function warnCodes(result: CompileOk): string[] {
  return [...new Set(result.warnings.map((issue) => issue.code))];
}

/**
 * Law #5 on the provider wire: the compiled registry command ids NEVER enter
 * the model conversation — no meta entrypoint, no `compiledBatch` payload, and
 * none of the curated agent command ids appears anywhere in a request body.
 * (The model's own ADVISORY pseudo commands are the bare tool ids, which are
 * deliberately NOT registry ids — self-checked below.)
 */
function expectNoCompiledCommandsLeak(
  calls: ReadonlyArray<{ body: ChatCompletionBody }>,
): void {
  for (const call of calls) {
    const serialized = JSON.stringify(call.body);
    expect(serialized.includes("engine.execute")).toBe(false);
    expect(serialized.includes("engine.batch")).toBe(false);
    expect(serialized.includes("compiledBatch")).toBe(false);
    for (const id of AGENT_COMMAND_IDS) {
      expect(serialized.includes(id)).toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Fixture self-checks (M4-N corpus precedent — fail fast on fixture drift)
// ---------------------------------------------------------------------------

describe("golden prompts — fixture validity self-checks", () => {
  it("covers all 10 required §M5-task-8 scenarios with unique fixture ids", () => {
    expect(GOLDEN_PROMPT_FIXTURES.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(GOLDEN_PROMPT_FIXTURES.map((fx) => fx.id));
    expect(ids.size).toBe(GOLDEN_PROMPT_FIXTURES.length);
    const covered = new Set(GOLDEN_PROMPT_FIXTURES.map((fx) => fx.scenario));
    for (const scenario of REQUIRED_SCENARIOS) {
      expect(covered.has(scenario)).toBe(true);
    }
  });

  it.each(GOLDEN_PROMPT_FIXTURES)("($id) the prompt is a real, bounded user message", (fx) => {
    expect(fx.prompt.length).toBeGreaterThan(0);
    expect(CHAT_MESSAGE_SCHEMA.safeParse(fx.prompt).success).toBe(true);
    // The goal handed to studio.plan_edit is bounded by its own schema.
    expect(fx.prompt.length).toBeLessThanOrEqual(4000);
  });

  it.each(GOLDEN_PROMPT_FIXTURES)("($id) the context snapshot is wire-shaped (§5.1/§5.2)", (fx) => {
    expect(CONTEXT_SELECTION_SCHEMA.safeParse(fx.userContext.context).success).toBe(true);
    for (const chip of fx.userContext.pinned) {
      expect(PINNED_CONTEXT_ITEM_SCHEMA.safeParse(chip).success).toBe(true);
    }
    expect(fx.userContext.activeComp.length).toBeGreaterThan(0);
    for (const name of fx.userContext.selection ?? []) {
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it.each(GOLDEN_PROMPT_FIXTURES)("($id) the scripted model plan PASSES EDIT_PLAN_SCHEMA", (fx) => {
    const parsed = EDIT_PLAN_SCHEMA.safeParse(fx.scriptedModelPlan);
    if (!parsed.success) {
      throw new Error(`plan failed the §8.6 schema: ${parsed.error.message}`);
    }
    // Every step names one of the 8 curated write tools (§8.4 table).
    for (const step of parsed.data.steps) {
      const bare = step.tool.replace(/^studio\./, "");
      expect((WRITE_TOOL_IDS as readonly string[]).includes(bare)).toBe(true);
    }
  });

  it.each(GOLDEN_PROMPT_FIXTURES)("($id) layer references are BY NAME (law #5)", (fx) => {
    const plan = parsePlan(fx);
    for (const layer of plan.affectedLayers) {
      expect(layer.name.length).toBeGreaterThan(0);
      expect(typeof layer.id).not.toBe("string");
    }
    for (const step of plan.steps) {
      const args = step.args as Record<string, unknown> | null | undefined;
      if (args !== null && typeof args === "object" && Array.isArray(args.layers)) {
        for (const ref of args.layers) {
          // The write-tool layer-ref shape is STRICT: {name: string}.
          expect(ref).toMatchObject({ name: expect.any(String) });
          expect((ref as { name: string }).name.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it.each(GOLDEN_PROMPT_FIXTURES)("($id) expected commands are curated agent registry ids", (fx) => {
    const allowlist = new Set(AGENT_COMMAND_IDS);
    for (const id of fx.expected.commands) {
      expect(allowlist.has(id)).toBe(true);
    }
    for (const id of META_COMMAND_IDS) {
      expect(allowlist.has(id)).toBe(false);
    }
  });

  it.each(GOLDEN_PROMPT_FIXTURES)(
    "($id) expected credits match estimateCredits for the RECOMPUTED risk (never the model's)",
    (fx) => {
      expect(PLAN_RISK_SCHEMA.safeParse(fx.expected.risk).success).toBe(true);
      const credits = estimateCredits({
        risk: fx.expected.risk,
        steps: fx.scriptedModelPlan.steps,
      });
      expect(fx.expected.estimatedCredits).toBe(credits);
      // The batch range and the compile status agree with each other.
      const [min, max] = fx.expected.batchStepRange;
      expect(min).toBeLessThanOrEqual(max);
      if (fx.expected.compile === "blocked") {
        expect(fx.expected.fatalCode).toBe("empty_batch");
      } else {
        expect(fx.expected.fatalCode).toBeUndefined();
      }
    },
  );

  it("the model's ADVISORY batch proposals never use registry command ids (law #5 wire-proof soundness)", () => {
    const allowlist = new Set(AGENT_COMMAND_IDS);
    for (const fx of GOLDEN_PROMPT_FIXTURES) {
      for (const step of fx.scriptedModelPlan.steps) {
        for (const proposed of step.batch.steps) {
          expect(allowlist.has(proposed.command)).toBe(false);
          expect(META_COMMAND_IDS.includes(proposed.command)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Direct compile — the REAL compiler against the REAL production deps
//    (registry = AGENT_COMMAND_REGISTRY, write tools = WRITE_TOOL_ARGS_SCHEMAS
//    via defaultCompileDeps(); complements plan-compiler.test.ts's injected
//    fixtures by proving the LIVE pair).
// ---------------------------------------------------------------------------

describe("golden prompts — REAL compiler + REAL contracts deps (compile coverage)", () => {
  it.each(GOLDEN_PROMPT_FIXTURES)("($id) $scenario compiles to the pinned outcome", (fx) => {
    const result = compileFixture(fx);

    if (fx.expected.compile === "compiled") {
      const ok = expectOk(result);
      expect(commandIds(ok.batch)).toEqual([...fx.expected.commands]);
      expect(ok.batch.steps.length).toBeGreaterThanOrEqual(fx.expected.batchStepRange[0]);
      expect(ok.batch.steps.length).toBeLessThanOrEqual(fx.expected.batchStepRange[1]);
      expect(ok.batch.atomic).toBe(true);
      expect(ok.batch.label).toBe(`Agent: ${fx.scriptedModelPlan.summary}`);
      // Risk + credits are RECOMPUTED server-side — never the model's numbers.
      expect(ok.risk).toBe(fx.expected.risk);
      expect(ok.estimatedCredits).toBe(fx.expected.estimatedCredits);
      expect(ok.resolutionRequests.map((request) => request.layerName)).toEqual([
        ...fx.expected.resolutionRequests,
      ]);
      for (const expected of fx.expected.warningCodes) {
        expect(warnCodes(ok)).toContain(expected);
      }
      if (fx.expected.saveVersionLabel === undefined) {
        expect(ok.saveVersion).toBeUndefined();
      } else {
        expect(ok.saveVersion).toEqual({ label: fx.expected.saveVersionLabel });
      }
      return;
    }

    // BLOCKED (FINDING G-1/G-6, pinned as today's fail-closed behavior): the
    // compile answers ONE typed fatal — no partial batch can exist.
    const fatal = expectFatal(result);
    expect(fatal.issues).toHaveLength(1);
    expect(fatal.issues[0]?.severity).toBe("fatal");
    expect(fatal.issues[0]?.code).toBe(fx.expected.fatalCode);
  });

  it("gp-06 pins the G-2 silent typography drop: font/size/fill never reach the compiled batch", () => {
    const fx = fixtureById("gp-06-create-text-typography");
    const ok = expectOk(compileFixture(fx));
    expect(ok.batch.steps).toEqual([
      {
        command: "layer.newText",
        // The write-tool args use font/size/fill; the compiler reads
        // fontSize/fontFamily/color (none of which the STRICT schema allows)
        // — only text/name/position survive. Pinned exactly.
        params: { text: "Studio Launch", name: "Launch Title", position: [960, 540] },
      },
    ]);
  });

  it("gp-07 pins the comp.new golden incl. the durationSeconds → duration mapping", () => {
    const ok = expectOk(compileFixture(fixtureById("gp-07-create-comp")));
    expect(ok.batch.steps).toEqual([
      {
        command: "comp.new",
        params: { name: "Outro Stinger", width: 1920, height: 1080, frameRate: 30, duration: 5 },
      },
    ]);
  });

  it("gp-09 pins the undo golden: edit.undo with NO params, risk recomputed to medium", () => {
    const fx = fixtureById("gp-09-undo-previous-run");
    const ok = expectOk(compileFixture(fx));
    expect(ok.batch.steps).toEqual([{ command: "edit.undo", params: {} }]);
    // The model guessed risk "low" / credits 12; the server recomputes both.
    expect(fx.scriptedModelPlan.risk).toBe("low");
    expect(ok.risk).toBe("medium");
    expect(fx.scriptedModelPlan.estimatedCredits).toBe(12);
    expect(ok.estimatedCredits).toBe(1.88);
  });

  it("gp-11 pins the G-3 partial drop: 3 plan steps compile to a 1-command batch (warn only)", () => {
    const fx = fixtureById("gp-11-lower-third-compound");
    const ok = expectOk(compileFixture(fx));
    expect(fx.scriptedModelPlan.steps).toHaveLength(3);
    expect(commandIds(ok.batch)).toEqual(["layer.newText"]);
    // The set_keyframes step translated to ZERO commands — warn severity only.
    expect(warnCodes(ok)).toContain("unusable_args");
    expect(ok.saveVersion).toEqual({ label: "Lower third v1" });
  });

  it("compilation is deterministic: every fixture compiles deep-equal twice", () => {
    for (const fx of GOLDEN_PROMPT_FIXTURES) {
      expect(compileFixture(fx)).toEqual(compileFixture(fx));
    }
  });
});

function fixtureById(id: string): GoldenPromptFixture {
  const fx = GOLDEN_PROMPT_FIXTURES.find((fixture) => fixture.id === id);
  if (fx === undefined) throw new Error(`unknown golden fixture ${id}`);
  return fx;
}

// ---------------------------------------------------------------------------
// 3. The wire proof — the full chat route over the real SSE wire, with the
//    model scripted per fixture (chat-loop harness technique; DB-gated).
// ---------------------------------------------------------------------------

const d = describe.skipIf(!HAS_DATABASE);

/** The fixtures proven on the wire (mission: at least 3; 5 chosen). */
const WIRE_FIXTURE_IDS = [
  "gp-06-create-text-typography",
  "gp-07-create-comp",
  "gp-09-undo-previous-run",
  "gp-10-save-labeled-version",
  "gp-11-lower-third-compound",
] as const;

const fake = new FakeOpenAIServer();
let server: RunningTestServer;

d("golden prompts — the wire proof (real chat loop, scripted model, plan event on the SSE wire)", () => {
  beforeAll(async () => {
    await fake.start();
    const envSource = {
      MOCK_MODEL: "false",
      LITELLM_BASE_URL: fake.url,
      LITELLM_API_KEY: "sk-test-golden",
      CHAT_MAX_STEPS: "6",
    };
    const env = testEnv(envSource);
    server = await bootServer({ env: envSource, runner: createRunnerForEnv(env) });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    await fake.stop();
  });

  afterEach(() => {
    fake.reset();
  });

  it.each(WIRE_FIXTURE_IDS.map((id) => fixtureById(id)))(
    "($id) prompt → plan_edit → compiled plan event matches the golden",
    async (fx) => {
      const ctx = await newFixture("golden");
      const toolCallId = `call_golden_${fx.id.replace(/-/g, "_")}`;

      // The scripted model: plan_edit(goal) → structured EditPlan → answer.
      fake.enqueue(
        planEditRound(toolCallId, fx.prompt),
        structuredPlanRound(parsePlan(fx)),
        finalAnswerRound("Here's the plan — review it and apply when ready."),
      );

      const response = await fetch(`${server.base}/v1/threads/${ctx.threadId}/chat`, {
        method: "POST",
        headers: {
          origin: TEST_APP_ORIGIN,
          "content-type": "application/json",
          accept: "text/event-stream",
          cookie: ctx.jar.header,
          "x-workspace-id": ctx.workspaceId,
        },
        body: JSON.stringify({
          message: fx.prompt,
          context: fx.userContext.context,
          idempotencyKey: unique("golden-chat"),
          pinned: fx.userContext.pinned,
        }),
        redirect: "manual",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const events = await readAllEvents(response);

      // §7.4 stream shape: run.started first, one terminal last, contiguous seq,
      // one run. (The byte-exact frame contract is chat-loop scenario 8.)
      expect(events[0]?.type).toBe("run.started");
      const last = events.at(-1);
      expect(last?.type).toBe("run.completed");
      const seqs = events.map((event) => event.seq);
      expect(seqs).toEqual(seqs.map((_seq, index) => index));
      expect(new Set(events.map((event) => event.runId)).size).toBe(1);

      // Exactly one plan event, carrying the model's plan VERBATIM.
      const planEvents = events.filter((event): event is PlanEvent => event.type === "plan");
      expect(planEvents).toHaveLength(1);
      const planEvent = planEvents[0];
      if (planEvent === undefined) throw new Error("no plan event on the wire");
      expect(planEvent.plan).toEqual(parsePlan(fx));

      // The M5 enrichment: the compiled batch matches the golden.
      expect(planEvent.compiledBatch).toBeDefined();
      const batch = planEvent.compiledBatch;
      if (batch === undefined) throw new Error("plan event was not enriched");
      expect(commandIds(batch)).toEqual([...fx.expected.commands]);
      expect(batch.steps.length).toBeGreaterThanOrEqual(fx.expected.batchStepRange[0]);
      expect(batch.steps.length).toBeLessThanOrEqual(fx.expected.batchStepRange[1]);
      expect(batch.atomic).toBe(true);
      expect(batch.label).toBe(`Agent: ${fx.scriptedModelPlan.summary}`);

      // Risk + credits are SERVER-RECOMPUTED — the model's numbers never win.
      expect(planEvent.risk).toBe(fx.expected.risk);
      expect(planEvent.estimatedCredits).toBe(fx.expected.estimatedCredits);

      // Layer-name resolution requests (§8.7): names only, request ids stable.
      expect(
        (planEvent.resolutionRequests ?? []).map((request) => request.layerName),
      ).toEqual([...fx.expected.resolutionRequests]);

      // The tool.result for plan_edit is the BARE plan (M4 shape) — the
      // compiled registry command ids ride the plan event for the CLIENT only.
      const toolResult = events.find(
        (event) => event.type === "tool.result" && event.toolCallId === toolCallId,
      );
      expect(toolResult).toBeDefined();
      if (toolResult?.type !== "tool.result") throw new Error("no plan tool.result on the wire");
      expect(toolResult.result).toEqual(parsePlan(fx));

      // The model conversation: 3 provider calls — the plan_edit round (13
      // curated tools), the structured-output round (NO tools, plan
      // instruction + goal), the final answer round.
      expect(fake.calls).toHaveLength(3);
      const [round1, round2, round3] = fake.calls;
      expect(round1?.body.tools?.length).toBe(TOOL_LIST.length);
      expect(TOOL_LIST).toHaveLength(13);
      expect(round2?.body.tools).toBeUndefined();
      expect(round3?.body.tools?.length).toBe(13);
      expect(round1?.authorization).toBe("Bearer sk-test-golden");

      // The structured prompt asked for THIS goal (§8.6 strict-JSON prompt).
      const planInstruction = round2?.body.messages.at(-1);
      expect(planInstruction?.role).toBe("user");
      expect(String(planInstruction?.content)).toContain("Produce an EditPlan");
      expect(String(planInstruction?.content)).toContain(fx.prompt);

      // Law #5: no compiled registry command id ever entered the conversation.
      expectNoCompiledCommandsLeak(fake.calls);

      // §8.8: a completed run commits 1..reserved credits.
      const credits = events.find(
        (event): event is Extract<StudioStreamEvent, { type: "credits" }> =>
          event.type === "credits",
      );
      expect(credits).toBeDefined();
      if (credits === undefined) throw new Error("no credits event");
      expect(credits.committed).toBeGreaterThanOrEqual(1);
      expect(credits.committed).toBeLessThanOrEqual(credits.reserved);
    },
    20_000,
  );

  it("the wire pins G-3 exactly: gp-11 shows 3 plan steps but a 1-command compiled batch", async () => {
    const fx = fixtureById("gp-11-lower-third-compound");
    const ctx = await newFixture("golden-g3");
    fake.enqueue(
      planEditRound("call_golden_g3", fx.prompt),
      structuredPlanRound(parsePlan(fx)),
      finalAnswerRound("Plan ready."),
    );

    const response = await fetch(`${server.base}/v1/threads/${ctx.threadId}/chat`, {
      method: "POST",
      headers: {
        origin: TEST_APP_ORIGIN,
        "content-type": "application/json",
        accept: "text/event-stream",
        cookie: ctx.jar.header,
        "x-workspace-id": ctx.workspaceId,
      },
      body: JSON.stringify({
        message: fx.prompt,
        context: fx.userContext.context,
        idempotencyKey: unique("golden-g3"),
        pinned: fx.userContext.pinned,
      }),
      redirect: "manual",
    });
    const events = await readAllEvents(response);
    const planEvent = events.find((event): event is PlanEvent => event.type === "plan");
    if (planEvent === undefined) throw new Error("no plan event on the wire");

    // What the PLAN CARD shows: the model's 3 steps (create + animate + save).
    expect(planEvent.plan.steps).toHaveLength(3);
    // What the APPLIED BATCH would perform: 1 command — the slide-in
    // animation translated to ZERO commands with warn severity only (G-3).
    expect(planEvent.plan.steps.map((step) => step.title)).toEqual([
      "Create the lower-third text",
      "Slide in from the left",
      "Save the version",
    ]);
    const g3Batch = planEvent.compiledBatch;
    if (g3Batch === undefined) throw new Error("gp-11 plan event was not enriched");
    expect(g3Batch.steps).toHaveLength(1);
    expect(commandIds(g3Batch)).toEqual(["layer.newText"]);
  });
});

// ---------------------------------------------------------------------------
// Wire fixtures: fresh workspace + credits + project + version + thread
// (the chat route needs the project's base version for base_version_id).
// ---------------------------------------------------------------------------

interface WireFixture {
  readonly jar: CookieJar;
  readonly workspaceId: string;
  readonly threadId: string;
}

async function newFixture(prefix: string): Promise<WireFixture> {
  const jar = new CookieJar();
  const signup = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: {
      email: uniqueEmail(prefix),
      password: "Passw0rd!longenough",
      name: "Golden Prompts Tester",
    },
  });
  expect(signup.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Golden WS"), slug: unique("golden") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };

  await server.deps.repos.ledger.grant(ws.data.id, { amount: 100, idempotencyKey: unique("grant") });

  const projectResponse = await api(server.base, "/v1/projects", {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.data.id, "idempotency-key": unique("prj") },
    body: { name: unique("Golden Project") },
  });
  expect(projectResponse.status).toBe(201);
  const project = (await projectResponse.json()) as { data: { id: string } };

  const bytes = Buffer.from(`{"fixture":"${unique("golden")}"}`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const versionResponse = await api(
    server.base,
    `/v1/projects/${project.data.id}/versions?sha256=${sha256}&sizeBytes=${bytes.byteLength}`,
    {
      method: "POST",
      jar,
      headers: {
        "x-workspace-id": ws.data.id,
        "idempotency-key": unique("ver"),
        "content-type": "application/octet-stream",
      },
      rawBody: new Uint8Array(bytes),
    },
  );
  expect(versionResponse.status).toBe(201);

  const threadResponse = await api(server.base, `/v1/projects/${project.data.id}/threads`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.data.id, "idempotency-key": unique("thr") },
    body: { title: "Golden prompts thread" },
  });
  expect(threadResponse.status).toBe(201);
  const thread = (await threadResponse.json()) as { data: { id: string } };
  return { jar, workspaceId: ws.data.id, threadId: thread.data.id };
}
