// M5-N — the WRITE-SURFACE PANIC HUNT (BUILD_PLAN §M5 task 8: "panic_hunt
// equivalent for tool args: adversarial JSON never crashes gateway or editor
// bridge"). Extends the M4-N read-side proofs (injection.test.ts) to the
// surfaces that MUTATE: the eight write tools' Zod args, the server-side plan
// compiler, the §8.5 batch wire and the plan-event pipeline that carries a
// compiledBatch to the client.
//
// Proves, against the corpus in ./injection-write.ts:
//   A. WRITE_TOOL_ARGS_SCHEMAS — every hostile args payload is REJECTED with a
//      typed Zod failure or parses with the poison as inert DATA; dunder keys
//      never survive into a KEY position; nothing throws, nothing pollutes.
//   B. compilePlan — hostile plans never crash the compiler: schema-rejected
//      poisons die at EDIT_PLAN_SCHEMA; schema-valid poisons get TYPED fatals;
//      and every ok:true batch is registry-clean (only AGENT_COMMAND_IDS, no
//      poison needles, no dunder keys anywhere).
//   C. FINDING F-5 (report-only pins) — the compiler's translate() reads the
//      OLD draft args shapes: five tools compile PERFECT, current-contracts
//      args to zero commands (PROPOSAL_INVALID today), create_text silently
//      drops validated typography fields, and a mixed plan silently drops the
//      drifted step. Flip these pins when plan-compiler.ts is fixed.
//   D. AGENT_BATCH_SCHEMA bounds (§8.5) + PLAN_EVENT_SCHEMA — the wire batch
//      rejects every bound violation; FINDING F-6 pins that the wire gate is
//      BOUNDS-ONLY (a dunder/shadow command parses) — the registry gate is the
//      compiler's, the engine's own rejection is the final defense.
//   E. The plan-event pipeline end-to-end (scripted-model harness, the
//      injection.test.ts technique): a poisoned plan NEVER yields a
//      compiledBatch carrying the poison — schema-rejected plans answer
//      PLAN_INVALID, compile-rejected plans ride the wire UN-enriched, and a
//      poisoned-but-compiling plan's compiledBatch contains none of the
//      poison (the proposal is advisory only).
//   F. Corpus self-check (fail fast on fixture drift).
//
// Deterministic: fake in-process OpenAI SSE server (injectable fetch) + fake
// AgentRunStream, real plan-compiler + real curated registry. No network, no
// Postgres for these paths (runs alongside the DB-gated suite).

import { describe, expect, it } from "vitest";

import {
  AGENT_BATCH_SCHEMA,
  AGENT_COMMAND_IDS,
  CONTEXT_SELECTION_SCHEMA,
  EDIT_PLAN_SCHEMA,
  PLAN_EVENT_SCHEMA,
  PROPOSED_BATCH_NOTE,
  TOOL_LIST,
  WRITE_TOOL_ARGS_SCHEMAS,
  hasNoDunderKeys,
} from "@studio/contracts";
import type { OpenAIChatMessage } from "../src/litellm/openai.js";
import { createLiteLLMRunner } from "../src/litellm/runner.js";
import { type PlanIssueCode, compilePlan, defaultCompileDeps } from "../src/plan-compiler.js";
import {
  type AgentRun,
  type AgentRunOutcome,
  type AgentRunStream,
  type RunStreamPayload,
  type ToolWaitResult,
} from "../src/runner.js";
import {
  BATCH_WIRE_POISONS,
  COMPILER_DRIFT_PROBES,
  DRIFT_MIXED_PLAN,
  WRITE_ARGS_INJECTIONS,
  WRITE_PLAN_INJECTIONS,
  batchWireFixture,
  writeArgsFixture,
  writeArgsValue,
  writePlan,
  writePlanFixture,
  writeStep,
} from "./injection-write.js";

// ---------------------------------------------------------------------------
// Fake OpenAI SSE server (scripted) — the M4-A/injection.test.ts harness
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

