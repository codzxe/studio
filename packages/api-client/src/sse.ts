// @studio/api-client — chat stream reader (PRODUCT_ARCHITECTURE §7.4,
// EDITOR_CHAT_UX §8).
//
// `POST /v1/threads/:id/chat` returns an AI SDK UI stream (SSE). The stream
// mixes TWO kinds of payloads, and the reader handles both:
//
//   1. Native AI SDK UI-message parts, e.g.
//        {"type":"text-delta","id":"…","delta":"I’ll "}
//        {"type":"tool-input-start","id":"…","toolCallId":"…","toolName":"…"}
//        {"type":"tool-input-delta","id":"…","toolCallId":"…","inputTextDelta":"…"}
//        {"type":"tool-output-available","id":"…","toolCallId":"…","output":{…}}
//      (v4 data-stream part names `textDelta`/`tool-call`/`tool-result` are
//      accepted too.)
//
//   2. Studio data parts (§7.4 StudioStreamEvent), either directly on the
//      `data:` line or wrapped as an AI SDK custom data part
//      (`{"type":"data-…","data":{…event…}}`). Every §7.4 event carries
//      `runId` + a monotonic per-run `seq`.
//
// NORMALIZATION: everything is normalized into StudioStreamEvent
// (`text-delta` → `message.delta`, `tool-input-start` → `tool.started`, …)
// and folded through the contracts `applyEvents` reducer, so the controller
// exposes message text, tool-call cards, plan, credits, preview and run
// status from ONE state machine.
//
// SEQ MODEL (why a local counter): §7.4 seqs identify a run's server-side
// log entries and are what `Last-Event-ID` replays; AI-SDK-native parts have
// no seq. To interleave both without ever dropping a server event, the reader
//   * tracks `lastServerSeq` and DROPS Studio events whose server seq was
//     already seen (replay after reconnect is idempotent — the reducer never
//     sees duplicates), and
//   * assigns every emitted event a strictly-increasing LOCAL seq so the
//     reducer's `seq <= lastSeq` rule orders arrival, not wire numbering.
// AI-SDK parts that arrive before `run.started` cannot belong to a run yet
// (§7.4: events are ordered per run) and are counted in `ignoredParts`.
//
// RECONNECT (§8.4): on a dropped stream the reader re-POSTs the SAME body
// (same idempotency key — a retry never duplicates a run) with
// `Last-Event-ID` = the highest server seq seen (or the raw SSE `id:` field
// when the server uses opaque ids), backing off 1s → 2s → 4s → 8s, capped at
// 30s, with 3 automatic attempts before pausing for a manual `reconnect()`.
// User aborts (`signal`, `abort()`, `cancel()`) never auto-reconnect.

import {
  CHAT_REQUEST_SCHEMA,
  INITIAL_RUN_STATE,
  STUDIO_STREAM_EVENT_SCHEMA,
  applyEvents,
  isErr,
  type ChatRequest,
  type EditPlan,
  type RunCreditsState,
  type RunErrorState,
  type RunPreviewState,
  type RunState,
  type RunStatus,
  type StudioStreamEvent,
  type ToolCallState,
} from "@studio/contracts";

import { ApiError, fromResponse, isApiError, networkError } from "./api-error.js";
import { getAbortError, isAbortError, sleepWithAbort } from "./utils.js";

// ---------------------------------------------------------------------------
// SSE byte-stream parser (WHATWG event-stream framing)
// ---------------------------------------------------------------------------

/** One dispatched SSE event block. */
export interface SseMessage {
  /** `event:` field, when present. */
  readonly event: string | undefined;
  /** `id:` field, when present. */
  readonly id: string | undefined;
  /** `data:` lines joined with `\n`. */
  readonly data: string;
  /** `retry:` field in ms, when present. */
  readonly retryMs: number | undefined;
}

export interface SseParser {
  /** Feed raw bytes (or a string) — chunks may split lines, JSON, anywhere. */
  push(chunk: Uint8Array | string): void;
  /**
   * Ends the stream. Deviation from WHATWG (documented): a trailing block
   * that never received its blank-line terminator is still dispatched when it
   * carries data — truncated-final-event robustness for dev servers. A
   * dangling lone `\r` is treated as a terminator first.
   */
  end(): void;
  /** Highest `id:` field seen (numeric or opaque), committed at block ends. */
  readonly lastEventId: string | null;
}

