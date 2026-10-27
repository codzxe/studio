"use client";

/**
 * useThreadHistory — ROUND 12 "Chat UI v3": history on reload + the thread
 * list for the switcher (research/round12-design.md "History on reload +
 * thread switcher"; audit gap #1: `threads.messages()` existed but was
 * called NOWHERE in apps/web).
 *
 * What this hook owns (and deliberately NOTHING else):
 * - **Thread list** for the project (`GET /v1/projects/:id/threads`, newest
 *   first) — the switcher dropdown's rows.
 * - **Auto-restore on reload**: while no thread is live and the live
 *   snapshot is EMPTY, the newest thread is ADOPTED once per mount through
 *   the caller's `onOpenThread` seam (the provider's `openThread` — the
 *   controller is recreated for it by the provider's existing effect; this
 *   hook never touches the controller).
 * - **Transcript reconstruction** for ADOPTED threads only:
 *   `GET /v1/threads/:id/messages` (newest-first page, reversed) mapped into
 *   the store's display shape `ChatUiMessage` — rendered by the PANEL layer
 *   (chat-panel-slot merges them BEFORE the live messages), never injected
 *   into run-state (i4's reducer stays the only writer of live state).
 * - **Past plan/tool cards**: for the bounded set of distinct run ids on
 *   the loaded rows, `GET /v1/runs/:id` supplies `plan` (the gateway's
 *   plan_json DTO) + `steps`; the plan renders through the message layer's
 *   READ-ONLY M4 card (no `planRuntime` — no compiled batch, no Apply
 *   surface — matching the reload auto-apply guard: a reloaded page must
 *   never resurrect actionable plans) and the steps render as tool cards
 *   with their persisted status.
 *
 * Never throws: every seam failure degrades to empty rows / a hidden
 * surface; the live chat is never blocked.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { RunRecord, Thread, ThreadMessage } from "@studio/contracts";

import type { ChatUiMessage, ToolCardState } from "./types";

// ---------------------------------------------------------------------------
// Client seams (narrow, trivially fakeable)
// ---------------------------------------------------------------------------

/**
 * The api-client surface this hook consumes. `ApiClient` satisfies this
 * structurally after the adapter below; tests pass plain object fakes.
 */
export interface ThreadHistorySeams {
  /** Project threads, NEWEST first (repo order: updatedAt desc). */
  listThreads(projectId: string): Promise<readonly Thread[]>;
  /** Thread transcript rows, OLDEST first (bounded — the recent window). */
  loadMessages(threadId: string): Promise<readonly ThreadMessage[]>;
  /** One run (plan + steps); null when the fetch fails (never throws). */
  loadRun(runId: string): Promise<RunRecord | null>;
}

/** How many transcript rows the history window loads (bounded UI). */
export const HISTORY_MESSAGE_LIMIT = 60;
/** Distinct runs whose plan/steps get reconstructed (newest runs win). */
export const HISTORY_RUN_LIMIT = 8;

/**
 * Adapter from the real `ApiClient` (the provider's `client`). Reverses the
 * repo's newest-first message page into oldest-first rows and swallows run
 * failures (a missing run row must never break the transcript).
 */
export function threadHistorySeamsFromClient(
  client: Pick<ApiClientShape, "threads" | "runs">,
): ThreadHistorySeams {
  return {
    listThreads: async (projectId) => (await client.threads.list(projectId, { limit: 30 })).items,
    loadMessages: async (threadId) =>
      [
        ...(await client.threads.messages(threadId, { limit: HISTORY_MESSAGE_LIMIT })).items,
      ].reverse(),
    loadRun: async (runId) => {
      try {
        return await client.runs.get(runId);
      } catch {
        return null; // a deleted/legacy run degrades to no cards
      }
    },
  };
}

/** Structural slice of @studio/api-client's ApiClient (type-only import). */
interface ApiClientShape {
  readonly threads: {
    list(
      projectId: string,
      query?: { readonly limit?: number },
    ): Promise<{ readonly items: readonly Thread[] }>;
    messages(
      threadId: string,
      query?: { readonly limit?: number },
    ): Promise<{ readonly items: readonly ThreadMessage[] }>;
  };
  readonly runs: {
    get(runId: string): Promise<RunRecord>;
  };
}