class FakeStream implements AgentRunStream {
  readonly events: RunStreamPayload[] = [];
  readonly controller = new AbortController();
  waitMode: "pending" | "auto" = "pending";
  private readonly waits = new Map<string, (result: ToolWaitResult) => void>();
  private readonly early = new Map<string, unknown>();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  emit(payload: RunStreamPayload) {
    this.events.push(payload);
  }

  async yieldToStream(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  expectToolCall(toolCallId: string, _tool: string): void {
    void toolCallId; // unused by this suite (write tools never wait client-side)
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
    runId: "run_m5n",
    threadId: "thr_m5n",
    projectId: "prj_m5n",
    workspaceId: "ws_m5n",
    model: "studio-smart",
    baseVersionId: null,
    message: "make the headline red",
    context: CONTEXT_SELECTION_SCHEMA.parse({}),
    pinned: [],
    reservedCredits: 10,
    ...overrides,
  };
}

function makeRunner(script: ReadonlyArray<Response>): {
  runner: ReturnType<typeof createLiteLLMRunner>;
  fetchCalls: RecordedCall[];
  stream: FakeStream;
} {
  const fetchStub = scriptedFetch(script);
  const stream = new FakeStream();
  const runner = createLiteLLMRunner({
    baseUrl: "http://127.0.0.1:4000",
    apiKey: "sk-platform",
    virtualKey: "sk-virtual-m5n",
    maxSteps: 8,
    fetch: fetchStub,
    sleep: async () => {},
    // NO injected compilePlan: the REAL ../plan-compiler.ts runs with the REAL
    // curated registry (M5-J) + the REAL write-tool schemas (M5-A) — the exact
    // production path a poisoned plan would take.
  });
  return { runner, fetchCalls: fetchStub.calls, stream };
}

// ---------------------------------------------------------------------------
// Security assertion helpers
// ---------------------------------------------------------------------------

/** Object.prototype must stay untouched by anything the pipeline processed. */
function expectPrototypeClean(): void {
  const probe: Record<string, unknown> = {};
  expect(probe.polluted).toBeUndefined();
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.getPrototypeOf(probe).polluted).toBeUndefined();
  expect(Object.hasOwn(Object.prototype, "toString")).toBe(true);
  expect(String({})).toBe("[object Object]"); // M4's paths:["toString"] overwrite probe
}

/** §8.4: every provider call offers EXACTLY the 13 curated tools, never the
 * raw engine entrypoints (the M5-N write edition of the M4 scan). */
const CURATED_TOOL_IDS = TOOL_LIST.map((tool) => tool.id);

function expectExactlyCuratedToolsSent(calls: readonly RecordedCall[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const tools = call.body.tools;
    if (tools === undefined) continue; // structured-output calls carry no tools
    expect(tools.map((tool) => tool.function.name)).toEqual(CURATED_TOOL_IDS);
  }
  for (const call of calls) {
    const serialized = JSON.stringify(call.body.tools ?? []);
    expect(serialized.includes("engine.execute")).toBe(false);
    expect(serialized.includes("engine.batch")).toBe(false);
  }
}

/** §12.2 (nuanced for the write corpus): raw engine strings may appear ONLY
 * inside tool-role messages (the VERBATIM plan data fed back per §8.3) or the
 * model's own assistant text replayed in the structured-attempt loop — never
 * in a tools array, never in a user/system turn. */
function expectEngineStringsConfinedToToolData(calls: readonly RecordedCall[]): void {
  for (const call of calls) {
    const tools = JSON.stringify(call.body.tools ?? []);
    expect(tools.includes("engine.execute")).toBe(false);
    expect(tools.includes("engine.batch")).toBe(false);
    for (const message of call.body.messages) {
      const content = String(message.content);
      if (!content.includes("engine.execute") && !content.includes("engine.batch")) continue;
      expect(
        message.role === "tool" || message.role === "assistant",
        "raw engine strings ride only as tool-role plan data or the model's own assistant text",
      ).toBe(true);
    }
  }
}

