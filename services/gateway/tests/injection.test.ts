// M4-N — the SAFETY PROOFS (BUILD_PLAN §M4 task 6): prompt-injection corpus
// vs the gateway pipeline. Extends M4-A's litellm-*.test.ts scenarios (their
// 11: happy path, credits, tool round-trip, timeout, abort, repair-turn,
// plan happy/invalid, step cap, provider-down, cancel, registry+redaction)
// with the ADVERSARIAL corpus from
// apps/web/src/lib/chat/__tests__/injection-corpus.ts (imported by relative
// path — the corpus is a zero-dependency data module on purpose).
//
// M5-C re-pins every property at the NEW tool count (BUILD_PLAN §M5.1): the
// provider wire now carries 13 curated tools — 5 read + 8 write — and the
// write tools are PROPOSE-ONLY (server-side compile, never an execution).
// Proves, per run:
//   1. anything NOT in the 13 is refused: begging gets ONE repair turn, then
//      RUN_INVALID_TOOL; a single-round flood dies with ZERO repairs; a
//      perfectly-argued WRITE call now returns a PROPOSED batch and NEVER
//      executes server-side (the M4 “cannot get a write tool” proof becomes
//      the M5 “cannot get an EXECUTION” proof);
//   2. project-sourced text stays DATA through the whole pipeline: tool
//      results are fed back verbatim, injected instructions never turn into
//      executions, and no raw engine command string ever reaches a provider;
//   3. the system prompt stays FIRST and byte-exact under corpus payloads;
//   4. redaction holds: fingerprints + logs carry lengths/sha256 only;
//   5. tool args validation rejects hostile payloads (bounds, enums,
//      duplicate keys) and strips prototype-pollution keys (the write
//      tools' STRICT Zod boundary is pinned in litellm-runner.test.ts);
//   6. EDIT_PLAN_SCHEMA bounds hold (steps/summary/risk/affectedLayers,
//      $ref escapes) and a twice-invalid plan degrades to PLAN_INVALID with
//      the run surviving; the M5 plan-event enrichment adds ONLY optional
//      fields and the compiled batch never reaches the model conversation;
//   7. adversarial multi-tool looping still dies at the step cap (write
//      tools are loop steps too — D-1).
//
// Deterministic: fake in-process OpenAI SSE server (injectable fetch) + a
// fake AgentRunStream. No network, no Postgres (same harness family as
// litellm-runner.test.ts; runs DB-gated alongside the rest of the suite).

import { describe, expect, it } from "vitest";

import {
  CONTEXT_SELECTION_SCHEMA,
  EDIT_PLAN_SCHEMA,
  PROPOSED_BATCH_NOTE,
  type StudioStreamEvent,
  TOOL_LIST,
  WRITE_TOOL_RESULT_SCHEMA,
} from "@studio/contracts";
import {
  ALL_TEXT_FIXTURES,
  HOSTILE_PLAN_PAYLOADS,
  HOSTILE_TOOL_ARGS,
  TOOL_RESULT_INJECTIONS,
  allNeedles,
  hostileArgsFixture,
  minimalPlan,
  toolResultFixture,
} from "../../../apps/web/src/lib/chat/__tests__/injection-corpus.js";

import type { OpenAIChatMessage } from "../src/litellm/openai.js";
import { SYSTEM_PROMPT, buildMessages, fingerprintMessages } from "../src/litellm/prompt.js";
import { type CompilePlanFn, createLiteLLMRunner } from "../src/litellm/runner.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  type AgentRun,
  type AgentRunOutcome,
  type AgentRunStream,
  type RunStreamPayload,
  type ToolWaitResult,
  mockEditPlan,
} from "../src/runner.js";

// ---------------------------------------------------------------------------
// Fake OpenAI SSE server (scripted) — M4-A's harness technique
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

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
function finish(reason: string): string {
  return frame({ choices: [{ delta: {}, finish_reason: reason }] });
}
const DONE = "data: [DONE]\n\n";

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface RecordedCall {
  readonly url: string;
  readonly body: {
    model: string;
    messages: OpenAIChatMessage[];
    tools?: Array<{ function: { name: string } }>;
    tool_choice?: string;
  };
}

function scriptedFetch(script: ReadonlyArray<Response>): typeof fetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const stub = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as RecordedCall["body"],
    });
    const next = script[index];
    index += 1;
    if (next === undefined) throw new Error("script exhausted");
    return next;
  }) as typeof fetch & { calls: RecordedCall[] };
  stub.calls = calls;
  return stub;
}

// ---------------------------------------------------------------------------
// Fake AgentRunStream
// ---------------------------------------------------------------------------

