// W6-B — executor loop: plan walk, budgets, deviations, clean stop, retry-once.
//
// Spec anchors: §5.1 (small steps / round-trip caps), §5.2 (budgets are hard
// caps; clean stop is a feature), §5.5 (deviations logged), §5.7 (untrusted
// names/args), §6.3 + §23.1 rule 7 (retry budget / no identical failed call),
// §3.4 (per-call deadline, run abort), §23.1 (prompt, verbatim).
//
// The model seam is a scripted async generator: turns are consumed across the
// per-step streamToolLoop calls; because the executor is pull-driven, results
// land in the transcript BETWEEN the fake's yields — exactly how the worker's
// AI-SDK loop will observe them.
import {
  type AnyTool,
  type AssetStoreLike,
  type DbLike,
  type EngineFailure,
  type EngineLike,
  type TemplateCatalogLike,
  type BudgetTracker as ToolBudgetTracker,
  type ToolContext,
  type ToolListing,
  type ToolLogger,
  type ToolResult,
  defineTool,
  err as toolErr,
  ok as toolOk,
} from "@studio/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetTracker, type Clock } from "../src/budgets.js";
import {
  EXECUTOR_DEFAULT_MAX_ROUND_TRIPS,
  EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS,
  type EmitExecutorStepEvent,
  type ExecuteInput,
  type ExecuteModelLike,
  type ExecutorBudgetView,
  type ExecutorEvent,
  type ExecutorLimits,
  type ExecutorMessage,
  ExecutorService,
  type ExecutorStatus,
  type ExecutorStepEvent,
  TOOL_RETRY_EXHAUSTED_FEEDBACK_CODE,
  canonicalCallKey,
  executorLimitsFromTier,
} from "../src/executor/index.js";
import {
  EXECUTOR_SYSTEM_PROMPT_TEMPLATE,
  TOOLS_BLOCK_HEADER,
  buildExecutorSystemPrompt,
} from "../src/executor/prompt.js";
import { ToolCallGate } from "../src/guards/tool-gate.js";
import { type Plan, validatePlan } from "../src/plan.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A deterministic tool whose calls always succeed (§6.1-shaped envelope). */
function okTool(
  name: string,
  options: {
    readonly revision?: number;
    readonly run?: (
      args: Readonly<Record<string, unknown>>,
      signal: AbortSignal,
    ) => ToolResult | Promise<ToolResult>;
  } = {},
): AnyTool {
  return defineTool({
    name,
    description: `Test ${name} tool — deterministic executor fake.`,
    args: z.record(z.string(), z.unknown()),
    run: async (_ctx, args: Readonly<Record<string, unknown>>, signal) => {
      if (options.run !== undefined) {
        return await options.run(args, signal);
      }
      return toolOk({
        summary: `${name} done`,
        ...(options.revision === undefined ? {} : { documentRevision: options.revision }),
      });
    },
  });
}

/** §6.1-style rejection helper so sleep honors the executor's abort signal. */
function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function signalSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** strict-schema tool: 9999 fails parseToolArgs; size ≥ 300 fails at "engine" level. */
const textSetTool = defineTool({
  name: "text_set",
  description: "Set editable text (strict test schema).",
  args: z.strictObject({ size: z.number().int().min(4).max(400) }),
  run: async (_ctx, args) => {
    if (args.size >= 300) {
      return toolErr("text_overflow", "Text does not fit the slot box at this size", {
        hint: "Reduce size to 72pt or shorten the copy.",
        retryable: false,
      });
    }
    return toolOk({ summary: `text set at ${args.size}pt`, documentRevision: 9 });
  },
});

function defaultFakeTools(overrides: Record<string, AnyTool> = {}): Record<string, AnyTool> {
  return {
    template_apply: okTool("template_apply", { revision: 7 }),
    template_fill: okTool("template_fill", { revision: 8 }),
    render_preview: okTool("render_preview", { revision: 12 }),
    workspace_snapshot: okTool("workspace_snapshot"),
    text_set: textSetTool,
    ...overrides,
  };
}

/** Minimal §6.2 ToolContext — fake tools never touch the seams. */
function fakeContext(): ToolContext {
  const engineFailure: EngineFailure = {
    ok: false,
    code: "engine_unavailable",
    message: "fake engine seam (executor tests)",
  };
  const engine: EngineLike = {
    batch: async () => engineFailure,
    execute: async () => engineFailure,
    render: async () => engineFailure,
    inspect: async () => engineFailure,
    listLayers: async () => engineFailure,
  };
  const db: DbLike = {
    getDocument: async () => undefined,
    appendCommandLog: async () => {},
  };
  const templates: TemplateCatalogLike = {
    get: async () => undefined,
    list: async () => [],
  };
  const assets: AssetStoreLike = {
    search: async () => [],
    get: async () => undefined,
  };
  const budgets: ToolBudgetTracker = {
    remaining: () => ({ msRemaining: 10_000, commandsRemaining: 100 }),
    charge: () => true,
  };
  const logger: ToolLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return {
    engine,
    db,
    templates,
    assets,
    budgets,
    workspace: { organizationId: "org_test", brandTokens: { palette: {}, fonts: [] } },
    logger,
    now: () => new Date(0),
  };
}

// --- the scripted model seam -------------------------------------------------

interface ScriptedCall {
  readonly name: string;
  readonly args?: unknown;
  readonly callId?: string;
}

interface ScriptedTurn {
  readonly calls?: readonly ScriptedCall[];
  readonly text?: string;
  readonly done?: true | string;
  readonly usage?: {
    readonly tokensIn?: number;
    readonly tokensOut?: number;
    readonly cacheHits?: number;
  };
}

interface ScriptedModelState {
  /** streamToolLoop invocations = plan steps that reached the seam. */
  calls: number;
  systems: string[];
  budgets: ExecutorBudgetView[];
  toolsSeen: ToolListing[][];
  /** Transcript snapshot before every yield — how the fake "sees" executor feedback. */
  snapshots: (readonly ExecutorMessage[])[];
  turnsConsumed: number;
}