/** The typed compiler fatals this suite accepts (§M5.2 vocabulary). */
const KNOWN_FATAL_CODES: readonly PlanIssueCode[] = [
  "plan_schema",
  "plan_too_large",
  "internal",
  "unknown_tool",
  "invalid_args",
  "unusable_args",
  "empty_step",
  "empty_batch",
  "too_many_commands",
  "batch_too_large",
  "too_many_layer_names",
  "unknown_command",
  "missing_required_param",
  "unresolvable_ref",
];

/** Compile a hostile plan value; the wrapper proves compilePlan NEVER throws. */
function compileHostile(plan: unknown): ReturnType<typeof compilePlan> {
  const deps = defaultCompileDeps();
  let outcome: ReturnType<typeof compilePlan> | undefined;
  expect(() => {
    outcome = compilePlan(plan as never, deps);
  }).not.toThrow();
  if (outcome === undefined) throw new Error("compilePlan did not return");
  return outcome;
}

// ---------------------------------------------------------------------------
// A. WRITE_TOOL_ARGS_SCHEMAS — the args boundary (Zod, law #2)
// ---------------------------------------------------------------------------

describe("M5-N safety — write-tool args: every hostile payload is rejected or inert data", () => {
  it.each(WRITE_ARGS_INJECTIONS.map((fixture) => [fixture.id]))(
    "%s: typed verdict, zero pollution",
    (fixtureId) => {
      const fixture = writeArgsFixture(fixtureId);
      const schema = WRITE_TOOL_ARGS_SCHEMAS[fixture.tool];
      let parsed: { success: boolean; data?: unknown };
      expect(() => {
        parsed = schema.safeParse(writeArgsValue(fixture));
      }).not.toThrow();

      if (fixture.expectation === "reject") {
        expect(parsed!.success, fixture.id).toBe(false);
        // A typed failure is still a clean failure.
        expectPrototypeClean();
        return;
      }
      // "data": the payload parses; every dunder fragment stays a VALUE —
      // no dunder key anywhere in the parsed output (F-1 write edition).
      expect(parsed!.success, fixture.id).toBe(true);
      expect(hasNoDunderKeys(parsed!.data), fixture.id).toBe(true);
      expectPrototypeClean();
    },
  );

  it("the dunder rejection holds for EVERY tool that takes a layer/name/params surface", () => {
    // Cross-tool dunder matrix: one dunder probe per tool that accepts names —
    // none may pass its args boundary with the dunder intact (F-1 class).
    const probes: Record<string, { layers?: unknown; name?: unknown; params?: unknown }> = {
      set_properties: { layers: [{ name: "prototype" }] },
      add_effect: { layers: [{ name: "constructor" }] },
      set_keyframes: { layers: [{ name: "__proto__" }] },
      apply_preset: { preset: { name: "__proto__" } },
      create_text: { text: "x", name: "constructor" },
    };
    for (const [tool, args] of Object.entries(probes)) {
      const schema = WRITE_TOOL_ARGS_SCHEMAS[tool as keyof typeof WRITE_TOOL_ARGS_SCHEMAS];
      expect(schema.safeParse(args).success, tool).toBe(false);
    }
    expectPrototypeClean();
  });
});

// ---------------------------------------------------------------------------
// B. compilePlan — hostile plans never crash; ok batches are registry-clean
// ---------------------------------------------------------------------------