// ---------------------------------------------------------------------------
// Pure row → display-shape mapping (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The user-visible text of one persisted row's `content` (content_json):
 * a plain string (legacy), `{ message }` (the round-12 user/assistant
 * shapes), `{ text }`, or nothing renderable → "". Tolerant by design —
 * the wire type is `unknown` and old rows must never crash the panel.
 */
export function historyTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content !== "object" || content === null) return "";
  const record = content as Record<string, unknown>;
  for (const key of ["message", "text"] as const) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Tool transcript rows (`{ kind: "tool", ... }`) never render as bubbles. */
export function isToolTranscriptRow(content: unknown): boolean {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as Record<string, unknown>).kind === "tool"
  );
}

/** `agent_steps.status` → the tool-card status vocabulary. */
export function stepStatusToCardStatus(
  status: RunRecord["steps"][number]["status"],
): ToolCardState["status"] {
  switch (status) {
    case "started":
      return "running"; // honest for a stale/interrupted run
    case "failed":
      return "failed";
    case "succeeded":
    case "skipped":
      return "done";
  }
}

/** Tool cards for one run's persisted steps (stable synthetic ids). */
function toolCardsForRun(run: RunRecord): ToolCardState[] {
  return run.steps.map((step) => ({
    toolCallId: `${run.id}:step:${step.seq}`,
    name: step.tool,
    status: stepStatusToCardStatus(step.status),
  }));
}

/**
 * Map persisted transcript rows (OLDEST first) into the store's display
 * shape. The run's plan + step cards attach to the run's LAST assistant row
 * (a multi-turn run persists one assistant row per turn; duplicating the
 * card on every row would lie). Rows for system/tool roles are skipped.
 */
