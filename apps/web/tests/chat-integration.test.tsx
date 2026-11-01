/**
 * M4-L/M5-Q — the WEB full-loop integration test, ROUND-12 EDITION (docs/
 * phases/M4-SEAMS.md Seam 7; docs/research/round12-design.md "Architecture" +
 * "TURN WIRE CONTRACT"): the flagship that composes the REAL browser-side
 * client-driven agent loop and fakes ONLY the wire.
 *
 * THE NEW TRUTH this file pins (round 12 — the loop lives in the browser):
 *   * every model call is ONE bounded turn POSTed through
 *     `client.chat.turn` (POST /v1/threads/:id/turn, header
 *     `Idempotency-Key: ${runId}:${stepIndex}` — the fake records the
 *     derived `turnKey` and asserts same-key re-POSTs);
 *   * the turn SSE is run.started → turn.started → message.delta/
 *     tool.started → turn.completed | turn.failed (NO server plan events,
 *     NO server run.completed, NO tool.result POST-backs);
 *   * READ/GENERATIVE tools execute LOCALLY through the provider-wired
 *     `createClientToolExecutor` (the real fake bridge answers) and the
 *     result echoes as a tool_result part in the NEXT turn's transcript;
 *   * WRITE tools arrive as proposal carriers — the loop ACCUMULATES them
 *     (`carrierEditPlan`), echoes `resultForModel`, and NEVER executes;
 *   * the run ends on a turn.completed with NO toolCalls → the client
 *     merges the carriers (`mergeEditPlans`) and POSTs /v1/runs/:id/plan,
 *     folding the response as the plan card (auto-apply drives on a
 *     `mode: "auto"` verdict);
 *   * STOP aborts the in-flight turn + fire-and-forget POSTs
 *     /v1/runs/:id/abandon; TURN_PAUSED (the turn transport's bounded park)
 *     plays the old §8.4 RUN_PAUSED role — banner + Retry re-sends the
 *     SAME step (same key).
 *
 * This is the ONE suite that composes the REAL browser-side stack:
 *
 *   REAL ChatProvider (thread lazy-create, models, context orchestration,
 *        canvas snapshot, executor factory, send facade)
 *   REAL ChatPanelSlot (the composed panel: header + context strip/popover +
 *        thread + composer + footer over the provider's render-prop)
 *   REAL createChatController + foldEvent + createClientToolExecutor +
 *        createApplyController + context.ts
 *   REAL wave-2 components (ChatComposer emits, ChatThread/ToolCard/PlanCard
 *        render the loop's outputs, ContextStrip/Popover drive the flags)
 *   REAL @studio/editor-bridge fake (createFakeEditor seeded with a real
 *        "Main" comp + a real selected "Headline" text layer — get_context
 *        returns REAL editor data)
 *
 *   FAKED: the api-client surface ONLY (threads.create/list/messages /
 *   models.list / chat.turn / runs.submitPlan + abandon + applyRun/undoRun).
 *   `chat.turn` records every POST, mirrors the DOCUMENTED streamTurn
 *   contract (sse.ts): per-turn server seqs are deduped by a replay cursor
 *   and rewritten into the run's monotonic LOCAL seqs (`seqBase`), a
 *   transport drop re-POSTs the SAME body + key through a NEW post with the
 *   normalizer's cursor continued, `abort()` settles `done` `aborted`, and
 *   TURN_PAUSED parks with `onError` + `done {reason: "paused"}`.
 *
 * Scenario → test map (M4 evidence, round-12 rewires):
 *   1 full read-agent loop  → "composer send → client-driven turn POSTs …"
 *   2 context-chip accuracy → "popover removal drops the selection block …"
 *     (+ "turn POST body omits model when entitlements failed …")
 *   3 replay idempotence    → "replay idempotence: the same turn event list …"
 *   4 reconnect             → "reconnect: a transport drop …"
 *   5 TURN_PAUSED park      → "TURN_PAUSED: the parked run shows the §8.4 …"
 *   6 stop → abandon        → "stop: the composer's Stop aborts …"
 *   7 read-only embed (M4.6)→ "read-only embed: a write-tool proposal …"
 *   8 non-client tool       → "non-client tool refusal: the wired executor …"
 *   9 steer queue (§3.4)    → "a composer send while the run is live …"
 *  10–20 the M5-Q wired apply journey (see the second describe).
 *
 * Deterministic, no network, real timers (the §11 1 Hz inspect poll is given
 * real time to fire where a scenario needs the AUTO selection flags — the
 * only wall-clock dependency in the file, bounded and looped, never slept
 * blind).
 */

