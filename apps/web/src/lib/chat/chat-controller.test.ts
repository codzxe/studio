/**
 * Controller suite v2 — the ROUND-12 CLIENT-DRIVEN LOOP against a scripted
 * fake of the `@studio/api-client` turn seam (deterministic, no network).
 *
 * The fake mirrors the DOCUMENTED `streamTurn` contract (sse.ts), not its
 * bytes: per-turn server seqs start at 0 and are rewritten into the run's
 * monotonic LOCAL seqs via `handlers.seqBase` (what the transport's
 * normalizer does); a parked attempt's `lastServerSeq` becomes the resumed
 * call's `replayCursor` (frames ≤ cursor drop, like the real normalizer);
 * `abort()` settles `done` with `reason: "aborted"`. Turn §7.4 sequences are
 * hand-built here — the wire parse itself is pinned in the api-client's own
 * turn.test.ts.
 */

import { ApiError } from "@studio/api-client";
import type { ApiClient, TurnStreamHandle, TurnStreamSummary } from "@studio/api-client";
import type {
  ContextSelection,
  EditPlan,
  StudioStreamEvent,
  TurnCanvas,
  TurnToolCall,
} from "@studio/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ApplicablePlan, ApplyController, ApplyOutcome, UndoOutcome } from "./apply";
import {
  CHAT_MAX_CLIENT_STEPS,
  CHAT_RUN_TIMEOUT_MS,
  type ChatController,
  createChatController,
} from "./chat-controller";
import type {
  ChatControllerClient,
  ChatSendInput,
  ChatToolExecutorFactory,
  TurnToolExecutor,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THREAD = "th_test_000000000000000000000001";
const BASE_FLAGS: ContextSelection = {
  projectSummary: true,
  activeComp: true,
  selection: false,
  playhead: true,
  focusedPanel: true,
  selectedProperties: false,
  currentFrame: false,
  recentCommands: false,
  comments: false,
};

function input(message: string, extra?: Partial<ChatSendInput>): ChatSendInput {
  return {
    message,
    context: BASE_FLAGS,
    pinned: [],
    ...extra,
  };
}

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

/** Waits (bounded) for a predicate over the controller's live snapshot. */
async function until(
  controller: ChatController,
  predicate: (snapshot: ReturnType<ChatController["getSnapshot"]>) => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate(controller.getSnapshot())) return;
    await tick();
  }
  throw new Error(`timeout waiting for ${label}`);
}

// -- §7.4 turn event builders (server shapes; the fake assigns seqs) --------

function runStarted(runId: string, step: number): StudioStreamEvent {
  return { type: "run.started", runId, seq: step, model: "gpt-5.2" };
}
function turnStarted(runId: string, seq: number, stepIndex: number): StudioStreamEvent {
  return { type: "turn.started", runId, seq, stepIndex };
}
function delta(runId: string, seq: number, text: string): StudioStreamEvent {
  return { type: "message.delta", runId, seq, delta: text };
}
function toolStarted(
  runId: string,
  seq: number,
  toolCallId: string,
  tool: string,
  args: unknown,
): StudioStreamEvent {
  return { type: "tool.started", runId, seq, toolCallId, name: tool, args };
}
function turnCompleted(
  runId: string,
  seq: number,
  stepIndex: number,
  outcome: {
    assistantText?: string;
    toolCalls?: TurnToolCall[];
    finishReason?: "stop" | "tool-calls" | "step-limit";
  },
): StudioStreamEvent {
  return {
    type: "turn.completed",
    runId,
    seq,
    stepIndex,
    finishReason: outcome.finishReason ?? (outcome.toolCalls?.length ? "tool-calls" : "stop"),
    usage: { inputTokens: 100, outputTokens: 24 },
    credits: { committed: 1 },
    ...(outcome.assistantText !== undefined ? { assistantText: outcome.assistantText } : {}),
    toolCalls: outcome.toolCalls ?? [],
  };
}
function turnFailed(
  runId: string,
  seq: number,
  stepIndex: number,
  failure: { code: string; message: string; retryable: boolean },
): StudioStreamEvent {
  return { type: "turn.failed", runId, seq, stepIndex, ...failure, credits: { committed: 0 } };
}

/** A write-tool proposal carrier (what the gateway emits for write tools). */
function writeProposal(
  tool: string,
  args: Record<string, unknown>,
  toolCallId: string,
): TurnToolCall {
  return {
    toolCallId,
    tool,
    args,
    resultForModel: { proposedBatch: { label: `Agent: ${tool}`, steps: [] }, note: "proposed" },
    proposal: {
      compiled: {
        batch: {
          label: `Agent: ${tool}`,
          atomic: true,
          steps: [{ command: tool.replace(/^studio\./, ""), params: args }],
        },
        risk: "low",
        estimatedCredits: 1.5,
        resolutionRequests: [],
      },
    },
  };
}

/** A read/generative call: no proposal — the client executes it locally. */
function readCall(tool: string, args: Record<string, unknown>, toolCallId: string): TurnToolCall {
  return { toolCallId, tool, args, resultForModel: null, proposal: null };
}

// ---------------------------------------------------------------------------
// Fake turn transport (mirrors the streamTurn surface the controller sees)
// ---------------------------------------------------------------------------

type Frames = (serverSeqStart: number) => StudioStreamEvent[];

interface StepScript {
  /** Frames in wire order; server seqs assigned 0.. */
  readonly frames: Frames;
  /** Park after N frames: onError TURN_PAUSED, done {reason:"paused"}. */
  readonly pauseAfter?: number;
  /** Hang after N frames until abort() (mid-turn stop tests). */
  readonly hangAfter?: number;
}

interface FakeScript {
  /** Per-stepIndex scripts; a missing step repeats the LAST known one. */
  readonly steps: Readonly<Record<number, StepScript>>;
  /** Per-step OVERRIDE by (stepIndex, nth POST of that step): 1-based. */
  readonly variants?: Readonly<Record<string, StepScript>>;
}

interface RecordedPost {
  readonly threadId: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly key: string;
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  readonly canvas: TurnCanvas | null | undefined;
  readonly model: unknown;
  readonly seqBase: number;
  readonly replayCursor: number | undefined;
}

const TERMINAL_TURN = new Set(["turn.completed", "turn.failed"]);

