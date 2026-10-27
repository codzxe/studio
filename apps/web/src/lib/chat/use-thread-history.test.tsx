/**
 * useThreadHistory tests (ROUND 12 "Chat UI v3" — history on reload + the
 * thread switcher list). The hook consumes NARROW fake seams (no wire): a
 * threads list, transcript rows and run records; every surface — auto-restore
 * adoption, history mapping (plan cards from run.plan, step tool cards,
 * tool/system row skipping) and the adoption gating — is asserted directly.
 */

import {
  HISTORY_RUN_LIMIT,
  type ThreadHistorySeams,
  historyTextOf,
  isToolTranscriptRow,
  mapHistoryRows,
  stepStatusToCardStatus,
  useThreadHistory,
} from "@/lib/chat/use-thread-history";
import type { RunRecord, Thread, ThreadMessage } from "@studio/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function thread(id: string, title: string | null, updatedAt: string): Thread {
  return {
    id,
    projectId: "proj_1",
    title,
    createdBy: "user_1",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt,
  };
}

function row(
  id: string,
  role: ThreadMessage["role"],
  content: unknown,
  runId: string | null,
  createdAt: string,
): ThreadMessage {
  return { id, threadId: "thr_1", role, content, runId, createdAt };
}

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run_1",
    threadId: "thr_1",
    projectId: "proj_1",
    model: "studio-fast",
    status: "completed",
    plan: {
      intent: "edit",
      summary: "Restyle the headline",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ name: "Headline", change: "restyle" }],
      estimatedCredits: 1,
      steps: [
        {
          title: "Restyle",
          tool: "studio.plan_edit",
          args: {},
          batch: { label: "Agent: restyle", steps: [{ command: "prop.set", params: {} }] },
        },
      ],
    },
    steps: [
      { seq: 0, tool: "studio.get_context", status: "succeeded", durationMs: 12 },
      { seq: 1, tool: "studio.plan_edit", status: "failed", durationMs: 4 },
    ],
    reservedCredits: 1,
    committedCredits: 1,
    baseVersionId: null,
    resultVersionId: "ver_9",
    errorCode: null,
    createdAt: "2026-10-20T10:00:02.000Z",
    completedAt: "2026-10-20T10:00:05.000Z",
    ...overrides,
  };
}

/** Rows OLDEST first — the adapter contract the slot relies on. */
function transcriptFixture(): ThreadMessage[] {
  return [
    row("msg_u1", "user", { message: "Make the headline red" }, null, "2026-10-20T10:00:00.000Z"),
    row(
      "msg_t1",
      "user",
      { kind: "tool", toolCallId: "tc_1", tool: "studio.get_context", payload: {} },
      "run_1",
      "2026-10-20T10:00:01.000Z",
    ),
    row(
      "msg_a1",
      "assistant",
      { message: "Checking the comp…" },
      "run_1",
      "2026-10-20T10:00:02.000Z",
    ),
    row("msg_a2", "assistant", { message: "Done." }, "run_1", "2026-10-20T10:00:05.000Z"),
    row("msg_s1", "system", { message: "bookkeeping" }, null, "2026-10-20T10:00:06.000Z"),
  ];
}