import { LAYOUT_STORAGE_KEY } from "@/components/chat/layout";
import { ChatPanelSlot } from "@/components/editor-host/chat-panel-slot";
import { createChatShortcutBus } from "@/components/editor-host/chat-shortcut-bus";
import { DEFAULT_FLAGS } from "@/lib/chat/context";
import { type ChatApplyPorts, type ChatContextApi, ChatProvider } from "@/lib/chat/provider";
import { createClientToolExecutor, isClientToolError } from "@/lib/chat/tool-executor";
import type { SaveOutcome } from "@/lib/editor-session";
import type { ApiClient, TurnStreamHandle } from "@studio/api-client";
import type { EditPlan, StudioStreamEvent, Thread, TurnToolCall } from "@studio/contracts";
import type { ContextSelection } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { type FakeEditor, attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The fake wire (the ONLY fake): an ApiClient stand-in that records turn POSTs
// ---------------------------------------------------------------------------

/**
 * The turn-transport handler set the chat engine hands to `client.chat.turn`
 * (sse.ts `streamTurn` — `TurnStreamHandlers` + the call's seqBase/replay
 * cursor options).
 */
interface TurnPostHandlers {
  readonly onEvent?: (event: StudioStreamEvent) => void;
  readonly onError?: (error: { code: string; message: string; retryable: boolean }) => void;
  readonly onReconnect?: (info: { attempt: number; delayMs: number }) => void;
  readonly onDone?: (summary: { reason: string; runId: string | null; failure: unknown }) => void;
  readonly seqBase?: number;
  readonly replayCursor?: number;
}

/**
 * ONE POST to /v1/threads/:id/turn (the original call, a controller Retry of
 * the same step, or the transport's own same-key re-POST after a drop).
 */
interface TurnPost {
  readonly threadId: string;
  /** The POST-time serialized body (the transport stringifies; never aliases). */
  readonly body: Record<string, unknown>;
  readonly runId: string;
  readonly stepIndex: number;
  /** `${runId}:${stepIndex}` — exactly what the Idempotency-Key header rides. */
  readonly turnKey: string;
  readonly seqBase: number;
  readonly replayCursor: number | null;
  readonly handlers: TurnPostHandlers;
  /** The normalizer's server-seq watermark — frames ≤ it are replay no-ops. */
  lastServerSeq: number;
  /** The normalizer's LOCAL seq (continues the run's monotonic space). */
  localSeq: number;
  /** Every LOCAL event this POST emitted (verbatim — the store-replay probe). */
  readonly emitted: StudioStreamEvent[];
  aborted: boolean;
  paused: boolean;
  /** Settles the handle's `done` promise (the transport's terminal path). */
  settle(reason: "terminal" | "aborted" | "paused"): void;
}

/** One POST to /v1/runs/:id/plan (the run-end merged-carrier fold). */
interface PostedPlan {
  readonly runId: string;
  readonly plan: EditPlan;
}

/** One POST to /v1/runs/:id/apply (the ApplyController's report). */
interface PostedApplyRun {
  readonly runId: string;
  readonly body: Record<string, unknown>;
  readonly idempotencyKey: string | undefined;
}

/** One POST to /v1/runs/:id/undo. */
interface PostedUndoRun {
  readonly runId: string;
  readonly body: Record<string, unknown>;
  readonly idempotencyKey: string | undefined;
}

const THREAD_ID = "thr_1";

const FAST_MODEL = {
  id: "studio-fast",
  tier: "fast" as const,
  use: "Cheap planning, classification, quick edits",
  creditsPer1kInput: 0.01,
  creditsPer1kOutput: 0.03,
};

const MODELS_OK = { plan: "trial", models: [FAST_MODEL] };

/** The default plan-route answer when a test scripts nothing richer. */
const DEFAULT_PLAN_RESPONSE = (runId: string, plan: EditPlan): Record<string, unknown> => ({
  runId,
  plan,
  autoApply: { mode: "propose", reason: "manual review" },
});

function makeWire(options: { readonly models?: "ok" | "fail" } = {}) {
  const posts: TurnPost[] = [];
  const planPosts: PostedPlan[] = [];
  const abandons: string[] = [];
  const applyRuns: PostedApplyRun[] = [];
  const undoRuns: PostedUndoRun[] = [];
  /** Scripted applyRun rejections (shifted per call; apply.ts's apiFailure shape). */
  const applyFailures: Array<{ status: number; code: string; message: string }> = [];
  /** Scripted /v1/runs/:id/plan responses (shifted per call; default echoes). */
  const planResponses: Array<Record<string, unknown>> = [];

  const active = (): TurnPost => {
    const post = posts[posts.length - 1];
    if (post === undefined) throw new Error("no open turn post");
    return post;
  };

  /** Opens ONE turn POST + its live handle (sse.ts TurnStreamHandle). */
  const openTurn = (
    threadId: string,
    body: Record<string, unknown>,
    handlers: TurnPostHandlers,
    continuation?: {
      readonly lastServerSeq: number;
      readonly localSeq: number;
      /** An internal same-key re-POST settles the ORIGINAL call's `done`. */
      readonly settle?: TurnPost["settle"];
    },
  ): TurnStreamHandle => {
    const runId = String(body.runId);
    const stepIndex = Number(body.stepIndex);
    const lastServerSeq = continuation?.lastServerSeq ?? handlers.replayCursor ?? -1;
    const localSeq = continuation?.localSeq ?? (handlers.seqBase ?? 0) - 1;
    let settled = false;
    let resolveDone: (summary: { reason: string }) => void = () => undefined;
    const done = new Promise<{ reason: string }>((resolve) => {
      resolveDone = resolve;
    });
    const ownSettle: TurnPost["settle"] = (reason) => {
      if (settled) return;
      settled = true;
      resolveDone({ reason });
    };
    const settleFn = continuation?.settle ?? ownSettle;
    const post: TurnPost = {
      threadId,
      body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
      runId,
      stepIndex,
      turnKey: `${runId}:${stepIndex}`,
      seqBase: handlers.seqBase ?? 0,
      replayCursor: handlers.replayCursor ?? null,
      handlers,
      lastServerSeq,
      localSeq,
      emitted: [],
      aborted: false,
      paused: false,
      settle: settleFn,
    };
    posts.push(post);
    return {
      done: done as never,
      runId,
      get lastServerSeq(): number {
        return post.lastServerSeq;
      },
      get paused(): boolean {
        return post.paused;
      },
      abort: () => {
        post.aborted = true;
        post.settle("aborted");
      },
    };
  };

  const client = {
    threads: {
      create: async (projectId: string): Promise<Thread> => ({
        id: THREAD_ID,
        projectId,
        title: null,
        createdBy: "usr_test",
        createdAt: "2026-10-24T00:00:00.000Z",
        updatedAt: "2026-10-24T00:00:00.000Z",
      }),
      // Thread-switcher/history seams (use-thread-history): empty + never throws.
      list: async () => ({ items: [] as Thread[], n: null }),
      messages: async () => ({ items: [], n: null }),
    },
    models: {
      list: async () => {
        if (options.models === "fail") throw new Error("models endpoint down");
        return MODELS_OK;
      },
    },
    chat: {
      /**
       * POST /v1/threads/:id/turn — the round-12 turn seam. The REAL
       * api-client validates the body (TURN_REQUEST_SCHEMA), rides the
       * `Idempotency-Key: ${runId}:${stepIndex}` header and owns bounded
       * same-key recovery (pinned in the api-client's own suite); this fake
       * mirrors the seam the controller codes against.
       */
      turn: (
        threadId: string,
        body: Record<string, unknown>,
        handlers?: TurnPostHandlers,
      ): TurnStreamHandle => openTurn(threadId, body, handlers ?? {}),
    },
    runs: {
      get: async () => {
        throw new Error("runs.get is not part of this suite's surface");
      },
      submitPlan: async (runId: string, body: { plan: EditPlan }) => {
        planPosts.push({ runId, plan: body.plan });
        const scripted = planResponses.shift();
        return (scripted ?? DEFAULT_PLAN_RESPONSE(runId, body.plan)) as never;
      },
      abandon: async (runId: string) => {
        abandons.push(runId);
        return null;
      },
      applyRun: async (
        runId: string,
        body: Record<string, unknown>,
        callOptions?: { idempotencyKey?: string },
      ) => {
        const failure = applyFailures.shift();
        if (failure !== undefined) {
          // ApiError-shaped rejection (apply.ts's apiFailure reads status/code/message).
          throw failure;
        }
        applyRuns.push({ runId, body, idempotencyKey: callOptions?.idempotencyKey });
        return {
          applied: true as const,
          versionId: body.versionId as string,
          creditsCommitted: 1,
        };
      },
      undoRun: async (
        runId: string,
        body: Record<string, unknown>,
        callOptions?: { idempotencyKey?: string },
      ) => {
        undoRuns.push({ runId, body, idempotencyKey: callOptions?.idempotencyKey });
        return { undone: true as const };
      },
    },
  } as unknown as ApiClient;

  /** Feed SERVER-seq §7.4 frames through the CURRENT post (the normalizer). */
  const feed = (...events: StudioStreamEvent[]): void => {
    const post = active();
    act(() => {
      for (const event of events) {
        // The normalizer's replay dedupe: frames ≤ the cursor are no-ops.
        if (event.seq <= post.lastServerSeq) continue;
        post.lastServerSeq = event.seq;
        post.localSeq += 1;
        const normalized = { ...event, runId: post.runId, seq: post.localSeq };
        post.emitted.push(normalized);
        post.handlers.onEvent?.(normalized);
      }
    });
  };

  /** Settles the ACTIVE handle's `done` — the transport's terminal path. */
  const finishTurn = (): void => {
    const post = active();
    act(() => {
      post.settle("terminal");
    });
  };

  /**
   * The transport's TURN_PAUSED park: `onError {code: "TURN_PAUSED"}` then
   * `done {reason: "paused"}` (bounded same-key retries exhausted).
   */
  const pauseTurn = (): void => {
    const post = active();
    act(() => {
      post.paused = true;
      post.handlers.onError?.({
        code: "TURN_PAUSED",
        message: "Run paused. Check your connection.",
        retryable: true,
      });
      post.settle("paused");
    });
  };

  /**
   * ONE transport drop mid-turn: `onReconnect` fires, then the TRANSPORT
   * re-POSTs the SAME body + turn key through a NEW post whose normalizer
   * state CONTINUES (frames already emitted stay deduped).
   */
  const dropOnce = (): void => {
    const post = active();
    act(() => {
      post.handlers.onReconnect?.({ attempt: 1, delayMs: 1000 });
      openTurn(post.threadId, post.body, post.handlers, {
        lastServerSeq: post.lastServerSeq,
        localSeq: post.localSeq,
        settle: post.settle,
      });
    });
  };

  /**
   * Re-folds the ACTIVE post's already-emitted LOCAL events verbatim (a
   * Last-Event-ID-style re-delivery that bypasses the normalizer): the
   * STORE's per-run seq cursor must make it a no-op.
   */
  const replayEmitted = (): void => {
    const post = active();
    act(() => {
      for (const event of [...post.emitted]) post.handlers.onEvent?.(event);
    });
  };

  return {
    client,
    posts,
    planPosts,
    abandons,
    applyRuns,
    undoRuns,
    applyFailures,
    planResponses,
    active,
    feed,
    finishTurn,
    pauseTurn,
    dropOnce,
    replayEmitted,
  };
}

// ---------------------------------------------------------------------------
// The recorded fake bridge (real fake editor + spies on every surface)
// ---------------------------------------------------------------------------

interface BridgeCalls {
  inspect: number;
  queries: string[];
  executes: string[];
  batches: number;
  renderFrames: number;
}

/**
 * The deterministic project: comp "Main" + a selected text layer "Headline".
 */
async function makeFakeEditorWithSelection(): Promise<FakeEditor> {
  const fake = createFakeEditor({ comps: [{ name: "Main" }] });
  await fake.execute("layer.newText", { text: "Headline" });
  return fake;
}

/**
 * The hostile duplicate-name project (the .ecproj Twin threat): TWO REAL
 * layers named "Headline" (ids 1 and 2 — `layer.rename` does NOT uniquify,
 * mirroring upstream), so the name resolution and the picked-id apply both run
 * against real engine state.
 */
async function makeFakeEditorWithTwinNames(): Promise<FakeEditor> {
  const fake = createFakeEditor({ comps: [{ name: "Main" }] });
  await fake.execute("layer.newText", { text: "Headline" }); // id 1
  await fake.execute("layer.newText", { text: "Twin" }); // id 2 (uniquified name)
  await fake.execute("layer.rename", { layer: 2, name: "Headline" }); // real twins
  return fake;
}

function makeRecordedBridge(fake: FakeEditor): { bridge: EditorBridge; calls: BridgeCalls } {
  const inner = attachFakeBridge(fake);
  const calls: BridgeCalls = { inspect: 0, queries: [], executes: [], batches: 0, renderFrames: 0 };
  const bridge: EditorBridge = {
    ...inner,
    inspect: async () => {
      calls.inspect += 1;
      return inner.inspect();
    },
    query: ((command: string, params?: unknown) => {
      calls.queries.push(command);
      return inner.query(command, params);
    }) as EditorBridge["query"],
    execute: ((command: string, params?: unknown) => {
      calls.executes.push(command);
      return inner.execute(command, params);
    }) as EditorBridge["execute"],
    batch: (input) => {
      calls.batches += 1;
      return inner.batch(input);
    },
    renderFrame: (params) => {
      calls.renderFrames += 1;
      return inner.renderFrame(params);
    },
  };
  return { bridge, calls };
}

// ---------------------------------------------------------------------------
// The mount: ChatProvider + the REAL composed panel (ChatPanelSlot)
// ---------------------------------------------------------------------------

interface Harness {
  readonly wire: ReturnType<typeof makeWire>;
  readonly bridge: EditorBridge;
  readonly bridgeCalls: BridgeCalls;
  readonly getApi: () => ChatContextApi;
}

// ---------------------------------------------------------------------------
// Seeded mount: ChatProvider + the REAL composed panel over a fake editor
// carrying a real comp + selection. `applyPorts` wires the REAL ApplyController
// (M5-Q); `twinNames` seeds the hostile duplicate-name project.
// ---------------------------------------------------------------------------

interface MountOptions {
  readonly models?: "ok" | "fail";
  readonly applyPorts?: ChatApplyPorts;
  /** Seeds the hostile duplicate-name project (the Twin threat). */
  readonly twinNames?: boolean;
}

async function mountSeeded(
  options: MountOptions = {},
): Promise<{ harness: Harness; fake: FakeEditor }> {
  const fake =
    options.twinNames === true
      ? await makeFakeEditorWithTwinNames()
      : await makeFakeEditorWithSelection();
  const wire = makeWire({ models: options.models });
  const { bridge, calls } = makeRecordedBridge(fake);
  let api: ChatContextApi | null = null;
  render(
    <ChatProvider
      client={wire.client}
      bridge={bridge}
      workspaceId="ws_test"
      projectId="prj_test"
      shortcutBus={createChatShortcutBus()}
      {...(options.applyPorts !== undefined ? { applyPorts: options.applyPorts } : {})}
    >
      {(current) => {
        api = current;
        return <ChatPanelSlot api={current} onSidebarDock={() => undefined} />;
      }}
    </ChatProvider>,
  );
  const harness: Harness = {
    wire,
    bridge,
    bridgeCalls: calls,
    getApi: () => {
      if (api === null) throw new Error("provider did not render");
      return api;
    },
  };
  return { harness, fake };
}

// ---------------------------------------------------------------------------
// Shared waits + wire-frame builders + fixtures
// ---------------------------------------------------------------------------

/** The composer's textarea (the REAL send surface). */
const composerBox = (): HTMLElement => screen.getByRole("textbox", { name: "Message the agent" });

/** Wait for models to settle (every send's model default depends on it). */
async function waitForModels(harness: Harness): Promise<void> {
  await waitFor(() => {
    expect(harness.getApi().models).not.toBeNull();
  });
}

/**
 * Give the §11 1 Hz inspect poll real time to fire so `autoFlags` flips the
 * selection-derived blocks on (the fake editor HAS a selection). Loops in
 * 200 ms steps inside one act scope so the timer landings are act-wrapped.
 */
async function waitForInspectPoll(harness: Harness): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 15 && harness.getApi().flags.selection === false; i += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  });
  expect(harness.getApi().flags.selection).toBe(true);
}

