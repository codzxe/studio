/**
 * M4-L — the WEB full-loop integration test (docs/phases/M4-SEAMS.md Seam 7
 * "Integration"; BUILD_PLAN §M4 exit criteria "Context chips accurately
 * reflect what is sent" + "Read-only agent answers questions about the open
 * comp/selection/playhead"; EDITOR_CHAT_UX §3.4/§5.3/§8.4).
 *
 * This is the ONE suite that composes the REAL browser-side M4 stack and
 * fakes ONLY the wire:
 *
 *   REAL ChatProvider (thread lazy-create, models, context orchestration,
 *        executor diff-wiring, send facade)
 *   REAL ChatPanelSlot (the composed panel: header + context strip/popover +
 *        thread + composer + footer over the provider's render-prop)
 *   REAL createChatController + foldEvent + createToolExecutor + context.ts
 *   REAL wave-2 components (ChatComposer emits, ChatThread/ToolCard/PlanCard
 *        render the loop's outputs, ContextStrip/Popover drive the flags)
 *   REAL @studio/editor-bridge fake (createFakeEditor seeded with a real
 *        "Main" comp + a real selected "Headline" text layer — get_context
 *        returns REAL editor data)
 *
 *   FAKED: the api-client surface ONLY (threads.create / models.list /
 *   chat.stream / runs.postEvent — the M4-C2 stub pattern). `chat.stream`
 *   records every §8.4 segment and hands back the controller's handler set so
 *   the tests can drive normalized §7.4 events by hand; the drop/pause helpers
 *   replay the documented sse.ts contract (same-idempotency-key re-POST +
 *   Last-Event-ID replay, pause after 3 attempts, fused cancel/resume).
 *
 * Scenario → test map (M4 evidence file):
 *   1 full read-agent loop   → "full read-agent loop: composer send …"
 *   2 context-flag accuracy → "popover removal drops the selection block …"
 *     (+ "chat POST body omits model when entitlements failed …")
 *   3 replay idempotence    → "replay idempotence: the same event list twice …"
 *   4 reconnect             → "reconnect: transport drop …"
 *   5 RUN_PAUSED            → "RUN_PAUSED: three failed attempts park …"
 *   6 plan card (M4.6)      → "plan card: a §7.4 plan event renders …"
 *   7 write tool forbidden  → "write tool refusal: studio.set_properties …"
 *   8 steer queue           → "steer queue: a composer send while streaming …"
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
import { type ChatContextApi, ChatProvider } from "@/lib/chat/provider";
import type { ApiClient } from "@studio/api-client";
import type { ChatRequest, EditPlan, StudioStreamEvent, Thread } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { type FakeEditor, attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The fake wire (the ONLY fake): an ApiClient stand-in that records segments
// ---------------------------------------------------------------------------

/** The §8.4 handler set the chat engine hands to `client.chat.stream` (sse.ts contract). */
interface WireHandlers {
  readonly onEvent?: (event: StudioStreamEvent) => void;
  readonly onError?: (error: { code: string; message: string; retryable: boolean }) => void;
  readonly onReconnect?: (info: {
    attempt: number;
    delayMs: number;
    lastEventId: string | null;
  }) => void;
  readonly onPause?: (info: { attempts: number }) => void;
  readonly onDone?: (summary: { reason: string; runId: string | null; status: string }) => void;
}

/** One POST to /v1/threads/:id/chat (the original send or a §8.4 same-key re-POST). */
interface WireSegment {
  readonly threadId: string;
  readonly body: ChatRequest;
  readonly handlers: WireHandlers;
  readonly paused: boolean;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly reconnect: ReturnType<typeof vi.fn>;
}