function makeSeams(options?: {
  readonly threads?: readonly Thread[];
  readonly rows?: readonly ThreadMessage[];
  readonly runs?: ReadonlyMap<string, RunRecord>;
}): { seams: ThreadHistorySeams; spies: { list: ReturnType<typeof vi.fn> } } {
  const list = vi.fn(async () => options?.threads ?? []);
  const seams: ThreadHistorySeams = {
    listThreads: async () => list(),
    loadMessages: async () => options?.rows ?? [],
    loadRun: async (runId) => options?.runs?.get(runId) ?? null,
  };
  return { seams, spies: { list } };
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

describe("historyTextOf", () => {
  it("extracts the round-12 user/assistant message field", () => {
    expect(historyTextOf({ message: "hello", context: {} })).toBe("hello");
    expect(historyTextOf({ message: "hi", status: "completed" })).toBe("hi");
  });

  it("tolerates legacy string + {text} + unusable shapes", () => {
    expect(historyTextOf("plain string")).toBe("plain string");
    expect(historyTextOf({ text: "alt" })).toBe("alt");
    expect(historyTextOf({ weird: 3 })).toBe("");
    expect(historyTextOf(null)).toBe("");
    expect(historyTextOf(undefined)).toBe("");
  });
});

describe("isToolTranscriptRow / stepStatusToCardStatus", () => {
  it("recognizes tool payload rows and nothing else", () => {
    expect(isToolTranscriptRow({ kind: "tool", toolCallId: "x" })).toBe(true);
    expect(isToolTranscriptRow({ message: "hi" })).toBe(false);
    expect(isToolTranscriptRow("hi")).toBe(false);
  });

  it("maps the persisted step statuses onto the card vocabulary", () => {
    expect(stepStatusToCardStatus("started")).toBe("running");
    expect(stepStatusToCardStatus("succeeded")).toBe("done");
    expect(stepStatusToCardStatus("skipped")).toBe("done");
    expect(stepStatusToCardStatus("failed")).toBe("failed");
  });
});

describe("mapHistoryRows", () => {
  it("maps the display shape, skipping system + tool rows", () => {
    const mapped = mapHistoryRows(transcriptFixture(), new Map([["run_1", run({})]]));
    expect(mapped.map((message) => message.id)).toEqual([
      "hist:msg_u1",
      "hist:msg_a1",
      "hist:msg_a2",
    ]);
    expect(mapped[0]).toMatchObject({ role: "user", text: "Make the headline red" });
    expect(mapped[1]).toMatchObject({
      role: "assistant",
      text: "Checking the comp…",
      runId: "run_1",
    });
  });

  it("attaches plan + step cards to the run's LAST assistant row only", () => {
    const mapped = mapHistoryRows(transcriptFixture(), new Map([["run_1", run({})]]));
    expect(mapped[1]?.toolCards).toEqual([]);
    expect(mapped[1]?.plan).toBeUndefined();
    expect(mapped[2]?.toolCards).toEqual([
      { toolCallId: "run_1:step:0", name: "studio.get_context", status: "done" },
      { toolCallId: "run_1:step:1", name: "studio.plan_edit", status: "failed" },
    ]);
    expect(mapped[2]?.plan?.summary).toBe("Restyle the headline");
  });

  it("renders read-only when the run is missing or planless", () => {
    const mapped = mapHistoryRows(transcriptFixture(), new Map());
    expect(mapped[2]?.toolCards).toEqual([]);
    expect(mapped[2]?.plan).toBeUndefined();
  });

  it("bounds the runs fetched per history window", () => {
    expect(HISTORY_RUN_LIMIT).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

describe("useThreadHistory — auto-restore + history load", () => {
  it("adopts the newest thread once when the live thread is empty on reload", async () => {
    const onOpenThread = vi.fn();
    const { seams } = makeSeams({
      threads: [
        thread("thr_2", "Second", "2026-10-22T10:00:00.000Z"),
        thread("thr_1", "First", "2026-10-21T10:00:00.000Z"),
      ],
      rows: transcriptFixture(),
      runs: new Map([["run_1", run({})]]),
    });
    const { result } = renderHook(() =>
      useThreadHistory({
        seams,
        projectId: "proj_1",
        threadId: null,
        liveMessageCount: 0,
        onOpenThread,
      }),
    );
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith("thr_2", "Second"));
    expect(result.current.threads).toHaveLength(2);
  });

  it("loads history for an ADOPTED thread and folds run cards into it", async () => {
    const onOpenThread = vi.fn();
    const { seams } = makeSeams({
      rows: transcriptFixture(),
      runs: new Map([["run_1", run({})]]),
    });
    const { result, rerender } = renderHook(
      ({
        threadId,
      }: {
        threadId: string | null;
      }) =>
        useThreadHistory({
          seams,
          projectId: "proj_1",
          threadId,
          liveMessageCount: 0,
          onOpenThread,
        }),
      { initialProps: { threadId: null as string | null } },
    );
    act(() => result.current.adoptThread("thr_1", "Old chat"));
    rerender({ threadId: "thr_1" });
    await waitFor(() => expect(result.current.history.length).toBe(3));
    expect(result.current.historyLoading).toBe(false);
    const last = result.current.history[2];
    expect(last?.plan?.summary).toBe("Restyle the headline");
    expect(last?.toolCards).toHaveLength(2);
  });

  it("never loads history for a lazily-created live thread (no double render)", async () => {
    const onOpenThread = vi.fn();
    const { seams } = makeSeams({ rows: transcriptFixture() });
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useThreadHistory({
          seams,
          projectId: "proj_1",
          threadId,
          liveMessageCount: 2,
          onOpenThread,
        }),
      { initialProps: { threadId: null as string | null } },
    );
    rerender({ threadId: "thr_lazy" });
    // No adoption ever happened for thr_lazy.
    await waitFor(() => expect(result.current.history).toEqual([]));
  });

  it("keeps a fresh New chat fresh (auto-restore fires once per mount)", async () => {
    const onOpenThread = vi.fn();
    const { seams } = makeSeams({
      threads: [thread("thr_1", "Only", "2026-10-22T10:00:00.000Z")],
    });
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useThreadHistory({
          seams,
          projectId: "proj_1",
          threadId,
          liveMessageCount: 0,
          onOpenThread,
        }),
      { initialProps: { threadId: null as string | null } },
    );
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledTimes(1));
    // The user starts a new chat: threadId returns to null and the effect
    // re-runs — the hook must NOT re-adopt.
    rerender({ threadId: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(result.current.history).toEqual([]);
  });

  it("degrades silently when the seams are null (no client)", async () => {
    const { result } = renderHook(() =>
      useThreadHistory({
        seams: null,
        projectId: "proj_1",
        threadId: "thr_1",
        liveMessageCount: 0,
        onOpenThread: vi.fn(),
      }),
    );
    expect(result.current.threads).toEqual([]);
    expect(result.current.history).toEqual([]);
    expect(result.current.threadsLoading).toBe(false);
  });
});