interface LineEnding {
  readonly index: number;
  readonly length: number;
}

/** Finds the next line terminator at/after `from` (CRLF, LF or CR). */
function findLineEnding(buffer: string, from: number): LineEnding | null {
  const lf = buffer.indexOf("\n", from);
  const cr = buffer.indexOf("\r", from);
  if (lf === -1 && cr === -1) return null;
  if (cr !== -1 && (lf === -1 || cr < lf)) {
    if (buffer[cr + 1] === "\n") return { index: cr, length: 2 };
    if (cr === buffer.length - 1) return null; // lone trailing \r — may become \r\n
    return { index: cr, length: 1 };
  }
  return { index: lf, length: 1 };
}

/**
 * Incremental SSE parser. Handles CRLF/LF/CR line endings, multi-line
 * `data:`, comments (`:`), `id:`/`event:`/`retry:` fields and UTF-8 split
 * across chunk boundaries (streaming TextDecoder).
 */
export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lastEventId: string | null = null;

  let dataLines: string[] = [];
  let eventType: string | undefined;
  let eventId: string | undefined;
  let retryMs: number | undefined;

  const commitBlock = (): void => {
    if (eventId !== undefined && !eventId.includes("\0")) lastEventId = eventId;
    if (dataLines.length > 0) {
      onMessage({
        event: eventType,
        id: eventId,
        data: dataLines.join("\n"),
        retryMs,
      });
    }
    dataLines = [];
    eventType = undefined;
    eventId = undefined;
    retryMs = undefined;
  };

  const processLine = (line: string): void => {
    if (line === "") {
      commitBlock();
      return;
    }
    if (line.startsWith(":")) return; // comment / heartbeat
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1); // strip ONE leading space
    }
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventType = value;
    } else if (field === "id") {
      eventId = value;
    } else if (field === "retry") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) === false) retryMs = parsed;
    }
    // Unknown fields are ignored per spec.
  };

  const drain = (): void => {
    let cursor = 0;
    for (;;) {
      const ending = findLineEnding(buffer, cursor);
      if (ending === null) break;
      processLine(buffer.slice(cursor, ending.index));
      cursor = ending.index + ending.length;
    }
    buffer = buffer.slice(cursor);
  };

  return {
    push(chunk: string | Uint8Array): void {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      drain();
    },
    end(): void {
      // A trailing lone \r terminates the final line.
      if (buffer.endsWith("\r")) buffer = `${buffer.slice(0, -1)}\n`;
      buffer += decoder.decode(); // flush any pending multi-byte tail
      drain();
      buffer = `${buffer}\n`; // force the final block through commitBlock()
      drain();
    },
    get lastEventId(): string | null {
      return lastEventId;
    },
  };
}

// ---------------------------------------------------------------------------
// Part normalizer (AI SDK parts + Studio data parts → StudioStreamEvent)
// ---------------------------------------------------------------------------

/** Client-synthesized code for an AI SDK `error` part (no §7.4 code exists). */
export const STREAM_ERROR_CODE = "STREAM_ERROR";

/**
 * The §7.4 event shapes the reader synthesizes from AI-SDK parts (before
 * `runId` and the local `seq` are assigned).
 */