describe("M5-N safety — the plan compiler under hostile plans (typed issues, clean batches)", () => {
  it.each(WRITE_PLAN_INJECTIONS.map((fixture) => [fixture.id]))(
    "%s",
    (fixtureId) => {
      const fixture = writePlanFixture(fixtureId);
      const plan = JSON.parse(fixture.planJson);
      const schemaOk = EDIT_PLAN_SCHEMA.safeParse(plan).success;

      if (fixture.expectation === "plan_invalid") {
        expect(schemaOk, fixture.id).toBe(false);
        const result = compileHostile(plan);
        expect(result.ok, fixture.id).toBe(false);
        if (!result.ok) {
          expect(result.issues.length).toBeGreaterThan(0);
          expect(result.issues.every((issue) => issue.severity === "fatal")).toBe(true);
          expect(result.issues.map((issue) => issue.code)).toContain("plan_schema");
        }
        expectPrototypeClean();
        return;
      }

      // Schema-valid from here on.
      expect(schemaOk, fixture.id).toBe(true);
      const result = compileHostile(plan);

      if (fixture.expectation === "compile_fatal") {
        expect(result.ok, fixture.id).toBe(false);
        if (!result.ok) {
          expect(result.issues.length).toBeGreaterThan(0);
          for (const issue of result.issues) {
            expect(issue.severity === "fatal" || issue.severity === "warn", fixture.id).toBe(true);
            expect(KNOWN_FATAL_CODES, fixture.id).toContain(issue.code);
            // Law #1 hygiene: bounded, stack-free messages.
            expect(issue.message.length).toBeLessThanOrEqual(200);
            expect(issue.message.includes("\n")).toBe(false);
            expect(issue.message.includes(" at ")).toBe(false);
          }
        }
        expectPrototypeClean();
        return;
      }

      // compiled_clean: the poison was ADVISORY — the batch comes from args.
      expect(result.ok, fixture.id).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const serialized = JSON.stringify(result.batch);
      for (const poison of fixture.poisonNeedles) {
        expect(serialized.includes(poison), `${fixture.id}: poison "${poison}" leaked into the compiled batch`).toBe(
          false,
        );
      }
      // Registry-only commands (law #5: the compiler invents no ids).
      for (const step of result.batch.steps) {
        expect(AGENT_COMMAND_IDS, `${fixture.id}: command ${step.command}`).toContain(step.command);
      }
      // §8.5 envelope + dunder-free params anywhere in the batch (F-1 class).
      expect(AGENT_BATCH_SCHEMA.safeParse(result.batch).success, fixture.id).toBe(true);
      expect(hasNoDunderKeys(result.batch), fixture.id).toBe(true);
      expectPrototypeClean();
    },
  );

  it("hostile plans across the whole corpus leave the danger invariants intact in ONE sweep", () => {
    // The belt-and-braces pass: every plan fixture compiles without a throw and
    // no compiled batch anywhere carries a dunder key or a non-registry command.
    for (const fixture of WRITE_PLAN_INJECTIONS) {
      const result = compileHostile(JSON.parse(fixture.planJson));
      if (!result.ok) continue;
      for (const step of result.batch.steps) {
        expect(AGENT_COMMAND_IDS, fixture.id).toContain(step.command);
      }
      expect(hasNoDunderKeys(result.batch), fixture.id).toBe(true);
    }
    expectPrototypeClean();
  });
});

// ---------------------------------------------------------------------------
// C. FINDING F-5 — the args-shape drift between the landed contracts schemas
//    and the compiler's translate() (report-only pins; flip when fixed)
// ---------------------------------------------------------------------------