class FakeTurnHandle implements TurnStreamHandle {
  readonly runId: string;
  readonly done: Promise<TurnStreamSummary>;
  #lastServerSeq = -1;
  #paused = false;
  #settle: (summary: TurnStreamSummary) => void = () => undefined;
  #unblock: (() => void) | null = null;

  constructor(
    script: StepScript,
    private readonly handlers: {
      onEvent?: (event: StudioStreamEvent) => void;
      onError?: (error: { code: string; message: string; retryable: boolean }) => void;
    },
    runId: string,
    seqBase: number,
    replayCursor: number | undefined,
    stepIndex: number,
  ) {
    this.runId = runId;
    this.done = new Promise<TurnStreamSummary>((resolve) => {
      this.#settle = resolve;
    });
    void this.#emit(script, seqBase, replayCursor ?? -1, stepIndex);
  }

  get lastServerSeq(): number {
    return this.#lastServerSeq;
  }

  get paused(): boolean {
    return this.#paused;
  }

  abort(): void {
    // A parked hang resolves like the real transport's abort path.
    this.#unblock?.();
    this.#settle({ reason: "aborted", runId: this.runId, failure: null });
  }

  async #emit(
    script: StepScript,
    seqBase: number,
    cursor: number,
    stepIndex: number,
  ): Promise<void> {
    await tick();
    const events = script.frames(stepIndex);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index] ?? ({} as StudioStreamEvent);
      const serverSeq = index;
      const emitted = serverSeq > cursor;
      if (emitted) {
        this.#lastServerSeq = serverSeq;
        // The gateway echoes the BODY's runId (the normalizer drops foreign
        // runs) — the fake enforces the same guarantee over scripted frames.
        this.handlers.onEvent?.({ ...event, runId: this.runId, seq: seqBase + serverSeq });
      }
      if (script.pauseAfter !== undefined && index + 1 === script.pauseAfter) {
        this.#paused = true;
        this.handlers.onError?.(
          new ApiError({
            code: "TURN_PAUSED",
            message: "Run paused. Check your connection.",
            retryable: true,
            status: 0,
          }),
        );
        this.#settle({
          reason: "paused",
          runId: this.runId,
          failure: new ApiError({
            code: "TURN_PAUSED",
            message: "Run paused. Check your connection.",
            retryable: true,
            status: 0,
          }),
        });
        return;
      }
      if (script.hangAfter !== undefined && index + 1 === script.hangAfter) {
        await new Promise<void>((resolve) => {
          this.#unblock = resolve;
        });
        return; // abort() settles the done promise
      }
      if (TERMINAL_TURN.has(event.type)) {
        if (event.type === "turn.failed") {
          const failure = event as { code: string; message: string; retryable: boolean };
          this.handlers.onError?.(
            new ApiError({
              code: failure.code,
              message: failure.message,
              retryable: failure.retryable,
              status: 0,
            }),
          );
          this.#settle({ reason: "error", runId: this.runId, failure: null });
          return;
        }
        this.#settle({ reason: "terminal", runId: this.runId, failure: null });
        return;
      }
      await tick();
    }
    // A stream that ended without a terminal — the transport parks.
    this.#paused = true;
    this.#settle({ reason: "paused", runId: this.runId, failure: null });
  }
}

interface FakeDeps {
  readonly script: FakeScript;
  readonly planResponse?: (runId: string, plan: EditPlan) => Record<string, unknown>;
  readonly planFails?: boolean;
  /** ROUND 13: submitPlan throws this typed code (e.g. RUN_NOT_ACTIVE). */
  readonly planErrorCode?: string;
  /** Blocks the plan POST until resolved (stop-vs-queue race tests, w3-b06). */
  readonly planGate?: Promise<void>;
}

/** Builds the ChatControllerClient fake: turn transport + plan + abandon. */
function makeClient({ script, planResponse, planFails, planGate, planErrorCode }: FakeDeps) {
  const posts: RecordedPost[] = [];
  const planPosts: Array<{ runId: string; plan: EditPlan }> = [];
  const abandons: string[] = [];
  /** nth POST per `${runId}:${stepIndex}` — for variant scripts. */
  const postCounts = new Map<string, number>();

  const client: ChatControllerClient = {
    chat: {
      turn: (threadId: string, body: unknown, handlers) => {
        const parsed = body as {
          runId: string;
          stepIndex: number;
          messages: Array<Record<string, unknown>>;
          canvas?: TurnCanvas | null;
          model?: unknown;
        };
        const key = `${parsed.runId}:${parsed.stepIndex}`;
        const nth = (postCounts.get(key) ?? 0) + 1;
        postCounts.set(key, nth);
        posts.push({
          threadId,
          runId: parsed.runId,
          stepIndex: parsed.stepIndex,
          key,
          // The REAL transport JSON-serializes the body at POST time —
          // snapshot the transcript instead of aliasing the live array.
          messages: JSON.parse(JSON.stringify(parsed.messages)) as Array<Record<string, unknown>>,
          canvas: parsed.canvas,
          model: parsed.model,
          seqBase: (handlers as { seqBase?: number } | undefined)?.seqBase ?? 0,
          replayCursor: (handlers as { replayCursor?: number } | undefined)?.replayCursor,
        });
        const knownSteps = Object.entries(script.steps)
          .map(([key, value]) => [Number(key), value] as const)
          .filter(([step]) => step <= parsed.stepIndex)
          .sort((a, b) => b[0] - a[0]);
        const stepScript =
          script.variants?.[`${parsed.stepIndex}:${nth}`] ??
          script.steps[parsed.stepIndex] ??
          knownSteps.at(0)?.[1];
        if (stepScript === undefined) {
          throw new Error(`no turn script for step ${parsed.stepIndex}`);
        }
        return new FakeTurnHandle(
          stepScript,
          (handlers ?? {}) as {
            onEvent?: (event: StudioStreamEvent) => void;
            onError?: (error: { code: string; message: string; retryable: boolean }) => void;
          },
          parsed.runId,
          posts.at(-1)?.seqBase ?? 0,
          posts.at(-1)?.replayCursor,
          parsed.stepIndex,
        );
      },
    },
    runs: {
      submitPlan: async (runId: string, body: { plan: EditPlan }) => {
        planPosts.push({ runId, plan: body.plan }); // recorded even when it throws
        if (planGate !== undefined) await planGate;
        if (planFails === true) {
          throw new ApiError({
            code: "RUN_GONE",
            message: "The run is gone.",
            retryable: false,
            status: 404,
          });
        }
        if (planErrorCode !== undefined) {
          // ROUND 13 graceful recovery: the gateway's typed answer when the
          // run was already ended server-side (stop/abandon raced the POST).
          throw new ApiError({
            code: planErrorCode,
            message: "This run already finished.",
            retryable: false,
            status: 409,
          });
        }
        return (planResponse?.(runId, body.plan) ?? {
          runId,
          plan: body.plan,
          autoApply: { mode: "propose", reason: "manual review" },
        }) as never;
      },
      abandon: async (runId: string) => {
        abandons.push(runId);
        return null;
      },
    },
  };
  return { client, posts, planPosts, abandons };
}

