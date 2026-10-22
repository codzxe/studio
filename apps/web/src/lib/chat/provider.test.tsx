/**
 * ChatProvider tests (M4-SEAMS.md Seam 7 "Integration (M4-J)") — the wiring
 * brain in isolation: NO wave-2 UI component is imported (peer-owned files may
 * land in any order; this suite stays independent of them).
 *
 * Deterministic, no network: a stub `ApiClient` (threads.create / models.list /
 * chat.stream / runs.postEvent — the M4-C2 stub pattern) + the real fake editor
 * bridge (`@studio/editor-bridge/fake`, wrapped to record queries) + the REAL
 * tool executor wrapped by a module mock that records dispatches while keeping
 * real execution (so the plan_edit skip + postEvent wiring are exercised
 * end-to-end).
 */

import type { ApiClient } from "@studio/api-client";
import type { ChatRequest, ContextSelection, Thread } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import {
  type FakeEditor,
  attachFakeBridge,
  createFakeEditor,
} from "@studio/editor-bridge/fake";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatShortcutBus, createChatShortcutBus } from "@/components/editor-host/chat-shortcut-bus";
import type { ClientToolCall } from "@/lib/chat/tool-executor";
import { type ChatContextApi, ChatProvider } from "./provider";

// ---------------------------------------------------------------------------
// Tool-executor seam: wrap the REAL executor (dispatches recorded, execution
// still happens) so the wiring tests observe the diff → execute hand-off.
// ---------------------------------------------------------------------------

const executorRecorder = vi.hoisted(() => ({
  deps: [] as Array<{ flags: ContextSelection }>,
  calls: [] as ClientToolCall[],
}));