function scriptedModel(
  turns: readonly ScriptedTurn[],
  options: { omitTurnStarted?: boolean } = {},
): { model: ExecuteModelLike; state: ScriptedModelState } {
  const state: ScriptedModelState = {
    calls: 0,
    systems: [],
    budgets: [],
    toolsSeen: [],
    snapshots: [],
    turnsConsumed: 0,
  };
  let turn = 0;
  const model: ExecuteModelLike = {
    async *streamToolLoop(system, messages, tools, budget): AsyncIterable<ExecutorEvent> {
      state.calls += 1;
      state.systems.push(system);
      state.toolsSeen.push([...tools]);
      state.budgets.push(budget);
      const snap = (): void => {
        state.snapshots.push(messages.messages());
      };
      while (turn < turns.length) {
        const scripted: ScriptedTurn | undefined = turns[turn];
        if (scripted === undefined) {
          return; // unreachable: bounds checked — keeps noUncheckedIndexedAccess happy
        }
        turn += 1;
        state.turnsConsumed += 1;
        if (options.omitTurnStarted !== true) {
          yield { type: "turn_started" };
        }
        if (scripted.usage !== undefined) {
          yield {
            type: "usage",
            usage: {
              model: "fake-model",
              tokensIn: scripted.usage.tokensIn ?? 0,
              tokensOut: scripted.usage.tokensOut ?? 0,
              cacheHits: scripted.usage.cacheHits ?? 0,
            },
          };
        }
        for (const [index, call] of (scripted.calls ?? []).entries()) {
          snap();
          yield {
            type: "tool_call",
            callId: call.callId ?? `c${turn}-${index}`,
            name: call.name,
            args: call.args ?? {},
          };
        }
        if (scripted.text !== undefined) {
          yield { type: "text", text: scripted.text };
        }
        if (scripted.done !== undefined) {
          snap();
          yield {
            type: "step_done",
            text: typeof scripted.done === "string" ? scripted.done : undefined,
          };
          return;
        }
      }
    },
  };
  return { model, state };
}

// --- fixtures ----------------------------------------------------------------

function makePlan(steps: readonly { tool: string; args?: Record<string, unknown> }[]): Plan {
  const result = validatePlan({
    intent: "create_post",
    template: null,
    steps: steps.map((step) => ({ tool: step.tool, args: step.args ?? {} })),
    model_tier: "standard",
    notes_for_user: "test plan",
  });
  if (!result.ok) {
    throw new Error(`test plan fixture invalid: ${result.issues.join("; ")}`);
  }
  return result.plan;
}

function makeBudget(options: { toolCallCap?: number; clock?: Clock } = {}): BudgetTracker {
  return new BudgetTracker(
    {
      tokenBudgetIn: 10_000,
      tokenBudgetOut: 2_000,
      toolCallCap: options.toolCallCap ?? 12,
      revisions: 2,
      wallClockMs: 600_000,
    },
    options.clock ?? (() => 0),
  );
}

function makeInput(plan: Plan, budget: BudgetTracker, phase?: ExecuteInput["phase"]): ExecuteInput {
  return {
    plan,
    budget,
    maxToolCalls: 12,
    maxRevisions: 2,
    maxTokens: 10_000,
    ...(phase === undefined ? {} : { phase }),
  };
}

interface ServiceFixture {
  readonly service: ExecutorService;
  readonly events: ExecutorStepEvent[];
}

function makeService(
  model: ExecuteModelLike,
  options: {
    tools?: Record<string, AnyTool>;
    limits?: Partial<ExecutorLimits>;
    clock?: Clock;
    emit?: EmitExecutorStepEvent;
  } = {},
): ServiceFixture {
  const tools = options.tools ?? defaultFakeTools();
  const manifest: ToolListing[] = Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
  const events: ExecutorStepEvent[] = [];
  const service = new ExecutorService({
    model,
    tools,
    manifest,
    toolContext: fakeContext(),
    emit: options.emit ?? ((event) => void events.push(event)),
    clock: options.clock ?? (() => 0),
    limits: options.limits,
  });
  return { service, events };
}

function isStarted(event: ExecutorStepEvent): boolean {
  return event.type === "step.started";
}

/** All tool-result codes seen by the fake, in yield order. */
function toolResultCodes(snapshots: readonly (readonly ExecutorMessage[])[]): string[] {
  const codes: string[] = [];
  for (const messages of snapshots) {
    for (const message of messages) {
      if (message.role === "tool") {
        codes.push(message.result.ok ? "ok" : message.result.code);
      }
    }
  }
  return codes;
}

/** Tool-result codes in the LATEST transcript snapshot (full history at that point). */
function lastSnapshotCodes(state: {
  readonly snapshots: readonly (readonly ExecutorMessage[])[];
}): string[] {
  return toolResultCodes(state.snapshots.slice(-1));
}

// ---------------------------------------------------------------------------
// §23.1 prompt
// ---------------------------------------------------------------------------