/** One POST to /v1/runs/:id/events (the client tool-executor's result). */
interface PostedEvent {
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

function makeWire(options: { readonly models?: "ok" | "fail" } = {}) {
  const segments: WireSegment[] = [];
  const postEvents: PostedEvent[] = [];

  const active = (): WireSegment => {
    const segment = segments[segments.length - 1];
    if (segment === undefined) throw new Error("no open stream segment");
    return segment;
  };

  const openSegment = (
    threadId: string,
    body: ChatRequest,
    handlers: WireHandlers,
  ): WireSegment => {
    const segment: WireSegment = {
      threadId,
      body,
      handlers,
      paused: false,
      cancel: vi.fn(async () => undefined),
      abort: vi.fn(),
      reconnect: vi.fn(async () => {
        openSegment(threadId, body, handlers); // sse.ts resume: same body re-POST
      }),
    };
    segments.push(segment);
    return segment;
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
    },
    models: {
      list: async () => {
        if (options.models === "fail") throw new Error("models endpoint down");
        return MODELS_OK;
      },
    },
    chat: {
      stream: (threadId: string, body: ChatRequest, handlers?: WireHandlers) =>
        openSegment(threadId, body, handlers ?? {}),
    },
    runs: {
      postEvent: async (
        runId: string,
        body: Record<string, unknown>,
        options?: { idempotencyKey?: string },
      ) => {
        postEvents.push({ runId, body, idempotencyKey: options?.idempotencyKey });
        return null;
      },
    },
  } as unknown as ApiClient;

  /** Feed normalized §7.4 events through the CURRENT segment (foldEvent runs for real). */
  const feed = (...events: StudioStreamEvent[]): void => {
    act(() => {
      for (const event of events) active().handlers.onEvent?.(event);
    });
  };

  /** The sse.ts terminal summary (fired AFTER the terminal event was folded). */
  const finishRun = (runId: string): void => {
    act(() => {
      active().handlers.onDone?.({ reason: "terminal", runId, status: "applied" });
    });
  };

  /** One transport drop: onReconnect → sse.ts re-POSTs the SAME body (a new segment). */
  const dropOnce = (): void => {
    const segment = active();
    act(() => {
      segment.handlers.onReconnect?.({ attempt: 1, delayMs: 1000, lastEventId: null });
      openSegment(segment.threadId, segment.body, segment.handlers);
    });
  };

  /** §8.4 exhaustion: 3 attempts (each onReconnect + same-key re-POST), then pause. */
  const dropToPause = (): void => {
    const segment = active();
    act(() => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        segment.handlers.onReconnect?.({ attempt, delayMs: 1000 * attempt, lastEventId: null });
        openSegment(segment.threadId, segment.body, segment.handlers);
      }
      segment.handlers.onPause?.({ attempts: 3 });
      segment.handlers.onDone?.({ reason: "paused", runId: null, status: "streaming" });
    });
  };

  return { client, segments, postEvents, active, feed, finishRun, dropOnce, dropToPause };
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

/** The deterministic project: comp "Main" + a selected text layer "Headline". */
async function makeFakeEditorWithSelection(): Promise<FakeEditor> {
  const fake = createFakeEditor({ comps: [{ name: "Main" }] });
  await fake.execute("layer.newText", { text: "Headline" });
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
  readonly bridgeCalls: BridgeCalls;
  readonly getApi: () => ChatContextApi;
}

// ---------------------------------------------------------------------------
// Seeded mount: ChatProvider + the REAL composed panel over a fake editor
// carrying a real comp + selection
// ---------------------------------------------------------------------------

async function mountSeeded(
  options: { readonly models?: "ok" | "fail" } = {},
): Promise<{ harness: Harness; fake: FakeEditor }> {
  const fake = await makeFakeEditorWithSelection();
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
    >
      {(current) => {
        api = current;
        return <ChatPanelSlot api={current} onSidebarDock={() => undefined} />;
      }}
    </ChatProvider>,
  );
  const harness: Harness = {
    wire,
    bridgeCalls: calls,
    getApi: () => {
      if (api === null) throw new Error("provider did not render");
      return api;
    },
  };
  return { harness, fake };
}

// ---------------------------------------------------------------------------
// Shared waits + fixtures
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
    for (let i = 0; i < 15 && harness.getApi().flags.selection === false; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });
  expect(harness.getApi().flags.selection).toBe(true);
}