export type UnboundStudioEvent =
  | { readonly type: "message.delta"; readonly delta: string }
  | {
      readonly type: "tool.started";
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly type: "tool.delta"; readonly toolCallId: string; readonly delta: string }
  | { readonly type: "tool.result"; readonly toolCallId: string; readonly result: unknown }
  | {
      readonly type: "run.failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Stateful normalizer. Owns run binding, server-seq replay protection and
 * the strictly-increasing local seq handed to the reducer.
 */
export class StreamEventNormalizer {
  #runId: string | null = null;
  #lastServerSeq = -1;
  #localSeq = -1;
  #ignored = 0;

  /** `runId` once a §7.4 event bound the stream to a run. */
  get runId(): string | null {
    return this.#runId;
  }

  /** Highest §7.4 `seq` seen; `-1` before the first server event. */
  get lastServerSeq(): number {
    return this.#lastServerSeq;
  }

  /** Count of payloads that could not be normalized (pre-run parts, junk). */
  get ignoredCount(): number {
    return this.#ignored;
  }

  /** Records a payload that could not be normalized at all (bad JSON etc.). */
  recordJunk(): void {
    this.#ignored += 1;
  }

  /**
   * Normalizes one parsed `data:` JSON value into zero or more events.
   * Studio events pass through validated (unknown keys stripped); AI SDK
   * parts map per the table in the file header.
   */
  ingest(payload: unknown): StudioStreamEvent[] {
    const direct = STUDIO_STREAM_EVENT_SCHEMA.safeParse(payload);
    if (direct.success) return this.emitServerEvent(direct.data);

    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { type?: unknown }).type === "string" &&
      (payload as { type: string }).type.startsWith("data-")
    ) {
      const inner = (payload as { data?: unknown }).data;
      const unwrapped = STUDIO_STREAM_EVENT_SCHEMA.safeParse(inner);
      if (unwrapped.success) return this.emitServerEvent(unwrapped.data);
      this.#ignored += 1;
      return [];
    }

    return this.emitAiSdkPart(payload);
  }

  private emitServerEvent(event: StudioStreamEvent): StudioStreamEvent[] {
    if (this.#runId !== null && event.runId !== this.#runId) {
      this.#ignored += 1; // foreign run — §7.4 events are per-run
      return [];
    }
    if (event.seq <= this.#lastServerSeq) {
      return []; // replay / duplicate (Last-Event-ID): idempotent no-op
    }
    if (this.#runId === null) this.#runId = event.runId;
    this.#lastServerSeq = event.seq;
    this.#localSeq += 1;
    return [{ ...event, seq: this.#localSeq }];
  }

  private emitAiSdkPart(payload: unknown): StudioStreamEvent[] {
    if (typeof payload !== "object" || payload === null) {
      this.#ignored += 1;
      return [];
    }
    const part = payload as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : undefined;
    if (type === undefined) {
      this.#ignored += 1;
      return [];
    }
    const events = this.mapPart(part, type);
    if (events.length === 0) return [];
    if (this.#runId === null) {
      // §7.4 ordering: a run starts at run.started. Pre-run SDK parts are
      // dropped (and counted) rather than guessed at.
      this.#ignored += events.length;
      return [];
    }
    const runId = this.#runId;
    return events.map((unbound) => {
      this.#localSeq += 1;
      return { ...unbound, runId, seq: this.#localSeq };
    });
  }

  private mapPart(part: Record<string, unknown>, type: string): UnboundStudioEvent[] {
    switch (type) {
      case "text-delta": {
        const delta = typeof part.delta === "string" ? part.delta : part.textDelta;
        if (typeof delta !== "string") return [];
        return [{ type: "message.delta", delta }];
      }
      case "tool-input-start": {
        if (typeof part.toolCallId !== "string" || typeof part.toolName !== "string") return [];
        return [
          { type: "tool.started", toolCallId: part.toolCallId, name: part.toolName, args: undefined },
        ];
      }
      case "tool-input-delta": {
        if (typeof part.toolCallId !== "string" || typeof part.inputTextDelta !== "string") {
          return [];
        }
        return [{ type: "tool.delta", toolCallId: part.toolCallId, delta: part.inputTextDelta }];
      }
      case "tool-call": {
        // AI SDK v4 data stream: one part carries the full call + args.
        if (typeof part.toolCallId !== "string" || typeof part.toolName !== "string") return [];
        return [
          { type: "tool.started", toolCallId: part.toolCallId, name: part.toolName, args: part.args },
        ];
      }
      case "tool-output-available": {
        if (typeof part.toolCallId !== "string") return [];
        return [{ type: "tool.result", toolCallId: part.toolCallId, result: part.output }];
      }
      case "tool-output-error": {
        if (typeof part.toolCallId !== "string") return [];
        return [
          {
            type: "tool.result",
            toolCallId: part.toolCallId,
            result: { error: part.errorText ?? "The tool call failed." },
          },
        ];
      }
      case "tool-result": {
        if (typeof part.toolCallId !== "string") return [];
        return [{ type: "tool.result", toolCallId: part.toolCallId, result: part.result }];
      }
      case "error": {
        const message =
          typeof part.errorText === "string" ? part.errorText : "The stream ended with an error.";
        return [{ type: "run.failed", code: STREAM_ERROR_CODE, message, retryable: true }];
      }
      default:
        // start / start-step / text-start / text-end / tool-input-end /
        // finish-step / finish / raw / reasoning-* have no §7.4 counterpart.
        return [];
    }
  }
}

// ---------------------------------------------------------------------------
// streamChat — POST + pump + normalize + reduce + cancel + reconnect
// ---------------------------------------------------------------------------

/** §8.4 backoff: 1s, 2s, 4s, 8s; later attempts cap at 30s. */
export const RECONNECT_SCHEDULE_MS: readonly number[] = [1000, 2000, 4000, 8000];
/** §8.4: "max 30s". */
export const RECONNECT_MAX_DELAY_MS = 30_000;
/** §8.4: "After 3 failures, show 'Run paused'…" — then only manual reconnect. */
export const RECONNECT_MAX_AUTO_ATTEMPTS = 3;

export interface ChatStreamReconnectConfig {
  /** Auto-reconnect dropped streams. Default `true`. */
  readonly enabled?: boolean;
  /** Backoff schedule; the last entry repeats, capped at `maxDelayMs`. */
  readonly scheduleMs?: readonly number[];
  readonly maxDelayMs?: number;
  /** Automatic attempts before pausing. Default 3 (§8.4). */
  readonly maxAutoAttempts?: number;
}

export interface ChatStreamReconnectInfo {
  /** 1-based attempt that is about to run. */
  readonly attempt: number;
  readonly delayMs: number;
  /** Value sent as `Last-Event-ID` (server seq when known). */
  readonly lastEventId: string | null;
}

/** Why the stream ended. */
export type ChatStreamDoneReason =
  | "terminal" // run.completed / run.failed / run.cancelled seen
  | "aborted" // user aborted or cancelled
  | "paused" // reconnect attempts exhausted — controller.reconnect() available
  | "closed" // stream closed cleanly without a terminal event, reconnect disabled
  | "error"; // non-retryable failure (stored on fatalError)

export interface ChatStreamSummary {
  readonly reason: ChatStreamDoneReason;
  readonly runId: string | null;
  readonly status: RunStatus;
}

export interface ChatStreamHandlers {
  /** Every normalized §7.4 event, in order — feed to your own reducer/UI too. */
  readonly onEvent?: (event: StudioStreamEvent) => void;
  /** Fatal, non-retryable failure (also stored on `fatalError`). */
  readonly onError?: (error: ApiError) => void;
  readonly onReconnect?: (info: ChatStreamReconnectInfo) => void;
  /** Reconnect attempts exhausted — run paused, `reconnect()` to resume. */
  readonly onPause?: (info: { readonly attempts: number }) => void;
  /** Fired exactly once per stream segment, whatever the reason. */
  readonly onDone?: (summary: ChatStreamSummary) => void;
}

export interface StreamChatOptions extends ChatStreamHandlers {
  readonly threadId: string;
  /** §7.2 chat body — validated client-side by CHAT_REQUEST_SCHEMA. */
  readonly body: unknown;
  /** Includes the version segment; default `/v1`. */
  readonly baseUrl?: string;
  /** Injectable fetch (client.ts passes its own). */
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Extra headers (auth) merged into both the chat POST and cancel POST. */
  readonly extraHeaders?: Record<string, string>;
  /** Idempotency keys for the cancel POST. */
  readonly idempotencyKeyFactory?: () => string;
  /** Sleep seam for reconnect backoff (tests inject zero-delay sleeps). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly reconnect?: ChatStreamReconnectConfig;
}

/** Live view of one chat run (single source of truth: the contracts reducer). */
export interface ChatStreamController {
  readonly state: RunState;
  readonly runId: string | null;
  readonly status: RunStatus;
  /** Assembled assistant text (all `message.delta`s, in order). */
  readonly text: string;
  readonly toolCalls: readonly ToolCallState[];
  readonly plan: EditPlan | null;
  readonly credits: RunCreditsState | null;
  readonly preview: RunPreviewState | null;
  readonly error: RunErrorState | null;
  readonly versionId: string | null;
  /** Highest §7.4 server seq seen (`-1` before the first). */
  readonly lastServerSeq: number;
  /** Raw SSE `id:` field, when the server uses it (opaque or numeric). */
  readonly lastEventId: string | null;
  /** Reconnect attempts exhausted — call `reconnect()` when the user retries. */
  readonly paused: boolean;
  readonly fatalError: ApiError | null;
  readonly cancelError: ApiError | null;
  /** Unnormalizable payloads (pre-run SDK parts, junk) — debugging aid. */
  readonly ignoredParts: number;
  /**
   * POSTs `/v1/runs/:id/cancel` (§8.3) and aborts the stream. Best-effort:
   * a failed cancel POST never rethrows — it lands on `cancelError`.
   */
  cancel(reason?: string): Promise<void>;
  /** Aborts the stream without cancelling server-side. */
  abort(): void;
  /** Manual retry after a pause (also usable while the run is alive). */
  reconnect(): Promise<void>;
  /** Resolves exactly once per stream segment (see `reconnect()`). */
  readonly done: Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Streams one chat run: POSTs the chat request, parses the AI-SDK UI stream
 * byte by byte, normalizes every part into §7.4 StudioStreamEvents, folds
 * them through `applyEvents`, and keeps the run resumable (reconnect with
 * backoff + Last-Event-ID; never a duplicate run — same idempotency key).
 *
 * Client-side validation failures throw synchronously (ApiError
 * VALIDATION_FAILED, status 0). Everything else is surfaced through
 * `onError`/`onPause`/`onDone` and the controller fields.
 */
export function streamChat(options: StreamChatOptions): ChatStreamController {
  let parsedBody: ChatRequest;
  try {
    parsedBody = CHAT_REQUEST_SCHEMA.parse(options.body);
  } catch (error) {
    if (isApiError(error)) throw error;
    throw new ApiError({
      code: "VALIDATION_FAILED",
      message: "That request didn't look right.",
      hint: "A chat message, context selection and idempotency key are required.",
      retryable: false,
      status: 0,
      cause: error,
    });
  }

  const baseUrl = (options.baseUrl ?? "/v1").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const extraHeaders = options.extraHeaders ?? {};
  const newKey = options.idempotencyKeyFactory ?? (() => crypto.randomUUID());
  const sleep = options.sleep ?? defaultSleep;
  const schedule = options.reconnect?.scheduleMs ?? RECONNECT_SCHEDULE_MS;
  const maxDelay = options.reconnect?.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
  const maxAuto = options.reconnect?.maxAutoAttempts ?? RECONNECT_MAX_AUTO_ATTEMPTS;
  const reconnectEnabled = options.reconnect?.enabled ?? true;

  const normalizer = new StreamEventNormalizer();
  const internalAbort = new AbortController();
  let state: RunState = applyEvents(INITIAL_RUN_STATE, { type: "run.submit" });
  let lastEventId: string | null = null;
  let paused = false;
  let fatal: ApiError | null = null;
  let cancelFailure: ApiError | null = null;
  let userStopped = false; // signal abort / abort() / cancel()
  let terminalSeen = false;
  let attempt = 0;
  let resolved = true;
  let donePromise: Promise<void> = Promise.resolve();
  let resolveDone: () => void = () => {};

  const emit = (event: StudioStreamEvent): void => {
    state = applyEvents(state, event);
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      terminalSeen = true;
    }
    options.onEvent?.(event);
  };

  const handleMessage = (message: SseMessage): void => {
    if (message.id !== undefined && message.id !== "" && !message.id.includes("\0")) {
      lastEventId = message.id;
    }
    const { data } = message;
    if (data === "" || data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      normalizer.recordJunk();
      return;
    }
    for (const event of normalizer.ingest(parsed)) emit(event);
  };

  const chatUrl = `${baseUrl}/threads/${encodeURIComponent(options.threadId)}/chat`;

  const replayId = (): string | null =>
    normalizer.lastServerSeq >= 0 ? String(normalizer.lastServerSeq) : (lastEventId ?? null);

  const buildHeaders = (isReconnect: boolean): Headers => {
    const headers = new Headers(extraHeaders);
    headers.set("Accept", "text/event-stream");
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", parsedBody.idempotencyKey);
    if (isReconnect) {
      const id = replayId();
      if (id !== null) headers.set("Last-Event-ID", id);
    }
    return headers;
  };

  const finish = (reason: ChatStreamDoneReason): void => {
    if (resolved) return;
    resolved = true;
    resolveDone();
    options.onDone?.({ reason, runId: state.runId, status: state.status });
  };

  const goFatal = (error: ApiError): void => {
    fatal = error;
    options.onError?.(error);
    finish("error");
  };

  /** Decide what a retryable failure means: backoff-retry, pause, or give up. */
  const pauseOrFatal = (error: ApiError): "retry" | "stop" => {
    if (!reconnectEnabled || userStopped) {
      goFatal(error);
      return "stop";
    }
    if (attempt >= maxAuto) {
      paused = true;
      options.onPause?.({ attempts: attempt });
      finish("paused");
      return "stop";
    }
    return "retry";
  };

  const backoff = async (): Promise<void> => {
    const base = schedule[Math.min(attempt, schedule.length - 1)] ?? maxDelay;
    const delayMs = Math.min(base, maxDelay);
    attempt += 1;
    options.onReconnect?.({ attempt, delayMs, lastEventId: replayId() });
    await sleepWithAbort(sleep, delayMs, internalAbort.signal);
  };

  const pump = async (
    body: ReadableStream<Uint8Array>,
  ): Promise<"terminal" | "closed" | "aborted"> => {
    const parser = createSseParser(handleMessage);
    const reader = body.getReader();

    // Real fetch bodies error on abort (undici + browsers), but the reader
    // may be parked in a pending read; race it so "pause on abort" is
    // immediate in every environment. The guard catch keeps the race
    // promise from surfacing as an unhandled rejection later.
    const rejectOnAbort = new Promise<never>((_, reject) => {
      if (internalAbort.signal.aborted) {
        reject(getAbortError(internalAbort.signal));
        return;
      }
      internalAbort.signal.addEventListener(
        "abort",
        () => {
          reject(getAbortError(internalAbort.signal));
        },
        { once: true },
      );
    });
    rejectOnAbort.catch(() => {});

    for (;;) {
      let chunk: Uint8Array | undefined;
      try {
        const read = await Promise.race([reader.read(), rejectOnAbort]);
        if (read.done) break;
        chunk = read.value;
      } catch (error) {
        if (isAbortError(error) || internalAbort.signal.aborted) return "aborted";
        throw networkError(error); // dropped mid-stream
      }
      if (chunk !== undefined) parser.push(chunk);
      if (terminalSeen) {
        void reader.cancel().catch(() => {});
        return "terminal";
      }
    }
    parser.end();
    return terminalSeen ? "terminal" : "closed";
  };

  /** 2xx with a JSON envelope where a stream was expected (§7.3 decides). */
  const jsonEnvelopeResponse = async (response: Response): Promise<boolean> => {
    const contentType = response.headers?.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return false;
    let json: unknown;
    try {
      json = JSON.parse(await response.text());
    } catch {
      return true; // consumed; treated as malformed below
    }
    if (isErr(json)) {
      const error = json.error;
      goFatal(
        new ApiError({
          code: error.code,
          message: error.message,
          hint: error.hint,
          retryable: error.retryable,
          requestId: error.requestId,
          status: response.status,
        }),
      );
      return true;
    }
    return true; // Ok envelope / junk — not a stream
  };

  const runLoop = async (): Promise<void> => {
    for (;;) {
      if (userStopped) {
        finish("aborted");
        return;
      }
      if (terminalSeen) {
        finish("terminal");
        return;
      }

      let response: Response;
      try {
        response = await fetchImpl(chatUrl, {
          method: "POST",
          headers: buildHeaders(attempt > 0),
          body: JSON.stringify(parsedBody),
          signal: internalAbort.signal,
        });
      } catch (error) {
        if (isAbortError(error) || internalAbort.signal.aborted) {
          finish("aborted");
          return;
        }
        if (pauseOrFatal(networkError(error)) === "stop") return;
        await backoff();
        continue;
      }

      if (!response.ok) {
        const apiError = await fromResponse(response);
        if (!apiError.retryable) {
          goFatal(apiError);
          return;
        }
        if (pauseOrFatal(apiError) === "stop") return;
        await backoff();
        continue;
      }

      // §7.3: the envelope decides — a 200 may still carry an Err body.
      if (await jsonEnvelopeResponse(response)) {
        if (resolved || fatal !== null) return; // Err envelope already fatal
        const malformed = networkError(new Error("chat response was not an event stream"));
        if (pauseOrFatal(malformed) === "stop") return;
        await backoff();
        continue;
      }

      if (response.body === null) {
        const malformed = networkError(new Error("stream response had no body"));
        if (pauseOrFatal(malformed) === "stop") return;
        await backoff();
        continue;
      }

      let outcome: "terminal" | "closed" | "aborted";
      try {
        outcome = await pump(response.body);
      } catch (error) {
        if (isApiError(error)) {
          // A dropped stream is resumable — same idempotency key, Last-Event-ID.
          if (pauseOrFatal(error) === "stop") return;
          await backoff();
          continue;
        }
        if (isAbortError(error) || internalAbort.signal.aborted) {
          finish("aborted");
          return;
        }
        if (pauseOrFatal(networkError(error)) === "stop") return;
        await backoff();
        continue;
      }

      if (outcome === "terminal") {
        finish("terminal");
        return;
      }
      if (outcome === "aborted") {
        finish("aborted");
        return;
      }

      // Clean close without a terminal §7.4 event: the connection dropped
      // (§8.4) unless reconnecting is disabled, in which case end honestly.
      if (!reconnectEnabled) {
        finish("closed");
        return;
      }
      const dropped = networkError(new Error("stream closed before the run finished"));
      if (pauseOrFatal(dropped) === "stop") return;
      await backoff();
    }
  };

  const wireSignal = (): void => {
    const signal = options.signal;
    if (signal === undefined) return;
    if (signal.aborted) {
      userStopped = true;
      internalAbort.abort(signal.reason);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        userStopped = true;
        internalAbort.abort(signal.reason);
      },
      { once: true },
    );
  };

  const startSegment = (): void => {
    resolved = false;
    donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
  };

  const controller: ChatStreamController = {
    get state() {
      return state;
    },
    get runId() {
      return state.runId ?? normalizer.runId;
    },
    get status() {
      return state.status;
    },
    get text() {
      return state.text;
    },
    get toolCalls() {
      return state.toolCalls;
    },
    get plan() {
      return state.plan;
    },
    get credits() {
      return state.credits;
    },
    get preview() {
      return state.preview;
    },
    get error() {
      return state.error;
    },
    get versionId() {
      return state.versionId;
    },
    get lastServerSeq() {
      return normalizer.lastServerSeq;
    },
    get lastEventId() {
      return lastEventId;
    },
    get paused() {
      return paused;
    },
    get fatalError() {
      return fatal;
    },
    get cancelError() {
      return cancelFailure;
    },
    get ignoredParts() {
      return normalizer.ignoredCount;
    },
    get done() {
      return donePromise;
    },
    async cancel(reason) {
      userStopped = true;
      internalAbort.abort();
      const runId = state.runId;
      if (runId === null) return;
      try {
        const headers = new Headers(extraHeaders);
        headers.set("Content-Type", "application/json");
        headers.set("Idempotency-Key", newKey());
        const response = await fetchImpl(`${baseUrl}/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify(reason === undefined ? {} : { reason }),
        });
        if (!response.ok) cancelFailure = await fromResponse(response);
      } catch (error) {
        if (!isAbortError(error)) cancelFailure = networkError(error);
      }
    },
    abort() {
      userStopped = true;
      internalAbort.abort();
    },
    async reconnect() {
      if (userStopped || terminalSeen) return;
      if (!paused && !resolved) return; // still streaming
      paused = false;
      attempt = 0;
      startSegment();
      await runLoop();
    },
  };

  wireSignal();
  startSegment();
  runLoop().catch((error) => {
    // Belt-and-braces: runLoop is written never to reject, but an escape
    // must never surface as an unhandled rejection.
    if (!isAbortError(error) && internalAbort.signal.aborted === false) {
      goFatal(networkError(error));
      return;
    }
    finish("aborted");
  });
  return Object.freeze(controller);
}