/** An ApplyController mock whose every gesture succeeds (plan-card folds). */
function makeApplyEngine(): ApplyController & { calls: { apply: ApplicablePlan[] } } {
  const calls = { apply: [] as ApplicablePlan[] };
  return {
    calls,
    apply: async (plan) => {
      calls.apply.push(plan);
      return { ok: true, versionId: "ver_applied_1", creditsCommitted: 1 } as ApplyOutcome;
    },
    undo: async () => ({ ok: true, undone: true }) as UndoOutcome,
    reapply: async (plan) => ({ ok: true, versionId: "ver_reapplied" }) as ApplyOutcome,
    retrySave: async () => ({ ok: true, versionId: "ver_saved" }) as ApplyOutcome,
  };
}

/** The executor double: handles the read catalog, records executes. */
function makeExecutor(result: unknown = { layers: [] }): TurnToolExecutor & {
  calls: Array<{ tool: string; args: unknown }>;
} {
  const calls: Array<{ tool: string; args: unknown }> = [];
  return {
    calls,
    handles: (tool) => tool === "studio.list_layers" || tool === "studio.get_context",
    execute: async (tool, args) => {
      calls.push({ tool, args });
      return result;
    },
  };
}

function executorFactory(
  build: (run: { runId: string; context: ContextSelection }) => TurnToolExecutor,
): ChatToolExecutorFactory {
  return build;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe("createChatController v2 — the client-driven loop", () => {
  it("runs a full 2-turn loop: write accumulates, read executes, plan POSTs, auto-apply fires", async () => {
    const write = writeProposal("studio.create_text", { name: "Title", text: "Hi" }, "call_w1");
    const read = readCall("studio.list_layers", {}, "call_r1");
    const executor = makeExecutor({ layers: [{ id: 1, name: "BG" }] });
    const applyEngine = makeApplyEngine();

    const { client, posts, planPosts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_fixed", 0),
              turnStarted("run_fixed", 1, 0),
              delta("run_fixed", 2, "Let me "),
              toolStarted("run_fixed", 3, "call_w1", "studio.create_text", write.args),
              toolStarted("run_fixed", 4, "call_r1", "studio.list_layers", {}),
              turnCompleted("run_fixed", 5, 0, {
                assistantText: "Let me look.",
                toolCalls: [write, read],
              }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_fixed", 0),
              turnStarted("run_fixed", 1, 1),
              delta("run_fixed", 2, "Done."),
              turnCompleted("run_fixed", 3, 1, { assistantText: "Done.", toolCalls: [] }),
            ],
          },
        },
      },
      planResponse: (runId, plan) => ({
        runId,
        plan,
        autoApply: { mode: "auto", reason: "low risk additive batch" },
        compiledBatch: {
          label: 'Agent: Add text layer "Title"',
          steps: [{ command: "create_text", params: { name: "Title", text: "Hi" } }],
        },
        risk: "low",
        estimatedCredits: 1.5,
        resolutionRequests: [],
        baseVersionId: "ver_base_1",
      }),
    });

    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      apply: applyEngine,
      toolExecutor: executorFactory(() => executor),
    });

    controller.send(input("Make a title."));
    await until(controller, (s) => s.phase === "done", "run done");

    // Two turns POSTed: step 0 then step 1, same run.
    expect(posts).toHaveLength(2);
    expect(posts[0]?.stepIndex).toBe(0);
    expect(posts[1]?.stepIndex).toBe(1);
    expect(new Set(posts.map((post) => post.runId)).size).toBe(1);

    // Step 0 body: the user part only.
    const step0 = posts[0]?.messages ?? [];
    expect(step0).toEqual([{ role: "user", text: "Make a title." }]);

    // Step 1 body: user + assistant + tool_call/tool_result pairs. The WRITE
    // call echoes resultForModel (never executed); the READ call echoes the
    // executor's real result.
    const step1 = posts[1]?.messages ?? [];
    expect(step1.map((part) => part.role)).toEqual([
      "user",
      "assistant",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ]);
    expect(step1[1]).toEqual({ role: "assistant", text: "Let me look." });
    const writeResult = step1[3] as unknown as { result: unknown };
    expect(writeResult.result).toEqual(write.resultForModel);
    const readResult = step1[5] as unknown as { result: unknown };
    expect(readResult.result).toEqual({ layers: [{ id: 1, name: "BG" }] });

    // The executor ran the READ tool ONLY.
    expect(executor.calls).toEqual([{ tool: "studio.list_layers", args: {} }]);

    // The merged plan POSTed to /v1/runs/:id/plan: ONE step, the write tool.
    expect(planPosts).toHaveLength(1);
    const posted = planPosts[0];
    expect(posted?.runId).toBe(posts[0]?.runId);
    expect(posted?.plan.steps).toHaveLength(1);
    expect(posted?.plan.steps[0]?.tool).toBe("studio.create_text");
    expect(posted?.plan.intent).toBe("create");

    // The plan card folded with the server's verdict + compiled batch, and
    // the auto-apply drive fired at the local run.completed (once per run).
    const last = controller.getSnapshot().messages.at(-1);
    expect(last?.plan?.steps[0]?.tool).toBe("studio.create_text");
    expect(last?.planRuntime?.autoApply).toEqual({
      mode: "auto",
      reason: "low risk additive batch",
    });
    expect(last?.planRuntime?.outcome).toBe("applied");
    expect(applyEngine.calls.apply).toHaveLength(1);
    expect(applyEngine.calls.apply[0]?.runId).toBe(posts[0]?.runId);

    // The assistant bubble holds the final text; the phase is terminal.
    expect(last?.text).toBe("Done.");
    expect(controller.getSnapshot().phase).toBe("done");
    controller.dispose();
  });

  it("steer (§3.4): a mid-run send renders immediately and rides the next turn", async () => {
    // Holder object: TS's control-flow analysis keeps a bare `let x = null`
    // narrowed to `null` at the call site (closure assignments are invisible
    // to CFA) — a property read never narrows, so the deferred resolves.
    const release = { gate: (): void => {} };
    const gate = new Promise<void>((resolve) => {
      release.gate = resolve;
    });
    const read = readCall("studio.get_context", {}, "call_c1");
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_steer", 0),
              turnStarted("run_steer", 1, 0),
              turnCompleted("run_steer", 2, 0, { assistantText: "Looking…", toolCalls: [read] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_steer", 0),
              turnStarted("run_steer", 1, 1),
              turnCompleted("run_steer", 2, 1, { assistantText: "Done.", toolCalls: [] }),
            ],
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => ({
        handles: (tool) => tool === "studio.get_context",
        execute: async () => {
          await gate; // park INSIDE the executor — the steer lands mid-run
          return { context: "…" };
        },
      })),
    });

    controller.send(input("Summarize the project."));
    // Wait until turn 0 completed and the loop parked inside the executor.
    await until(
      controller,
      (s) => s.messages.some((m) => (m.toolCalls?.length ?? 0) > 0),
      "turn 0 completed",
    );

    controller.send(input("Also check the audio levels."));
    // The user message rendered immediately (the composer never eats input).
    expect(
      controller
        .getSnapshot()
        .messages.some((message) => message.role === "user" && message.text.includes("audio")),
    ).toBe(true);

    release.gate();
    await until(controller, (s) => s.phase === "done", "run done");

    const step1 = posts[1]?.messages ?? [];
    expect(
      step1.some((part) => part.role === "steer" && part.text === "Also check the audio levels."),
    ).toBe(true);
    controller.dispose();
  });

  it("step cap: RUN_STEP_LIMIT after CHAT_MAX_CLIENT_STEPS turns, no further POSTs", async () => {
    // Vary the args per step so the repetition guard never fires first.
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: (step: number) => [
              runStarted("run_cap", 0),
              turnStarted("run_cap", 1, step),
              turnCompleted("run_cap", 2, step, {
                assistantText: "",
                toolCalls: [readCall("studio.list_layers", { depth: step }, `call_loop_${step}`)],
              }),
            ],
          },
        },
      },
    });
    const errors: Array<{ code: string; message: string }> = [];
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => makeExecutor({ layers: [] })),
      onError: (error) => errors.push(error),
    });

    controller.send(input("Never finishes."));
    await until(controller, (s) => s.phase === "failed", "step-cap failure");

    expect(posts).toHaveLength(CHAT_MAX_CLIENT_STEPS);
    expect(posts.at(-1)?.stepIndex).toBe(CHAT_MAX_CLIENT_STEPS - 1);
    expect(controller.getSnapshot().error?.code).toBe("RUN_STEP_LIMIT");
    expect(errors.at(-1)?.code).toBe("RUN_STEP_LIMIT");
    controller.dispose();
  });

  it("wall clock: RUN_TIMEOUT once the run exceeds CHAT_RUN_TIMEOUT_MS, no further POSTs", async () => {
    const read = readCall("studio.list_layers", {}, "call_slow");
    // Same holder-object pattern as the steer test: TS's control-flow
    // analysis keeps a bare `let x = null` narrowed to `null` at the call.
    const release = { gate: (): void => {} };
    const gate = new Promise<void>((resolve) => {
      release.gate = resolve;
    });
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_slow", 0),
              turnStarted("run_slow", 1, 0),
              turnCompleted("run_slow", 2, 0, { assistantText: "", toolCalls: [read] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_slow", 0),
              turnCompleted("run_slow", 1, 1, { assistantText: "Done.", toolCalls: [] }),
            ],
          },
        },
      },
    });
    const errors: Array<{ code: string; message: string }> = [];
    let clock = 1_000;
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => ({
        handles: (tool) => tool === "studio.list_layers",
        execute: async () => {
          await gate; // park INSIDE the executor — the clock advances mid-run
          return { ok: true };
        },
      })),
      now: () => clock,
      onError: (error) => errors.push(error),
    });

    controller.send(input("Slow run."));
    await until(
      controller,
      (s) => (s.messages.at(-1)?.toolCalls?.length ?? 0) > 0,
      "turn 0 completed",
    );

    clock += CHAT_RUN_TIMEOUT_MS + 1; // ten minutes pass while the executor parks
    release.gate();
    await until(controller, (s) => s.phase === "failed", "wall-clock abort");

    expect(controller.getSnapshot().error?.code).toBe("RUN_TIMEOUT");
    expect(errors.at(-1)?.code).toBe("RUN_TIMEOUT");
    expect(posts).toHaveLength(1); // the step 1 POST never went out
    controller.dispose();
  });

  it("repetition guard: nudge at the 2nd identical call, RUN_STEP_LIMIT at the 3rd", async () => {
    const repeated = () =>
      readCall("studio.set_properties", { properties: [{ path: "x", value: 1 }] }, "call_same");
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_rep", 0),
              turnCompleted("run_rep", 1, 0, { assistantText: "", toolCalls: [repeated()] }),
            ],
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => makeExecutor({ ok: true })),
    });

    controller.send(input("Do the same thing."));
    await until(controller, (s) => s.phase === "failed", "repetition abort");

    expect(posts).toHaveLength(3); // the three occurrences
    // The 3rd turn's body carries the nudge injected after the 2nd.
    const step2 = posts[2]?.messages ?? [];
    expect(
      step2.some(
        (part) =>
          part.role === "steer" &&
          part.text === "You already proposed studio.set_properties; continue with the next step.",
      ),
    ).toBe(true);
    expect(controller.getSnapshot().error?.code).toBe("RUN_STEP_LIMIT");
    controller.dispose();
  });

  it("stop (§8.3): folds cancelled at once, aborts the fetch, abandons ONCE, never continues", async () => {
    const { client, posts, abandons } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_stop", 0),
              turnStarted("run_stop", 1, 0),
              delta("run_stop", 2, "Thi"),
              // hangs here until abort()
            ],
            hangAfter: 3,
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => makeExecutor()),
    });

    controller.send(input("Anything."));
    await until(controller, (s) => s.phase === "streaming", "streaming");
    controller.stop();

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe("cancelled");
    await until(controller, () => abandons.length === 1, "abandon POSTed");
    expect(abandons).toHaveLength(1);
    expect(abandons[0]).toBe(posts[0]?.runId);

    // Give the aborted loop a chance to (incorrectly) continue.
    for (let i = 0; i < 20; i += 1) await tick();
    expect(posts).toHaveLength(1); // no step 1 was ever POSTed
    controller.dispose();
    expect(abandons).toHaveLength(1); // dispose never double-abandons
  });

  it("stop() clears the steer queue: a send racing the run's end is dropped + explained, never stranded (w3-b06)", async () => {
    // The plan POST hangs: the run is ENDING (final turn completed) while the
    // phase is still live — the exact window where send() queues + renders.
    const release = { gate: (): void => {} };
    const planGate = new Promise<void>((resolve) => {
      release.gate = resolve;
    });
    const write = writeProposal("studio.create_text", { name: "T", text: "x" }, "call_q1");
    const { client, posts, planPosts, abandons } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_q", 0),
              turnCompleted("run_q", 1, 0, { assistantText: "", toolCalls: [write] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_q", 0),
              turnCompleted("run_q", 1, 1, { assistantText: "Done.", toolCalls: [] }),
            ],
          },
        },
      },
      planGate,
    });
    const errors: Array<{ code: string; message: string }> = [];
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      onError: (error) => errors.push(error),
    });

    controller.send(input("Original ask."));
    await until(controller, () => planPosts.length === 1, "plan POST in flight (run ending)");

    // A send in the ending window: bubble rendered NOW, queued for a fresh run.
    controller.send(input("Racing send."));
    expect(
      controller
        .getSnapshot()
        .messages.some((message) => message.role === "user" && message.text === "Racing send."),
    ).toBe(true);

    controller.stop();
    expect(controller.getSnapshot().phase).toBe("cancelled");
    // The queued send was DROPPED with an explanation — never silently stranded.
    expect(errors).toEqual([
      { code: "STOP_DROPPED_SENDS", message: "Run cancelled — 1 unsent message dropped." },
    ]);

    release.gate(); // the parked plan POST settles; finishRun must bail (stopped)
    for (let i = 0; i < 20; i += 1) await tick();
    // No fresh run ever POSTed the stranded send; the aborted run keeps its
    // two turns and its single abandon.
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((post) => post.runId)).size).toBe(1);
    expect(abandons).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe("cancelled");
    controller.dispose();
  });

  it("stop() drops un-ridden steers the same way (bubble stays, nothing auto-starts, w3-b06)", async () => {
    const { client, posts, abandons } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_st", 0),
              turnStarted("run_st", 1, 0),
              delta("run_st", 2, "Wo"),
            ],
            hangAfter: 3, // the turn hangs: a steer lands but never rides a POST
          },
        },
      },
    });
    const errors: Array<{ code: string; message: string }> = [];
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      onError: (error) => errors.push(error),
    });

    controller.send(input("Base ask."));
    await until(controller, (s) => s.phase === "streaming", "streaming");
    controller.send(input("Unsent steer.")); // pendingSteers — never on the wire
    expect(
      controller
        .getSnapshot()
        .messages.some((message) => message.role === "user" && message.text === "Unsent steer."),
    ).toBe(true);

    controller.stop();
    expect(errors).toEqual([
      { code: "STOP_DROPPED_SENDS", message: "Run cancelled — 1 unsent message dropped." },
    ]);

    for (let i = 0; i < 20; i += 1) await tick();
    expect(posts).toHaveLength(1); // the steer never rode a turn, never started a run
    expect(abandons).toHaveLength(1);
    controller.dispose();
  });

  it("TURN_PAUSED parks; retry() re-POSTs the SAME step (same key) and the run finishes", async () => {
    const read = readCall("studio.get_context", {}, "call_p1");
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_pause", 0),
              turnStarted("run_pause", 1, 0),
              delta("run_pause", 2, "Half "),
              turnCompleted("run_pause", 3, 0, { assistantText: "Half done.", toolCalls: [read] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_pause", 0),
              turnCompleted("run_pause", 1, 1, { assistantText: "Done.", toolCalls: [] }),
            ],
          },
        },
        // The FIRST POST of step 0 parks mid-turn (transport exhausted).
        variants: {
          "0:1": {
            frames: () => [runStarted("run_pause", 0), delta("run_pause", 1, "Hal")],
            pauseAfter: 2,
          },
        },
      },
    });
    const errors: Array<{ code: string; message: string }> = [];
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => makeExecutor({ context: "…" })),
      onError: (error) => errors.push(error),
    });

    controller.send(input("Paused run."));
    await until(controller, (s) => s.phase === "failed", "parked failure");
    expect(controller.getSnapshot().error?.code).toBe("TURN_PAUSED");
    expect(errors.at(-1)?.code).toBe("TURN_PAUSED");
    expect(posts).toHaveLength(1);

    controller.retry();
    await until(controller, (s) => s.phase === "done", "resumed run done");

    // The resume re-POSTed the SAME step with the SAME key + the parked
    // attempt's replay cursor — never a duplicate run.
    expect(posts).toHaveLength(3);
    expect(posts[0]?.key).toBe(posts[1]?.key);
    expect(posts[1]?.replayCursor).toBe(1); // the parked attempt's lastServerSeq
    // The replayed run.started/turn.started dropped (≤ cursor); the terminal
    // carried the authoritative text.
    const last = controller.getSnapshot().messages.at(-1);
    expect(last?.text).toBe("Done.");
    controller.dispose();
  });

  it("retry() escape hatch: an unexpected rejection during the resume folds failed — never parks on reconnecting (w3-b06)", async () => {
    // The resume's runTurn call is NOT wrapped by startRun's catch — an
    // unexpected escape (here: a throwing canvas seam) must fold the honest
    // failure instead of leaving the phase on "reconnecting" forever.
    // The variant serves the FIRST step-0 POST a park (TURN_PAUSED) and every
    // later one the completing frames — the fake keys variants by step:nth,
    // not runId, so the fresh run's step 0 hits the same "0:1" slot.
    let firstStepZeroServed = false;
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_esc", 0),
              turnStarted("run_esc", 1, 0),
              delta("run_esc", 2, "Hal"),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_esc", 0),
              turnCompleted("run_esc", 1, 1, { assistantText: "Done.", toolCalls: [] }),
            ],
          },
        },
        variants: {
          get "0:1"(): StepScript {
            return firstStepZeroServed
              ? {
                  frames: () => [
                    runStarted("run_esc", 0),
                    turnCompleted("run_esc", 1, 0, { assistantText: "Fresh.", toolCalls: [] }),
                  ],
                }
              : {
                  frames: () => [runStarted("run_esc", 0), delta("run_esc", 1, "Ha")],
                  pauseAfter: 2,
                };
          },
        },
      },
    });
    const errors: Array<{ code: string; message: string }> = [];
    let throwOnCanvas = false;
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      canvasSnapshot: () => {
        if (throwOnCanvas) throw new Error("canvas bridge exploded");
        return null;
      },
      onError: (error) => errors.push(error),
    });

    controller.send(input("Pause me."));
    await until(
      controller,
      (s) => s.phase === "failed" && s.error?.code === "TURN_PAUSED",
      "parked TURN_PAUSED",
    );

    throwOnCanvas = true; // the resumed runTurn now rejects unexpectedly
    controller.retry();
    await until(
      controller,
      (s) => s.phase === "failed" && s.error?.code === "NETWORK_ERROR",
      "escape folded to failed",
    );
    expect(errors.at(-1)?.code).toBe("NETWORK_ERROR");

    // The engine still serves a fresh send afterwards (the dead run is finished).
    throwOnCanvas = false;
    firstStepZeroServed = true;
    controller.send(input("Fresh start."));
    await until(controller, (s) => s.phase === "done", "fresh run done");
    // parked attempt + the fresh run's step 0 (the escape itself never POSTed —
    // the canvas seam threw before the transport), and the fresh run is NEW.
    expect(posts).toHaveLength(2);
    expect(posts[1]?.runId).not.toBe(posts[0]?.runId);
    controller.dispose();
  });

  it("a surfaced non-retryable turn.failed ends the run; retry() starts a FRESH run (new runId)", async () => {
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_dead", 0),
              turnStarted("run_dead", 1, 0),
              turnFailed("run_dead", 2, 0, {
                code: "MODEL_UNAVAILABLE",
                message: "The model is unavailable.",
                retryable: false,
              }),
            ],
          },
        },
        variants: {
          // A different run (new runId) succeeding on its step 0: the fake
          // keys scripts by stepIndex, so the fresh run replays step 0 —
          // override via nth is per key, which differs. Instead the base
          // step-0 script is replaced after the first run died.
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => makeExecutor()),
    });

    controller.send(input("Try once."));
    await until(controller, (s) => s.phase === "failed", "terminal failure");
    expect(controller.getSnapshot().error?.code).toBe("MODEL_UNAVAILABLE");
    const firstRunId = posts[0]?.runId;

    // Fresh-run retry: a NEW runId — never a replay of the dead run's log.
    controller.retry();
    await until(controller, () => posts.length >= 2, "fresh run POSTed");
    expect(posts[1]?.runId).not.toBe(firstRunId);
    expect(posts[1]?.stepIndex).toBe(0);
    // No duplicate user bubble: still exactly one user message rendered.
    const users = controller.getSnapshot().messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    controller.dispose();
  });

  it("no proposals ⇒ ONE end-marker POST; a run without an executor echoes the typed unavailable result", async () => {
    const read = readCall("studio.list_layers", {}, "call_only");
    const { client, posts, planPosts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_readonly", 0),
              turnCompleted("run_readonly", 1, 0, { assistantText: "", toolCalls: [read] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_readonly", 0),
              turnCompleted("run_readonly", 1, 1, { assistantText: "No layers.", toolCalls: [] }),
            ],
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      // NO toolExecutor: read calls fail closed, the run continues.
    });

    controller.send(input("List the layers."));
    await until(controller, (s) => s.phase === "done", "run done");

    expect(planPosts).toEqual([{ plan: undefined, runId: expect.any(String) }]); // 12-w7: end marker only
    const toolResult = (posts[1]?.messages ?? []).find((part) => part.role === "tool_result") as
      | { result: { error: string; message: string } }
      | undefined;
    expect(toolResult?.result.error).toBe("CLIENT_TOOL_UNAVAILABLE");
    // ROUND-12 end-marker pin (12-w7): no proposals ⇒ still ONE end-marker
    // POST to /v1/runs/:id/plan (never a merged-plan POST).
    expect(planPosts).toEqual([{ plan: undefined, runId: expect.any(String) }]);
    controller.dispose();
  });

  it("all-undo_run carriers still POST the {end:true} marker (mergeEditPlans null is a designed value, w3-b06)", async () => {
    // A run whose ONLY write tool is `studio.undo_run` (the model proposing
    // "undo the previous run"): every carrier filters out of mergeEditPlans,
    // the merge is null — the gateway row still needs the end marker or it
    // rots as a stale "running" row (12-w6-e2, extended by w3-b06).
    const undo = writeProposal("studio.undo_run", {}, "call_u1");
    const { client, planPosts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_undo", 0),
              turnCompleted("run_undo", 1, 0, { assistantText: "", toolCalls: [undo] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_undo", 0),
              turnCompleted("run_undo", 1, 1, { assistantText: "Undone.", toolCalls: [] }),
            ],
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
    });

    controller.send(input("Undo the last run."));
    await until(controller, (s) => s.phase === "done", "run done");

    // ONE end-marker POST (plan: undefined) — never ZERO (the old rot), never
    // a merged plan (nothing mergeable existed).
    expect(planPosts).toEqual([{ plan: undefined, runId: expect.any(String) }]);
    expect(controller.getSnapshot().messages.at(-1)?.text).toBe("Undone.");
    controller.dispose();
  });

  it("plan-POST failure surfaces onError but the run still completes", async () => {
    const write = writeProposal("studio.save_version", { label: "v2" }, "call_s1");
    const errors: Array<{ code: string; message: string }> = [];
    const { client, planPosts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_planfail", 0),
              turnCompleted("run_planfail", 1, 0, { assistantText: "", toolCalls: [write] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_planfail", 0),
              turnCompleted("run_planfail", 1, 1, { assistantText: "Proposing.", toolCalls: [] }),
            ],
          },
        },
      },
      planFails: true,
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      onError: (error) => errors.push(error),
    });

    controller.send(input("Save it."));
    await until(controller, (s) => s.phase === "done", "run still completes");
    expect(planPosts).toHaveLength(1); // the POST was attempted once
    expect(errors.some((error) => error.message === "The plan could not be submitted.")).toBe(true);
    // The card never appeared, but the text folds stand.
    expect(controller.getSnapshot().messages.at(-1)?.text).toBe("Proposing.");
    controller.dispose();
  });

  it("round 13: a plan POST answered RUN_NOT_ACTIVE (stop raced the run end) is swallowed — no error, the run completes", async () => {
    const write = writeProposal("studio.save_version", { label: "v2" }, "call_s1");
    const errors: Array<{ code: string; message: string }> = [];
    const { client, planPosts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_stoppedrace", 0),
              turnCompleted("run_stoppedrace", 1, 0, { assistantText: "", toolCalls: [write] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_stoppedrace", 0),
              turnCompleted("run_stoppedrace", 1, 1, {
                assistantText: "Proposing.",
                toolCalls: [],
              }),
            ],
          },
        },
      },
      planErrorCode: "RUN_NOT_ACTIVE",
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      onError: (error) => errors.push(error),
    });

    controller.send(input("Save it."));
    await until(controller, (s) => s.phase === "done", "run completes anyway");
    expect(planPosts).toHaveLength(1); // the POST was attempted once
    // GRACEFUL RECOVERY: the stopped run's answer is EXPECTED, never surfaced.
    expect(errors).toHaveLength(0);
    expect(controller.getSnapshot().error).toBeUndefined();
    // The text folds stand.
    expect(controller.getSnapshot().messages.at(-1)?.text).toBe("Proposing.");
    controller.dispose();
  });

  it("canvas: included on step 0 and again only when the snapshot hash changed", async () => {
    const read = readCall("studio.get_context", {}, "call_cv");
    let canvas: TurnCanvas | null = {
      activeComp: "Main",
      layers: [{ id: 1, name: "BG", type: "solid" }],
      selection: [],
      playhead: 0,
      fps: 30,
      duration: 10,
    };
    const { client, posts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_canvas", 0),
              turnCompleted("run_canvas", 1, 0, { assistantText: "", toolCalls: [read] }),
            ],
          },
          1: {
            frames: () => [
              runStarted("run_canvas", 0),
              turnCompleted("run_canvas", 1, 1, { assistantText: "", toolCalls: [read] }),
            ],
          },
          2: {
            frames: () => [
              runStarted("run_canvas", 0),
              turnCompleted("run_canvas", 1, 2, { assistantText: "Done.", toolCalls: [] }),
            ],
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
      toolExecutor: executorFactory(() => makeExecutor({ context: "…" })),
      canvasSnapshot: () => canvas,
    });

    controller.send(input("Watch the canvas."));
    await until(controller, (s) => s.phase === "done", "run done");

    expect(posts).toHaveLength(3);
    expect(posts[0]?.canvas).toEqual(canvas); // step 0: always included
    expect(posts[1]?.canvas).toBeUndefined(); // unchanged hash ⇒ omitted
    canvas = { ...canvas, playhead: 5 }; // the editor moved
    // Re-run: a fresh send re-includes the canvas on its step 0.
    controller.send(input("Second look."));
    await until(controller, (s) => s.phase === "done", "second run done");
    const second = posts.slice(3);
    expect(second[0]?.canvas).toEqual({ ...canvas });
    controller.dispose();
  });

  it("store semantics: subscribe/unsubscribe work; getSnapshot is stable between changes", async () => {
    const { client } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_store", 0),
              turnCompleted("run_store", 1, 0, { assistantText: "Hi.", toolCalls: [] }),
            ],
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.send(input("Hello."));
    await until(controller, (s) => s.phase === "done", "run done");
    expect(listener).toHaveBeenCalled();
    const settled = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(settled); // referentially stable
    unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    controller.send(input("Again."));
    await until(controller, (s) => s.activeRunId !== settled.activeRunId, "new run");
    expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe); // no leaks
    controller.dispose();
  });

  it("apply gestures without a plan runtime fold APPLY_UNAVAILABLE and execute nothing", async () => {
    const { client } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_gesture", 0),
              turnCompleted("run_gesture", 1, 0, { assistantText: "Hi.", toolCalls: [] }),
            ],
          },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws_1",
      projectId: "prj_1",
      threadId: THREAD,
    });
    controller.send(input("Hello."));
    await until(controller, (s) => s.phase === "done", "run done");

    const plan: ApplicablePlan = {
      runId: "run_gesture",
      compiledBatch: { label: "Agent: x", atomic: true, steps: [{ command: "noop", params: {} }] },
    };
    controller.apply(plan);
    const runtime = controller
      .getSnapshot()
      .messages.find((m) => m.runId === "run_gesture")?.planRuntime;
    // No runtime on this card (no plan POST) ⇒ the gesture folds nothing.
    expect(runtime).toBeUndefined();
    controller.dispose();
  });

  it("the real ApiClient satisfies ChatControllerClient (compile-time guard)", () => {
    const typeCheck: ChatControllerClient = null as unknown as ApiClient;
    expect(typeCheck).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// w8 LIVE-APPLY + STOP-CONTEXT — the harness fixes
// ---------------------------------------------------------------------------

describe("w8 live-apply (per-turn, canvas-visible)", () => {
  it("applyLive fires per TURN boundary, before the run's plan POST; run-end never re-executes", async () => {
    const write0 = writeProposal("studio.create_text", { name: "Title", text: "Hi" }, "call_w0");
    const engine = makeApplyEngine();
    const liveCalls: ApplicablePlan[] = [];
    const liveEngine: ApplyController = {
      ...engine,
      applyLive: async (plan) => {
        liveCalls.push(plan);
        return { ok: true, versionId: "ver_live_1" } as ApplyOutcome;
      },
    };
    const { client, planPosts } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_live", 0),
              turnStarted("run_live", 1, 0),
              toolStarted("run_live", 2, "call_w0", "studio.create_text", write0.args),
              turnCompleted("run_live", 3, 0, { toolCalls: [write0] }),
            ],
          },
          1: {
            frames: () => [turnCompleted("run_live", 4, 1, { assistantText: "Done." })],
          },
        },
      },
      planResponse: (runId, plan) => ({
        runId,
        plan,
        compiledBatch: undefined,
        autoApply: { mode: "auto", reason: "low risk" },
      }),
    });
    const controller = createChatController({
      client,
      workspaceId: "ws",
      projectId: "prj",
      threadId: "th",
      apply: liveEngine,
      toolExecutor: () => makeExecutor(),
    });
    controller.send({ message: "make a title", context: {} as ContextSelection, pinned: [] });
    await until(controller, () => controller.getSnapshot().phase === "done", "phase");
    // THE moment-each-turn-finishes property: the turn's batch ran live.
    expect(liveCalls).toHaveLength(1);
    // The plan rides the CONTROLLER's run id (the one the plan POST uses).
    expect(planPosts[0]?.runId).toBe(liveCalls[0]?.runId);
    // The run-end apply NEVER re-executed it (no duplicate layers).
    expect(engine.calls.apply).toHaveLength(0);
    // The run-end plan POST still happened (the gateway end marker + card).
    expect(planPosts.length).toBeGreaterThanOrEqual(1);
    controller.dispose();
  });

  it("a live failure marks the run live-broken and surfaces it, never re-executes", async () => {
    const write0 = writeProposal("studio.set_properties", { layer: "Title", props: {} }, "call_w0");
    const engine = makeApplyEngine();
    const liveEngine: ApplyController = {
      ...engine,
      applyLive: async () =>
        ({ ok: false, reason: "save-failed", message: "could not save" }) as ApplyOutcome,
    };
    const errors: Array<{ code: string; message: string }> = [];
    const { client } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_live2", 0),
              turnStarted("run_live2", 1, 0),
              toolStarted("run_live2", 2, "call_w0", "studio.set_properties", write0.args),
              turnCompleted("run_live2", 3, 0, { toolCalls: [write0] }),
            ],
          },
          1: { frames: () => [turnCompleted("run_live2", 4, 1, { assistantText: "Done." })] },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws",
      projectId: "prj",
      threadId: "th",
      apply: liveEngine,
      onError: (error) => errors.push(error),
      toolExecutor: () => makeExecutor(),
    });
    controller.send({ message: "style it", context: {} as ContextSelection, pinned: [] });
    await until(controller, () => controller.getSnapshot().phase === "done", "phase");
    expect(errors.some((error) => error.code === "LIVE_APPLY_FAILED")).toBe(true);
    // The run-end flow did NOT silently re-execute the broken plan either.
    expect(engine.calls.apply).toHaveLength(0);
    controller.dispose();
  });

  it("autoApplyPref === false (the user opted out) keeps everything for the plan card", async () => {
    const write0 = writeProposal("studio.create_text", { name: "Title", text: "Hi" }, "call_w0");
    const engine = makeApplyEngine();
    const liveEngine: ApplyController = {
      ...engine,
      applyLive: async (plan) => {
        engine.calls.apply.push(plan);
        return { ok: true, versionId: "ver_x" } as ApplyOutcome;
      },
    };
    const { client } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_live3", 0),
              turnCompleted("run_live3", 1, 0, { toolCalls: [write0] }),
            ],
          },
          1: { frames: () => [turnCompleted("run_live3", 2, 1, { assistantText: "Done." })] },
        },
      },
    });
    const controller = createChatController({
      client,
      workspaceId: "ws",
      projectId: "prj",
      threadId: "th",
      apply: liveEngine,
      autoApplyPref: () => false,
      toolExecutor: () => makeExecutor(),
    });
    controller.send({ message: "make a title", context: {} as ContextSelection, pinned: [] });
    await until(controller, () => controller.getSnapshot().phase === "done", "phase");
    expect(engine.calls.apply).toHaveLength(0);
    controller.dispose();
  });
});

