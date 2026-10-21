// apps/web — SSE core + run-events stream (W1-K; split out of src/lib/api.ts
// by W8-O). Pure WHATWG text/event-stream parsing plus the §13.2
// RunEventStream — NO React, NO env access, fetch is injectable.
//
// Import note: this module imports the envelope unwrap from ./client.ts,
// which imports RunEventStream back. The cycle is call-time only (both sides
// reference the other exclusively inside method bodies — nothing is touched
// at module-evaluation time), which ESM, webpack and Vitest all handle.

import { z } from "zod";
import { ApiError, type FetchLike, isApiError, readJsonBody, toApiError } from "./client";

// ---------------------------------------------------------------------------
// SSE — WHATWG parsing core (pure; unit-tested in tests/api.test.ts)
// ---------------------------------------------------------------------------

/** One complete SSE message dispatched on a blank line. */
export interface SseMessage {
  /** Event name; "message" when the server sent no `event:` field. */
  readonly event: string;
  /** `data:` lines joined with "\n". */
  readonly data: string;
  /** This message's `id:` value, if any (null once the next block starts). */
  readonly id: string | null;
}

/**
 * Incremental text/event-stream parser per the WHATWG spec: lines end with
 * CRLF, LF or CR; `:`-prefixed lines are comments; a single optional space
 * after the field colon is stripped; a blank line dispatches (only when data
 * is present) and resets the field buffers; `id:` updates the durable
 * last-event-id used for resume. `retry:` and unknown fields are ignored.
 */
export class SseParser {
  private buffer = "";
  private eventName = "message";
  private dataLines: string[] = [];
  private messageId: string | null = null;
  private durableLastId: string | null = null;

  /** Last `id:` seen — survives dispatches; feeds the Last-Event-ID header. */
  get lastEventId(): string | null {
    return this.durableLastId;
  }

  /** Feed a decoded chunk; returns every message completed by it. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const taken = takeLine(this.buffer);
      if (taken === null) {
        break;
      }
      this.buffer = taken.rest;
      const message = this.processLine(taken.line);
      if (message !== null) {
        messages.push(message);
      }
    }
    return messages;
  }

  /** Dispatch a pending (unterminated) block at end-of-stream, if any. */
  flush(): SseMessage[] {
    if (this.buffer !== "") {
      // The final partial line counts as terminated; a lone trailing CR is
      // an unterminated CRLF, so it ends the line instead.
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.processLine(line);
    }
    const message = this.dispatch();
    return message === null ? [] : [message];
  }

  private processLine(line: string): SseMessage | null {
    if (line === "") {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return null; // comment / heartbeat
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventName = value === "" ? "message" : value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        // NUL ids are ignored per spec; the id must survive for resume (§13.2).
        if (!value.includes("\0")) {
          this.messageId = value;
          this.durableLastId = value;
        }
        break;
      default:
        break; // `retry:` and future fields are not consumed client-side
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    if (this.dataLines.length === 0) {
      this.eventName = "message";
      this.messageId = null;
      return null; // an event without data is not dispatched (spec)
    }
    const message: SseMessage = {
      event: this.eventName,
      data: this.dataLines.join("\n"),
      id: this.messageId,
    };
    this.eventName = "message";
    this.dataLines = [];
    this.messageId = null;
    return message;
  }
}

/** Splits `buffer` at its first line terminator; null while a CRLF is pending. */
function takeLine(buffer: string): { line: string; rest: string } | null {
  const nl = buffer.indexOf("\n");
  const cr = buffer.indexOf("\r");
  if (nl === -1 && cr === -1) {
    return null; // no complete line yet
  }
  if (cr === -1 || (nl !== -1 && nl < cr)) {
    return { line: buffer.slice(0, nl), rest: buffer.slice(nl + 1) };
  }
  if (cr === buffer.length - 1) {
    return null; // trailing CR might still become CRLF — wait for more input
  }
  const skipLf = buffer[cr + 1] === "\n" ? 2 : 1;
  return { line: buffer.slice(0, cr), rest: buffer.slice(cr + skipLf) };
}

/** Decodes and parses a live response body into a message async-iterator. */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        yield message;
      }
    }
    const tail = decoder.decode(); // flush the streaming decoder
    if (tail !== "") {
      for (const message of parser.push(tail)) {
        yield message;
      }
    }
    for (const message of parser.flush()) {
      yield message;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// SSE — run events (§13.2)
// ---------------------------------------------------------------------------

// §13.2 mirror of `@studio/config` `constants/events.ts` (exact list).
// TODO(sync, contract wave): import `SSE_EVENT_SCHEMA` from @studio/config
// once the TS-source workspace package is compiled into the browser bundle
// (transpilePackages) and aliased for Vitest — until then keep in sync.
const RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.plan",
  "step.started",
  "step.finished",
  "preview.updated",
  "validate.report",
  "critique.report",
  "credits.reserved",
  "credits.charged",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly string[];

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

const runEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    run_id: z.string().min(1),
    at: z.coerce.date(),
    type: z.enum(RUN_EVENT_TYPES),
    payload: z.unknown(),
  })
  .strict();