describe("prompt: §23.1 executor system prompt (verbatim)", () => {
  const manifest: ToolListing[] = [
    { name: "workspace_snapshot", description: "One-call context: canvas, layers, slots." },
    { name: "text_set", description: "Create or rewrite editable text (fits to box)." },
  ];

  it("renders the §23.1 block verbatim with budget numbers substituted", () => {
    const prompt = buildExecutorSystemPrompt({
      maxToolCalls: 12,
      maxRevisions: 2,
      maxTokens: 85_000,
      toolsManifest: manifest,
    });
    const expectedBody = EXECUTOR_SYSTEM_PROMPT_TEMPLATE.split("{max_tool_calls}")
      .join("12")
      .split("{max_revisions}")
      .join("2")
      .split("{max_tokens}")
      .join("85000");
    expect(prompt.startsWith(expectedBody)).toBe(true);
    expect(prompt).toContain(
      "6. Stay inside your budget: 12 tool calls, 2 revisions,\n85000 tokens.",
    );
    // 10 non-negotiable rules + the output protocol note are all present, in order.
    expect(prompt).toContain("Non-negotiable rules:");
    expect(prompt).toContain("1. Inspect before you edit.");
    expect(prompt).toContain("10. If you lack required information");
    expect(prompt.indexOf("Output protocol:")).toBeGreaterThan(prompt.indexOf("10. If you lack"));
  });

  it("appends the tools manifest block (names + descriptions only, §6.1)", () => {
    const prompt = buildExecutorSystemPrompt({
      maxToolCalls: 12,
      maxRevisions: 2,
      maxTokens: 85_000,
      toolsManifest: manifest,
    });
    expect(prompt).toContain(
      `${TOOLS_BLOCK_HEADER}\n- workspace_snapshot — One-call context: canvas, layers, slots.`,
    );
    expect(prompt.endsWith("- text_set — Create or rewrite editable text (fits to box).")).toBe(
      true,
    );
  });

  it("is byte-stable per input and changes with the numbers (§5.3 cache anchor)", () => {
    const input = { maxToolCalls: 6, maxRevisions: 1, maxTokens: 20_000, toolsManifest: manifest };
    const again = buildExecutorSystemPrompt(input);
    expect(buildExecutorSystemPrompt(input)).toBe(again);
    expect(again).not.toBe(buildExecutorSystemPrompt({ ...input, maxToolCalls: 24 }));
  });

  it("omits the tools block for an empty manifest and rejects nonsense inputs (zod boundary)", () => {
    const body = buildExecutorSystemPrompt({
      maxToolCalls: 12,
      maxRevisions: 2,
      maxTokens: 85_000,
      toolsManifest: [],
    });
    expect(body).not.toContain(TOOLS_BLOCK_HEADER);
    expect(() =>
      buildExecutorSystemPrompt({
        maxToolCalls: -1,
        maxRevisions: 2,
        maxTokens: 85_000,
        toolsManifest: [],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Limits (§5.1 round trips, per tier)
// ---------------------------------------------------------------------------

describe("limits: §5.1 round-trip cap defaults + tier resolution", () => {
  it("defaults to 8 round trips per phase (§5.1) and §3.4's 5 s per-call deadline", () => {
    expect(EXECUTOR_DEFAULT_MAX_ROUND_TRIPS).toBe(8);
    expect(EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS).toBe(5000);
    expect(executorLimitsFromTier("standard")).toEqual({
      maxRoundTrips: 8,
      toolCallTimeoutMs: 5000,
    });
  });

  it("resolves per-tier caps from @studio/config (premium ×1.5, max ×2)", () => {
    expect(executorLimitsFromTier("quick").maxRoundTrips).toBe(8);
    expect(executorLimitsFromTier("premium").maxRoundTrips).toBe(12);
    expect(executorLimitsFromTier("max").maxRoundTrips).toBe(16);
    expect(() => executorLimitsFromTier("image_gen")).toThrow(/never execute plans/);
  });
});

// ---------------------------------------------------------------------------
// Service construction
// ---------------------------------------------------------------------------

describe("executor service: construction gates (wiring bugs fail fast)", () => {
  const { model } = scriptedModel([]);

  it("requires every seam", () => {
    expect(
      () =>
        new ExecutorService({
          model: { streamToolLoop: undefined } as unknown as ExecuteModelLike,
          tools: defaultFakeTools(),
          manifest: [{ name: "text_set", description: "Set text." }],
          toolContext: fakeContext(),
          emit: () => {},
        }),
    ).toThrow();
    expect(() => makeService(model, { tools: {} })).toThrow(/non-empty/);
    expect(() =>
      makeService(model, {
        tools: { ...defaultFakeTools(), ghost: undefined as unknown as AnyTool },
      }),
    ).toThrow();
  });

  it("requires a non-empty manifest, an emit function, and sane limits (zod)", () => {
    const tools = defaultFakeTools();
    expect(
      () =>
        new ExecutorService({
          model,
          tools,
          manifest: [],
          toolContext: fakeContext(),
          emit: () => {},
        }),
    ).toThrow(/manifest/);
    expect(
      () =>
        new ExecutorService({
          model,
          tools,
          manifest: [{ name: "text_set", description: "Set text." }],
          toolContext: fakeContext(),
          emit: "not-a-function" as unknown as EmitExecutorStepEvent,
        }),
    ).toThrow(/emit/);
    expect(() => makeService(model, { limits: { maxRoundTrips: 0 } })).toThrow();
    expect(() => makeService(model, { limits: { toolCallTimeoutMs: 0 } })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy plan walk
// ---------------------------------------------------------------------------

describe("executor: happy plan walk (§5.1 small steps)", () => {
  it("walks every step, executes each planned tool, emits step.started/finished, reports usage", async () => {
    const plan = makePlan([
      { tool: "template_apply" },
      { tool: "template_fill" },
      { tool: "render_preview" },
    ]);
    const { model, state } = scriptedModel([
      {
        usage: { tokensIn: 100, tokensOut: 20, cacheHits: 1 },
        calls: [{ name: "template_apply", args: { template: "instagram-post@3" } }],
        done: true,
      },
      { calls: [{ name: "template_fill" }], done: true },
      { calls: [{ name: "render_preview" }], done: "Done: applied, filled, previewed." },
    ]);
    const { service, events } = makeService(model);
    const budget = makeBudget();

    const report = await service.execute(makeInput(plan, budget), new AbortController().signal);

    expect(report.status).toBe("completed");
    expect(report.cut).toBeNull();
    expect(report.steps.map((step) => step.plannedTool)).toEqual([
      "template_apply",
      "template_fill",
      "render_preview",
    ]);
    expect(
      report.steps.every((step) => step.ok && step.plannedToolSucceeded && !step.deviationFromPlan),
    ).toBe(true);
    expect(report.deviations).toEqual([]);
    expect(report.roundTripsUsed).toBe(3);
    expect(report.maxRoundTrips).toBe(8);
    expect(report.toolCallsExecuted).toBe(3);
    expect(report.lastDocumentRevision).toBe(12); // latest ok result wins
    expect(report.finalAssistantText).toBe("Done: applied, filled, previewed.");
    expect(report.usage.used.toolCalls).toBe(3);
    expect(report.usage.used.tokensIn).toBe(100); // only step 0 reported usage
    expect(report.usage.modelUsage["fake-model"]).toEqual({
      calls: 1,
      tokensIn: 100,
      tokensOut: 20,
      cacheHits: 1,
    });
    expect(report.usage.cacheHitRate).toBe(1);
    expect(budget.snapshot().used.toolCalls).toBe(3);

    // §13.2 events: started/finished per step, in order, phase "executing".
    expect(events.map((event) => `${event.type}:${event.payload.stepSeq}`).join(" ")).toBe(
      "step.started:0 step.finished:0 step.started:1 step.finished:1 step.started:2 step.finished:2",
    );
    for (const event of events) {
      expect(event.payload.phase).toBe("executing");
    }
    expect(events.filter(isStarted).map((event) => event.payload.tool)).toEqual([
      "template_apply",
      "template_fill",
      "render_preview",
    ]);

    // The seam got the same byte-stable system prompt per step (§5.3 cache).
    expect(state.calls).toBe(3);
    expect(state.systems[0]).toBe(state.systems[1]);
    expect(state.systems[0]).toContain("6. Stay inside your budget: 12 tool calls");
    expect(state.toolsSeen[0]?.map((tool) => tool.name)).toContain("text_set");
    // Budget view handed to the seam decreases per step (§5.1 round trips left).
    expect(state.budgets[0]?.roundTripsRemaining).toBe(8);
    expect(state.budgets[2]?.roundTripsRemaining).toBe(6);

    // Step directives are user messages naming the planned tool (§5.5).
    const firstSnapshot = state.snapshots[0] ?? [];
    const directive = firstSnapshot.find((message) => message.role === "user");
    expect(directive?.text).toContain('Plan step 1 of 3: call the "template_apply" tool now.');

    // Every executed call is fed back as an assistant(toolCalls)+tool result pair.
    const codes = lastSnapshotCodes(state);
    expect(codes).toEqual(["ok", "ok", "ok"]);
    const lastMessages = (state.snapshots.at(-1) ?? []).slice(-2);
    expect(lastMessages[0]?.role === "assistant" && lastMessages[1]?.role === "tool").toBe(true);
    if (lastMessages[0]?.role === "assistant" && lastMessages[1]?.role === "tool") {
      expect(lastMessages[0].toolCalls?.[0]?.callId).toBe(lastMessages[1].callId);
    }
  });

  it("labels step events with the repairing phase when the repair driver reuses the executor", async () => {
    const plan = makePlan([{ tool: "text_set", args: { size: 40 } }]);
    const { model } = scriptedModel([
      { calls: [{ name: "text_set", args: { size: 40 } }], done: true },
    ]);
    const { service, events } = makeService(model);
    const report = await service.execute(
      makeInput(plan, makeBudget(), "repairing"),
      new AbortController().signal,
    );
    expect(report.phase).toBe("repairing");
    expect(events.every((event) => event.payload.phase === "repairing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool (§5.7 registry gate)
// ---------------------------------------------------------------------------

describe("executor: unknown tools are skipped + logged (§5.7)", () => {
  it("skips an unregistered name, feeds back unknown_tool, and keeps the step running", async () => {
    const plan = makePlan([{ tool: "template_apply" }]);
    const { model, state } = scriptedModel([
      {
        calls: [{ name: "rm_rf_everything", args: { force: true } }, { name: "template_apply" }],
        done: true,
      },
    ]);
    const { service, events } = makeService(model);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    // The unknown call was NOT executed (no §5.2 tool-call charge), only logged.
    expect(report.toolCallsExecuted).toBe(1);
    expect(report.steps[0]?.succeededTools).toEqual(["template_apply"]);
    expect(report.steps[0]?.ok).toBe(true);
    expect(report.steps[0]?.deviationFromPlan).toBe(true);
    expect(report.deviations).toHaveLength(1);
    expect(report.deviations[0]).toMatchObject({
      stepSeq: 0,
      kind: "unknown_tool",
      plannedTool: "template_apply",
      actualTool: "rm_rf_everything",
    });

    // Feedback: the model sees an unknown_tool result with the allowed list.
    const codes = lastSnapshotCodes(state);
    expect(codes).toEqual(["unknown_tool", "ok"]);
    const messages = (state.snapshots.at(-1) ?? []).filter((message) => message.role === "tool");
    const feedback = messages.find((message) => !message.result.ok)?.result;
    if (feedback === undefined || feedback.ok) {
      throw new Error("expected an unknown_tool feedback result");
    }
    expect(feedback.code).toBe("unknown_tool");
    expect(feedback.hint).toContain("template_apply");
    expect(feedback.retryable).toBe(false);

    // The finished event surfaced the deviation (§5.5).
    const finished = events.find((event) => event.type === "step.finished");
    expect(finished?.type === "step.finished" && finished.payload.deviationFromPlan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deviations from plan (§5.5)
// ---------------------------------------------------------------------------

describe("executor: planned-vs-actual deviation detection (§5.5)", () => {
  it("logs a helper call before the planned tool as a plan mismatch, without failing the step", async () => {
    const plan = makePlan([{ tool: "text_set", args: { size: 40 } }]);
    const { model } = scriptedModel([
      {
        calls: [{ name: "workspace_snapshot" }, { name: "text_set", args: { size: 40 } }],
        done: true,
      },
    ]);
    const { service, events } = makeService(model);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.status).toBe("completed");
    expect(report.steps[0]?.succeededTools).toEqual(["workspace_snapshot", "text_set"]);
    expect(report.steps[0]?.plannedToolSucceeded).toBe(true);
    expect(report.steps[0]?.deviationFromPlan).toBe(true);
    expect(report.deviations).toEqual([
      {
        stepSeq: 0,
        kind: "plan_mismatch",
        plannedTool: "text_set",
        actualTool: "workspace_snapshot",
        detail:
          'Planned "text_set" but the model called "workspace_snapshot" (§5.5: deviations only to fix errors)',
      },
    ]);
    const finished = events.find((event) => event.type === "step.finished");
    expect(finished?.type === "step.finished" && finished.payload.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §23.1 rule 7: failed-call identity + §6.3 retry budget
// ---------------------------------------------------------------------------

describe("executor: no identical failed call twice (§23.1 rule 7)", () => {
  it("refuses the identical repeat but executes the fixed retry", async () => {
    const plan = makePlan([{ tool: "text_set" }]);
    const { model, state } = scriptedModel([
      { calls: [{ name: "text_set", args: { size: 350 } }] }, // engine-level failure
      { calls: [{ name: "text_set", args: { size: 350 } }] }, // identical → refused
      { calls: [{ name: "text_set", args: { size: 72 } }], done: true }, // fixed → ok
    ]);
    const { service } = makeService(model);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.status).toBe("completed");
    expect(report.steps[0]?.succeededTools).toEqual(["text_set"]);
    expect(report.steps[0]?.ok).toBe(true);
    // Only 2 executions: the refused repeat never reached the tool.
    expect(report.toolCallsExecuted).toBe(2);
    expect(report.deviations).toEqual([
      {
        stepSeq: 0,
        kind: "repeated_failed_call",
        plannedTool: "text_set",
        actualTool: "text_set",
        detail: 'Identical failed call "text_set" refused (§23.1 rule 7)',
      },
    ]);
    expect(toolResultCodes(state.snapshots.slice(-1))).toEqual([
      "text_overflow",
      "invalid_args",
      "ok",
    ]);
  });

  it("canonicalCallKey: sorted keys make failed-call identity order-insensitive", () => {
    expect(canonicalCallKey("text_set", { b: 2, a: 1 })).toBe(
      canonicalCallKey("text_set", { a: 1, b: 2 }),
    );
    expect(canonicalCallKey("text_set", { a: 1 })).not.toBe(canonicalCallKey("text_set", { a: 2 }));
    expect(canonicalCallKey("text_set", [1, 2])).not.toBe(canonicalCallKey("text_set", [2, 1]));
    expect(canonicalCallKey("a", {})).not.toBe(canonicalCallKey("b", {}));
  });

  it("failed-call identity persists across steps (§23.1 rule 7 is run-scoped)", async () => {
    const plan = makePlan([{ tool: "text_set" }, { tool: "text_set" }]);
    const { model } = scriptedModel([
      { calls: [{ name: "text_set", args: { size: 350 } }], done: true }, // step 0 fails, model moves on
      { calls: [{ name: "text_set", args: { size: 350 } }] }, // same args in step 1 → refused
      { calls: [{ name: "text_set", args: { size: 72 } }], done: true }, // fixed → ok
    ]);
    const { service } = makeService(model);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.steps[1]?.ok).toBe(true);
    expect(report.deviations.map((deviation) => deviation.kind)).toEqual(["repeated_failed_call"]);
    expect(report.toolCallsExecuted).toBe(2); // 350 once, 72 once
  });
});

describe("executor: retry budget is exactly one per tool error (§6.3, §23.1 rule 7)", () => {
  const cases: readonly {
    readonly name: string;
    readonly plan: readonly { tool: string; args?: Record<string, unknown> }[];
    readonly turns: readonly ScriptedTurn[];
    readonly executed: number;
    readonly ok: boolean;
    readonly plannedToolSucceeded: boolean;
    readonly deviationKinds: readonly string[];
    readonly resultCodes: readonly string[];
  }[] = [
    {
      name: "error → read it → fix args once → success",
      plan: [{ tool: "text_set" }],
      turns: [
        { calls: [{ name: "text_set", args: { size: 350 } }] },
        { calls: [{ name: "text_set", args: { size: 72 } }], done: true },
      ],
      executed: 2,
      ok: true,
      plannedToolSucceeded: true,
      deviationKinds: [],
      resultCodes: ["text_overflow", "ok"],
    },
    {
      name: "error → retry fails too → third attempt refused (retry budget exhausted)",
      plan: [{ tool: "text_set" }],
      turns: [
        { calls: [{ name: "text_set", args: { size: 350 } }] },
        { calls: [{ name: "text_set", args: { size: 390 } }] },
        { calls: [{ name: "text_set", args: { size: 80 } }], done: true },
      ],
      executed: 2, // initial + the single retry; the third is refused
      ok: false,
      plannedToolSucceeded: false,
      deviationKinds: ["retry_budget_exhausted"],
      resultCodes: ["text_overflow", "text_overflow", TOOL_RETRY_EXHAUSTED_FEEDBACK_CODE],
    },
    {
      name: "schema-invalid args count as the tool error (invalid_args feedback)",
      plan: [{ tool: "text_set" }],
      turns: [
        { calls: [{ name: "text_set", args: { size: 9999 } }] }, // fails the Zod boundary
        { calls: [{ name: "text_set", args: { size: 9999 } }] }, // identical → rule-7 refusal
        { calls: [{ name: "text_set", args: { size: 50 } }], done: true },
      ],
      executed: 1, // only the fixed call ever reaches the tool
      ok: true,
      plannedToolSucceeded: true,
      deviationKinds: ["repeated_failed_call"],
      resultCodes: ["invalid_args", "invalid_args", "ok"],
    },
    {
      name: "a repeat of a SUCCESSFUL call is not rule-7 (failed calls only)",
      plan: [{ tool: "text_set" }],
      turns: [
        { calls: [{ name: "text_set", args: { size: 50 } }] },
        { calls: [{ name: "text_set", args: { size: 50 } }], done: true },
      ],
      executed: 2,
      ok: true,
      plannedToolSucceeded: true,
      deviationKinds: [],
      resultCodes: ["ok", "ok"],
    },
  ];

  for (const testCase of cases) {
    it(`table: ${testCase.name}`, async () => {
      const plan = makePlan(testCase.plan);
      const { model, state } = scriptedModel(testCase.turns);
      const { service } = makeService(model);
      const report = await service.execute(
        makeInput(plan, makeBudget()),
        new AbortController().signal,
      );

      expect(report.status).toBe("completed"); // tool errors are feedback, never a stop
      expect(report.toolCallsExecuted).toBe(testCase.executed);
      expect(report.steps[0]?.ok).toBe(testCase.ok);
      expect(report.steps[0]?.plannedToolSucceeded).toBe(testCase.plannedToolSucceeded);
      expect(report.deviations.map((deviation) => deviation.kind)).toEqual(testCase.deviationKinds);
      expect(lastSnapshotCodes(state)).toEqual(testCase.resultCodes);
    });
  }

  it("the retry budget resets per step: the same tool gets a fresh attempt in the next step", async () => {
    const plan = makePlan([{ tool: "text_set" }, { tool: "text_set" }]);
    const { model } = scriptedModel([
      // Step 0: initial + retry both fail; the third attempt is refused.
      { calls: [{ name: "text_set", args: { size: 350 } }] },
      { calls: [{ name: "text_set", args: { size: 390 } }] },
      { calls: [{ name: "text_set", args: { size: 80 } }], done: true },
      // Step 1: same tool, fresh budget → succeeds.
      { calls: [{ name: "text_set", args: { size: 60 } }], done: true },
    ]);
    const { service } = makeService(model);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.toolCallsExecuted).toBe(3); // 2 in step 0 + 1 in step 1
    expect(report.steps[0]?.ok).toBe(false);
    expect(report.steps[1]?.ok).toBe(true);
    expect(report.steps[1]?.plannedToolSucceeded).toBe(true);
    expect(report.deviations.map((deviation) => deviation.kind)).toEqual([
      "retry_budget_exhausted",
    ]);
  });

  it("exposes the retry-exhausted swap-point code for the catalog owner to flip", () => {
    expect(TOOL_RETRY_EXHAUSTED_FEEDBACK_CODE).toBe("engine_timeout");
  });
});

// ---------------------------------------------------------------------------
// §5.2 budget clean stops
// ---------------------------------------------------------------------------

describe("executor: §5.2 budget stops are clean stops (feature, not error)", () => {
  it("stops between steps when the tool-call cap is spent and reports what was cut", async () => {
    const plan = makePlan([
      { tool: "template_apply" },
      { tool: "template_fill" },
      { tool: "render_preview" },
    ]);
    const { model, state } = scriptedModel([
      { calls: [{ name: "template_apply" }], done: true },
      { calls: [{ name: "template_fill" }], done: true },
      { calls: [{ name: "render_preview" }], done: true },
    ]);
    const { service, events } = makeService(model);
    const budget = makeBudget({ toolCallCap: 2 });

    const report = await service.execute(makeInput(plan, budget), new AbortController().signal);

    expect(report.status).toBe("budget_stopped");
    expect(report.steps).toHaveLength(2);
    expect(report.steps.every((step) => step.ok)).toBe(true);
    expect(report.toolCallsExecuted).toBe(2);
    expect(report.usage.exceeded?.kind).toBe("tool_calls");
    // Step 3 never started: no step.started for it.
    expect(events.filter(isStarted)).toHaveLength(2);
    expect(state.calls).toBe(2); // the seam was never called for step 3
    // §5.2 "tell the user what was cut".
    expect(report.cut).toMatchObject({
      reason: "budget_exceeded",
      completedSteps: 2,
      totalSteps: 3,
      inFlightStep: null,
      cutStepTools: ["render_preview"],
      message: expect.stringContaining("tool calls budget reached (2 of 2 tool calls)"),
    });
    expect(report.cut?.message).toContain("Remaining plan steps cut: render_preview.");
    expect(report.cut?.budgetExceeded?.kind).toBe("tool_calls");
  });

  it("stops mid-step on the between-calls budget check and reports the in-flight step", async () => {
    const plan = makePlan([{ tool: "template_apply" }]);
    const { model } = scriptedModel([
      {
        calls: [{ name: "template_apply" }, { name: "template_apply" }, { name: "template_apply" }],
        done: true,
      },
    ]);
    const { service, events } = makeService(model);
    const budget = makeBudget({ toolCallCap: 2 });

    const report = await service.execute(makeInput(plan, budget), new AbortController().signal);

    expect(report.status).toBe("budget_stopped");
    expect(report.toolCallsExecuted).toBe(2); // the third call was refused by the budget gate
    expect(report.steps).toHaveLength(1); // the interrupted step still got its record + events
    expect(report.steps[0]?.ok).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["step.started", "step.finished"]);
    expect(report.cut).toMatchObject({
      reason: "budget_exceeded",
      completedSteps: 0,
      inFlightStep: 0,
      cutStepTools: [],
    });
    expect(report.cut?.message).toContain('Step 1 ("template_apply") was interrupted mid-step');
    // Finalization input for the worker: committed work is the revision so far.
    expect(report.lastDocumentRevision).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// §5.1 round-trip cap
// ---------------------------------------------------------------------------

describe("executor: max 8 model↔tool round trips per phase (§5.1)", () => {
  it("stops before the 9th turn across steps and reports the cut steps", async () => {
    const plan = makePlan(
      Array.from({ length: 10 }, (_unused, index) => ({ tool: `tool_${index}` })),
    );
    const turns: ScriptedTurn[] = Array.from({ length: 10 }, (_unused, index) => ({
      calls: [{ name: `tool_${index}` }],
      done: true,
    }));
    const tools = Object.fromEntries(
      Array.from({ length: 10 }, (_unused, index) => [`tool_${index}`, okTool(`tool_${index}`)]),
    );
    const { model, state } = scriptedModel(turns);
    const { service } = makeService(model, { tools });

    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.status).toBe("round_trip_stopped");
    expect(report.roundTripsUsed).toBe(8);
    expect(report.steps).toHaveLength(8);
    expect(report.steps.every((step) => step.ok)).toBe(true);
    expect(state.turnsConsumed).toBe(8); // the 9th turn never reached the seam's stream
    expect(report.cut).toMatchObject({
      reason: "round_trip_cap",
      completedSteps: 8,
      totalSteps: 10,
      inFlightStep: null,
      cutStepTools: ["tool_8", "tool_9"],
      budgetExceeded: null,
      message: expect.stringContaining("round-trip cap for the phase reached (8 of 8, §5.1)"),
    });
  });

  it("stops inside a step when a step burns the whole cap (config per tier via limits)", async () => {
    const plan = makePlan([{ tool: "template_apply" }, { tool: "template_fill" }]);
    const { model } = scriptedModel([
      { calls: [{ name: "template_apply" }] }, // turn 1
      { calls: [{ name: "template_apply" }] }, // turn 2
      { calls: [{ name: "template_apply" }] }, // turn 3 → refused BEFORE any call runs
    ]);
    const { service, events } = makeService(model, { limits: { maxRoundTrips: 2 } });

    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.status).toBe("round_trip_stopped");
    expect(report.roundTripsUsed).toBe(2);
    expect(report.toolCallsExecuted).toBe(2);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]?.ok).toBe(true);
    expect(report.cut).toMatchObject({
      inFlightStep: 0,
      completedSteps: 0,
      cutStepTools: ["template_fill"],
    });
    expect(events.map((event) => event.type)).toEqual(["step.started", "step.finished"]);
  });

  it("counts the implicit first turn when the seam omits turn_started (robust accounting)", async () => {
    const plan = makePlan([{ tool: "template_apply" }]);
    const { model } = scriptedModel(
      [
        { calls: [{ name: "template_apply" }, { name: "template_apply" }], done: true }, // ONE model turn
      ],
      { omitTurnStarted: true },
    );
    const { service } = makeService(model);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );
    expect(report.roundTripsUsed).toBe(1);
    expect(report.toolCallsExecuted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §3.4 abort + per-call deadline
// ---------------------------------------------------------------------------

describe("executor: abort handling (§3.4 cancel)", () => {
  it("a pre-aborted signal stops before any step starts and reports everything as cut", async () => {
    const plan = makePlan([{ tool: "template_apply" }, { tool: "template_fill" }]);
    const { model, state } = scriptedModel([{ calls: [{ name: "template_apply" }], done: true }]);
    const { service, events } = makeService(model);
    const controller = new AbortController();
    controller.abort();

    const report = await service.execute(makeInput(plan, makeBudget()), controller.signal);

    expect(report.status).toBe("aborted");
    expect(report.steps).toEqual([]);
    expect(report.roundTripsUsed).toBe(0);
    expect(report.toolCallsExecuted).toBe(0);
    expect(events).toEqual([]);
    expect(state.calls).toBe(0);
    expect(report.cut).toMatchObject({
      reason: "aborted",
      completedSteps: 0,
      inFlightStep: null,
      cutStepTools: ["template_apply", "template_fill"],
    });
    expect(report.cut?.message).toContain("Run cancelled");
  });

  it("aborts mid-step when a tool cancels the run signal; the finished step keeps committed work", async () => {
    const plan = makePlan([{ tool: "template_apply" }, { tool: "template_fill" }]);
    const controller = new AbortController();
    const tools = defaultFakeTools({
      template_apply: okTool("template_apply", {
        revision: 7,
        run: () => {
          controller.abort(); // §3.4: user/system cancel lands mid-call
          return toolOk({ summary: "template_apply done", documentRevision: 7 });
        },
      }),
    });
    const { model } = scriptedModel([
      { calls: [{ name: "template_apply" }], done: true },
      { calls: [{ name: "template_fill" }], done: true },
    ]);
    const { service, events } = makeService(model, { tools });

    const report = await service.execute(makeInput(plan, makeBudget()), controller.signal);

    expect(report.status).toBe("aborted");
    expect(report.steps).toHaveLength(1); // the interrupted step got its record
    expect(report.steps[0]?.ok).toBe(true);
    expect(report.toolCallsExecuted).toBe(1);
    expect(report.lastDocumentRevision).toBe(7);
    expect(events.map((event) => event.type)).toEqual(["step.started", "step.finished"]);
    expect(report.cut).toMatchObject({
      reason: "aborted",
      completedSteps: 0,
      inFlightStep: 0,
      cutStepTools: ["template_fill"],
    });
  });
});

describe("executor: §3.4 per-call deadline becomes a retryable tool error", () => {
  it("a slow tool times out, is fed back as engine_timeout (retryable), and the run continues", async () => {
    const plan = makePlan([{ tool: "template_apply" }]);
    const tools = defaultFakeTools({
      template_apply: okTool("template_apply", {
        revision: 7,
        run: async (_args, signal) => {
          await signalSleep(50, signal); // slower than the 5 ms per-call deadline
          return toolOk({ summary: "template_apply done", documentRevision: 7 });
        },
      }),
    });
    const { model, state } = scriptedModel([
      { calls: [{ name: "template_apply" }], done: "Timed out once; nothing else to do." },
    ]);
    const { service } = makeService(model, { tools, limits: { toolCallTimeoutMs: 5 } });

    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.status).toBe("completed"); // §23.1 rule 7: a tool error is feedback, not a stop
    expect(report.toolCallsExecuted).toBe(1);
    expect(report.steps[0]?.ok).toBe(false); // the call itself never succeeded
    const codes = lastSnapshotCodes(state);
    expect(codes).toEqual(["engine_timeout"]);
    const messages = (state.snapshots.at(-1) ?? []).filter((message) => message.role === "tool");
    const feedback = messages.find((message) => !message.result.ok)?.result;
    if (feedback === undefined || feedback.ok) {
      throw new Error("expected an engine_timeout feedback result");
    }
    expect(feedback.code).toBe("engine_timeout");
    expect(feedback.retryable).toBe(true);
  });

  it("a tool that resolves within the deadline is not aborted", async () => {
    const plan = makePlan([{ tool: "template_apply" }]);
    const tools = defaultFakeTools({
      template_apply: okTool("template_apply", {
        revision: 7,
        run: async (_args, signal) => {
          await signalSleep(1, signal);
          return toolOk({ summary: "template_apply done", documentRevision: 7 });
        },
      }),
    });
    const { model } = scriptedModel([{ calls: [{ name: "template_apply" }], done: true }]);
    const { service } = makeService(model, { tools, limits: { toolCallTimeoutMs: 5000 } });
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );
    expect(report.status).toBe("completed");
    expect(report.steps[0]?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status mapping sanity
// ---------------------------------------------------------------------------

describe("executor: statuses", () => {
  it("exposes the four §5.2-clean statuses", () => {
    const statuses: readonly ExecutorStatus[] = [
      "completed",
      "budget_stopped",
      "round_trip_stopped",
      "aborted",
    ];
    expect(statuses).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// §5.7 ToolCallGate wiring (W6-K seam, wired by W7-M)
// ---------------------------------------------------------------------------

describe("executor: §5.7 ToolCallGate wiring (W7-M)", () => {
  /** The run-start manifest the gate freezes: a SUBSET of the registry, so a
   * registry-known-but-unoffered tool proves the gate runs BEFORE dispatch. */
  const gateManifest: ToolListing[] = [
    { name: "workspace_snapshot", description: "Read the document." },
    { name: "text_set", description: "Set editable text." },
  ];

  function makeGatedService(
    turns: readonly ScriptedTurn[],
    options: { mutatingCommandCap?: number } = {},
  ): { service: ExecutorService; state: ScriptedModelState } {
    const { model, state } = scriptedModel(turns);
    const tools = defaultFakeTools();
    const service = new ExecutorService({
      model,
      tools,
      manifest: gateManifest,
      toolContext: fakeContext(),
      emit: () => {},
      clock: () => 0,
      gate: new ToolCallGate({
        tools,
        manifest: gateManifest,
        mutatingCommandCap: options.mutatingCommandCap ?? 12,
      }),
    });
    return { service, state };
  }

  it("rejects a registry-known tool outside the run-start manifest (skip + deviation, no execution)", async () => {
    // template_apply IS in the registry (and would execute without a gate), but
    // the gate's manifest was fixed at run start without it → §5.7 rejection.
    const plan = makePlan([{ tool: "text_set", args: { size: 40 } }]);
    const { service, state } = makeGatedService([
      {
        calls: [{ name: "template_apply" }, { name: "text_set", args: { size: 40 } }],
        done: true,
      },
    ]);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.status).toBe("completed");
    expect(report.toolCallsExecuted).toBe(1); // only text_set ran; template_apply skipped
    expect(report.steps[0]?.succeededTools).toEqual(["text_set"]);
    expect(report.deviations).toEqual([
      {
        stepSeq: 0,
        kind: "unknown_tool",
        plannedTool: "text_set",
        actualTool: "template_apply",
        detail: expect.stringContaining('ToolCallGate rejected "template_apply"'),
      },
    ]);
    // The model gets the gate's envelope with the OFFERED tools in the hint.
    const codes = lastSnapshotCodes(state);
    expect(codes).toEqual(["unknown_tool", "ok"]);
    const messages = (state.snapshots.at(-1) ?? []).filter((message) => message.role === "tool");
    const feedback = messages.find((message) => !message.result.ok)?.result;
    if (feedback === undefined || feedback.ok) {
      throw new Error("expected the gate's unknown_tool feedback result");
    }
    expect(feedback.hint).toContain("workspace_snapshot");
    expect(feedback.hint).not.toContain("template_apply");
  });

  it("refuses mutating calls past the gate's §5.2 cap (mutating_budget deviation, tool never runs)", async () => {
    const plan = makePlan([{ tool: "text_set" }]);
    const { service, state } = makeGatedService(
      [
        { calls: [{ name: "text_set", args: { size: 72 } }] }, // executes, reserves 1/1
        { calls: [{ name: "text_set", args: { size: 80 } }], done: true }, // cap exhausted
      ],
      { mutatingCommandCap: 1 },
    );
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.toolCallsExecuted).toBe(1);
    expect(report.steps[0]?.succeededTools).toEqual(["text_set"]);
    expect(report.deviations).toEqual([
      {
        stepSeq: 0,
        kind: "mutating_budget",
        plannedTool: "text_set",
        actualTool: "text_set",
        detail: expect.stringContaining("mutating command budget is exhausted"),
      },
    ]);
    expect(lastSnapshotCodes(state)).toEqual(["ok", "budget_exceeded"]);
  });

  it("args-cap rejections take the §6.3 retry path: invalid_args feedback, no deviation, a fixed retry executes", async () => {
    const plan = makePlan([{ tool: "text_set" }]);
    // A 2501-char string trips the gate's §5.7 string cap before the schema parse.
    const oversized = { size: 72, note: "x".repeat(2501) };
    const { service, state } = makeGatedService([
      { calls: [{ name: "text_set", args: oversized }] }, // args_cap → invalid_args
      { calls: [{ name: "text_set", args: { size: 72 } }], done: true }, // fixed → ok
    ]);
    const report = await service.execute(
      makeInput(plan, makeBudget()),
      new AbortController().signal,
    );

    expect(report.status).toBe("completed");
    expect(report.toolCallsExecuted).toBe(1); // the capped call never ran
    expect(report.deviations).toEqual([]); // §6.3 feedback path, not a §5.5 deviation
    expect(lastSnapshotCodes(state)).toEqual(["invalid_args", "ok"]);
    const messages = (state.snapshots.at(-1) ?? []).filter((message) => message.role === "tool");
    const feedback = messages.find((message) => !message.result.ok)?.result;
    if (feedback === undefined || feedback.ok) {
      throw new Error("expected the gate's args_cap feedback result");
    }
    expect(feedback.code).toBe("invalid_args");
    expect(feedback.message).toContain("§5.7 caps");
  });
});
