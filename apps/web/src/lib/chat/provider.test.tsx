/**
 * ChatProvider tests (M4-SEAMS.md Seam 7 "Integration (M4-J)") — the wiring
 * brain in isolation: NO wave-2 UI component is imported (peer-owned files may
 * land in any order; this suite stays independent of them).
 *
 * Deterministic, no network: a stub `ApiClient` (threads.create / models.list
 * / chat.turn / runs.submitPlan / runs.abandon — the M4-C2 stub pattern,
 * round-12 turn seam) + the real fake editor bridge
 * (`@studio/editor-bridge/fake`, wrapped to record queries) + the round-12
 * per-run tool-executor factory wrapped by a module mock that records the
 * deps the provider hands it (threadId, the client-generated runId, the
 * send-time flags) while keeping the controller's loop real.
 */

import {
  type ChatShortcutBus,
  createChatShortcutBus,
} from "@/components/editor-host/chat-shortcut-bus";
import type { ChatToolExecutorFactory } from "@/lib/chat/types";
import type { ApiClient } from "@studio/api-client";
import type { Thread, TurnCanvas } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { type FakeEditor, attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatContextApi, ChatProvider } from "./provider";

// ---------------------------------------------------------------------------
// Tool-executor seam: the module mock records the per-run DEPS the provider
// passes (i5's createClientToolExecutor takes threadId + the client-generated
// runId + the flags) and returns a recording double — the real executor has
// its own suite (tool-executor.test.ts); the loop that CONSUMES it is pinned
// in chat-controller.test.ts.
// ---------------------------------------------------------------------------

interface RecordedExecutorDeps {
  readonly threadId: string;
  readonly runId: string;
  readonly flags: Record<string, boolean>;
}

const executorRecorder = vi.hoisted(() => ({
  deps: [] as RecordedExecutorDeps[],
  calls: [] as Array<{ tool: string; args: unknown }>,
}));