/** Wire shape of one run event (§13.2: `{ seq, run_id, at, type, payload }`). */
export interface RunEvent {
  readonly seq: number;
  readonly run_id: string;
  readonly at: Date;
  readonly type: RunEventType;
  readonly payload: unknown;
}

/** Events after which the stream is complete — no reconnect afterwards. */
export const TERMINAL_RUN_EVENT_TYPES = [
  "run.succeeded",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly RunEventType[];

export interface RunEventStreamOptions {
  readonly runId: string;
  /** Dedupe anchor from a previous session (§13.2 — dedupe by `seq`). */
  readonly lastSeq?: number | null;
  readonly signal?: AbortSignal;
  /** Receives each valid, non-duplicate event in arrival order. */
  readonly onEvent: (event: RunEvent) => void;
  /** Reconnect attempts after stream drops / retryable errors (default 10). */
  readonly maxReconnects?: number;
  /** First reconnect delay (default 1 s), doubling per attempt, capped. */
  readonly reconnectDelayMs?: number;
}

const DEFAULT_MAX_RECONNECTS = 10;
const MAX_RECONNECT_DELAY_MS = 15_000;

/**
 * Internal transport bundle — produced by the client factory (./client.ts),
 * which threads its auth seam through so bearer clients authenticate SSE
 * reconnects too. The W8-O additions (`credentials`, `headers`) default to
 * the W1-K behavior (cookies included, no extra headers).
 */
interface SseTransport {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly credentials?: RequestCredentials;
  readonly headers?: Record<string, string>;
}

/**
 * Consumes `GET /v1/runs/:id/events` (§13.1): backfill + live events,
 * dedupe by `seq`, resume with `Last-Event-ID` after drops (§13.2). Stops
 * after the first terminal event; malformed/unknown messages are skipped so
 * a drifting gateway can never wedge the stream (seq still advances).
 */
export class RunEventStream {
  private readonly transport: SseTransport;
  private readonly options: RunEventStreamOptions;
  private lastSeq: number | null;
  private durableId: string | null = null;

  constructor(transport: SseTransport, options: RunEventStreamOptions) {
    this.transport = transport;
    this.options = options;
    this.lastSeq = options.lastSeq ?? null;
  }

  /** Runs the stream loop to completion; resolves on terminal event or abort. */
  async consume(): Promise<void> {
    let attempt = 0;
    const maxReconnects = this.options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    while (!this.isAborted()) {
      try {
        if (await this.pumpOnce()) {
          return; // terminal event seen
        }
      } catch (error) {
        if (this.isAborted()) {
          return;
        }
        if (
          isApiError(error) &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429 &&
          error.code !== "network_error"
        ) {
          throw error; // 4xx (except 429): retrying cannot help
        }
      }
      attempt += 1;
      if (attempt > maxReconnects) {
        throw new ApiError({
          code: "sse_disconnected",
          message: "Lost the run event stream and could not reconnect.",
          status: 0,
          retryable: true,
        });
      }
      await abortableDelay(this.delayMs(attempt), this.options.signal);
    }
  }

  private isAborted(): boolean {
    return this.options.signal?.aborted === true;
  }

  private delayMs(attempt: number): number {
    const base = this.options.reconnectDelayMs ?? 1_000;
    return Math.min(base * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
  }

  /** One connection; true when a terminal event was seen, false to reconnect. */
  private async pumpOnce(): Promise<boolean> {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      ...(this.transport.headers ?? {}),
    };
    // §13.2 resume: the server backfills from run_events, then goes live.
    const resumeId = this.durableId ?? (this.lastSeq !== null ? String(this.lastSeq) : null);
    if (resumeId !== null) {
      headers["Last-Event-ID"] = resumeId;
    }
    const response = await this.transport.fetch(
      `${this.transport.baseUrl}/runs/${encodeURIComponent(this.options.runId)}/events`,
      {
        headers,
        credentials: this.transport.credentials ?? "include",
        ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
      },
    );
    if (!response.ok || response.body === null) {
      throw toApiError(response.status, await readJsonBody(response));
    }
    for await (const message of readSseStream(response.body)) {
      if (message.id !== null) {
        this.durableId = message.id; // survives for the reconnect header
      }
      const event = this.parseMessage(message);
      if (event === null) {
        continue;
      }
      if (this.lastSeq !== null && event.seq <= this.lastSeq) {
        continue; // §13.2 dedupe by seq (backfill replays)
      }
      this.lastSeq = event.seq;
      this.options.onEvent(event);
      if ((TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(event.type)) {
        return true;
      }
    }
    return false; // stream ended without a terminal event — reconnect
  }

  /** Schema-validated decode; skips malformed/unknown messages defensively. */
  private parseMessage(message: SseMessage): RunEvent | null {
    let json: unknown;
    try {
      json = JSON.parse(message.data);
    } catch {
      return null;
    }
    const parsed = runEventSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