describe("M5-N FINDING F-5 — the compiler reads the OLD draft args shapes (drift pins)", () => {
  it.each(COMPILER_DRIFT_PROBES.map((fixture) => [fixture.id]))(
    "%s: perfect CURRENT-contracts args (FINDING F-5, report-only)",
    (fixtureId) => {
      const probe = COMPILER_DRIFT_PROBES.find((item) => item.id === fixtureId);
      if (probe === undefined) throw new Error("fixture missing");
      // 1. The args are PERFECTLY VALID under the CURRENT contracts schema…
      const schema = WRITE_TOOL_ARGS_SCHEMAS[probe.tool];
      const argsCheck = schema.safeParse(JSON.parse(probe.argsJson));
      expect(argsCheck.success, `${probe.id}: the landed schema accepts these args`).toBe(true);

      // 2. …but the compiler translates them with the old field names.
      const plan = writePlan([writeStep(probe.tool, JSON.parse(probe.argsJson))]);
      const result = compileHostile(plan);
      if (probe.compiledToday === "empty") {
        // F-5 as it stands: zero commands → every perfectly-argued call for
        // set_properties / set_keyframes / add_effect / apply_preset answers
        // PROPOSAL_INVALID. FLIP THIS BLOCK when translate() reads the
        // current shapes (the block above stays green either way).
        expect(result.ok, `${probe.id}: drift pin — currently compiles to nothing`).toBe(false);
        if (!result.ok) {
          expect(result.issues.map((issue) => issue.code)).toContain("empty_batch");
        }
      } else {
        // create_text compiles but SILENTLY DROPS the validated typography
        // fields (font/style/size/fill) — the compiled params carry only the
        // old-shape fields (text/name/position).
        expect(result.ok, `${probe.id}: drift pin — currently compiles partially`).toBe(true);
        if (result.ok) {
          const step = result.batch.steps[0];
          expect(step?.command).toBe("layer.newText");
          expect(step?.params).toEqual({
            text: "M5N-DRIFT-CREATE-TEXT",
            name: "Title",
            position: [960, 540],
          });
        }
      }
      expectPrototypeClean();
    },
  );

  it("FINDING F-5 (sharpest edge): a mixed plan SILENTLY DROPS the drifted step from the applied batch", () => {
    // The user approves a plan card that says "create a Title AND set the
    // Headline text"; the compiled batch carries ONLY the create_text step —
    // the set_properties translation is silently empty (warn unusable_args),
    // so Apply would run HALF the approved plan. Flip when translate() is
    // aligned with the landed schemas.
    const result = compileHostile(DRIFT_MIXED_PLAN);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.batch.steps.map((step) => step.command)).toEqual(["layer.newText"]);
    expect(JSON.stringify(result.batch).includes("M5N-DRIFT-MIXED-PROP")).toBe(false);
    expect(result.warnings.map((issue) => issue.code)).toContain("unusable_args");
    expectPrototypeClean();
  });
});

// ---------------------------------------------------------------------------
// D. §8.5 wire bounds — AGENT_BATCH_SCHEMA + the plan event's compiledBatch
// ---------------------------------------------------------------------------

describe("M5-N safety — §8.5 batch bounds on the wire (AGENT_BATCH_SCHEMA + PLAN_EVENT_SCHEMA)", () => {
  it.each(BATCH_WIRE_POISONS.map((fixture) => [fixture.id]))(
    "%s",
    (fixtureId) => {
      const fixture = batchWireFixture(fixtureId);
      const payload = JSON.parse(fixture.batchJson);
      let parsed: { success: boolean; data?: unknown };
      expect(() => {
        parsed = AGENT_BATCH_SCHEMA.safeParse(payload);
      }).not.toThrow();
      expect(parsed!.success, fixture.id).toBe(fixture.expectation === "parse");
      expectPrototypeClean();
    },
  );

  it("FINDING F-6 (report-only): the wire gate is BOUNDS-ONLY — a hostile command id rides a plan event", () => {
    // AGENT_BATCH_SCHEMA checks shape/size/refs — NOT command-id membership.
    // A plan event whose compiledBatch carries a non-registry command (or the
    // NOT_IN_BATCH raw entrypoint) PARSES the §7.4 wire schema. The defenses
    // are upstream (the compiler's registry gate, proved in section B) and
    // downstream (the engine's own registry/NOT_IN_BATCH rejection, pinned in
    // the web suite). Pin the schema gap so it never silently widens further.
    const plan = EDIT_PLAN_SCHEMA.parse(writePlan([writeStep("create_composition", { name: "Intro" })]));
    for (const fixtureId of ["wire-dunder-command", "wire-shadow-engine-batch"]) {
      const fixture = batchWireFixture(fixtureId);
      const batch = AGENT_BATCH_SCHEMA.parse(JSON.parse(fixture.batchJson));
      const event = {
        type: "plan" as const,
        runId: "run_m5n",
        seq: 0,
        plan,
        compiledBatch: batch,
      };
      expect(PLAN_EVENT_SCHEMA.safeParse(event).success, fixtureId).toBe(true);
    }
    // The wire schema DOES enforce the §8.5 bounds on compiledBatch:
    const oversized = JSON.parse(batchWireFixture("wire-timeout-1e12").batchJson);
    const boundedEvent = {
      type: "plan" as const,
      runId: "run_m5n",
      seq: 0,
      plan,
      compiledBatch: oversized,
    };
    expect(PLAN_EVENT_SCHEMA.safeParse(boundedEvent).success).toBe(false);
    expectPrototypeClean();
  });

  it("a clean compiled batch rides a plan event verbatim (the sanity wire)", () => {
    const plan = EDIT_PLAN_SCHEMA.parse(writePlan([writeStep("create_composition", { name: "Intro" })]));
    const batch = AGENT_BATCH_SCHEMA.parse(JSON.parse(batchWireFixture("wire-clean").batchJson));
    const event = { type: "plan" as const, runId: "run_m5n", seq: 3, plan, compiledBatch: batch };
    const parsed = PLAN_EVENT_SCHEMA.safeParse(event);
    expect(parsed.success).toBe(true);
    expectPrototypeClean();
  });
});