class FakeStream implements AgentRunStream {
  readonly events: RunStreamPayload[] = [];
  readonly expected: Array<{ toolCallId: string; tool: string }> = [];
  readonly controller = new AbortController();
  waitMode: "pending" | "auto" = "pending";
  private readonly waits = new Map<string, (result: ToolWaitResult) => void>();
  private readonly early = new Map<string, unknown>();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  emit(payload: RunStreamPayload): StudioStreamEvent {
    this.events.push(payload);
    return { ...payload, runId: "run_inj", seq: this.events.length - 1 };
  }

  async yieldToStream(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  expectToolCall(toolCallId: string, tool: string): void {
    this.expected.push({ toolCallId, tool });
  }

  waitForToolResult(toolCallId: string): Promise<ToolWaitResult> {
    if (this.waitMode === "auto") return Promise.resolve({ ok: true, result: { stub: true } });
    if (this.early.has(toolCallId)) {
      return Promise.resolve({ ok: true, result: this.early.get(toolCallId) });
    }
    return new Promise((resolve) => {
      this.waits.set(toolCallId, resolve);
    });
  }

  resolveToolResult(toolCallId: string, result: unknown): void {
    const resolve = this.waits.get(toolCallId);
    if (resolve === undefined) {
      this.early.set(toolCallId, result);
      return;
    }
    this.waits.delete(toolCallId);
    resolve({ ok: true, result });
  }
}

async function runToOutcome(
  runner: ReturnType<typeof createLiteLLMRunner>,
  run: AgentRun,
  stream: FakeStream,
): Promise<AgentRunOutcome> {
  const outcome = await runner.start(run, stream);
  if (outcome.kind === "failed") {
    stream.emit({
      type: "run.failed",
      code: outcome.code,
      message: outcome.message,
      retryable: outcome.retryable,
    });
  } else if (outcome.kind === "cancelled") {
    stream.emit({ type: "run.cancelled" });
  } else {
    stream.emit({ type: "run.completed" });
  }
  return outcome;
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: "run_inj",
    threadId: "thr_inj",
    projectId: "prj_inj",
    workspaceId: "ws_inj",
    model: "studio-smart",
    baseVersionId: null,
    message: "what is on this comp?",
    context: CONTEXT_SELECTION_SCHEMA.parse({}),
    pinned: [],
    reservedCredits: 10,
    ...overrides,
  };
}

function makeRunner(
  script: ReadonlyArray<Response>,
  options: {
    maxSteps?: number;
    stream?: FakeStream;
    logger?: Logger;
    compilePlan?: CompilePlanFn;
  } = {},
): {
  runner: ReturnType<typeof createLiteLLMRunner>;
  fetchCalls: RecordedCall[];
  stream: FakeStream;
} {
  const fetchStub = scriptedFetch(script);
  const stream = options.stream ?? new FakeStream();
  const runner = createLiteLLMRunner({
    baseUrl: "http://127.0.0.1:4000",
    apiKey: "sk-platform",
    virtualKey: "sk-virtual-inj",
    maxSteps: options.maxSteps ?? 8,
    fetch: fetchStub,
    sleep: async () => {},
    logger: options.logger,
    compilePlan: options.compilePlan,
  });
  return { runner, fetchCalls: fetchStub.calls, stream };
}

// ---------------------------------------------------------------------------
// Security assertion helpers
// ---------------------------------------------------------------------------

/** §8.4 law: the provider is offered EXACTLY the 13 curated tools — the 5
 * read tools + the 8 PROPOSE-ONLY write tools (BUILD_PLAN §M5.1) — and
 * nothing else ever: no raw engine entrypoint, no invented id. */
const CURATED_TOOL_IDS = TOOL_LIST.map((tool) => tool.id);

function expectExactlyCuratedToolsSent(calls: readonly RecordedCall[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const tools = call.body.tools;
    if (tools === undefined) continue; // structured-output calls carry no tools
    expect(tools.map((tool) => tool.function.name)).toEqual(CURATED_TOOL_IDS);
  }
  // Belt and braces: nothing outside the curated 13 ever appears in a tools
  // array — in particular never the raw execution entrypoints.
  for (const call of calls) {
    const serialized = JSON.stringify(call.body.tools ?? []);
    expect(serialized.includes("engine.execute")).toBe(false);
    expect(serialized.includes("engine.batch")).toBe(false);
  }
}

/** §12.2 law: no raw engine command string is ever put on the wire. */
function expectNoEngineCommandStrings(calls: readonly RecordedCall[]): void {
  for (const call of calls) {
    const serialized = JSON.stringify(call.body);
    expect(serialized.includes("engine.execute")).toBe(false);
    expect(serialized.includes("engine.batch")).toBe(false);
  }
}