vi.mock("@/lib/chat/tool-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/tool-executor")>();
  return {
    ...actual,
    createClientToolExecutor: (deps: {
      threadId: string;
      runId: string;
      flags: Record<string, boolean>;
    }) => {
      executorRecorder.deps.push({
        threadId: deps.threadId,
        runId: deps.runId,
        flags: { ...deps.flags },
      });
      return {
        handles: (tool: string) => tool === "studio.get_context",
        execute: async (tool: string, args: unknown) => {
          executorRecorder.calls.push({ tool, args });
          return { context: "recorded" };
        },
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Harness: stub api-client (turn seam) + recorded fake bridge
// ---------------------------------------------------------------------------

type ThreadMode = "auto" | "manual" | "reject-once";

/** What the harness turn stub emits: an immediate final answer, or a hang. */
type TurnMode = "final" | "hang";

interface HarnessOptions {
  /** "auto" resolves creation on the next microtask; "manual" waits for resolveCreate(); "reject-once" fails the first create. */
  readonly threadMode?: ThreadMode;
  /** "fail" makes every models.list attempt reject (entitlement failure → []). */
  readonly models?: "ok" | "fail";
  /** Overrides the models.list payload (the saved-default tests need two models). */
  readonly modelsResponse?: { plan: string; models: unknown[] };
  /** The turn stub's shape; default "final" (one turn, no tools, done). */
  readonly turnMode?: TurnMode;
}

interface RecordedTurnCall {
  readonly threadId: string;
  readonly body: {
    runId: string;
    stepIndex: number;
    messages: Array<Record<string, unknown>>;
    context?: unknown;
    pinned?: unknown;
    model?: unknown;
    canvas?: TurnCanvas | null;
  };
  readonly abort: ReturnType<typeof vi.fn>;
}

interface Harness {
  readonly api: () => ChatContextApi;
  readonly createThreadCalls: () => number;
  readonly resolveCreateThread: () => void;
  readonly modelsListCalls: () => number;
  readonly turnCalls: RecordedTurnCall[];
  readonly planPosts: Array<{ runId: string; plan: unknown }>;
  readonly abandons: string[];
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

const SMART_MODEL = {
  id: "studio-smart",
  tier: "smart" as const,
  use: "Heavy reasoning, complex multi-step plans",
  creditsPer1kInput: 0.4,
  creditsPer1kOutput: 1.2,
};

const MODELS_OK = { plan: "trial", models: [FAST_MODEL] };
const MODELS_FAST_SMART = { plan: "starter", models: [FAST_MODEL, SMART_MODEL] };

const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function makeHarness(options: HarnessOptions = {}): Harness {
  const threadMode: ThreadMode = options.threadMode ?? "auto";
  const modelsFail = options.models === "fail";
  const turnMode: TurnMode = options.turnMode ?? "final";

  let createCalls = 0;
  let rejectedOnce = false;
  const manualResolvers: Array<(thread: Thread) => void> = [];
  const turnCalls: RecordedTurnCall[] = [];
  const planPosts: Array<{ runId: string; plan: unknown }> = [];
  const abandons: string[] = [];
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
        return Promise.resolve(options.modelsResponse ?? MODELS_OK);
      },
    },
    chat: {
      // The turn seam: ONE bounded turn per POST. "final" streams a one-turn
      // run (run.started → turn.completed, no tool calls); "hang" parks after
      // run.started until abort() (the stop-path tests).
      turn: (
        threadId: string,
        body: RecordedTurnCall["body"],
        handlers: {
          onEvent?: (event: unknown) => void;
          onError?: (error: unknown) => void;
        },
      ) => {
        const call: RecordedTurnCall = {
          threadId,
          // The REAL transport JSON-serializes the body at POST time — record
          // a deep copy instead of aliasing the controller's LIVE transcript
          // (the loop appends assistant/steer parts to that same array after
          // the turn completes, which once made this record mutate mid-test).
          body: JSON.parse(JSON.stringify(body)) as RecordedTurnCall["body"],
          abort: vi.fn(),
        };
        turnCalls.push(call);
        const emit = async (): Promise<void> => {
          await tick();
          handlers.onEvent?.({
            type: "run.started",
            runId: body.runId,
            seq: (handlers as { seqBase?: number }).seqBase ?? 0,
          });
          if (turnMode === "hang") {
            await new Promise<void>(() => {
              // parked until abort() settles done below
            });
            return;
          }
          await tick();
          handlers.onEvent?.({
            type: "turn.completed",
            runId: body.runId,
            seq: ((handlers as { seqBase?: number }).seqBase ?? 0) + 1,
            stepIndex: body.stepIndex,
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 2 },
            credits: { committed: 1 },
            assistantText: "Done.",
            toolCalls: [],
          });
        };
        const done = emit().then(() => ({
          reason: "terminal",
          runId: body.runId,
          failure: null,
        }));
        return {
          done,
          runId: body.runId,
          get lastServerSeq() {
            return 1;
          },
          get paused() {
            return false;
          },
          abort: () => {
            call.abort();
          },
        };
      },
    },
    runs: {
      submitPlan: async (runId: string, requestBody: { plan: unknown }) => {
        planPosts.push({ runId, plan: requestBody.plan });
        return {
          runId,
          plan: requestBody.plan,
          autoApply: { mode: "propose", reason: "manual review" },
        };
      },
      abandon: async (runId: string) => {
        abandons.push(runId);
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
    turnCalls,
    planPosts,
    abandons,
    bridgeCalls,
    bus,
  };
}

/** The executor factory the provider hands the controller (type guard). */
function factoryOf(api: ChatContextApi): ChatToolExecutorFactory | undefined {
  return (api as unknown as { toolExecutor?: ChatToolExecutorFactory }).toolExecutor;
}

beforeEach(() => {
  executorRecorder.deps.length = 0;
  executorRecorder.calls.length = 0;
  window.localStorage.clear();
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
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });
    expect(harness.api().models).toEqual([FAST_MODEL]);
    expect(harness.api().activeModelId).toBe("studio-fast");
    expect(harness.modelsListCalls()).toBe(1);

    // An explicit pick (the header picker) overrides the default.
    act(() => {
      harness.api().setActiveModelId("studio-fast");
    });
    expect(harness.api().activeModelId).toBe("studio-fast");
  });

  it("retries the models fetch once, then reports the failure as an empty list (picker hidden)", async () => {
    const harness = makeHarness({ models: "fail" });
    await waitFor(() => {
      expect(harness.api().models).toEqual([]);
    });
    expect(harness.modelsListCalls()).toBe(2); // exactly one retry
    expect(harness.api().activeModelId).toBeNull(); // nothing to default to
  });

  it("adopts the Settings-saved default (studio.chat.model.v1) when it is on-plan", async () => {
    // W5-03: the §8.9 Models radio WRITES the seam; the provider READS it on
    // the first adoption — a saved on-plan default beats "first allowed".
    window.localStorage.setItem("studio.chat.model.v1", "studio-smart");
    const harness = makeHarness({ modelsResponse: MODELS_FAST_SMART });
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });
    expect(harness.api().activeModelId).toBe("studio-smart");
  });

  it("falls back to the first allowed model when the saved default is off-plan or absent", async () => {
    window.localStorage.setItem("studio.chat.model.v1", "studio-vision"); // D-8: never on a plan
    const offPlan = makeHarness({ modelsResponse: MODELS_FAST_SMART });
    await waitFor(() => {
      expect(offPlan.api().models).not.toBeNull();
    });
    expect(offPlan.api().activeModelId).toBe("studio-fast");

    window.localStorage.removeItem("studio.chat.model.v1");
    const absent = makeHarness({ modelsResponse: MODELS_FAST_SMART });
    await waitFor(() => {
      expect(absent.api().models).not.toBeNull();
    });
    expect(absent.api().activeModelId).toBe("studio-fast");
  });
});