/** Placeholder runId — the fake rewrites every emitted frame to the POST's own. */
const RUN_OF_THE_WIRE = "run_from_the_wire";

// -- SERVER-seq §7.4 turn frames (the fake assigns local seqs) ---------------

function runStarted(seq: number): StudioStreamEvent {
  return { type: "run.started", runId: RUN_OF_THE_WIRE, seq, model: "studio-fast" };
}

function delta(seq: number, text: string): StudioStreamEvent {
  return { type: "message.delta", runId: RUN_OF_THE_WIRE, seq, delta: text };
}

function toolStarted(
  seq: number,
  toolCallId: string,
  tool: string,
  args: unknown,
): StudioStreamEvent {
  return {
    type: "tool.started",
    runId: RUN_OF_THE_WIRE,
    seq,
    toolCallId,
    name: tool,
    args,
  };
}

function turnCompleted(
  seq: number,
  stepIndex: number,
  outcome: {
    readonly assistantText?: string;
    readonly toolCalls?: readonly TurnToolCall[];
  },
): StudioStreamEvent {
  return {
    type: "turn.completed",
    runId: RUN_OF_THE_WIRE,
    seq,
    stepIndex,
    finishReason: (outcome.toolCalls?.length ?? 0) > 0 ? "tool-calls" : "stop",
    usage: { inputTokens: 100, outputTokens: 24 },
    credits: { committed: 1 },
    ...(outcome.assistantText !== undefined ? { assistantText: outcome.assistantText } : {}),
    toolCalls: [...(outcome.toolCalls ?? [])],
  };
}

/** A write-tool proposal carrier (the gateway's turn.completed payload). */
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

const AUTO_ON_FLAGS: ContextSelection = {
  ...DEFAULT_FLAGS,
  selection: true,
  selectedProperties: true,
};

/** The §8.6 set_properties args the model proposes (the retitle carrier). */
const SET_PROPERTIES_ARGS = {
  layers: [{ name: "Headline" }],
  properties: [{ path: "text/sourceText", value: "New headline" }],
};

beforeEach(() => {
  // The chat shell persists its layout under this key (D-10); every test
  // starts from the DEFAULT floating panel.
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
});