describe("w8 stop-context (steers persist as thread history)", () => {
  it("stop() persists undelivered steers through threads.addMessage — the next run sees them", async () => {
    const write0 = writeProposal("studio.create_text", { name: "A", text: "a" }, "call_s0");
    const persisted: Array<{ threadId: string; message: string; note?: string }> = [];
    const { client } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [
              runStarted("run_stop", 0),
              turnStarted("run_stop", 1, 0),
              toolStarted("run_stop", 2, "call_s0", "studio.create_text", write0.args),
              turnCompleted("run_stop", 3, 0, { toolCalls: [write0] }),
            ],
            hangAfter: 3,
          },
        },
      },
    });
    const withThreads: ChatControllerClient = {
      ...client,
      threads: {
        addMessage: async (threadId, body) => {
          persisted.push({ threadId, message: body.message, note: body.note });
          return { id: "msg_x" } as never;
        },
      },
    };
    const controller = createChatController({
      client: withThreads,
      workspaceId: "ws",
      projectId: "prj",
      threadId: "th_stop",
      toolExecutor: () => makeExecutor(),
    });
    controller.send({ message: "start", context: {} as ContextSelection, pinned: [] });
    await until(controller, () => controller.getSnapshot().phase === "streaming", "phase");
    // Steer the live run, then stop it before the turn POSTs.
    controller.send({
      message: "actually use a bold font",
      context: {} as ContextSelection,
      pinned: [],
    });
    controller.stop();
    await until(controller, () => controller.getSnapshot().phase === "cancelled", "phase");
    expect(persisted).toEqual([
      {
        threadId: "th_stop",
        message: "actually use a bold font",
        note: "sent while the agent was working — the run was stopped before it was answered",
      },
    ]);
    controller.dispose();
  });

  it("stop() with NO undelivered sends persists nothing", async () => {
    const persisted: unknown[] = [];
    const { client } = makeClient({
      script: {
        steps: {
          0: {
            frames: () => [runStarted("run_stop2", 0), turnStarted("run_stop2", 1, 0)],
            hangAfter: 2,
          },
        },
      },
    });
    const withThreads: ChatControllerClient = {
      ...client,
      threads: {
        addMessage: async (_threadId, body) => {
          persisted.push(body);
          return { id: "msg_y" } as never;
        },
      },
    };
    const controller = createChatController({
      client: withThreads,
      workspaceId: "ws",
      projectId: "prj",
      threadId: "th_stop2",
      toolExecutor: () => makeExecutor(),
    });
    controller.send({ message: "hello", context: {} as ContextSelection, pinned: [] });
    await until(controller, () => controller.getSnapshot().phase === "streaming", "phase");
    controller.stop();
    await until(controller, () => controller.getSnapshot().phase === "cancelled", "phase");
    expect(persisted).toHaveLength(0);
    controller.dispose();
  });
});