// ---------------------------------------------------------------------------
// Thread lifecycle (lazy create + promise queue)
// ---------------------------------------------------------------------------

describe("ChatProvider — lazy thread + send queue", () => {
  it("creates the thread on the FIRST send, queues the message until the id resolves, then POSTs ONE turn", async () => {
    const harness = makeHarness({ threadMode: "manual" });
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });

    act(() => {
      harness.api().send({ message: "  Explain this comp  " });
    });

    // Queued: one create started, no turn POST yet (manual mode keeps the
    // thread id pending until resolveCreateThread).
    await waitFor(() => {
      expect(harness.createThreadCalls()).toBe(1);
    });
    expect(harness.turnCalls).toHaveLength(0);

    await act(async () => {
      harness.resolveCreateThread();
    });

    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1);
    });
    const call = harness.turnCalls[0];
    expect(call?.threadId).toBe("thr_1");
    // The TURN_REQUEST_SCHEMA body: the client-generated runId + step 0 with
    // the user part; context/pinned/model ride every turn.
    expect(typeof call?.body.runId).toBe("string");
    expect(call?.body.stepIndex).toBe(0);
    expect(call?.body.messages).toEqual([{ role: "user", text: "Explain this comp" }]);
    expect(call?.body.model).toBe("studio-fast"); // defaulted from models

    // The user message rendered immediately (§3.4 send UX) and the run's
    // turn.completed folded the assistant answer onto its placeholder bubble.
    await waitFor(() => {
      expect(harness.api().snapshot.messages).toHaveLength(2);
    });
    expect(harness.api().snapshot.messages[0]?.role).toBe("user");
    expect(harness.api().snapshot.messages[0]?.text).toBe("Explain this comp");
    expect(harness.api().snapshot.messages[1]?.role).toBe("assistant");
    expect(harness.api().snapshot.messages[1]?.text).toBe("Done.");
    expect(harness.api().threadId).toBe("thr_1");
    expect(harness.api().threadTitle).toBe("Agent");

    // The run folded to done (the one-turn stub) and the canvas snapshot was
    // collected before the wire send (comp.info) and rides the turn body.
    await waitFor(() => {
      expect(harness.api().snapshot.phase).toBe("done");
    });
    expect(harness.bridgeCalls.queries).toContain("comp.info");
    expect(call?.body.canvas).not.toBeUndefined();
  });

  it("flushes queued sends in order: the first message runs, the second steers (§3.4)", async () => {
    const harness = makeHarness({ threadMode: "manual" });
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });

    act(() => {
      harness.api().send({ message: "first" });
    });
    act(() => {
      harness.api().send({ message: "second" });
    });
    await waitFor(() => {
      expect(harness.createThreadCalls()).toBe(1); // ONE create for both
    });

    await act(async () => {
      harness.resolveCreateThread();
    });

    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1); // only the first hits the wire
    });
    expect(harness.turnCalls[0]?.body.messages).toEqual([{ role: "user", text: "first" }]);
    // Both user messages rendered IMMEDIATELY (the second steers the live
    // run — §3.4: the composer never eats input); the run's assistant bubble
    // lands when its run.started arrives, after both.
    await waitFor(() => {
      expect(harness.api().snapshot.messages).toHaveLength(3);
    });
    expect(harness.api().snapshot.messages.map((message) => message.text)).toEqual([
      "first",
      "second",
      "Done.",
    ]);
  });

  it("reuses the thread for later sends (no second create); newThread() forces a fresh one", async () => {
    const harness = makeHarness();
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });

    act(() => {
      harness.api().send({ message: "hello" });
    });
    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(harness.api().snapshot.phase).toBe("done"); // the run settled
    });
    expect(harness.createThreadCalls()).toBe(1);
    expect(harness.api().threadId).toBe("thr_1");

    // newChat (⌘⇧L): the thread id is dropped, the transcript resets.
    act(() => {
      harness.api().newThread();
    });
    expect(harness.api().threadId).toBeNull();
    expect(harness.api().controller).toBeNull();
    expect(harness.api().snapshot.messages).toHaveLength(0);

    act(() => {
      harness.api().send({ message: "fresh thread please" });
    });
    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(2);
    });
    expect(harness.createThreadCalls()).toBe(2);
    expect(harness.turnCalls[1]?.threadId).toBe("thr_2");
    expect(harness.turnCalls[1]?.body.messages).toEqual([
      { role: "user", text: "fresh thread please" },
    ]);
  });

  it("surfaces a typed thread error when creation fails, drops the queue, and retries on the next send", async () => {
    const harness = makeHarness({ threadMode: "reject-once" });
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });

    act(() => {
      harness.api().send({ message: "doomed" });
    });
    await waitFor(() => {
      expect(harness.api().threadError).not.toBeNull();
    });
    expect(harness.api().threadError?.code).toBe("THREAD_CREATE_FAILED");
    expect(harness.api().threadError?.retryable).toBe(true);
    expect(harness.turnCalls).toHaveLength(0);

    // The failed queue is dropped — the next send starts over cleanly.
    act(() => {
      harness.api().send({ message: "try again" });
    });
    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1);
    });
    expect(harness.createThreadCalls()).toBe(2);
    expect(harness.turnCalls[0]?.body.messages).toEqual([{ role: "user", text: "try again" }]);
    await waitFor(() => {
      expect(harness.api().threadError).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tool-executor wiring (round 12: the per-run factory the controller consumes)
// ---------------------------------------------------------------------------

describe("ChatProvider — tool executor wiring", () => {
  it("builds the per-run executor with the thread, the client runId and the send-time flags", async () => {
    const harness = makeHarness();
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });

    act(() => {
      harness.api().setFlag("recentCommands", true);
    });
    act(() => {
      harness.api().send({ message: "look around" });
    });
    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1);
    });

    // The controller invoked the factory ONCE for this run, with the exact
    // deps the pinned executor seam needs (threadId, runId, flags).
    await waitFor(() => {
      expect(executorRecorder.deps).toHaveLength(1);
    });
    const deps = executorRecorder.deps[0];
    expect(deps?.threadId).toBe("thr_1");
    expect(deps?.runId).toBe(harness.turnCalls[0]?.body.runId); // the wire's runId
    expect(deps?.flags.recentCommands).toBe(true); // the §5.1 flags AT SEND TIME
  });
});