// ---------------------------------------------------------------------------
// Scenario 1 — the flagship full read-agent loop (client-driven turns)
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — full read-agent loop (flagship, round 12)", () => {
  it("composer send → client-driven turn POST → the loop executes get_context LOCALLY → the result echoes into the NEXT turn transcript → the run ends on a turn.completed with NO toolCalls", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    expect(harness.getApi().activeModelId).toBe("studio-fast");

    // §11 poll → autoFlags: the selection-derived blocks switch on (real selection).
    await waitForInspectPoll(harness);
    expect(await screen.findByTestId("context-chip-selection")).toBeInTheDocument();
    expect(screen.getByTestId("context-chip-projectSummary")).toBeInTheDocument();
    expect(screen.getByTestId("context-chip-activeComp")).toBeInTheDocument();
    expect(screen.getByTestId("context-chip-playhead")).toBeInTheDocument();
    expect(screen.getByTestId("context-chip-selectedProperties")).toBeInTheDocument();

    // The user types the pinned quick-prompt into the REAL composer + Enter.
    await user.type(composerBox(), "What's on this comp?{Enter}");

    // The turn POST: the exact TURN_REQUEST body shape (Idempotency-Key is a
    // HEADER derived from the body — the fake records the same derivation).
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const post = harness.wire.posts[0];
    const body = post?.body;
    expect(post?.threadId).toBe(THREAD_ID);
    expect(post?.stepIndex).toBe(0);
    expect(typeof post?.runId).toBe("string"); // client crypto.randomUUID()
    expect(post?.turnKey).toBe(`${post?.runId}:0`);
    expect(body?.messages).toEqual([{ role: "user", text: "What's on this comp?" }]);
    expect(body?.context).toEqual(AUTO_ON_FLAGS); // chips mirror what is sent
    expect(body?.pinned).toEqual([]);
    expect(body?.model).toBe("studio-fast"); // the entitlement default
    expect(body?.canvas).toMatchObject({
      // the compact canvas rides step 0 (hash-change rule)
      activeComp: "Main",
      layers: [{ id: 1, name: "Headline", type: "text" }],
      selection: [1],
    });

    // run.started → the assistant placeholder ("Thinking…") with the caret.
    harness.wire.feed(runStarted(0));
    expect(screen.getByTestId("chat-thinking")).toBeInTheDocument();
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop streaming")).toBeInTheDocument();

    // tool.started → the running card (no result settles it on the turn wire).
    const summaryBefore = harness.bridgeCalls.queries.filter((q) => q === "project.summary").length;
    harness.wire.feed(toolStarted(1, "call_ctx", "studio.get_context", {}));
    await waitFor(() => expect(screen.getByTestId("tool-card").dataset.status).toBe("running"));

    // turn.completed carries the read call → the loop executes it LOCALLY
    // through the provider-wired executor against the REAL fake bridge.
    harness.wire.feed(
      turnCompleted(2, 0, {
        assistantText: "Let me look.",
        toolCalls: [readCall("studio.get_context", {}, "call_ctx")],
      }),
    );
    harness.wire.finishTurn();

    // The NEXT turn POST (step 1, same run): the transcript echoes the
    // tool_call + the REAL locally-executed tool_result.
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const stepOne = harness.wire.posts[1];
    expect(stepOne?.runId).toBe(post?.runId); // ONE run, client-driven
    expect(stepOne?.turnKey).toBe(`${post?.runId}:1`);
    expect(stepOne?.body.canvas).toBeUndefined(); // unchanged canvas hash ⇒ omitted
    const transcript = stepOne?.body.messages as Array<Record<string, unknown>>;
    expect(transcript).toEqual([
      { role: "user", text: "What's on this comp?" },
      { role: "assistant", text: "Let me look." }, // the terminal's authoritative text
      { role: "tool_call", toolCallId: "call_ctx", tool: "studio.get_context", args: {} },
      expect.objectContaining({
        role: "tool_result",
        toolCallId: "call_ctx",
        tool: "studio.get_context",
      }),
    ]);
    const result = (transcript[3] as { result: Record<string, unknown> }).result;

    // The result carries the REAL fake-editor state, gated by DEFAULT+auto flags.
    expect(Object.keys(result).sort()).toEqual([
      "activeComp",
      "focusedPanel",
      "playhead",
      "projectSummary",
      "recentCommands",
      "selectedProperties",
      "selection",
    ]);
    expect(result.projectSummary).toMatchObject({ activeComp: 1, selectedLayers: [1] });
    expect((result.projectSummary as { items: Array<{ name: string }> }).items[0]?.name).toBe(
      "Main",
    );
    expect(
      (
        result.activeComp as {
          name: string;
          layers: Array<{ id: number; name: string; type: string }>;
        }
      ).name,
    ).toBe("Main");
    expect(
      (result.activeComp as { layers: Array<{ id: number; name: string; type: string }> })
        .layers[0],
    ).toMatchObject({ id: 1, name: "Headline", type: "text" });
    expect(result.selection).toMatchObject({ layerIds: [1] });
    expect((result.selection as { tree: { name: string } | null }).tree).toMatchObject({
      name: "Headline",
    });
    expect(result.playhead).toEqual({ timeSeconds: 0, playing: false });
    expect(result.focusedPanel).toBe("Viewer");
    expect(result.selectedProperties).toMatchObject({ layerId: 1 });
    expect(
      (result.selectedProperties as { properties: Record<string, { value: unknown }> }).properties[
        "text/sourceText"
      ],
    ).toMatchObject({ value: "Headline" });
    expect(
      (result.selectedProperties as { properties: Record<string, { value: unknown }> }).properties[
        "transform/position"
      ],
    ).toMatchObject({ value: [960, 540, 0] });
    expect(result.recentCommands).toBe("removed by user"); // DEFAULT-off flag

    // Read-only proof: the executor queried the real read surface for THIS
    // tool call, never mutated, and covered the bridge reads.
    expect(
      harness.bridgeCalls.queries.filter((q) => q === "project.summary").length - summaryBefore,
    ).toBe(1);
    expect(harness.bridgeCalls.queries).toEqual(
      expect.arrayContaining(["comp.info", "layer.tree", "prop.get"]),
    );
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);

    // The final turn: streamed deltas + a turn.completed with NO toolCalls ⇒
    // the run ENDS (local run.completed — the server is stateless per turn).
    harness.wire.feed(
      runStarted(0),
      delta(1, "The comp **Main** holds one text"),
      delta(2, " layer, Headline."),
      turnCompleted(3, 1, { assistantText: "The comp **Main** holds one text layer, Headline." }),
    );
    harness.wire.finishTurn();

    // The thread renders the finished loop: user + assistant; NO plan POST
    // (a read-only run never submits a plan); NO banner.
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
    const messages = screen.getAllByTestId("chat-message");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.dataset.role).toBe("user");
    expect(messages[1]?.dataset.role).toBe("assistant");
    expect(messages[1]?.textContent).toContain("The comp");
    expect(messages[1]?.textContent).toContain("text layer, Headline.");
    // ROUND-12 end-marker pin (12-w7): a proposal-less run still tells the
    // gateway it finished — exactly ONE {end:true} plan-route POST (the run
    // row turns completed server-side instead of rotting "running").
    expect(harness.wire.planPosts).toEqual([{ plan: undefined, runId: expect.any(String) }]);
    expect(harness.wire.abandons).toEqual([]);
    expect(screen.queryByTestId("chat-caret")).toBeNull();
    expect(screen.queryByTestId("chat-banner")).toBeNull();
    expect(screen.queryByTestId("chat-thinking")).toBeNull();
    expect(screen.getByLabelText("Send")).toBeInTheDocument(); // composer released

    // ROUND-12 fix pin (12-w5-t1): the loop SYNTHESIZES a tool.result for
    // every executed tool call through the existing §7.4 fold, so the card
    // settles with its result the moment the turn's calls are processed
    // (never spins "running" forever like the pre-fix wire gap did).
    // ROUND 13: the settled run's tool calls fold under the collapsible bar —
    // open it, then the card + its result are reachable as before.
    fireEvent.click(screen.getByTestId("chat-tools-header"));
    const card = screen.getByTestId("tool-card");
    expect(card.dataset.tool).toBe("studio.get_context");
    expect(card.dataset.status).toBe("done");
    await user.click(screen.getByTestId("tool-card-toggle"));
    expect(screen.getByTestId("tool-card-args").textContent).toContain("{}");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — context flags accuracy (popover removal → snapshot → wire)
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — context accuracy (chips mirror the wire)", () => {
  it("popover removal drops the selection block: absent from the snapshot + strip, and the next turn POST carries context.selection === false", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    await waitForInspectPoll(harness);

    // BEFORE: the auto selection context reaches the wire (send facade — the
    // exact path ChatComposer's onSend calls).
    act(() => {
      harness.getApi().send({ message: "what is selected?" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    expect(harness.wire.posts[0]?.body.context).toEqual(AUTO_ON_FLAGS);

    // Settle the first run (final turn, no tool calls) so the next send is a
    // FRESH run, not a steer (§3.4).
    harness.wire.feed(runStarted(0), turnCompleted(1, 0, { assistantText: "It is selected." }));
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));

    // The REAL §5.3 popover path: header "Context N" → the selection row → Done.
    await user.click(screen.getByTestId("chat-context-button"));
    const row = await screen.findByTestId("context-row-selection");
    expect(row.textContent).toContain("Selection: Headline"); // real editor data in the label
    await user.click(screen.getByTestId("context-toggle-selection"));
    await user.click(screen.getByTestId("context-done"));

    // The block is ABSENT (not merely unchecked): flags, snapshot, strip.
    await waitFor(() => {
      expect(harness.getApi().context?.blocks.some((block) => block.kind === "selection")).toBe(
        false,
      );
    });
    expect(harness.getApi().flags.selection).toBe(false);
    expect(screen.queryByTestId("context-chip-selection")).toBeNull();
    expect(screen.getByTestId("context-chip-selectedProperties")).toBeInTheDocument(); // granular

    // The NEXT send carries the exact turn body with selection === false.
    act(() => {
      harness.getApi().send({ message: "and now?" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const body = harness.wire.posts[1]?.body;
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "canvas",
      "context",
      "messages",
      "model",
      "pinned",
      "runId",
      "stepIndex",
    ]);
    expect(body?.messages).toEqual([{ role: "user", text: "and now?" }]);
    expect(body?.context).toEqual({ ...DEFAULT_FLAGS, selectedProperties: true });
    expect(body?.pinned).toEqual([]);
    expect(body?.model).toBe("studio-fast");
    expect(body?.runId).not.toBe(harness.wire.posts[0]?.runId); // a FRESH run
    harness.wire.feed(runStarted(0), turnCompleted(1, 0, { assistantText: "Nothing selected." }));
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
  });

  it("turn POST body omits the model key entirely when the entitlement fetch failed", async () => {
    const { harness } = await mountSeeded({ models: "fail" });
    await waitFor(() => expect(harness.getApi().models).toEqual([])); // one retry, then []
    expect(harness.getApi().activeModelId).toBeNull();
    expect(screen.queryByTestId("chat-model-button")).toBeNull(); // picker hidden ([] contract)

    act(() => {
      harness.getApi().send({ message: "no models loaded" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const body = harness.wire.posts[0]?.body;
    expect(body?.model).toBeUndefined(); // absent from the wire, not defaulted
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "canvas",
      "context",
      "messages",
      "pinned",
      "runId",
      "stepIndex",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — replay idempotence + reconnect at the component level
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — resilience (replay, reconnect, pause, stop)", () => {
  it("replay idempotence: the same turn event list folded twice leaves ONE assistant message, ONE card, ONE execution", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "explain the project" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));

    const summaryBefore = harness.bridgeCalls.queries.filter((q) => q === "project.summary").length;
    // Step 0 streams: run.started + the read call's tool.started + the
    // terminal carrying the call.
    harness.wire.feed(
      runStarted(0),
      toolStarted(1, "call_ctx", "studio.get_context", {}),
      turnCompleted(2, 0, { toolCalls: [readCall("studio.get_context", {}, "call_ctx")] }),
    );

    // A Last-Event-ID-style re-delivery of the SAME local events: the store's
    // per-run seq cursor folds each one exactly once (replayEmitted bypasses
    // the normalizer on purpose — this is the STORE's contract).
    harness.wire.replayEmitted();
    expect(screen.getAllByTestId("chat-message")).toHaveLength(2); // user + ONE assistant
    expect(screen.getAllByTestId("tool-card")).toHaveLength(1); // ONE card (upserted by id)

    // Settling the turn executes the read tool EXACTLY once.
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    expect(
      harness.bridgeCalls.queries.filter((q) => q === "project.summary").length - summaryBefore,
    ).toBe(1); // NEVER re-executed

    // The final turn's tail still folds exactly once.
    harness.wire.feed(runStarted(0), turnCompleted(1, 1, { assistantText: "Once." }));
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));

    const assistant = screen.getAllByTestId("chat-message")[1];
    const text = assistant?.textContent ?? "";
    expect(text.includes("Once.")).toBe(true);
    expect(text.split("Once.")).toHaveLength(2); // exactly once, never doubled
  });

  it("reconnect: a transport drop shows the Reconnecting… banner, the turn seam re-POSTs the SAME body + turn key, and the replay + tail complete the run", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "tell me about the comp" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const firstBody = harness.wire.posts[0]?.body;
    const firstKey = harness.wire.posts[0]?.turnKey;
    const summaryBefore = harness.bridgeCalls.queries.filter((q) => q === "project.summary").length;

    harness.wire.feed(runStarted(0), delta(1, "Resuming"));

    // Transport drop → §8.4 banner + the TRANSPORT's same-key re-POST.
    harness.wire.dropOnce();
    expect(harness.getApi().snapshot.phase).toBe("reconnecting");
    expect(screen.getByTestId("chat-banner").textContent).toContain("Reconnecting…");
    expect(harness.wire.posts).toHaveLength(2);
    expect(harness.wire.posts[1]?.turnKey).toBe(firstKey); // SAME turn key
    expect(harness.wire.posts[1]?.body).toEqual(firstBody); // SAME body, SAME key
    expect(harness.wire.posts[1]?.seqBase).toBe(harness.wire.posts[0]?.seqBase);

    // The gateway replays seq 0–1: the normalizer's cursor drops them — the
    // streamed text never doubles and nothing re-executes. ROUND 13: text
    // deltas now ride the stream pacer (50 ms cadence), so the assertion
    // WAITS for the paced release instead of reading synchronously.
    harness.wire.feed(runStarted(0), delta(1, "Resuming"));
    await waitFor(() => {
      const bubble = screen.getAllByTestId("chat-message")[1];
      expect(bubble?.textContent).toContain("Resuming");
    });
    const assistant = screen.getAllByTestId("chat-message")[1];
    expect(assistant?.textContent).not.toContain("ResumingResuming");
    expect(harness.bridgeCalls.queries.filter((q) => q === "project.summary")).toHaveLength(
      summaryBefore,
    );

    // …then the unseen tail completes the turn WITH a read call → the loop
    // executes it LOCALLY exactly once and echoes it into step 1.
    harness.wire.feed(
      turnCompleted(2, 0, { toolCalls: [readCall("studio.get_context", {}, "call_ctx")] }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.wire.posts).toHaveLength(3));
    expect(harness.bridgeCalls.queries.filter((q) => q === "project.summary")).toHaveLength(
      summaryBefore + 1,
    );
    const transcript = harness.wire.posts[2]?.body.messages as Array<Record<string, unknown>>;
    expect(transcript).toEqual([
      { role: "user", text: "tell me about the comp" },
      { role: "tool_call", toolCallId: "call_ctx", tool: "studio.get_context", args: {} },
      expect.objectContaining({ role: "tool_result", toolCallId: "call_ctx" }),
    ]);

    // …and the final turn ends the run with the banner cleared.
    harness.wire.feed(runStarted(0), turnCompleted(1, 1, { assistantText: "Resumed." }));
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
    expect(screen.queryByTestId("chat-banner")).toBeNull();
    expect(screen.getAllByTestId("chat-message")[1]?.textContent).toContain("Resumed.");
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — TURN_PAUSED park + recovery (the §8.4 role, turn edition)
  // -------------------------------------------------------------------------

  it("TURN_PAUSED: the parked run shows the §8.4 banner, and the banner's Retry re-POSTs the SAME step (same turn key + resume cursor) to completion", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "flaky network please" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const key = harness.wire.posts[0]?.turnKey;

    harness.wire.feed(runStarted(0), delta(1, "Partial"));

    // The transport's bounded retries exhausted: onError TURN_PAUSED + parked.
    harness.wire.pauseTurn();
    await waitFor(() => expect(harness.getApi().snapshot.error?.code).toBe("TURN_PAUSED"));
    expect(harness.getApi().snapshot.phase).toBe("failed");
    expect(screen.getByTestId("chat-banner").textContent).toContain(
      "Run paused. Check your connection.",
    );
    expect(screen.getByTestId("chat-banner-action").textContent).toBe("Retry");

    // The banner's Retry resumes the SAME step: another POST, SAME turn key,
    // the paused attempt's cursor riding replayCursor (the transcript is
    // UNCHANGED — the turn never settled, so nothing re-sends).
    await user.click(screen.getByTestId("chat-banner-action"));
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("reconnecting"));
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const resumed = harness.wire.posts[1];
    expect(resumed?.turnKey).toBe(key);
    expect(resumed?.stepIndex).toBe(0);
    expect(resumed?.replayCursor).toBe(1); // frames 0–1 were already folded
    expect(resumed?.body.messages).toEqual([{ role: "user", text: "flaky network please" }]);
    expect(resumed?.body.model).toBe("studio-fast");

    // The resumed server replays seq 0–1 (dropped ≤ cursor), then the tail.
    harness.wire.feed(runStarted(0), delta(1, "Partial"));
    harness.wire.feed(
      delta(2, " answer."),
      turnCompleted(3, 0, { assistantText: "Partial answer." }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));

    expect(screen.queryByTestId("chat-banner")).toBeNull();
    const assistant = screen.getAllByTestId("chat-message")[1];
    expect(assistant?.textContent).toContain("Partial answer.");
    expect((assistant?.textContent ?? "").split("Partial answer.")).toHaveLength(2);
    expect(harness.wire.posts).toHaveLength(2); // the SAME run completed — never a fresh one
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — §8.3 stop: local cancel + server-side abandon
  // -------------------------------------------------------------------------

  it("stop: the composer's Stop aborts the in-flight turn, folds cancelled locally, and fire-and-forget POSTs /v1/runs/:id/abandon once", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    await user.type(composerBox(), "long running thing{Enter}");
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const runId = harness.wire.posts[0]?.runId;

    harness.wire.feed(runStarted(0), delta(1, "Working"));
    expect(screen.getByLabelText("Stop streaming")).toBeInTheDocument();

    // §8.3: the local phase settles at once; the in-flight POST aborts; the
    // run is abandoned server-side (holds refunded) — fire-and-forget, once.
    await user.click(screen.getByLabelText("Stop streaming"));
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("cancelled"));
    expect(harness.wire.active().aborted).toBe(true);
    expect(harness.wire.abandons).toEqual([runId]);
    expect(screen.getByLabelText("Send")).toBeInTheDocument(); // composer released

    // A second stop gesture is a no-op — never a second abandon POST.
    const abandonCount = harness.wire.abandons.length;
    act(() => {
      harness.getApi().stop();
    });
    expect(harness.wire.abandons).toHaveLength(abandonCount);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — the read-only embed (M4.6): proposals accumulate, the plan card
// mounts WITHOUT any apply surface, nothing ever executes
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — read-only guarantees (M4.6, round 12)", () => {
  it("read-only embed: a write-tool proposal accumulates (never executes), the merged carrier POSTs to /v1/runs/:id/plan, and the folded plan card mounts with NO Apply control", async () => {
    const { harness } = await mountSeeded(); // NO applyPorts ⇒ no ApplyController
    const runIdPlaceholder = "run_response";
    harness.wire.planResponses.push({
      runId: runIdPlaceholder,
      plan: {
        intent: "edit",
        summary: "Set 1 property on 1 layer",
        risk: "low",
        requiresApproval: false,
        affectedLayers: [{ name: "Headline", change: "Text → New headline" }],
        estimatedCredits: 1,
        steps: [
          {
            title: "Set 1 property on 1 layer",
            tool: "studio.set_properties",
            args: {},
            batch: {
              label: "Agent: retitle the headline",
              steps: [{ command: "prop.set", params: {} }],
            },
          },
        ],
      },
      autoApply: { mode: "propose", reason: "manual review" },
      compiledBatch: {
        label: "Agent: retitle the headline",
        atomic: true,
        steps: [
          {
            command: "prop.set",
            params: { layer: 1, path: "text/sourceText", value: "New headline" },
          },
        ],
      },
      risk: "low",
      estimatedCredits: 2.25,
      baseVersionId: "ver_base_1",
    });
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "make the headline pop" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));

    // Step 0: the model PROPOSES the write tool — the carrier rides the
    // terminal; the client NEVER executes it during the run.
    const proposal = writeProposal("studio.set_properties", SET_PROPERTIES_ARGS, "call_write");
    harness.wire.feed(
      runStarted(0),
      toolStarted(1, "call_write", "studio.set_properties", SET_PROPERTIES_ARGS),
      turnCompleted(2, 0, { assistantText: "I would change the text.", toolCalls: [proposal] }),
    );
    harness.wire.finishTurn();

    // The next turn's transcript echoes the PROPOSE-ONLY resultForModel —
    // never a local execution of the write tool.
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const transcript = harness.wire.posts[1]?.body.messages as Array<Record<string, unknown>>;
    expect(transcript[3]).toEqual({
      role: "tool_result",
      toolCallId: "call_write",
      tool: "studio.set_properties",
      result: proposal.resultForModel,
    });

    // Step 1: NO toolCalls ⇒ run end → mergeEditPlans → POST /v1/runs/:id/plan.
    harness.wire.feed(runStarted(0), turnCompleted(1, 1, { assistantText: "Here is my plan." }));
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.wire.planPosts).toHaveLength(1));
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));

    // The merged carrier the client POSTed (mergeEditPlans over the carriers).
    const submitted = harness.wire.planPosts[0];
    expect(submitted?.runId).toBe(harness.wire.posts[0]?.runId);
    expect(submitted?.plan.summary).toBe("Set 1 property on 1 layer");
    expect(submitted?.plan.intent).toBe("edit");
    expect(submitted?.plan.steps).toHaveLength(1);
    const carrierStep = submitted?.plan.steps[0] as {
      batch: { steps: Array<Record<string, unknown>> };
    };
    expect(carrierStep.batch.steps[0]).toEqual({
      command: "set_properties",
      params: SET_PROPERTIES_ARGS,
    });

    // The plan-card fold (the submitPlan response → a first-class plan event):
    // the server's risk/credits ride the card, but with NO apply engine wired
    // there is NO Apply control anywhere (M4.6 read-only property).
    const card = screen.getByTestId("plan-card");
    expect(card.dataset.status).toBe("proposed");
    expect(card.dataset.applied).toBe("false");
    expect(card.dataset.risk).toBe("low");
    expect(screen.getByTestId("plan-risk").textContent).toBe("Low risk");
    expect(screen.getByTestId("plan-intent").textContent).toBe("Edit");
    const steps = within(screen.getByTestId("plan-steps")).getAllByRole("listitem");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.textContent).toContain("Set 1 property on 1 layer");
    expect(screen.getByTestId("plan-credits").textContent).toBe("≈ 2.25 credits");
    expect(within(screen.getByTestId("plan-actions")).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^apply/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^cancel/i })).toBeNull();

    // Server-side-tool proof: the proposal never touched the engine.
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);
    expect(harness.bridgeCalls.renderFrames).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — a non-client tool never executes (the executor's refusal)
  // -------------------------------------------------------------------------

  it("non-client tool refusal: the wired executor throws ClientToolError TOOL_FORBIDDEN with ZERO bridge traffic, and a hostile proposal-less write call in the loop echoes the typed refusal without executing", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);

    // THE EXECUTOR SEAM (exactly the deps the provider wires per run): a
    // write tool is refused by the executor itself — the typed ClientToolError
    // the round-12 contract pins — with ZERO bridge calls.
    const executor = createClientToolExecutor({
      bridge: harness.bridge,
      client: harness.wire.client,
      workspaceId: "ws_test",
      threadId: THREAD_ID,
      runId: "run_refusal_probe",
      flags: DEFAULT_FLAGS,
    });
    expect(executor.handles("studio.set_properties")).toBe(false); // never a client tool
    const refusal = await executor.execute("studio.set_properties", SET_PROPERTIES_ARGS).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isClientToolError(refusal)).toBe(true);
    expect(refusal).toMatchObject({
      code: "TOOL_FORBIDDEN",
      message: "Write tools are proposal-only; the plan card applies them.",
    });
    // The RAW engine surface is refused BY NAME (law #5/#6 backstop).
    const rawRefusal = await executor.execute("engine.batch", { steps: [] }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isClientToolError(rawRefusal)).toBe(true);
    expect(rawRefusal).toMatchObject({ code: "TOOL_FORBIDDEN" });
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);

    // THE LOOP: a hostile server emits the write tool WITHOUT its proposal
    // carrier — the loop's handles() gate answers the typed refusal (the
    // executor-level TOOL_FORBIDDEN is shadowed by the gate, honestly), the
    // run CONTINUES, and nothing ever executes.
    act(() => {
      harness.getApi().send({ message: "set the opacity to zero" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const queriesBefore = harness.bridgeCalls.queries.length;
    harness.wire.feed(
      runStarted(0),
      turnCompleted(1, 0, {
        toolCalls: [
          {
            toolCallId: "call_write",
            tool: "studio.set_properties",
            args: SET_PROPERTIES_ARGS,
            resultForModel: null,
            proposal: null,
          },
        ],
      }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const transcript = harness.wire.posts[1]?.body.messages as Array<Record<string, unknown>>;
    expect(transcript[2]).toEqual({
      role: "tool_result",
      toolCallId: "call_write",
      tool: "studio.set_properties",
      result: {
        error: "CLIENT_TOOL_UNAVAILABLE",
        message: '"studio.set_properties" cannot run in this session.',
      },
    });
    expect(harness.bridgeCalls.queries).toHaveLength(queriesBefore); // ZERO new bridge reads
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);

    // The model recovers and the run completes.
    harness.wire.feed(
      runStarted(0),
      turnCompleted(1, 1, {
        assistantText: "I cannot edit in this session — apply a plan instead.",
      }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
    expect(screen.getAllByTestId("chat-message")[1]?.textContent).toContain("apply a plan instead");
  });

  it("echoes a degraded studio.plan_edit verdict — never a local refusal (w8 fix)", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);

    // THE WIRE: the gateway settled plan_edit SERVER-side, but its plan
    // compile degraded — the turn.completed entry carries no proposal, only
    // the gateway's verdict in resultForModel. The loop must echo THAT (the
    // model's real next-turn tool_result), never attempt a local run:
    // plan_edit is not a client tool, and the old fall-through surfaced the
    // misleading '"studio.plan_edit" cannot run in this session' chip while
    // feeding the model a false CLIENT_TOOL_UNAVAILABLE failure (w8 fix).
    act(() => {
      harness.getApi().send({ message: "plan a bigger change" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const queriesBefore = harness.bridgeCalls.queries.length;
    const verdict = {
      error: "PLAN_INVALID",
      message: "The plan could not be generated.",
    };
    harness.wire.feed(
      runStarted(0),
      turnCompleted(1, 0, {
        toolCalls: [
          {
            toolCallId: "call_plan_degraded",
            tool: "studio.plan_edit",
            args: { goal: "make it pop" },
            resultForModel: verdict,
            proposal: null,
          },
        ],
      }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const transcript = harness.wire.posts[1]?.body.messages as Array<Record<string, unknown>>;
    expect(transcript[2]).toEqual({
      role: "tool_result",
      toolCallId: "call_plan_degraded",
      tool: "studio.plan_edit",
      result: verdict,
    });
    // ZERO new bridge activity: a server-settled tool never touches the editor.
    expect(harness.bridgeCalls.queries).toHaveLength(queriesBefore);
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);

    // The model recovers and the run completes.
    harness.wire.feed(
      runStarted(0),
      turnCompleted(1, 1, {
        assistantText: "The plan draft failed — tell me the goal in one line and I'll retry.",
      }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
  });

  it("echoes the gateway's INVALID_TOOL_CALL verdict for a rejected write call — never a local refusal", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);

    // THE REAL WIRE (user-reported '!"studio.create_text" cannot run in this
    // session'): the model proposed create_text with args the strict schema
    // rejects (an empty `text`). The gateway settles the call SERVER-side —
    // INVALID_TOOL_CALL, no compiled proposal — and the loop must echo THAT
    // verdict: it is the chip's real error and the model's repair signal. The
    // old fall-through executed it locally, surfaced the misleading
    // '"studio.create_text" cannot run in this session' chip, fed the model a
    // FALSE CLIENT_TOOL_UNAVAILABLE, and the repetition guard then killed the
    // run. (The fixture once also carried `opacity` as an UNRECOGNIZED key —
    // the signature of the stale-bundle regression the runtime fix shipped;
    // `opacity` is a legal, even string-repairable, key since the bundle was
    // rebuilt, so the fixture keeps only the still-invalid empty text.)
    act(() => {
      harness.getApi().send({ message: "add a background text layer" });
    });
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
    const queriesBefore = harness.bridgeCalls.queries.length;
    const verdict = {
      error: "INVALID_TOOL_CALL",
      message:
        "Invalid arguments for studio.create_text: text: Too small: expected string to have >=1 characters",
    };
    harness.wire.feed(
      runStarted(0),
      toolStarted(1, "call_text_invalid", "studio.create_text", {
        text: "",
        name: "Background Void",
        position: [1920, 1080],
        size: 1,
      }),
      turnCompleted(2, 0, {
        toolCalls: [
          {
            toolCallId: "call_text_invalid",
            tool: "studio.create_text",
            args: { text: "", name: "Background Void", position: [1920, 1080], size: 1 },
            resultForModel: verdict,
            proposal: null,
          },
        ],
      }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const transcript = harness.wire.posts[1]?.body.messages as Array<Record<string, unknown>>;
    expect(transcript[2]).toEqual({
      role: "tool_result",
      toolCallId: "call_text_invalid",
      tool: "studio.create_text",
      result: verdict,
    });
    // The chip settles FAILED with the gateway's REAL message — the user
    // sees WHY the write was refused, never "cannot run in this session".
    const card = screen.getByTestId("tool-card");
    expect(card.dataset.status).toBe("failed");
    expect(card.dataset.tool).toBe("studio.create_text");
    expect(screen.getByTestId("tool-card-summary").textContent).toContain("Invalid arguments");
    expect(screen.getByTestId("tool-card-summary").textContent).not.toContain(
      "cannot run in this session",
    );
    // ZERO new bridge activity: a server-settled write never touches the editor.
    expect(harness.bridgeCalls.queries).toHaveLength(queriesBefore);
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);
    // No plan card: an uncompiled call contributes NO proposal to apply.
    expect(screen.queryByTestId("plan-card")).not.toBeInTheDocument();

    // The model repairs the args (the verdict told it exactly what broke)
    // and the run completes.
    harness.wire.feed(
      runStarted(0),
      turnCompleted(4, 1, {
        assistantText: "Let me fix the layer text and try again.",
      }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — the §3.4 steer part through the real composer
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — steer queue (§3.4, turn edition)", () => {
  it("a composer send while the run is live renders immediately and rides the NEXT turn POST as a steer part — never a second run", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);

    await user.type(composerBox(), "first{Enter}");
    await waitFor(() => expect(harness.wire.posts).toHaveLength(1));

    harness.wire.feed(runStarted(0), delta(1, "Working"));
    expect(screen.getByLabelText("Stop streaming")).toBeInTheDocument();

    // The composer stays live while the run streams (§3.4): Enter STEERS.
    await user.type(composerBox(), "second thought{Enter}");

    // The user message renders at once; the wire is untouched.
    const messages = screen.getAllByTestId("chat-message");
    expect(messages).toHaveLength(3);
    expect(messages[2]?.dataset.role).toBe("user");
    expect(messages[2]?.textContent).toContain("second thought");
    expect(harness.wire.posts).toHaveLength(1);

    // The step-0 turn completes WITH a tool call ⇒ the loop POSTs step 1 and
    // the queued send rides it as a `steer` part of the transcript.
    harness.wire.feed(
      turnCompleted(2, 0, { toolCalls: [readCall("studio.get_context", {}, "call_ctx")] }),
    );
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
    const transcript = harness.wire.posts[1]?.body.messages as Array<Record<string, unknown>>;
    expect(transcript).toEqual([
      { role: "user", text: "first" },
      { role: "tool_call", toolCallId: "call_ctx", tool: "studio.get_context", args: {} },
      expect.objectContaining({ role: "tool_result", toolCallId: "call_ctx" }),
      { role: "steer", text: "second thought" },
    ]);

    // The steered run settles; the steer NEVER spawns its own POST/run.
    harness.wire.feed(runStarted(0), turnCompleted(1, 1, { assistantText: "Steered — noted." }));
    harness.wire.finishTurn();
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
    expect(harness.wire.posts).toHaveLength(2);
    expect(screen.getAllByTestId("chat-message")[2]?.dataset.role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// M5-Q — the WIRED apply journey (BUILD_PLAN §M5.4/§M5.5; DECISIONS D-21/D-22)
//
// The REAL mounted thread end-to-end, round-12 edition: ChatProvider (with
// applyPorts → the REAL createApplyController over the REAL fake bridge +
// scripted autosave/api ports) → ChatPanelSlot → ChatThread → ChatMessageView
// → the M5-G PlanCard + M5-H PlanPreview. The run itself is the REAL
// client-driven loop: a write-tool PROPOSAL turn → the final turn → the client
// merges the carriers (mergeEditPlans) → POST /v1/runs/:id/plan → the
// response's authoritative compiled batch + §7.3 verdict fold as the plan
// card. Fakes remain ONLY the wire + the ports; every gesture flows through
// the real controller, the real run-state folds and the real apply engine.
// ---------------------------------------------------------------------------

/** The version head the plan was proposed against (D-21 → the plan response). */
const BASE_VERSION_ID = "ver_base_1";

/** The D-6 apply save reason pinned by apply.ts. */
const AGENT_APPLY_REASON = "agent-apply";

/** The server's authoritative display plan for the retitle carrier. */
const RETITLE_DISPLAY_PLAN: EditPlan = {
  intent: "edit",
  summary: "Set 1 property on 1 layer",
  risk: "low",
  requiresApproval: false,
  affectedLayers: [{ id: 1, name: "Headline", change: "Text → New headline" }],
  estimatedCredits: 12, // the MODEL's lie — the server's 2.25 wins on the card
  steps: [
    {
      title: "Set the text to New headline",
      tool: "studio.set_properties",
      args: {},
      batch: { label: "Agent: retitle the headline", steps: [{ command: "prop.set", params: {} }] },
    },
  ],
};

/**
 * The gateway's authoritative /v1/runs/:id/plan response: it re-compiles the
 * merged carrier server-side and stamps the §7.3 verdict (D-21/D-22). The
 * compiled batch is either the pinned `$request:` placeholder (the compiler's
 * real output — the CLIENT resolves by name at apply) or the concrete id 1.
 */
function retitlePlanResponse(options: {
  readonly risk?: "low" | "medium" | "high";
  readonly withResolution?: boolean;
  readonly autoApply?: { readonly mode: "auto" | "propose"; readonly reason: string };
}): Record<string, unknown> {
  const layerParam: string | number = options.withResolution === true ? "$request:req_head" : 1;
  return {
    runId: "run_response",
    plan: RETITLE_DISPLAY_PLAN,
    autoApply: options.autoApply ?? { mode: "propose", reason: "manual review" },
    compiledBatch: {
      label: "Agent: retitle the headline",
      atomic: true,
      steps: [
        {
          command: "prop.set",
          params: { layer: layerParam, path: "text/sourceText", value: "New headline" },
        },
      ],
    },
    ...(options.withResolution === true
      ? {
          resolutionRequests: [
            { requestId: "req_head", layerName: "Headline", disambiguation: [] },
          ],
        }
      : {}),
    risk: options.risk ?? "low",
    estimatedCredits: 2.25, // server-recomputed — beats the plan's 12 on the card
    baseVersionId: BASE_VERSION_ID,
  };
}

/** The scripted apply-session ports: recorded saveNow reasons, flippable outcome. */
function makeApplyPorts(config: { readonly currentVersionId?: string | null } = {}) {
  const saves: string[] = [];
  let saveCount = 0;
  let failSaves = 0;
  const sessionState = { current: config.currentVersionId ?? null };
  const ports: ChatApplyPorts = {
    autosave: {
      saveNow: async (reason: string): Promise<SaveOutcome> => {
        saves.push(reason);
        if (failSaves > 0) {
          failSaves -= 1;
          return { saved: false };
        }
        saveCount += 1;
        return {
          saved: true,
          version: {
            id: `ver_apply_${saveCount}`,
            label: null,
            sha256: "0".repeat(64),
            sizeBytes: 8,
          },
        };
      },
      markDirty: (reason?: string) => saves.push(`markDirty:${reason ?? "unnamed"}`),
    },
    session: { currentVersionId: () => sessionState.current },
  };
  return {
    ports,
    saves,
    sessionState,
    failNextSave: (): void => {
      failSaves += 1;
    },
  };
}

/**
 * Sends + streams one full WRITE-PROPOSAL run through the REAL client-driven
 * loop to the settled (phase "done") thread: proposal turn → final turn →
 * merged-carrier plan POST → the scripted response folds the plan card.
 */
async function streamSettledProposalRun(
  harness: Harness,
  response: Record<string, unknown>,
): Promise<void> {
  harness.wire.planResponses.push(response);
  await waitFor(() => expect(harness.getApi().models).not.toBeNull());
  act(() => {
    harness.getApi().send({ message: "retitle the headline" });
  });
  await waitFor(() => expect(harness.wire.posts).toHaveLength(1));
  // Step 0: the model PROPOSES the write tool (a carrier, never executed).
  harness.wire.feed(
    runStarted(0),
    toolStarted(1, "call_write", "studio.set_properties", SET_PROPERTIES_ARGS),
    turnCompleted(2, 0, {
      assistantText: "Let me retitle that.",
      toolCalls: [writeProposal("studio.set_properties", SET_PROPERTIES_ARGS, "call_write")],
    }),
  );
  harness.wire.finishTurn();
  await waitFor(() => expect(harness.wire.posts).toHaveLength(2));
  // Step 1: NO toolCalls ⇒ run end → mergeEditPlans → POST /v1/runs/:id/plan.
  harness.wire.feed(runStarted(0), turnCompleted(1, 1, { assistantText: "Here is the plan." }));
  harness.wire.finishTurn();
  await waitFor(() => expect(harness.wire.planPosts).toHaveLength(1));
  await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
}

describe("M5-Q web chat integration — the wired apply journey (client-driven loop)", () => {
  it('apply happy path: settled card → Apply → ONE engine.batch → saveNow("agent-apply") → applyRun → applied', async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(harness, retitlePlanResponse({ withResolution: true }));

    // Mid-run gate proof (the run just settled): the card is proposed with
    // the FULL M5 surface — the SERVER's credits VERBATIM (2.25, never the
    // plan's 12), the server's risk, the Apply/Cancel pair.
    const card = screen.getByTestId("plan-card");
    expect(card.dataset.status).toBe("proposed");
    expect(card.dataset.risk).toBe("low");
    expect(screen.getByTestId("plan-credits").textContent).toBe("≈ 2.25 credits");
    const apply = screen.getByTestId("plan-apply");
    expect(apply).toBeEnabled();
    expect(screen.getByTestId("plan-cancel")).toBeInTheDocument();

    // The M5-H preview mounted (low risk) — and HONESTLY failed: the probe
    // batch carries the raw `$request:` token, so the engine refused it before
    // the user confirmed anything (probe = engine.batch + rollback only).
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("failed"),
    );

    // Click Apply → resolve (comp.info) → ONE engine.batch → saveNow → applyRun.
    await user.click(apply);
    await waitFor(() => expect(card.dataset.status).toBe("applied"));
    expect(screen.getByTestId("plan-applied").textContent).toContain(
      "Applied — Version ver_apply_1 · one undo step.",
    );
    expect(screen.getByTestId("plan-undo")).toBeInTheDocument();

    // Engine discipline: the apply gesture executed engine.batch EXACTLY
    // once (the failed preview probe rode bridge.batch — the §8.5 entry point
    // preview.ts uses — and rolled back, never touching executes).
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(1);
    expect(harness.bridgeCalls.batches).toBe(1); // the probe (rejected: raw $request token)
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "edit.undo")).toHaveLength(0);
    expect(ports.saves).toEqual([
      "markDirty:agent-apply", // the belt-and-braces dirty flag (D-6)
      AGENT_APPLY_REASON, // the D-6 apply moment
    ]);

    // The exact applyRun report (M5-E wire): patched sha, the UPLOADED version
    // id, a gesture key, and the name→id resolutions — layerId STRINGIFIED
    // (the provider's cross-seam adapter: apply.ts pins numbers, the wire IDs).
    expect(harness.wire.applyRuns).toHaveLength(1);
    const posted = harness.wire.applyRuns[0];
    expect(posted?.runId).toBe(harness.wire.posts[0]?.runId);
    expect(typeof posted?.body.idempotencyKey).toBe("string");
    expect((posted?.body.idempotencyKey as string).length ?? 0).toBeGreaterThanOrEqual(8);
    expect(posted?.body.versionId).toBe("ver_apply_1");
    expect(posted?.body.batchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(posted?.body.resolvedLayers).toEqual([{ requestId: "req_head", layerId: "1" }]);
    expect(harness.wire.undoRuns).toHaveLength(0);
  });

  it("cancel: the proposed card's Cancel dismisses it (status cancelled) and nothing ever executes", async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(harness, retitlePlanResponse({ withResolution: true }));
    // Wait the probe out (nothing user-visible depends on it).
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("failed"),
    );

    await user.click(screen.getByTestId("plan-cancel"));
    const card = screen.getByTestId("plan-card");
    expect(card.dataset.status).toBe("cancelled");
    expect(screen.getByTestId("plan-cancelled").textContent).toContain(
      "Plan cancelled — nothing was applied.",
    );
    // Nothing user-driven executed: the probe was REJECTED before any engine
    // mutation (raw $request token), and the gesture never ran.
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(0);
    expect(harness.wire.applyRuns).toHaveLength(0);
    expect(ports.saves).toEqual([]);
  });

  it("conflict 409: the card renders the conflict copy (re-apply blocked), never re-drives", async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(harness, retitlePlanResponse({ withResolution: true }));
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("failed"),
    );
    harness.wire.applyFailures.push({
      status: 409,
      code: "VERSION_CONFLICT",
      message: "This run's plan was already applied.",
    });

    await user.click(screen.getByTestId("plan-apply"));
    const card = screen.getByTestId("plan-card");
    await waitFor(() => expect(card.dataset.status).toBe("conflict"));
    expect(screen.getByTestId("plan-conflict").textContent).toContain(
      "Apply was rejected — the project moved on while this plan was waiting.",
    );
    expect(screen.getByTestId("plan-conflict-detail").textContent).toContain(
      // apply.ts's OWN 409 copy — the client explains, it never echoes the
      // server's raw message at the card.
      "This plan was already applied or the run changed on the server. Nothing was re-executed.",
    );
    expect(within(screen.getByTestId("plan-actions")).queryAllByRole("button")).toHaveLength(0);
    // Exactly ONE report POST — no client auto-retry, no re-execution.
    expect(harness.wire.applyRuns).toHaveLength(0); // the fake REJECTS — nothing recorded
    expect(harness.wire.applyFailures).toHaveLength(0); // the scripted failure was consumed
    expect(ports.saves).toEqual(["markDirty:agent-apply", AGENT_APPLY_REASON]);
  });

  it("ambiguous resolution: candidates render, the pick re-drives the apply bound to the chosen id (ONE batch executes)", async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness, fake } = await mountSeeded({
      applyPorts: ports.ports,
      twinNames: true, // the hostile duplicate-name project
    });
    await streamSettledProposalRun(harness, retitlePlanResponse({ withResolution: true }));
    // The preview probe fails (the raw $request token) — wait it out.
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("failed"),
    );

    // Apply → resolution sees TWO "Headline" layers → typed ambiguous,
    // NOTHING executed (zero engine.batch), the candidates render as picks.
    await user.click(screen.getByTestId("plan-apply"));
    const card = screen.getByTestId("plan-card");
    await waitFor(() => expect(card.dataset.status).toBe("ambiguous-resolution"));
    expect(screen.getByTestId("plan-ambiguous").textContent).toContain(
      "a layer name matches more than one layer",
    );
    const resolution = screen.getByTestId("plan-resolution");
    expect(resolution.textContent).toContain("Headline");
    const candidates = screen.getAllByTestId("plan-candidate");
    // The engine's comp order is not part of the contract — assert the SET.
    expect(candidates.map((entry) => entry.textContent).sort()).toEqual([
      "Headline (layer 1)",
      "Headline (layer 2)",
    ]);
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(0);
    expect(harness.wire.applyRuns).toHaveLength(0);

    // The pick re-drives the apply: the chosen id is PRE-PATCHED into the
    // batch (it rides the batch, not the wire — no resolvedLayers) and the
    // engine executed the batch exactly ONCE (the probe never mutated).
    const pick = candidates.find((entry) => entry.textContent === "Headline (layer 2)");
    expect(pick).toBeDefined();
    await user.click(pick as HTMLElement);
    await waitFor(() => expect(card.dataset.status).toBe("applied"));
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(1);
    expect(harness.wire.applyRuns).toHaveLength(1);
    const posted = harness.wire.applyRuns[0];
    expect(posted?.body.resolvedLayers).toBeUndefined(); // the pick replaced the request
    expect(posted?.body.versionId).toBe("ver_apply_1");
    expect(posted?.body.batchSha256).toMatch(/^[0-9a-f]{64}$/);
    // The engine proves the pick: the CHOSEN twin (id 2) carries the edit; the
    // other twin (id 1) is untouched.
    const pickedText = (await fake.execute("prop.get", {
      layer: 2,
      path: "text/sourceText",
    })) as { value: unknown };
    expect(pickedText.value).toBe("New headline");
    const otherText = (await fake.execute("prop.get", {
      layer: 1,
      path: "text/sourceText",
    })) as { value: unknown };
    expect(otherText.value).toBe("Headline");
  });

  it("undo → undone; re-apply ENABLED while the session still sits on the plan's base version (no drift)", async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(harness, retitlePlanResponse({ withResolution: true }));
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("failed"),
    );

    // Apply → applied.
    await user.click(screen.getByTestId("plan-apply"));
    const card = screen.getByTestId("plan-card");
    await waitFor(() => expect(card.dataset.status).toBe("applied"));

    // Undo: ONE edit.undo + undoRun → the card flips undone, Re-apply ENABLED.
    await user.click(screen.getByTestId("plan-undo"));
    await waitFor(() => expect(card.dataset.status).toBe("undone"));
    expect(screen.getByTestId("plan-undone").textContent).toContain(
      "Undone — the batch reverted; the version stays in history.",
    );
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "edit.undo")).toHaveLength(1);
    expect(harness.wire.undoRuns).toHaveLength(1);
    expect(harness.wire.undoRuns[0]?.runId).toBe(harness.wire.posts[0]?.runId);
    const reapply = screen.getByTestId("plan-reapply");
    expect(reapply).toBeEnabled(); // sessionVersionId === baseVersionId (not drifted)
    expect(screen.queryByTestId("plan-reapply-blocked")).toBeNull();

    // Re-apply re-drives the FULL gesture: a fresh key, the same content sha.
    await user.click(reapply);
    await waitFor(() => expect(card.dataset.status).toBe("applied"));
    expect(harness.wire.applyRuns).toHaveLength(2);
    expect(harness.wire.applyRuns[1]?.body.versionId).toBe("ver_apply_2");
    expect(harness.wire.applyRuns[1]?.body.idempotencyKey).not.toBe(
      harness.wire.applyRuns[0]?.body.idempotencyKey,
    );
    expect(harness.wire.applyRuns[1]?.body.batchSha256).toBe(
      harness.wire.applyRuns[0]?.body.batchSha256,
    );
  });

  it("re-apply is BLOCKED with the §M5.5 explanation when the session moved past the plan's base version (drifted)", async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: "ver_drifted_9" });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(harness, retitlePlanResponse({ withResolution: true }));
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("failed"),
    );

    await user.click(screen.getByTestId("plan-apply"));
    const card = screen.getByTestId("plan-card");
    await waitFor(() => expect(card.dataset.status).toBe("applied"));
    await user.click(screen.getByTestId("plan-undo"));
    await waitFor(() => expect(card.dataset.status).toBe("undone"));

    const reapply = screen.getByTestId("plan-reapply");
    expect(reapply).toBeDisabled();
    expect(screen.getByTestId("plan-reapply-blocked").textContent).toContain(
      "Re-apply is blocked — the project moved on since this run was undone.",
    );

    // A hostile click on the disabled control can never fire (toBeDisabled);
    // nothing re-executed and no report left the client.
    expect(harness.wire.applyRuns).toHaveLength(1);
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(1);
  });

  it("high risk: the checkbox gates Apply, the confirm dialog double-gates it (Escape keeps proposed), and NO preview probes the engine", async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(
      harness,
      retitlePlanResponse({ risk: "high", withResolution: true }),
    );

    const card = screen.getByTestId("plan-card");
    expect(card.dataset.risk).toBe("high");
    expect(screen.getByTestId("plan-requires-confirmation").textContent).toContain(
      "High risk — requires confirmation",
    );
    // The high-risk card NEVER probes: no preview slot (probing executes the
    // batch + undo — nothing runs before the user confirms).
    expect(screen.queryByTestId("plan-preview")).toBeNull();
    expect(screen.queryByTestId("plan-preview-panel")).toBeNull();

    const checkbox = screen.getByTestId("plan-confirm-checkbox");
    const apply = screen.getByTestId("plan-apply");
    expect(apply).toBeDisabled();
    await user.click(checkbox);
    expect(apply).toBeEnabled();

    // First gate pass → the confirm dialog; Escape cancels WITHOUT applying.
    await user.click(apply);
    const dialog = screen.getByTestId("chat-confirm-dialog");
    expect(screen.getByTestId("chat-confirm-title").textContent).toContain(
      "Apply this high-risk plan?",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("chat-confirm-dialog")).toBeNull());
    expect(card.dataset.status).toBe("proposed");
    expect(harness.bridgeCalls.executes).toEqual([]);

    // Confirmed apply: the dialog's Confirm fires the ONE atomic batch.
    await user.click(apply);
    await user.click(screen.getByTestId("chat-confirm-confirm"));
    await waitFor(() => expect(card.dataset.status).toBe("applied"));
    const batches = harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch");
    expect(batches).toHaveLength(1); // no probe for high risk — exactly the apply
    expect(harness.wire.applyRuns).toHaveLength(1);
    expect(screen.getByTestId("plan-applied").textContent).toContain("· one undo step.");
  });

  it("preview (M5-H): a low-risk plan WITHOUT name placeholders mounts the before/after frames (probe → render → undo)", async () => {
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness, fake } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(harness, retitlePlanResponse({})); // concrete layer id

    // The probe: ONE engine.batch (applied momentarily) + ONE render + ONE
    // edit.undo restoring the state — nothing stays applied (§8.5 atomicity).
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("ready"),
    );
    expect(screen.getByTestId("plan-preview-frames")).toBeInTheDocument();
    expect(screen.getByTestId("plan-preview-before-img")).toBeInTheDocument();
    expect(screen.getByTestId("plan-preview-after-img")).toBeInTheDocument();
    expect(screen.getByTestId("plan-preview-note").textContent).toContain(
      "The after frame is a temporary preview — nothing is applied until you choose Apply.",
    );
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(0); // the apply has not run yet
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "edit.undo")).toHaveLength(1);
    expect(harness.bridgeCalls.batches).toBe(1); // the probe (bridge.batch — §8.5 entry point)
    expect(harness.bridgeCalls.renderFrames).toBeGreaterThanOrEqual(2); // before + after

    // The probe left the engine state restored: the apply afterwards is the
    // only mutation, and the engine still holds ONE undoable step afterwards.
    const text = (await fake.execute("prop.get", {
      layer: 1,
      path: "text/sourceText",
    })) as { value: unknown };
    expect(text.value).toBe("Headline"); // probe restored
    const user = userEvent.setup();
    await user.click(screen.getByTestId("plan-apply"));
    await waitFor(() => expect(screen.getByTestId("plan-card").dataset.status).toBe("applied"));
    const applied = (await fake.execute("prop.get", {
      layer: 1,
      path: "text/sourceText",
    })) as { value: unknown };
    expect(applied.value).toBe("New headline");
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(1);
  });

  it("auto verdict pre-arm: an auto verdict with UNRESOLVED layer names pre-arms the LOW-risk card (hint + focused Apply) — the auto-drive defers to the user's pick and Apply is still the user's click", async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    // mode "auto" + an unresolved $request: the auto-drive guard refuses
    // (ambiguity needs the user's §8.7 pick) — the card stays proposed.
    await streamSettledProposalRun(
      harness,
      retitlePlanResponse({
        withResolution: true,
        autoApply: { mode: "auto", reason: "eligible" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("failed"),
    );

    // Armed: the hint renders and Apply carries the focus emphasis…
    expect(screen.getByTestId("plan-auto-armed").textContent).toContain(
      "Auto-apply is on — review the plan, then press Apply.",
    );
    const apply = screen.getByTestId("plan-apply");
    expect(document.activeElement).toBe(apply);

    // …but NOTHING executed from the verdict alone (the ambiguity guard):
    // no batch, no save, no report until the explicit click.
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(0);
    expect(ports.saves).toEqual([]);
    expect(harness.wire.applyRuns).toHaveLength(0);

    // The click is still the driver: the armed card applies like any other.
    await user.click(apply);
    await waitFor(() => expect(screen.getByTestId("plan-card").dataset.status).toBe("applied"));
    expect(harness.wire.applyRuns).toHaveLength(1);
  });

  it("auto-apply drive: a mode:auto verdict with NO unresolved names AUTO-DRIVES the apply at run end (once per run) — ONE batch, ONE save, ONE report, the card lands applied with Undo", async () => {
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    // The §7.3 verdict says auto + the compiled batch is concrete (no
    // $request tokens) → the round-10 v2 drive fires at the local
    // run.completed, BEFORE the card ever renders proposed (no probe).
    await streamSettledProposalRun(
      harness,
      retitlePlanResponse({ autoApply: { mode: "auto", reason: "low risk additive batch" } }),
    );

    // No click ever happened: the card drove itself to applied.
    const card = screen.getByTestId("plan-card");
    await waitFor(() => expect(card.dataset.status).toBe("applied"));
    expect(screen.getByTestId("plan-applied").textContent).toContain("· one undo step.");
    expect(screen.getByTestId("plan-undo")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-auto-armed")).toBeNull(); // never sat proposed

    // Exactly ONE gesture: one engine.batch (the apply), one saveNow pair,
    // one report — and NO probe (the runtime went straight to applying).
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch")).toHaveLength(1);
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "edit.undo")).toHaveLength(0);
    expect(harness.bridgeCalls.batches).toBe(0); // the preview probe never mounted
    expect(harness.bridgeCalls.renderFrames).toBe(0);
    expect(ports.saves).toEqual(["markDirty:agent-apply", AGENT_APPLY_REASON]);
    expect(harness.wire.applyRuns).toHaveLength(1);
    expect(harness.wire.applyRuns[0]?.runId).toBe(harness.wire.posts[0]?.runId);
    expect(harness.wire.applyRuns[0]?.body.versionId).toBe("ver_apply_1");
    expect(harness.wire.undoRuns).toHaveLength(0);

    // The engine holds the edit: one undo step reverts it (Undo's escape hatch).
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("done"));
  });

  it('F-L3 save-failed: the card shows the honest "in the editor only" copy and Retry save NEVER re-executes the batch (F-L1)', async () => {
    const user = userEvent.setup();
    const ports = makeApplyPorts({ currentVersionId: BASE_VERSION_ID });
    const { harness } = await mountSeeded({ applyPorts: ports.ports });
    await streamSettledProposalRun(harness, retitlePlanResponse({})); // concrete id → clean probe
    await waitFor(() =>
      expect(screen.getByTestId("plan-preview-panel").dataset.status).toBe("ready"),
    );

    // Script the FIRST saveNow to fail — the batch executed, the version did
    // not upload, the gateway was never told (apply.ts's honest ordering).
    ports.failNextSave();
    await user.click(screen.getByTestId("plan-apply"));
    const card = screen.getByTestId("plan-card");
    await waitFor(() => expect(card.dataset.status).toBe("failed"));
    // F-L3: the controller's HONEST copy renders verbatim — never the generic
    // "nothing changed" alone.
    expect(screen.getByTestId("plan-failed-detail").textContent).toContain(
      "The edit was applied but could not be saved as a version.",
    );
    expect(harness.wire.applyRuns).toHaveLength(0); // no applyRun without a version
    // The probe (bridge.batch) + the one executed apply — split across the two
    // bridge entry points, so each count is EXACTLY one here.
    const executedApplyBatches = harness.bridgeCalls.executes.filter(
      (cmd) => cmd === "engine.batch",
    ).length;
    expect(executedApplyBatches).toBe(1);
    expect(harness.bridgeCalls.batches).toBe(1);

    // The card's Try-again is wired to the re-save-only seam: engine.batch is
    // NEVER re-executed (F-L1's doubling hazard is structurally impossible).
    await user.click(screen.getByTestId("plan-retry"));
    await waitFor(() => expect(card.dataset.status).toBe("applied"));
    expect(harness.bridgeCalls.executes.filter((cmd) => cmd === "engine.batch").length).toBe(
      executedApplyBatches,
    ); // UNCHANGED — the batch never re-ran
    expect(harness.bridgeCalls.batches).toBe(1); // the probe never re-ran either
    expect(ports.saves.filter((entry) => entry === AGENT_APPLY_REASON).length).toBe(2); // re-saved
    expect(harness.wire.applyRuns).toHaveLength(1);
    expect(harness.wire.applyRuns[0]?.body.versionId).toBe("ver_apply_1");
    // F-L2 retention: the retry reuses the SAME gesture idempotency key.
    expect(typeof harness.wire.applyRuns[0]?.body.idempotencyKey).toBe("string");
  });
});