/** A valid §8.6 plan (parses EDIT_PLAN_SCHEMA; same shape as the plan-card fixture). */
const PLAN_FIXTURE: EditPlan = {
  intent: "animate",
  summary: "Animate the headline scale with a springy overshoot",
  risk: "low",
  requiresApproval: true,
  affectedLayers: [
    { name: "Headline", change: "Keyframe Scale" },
    { name: "Subhead", change: "Delay 0.2s" },
  ],
  estimatedCredits: 12,
  steps: [
    {
      title: "Keyframe Scale 20% → 110% → 100%",
      tool: "studio.plan_edit",
      args: {},
      batch: { label: "Agent: animate headline", steps: [{ command: "prop.set", params: {} }] },
    },
    {
      title: "Add overshoot at 0.45s",
      tool: "studio.plan_edit",
      args: {},
      batch: { label: "Agent: overshoot", steps: [{ command: "prop.set", params: {} }] },
    },
  ],
};

const AUTO_ON_FLAGS = { ...DEFAULT_FLAGS, selection: true, selectedProperties: true };

beforeEach(() => {
  // The chat shell persists its layout under this key (D-10); every test
  // starts from the DEFAULT floating panel.
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
});

// ---------------------------------------------------------------------------
// Scenario 1 — the flagship full read-agent loop
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — full read-agent loop (flagship)", () => {
  it("composer send → SSE run → executor queries the bridge → gated tool.result POST → final answer + tool card + credits render", async () => {
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

    // The wire POST: the exact CHAT_REQUEST body (strictObject shape).
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));
    const body = harness.wire.segments[0]?.body;
    expect(body?.message).toBe("What's on this comp?");
    expect(body?.context).toEqual(AUTO_ON_FLAGS); // chips mirror what is sent
    expect(body?.model).toBe("studio-fast"); // the entitlement default
    expect(body?.pinned).toEqual([]);
    expect(typeof body?.idempotencyKey).toBe("string");
    expect(body?.idempotencyKey.length ?? 0).toBeGreaterThanOrEqual(8);

    // run.started → the assistant placeholder ("Thinking…") with the caret.
    harness.wire.feed({ type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" });
    expect(screen.getByTestId("chat-thinking")).toBeInTheDocument();
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop streaming")).toBeInTheDocument();

    // tool.started → the running card; the REAL executor runs against the
    // REAL fake bridge (count only THIS call's queries — the provider's own
    // context collects also query project.summary by design).
    const summaryBefore = harness.bridgeCalls.queries.filter((q) => q === "project.summary").length;
    harness.wire.feed({
      type: "tool.started",
      runId: "run_1",
      seq: 2,
      toolCallId: "call_ctx",
      name: "studio.get_context",
      args: {},
    });
    await waitFor(() => expect(screen.getByTestId("tool-card").dataset.status).toBe("running"));

    // The executor POSTs the tool result — exact RUN_EVENT wire shape.
    await waitFor(() => expect(harness.wire.postEvents).toHaveLength(1));
    const posted = harness.wire.postEvents[0];
    expect(posted?.runId).toBe("run_1");
    expect(posted?.idempotencyKey).toBe("toolresult:run_1:call_ctx");
    expect(Object.keys(posted?.body ?? {}).sort()).toEqual(["result", "toolCallId", "type"]);
    expect(posted?.body.type).toBe("tool.result");
    expect(posted?.body.toolCallId).toBe("call_ctx");

    // The result carries the REAL fake-editor state, gated by DEFAULT+auto flags.
    const result = posted?.body.result as {
      activeComp: { name: string; layers: Array<{ id: number; name: string; type: string }> };
      focusedPanel: string;
      playhead: { timeSeconds: number; playing: boolean };
      projectSummary: {
        activeComp: number;
        selectedLayers: number[];
        items: Array<{ name: string }>;
      };
      recentCommands: unknown;
      selectedProperties: {
        layerId: number;
        properties: Record<string, { value: unknown }>;
      };
      selection: { layerIds: number[]; tree: { name: string } | null };
    };
    expect(Object.keys(result).sort()).toEqual([
      "activeComp",
      "focusedPanel",
      "playhead",
      "projectSummary",
      "recentCommands",
      "selectedProperties",
      "selection",
    ]);
    expect(result.projectSummary.activeComp).toBe(1);
    expect(result.projectSummary.items[0]?.name).toBe("Main");
    expect(result.projectSummary.selectedLayers).toEqual([1]);
    expect(result.activeComp.name).toBe("Main");
    expect(result.activeComp.layers[0]).toMatchObject({ id: 1, name: "Headline", type: "text" });
    expect(result.selection.layerIds).toEqual([1]);
    expect(result.selection.tree).toMatchObject({ name: "Headline" });
    expect(result.playhead).toEqual({ timeSeconds: 0, playing: false });
    expect(result.focusedPanel).toBe("Viewer");
    expect(result.selectedProperties.layerId).toBe(1);
    expect(result.selectedProperties.properties["text/sourceText"]).toMatchObject({
      value: "Headline",
    });
    expect(result.selectedProperties.properties["transform/position"]).toMatchObject({
      value: [960, 540, 0],
    });
    expect(result.recentCommands).toBe("removed by user"); // DEFAULT-off flag

    // Read-only proof: the executor queried project.summary EXACTLY once for
    // this tool call, never mutated, and covered the real read surface.
    expect(
      harness.bridgeCalls.queries.filter((q) => q === "project.summary").length - summaryBefore,
    ).toBe(1);
    expect(harness.bridgeCalls.queries).toEqual(
      expect.arrayContaining(["comp.info", "layer.tree", "prop.get"]),
    );
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);

    // The server echoes the tool result → the card flips done.
    harness.wire.feed({
      type: "tool.result",
      runId: "run_1",
      seq: 3,
      toolCallId: "call_ctx",
      result: posted?.body.result,
    });
    const card = screen.getByTestId("tool-card");
    expect(card.dataset.status).toBe("done");
    expect(card.dataset.tool).toBe("studio.get_context");
    expect(screen.getByText("Inspect project")).toBeInTheDocument();

    // The final assistant answer + credits + terminal.
    harness.wire.feed(
      { type: "message.delta", runId: "run_1", seq: 4, delta: "The comp **Main** holds one text" },
      { type: "message.delta", runId: "run_1", seq: 5, delta: " layer, Headline." },
      { type: "credits", runId: "run_1", seq: 6, reserved: 1, committed: 1, balance: 99 },
      { type: "run.completed", runId: "run_1", seq: 7 },
    );
    harness.wire.finishRun("run_1");

    // The thread renders the finished loop: user + assistant, card, credits.
    const messages = screen.getAllByTestId("chat-message");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.dataset.role).toBe("user");
    expect(messages[1]?.dataset.role).toBe("assistant");
    expect(messages[1]?.textContent).toContain("The comp");
    expect(messages[1]?.textContent).toContain("text layer, Headline.");
    expect(screen.getByTestId("chat-credits").textContent).toBe("1 credits used · balance 99");
    expect(screen.queryByTestId("chat-caret")).toBeNull();
    expect(screen.queryByTestId("chat-banner")).toBeNull();
    expect(screen.queryByTestId("chat-thinking")).toBeNull();
    expect(screen.getByLabelText("Send")).toBeInTheDocument(); // composer released
    expect(harness.getApi().snapshot.phase).toBe("done");

    // The loop's data reaches the card's expandable detail surface.
    await user.click(screen.getByTestId("tool-card-toggle"));
    expect(screen.getByTestId("tool-card-result").textContent).toContain("Headline");
    expect(screen.getByTestId("tool-card-args").textContent).toContain("{}");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — context flags accuracy (popover removal → snapshot → wire)
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — context accuracy (chips mirror the wire)", () => {
  it("popover removal drops the selection block: absent from the snapshot + strip, and the next chat POST carries context.selection === false", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    await waitForInspectPoll(harness);

    // BEFORE: the auto selection context reaches the wire (send facade — the
    // exact path ChatComposer's onSend calls).
    act(() => {
      harness.getApi().send({ message: "what is selected?" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));
    expect(harness.wire.segments[0]?.body.context).toEqual(AUTO_ON_FLAGS);

    // Settle the first run so the next send is not steer-queued (§3.4).
    harness.wire.feed(
      { type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" },
      { type: "run.completed", runId: "run_1", seq: 2 },
    );
    harness.wire.finishRun("run_1");

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

    // The NEXT send carries the exact wire body with selection === false.
    act(() => {
      harness.getApi().send({ message: "and now?" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(2));
    const body = harness.wire.segments[1]?.body;
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "context",
      "idempotencyKey",
      "message",
      "model",
      "pinned",
    ]);
    expect(body?.message).toBe("and now?");
    expect(body?.context).toEqual({ ...DEFAULT_FLAGS, selectedProperties: true });
    expect(body?.pinned).toEqual([]);
    expect(body?.model).toBe("studio-fast");
    expect(typeof body?.idempotencyKey === "string").toBe(true);
    expect(body?.idempotencyKey.length ?? 0).toBeGreaterThanOrEqual(8);
  });

  it("chat POST body omits the model key entirely when the entitlement fetch failed", async () => {
    const { harness } = await mountSeeded({ models: "fail" });
    await waitFor(() => expect(harness.getApi().models).toEqual([])); // one retry, then []
    expect(harness.getApi().activeModelId).toBeNull();
    expect(screen.queryByTestId("chat-model-button")).toBeNull(); // picker hidden ([] contract)

    act(() => {
      harness.getApi().send({ message: "no models loaded" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));
    const body = harness.wire.segments[0]?.body;
    expect(body?.model).toBeUndefined(); // absent from the wire, not defaulted
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "context",
      "idempotencyKey",
      "message",
      "pinned",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — replay idempotence at the UI level
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — resilience (replay, reconnect, pause)", () => {
  it("replay idempotence: the same event list folded twice leaves ONE assistant message, ONE card, ONE execution", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "explain the project" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));

    const segment = harness.wire.active();
    const summaryBefore = harness.bridgeCalls.queries.filter((q) => q === "project.summary").length;
    const runStarted = {
      type: "run.started",
      runId: "run_1",
      seq: 1,
      model: "studio-fast",
    } as const satisfies StudioStreamEvent;
    const toolStarted = {
      type: "tool.started",
      runId: "run_1",
      seq: 2,
      toolCallId: "call_ctx",
      name: "studio.get_context",
      args: {},
    } as const satisfies StudioStreamEvent;
    act(() => {
      segment.handlers.onEvent?.(runStarted);
      segment.handlers.onEvent?.(toolStarted);
    });
    await waitFor(() => expect(harness.wire.postEvents).toHaveLength(1));
    expect(
      harness.bridgeCalls.queries.filter((q) => q === "project.summary").length - summaryBefore,
    ).toBe(1); // the executor's ONE query

    // Last-Event-ID replay: the server re-sends the whole segment from seq 1.
    act(() => {
      segment.handlers.onEvent?.(runStarted);
      segment.handlers.onEvent?.(toolStarted);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30)); // any re-run would land here
    });
    expect(
      harness.bridgeCalls.queries.filter((q) => q === "project.summary").length - summaryBefore,
    ).toBe(1); // NEVER re-executed
    expect(harness.wire.postEvents).toHaveLength(1);
    expect(screen.getAllByTestId("chat-message")).toHaveLength(2); // user + ONE assistant
    expect(screen.getAllByTestId("tool-card")).toHaveLength(1); // ONE card (upserted by id)

    // The tail still folds exactly once.
    harness.wire.feed(
      {
        type: "tool.result",
        runId: "run_1",
        seq: 3,
        toolCallId: "call_ctx",
        result: harness.wire.postEvents[0]?.body.result,
      },
      { type: "message.delta", runId: "run_1", seq: 4, delta: "Once." },
      { type: "run.completed", runId: "run_1", seq: 5 },
    );
    harness.wire.finishRun("run_1");

    const assistant = screen.getAllByTestId("chat-message")[1];
    const text = assistant?.textContent ?? "";
    expect(text.includes("Once.")).toBe(true);
    expect(text.split("Once.")).toHaveLength(2); // exactly once, never doubled
    expect(harness.getApi().snapshot.phase).toBe("done");
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — reconnect at the component level
  // -------------------------------------------------------------------------

  it("reconnect: a transport drop shows the Reconnecting… banner, re-POSTs the SAME body (same idempotencyKey), and the replay + tail complete the run", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "tell me about the comp" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));
    const firstBody = harness.wire.segments[0]?.body;

    harness.wire.feed(
      { type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" },
      {
        type: "tool.started",
        runId: "run_1",
        seq: 2,
        toolCallId: "call_ctx",
        name: "studio.get_context",
        args: {},
      },
    );
    await waitFor(() => expect(harness.wire.postEvents).toHaveLength(1));

    // Transport drop → §8.4 banner + the same-key re-POST (a new segment).
    harness.wire.dropOnce();
    expect(harness.getApi().snapshot.phase).toBe("reconnecting");
    expect(screen.getByTestId("chat-banner").textContent).toContain("Reconnecting…");
    expect(harness.wire.segments).toHaveLength(2);
    expect(harness.wire.segments[1]?.body).toEqual(firstBody); // SAME body, SAME key
    expect(harness.wire.segments[1]?.body.idempotencyKey).toBe(firstBody?.idempotencyKey);

    // The gateway replays seq 1–2 from its run log (dedupe: no re-execution)…
    const summaryQueries = harness.bridgeCalls.queries.filter(
      (q) => q === "project.summary",
    ).length;
    harness.wire.feed(
      { type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" },
      {
        type: "tool.started",
        runId: "run_1",
        seq: 2,
        toolCallId: "call_ctx",
        name: "studio.get_context",
        args: {},
      },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(harness.bridgeCalls.queries.filter((q) => q === "project.summary")).toHaveLength(
      summaryQueries,
    );
    expect(harness.wire.postEvents).toHaveLength(1);

    // …then the unseen tail completes the run.
    harness.wire.feed(
      {
        type: "tool.result",
        runId: "run_1",
        seq: 3,
        toolCallId: "call_ctx",
        result: harness.wire.postEvents[0]?.body.result,
      },
      { type: "message.delta", runId: "run_1", seq: 4, delta: "Resumed." },
      { type: "run.completed", runId: "run_1", seq: 5 },
    );
    harness.wire.finishRun("run_1");

    expect(screen.queryByTestId("chat-banner")).toBeNull();
    expect(harness.getApi().snapshot.phase).toBe("done");
    expect(screen.getAllByTestId("chat-message")[1]?.textContent).toContain("Resumed.");
    expect(screen.getByTestId("tool-card").dataset.status).toBe("done");
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — RUN_PAUSED park + recovery
  // -------------------------------------------------------------------------

  it("RUN_PAUSED: three failed attempts park the run with the RunPausedBanner, and the banner's Retry resumes the SAME run (same key) to completion", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "flaky network please" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));

    harness.wire.feed(
      { type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" },
      { type: "message.delta", runId: "run_1", seq: 2, delta: "Partial" },
    );

    // §8.4: 3 automatic attempts, all fail → park.
    harness.wire.dropToPause();
    expect(harness.getApi().snapshot.phase).toBe("failed");
    expect(harness.getApi().snapshot.error?.code).toBe("RUN_PAUSED");
    expect(screen.getByTestId("chat-banner-run-paused")).toBeInTheDocument();
    expect(screen.getByTestId("chat-banner").textContent).toContain(
      "Run paused. Check your connection.",
    );
    // The original POST + the 3 same-key re-POST attempts, one key throughout.
    expect(harness.wire.segments).toHaveLength(4);
    const key = harness.wire.segments[0]?.body.idempotencyKey;
    for (const segment of harness.wire.segments) {
      expect(segment.body.idempotencyKey).toBe(key);
    }

    // The banner's Retry resumes the SAME run: another same-key re-POST.
    await user.click(screen.getByTestId("chat-banner-action"));
    expect(screen.getByTestId("chat-banner-action").textContent).toBe("Retry");
    await waitFor(() => expect(harness.getApi().snapshot.phase).toBe("reconnecting"));
    expect(harness.wire.segments).toHaveLength(5);
    expect(harness.wire.segments[4]?.body.idempotencyKey).toBe(key);
    expect(harness.wire.segments[4]?.body.message).toBe("flaky network please");

    // The resumed tail completes the run; the banner clears with the terminal event.
    harness.wire.feed(
      { type: "message.delta", runId: "run_1", seq: 3, delta: " answer." },
      { type: "run.completed", runId: "run_1", seq: 4 },
    );
    harness.wire.finishRun("run_1");
    expect(screen.queryByTestId("chat-banner-run-paused")).toBeNull();
    expect(screen.queryByTestId("chat-banner")).toBeNull();
    expect(harness.getApi().snapshot.phase).toBe("done");
    expect(screen.getAllByTestId("chat-message")[1]?.textContent).toContain("Partial answer.");
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — the M4-informational plan card (M4.6 read-only proof)
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — read-only guarantees (M4.6)", () => {
  it("plan card: a §7.4 plan event renders the informational card (risk, steps, ≈credits, the M5 note) and NO Apply control exists anywhere", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "make the headline pop" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));

    harness.wire.feed(
      { type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" },
      { type: "plan", runId: "run_1", seq: 2, plan: PLAN_FIXTURE },
      { type: "run.completed", runId: "run_1", seq: 3 },
    );
    harness.wire.finishRun("run_1");

    const card = screen.getByTestId("plan-card");
    expect(card.dataset.applied).toBe("false");
    expect(card.dataset.risk).toBe("low");
    expect(screen.getByTestId("plan-risk").textContent).toBe("Low risk");
    expect(screen.getByTestId("plan-intent").textContent).toBe("Animate");
    const steps = within(screen.getByTestId("plan-steps")).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.textContent).toContain("Keyframe Scale 20% → 110% → 100%");
    expect(screen.getByTestId("plan-credits").textContent).toBe("≈ 12 credits");
    expect(screen.getByTestId("plan-note").textContent).toContain("Apply arrives with M5");

    // M4.6 read-only proof at the UI level: no apply/cancel control anywhere.
    expect(screen.queryByRole("button", { name: /^apply/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^cancel/i })).toBeNull();
    expect(screen.queryByTestId(/apply/i)).toBeNull();

    // Server-side tool: nothing ever dispatched to the client executor.
    expect(harness.wire.postEvents).toHaveLength(0);
    expect(harness.getApi().snapshot.phase).toBe("done");
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — a hypothetical write tool never executes
  // -------------------------------------------------------------------------

  it("write tool refusal: studio.set_properties posts TOOL_FORBIDDEN without touching the bridge, and the card renders failed", async () => {
    const { harness } = await mountSeeded();
    await waitForModels(harness);
    act(() => {
      harness.getApi().send({ message: "set the opacity to zero" });
    });
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));

    const queriesBefore = harness.bridgeCalls.queries.length;
    harness.wire.feed(
      { type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" },
      {
        type: "tool.started",
        runId: "run_1",
        seq: 2,
        toolCallId: "call_write",
        name: "studio.set_properties",
        args: { layerId: 1, properties: { "transform/opacity": 0 } },
      },
    );

    // The executor refuses and reports honestly — the exact §7.4 result shape.
    await waitFor(() => expect(harness.wire.postEvents).toHaveLength(1));
    const posted = harness.wire.postEvents[0];
    expect(posted?.body).toEqual({
      type: "tool.result",
      toolCallId: "call_write",
      result: { error: "TOOL_FORBIDDEN", message: "Write tools are not available yet." },
    });
    expect(posted?.idempotencyKey).toBe("toolresult:run_1:call_write");

    // Zero bridge traffic for the write call; zero mutation surfaces ever.
    expect(harness.bridgeCalls.queries).toHaveLength(queriesBefore);
    expect(harness.bridgeCalls.executes).toEqual([]);
    expect(harness.bridgeCalls.batches).toBe(0);
    expect(harness.bridgeCalls.renderFrames).toBe(0);

    // The echoed refusal fails the card; the run can still complete.
    harness.wire.feed(
      {
        type: "tool.result",
        runId: "run_1",
        seq: 3,
        toolCallId: "call_write",
        result: { error: "TOOL_FORBIDDEN", message: "Write tools are not available yet." },
      },
      {
        type: "message.delta",
        runId: "run_1",
        seq: 4,
        delta: "I can only read in this version — apply arrives with M5.",
      },
      { type: "run.completed", runId: "run_1", seq: 5 },
    );
    harness.wire.finishRun("run_1");

    const card = screen.getByTestId("tool-card");
    expect(card.dataset.status).toBe("failed");
    expect(card.dataset.tool).toBe("studio.set_properties");
    expect(screen.getByTestId("tool-card-summary").textContent).toContain(
      "Write tools are not available yet.",
    );
    expect(screen.getAllByTestId("chat-message")[1]?.textContent).toContain(
      "apply arrives with M5",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — the §3.4 steer queue through the real composer
// ---------------------------------------------------------------------------

describe("M4-L web chat integration — steer queue (§3.4)", () => {
  it("a composer send while streaming renders immediately, waits for the run to settle, then flushes as a second POST with a FRESH idempotency key", async () => {
    const user = userEvent.setup();
    const { harness } = await mountSeeded();
    await waitForModels(harness);

    await user.type(composerBox(), "first{Enter}");
    await waitFor(() => expect(harness.wire.segments).toHaveLength(1));

    harness.wire.feed(
      { type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" },
      { type: "message.delta", runId: "run_1", seq: 2, delta: "Working" },
    );
    expect(screen.getByLabelText("Stop streaming")).toBeInTheDocument();

    // The composer stays live while streaming (§3.4): Enter STEERS.
    await user.type(composerBox(), "second thought{Enter}");

    // The user message renders at once; the wire is untouched.
    const messages = screen.getAllByTestId("chat-message");
    expect(messages).toHaveLength(3);
    expect(messages[2]?.dataset.role).toBe("user");
    expect(messages[2]?.textContent).toContain("second thought");
    expect(harness.wire.segments).toHaveLength(1);

    // Terminal → the flush fires the queued send as its OWN run.
    harness.wire.feed({ type: "run.completed", runId: "run_1", seq: 3 });
    harness.wire.finishRun("run_1");

    expect(harness.wire.segments).toHaveLength(2);
    const first = harness.wire.segments[0]?.body;
    const second = harness.wire.segments[1]?.body;
    expect(second?.message).toBe("second thought");
    expect(harness.wire.segments[1]?.threadId).toBe(THREAD_ID); // same thread
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey); // §7.2 never re-uses a live key
    expect(first?.idempotencyKey.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(second?.idempotencyKey.length ?? 0).toBeGreaterThanOrEqual(8);

    // The second run streams into the same thread.
    harness.wire.feed({ type: "run.started", runId: "run_2", seq: 1, model: "studio-fast" });
    expect(screen.getAllByTestId("chat-message")).toHaveLength(4);
    expect(harness.getApi().snapshot.activeRunId).toBe("run_2");
    expect(screen.getAllByTestId("chat-message")[3]?.dataset.role).toBe("assistant");
  });
});