// ---------------------------------------------------------------------------
// Context orchestration
// ---------------------------------------------------------------------------

describe("ChatProvider — context orchestration", () => {
  it("collects the snapshot when the panel opens and re-collects on flag toggles", async () => {
    const harness = makeHarness();
    expect(harness.api().context).toBeNull(); // nothing collected while hidden
    expect(harness.api().panelVisible).toBe(false);

    act(() => {
      harness.api().setPanelVisible(true);
    });
    await waitFor(() => {
      expect(harness.api().context).not.toBeNull();
    });
    const initialKinds = (harness.api().context?.blocks ?? []).map((block) => block.kind);
    expect(initialKinds).toContain("projectSummary");
    expect(initialKinds).toContain("activeComp");
    expect(initialKinds).not.toContain("recentCommands"); // default-off (§5.1)

    // User opts a block in (§5.3 popover toggle) → the snapshot re-collects.
    act(() => {
      harness.api().setFlag("recentCommands", true);
    });
    await waitFor(() => {
      expect(
        (harness.api().context?.blocks ?? []).some((block) => block.kind === "recentCommands"),
      ).toBe(true);
    });
    expect(harness.bridgeCalls.queries).toContain("edit.history.list");

    // ...and back off (removed auto-context STAYS removed, §3.2).
    act(() => {
      harness.api().setFlag("recentCommands", false);
    });
    await waitFor(() => {
      expect(
        (harness.api().context?.blocks ?? []).some((block) => block.kind === "recentCommands"),
      ).toBe(false);
    });

    // "Remove all" clears every currently-on block via overrides.
    act(() => {
      harness.api().clearOptionalBlocks();
    });
    await waitFor(() => {
      expect(harness.api().context?.blocks).toHaveLength(0);
    });
    expect(harness.api().flags.projectSummary).toBe(false);
  });

  it("carries pinned chips into the snapshot and the turn body", async () => {
    const harness = makeHarness();
    act(() => {
      harness.api().setPanelVisible(true);
    });
    await waitFor(() => {
      expect(harness.api().context).not.toBeNull();
    });

    const chip = { kind: "frame" as const, label: "Frame at 00:03" };
    act(() => {
      harness.api().addPinned(chip);
    });
    await waitFor(() => {
      expect(harness.api().pinned).toEqual([chip]);
    });
    await waitFor(() => {
      expect(harness.api().context?.pinned).toEqual([chip]);
    });
    expect(harness.api().context?.totalTokenEstimate).toBeGreaterThan(0); // pinned chips count

    act(() => {
      harness.api().send({ message: "use my pinned frame" });
    });
    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1);
    });
    expect(harness.turnCalls[0]?.body.pinned).toEqual([chip]);

    // Removing the chip clears it from the next snapshot.
    act(() => {
      harness.api().removePinned(chip);
    });
    await waitFor(() => {
      expect(harness.api().pinned).toHaveLength(0);
    });
  });

  it("polls ui.inspect at 1 Hz only while the panel is visible (§11)", async () => {
    const harness = makeHarness();
    await act(async () => {
      vi.useFakeTimers();
    });

    const beforeVisible = harness.bridgeCalls.inspect;
    act(() => {
      harness.api().setPanelVisible(true);
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
      harness.api().setPanelVisible(false);
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
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("studio:chat-quick-action", { detail: "Render a preview" }),
      );
    });

    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1);
    });
    expect(harness.turnCalls[0]?.body.messages).toEqual([
      { role: "user", text: "Render a preview" },
    ]);
    expect(harness.createThreadCalls()).toBe(1);

    // Empty/garbage details never dispatch.
    act(() => {
      window.dispatchEvent(new CustomEvent("studio:chat-quick-action", { detail: "   " }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.turnCalls).toHaveLength(1);
  });

  it("stop() aborts the in-flight turn, folds cancelled and POSTs /v1/runs/:id/abandon once (§8.3)", async () => {
    const harness = makeHarness({ turnMode: "hang" });
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });
    act(() => {
      harness.api().send({ message: "stop me" });
    });
    await waitFor(() => {
      expect(harness.turnCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(harness.api().snapshot.phase).toBe("streaming");
    });

    act(() => {
      harness.api().stop();
    });
    expect(harness.api().snapshot.phase).toBe("cancelled");
    await waitFor(() => {
      expect(harness.abandons).toHaveLength(1);
    });
    expect(harness.abandons[0]).toBe(harness.turnCalls[0]?.body.runId);
    expect(harness.turnCalls[0]?.abort).toHaveBeenCalled();
    expect(harness.planPosts).toHaveLength(0); // nothing was proposed
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
// Executor deps (live ContextSelection per run — the factory is per-run now)
// ---------------------------------------------------------------------------

describe("ChatProvider — executor deps", () => {
  it("each run's factory call carries that run's id and the CURRENT flags", async () => {
    const harness = makeHarness();
    await waitFor(() => {
      expect(harness.api().models).not.toBeNull();
    });

    act(() => {
      harness.api().send({ message: "one" });
    });
    await waitFor(() => {
      expect(executorRecorder.deps).toHaveLength(1);
    });
    expect(executorRecorder.deps[0]?.flags.recentCommands).toBe(false);

    await waitFor(() => {
      expect(harness.api().snapshot.phase).toBe("done");
    });

    act(() => {
      harness.api().setFlag("recentCommands", true);
    });
    act(() => {
      harness.api().send({ message: "two" });
    });
    await waitFor(() => {
      expect(executorRecorder.deps).toHaveLength(2);
    });
    const second = executorRecorder.deps[1];
    expect(second?.runId).not.toBe(executorRecorder.deps[0]?.runId); // fresh run, fresh id
    expect(second?.flags.recentCommands).toBe(true);
    expect(typeof second?.runId).toBe("string");
  });
});

// Compile-time guard: the factory seam the controller codes against.
describe("ChatProvider — factory type seam", () => {
  it("ChatToolExecutorFactory is assignable from the provider's wiring", () => {
    const factory: ChatToolExecutorFactory = (run) => ({
      handles: (tool) => tool === run.runId,
      execute: async () => run.context,
    });
    expect(factory).toBeDefined();
    expect(factoryOf).toBeDefined();
  });
});