// ---------------------------------------------------------------------------
// E. The plan-event pipeline end-to-end (scripted model; the REAL compiler)
// ---------------------------------------------------------------------------

describe("M5-N safety — a poisoned plan NEVER yields a poisoned compiledBatch on the wire", () => {
  it("a schema-rejected poison plan answers PLAN_INVALID twice → the run survives, no plan event", async () => {
    const poison = writePlanFixture("plan-batch-steps-as-strings");
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_plan", "studio.plan_edit"),
        toolCallArgs(0, '{"goal":"add a comp"}'),
        finish("tool_calls"),
        DONE,
      ]),
      // Structured attempt 1 + 2: the poisoned plan (steps as strings).
      sseResponse([textDelta(poison.planJson), finish("stop"), DONE]),
      sseResponse([textDelta(poison.planJson), finish("stop"), DONE]),
      sseResponse([textDelta("I could not produce a valid plan."), finish("stop"), DONE]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

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
    expectExactlyCuratedToolsSent(fetchCalls);
    expectEngineStringsConfinedToToolData(fetchCalls);
    expectPrototypeClean();
  });

  it("a compile-rejected poison plan rides the wire UN-ENRICHED (no compiledBatch, no apply surface)", async () => {
    const poison = writePlanFixture("plan-tool-shadows-read-tool"); // schema-valid, unknown_tool fatal
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_plan", "studio.plan_edit"),
        toolCallArgs(0, '{"goal":"organize the layers"}'),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([textDelta(poison.planJson), finish("stop"), DONE]),
      sseResponse([textDelta("Plan noted for review."), finish("stop"), DONE]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome.kind).toBe("completed");
    const planEvents = stream.events.filter((event) => event.type === "plan");
    expect(planEvents).toHaveLength(1);
    const planEvent = planEvents[0] as Record<string, unknown>;
    expect(planEvent.compiledBatch).toBeUndefined(); // ← the apply gate
    expect(planEvent.resolutionRequests).toBeUndefined();
    // The hostile step tool string rode the wire as plan DATA (fidelity)…
    expect(JSON.stringify(planEvent).includes(poison.needle)).toBe(true);
    // …and the model saw the bare plan as tool-role data — never a command.
    const toolMessage = fetchCalls[2]?.body.messages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content).includes(poison.needle)).toBe(true);
    expectExactlyCuratedToolsSent(fetchCalls);
    expectEngineStringsConfinedToToolData(fetchCalls);
    expectPrototypeClean();
  });

  it("a poisoned-but-compiling plan yields a compiledBatch with NONE of the poison", async () => {
    const poison = writePlanFixture("plan-batch-unknown-command"); // proposal: evil.delete.everything
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_plan", "studio.plan_edit"),
        toolCallArgs(0, '{"goal":"add an intro comp"}'),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([textDelta(poison.planJson), finish("stop"), DONE]),
      sseResponse([textDelta("Plan ready for review."), finish("stop"), DONE]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome.kind).toBe("completed");
    const planEvents = stream.events.filter((event) => event.type === "plan");
    expect(planEvents).toHaveLength(1);
    const planEvent = planEvents[0] as Record<string, unknown>;
    const batch = planEvent.compiledBatch;
    expect(batch).toBeDefined();
    // The wire event re-validates the compiled batch (PLAN_EVENT_SCHEMA)…
    const wireEvent = {
      type: "plan" as const,
      runId: "run_m5n",
      seq: 0,
      plan: (planEvent as { plan: unknown }).plan,
      compiledBatch: batch,
    };
    expect(PLAN_EVENT_SCHEMA.safeParse(wireEvent).success).toBe(true);
    // …and NONE of the proposed-batch poison reached it: the compiled batch is
    // the args translation only (comp.new), the poison needles are absent…
    const serialized = JSON.stringify(batch);
    for (const needle of poison.poisonNeedles) {
      expect(serialized.includes(needle), needle).toBe(false);
    }
    const steps = (batch as { steps: Array<{ command: string }> }).steps;
    expect(steps.map((step) => step.command)).toEqual(["comp.new"]);
    // …while the model saw the POISONED PROPOSAL as tool-role data (data
    // fidelity: it is what the model said, byte for byte).
    const toolMessage = fetchCalls[2]?.body.messages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content).includes("M5N-POISON-COMMAND")).toBe(true);
    expectExactlyCuratedToolsSent(fetchCalls);
    expectEngineStringsConfinedToToolData(fetchCalls);
    expectPrototypeClean();
  });

  it("hostile write-tool ARGS get the repair turn, never a proposal (the args boundary)", async () => {
    const hostile = writeArgsFixture("sp-layer-dunder");
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_dunder", "studio.set_properties"),
        toolCallArgs(0, hostile.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([
        toolCallStart(0, "call_dunder2", "studio.set_properties"),
        toolCallArgs(0, hostile.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome).toMatchObject({ kind: "failed", code: "RUN_INVALID_TOOL", retryable: false });
    // The dunder call NEVER reached the editor as a tool.started, and no
    // proposal (tool.result) was ever emitted for it.
    expect(stream.events.some((event) => event.type === "tool.started")).toBe(false);
    expect(stream.events.some((event) => event.type === "tool.result")).toBe(false);
    const repair = JSON.parse(
      String(fetchCalls[1]?.body.messages.find((message) => message.role === "tool")?.content),
    ) as { error: string; message: string };
    expect(repair.error).toBe("VALIDATION_FAILED");
    expect(repair.message).toContain("studio.set_properties");
    expectExactlyCuratedToolsSent(fetchCalls);
    expectPrototypeClean();
  });
  it("FINDING F-5 at the runner wire: PERFECT set_properties args propose NOTHING today", async () => {
    const drift = COMPILER_DRIFT_PROBES.find((item) => item.id === "drift-set-properties");
    if (drift === undefined) throw new Error("fixture missing");
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_write", "studio.set_properties"),
        toolCallArgs(0, drift.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([textDelta("The change could not be proposed."), finish("stop"), DONE]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);

    expect(outcome.kind).toBe("completed");
    // The args passed the STRICT schema (tool.started shows them verbatim)…
    const started = stream.events.find((event) => event.type === "tool.started");
    expect(started).toMatchObject({
      toolCallId: "call_write",
      name: "studio.set_properties",
      args: JSON.parse(drift.argsJson),
    });
    // …and STILL nothing executes: the drift (F-5) turns the perfect args into
    // an empty translation → PROPOSAL_INVALID (fail-closed). Flip with F-5.
    const result = stream.events.find(
      (event) => event.type === "tool.result" && event.toolCallId === "call_write",
    );
    expect(result).toMatchObject({ result: { error: "PROPOSAL_INVALID" } });
    const toolMessage = fetchCalls[1]?.body.messages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content).includes("PROPOSAL_INVALID")).toBe(true);
    expectExactlyCuratedToolsSent(fetchCalls);
    expectEngineStringsConfinedToToolData(fetchCalls);
    expectPrototypeClean();
  });

  it("the model NEVER sees the proposed-batch command ids (redacted envelope, law #5)", async () => {
    const drift = COMPILER_DRIFT_PROBES.find((item) => item.id === "drift-apply-preset");
    if (drift === undefined) throw new Error("fixture missing");
    const { runner, fetchCalls, stream } = makeRunner([
      sseResponse([
        toolCallStart(0, "call_preset", "studio.apply_preset"),
        toolCallArgs(0, drift.argsJson),
        finish("tool_calls"),
        DONE,
      ]),
      sseResponse([textDelta("Understood."), finish("stop"), DONE]),
    ]);

    const outcome = await runToOutcome(runner, makeRun(), stream);
    expect(outcome.kind).toBe("completed");
    // Even a PROPOSAL result must be the pinned envelope or the typed refusal —
    // never a raw engine command string (this run refuses via F-5; the M4-N
    // suite proves the proposing shape with a stub compiler).
    for (const call of fetchCalls.slice(1)) {
      const toolMessage = call.body.messages.find((message) => message.role === "tool");
      if (toolMessage === undefined) continue;
      const content = String(toolMessage.content);
      expect(content.includes("anim.applyBuiltinPreset")).toBe(false);
      expect(content.includes(PROPOSED_BATCH_NOTE) || content.includes("PROPOSAL_INVALID")).toBe(
        true,
      );
    }
    expectExactlyCuratedToolsSent(fetchCalls);
    expectEngineStringsConfinedToToolData(fetchCalls);
    expectPrototypeClean();
  });
});