vi.mock("@/lib/chat/tool-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/tool-executor")>();
  return {
    ...actual,
    createToolExecutor: (deps: { flags: ContextSelection }) => {
      executorRecorder.deps.push(deps);
      const execute = actual.createToolExecutor(deps);
      return (call: ClientToolCall): Promise<void> => {
        executorRecorder.calls.push(call);
        return execute(call);
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Harness: stub api-client + recorded fake bridge
// ---------------------------------------------------------------------------

type ThreadMode = "auto" | "manual" | "reject-once";

interface HarnessOptions {
  /** "auto" resolves creation on the next microtask; "manual" waits for resolveCreate(); "reject-once" fails the first create. */
  readonly threadMode?: ThreadMode;
  /** "fail" makes every models.list attempt reject (entitlement failure → []). */
  readonly models?: "ok" | "fail";
}

interface RecordedStreamCall {
  readonly threadId: string;
  readonly body: ChatRequest;
  readonly handlers: {
    onEvent?: (event: unknown) => void;
    onError?: (error: unknown) => void;
    onDone?: (summary: unknown) => void;
  };
  readonly cancel: ReturnType<typeof vi.fn>;
}

interface Harness {
  readonly api: () => ChatContextApi;
  readonly createThreadCalls: () => number;
  readonly resolveCreateThread: () => void;
  readonly modelsListCalls: () => number;
  readonly streamCalls: RecordedStreamCall[];
  readonly postEvents: Array<{ runId: string; body: Record<string, unknown> }>;
  readonly bridgeCalls: { inspect: number; queries: string[] };
  readonly bus: ChatShortcutBus;
}

const THREAD_IDS = ["thr_1", "thr_2"];

function makeThread(id: string): Thread {
  return {
    id,
    projectId: "prj_test",
    title: null,
    createdBy: "usr_1",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
}

const FAST_MODEL = {
  id: "studio-fast",
  tier: "fast" as const,
  use: "Cheap planning, classification, quick edits",
  creditsPer1kInput: 0.01,
  creditsPer1kOutput: 0.03,
};

const MODELS_OK = { plan: "trial", models: [FAST_MODEL] };

function makeHarness(options: HarnessOptions = {}): Harness {
  const threadMode: ThreadMode = options.threadMode ?? "auto";
  const modelsFail = options.models === "fail";

  let createCalls = 0;
  let rejectedOnce = false;
  const manualResolvers: Array<(thread: Thread) => void> = [];
  const streamCalls: RecordedStreamCall[] = [];
  const postEvents: Array<{ runId: string; body: Record<string, unknown> }> = [];
  let modelsCalls = 0;

  const client = {
    threads: {
      create: (_projectId: string) => {
        createCalls += 1;
        const thread = makeThread(THREAD_IDS[createCalls - 1] ?? "thr_x");
        if (threadMode === "manual") {
          return new Promise<Thread>((resolve) => {
            manualResolvers.push(resolve);
          });
        }
        if (threadMode === "reject-once" && !rejectedOnce) {
          rejectedOnce = true;
          return Promise.reject(new Error("threads are unavailable right now"));
        }
        return Promise.resolve(thread);
      },
    },
    models: {
      list: () => {
        modelsCalls += 1;
        if (modelsFail) return Promise.reject(new Error("models endpoint down"));
        return Promise.resolve(MODELS_OK);
      },
    },
    chat: {
      stream: (threadId: string, body: ChatRequest, handlers: RecordedStreamCall["handlers"]) => {
        const call: RecordedStreamCall = {
          threadId,
          body,
          handlers,
          cancel: vi.fn(async () => undefined),
        };
        streamCalls.push(call);
        return {
          paused: false,
          cancel: call.cancel,
          abort: () => undefined,
          reconnect: vi.fn(async () => undefined),
        };
      },
    },
    runs: {
      postEvent: async (runId: string, body: Record<string, unknown>) => {
        postEvents.push({ runId, body });
        return null;
      },
    },
  } as unknown as ApiClient;

  // Recorded fake bridge (M4-C2's recordBridge pattern, trimmed to the calls
  // the provider makes: inspect + query).
  const fake: FakeEditor = createFakeEditor({ version: "0.13.0" });
  const bridgeCalls = { inspect: 0, queries: [] as string[] };
  const inner = attachFakeBridge(fake);
  const bridge: EditorBridge = {
    ...inner,
    inspect: async () => {
      bridgeCalls.inspect += 1;
      return inner.inspect();
    },
    query: ((command: string, params?: unknown) => {
      bridgeCalls.queries.push(command);
      return inner.query(command, params);
    }) as EditorBridge["query"],
  };

  const bus: ChatShortcutBus = createChatShortcutBus();

  let captured: ChatContextApi | null = null;
  render(
    <ChatProvider
      client={client}
      bridge={bridge}
      workspaceId="ws_test"
      projectId="prj_test"
      shortcutBus={bus}
    >
      {(api) => {
        captured = api;
        return <div data-testid="provider-probe" data-chat-phase={api.snapshot.phase} />;
      }}
    </ChatProvider>,
  );

  return {
    api: () => {
      if (captured === null) throw new Error("provider did not render");
      return captured;
    },
    createThreadCalls: () => createCalls,
    resolveCreateThread: () => {
      const resolve = manualResolvers.shift();
      if (resolve === undefined) throw new Error("no pending threads.create to resolve");
      resolve(makeThread(THREAD_IDS[createCalls - 1] ?? "thr_x"));
    },
    modelsListCalls: () => modelsCalls,
    streamCalls,
    postEvents,
    bridgeCalls,
    bus,
  };
}

beforeEach(() => {
  executorRecorder.deps.length = 0;
  executorRecorder.calls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Models (entitlement surface — M4-A2's GET /v1/models)
// ---------------------------------------------------------------------------

describe("ChatProvider — models", () => {
  it("loads the plan's models and defaults the active model to the first entry", async () => {
    const harness = makeHarness();
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });
    expect(api.models).toEqual([FAST_MODEL]);
    expect(api.activeModelId).toBe("studio-fast");
    expect(harness.modelsListCalls()).toBe(1);

    // An explicit pick (the header picker) overrides the default.
    act(() => {
      api.setActiveModelId("studio-fast");
    });
    expect(api.activeModelId).toBe("studio-fast");
  });

  it("retries the models fetch once, then reports the failure as an empty list (picker hidden)", async () => {
    const harness = makeHarness({ models: "fail" });
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).toEqual([]);
    });
    expect(harness.modelsListCalls()).toBe(2); // exactly one retry
    expect(api.activeModelId).toBeNull(); // nothing to default to
  });
});

// ---------------------------------------------------------------------------
// Thread lifecycle (lazy create + promise queue)
// ---------------------------------------------------------------------------

describe("ChatProvider — lazy thread + send queue", () => {
  it("creates the thread on the FIRST send, queues the message until the id resolves, then streams once", async () => {
    const harness = makeHarness({ threadMode: "manual" });
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });

    act(() => {
      api.send({ message: "  Explain this comp  " });
    });

    // Queued: one create started, nothing streamed yet.
    expect(harness.createThreadCalls()).toBe(1);
    expect(harness.streamCalls).toHaveLength(0);

    await act(async () => {
      harness.resolveCreateThread();
    });

    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1);
    });
    const call = harness.streamCalls[0];
    expect(call?.threadId).toBe("thr_1");
    expect(call?.body.message).toBe("Explain this comp"); // trimmed
    expect(call?.body.context).toEqual(api.flags); // the §5.1 effective flags
    expect(call?.body.model).toBe("studio-fast"); // defaulted from models
    expect(typeof call?.body.idempotencyKey).toBe("string");

    // The user message rendered immediately (§3.4 send UX).
    await waitFor(() => {
      expect(api.snapshot.messages).toHaveLength(1);
    });
    expect(api.snapshot.messages[0]?.role).toBe("user");
    expect(api.snapshot.messages[0]?.text).toBe("Explain this comp");
    expect(api.threadId).toBe("thr_1");
    expect(api.threadTitle).toBe("Agent");
  });

  it("flushes queued sends in order: the first message streams, the second lands in the steer queue (§3.4)", async () => {
    const harness = makeHarness({ threadMode: "manual" });
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });

    act(() => {
      api.send({ message: "first" });
    });
    act(() => {
      api.send({ message: "second" });
    });
    expect(harness.createThreadCalls()).toBe(1); // ONE create for both

    await act(async () => {
      harness.resolveCreateThread();
    });

    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1); // only the first hits the wire
    });
    expect(harness.streamCalls[0]?.body.message).toBe("first");
    // Both user messages rendered; the second waits for the run to settle.
    await waitFor(() => {
      expect(api.snapshot.messages).toHaveLength(2);
    });
    expect(api.snapshot.messages.map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("reuses the thread for later sends (no second create); newThread() forces a fresh one", async () => {
    const harness = makeHarness();
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });

    act(() => {
      api.send({ message: "hello" });
    });
    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1);
    });
    expect(harness.createThreadCalls()).toBe(1);
    expect(api.threadId).toBe("thr_1");

    // newChat (⌘⇧L): the thread id is dropped, the transcript resets.
    act(() => {
      api.newThread();
    });
    expect(api.threadId).toBeNull();
    expect(api.controller).toBeNull();
    expect(api.snapshot.messages).toHaveLength(0);

    act(() => {
      api.send({ message: "fresh thread please" });
    });
    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(2);
    });
    expect(harness.createThreadCalls()).toBe(2);
    expect(harness.streamCalls[1]?.threadId).toBe("thr_2");
    expect(harness.streamCalls[1]?.body.message).toBe("fresh thread please");
  });

  it("surfaces a typed thread error when creation fails, drops the queue, and retries on the next send", async () => {
    const harness = makeHarness({ threadMode: "reject-once" });
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });

    act(() => {
      api.send({ message: "doomed" });
    });
    await waitFor(() => {
      expect(api.threadError).not.toBeNull();
    });
    expect(api.threadError?.code).toBe("THREAD_CREATE_FAILED");
    expect(api.threadError?.retryable).toBe(true);
    expect(harness.streamCalls).toHaveLength(0);

    // The failed queue is dropped — the next send starts over cleanly.
    act(() => {
      api.send({ message: "try again" });
    });
    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1);
    });
    expect(harness.createThreadCalls()).toBe(2);
    expect(harness.streamCalls[0]?.body.message).toBe("try again");
    await waitFor(() => {
      expect(api.threadError).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tool-executor wiring (snapshot diff → executor dispatch)
// ---------------------------------------------------------------------------

describe("ChatProvider — tool executor wiring", () => {
  it("diffs running tool cards, executes client tools with the right call, posts the result, and never re-runs replays; plan_edit dispatches but never posts", async () => {
    const harness = makeHarness();
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });
    act(() => {
      api.send({ message: "what is in this project?" });
    });
    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1);
    });

    const handlers = harness.streamCalls[0]?.handlers;
    expect(handlers?.onEvent).toBeDefined();
    act(() => {
      handlers?.onEvent({ type: "run.started", runId: "run_1", seq: 1, model: "studio-fast" });
    });
    await waitFor(() => {
      expect(api.snapshot.phase).toBe("streaming");
    });

    act(() => {
      handlers?.onEvent({
        type: "tool.started",
        runId: "run_1",
        seq: 2,
        toolCallId: "call_ctx",
        name: "studio.get_context",
        args: {},
      });
    });

    // The provider diff dispatched exactly this call to the executor.
    await waitFor(() => {
      expect(executorRecorder.calls.some((call) => call.toolCallId === "call_ctx")).toBe(true);
    });
    expect(executorRecorder.calls.find((call) => call.toolCallId === "call_ctx")).toEqual({
      runId: "run_1",
      toolCallId: "call_ctx",
      name: "studio.get_context",
      args: {},
    });

    // The REAL executor ran it against the bridge and posted the tool result.
    await waitFor(() => {
      expect(harness.postEvents).toHaveLength(1);
    });
    const posted = harness.postEvents[0];
    expect(posted?.runId).toBe("run_1");
    expect(posted?.body).toMatchObject({ type: "tool.result", toolCallId: "call_ctx" });
    expect(harness.bridgeCalls.queries).toContain("project.summary");

    // Server-side tool (studio.plan_edit): the diff still hands it to the
    // executor (pinned observation pattern), which SKIPS it — nothing extra
    // is posted (the runner owns plan_edit's result server-side).
    act(() => {
      handlers?.onEvent({
        type: "tool.started",
        runId: "run_1",
        seq: 3,
        toolCallId: "call_plan",
        name: "studio.plan_edit",
        args: { request: "move the title" },
      });
    });
    await waitFor(() => {
      expect(executorRecorder.calls.some((call) => call.toolCallId === "call_plan")).toBe(true);
    });
    expect(harness.postEvents).toHaveLength(1); // unchanged

    // Replaying the same tool.started (Last-Event-ID reconnect) never re-runs.
    act(() => {
      handlers?.onEvent({
        type: "tool.started",
        runId: "run_1",
        seq: 2,
        toolCallId: "call_ctx",
        name: "studio.get_context",
        args: {},
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executorRecorder.calls.filter((call) => call.toolCallId === "call_ctx")).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Context orchestration (flags, collects, pinned, visibility)
// ---------------------------------------------------------------------------

describe("ChatProvider — context orchestration", () => {
  it("collects the snapshot when the panel opens and re-collects on flag toggles", async () => {
    const harness = makeHarness();
    const api = harness.api();
    expect(api.context).toBeNull(); // nothing collected while hidden
    expect(api.panelVisible).toBe(false);

    act(() => {
      api.setPanelVisible(true);
    });
    await waitFor(() => {
      expect(api.context).not.toBeNull();
    });
    const initialKinds = (api.context?.blocks ?? []).map((block) => block.kind);
    expect(initialKinds).toContain("projectSummary");
    expect(initialKinds).toContain("activeComp");
    expect(initialKinds).not.toContain("recentCommands"); // default-off (§5.1)

    // User opts a block in (§5.3 popover toggle) → the snapshot re-collects.
    act(() => {
      api.setFlag("recentCommands", true);
    });
    await waitFor(() => {
      expect(
        (api.context?.blocks ?? []).some((block) => block.kind === "recentCommands"),
      ).toBe(true);
    });
    expect(harness.bridgeCalls.queries).toContain("edit.history.list");

    // ...and back off (removed auto-context STAYS removed, §3.2).
    act(() => {
      api.setFlag("recentCommands", false);
    });
    await waitFor(() => {
      expect(
        (api.context?.blocks ?? []).some((block) => block.kind === "recentCommands"),
      ).toBe(false);
    });

    // "Remove all" clears every currently-on block via overrides.
    act(() => {
      api.clearOptionalBlocks();
    });
    await waitFor(() => {
      expect(api.context?.blocks).toHaveLength(0);
    });
    expect(api.flags.projectSummary).toBe(false);
  });

  it("carries pinned chips into the snapshot and the wire body", async () => {
    const harness = makeHarness();
    const api = harness.api();
    act(() => {
      api.setPanelVisible(true);
    });
    await waitFor(() => {
      expect(api.context).not.toBeNull();
    });

    const chip = { kind: "frame" as const, label: "Frame at 00:03" };
    act(() => {
      api.addPinned(chip);
    });
    await waitFor(() => {
      expect(api.pinned).toEqual([chip]);
    });
    await waitFor(() => {
      expect(api.context?.pinned).toEqual([chip]);
    });
    expect(api.context?.totalTokenEstimate).toBeGreaterThan(0); // pinned chips count

    act(() => {
      api.send({ message: "use my pinned frame" });
    });
    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1);
    });
    expect(harness.streamCalls[0]?.body.pinned).toEqual([chip]);

    // Removing the chip clears it from the next snapshot.
    act(() => {
      api.removePinned(chip);
    });
    await waitFor(() => {
      expect(api.pinned).toHaveLength(0);
    });
  });

  it("polls ui.inspect at 1 Hz only while the panel is visible (§11)", async () => {
    const harness = makeHarness();
    const api = harness.api();
    await act(async () => {
      vi.useFakeTimers();
    });

    const beforeVisible = harness.bridgeCalls.inspect;
    act(() => {
      api.setPanelVisible(true);
    });
    // The on-open collect runs one inspect; then the 1 Hz ticks take over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    const afterVisible = harness.bridgeCalls.inspect;
    // 1 (open collect) + 2 (interval ticks at 1s and 2s) — the exact count.
    expect(afterVisible - beforeVisible).toBe(3);

    // Hidden: the interval is torn down; no further inspects.
    act(() => {
      api.setPanelVisible(false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(harness.bridgeCalls.inspect).toBe(afterVisible);
  });
});

// ---------------------------------------------------------------------------
// Quick actions + facades
// ---------------------------------------------------------------------------

describe("ChatProvider — quick actions + facades", () => {
  it("sends on the studio:chat-quick-action window CustomEvent through the same send path", async () => {
    const harness = makeHarness();
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("studio:chat-quick-action", { detail: "Render a preview" }),
      );
    });

    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1);
    });
    expect(harness.streamCalls[0]?.body.message).toBe("Render a preview");
    expect(harness.createThreadCalls()).toBe(1);

    // Empty/garbage details never dispatch.
    act(() => {
      window.dispatchEvent(new CustomEvent("studio:chat-quick-action", { detail: "   " }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.streamCalls).toHaveLength(1);
  });

  it("stop() routes through the live controller to the stream handle's fused cancel (§8.3)", async () => {
    const harness = makeHarness();
    const api = harness.api();
    await waitFor(() => {
      expect(api.models).not.toBeNull();
    });
    act(() => {
      api.send({ message: "stop me" });
    });
    await waitFor(() => {
      expect(harness.streamCalls).toHaveLength(1);
    });

    act(() => {
      api.stop();
    });
    await waitFor(() => {
      expect(harness.streamCalls[0]?.cancel).toHaveBeenCalled();
    });
    expect(api.snapshot.phase).toBe("cancelled");
  });

  it("useChatContextApi works inside the provider and throws outside it", async () => {
    const { useChatContextApi } = await import("./provider");

    const OutsideProbe = (): ReactElement => {
      let message = "";
      try {
        useChatContextApi();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return <div data-testid="outside-probe">{message}</div>;
    };
    render(<OutsideProbe />);
    expect(screen.getByTestId("outside-probe").textContent).toMatch(/ChatProvider/);
    cleanup();

    let phase = "";
    const InsideProbe = (): ReactElement => {
      const inner = useChatContextApi();
      phase = inner.snapshot.phase;
      return <div data-testid="inside-probe" />;
    };
    render(
      <ChatProvider
        client={{} as unknown as ApiClient}
        bridge={attachFakeBridge(createFakeEditor({ version: "0.13.0" }))}
        workspaceId="ws_test"
        projectId="prj_test"
        shortcutBus={createChatShortcutBus()}
      >
        {() => <InsideProbe />}
      </ChatProvider>,
    );
    expect(screen.getByTestId("inside-probe")).toBeInTheDocument();
    expect(phase).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Executor deps (live ContextSelection per flags change)
// ---------------------------------------------------------------------------

describe("ChatProvider — executor deps", () => {
  it("recreates the executor with the live flags when the user toggles a block", async () => {
    const harness = makeHarness();
    const api = harness.api();
    await waitFor(() => {
      expect(executorRecorder.deps).toHaveLength(1); // created once per mount
    });
    expect(executorRecorder.deps[0]?.flags.recentCommands).toBe(false);

    act(() => {
      api.setFlag("recentCommands", true);
    });
    await waitFor(() => {
      expect(executorRecorder.deps.length).toBeGreaterThanOrEqual(2);
    });
    expect(executorRecorder.deps[executorRecorder.deps.length - 1]?.flags.recentCommands).toBe(
      true,
    );
  });
});