export function mapHistoryRows(
  rows: readonly ThreadMessage[],
  runsByRunId: ReadonlyMap<string, RunRecord>,
): ChatUiMessage[] {
  const lastAssistantByRun = new Map<string, ThreadMessage>();
  for (const row of rows) {
    if (row.role === "assistant" && row.runId !== null) {
      lastAssistantByRun.set(row.runId, row); // rows are oldest→newest
    }
  }
  const out: ChatUiMessage[] = [];
  for (const row of rows) {
    // Tool transcript rows ride role "user" on the wire (the gateway's DTO
    // maps the DB's role enum to user|assistant|system) — never a bubble.
    if (row.role === "user" && isToolTranscriptRow(row.content)) continue;
    // System rows are bookkeeping, never conversation.
    if (row.role !== "user" && row.role !== "assistant") continue;
    const text = historyTextOf(row.content);
    if (row.role === "user") {
      out.push({
        id: `hist:${row.id}`,
        role: "user",
        text,
        toolCards: [],
      });
      continue;
    }
    const runId = row.runId;
    const run = runId !== null ? runsByRunId.get(runId) : undefined;
    // The plan + step cards attach to the run's LAST assistant row (a
    // multi-turn run persists one assistant row per turn; duplicating the
    // card on every row would lie).
    const isLast = runId !== null && lastAssistantByRun.get(runId) === row;
    out.push({
      id: `hist:${row.id}`,
      role: "assistant",
      text,
      ...(runId !== null ? { runId } : {}),
      toolCards: isLast && run !== undefined ? toolCardsForRun(run) : [],
      ...(isLast && run?.plan != null ? { plan: run.plan } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface UseThreadHistoryOptions {
  /** null = no history surface (no client — tests, read-only embeds). */
  readonly seams: ThreadHistorySeams | null;
  readonly projectId: string | null;
  /** The live thread id (the provider's lazy/adopted thread). */
  readonly threadId: string | null;
  /**
   * Live snapshot message count — the auto-restore only fires while the
   * live thread is empty (defensive: a live transcript must never be
   * duplicated by a history load).
   */
  readonly liveMessageCount: number;
  /**
   * Adopt a thread (the provider's `openThread`): recreates the controller
   * for it. Only threads adopted through this seam get history loaded.
   */
  readonly onOpenThread: (threadId: string, title: string | null) => void;
}

export interface ThreadHistoryState {
  /** Project threads, newest first (the switcher's rows). */
  readonly threads: readonly Thread[];
  readonly threadsLoading: boolean;
  /** Transcript rows (oldest first) for the ADOPTED thread; [] otherwise. */
  readonly history: readonly ChatUiMessage[];
  readonly historyLoading: boolean;
  /** Re-list the project's threads (after creates/switches). */
  readonly refreshThreads: () => void;
  /**
   * Adopt a thread: record it (only adopted threads load history) and
   * forward to the provider's `openThread`. THE switcher + auto-restore
   * seam — the panel layer must call this, never `api.openThread`.
   */
  readonly adoptThread: (threadId: string, title: string | null) => void;
}

/**
 * History-on-reload + thread-list state. All async is guarded (cancelled
 * flags + latest-write-wins); the hook never throws into the panel.
 */
export function useThreadHistory(options: UseThreadHistoryOptions): ThreadHistoryState {
  const { seams, projectId, threadId, liveMessageCount, onOpenThread } = options;

  const [threads, setThreads] = useState<readonly Thread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [history, setHistory] = useState<readonly ChatUiMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [refreshSeq, setRefreshSeq] = useState(0);

  /** The thread the UI adopted this mount (auto-restore or switcher). */
  const adoptedIdRef = useRef<string | null>(null);
  /** Auto-restore attempts at most once per mount (never after New chat). */
  const autoOpenedRef = useRef(false);
  const onOpenThreadRef = useRef(onOpenThread);
  onOpenThreadRef.current = onOpenThread;
  /**
   * Latest-ref seams for the once-per-mount auto-restore guard (w3-b06):
   * `threadId`/`liveMessageCount` exist ONLY to feed that guard, so the list
   * effect must not depend on them — every live message (send/steer/
   * run.started) and every thread switch would otherwise cancel + refetch
   * `GET /v1/projects/:id/threads` mid-chat. Reading the refs AT RESOLUTION
   * TIME is also the honest guard: it sees a message that landed while the
   * list was in flight (the captured-closure read could not).
   */
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const liveMessageCountRef = useRef(liveMessageCount);
  liveMessageCountRef.current = liveMessageCount;

  const refreshThreads = useCallback((): void => {
    setRefreshSeq((seq) => seq + 1);
  }, []);

  /** The switcher/auto-restore adoption seam (see ThreadHistoryState). */
  const adoptThread = useCallback((nextId: string, title: string | null): void => {
    adoptedIdRef.current = nextId;
    onOpenThreadRef.current(nextId, title);
  }, []);

  // -- thread list + the once-per-mount auto-restore -------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate dep — refreshSeq is the manual re-list trigger (never read in the body); threadId/liveMessageCount feed the auto-restore guard through refs so live traffic does NOT refetch the list (w3-b06).
  useEffect(() => {
    if (seams === null || projectId === null) return;
    let cancelled = false;
    setThreadsLoading(true);
    void seams
      .listThreads(projectId)
      .then((rows) => {
        if (cancelled) return;
        setThreads(rows);
        // Reload restore: no live thread, nothing typed yet, not done
        // before and a thread exists → adopt the newest one. An explicit
        // New chat (threadId null again) stays fresh: autoOpenedRef.
        const newest = rows[0];
        if (
          !autoOpenedRef.current &&
          newest !== undefined &&
          threadIdRef.current === null &&
          liveMessageCountRef.current === 0
        ) {
          autoOpenedRef.current = true;
          adoptThread(newest.id, newest.title);
        }
      })
      .catch(() => {
        if (!cancelled) setThreads([]); // a failed list hides the surface
      })
      .finally(() => {
        if (!cancelled) setThreadsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seams, projectId, refreshSeq, adoptThread]);

  // -- transcript for the ADOPTED thread only --------------------------------
  useEffect(() => {
    if (seams === null || threadId === null || threadId !== adoptedIdRef.current) {
      setHistory((current) => (current.length === 0 ? current : []));
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    void seams
      .loadMessages(threadId)
      .then(async (rows) => {
        if (cancelled) return;
        // Distinct run ids, NEWEST runs first, bounded.
        const runIds: string[] = [];
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i];
          if (row !== undefined && row.role === "assistant" && row.runId !== null) {
            if (!runIds.includes(row.runId) && runIds.length < HISTORY_RUN_LIMIT) {
              runIds.push(row.runId);
            }
          }
        }
        const runs = await Promise.all(
          runIds.map((runId) => seams.loadRun(runId).catch(() => null)),
        );
        if (cancelled) return;
        const runsByRunId = new Map<string, RunRecord>();
        for (const run of runs) {
          if (run !== null) runsByRunId.set(run.id, run);
        }
        setHistory(mapHistoryRows(rows, runsByRunId));
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seams, threadId]);

  return { threads, threadsLoading, history, historyLoading, refreshThreads, adoptThread };
}
