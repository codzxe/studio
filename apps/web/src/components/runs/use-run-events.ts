"use client";

// apps/web — run timeline SSE hook (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §13.2  connect with Last-Event-ID, dedupe by seq, resync → reconnect,
//          close after a terminal event (run.succeeded/failed/cancelled).
//   §13.1  the stream is GET /v1/runs/:id/events (backfill, then live).
//   §20 #5 the timeline streams plan → steps → previews → verdicts.
//
// Transport: the W1-K `RunEventStream` (src/lib/api.ts) owns the wire — this
// hook owns the React binding:
//   - connect with `lastSeq` as the §13.2 Last-Event-ID anchor (full backfill
//     on first mount; `reconnect()` resumes from the high-water seq);
//   - seq dedupe: the stream dedupes per connection; `mergeRunEvent` is the
//     second line of defense for StrictMode double-streams and backfill
//     replays (monotonic high-water rule);
//   - resync sentinel: the gateway (W4-H) ends the response with a
//     `run.resync` frame whose id is the last CONTIGUOUSLY delivered seq; the
//     stream records that id and transparently reconnects with it, so the
//     re-healed backfill fills the gap and seq dedupe drops the overlap. No
//     hook action is needed — this is why `consume()` only settles on a
//     terminal event, an abort, or exhaustion of reconnect attempts;
//   - terminal event: the stream stops itself; the hook calls `onTerminal`
//     exactly once so the page can do the final GET /v1/runs/:id refresh
//     (authoritative status/cost after the worker settles the run).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isApiError, TERMINAL_RUN_EVENT_TYPES, type GatewayClient } from "@/lib/api";
import {
  deriveTimeline,
  mergeRunEvent,
  orderedRunEvents,
  parseRunEvent,
  type ParsedRunEvent,
  type RunDetailView,
  type RunEventStore,
  type RunTimeline,
} from "./timeline-state";

/** Lifecycle of the §13.2 stream as the page sees it. */
export type RunStreamState = "connecting" | "live" | "stopped" | "error";

export interface UseRunEventsOptions {
  readonly client: GatewayClient;
  readonly runId: string;
  /** Latest GET /v1/runs/:id payload (seeds the timeline; may be null). */
  readonly detail: RunDetailView | null;
  /** Fires once on the first terminal §13.2 event — the final GET refresh. */
  readonly onTerminal?: () => void;
}

export interface UseRunEventsResult {
  readonly timeline: RunTimeline;
  readonly streamState: RunStreamState;
  /** Friendly, user-safe notice when the stream gave up (§13.3 vocabulary). */
  readonly streamMessage: string | null;
  /** Manual retry after a stream error — resumes from the last seen seq. */
  readonly reconnect: () => void;
}

/**
 * Streams one run's §13.2 events and derives the timeline view state.
 * Re-render safe: the stream is created once per (client, runId, attempt) and
 * never restarts on detail refetches — only terminal events stop it.
 */
export function useRunEvents(options: UseRunEventsOptions): UseRunEventsResult {
  const { client, runId, detail } = options;

  const [eventStore, setEventStore] = useState<RunEventStore>(() => new Map());
  const [streamState, setStreamState] = useState<RunStreamState>("connecting");
  const [streamMessage, setStreamMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // §13.2 high-water seq — the Last-Event-ID anchor across reconnects.
  const lastSeqRef = useRef(0);
  const terminalSeenRef = useRef(false);
  const onTerminalRef = useRef(options.onTerminal);

  // Keep the terminal callback fresh without restarting the stream.
  useEffect(() => {
    onTerminalRef.current = options.onTerminal;
  });

  // Reset per-run stream state when the run id changes (route transitions).
  useEffect(() => {
    lastSeqRef.current = 0;
    terminalSeenRef.current = false;
    setEventStore(new Map());
    setStreamState("connecting");
    setStreamMessage(null);
  }, [runId]);

  // The stream effect — the only side-effecting subscription in the page.
  useEffect(() => {
    if (runId === "") {
      setStreamState("stopped");
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void attempt; // reload token: bumping it re-runs this effect (manual reconnect)
    setStreamState("connecting");

    const stream = client.streamRunEvents({
      runId,
      lastSeq: lastSeqRef.current > 0 ? lastSeqRef.current : null,
      signal: controller.signal,
      onEvent: (event) => {
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
        const parsed = parseRunEvent(event);
        if (parsed !== null) {
          setEventStore((store) => mergeRunEvent(store, parsed));
        }
        setStreamState("live");
        if (
          !terminalSeenRef.current &&
          (TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(event.type)
        ) {
          terminalSeenRef.current = true;
          setStreamState("stopped");
          onTerminalRef.current?.(); // final GET /v1/runs/:id refresh
        }
      },
    });

    stream
      .consume()
      .then(() => {
        if (!cancelled) {
          // Clean close: terminal event seen, or the server finished the
          // backfill for an already-terminal run without new frames.
          setStreamState((state) => (state === "error" ? state : "stopped"));
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setStreamState("error");
        setStreamMessage(
          isApiError(error)
            ? error.hint === undefined
              ? error.message
              : `${error.message} ${error.hint}`
            : "Lost the run event stream.",
        );
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, runId, attempt]);

  const reconnect = useCallback(() => {
    setStreamMessage(null);
    setAttempt((value) => value + 1);
  }, []);

  const timeline = useMemo(
    () => deriveTimeline(detail, orderedRunEvents(eventStore)),
    [detail, eventStore],
  );

  return { timeline, streamState, streamMessage, reconnect };
}

/**
 * A 1 Hz wall clock while `active` (elapsed + live step durations tick);
 * frozen between renders when inactive. Deterministic in tests: the derived
 * values are pure functions of (timeline, now).
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