// ---------------------------------------------------------------------------
// F. Corpus self-check (fail fast on fixture drift)
// ---------------------------------------------------------------------------

describe("M5-N corpus self-check", () => {
  it("every JSON fixture parses and carries its needle (argsValue fixtures documented)", () => {
    expect(WRITE_ARGS_INJECTIONS.length).toBeGreaterThanOrEqual(40);
    expect(WRITE_PLAN_INJECTIONS.length).toBeGreaterThanOrEqual(18);
    expect(BATCH_WIRE_POISONS.length).toBeGreaterThanOrEqual(16);
    expect(COMPILER_DRIFT_PROBES.length).toBe(5);

    for (const fixture of WRITE_ARGS_INJECTIONS) {
      if (fixture.argsValue !== undefined) continue; // non-JSON poison (NaN)
      const parsed = JSON.parse(fixture.argsJson) as unknown;
      expect(parsed, fixture.id).toBeDefined();
      expect(fixture.argsJson.includes(fixture.needle), `${fixture.id}: needle missing from argsJson`).toBe(
        true,
      );
    }
    for (const fixture of WRITE_PLAN_INJECTIONS) {
      expect(JSON.parse(fixture.planJson), fixture.id).toBeDefined();
      expect(fixture.planJson.includes(fixture.needle), `${fixture.id}: needle missing`).toBe(true);
    }
    for (const fixture of BATCH_WIRE_POISONS) {
      expect(JSON.parse(fixture.batchJson), fixture.id).toBeDefined();
      expect(fixture.batchJson.includes(fixture.needle), `${fixture.id}: needle missing`).toBe(true);
    }
    for (const fixture of COMPILER_DRIFT_PROBES) {
      expect(JSON.parse(fixture.argsJson), fixture.id).toBeDefined();
      expect(fixture.threat.startsWith("FINDING F-5"), fixture.id).toBe(true);
    }
  });

  it("the corpus names the two M5-N findings it pins (F-5 drift + F-6 wire gate)", () => {
    const threats = [
      ...COMPILER_DRIFT_PROBES.map((fixture) => fixture.threat),
      ...BATCH_WIRE_POISONS.map((fixture) => fixture.threat),
    ].join(" ");
    expect(threats.includes("FINDING F-5")).toBe(true);
    expect(threats.includes("FINDING F-6")).toBe(true);
  });
});