/** Object.prototype must stay untouched by anything the pipeline processed. */
function expectPrototypeClean(): void {
  const probe: Record<string, unknown> = {};
  expect(probe.polluted).toBeUndefined();
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.getPrototypeOf(probe).polluted).toBeUndefined();
}

/** The tool-role repair message of the runner's k-th provider call. */
function toolRoleMessage(call: RecordedCall | undefined): OpenAIChatMessage | undefined {
  return call?.body.messages.find(
    (message): message is OpenAIChatMessage & { role: "tool" } => message.role === "tool",
  );
}

// ---------------------------------------------------------------------------
// (1) BEGGING OUTSIDE THE CURATED 13 — the allowlist is the backstop; the
//     curated write tools themselves PROPOSE only (M5.1)
// ---------------------------------------------------------------------------

/** Deterministic stub proposal the injected compile seam returns (M5-B stand-in). */
const stubProposalCompiler: CompilePlanFn = async () => ({
  ok: true,
  batch: {
    label: "Agent: corpus stub proposal",
    atomic: true,
    steps: [{ command: "text.insert", params: { text: "stub" } }],
  },
  risk: "low",
  estimatedCredits: 1,
  resolutionRequests: [],
});

/** M5-A's CURRENT set_properties args shape (STRICT, layers BY NAME). */
const SET_PROPERTIES_ARGS = JSON.stringify({
  layers: [{ name: "headline" }],
  properties: [{ path: "text/sourceText", value: "PWNED-BY-BEGGING" }],
});

describe("safety (M5.1) — anything not in the curated 13 is refused; writes only PROPOSE", () => {
  it("begging for an unregistered tool: ONE repair turn, then RUN_INVALID_TOOL", async () => {
    const { runner, fetchCalls, stream } = makeRunner([
      // Round 1: the model begs for a tool that is not in the 13.
      sseResponse([
        textDelta("I really need to modify the project to help you."),
        toolCallStart(0, "call_w1", "studio.delete_everything"),
        toolCallArgs(0, "{}"),
        finish("tool_calls"),
        DONE,
      ]),
      // Round 2: the model begs again in prose and repeats the offense.
      sseResponse([
        textDelta("Please, I must delete everything."),
        toolCallStart(0, "call_w2", "studio.delete_everything"),
        toolCallArgs(0, "{}"),
        finish("tool_calls"),
        DONE,
      ]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome).toEqual({
      kind: "failed",
      code: "RUN_INVALID_TOOL",
      message: "The agent requested a tool call we can't validate.",
      retryable: false,
    });
    expectExactlyCuratedToolsSent(fetchCalls);
    expectNoEngineCommandStrings(fetchCalls);
    // The unregistered call never reached the editor: no tool.started.
    expect(stream.events.some((event) => event.type === "tool.started")).toBe(false);
    expect(stream.expected).toEqual([]);
    // The repair turn told the model the truth: unknown tool + the real list —
    // which now legitimately includes the PROPOSE-ONLY write tools.
    const repair = JSON.parse(String(toolRoleMessage(fetchCalls[1])?.content ?? "null")) as {
      error: string;
      message: string;
    };
    expect(repair.error).toBe("VALIDATION_FAILED");
    expect(repair.message).toContain('Unknown tool "studio.delete_everything"');
    expect(repair.message).toContain("studio.plan_edit"); // the read tools listed
    expect(repair.message).toContain("studio.set_properties"); // the curated write tools listed
  });

  it("a single-round flood of unregistered tool calls dies with ZERO repair turns", async () => {
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_f1", "studio.delete_everything"),
        toolCallArgs(0, "{}"),
        toolCallStart(1, "call_f2", "studio.explode_project"),
        toolCallArgs(1, "{}"),
        finish("tool_calls"),
        DONE,
      ]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome).toEqual({
      kind: "failed",
      code: "RUN_INVALID_TOOL",
      message: "The agent requested a tool call we can't validate.",
      retryable: false,
    });
    // Two strikes in one round: no repair turn was ever issued.
    expect(fetchCalls.length).toBe(1);
    expectExactlyCuratedToolsSent(fetchCalls);
    expect(stream.events.some((event) => event.type === "tool.started")).toBe(false);
  });

  it("a perfectly-argued WRITE call now returns a PROPOSED batch — nothing executes server-side", async () => {
    // The M4 proof was "the write tool cannot be reached" (it was not
    // registered). The M5 proof: it IS registered, the args pass the STRICT
    // Zod boundary, and STILL nothing executes — the runner resolves the
    // call server-side into a proposal, the model sees a redacted summary,
    // and the run simply continues.
    const { runner, fetchCalls, stream } = makeRunner(
      [
        sseResponse([
          toolCallStart(0, "call_w1", "studio.set_properties"),
          toolCallArgs(0, SET_PROPERTIES_ARGS),
          finish("tool_calls"),
          DONE,
        ]),
        // Round 2: the "obedient" model asks for another write, gets another
        // PROPOSAL — never an execution.
        sseResponse([
          textDelta("Understood, updating the project."),
          toolCallStart(0, "call_w2", "studio.create_text"),
          toolCallArgs(0, JSON.stringify({ text: "PWNED-INSIST" })),
          finish("tool_calls"),
          DONE,
        ]),
        sseResponse([textDelta("Both changes are proposed."), finish("stop"), DONE]),
      ],
      { compilePlan: stubProposalCompiler },
    );

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome.kind).toBe("completed");
    expectExactlyCuratedToolsSent(fetchCalls);
    expectNoEngineCommandStrings(fetchCalls);
    // Both write calls reached the CLIENT as proposals (tool.started + a
    // WRITE_TOOL_RESULT_SCHEMA-shaped tool.result) — never an execution.
    const started = stream.events.filter((event) => event.type === "tool.started");
    expect(started.map((event) => (event as { name: string }).name)).toEqual([
      "studio.set_properties",
      "studio.create_text",
    ]);
    const results = stream.events.filter((event) => event.type === "tool.result");
    expect(results).toHaveLength(2);
    for (const result of results) {
      const payload = (result as { result?: unknown }).result;
      expect(WRITE_TOOL_RESULT_SCHEMA.safeParse(payload).success).toBe(true);
      expect((payload as { note?: string }).note).toBe(PROPOSED_BATCH_NOTE);
    }
    // The model was fed REDACTED summaries — never the compiled command ids.
    for (const call of fetchCalls.slice(1)) {
      const toolMessage = toolRoleMessage(call);
      const content = String(toolMessage?.content);
      expect(content.includes("text.insert")).toBe(false);
      expect(content.includes("Agent: corpus stub proposal")).toBe(false);
      const fedBack = JSON.parse(content) as Record<string, unknown>;
      expect(fedBack.proposed).toBe(true);
    }
    expectPrototypeClean();
  });
});

