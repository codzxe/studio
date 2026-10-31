// ROUND 13 — stream pacer (the "streaming should feel like streaming" fix).
//
// WHY: real model streams arrive in WILD burst sizes — an OpenAI-compatible
// proxy may hand the gateway the whole reply in one 4 KB chunk (observed on
// the local z-ai seam) or token-by-token. Forwarded verbatim, the chat bubble
// either sits frozen then dumps a wall of text ("stuck at one speed") or
// flickers in huge gulps. The pacer sits between the transport's onEvent and
// the fold: it BUFFERS `message.delta` + `reasoning.delta` text and releases
// it on a 50 ms cadence at an ADAPTIVE rate — typing speed at the tail,
// fast-forward through bulk (backlog-proportional), so the UI always shows
// fluid live typing regardless of how the upstream chunks arrived.
//
// ORDER + SEQ CONTRACTS (what makes this safe):
// - Non-delta events are NEVER delayed: the pacer flushes its whole backlog
//   first, then forwards the event — source order is preserved, and a
//   `turn.completed` (whose assistantText/reasoningText replace the streamed
//   text authoritatively) can never race a stale buffered tail.
// - Every emitted event gets a STRICTLY INCREASING seq (the pacer rewrites
//   seqs; its cursor never goes below an incoming event's seq). The fold's
//   dedupe (seq <= lastSeq dropped) and the controller's seqBase tracking
//   keep working unchanged.

import type { StudioStreamEvent } from "@studio/contracts";

/** Delta event types the pacer smooths (everything else forwards at once). */
const PACED_TYPES: ReadonlySet<string> = new Set(["message.delta", "reasoning.delta"]);

/** Cadence: one release tick every 50 ms (20 fps — fluid, cheap). */
export const PACER_TICK_MS = 50;
/**
 * Rate curve: per tick, release clamp(ceil(backlog / 14), 3, 160) chars —
 * ~60 chars/s at the tail (human typing), ~3,200 chars/s catching up through
 * bulk, so the pacer never lags meaningfully behind the source.
 */
const BACKLOG_DIVISOR = 14;
const MIN_CHARS_PER_TICK = 3;
const MAX_CHARS_PER_TICK = 160;

type PacedEvent = Extract<StudioStreamEvent, { type: "message.delta" | "reasoning.delta" }>;

/** One buffered text piece (its own run id — runs never share the queue). */
interface BufferPiece {
  readonly type: PacedEvent["type"];
  readonly runId: string;
  text: string;
}

export interface StreamPacer {
  /** Feed one transport event: delta text buffers, everything else flushes + forwards. */
  push(event: StudioStreamEvent): void;
  /** Drain the whole backlog now (each piece its own event, in order). */
  flush(): void;
  /** Drop the backlog and stop the timer. No further emissions. */
  dispose(): void;
}

interface PacerOptions {
  /** Injectable for tests (deterministic, no real timers). */
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export function createStreamPacer(
  emitOut: (event: StudioStreamEvent) => void,
  options: PacerOptions = {},
): StreamPacer {
  const startTimer =
    options.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopTimer =
    options.clearInterval ??
    ((handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]));

  const queue: BufferPiece[] = [];
  let queueChars = 0;
  let timer: unknown = null;
  let disposed = false;
  /** Seq cursor for rewritten events; `null` until the first event assigns it. */
  let nextSeq: number | null = null;

  const emitPaced = (type: PacedEvent["type"], runId: string, piece: string): void => {
    if (nextSeq === null) return; // unreachable: push() sets the cursor first
    emitOut({ type, runId, seq: nextSeq, delta: piece } as StudioStreamEvent);
    nextSeq += 1;
  };

  const stopTicking = (): void => {
    if (timer !== null) {
      stopTimer(timer);
      timer = null;
    }
  };

  /** One adaptive release tick (the interval body). */
  const release = (): void => {
    if (disposed || queueChars === 0) {
      stopTicking();
      return;
    }
    const rate = Math.min(
      MAX_CHARS_PER_TICK,
      Math.max(MIN_CHARS_PER_TICK, Math.ceil(queueChars / BACKLOG_DIVISOR)),
    );
    let budget = rate;
    while (budget > 0 && queue.length > 0) {
      const head = queue[0];
      if (head === undefined) break;
      if (head.text.length <= budget) {
        queue.shift();
        queueChars -= head.text.length;
        budget -= head.text.length;
        emitPaced(head.type, head.runId, head.text);
      } else {
        const piece = head.text.slice(0, budget);
        head.text = head.text.slice(budget);
        queueChars -= budget;
        budget = 0;
        emitPaced(head.type, head.runId, piece);
      }
    }
    if (queueChars === 0) stopTicking();
  };

  return {
    push(event: StudioStreamEvent): void {
      if (disposed) return;
      // The cursor NEVER goes below an incoming seq — interleaved synthesized
      // events (tool.result, plan, run.completed) keep their monotonic space.
      nextSeq = nextSeq === null ? event.seq : Math.max(nextSeq, event.seq);
      if (PACED_TYPES.has(event.type)) {
        const paced = event as PacedEvent;
        if (paced.delta === "") return;
        queue.push({ type: paced.type, runId: paced.runId, text: paced.delta });
        queueChars += paced.delta.length;
        if (timer === null && !disposed) timer = startTimer(release, PACER_TICK_MS);
        return;
      }
      // Non-delta (and terminal) events: flush first — ordering + the
      // authoritative terminal replace can never see a stale buffered tail.
      this.flush();
      if (nextSeq === null) return;
      emitOut({ ...event, seq: nextSeq } as StudioStreamEvent);
      nextSeq += 1;
    },
    flush(): void {
      if (disposed) return;
      // Drain everything in one synchronous pass (terminals + push use this).
      let guard = 0;
      while (queueChars > 0 && queue.length > 0 && guard < 100_000) {
        guard += 1;
        const head = queue.shift();
        if (head === undefined) break;
        queueChars -= head.text.length;
        emitPaced(head.type, head.runId, head.text);
      }
      stopTicking();
    },
    dispose(): void {
      disposed = true;
      queue.length = 0;
      queueChars = 0;
      stopTicking();
    },
  };
}

/** True when the event type is paced (exported for tests + wiring docs). */
export function isPacedEventType(type: string): boolean {
  return PACED_TYPES.has(type);
}