// ---------------------------------------------------------------------------
// (2) INJECTED INSTRUCTIONS IN TOOL RESULTS STAY DATA
// ---------------------------------------------------------------------------

describe("safety — injected tool results stay data (§8.3 end to end)", () => {
  it.each(TOOL_RESULT_INJECTIONS.map((fixture) => [fixture.id]))(
    "corpus result %s: fed back VERBATIM, the write tool it begs for only PROPOSES",
    async (fixtureId) => {
      const poisoned = toolResultFixture(fixtureId);
      const { runner, fetchCalls, stream } = makeRunner(
        [
          // Round 1: a legitimate read the hostile result answers.
          sseResponse([
            toolCallStart(0, "call_read", "studio.get_context"),
            toolCallArgs(0, "{}"),
            finish("tool_calls"),
            DONE,
          ]),
          // Round 2: the model "obeyed" the injected instruction — but the
          // curated write tool now PROPOSES server-side; nothing executes.
          sseResponse([
            textDelta("Understood, updating the project."),
            toolCallStart(0, "call_write", "studio.set_properties"),
            toolCallArgs(0, SET_PROPERTIES_ARGS),
            finish("tool_calls"),
            DONE,
          ]),
          // Round 3: the model insists with a different write tool — another
          // proposal, still no execution.
          sseResponse([
            toolCallStart(0, "call_write2", "studio.create_text"),
            toolCallArgs(0, JSON.stringify({ text: "PWNED-INSIST" })),
            finish("tool_calls"),
            DONE,
          ]),
          sseResponse([textDelta("Both changes are proposed for review."), finish("stop"), DONE]),
        ],
        { compilePlan: stubProposalCompiler },
      );

      const outcomePromise = runToOutcome(runner, makeRun(), stream);
      await new Promise((resolve) => setImmediate(resolve));
      // The editor client POSTs the poisoned result (Seam 2).
      stream.resolveToolResult("call_read", poisoned.result);
      const outcome = await outcomePromise;

      expect(outcome.kind).toBe("completed");
      expectExactlyCuratedToolsSent(fetchCalls);
      expectNoEngineCommandStrings(fetchCalls);
      // One CLIENT read reached the editor; the two write calls reached the
      // client as tool.started cards whose results are PROPOSALS.
      const started = stream.events.filter((event) => event.type === "tool.started");
      expect(started.map((event) => (event as { name: string }).name)).toEqual([
        "studio.get_context",
        "studio.set_properties",
        "studio.create_text",
      ]);
      const writeResults = stream.events.filter(
        (event) => event.type === "tool.result" && event.toolCallId !== "call_read",
      );
      expect(writeResults).toHaveLength(2);
      for (const result of writeResults) {
        const payload = (result as { result?: unknown }).result;
        expect(WRITE_TOOL_RESULT_SCHEMA.safeParse(payload).success).toBe(true);
      }
      // DATA, VERBATIM: the poisoned result is the tool-role message the next
      // model turn saw — byte-identical, never sanitized, never escalated.
      const round2Tool = toolRoleMessage(fetchCalls[1]);
      expect(round2Tool?.tool_call_id).toBe("call_read");
      expect(round2Tool?.content).toBe(JSON.stringify(poisoned.result));
      // The injection reached the model as data…
      expect(String(round2Tool?.content).includes(poisoned.needle)).toBe(true);
      // …and it still bought nothing: no engine string ever reached the
      // provider and the proposals fed back to the model carry no command ids.
      for (const call of fetchCalls.slice(2)) {
        const toolMessage = toolRoleMessage(call);
        if (toolMessage === undefined) continue;
        expect(String(toolMessage.content).includes("text.insert")).toBe(false);
      }
      expectPrototypeClean();
    },
  );

  it("the plan path never leaks a raw engine entrypoint either (plans are proposal data)", async () => {
    const plan = mockEditPlan();
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_plan", "studio.plan_edit"),
        toolCallArgs(0, '{"goal":"organize the layers"}'),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([textDelta(JSON.stringify(plan)), finish("stop"), DONE]),
      sseResponse([textDelta("Plan ready."), finish("stop"), DONE]),
    ]);
    const outcome = await runToOutcome(runner, makeRun(), stream);
    expect(outcome.kind).toBe("completed");
    expect(stream.events.some((event) => event.type === "plan")).toBe(true);
    // Plan steps may CARRY proposed command ids (data, §8.6 shape) but the raw
    // execution entrypoints engine.execute / engine.batch never appear.
    expectNoEngineCommandStrings(fetchCalls);
    expectExactlyCuratedToolsSent(fetchCalls);
  });

  it("the enriched plan path (M5 compile seam) still never leaks the compiled batch to the model", async () => {
    // With a compile seam wired, the plan event carries compiledBatch for the
    // CLIENT — the model's tool-role content stays the BARE plan (M4 shape),
    // so the server-chosen registry command ids never enter the conversation.
    const plan = mockEditPlan();
    const { runner, fetchCalls, stream } = makeRunner(
      [
        sseResponse([
          toolCallStart(0, "call_plan", "studio.plan_edit"),
          toolCallArgs(0, '{"goal":"organize the layers"}'),
          finish("tool_calls"),
          DONE,
        ]),
        sseResponse([textDelta(JSON.stringify(plan)), finish("stop"), DONE]),
        sseResponse([textDelta("Plan ready."), finish("stop"), DONE]),
      ],
      { compilePlan: stubProposalCompiler },
    );
    const outcome = await runToOutcome(runner, makeRun(), stream);
    expect(outcome.kind).toBe("completed");
    const planEvent = stream.events.find((event) => event.type === "plan");
    if (planEvent?.type !== "plan") throw new Error("no plan event");
    expect((planEvent as { compiledBatch?: unknown }).compiledBatch).toBeDefined();
    expect((planEvent as { risk?: unknown }).risk).toBe("low");
    // The tool-role message the model saw is the bare plan — no compiledBatch,
    // no proposal label, no command id from the compile.
    const toolMessage = toolRoleMessage(fetchCalls[2]);
    expect(toolMessage?.content).toBe(JSON.stringify(plan));
    expectNoEngineCommandStrings(fetchCalls);
    expectExactlyCuratedToolsSent(fetchCalls);
  });
});

// ---------------------------------------------------------------------------
// (3) PROMPT BOUNDARY — the system prompt is assembled, never grown
// ---------------------------------------------------------------------------

describe("safety — prompt boundary holds for every corpus payload", () => {
  it("keeps the system prompt FIRST and byte-exact; payloads travel as data only", () => {
    for (const fixture of ALL_TEXT_FIXTURES) {
      const messages = buildMessages(
        makeRun({
          message: fixture.payload,
          history: [
            { role: "user", content: fixture.payload },
            { role: "assistant", content: fixture.payload },
          ],
        }),
      );
      // The system turn is first and byte-identical — no fixture content, no
      // "SYSTEM:" header, no boundary escape can modify or append to it.
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
      const systemTurns = messages.filter((message) => message.role === "system");
      expect(systemTurns).toHaveLength(1);
      // Data not lost: the payload rides the user/history turns verbatim.
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      expect(String(lastUser?.content).includes(fixture.payload)).toBe(true);
      expect(messages[1]?.content).toBe(fixture.payload);
    }
  });

  it("hostile pinned labels land in the user turn, never in the system turn", () => {
    const fixture = ALL_TEXT_FIXTURES.find((item) => item.id === "html-anchor-js");
    if (fixture === undefined) throw new Error("fixture missing");
    const messages = buildMessages(
      makeRun({
        message: "what is pinned?",
        pinned: [{ kind: "composition", id: "comp_1", label: fixture.payload }],
      }),
    );
    expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
    const lastUser = messages.at(-1);
    expect(String(lastUser?.content).includes(fixture.payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (4) REDACTION — fingerprints and logs carry metadata only
// ---------------------------------------------------------------------------

describe("safety — redaction holds (M4.3)", () => {
  it("fingerprintMessages output contains NO corpus payload — length + sha256 only", () => {
    const digests: string[] = [];
    for (const fixture of ALL_TEXT_FIXTURES) {
      const messages: OpenAIChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: fixture.payload },
      ];
      const fingerprint = fingerprintMessages(messages);
      const serialized = JSON.stringify(fingerprint);
      expect(serialized.includes(fixture.needle)).toBe(false);
      expect(fingerprint.messageCount).toBe(2);
      expect(fingerprint.chars).toBe(JSON.stringify(messages).length);
      digests.push(fingerprint.sha256);
    }
    // Tamper-evident without carrying content: distinct payloads → distinct
    // digests for every corpus fixture.
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("the runner's logger receives no corpus needle across a fully hostile run", async () => {
    const records: Array<{ level: string; msg: string; fields: LogFields }> = [];
    const spyLogger: Logger = {
      debug: (msg, fields) => records.push({ level: "debug", msg, fields: { ...fields } }),
      info: (msg, fields) => records.push({ level: "info", msg, fields: { ...fields } }),
      warn: (msg, fields) => records.push({ level: "warn", msg, fields: { ...fields } }),
      error: (msg, fields) => records.push({ level: "error", msg, fields: { ...fields } }),
      child: () => spyLogger,
    };
    const begging = hostileArgsFixture("write-tool-perfect-args");
    const { runner, stream } = makeRunner(
      [sseResponse([textDelta("Here it is."), finish("stop"), DONE])],
      {
        logger: spyLogger,
      },
    );
    const history = ALL_TEXT_FIXTURES.slice(0, 6).map((fixture) => ({
      role: "user" as const,
      content: fixture.payload,
    }));
    const outcome = await runToOutcome(
      runner,
      makeRun({ message: begging.argsJson, history }),
      stream,
    );
    expect(outcome.kind).toBe("completed");

    const modelCalls = records.filter((record) => record.msg === "litellm_model_call");
    expect(modelCalls.length).toBe(1);
    const fields = modelCalls[0]?.fields as Record<string, unknown>;
    expect(fields.promptChars).toBeGreaterThan(0);
    expect(String(fields.promptSha256)).toMatch(/^[0-9a-f]{16}$/);
    // M4.3: no corpus needle (payload fragment, base64 blob, URL query…) may
    // appear in ANY log record of the run.
    const allSerialized = JSON.stringify(records);
    for (const needle of allNeedles()) {
      expect(allSerialized.includes(needle)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (5) ARGS VALIDATION — hostile payloads never execute
// ---------------------------------------------------------------------------

describe("safety — tool args validation rejects hostile payloads", () => {
  it("999 layerIds: ONE repair turn, then the model recovers with valid args", async () => {
    const hostile = hostileArgsFixture("props-999-layers");
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_bomb", hostile.tool),
        toolCallArgs(0, hostile.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([
        toolCallStart(0, "call_ok", "studio.get_context"),
        toolCallArgs(0, "{}"),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([textDelta("Done."), finish("stop"), DONE]),
    ]);
    stream.waitMode = "auto";

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome.kind).toBe("completed");
    expectExactlyCuratedToolsSent(fetchCalls);
    // The bomb never reached the editor; the repair turn named the bound.
    const started = stream.events.filter((event) => event.type === "tool.started");
    expect(started).toEqual([
      { type: "tool.started", toolCallId: "call_ok", name: "studio.get_context", args: {} },
    ]);
    const repair = JSON.parse(String(toolRoleMessage(fetchCalls[1])?.content ?? "null")) as {
      error: string;
      message: string;
    };
    expect(repair.error).toBe("VALIDATION_FAILED");
    expect(repair.message).toContain("layerIds");
  });

  it.each(
    ["preview-huge-width", "layers-depth-99", "context-unknown-block", "args-duplicate-key"].map(
      (id) => [id],
    ),
  )("hostile args %s: repeat offense → RUN_INVALID_TOOL", async (fixtureId) => {
    const hostile = hostileArgsFixture(fixtureId);
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_h1", hostile.tool),
        toolCallArgs(0, hostile.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([
        toolCallStart(0, "call_h2", hostile.tool),
        toolCallArgs(0, hostile.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome).toEqual({
      kind: "failed",
      code: "RUN_INVALID_TOOL",
      message: "The agent requested a tool call we can't validate.",
      retryable: false,
    });
    expect(stream.events.some((event) => event.type === "tool.started")).toBe(false);
    expectExactlyCuratedToolsSent(fetchCalls);
    expectPrototypeClean();
  });

  it("prototype-pollution keys in args are stripped by Zod, never honored", async () => {
    const hostile = hostileArgsFixture("args-proto-keys");
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_proto", hostile.tool),
        toolCallArgs(0, hostile.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([textDelta("Read them."), finish("stop"), DONE]),
    ]);
    stream.waitMode = "auto";

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome.kind).toBe("completed");
    expectExactlyCuratedToolsSent(fetchCalls);
    // The tool RAN — with the pollution keys stripped from the validated args.
    const started = stream.events.find((event) => event.type === "tool.started");
    expect(started).toMatchObject({ toolCallId: "call_proto", name: "studio.get_properties" });
    const argsJson = JSON.stringify((started as { args?: unknown } | undefined)?.args ?? {});
    expect(argsJson).toBe(JSON.stringify({ layerIds: ["l1"] }));
    expect(argsJson.includes("__proto__")).toBe(false);
    expect(argsJson.includes("constructor")).toBe(false);
    expect(argsJson.includes(hostile.needle)).toBe(false);
    expectPrototypeClean();
  });
});

// ---------------------------------------------------------------------------
// (6) PLAN BOUNDS — EDIT_PLAN_SCHEMA under hostile structured output
// ---------------------------------------------------------------------------

describe("safety — plan bounds hold (§8.6 / EDIT_PLAN_SCHEMA)", () => {
  it("EDIT_PLAN_SCHEMA rejects every hostile bound/shape and keeps data-payloads inert", () => {
    for (const fixture of HOSTILE_PLAN_PAYLOADS) {
      const parsed: unknown = JSON.parse(fixture.planJson);
      const checked = EDIT_PLAN_SCHEMA.safeParse(parsed);
      if (fixture.expectation === "reject") {
        expect(checked.success, fixture.id).toBe(false);
      } else {
        // "data" expectation: the payload PARSES, and the hostile fragment is
        // carried verbatim as inert JSON data (M4 compiles nothing — there is
        // no apply path; the M5 batch validator stays the gate).
        expect(checked.success, fixture.id).toBe(true);
        expect(JSON.stringify(checked.success ? checked.data : {}).includes(fixture.needle)).toBe(
          true,
        );
      }
      expectPrototypeClean();
    }
  });

  it("a valid plan with hostile-looking (but inert) data still parses — corpus sanity", () => {
    // The base builder must be valid: proves the rejects above come from the
    // hostile deltas, not from a broken fixture.
    expect(EDIT_PLAN_SCHEMA.safeParse(JSON.parse(JSON.stringify(minimalPlan()))).success).toBe(
      true,
    );
  });

  it("a $ref-escape plan fails 2 attempts → PLAN_INVALID tool result, run survives", async () => {
    const goalFixture = hostileArgsFixture("plan-goal-schema-override");
    const refPlan = HOSTILE_PLAN_PAYLOADS.find((fixture) => fixture.id === "plan-ref-escape");
    if (refPlan === undefined) throw new Error("fixture missing");
    const { runner, fetchCalls, stream } = makeRunner([
      // Main round: the model calls plan_edit with the schema-override goal.
      sseResponse([
        toolCallStart(0, "call_plan", "studio.plan_edit"),
        toolCallArgs(0, goalFixture.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
      // Structured attempt 1: the $ref-escape plan.
      sseResponse([textDelta(refPlan.planJson), finish("stop"), DONE]),
      // Structured attempt 2: the model smuggles the same $ref again.
      sseResponse([textDelta(refPlan.planJson), finish("stop"), DONE]),
      // Main round 2: the model gives up and answers in text.
      sseResponse([textDelta("I could not produce a valid plan."), finish("stop"), DONE]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    // The run SURVIVES: PLAN_INVALID is a tool result, not a run failure.
    expect(outcome.kind).toBe("completed");
    expect(stream.events.some((event) => event.type === "plan")).toBe(false);
    const toolResult = stream.events.find(
      (event) => event.type === "tool.result" && event.toolCallId === "call_plan",
    );
    expect(toolResult).toMatchObject({
      type: "tool.result",
      toolCallId: "call_plan",
      result: { error: "PLAN_INVALID" },
    });
    // Attempt 2 saw the validation error of attempt 1 as data…
    const attempt2 = fetchCalls[2]?.body.messages ?? [];
    expect(
      attempt2.some((message) => String(message.content).includes("was not a valid EditPlan")),
    ).toBe(true);
    // …and the structured calls never carried tools.
    expect(fetchCalls[1]?.body.tools).toBeUndefined();
    expect(fetchCalls[2]?.body.tools).toBeUndefined();
    // The goal's embedded schema override rode the structured prompt as DATA
    // (verbatim), while the fixed strict-JSON instruction still leads it.
    const planUser = fetchCalls[1]?.body.messages.at(-1);
    expect(String(planUser?.content).includes("STRICT JSON")).toBe(true);
    expect(String(planUser?.content).includes(goalFixture.needle)).toBe(true);
    expectExactlyCuratedToolsSent(fetchCalls);
    expectNoEngineCommandStrings(fetchCalls);
  });
});

// ---------------------------------------------------------------------------
// (7) STEP CAP under adversarial looping
// ---------------------------------------------------------------------------

describe("safety — adversarial looping still dies at the step cap (§8.9)", () => {
  it("multi-tool-per-round looping hits RUN_STEP_LIMIT; nothing grows unbounded", async () => {
    const { runner, fetchCalls, stream } = makeRunner(
      [
        sseResponse([
          toolCallStart(0, "call_a1", "studio.get_context"),
          toolCallArgs(0, "{}"),
          toolCallStart(1, "call_a2", "studio.get_context"),
          toolCallArgs(1, "{}"),
          finish("tool_calls"),
          DONE,
        ]),
        sseResponse([
          toolCallStart(0, "call_b1", "studio.get_context"),
          toolCallArgs(0, "{}"),
          toolCallStart(1, "call_b2", "studio.get_context"),
          toolCallArgs(1, "{}"),
          finish("tool_calls"),
          DONE,
        ]),
        sseResponse([
          toolCallStart(0, "call_c1", "studio.get_context"),
          toolCallArgs(0, "{}"),
          toolCallStart(1, "call_c2", "studio.get_context"),
          toolCallArgs(1, "{}"),
          finish("tool_calls"),
          DONE,
        ]),
      ],
      { maxSteps: 3 },
    );
    stream.waitMode = "auto";

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome).toEqual({
      kind: "failed",
      code: "RUN_STEP_LIMIT",
      message: "The agent used too many steps for one message.",
      retryable: false,
    });
    // Two valid calls per round × exactly maxSteps rounds — then a hard stop.
    expect(stream.events.filter((event) => event.type === "tool.started")).toHaveLength(6);
    expect(fetchCalls.length).toBe(3);
    expectExactlyCuratedToolsSent(fetchCalls);
  });
});

// ---------------------------------------------------------------------------
// Corpus self-checks (fail fast if the corpus drifts)
// ---------------------------------------------------------------------------

describe("corpus self-check", () => {
  it("every text fixture carries its needle and no needle appears in the system prompt", () => {
    expect(ALL_TEXT_FIXTURES.length).toBeGreaterThanOrEqual(18);
    expect(HOSTILE_TOOL_ARGS.length).toBeGreaterThanOrEqual(8);
    expect(TOOL_RESULT_INJECTIONS.length).toBeGreaterThanOrEqual(5);
    expect(HOSTILE_PLAN_PAYLOADS.length).toBeGreaterThanOrEqual(6);
    for (const fixture of ALL_TEXT_FIXTURES) {
      expect(fixture.payload.includes(fixture.needle), fixture.id).toBe(true);
      expect(SYSTEM_PROMPT.includes(fixture.needle)).toBe(false);
    }
    for (const fixture of HOSTILE_TOOL_ARGS) {
      expect(JSON.parse(fixture.argsJson)).toBeDefined();
    }
  });
});
