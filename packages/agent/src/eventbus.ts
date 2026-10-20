// @studio/agent — durable-first SSE run-event bus. Owner: W2-P (docs/AGENTS.md).
//
// Spec anchors:
//   §13.2  events carry `{ seq, run_id, at, type, payload }`; the client dedupes
//          by `seq` and resumes with `Last-Event-ID` (backfill from `run_events`,
//          then live — endpoint `GET /v1/runs/:id/events`).
//   §22    request/run correlation: every event row carries run/workspace ids;
//          durability over latency (the publish ack awaits the durable append);
//          prompt-log redaction unless the workspace opts in.
//   §15.3  user text is data; the durable record stays complete for retention
//          (§15.3 window), while DELIVERIES are redacted by policy.
//
// Architecture (who owns what):
//   - The WORKER publishes run events here (the only writer).
//   - The GATEWAY wires `EventStoreLike` to the `run_events` table (W1-E,
//     packages/db/src/schema/runs.ts: bigint `seq`, unique(run_id, seq)) and
//     consumes `subscribe()` for the SSE endpoint (Last-Event-ID → `fromSeq`).
//
// Durability model: `publish()` allocates a per-run monotonic `seq` from an
// in-memory counter initialized from the store's max seq (a new bus instance
// over the same store continues the sequence — no reuse, no gap), awaits
// `store.append` BEFORE acking (§22 durability over latency), and only then
// fans out to live subscribers. A failed append does NOT advance the counter,
// so the next publish re-allocates the same seq and the stream stays gapless
// (gap-guard).
//
// Delivery model: `subscribe()` registers the live listener FIRST, then
// backfills from `store.sinceSeq` (paged), then flushes the live events that
// arrived during the backfill — merged by seq, so nothing is missed and
// nothing is delivered twice. Each subscriber holds a bounded queue: when it
// fills (a slow SSE consumer) the OLDEST queued events are shed (drop-slowest
// policy — only the slow subscriber loses data; healthy subscribers are never
// blocked by it). Loss is not silent: the next delivered event is flagged
// `resync: true` (seq gap), which tells the SSE layer to end the response so
// the client reconnects with Last-Event-ID and re-heals from the durable
// store. Shed events can also be healed transparently when backfill still
// covers their seq (the gap never reaches the consumer, so no flag).

import {
  buildRunEvent,
  type RunEventFor,
  type RunEventPayloadMap,
  type RunEventType,
  isTerminalRunEventType,
} from "./events.js";

// --- Store seam ------------------------------------------------------------------------

/**
 * The durable event row to append (the `run_events` columns W1-E defined, minus
 * the pk). `seq` is a bigint column in Postgres but a `number` here — a run can
 * never approach 2^53 events (§5.2 tier budgets cap tool calls at 24).
 */
export interface StoredEventAppend {
  readonly seq: number;
  readonly type: RunEventType;
  /** Raw payload (pre-redaction): the durable record is complete (§15.3). */
  readonly payload: unknown;
  /** §22 correlation timestamps on stored rows are ISO 8601 strings. */
  readonly at: string;
  /** §22 correlation + §12.2 tenant column on every `run_events` row. */
  readonly organizationId: string;
}

/** A persisted event row as `sinceSeq` returns it (ascending by `seq`). */
export interface StoredEventRow extends StoredEventAppend {}

/**
 * The durable sink the gateway wires to the `run_events` table via drizzle:
 * `append` inserts one row; `sinceSeq` returns rows with `seq > afterSeq`,
 * at most `limit`, ordered ascending (Last-Event-ID backfill, §13.2).
 *
 * `maxSeq` is optional: when present it is the authoritative highest seq for a
 * run (drizzle `max(seq)`); when absent the bus derives it from `sinceSeq`
 * (bounded scan — §5.2 budgets keep a run's event count far below the cap).
 */
export interface EventStoreLike {
  append(runId: string, row: StoredEventAppend): Promise<void>;
  sinceSeq(runId: string, afterSeq: number, limit: number): Promise<readonly StoredEventRow[]>;
  maxSeq?(runId: string): Promise<number>;
}

// --- Tunables ---------------------------------------------------------------------------

/** Per-subscriber queue bound (§13.2 streams are small; runs emit ~tens of events). */
export const DEFAULT_SUBSCRIBER_QUEUE_CAP = 256;
/** Backfill page size passed to `store.sinceSeq`. */
export const DEFAULT_BACKFILL_PAGE_LIMIT = 128;
/** Backfill page cap — 64 × 128 ≫ any §5.2-budgeted run timeline. */
export const DEFAULT_MAX_BACKFILL_PAGES = 64;
/**
 * Fallback max-seq scan bound when the adapter provides no `maxSeq`:
 * `sinceSeq(runId, 0, SEQ_SCAN_CAP)`, take the last row. §5.2 budgets
 * (≤ 24 tool calls per run) make a longer run implausible; hitting the cap
 * surfaces as a unique(run_id, seq) append failure instead of silent overwrite.
 */
const SEQ_SCAN_CAP = 4096;

// --- Failure envelopes (self-contained, house shape per W2 precedent) -------------------

export const EVENT_BUS_ERROR_CODES = [
  // A store read (maxSeq / sinceSeq backfill) failed. Retryable: the store is
  // the source of truth and nothing was mutated.
  "event_store_unavailable",
  // `store.append` failed; the seq counter was rolled back (gap-guard), so the
  // same publish can be retried. Retryable.
  "event_persist_failed",
  // The run is already published under another organization (§15.1 tenant
  // hygiene: a run belongs to exactly one org — never cross-deliver).
  "organization_mismatch",
] as const satisfies readonly string[];

export type EventBusErrorCode = (typeof EVENT_BUS_ERROR_CODES)[number];

export interface EventBusFailure {
  readonly ok: false;
  readonly code: EventBusErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type PublishResult<T extends RunEventType> =
  | { readonly ok: true; readonly event: CorrelatedRunEvent<T> }
  | EventBusFailure;

function eventBusFailure(
  code: EventBusErrorCode,
  message: string,
  options: { hint?: string; retryable?: boolean } = {},
): EventBusFailure {
  const failure: { ok: false; code: EventBusErrorCode; message: string; hint?: string; retryable?: boolean } = {
    ok: false,
    code,
    message,
  };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  return failure;
}

// --- Correlation (§22) -------------------------------------------------------------------

/** A run event correlated per §22: W1-P's `RunEventFor` + the tenant root. */
export interface CorrelatedRunEvent<T extends RunEventType = RunEventType> extends RunEventFor<T> {
  readonly organizationId: string;
}

// --- Redaction (§22 / §15.3) ---------------------------------------------------------------

/** Marker replacing redacted strings on delivered events (§22 log redaction). */
export const REDACTED = "[redacted]";

export interface RedactionContext {
  /** §12.2 tenant root — policies key workspace opt-in on it (§22). */
  readonly organizationId: string;
  readonly runId: string;
}

/**
 * Injectable payload transform applied at DELIVERY time (live fan-out and
 * backfill alike) — the durable store keeps the raw payload (§15.3 retention;
 * `agent_runs.prompt` is the canonical prompt record anyway).
 *
 * A policy must preserve the payload's shape: `redactPayload` returns the same
 * type it receives, with only field VALUES transformed.
 */
export interface RedactionPolicy {
  redactPayload(
    type: RunEventType,
    payload: RunEventPayloadMap[RunEventType],
    context: RedactionContext,
  ): RunEventPayloadMap[RunEventType];
}

/** Default-policy opt-in: fixed flag or a per-workspace predicate (§22). */
export type PromptTextOptIn = boolean | ((organizationId: string) => boolean);

export interface DefaultRedactionOptions {
  /** §22 opt-in — defaults to false (redact everything sensitive). */
  readonly promptTextOptIn?: PromptTextOptIn;
}

/**
 * Key tokens whose VALUES are treated as user prompt-like text (§22 "log
 * redaction for prompts"): user briefs, text-layer copy, slot fills, critic
 * observations, model-facing notes. Tokenized on non-alphanumerics, so
 * `user_text`, `promptText` and `notes_for_user` all match.
 */
const SENSITIVE_KEY_TOKENS: ReadonlySet<string> = new Set([
  "prompt",
  "brief",
  "text",
  "copy",
  "content",
  "note",
  "notes",
  "observation",
  "fix",
  "question",
  "answer",
  "user",
  "caption",
  "headline",
  "title",
  "body",
]);

/**
 * Curated, safe-at-the-source fields that are never redacted (§13.3 error
 * envelopes are built for user display and by construction carry no raw user
 * text; `run.cancelled.reason` is the same kind of curated string).
 */
const CURATED_KEYS: ReadonlySet<string> = new Set(["error", "reason"]);

const MAX_REDACTION_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  const tokens = key.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  return tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep transform: replaces every string under a sensitive key (or anywhere in
 * a sensitive subtree) with `REDACTED`; leaves scalars and curated envelopes
 * alone. Immutable: returns a new tree, never mutates the published payload.
 */
function redactTree(value: unknown, depth: number, subtreeSensitive: boolean): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    return value;
  }
  if (typeof value === "string") {
    return subtreeSensitive ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactTree(item, depth + 1, subtreeSensitive));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (subtreeSensitive) {
        out[key] = redactTree(child, depth + 1, true);
      } else if (CURATED_KEYS.has(key)) {
        out[key] = child; // curated envelope — verbatim
      } else {
        out[key] = redactTree(child, depth + 1, isSensitiveKey(key));
      }
    }
    return out;
  }
  return value;
}

/**
 * The §22 default: redact every user prompt-like string unless the workspace
 * opted in. Known payload shapes get structural treatment on top of the key
 * rules — `run.plan.slots` values are §6.2 text-slot fills (user copy
 * regardless of slot name) and `plan.notes_for_user` may paraphrase the brief;
 * §11.2 critic issues may quote document text.
 */
export class DefaultRedactionPolicy implements RedactionPolicy {
  readonly #promptTextOptIn: PromptTextOptIn;

  constructor(options: DefaultRedactionOptions = {}) {
    this.#promptTextOptIn = options.promptTextOptIn ?? false;
  }

  #optedIn(organizationId: string): boolean {
    return typeof this.#promptTextOptIn === "function"
      ? this.#promptTextOptIn(organizationId)
      : this.#promptTextOptIn;
  }

  redactPayload(
    type: RunEventType,
    payload: RunEventPayloadMap[RunEventType],
    context: RedactionContext,
  ): RunEventPayloadMap[RunEventType] {
    if (this.#optedIn(context.organizationId)) {
      return payload; // §22: this workspace opted in — deliver as-is.
    }
    if (type === "run.plan") {
      const plan = payload as RunEventPayloadMap["run.plan"];
      return {
        plan: {
          ...plan.plan,
          // §6.2 text slots: values are user copy, whatever the slot is named.
          slots: Object.fromEntries(Object.keys(plan.plan.slots).map((slot) => [slot, REDACTED])),
          notes_for_user: REDACTED,
          steps: plan.plan.steps.map((step) => redactTree(step, 0, false)),
          typography: redactTree(plan.plan.typography, 0, false) as typeof plan.plan.typography,
        },
      } as RunEventPayloadMap[RunEventType];
    }
    if (type === "critique.report") {
      const report = payload as RunEventPayloadMap["critique.report"];
      return {
        ...report,
        issues: report.issues.map((issue) => ({
          ...issue,
          observation: REDACTED, // §11.2: may quote rendered/user text.
          fix: REDACTED,
        })),
      } as RunEventPayloadMap[RunEventType];
    }
    // Generic key-based pass for every other type (and future fields).
    return redactTree(payload, 0, false) as RunEventPayloadMap[RunEventType];
  }
}

// --- Subscriptions ------------------------------------------------------------------------

/** One delivered event, plus the §13.2 resync signal. */
export interface EventDelivery {
  readonly event: CorrelatedRunEvent;
  /**
   * True when a seq gap was detected before this event (missed or shed
   * events). The SSE layer ends the response on `resync` so the client
   * reconnects with `Last-Event-ID` = the last seq it received; backfill
   * re-heals from the durable store. Shed-during-backfill that backfill later
   * covers does NOT flag (the consumer saw a contiguous stream).
   */
  readonly resync: boolean;
}

export type StreamEndReason =
  | "terminal" // a §13.2 terminal event was delivered (the client closes after it)
  | "unsubscribed"
  | "closed" // bus.close() — shutdown
  | "backfill_failed"; // store read failed; SSE should retry the connection

export interface StreamEnd {
  readonly reason: StreamEndReason;
  readonly failure?: EventBusFailure;
  /**
   * Checkpoint at the moment the stream ENDED; the subscription getters stay
   * live while already-queued events keep draining, so read
   * `subscription.lastDeliveredSeq` afterwards for the final value.
   */
  readonly lastDeliveredSeq: number;
}

export interface SubscribeOptions {
  /** §13.2 `Last-Event-ID`: deliver events with `seq > fromSeq` (default 0). */
  readonly fromSeq?: number;
  /** §15.1 tenant filter: skip rows / live events from another organization. */
  readonly organizationId?: string;
  /** Per-subscriber backpressure cap override. */
  readonly queueCap?: number;
}

export interface RunEventSubscription {
  readonly runId: string;
  /** Highest seq actually handed to the consumer (Last-Event-ID checkpoint). */
  readonly lastDeliveredSeq: number;
  /** Events shed from this subscriber's queue by the drop-slowest policy. */
  readonly dropped: number;
  /** Sticky: a seq gap reached the consumer (shed or store hole). */
  readonly needsResync: boolean;
  readonly ended: boolean;

  /** Iterator mode: `for await (const delivery of sub)` until end/terminal. */
  [Symbol.asyncIterator](): AsyncIterator<EventDelivery, undefined, undefined>;
  /** Callback mode: invoked per delivery; returns an unregister function. */
  onDelivery(callback: (delivery: EventDelivery) => void): () => void;
  /** Fires once when the stream ends (terminal, unsubscribe, close, backfill failure). */
  onEnd(callback: (end: StreamEnd) => void): () => void;
  unsubscribe(): void;
}

type DeliveryWaiter = (result: IteratorResult<EventDelivery, undefined>) => void;
type EndListener = (end: StreamEnd) => void;

/**
 * One live consumer. Holds a bounded FIFO of undelivered (already-redacted)
 * events plus a `pending` buffer for live events that arrive while the store
 * backfill is still running (they must not jump ahead of unfetched history).
 */
class Subscriber implements RunEventSubscription {
  readonly runId: string;
  readonly #bus: RunEventBus;
  readonly #organizationFilter: string | null;
  readonly #queueCap: number;
  readonly #queue: CorrelatedRunEvent[] = [];
  readonly #pending: CorrelatedRunEvent[] = [];
  readonly #waiters: DeliveryWaiter[] = [];
  readonly #endListeners = new Set<EndListener>();
  #callback: ((delivery: EventDelivery) => void) | null = null;
  #drainScheduled = false;
  #backfillActive = true;
  #terminalSeq: number | null = null;
  #ended = false;
  #lastEnd: StreamEnd | null = null;
  #lastDeliveredSeq: number;
  #dropped = 0;
  #needsResync = false;

  constructor(bus: RunEventBus, runId: string, options: SubscribeOptions, defaultQueueCap: number) {
    this.runId = runId;
    this.#bus = bus;
    this.#organizationFilter = options.organizationId ?? null;
    this.#queueCap = Math.max(1, options.queueCap ?? defaultQueueCap);
    this.#lastDeliveredSeq = options.fromSeq ?? 0;
  }

  get lastDeliveredSeq(): number {
    return this.#lastDeliveredSeq;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get needsResync(): boolean {
    return this.#needsResync;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** @internal — §15.1 tenant filter for backfill rows. */
  get organizationFilter(): string | null {
    return this.#organizationFilter;
  }

  // -- producer side (called from publish fan-out / backfill merge) ----------------------

  /** Live event from `publish` fan-out (already redacted by the bus). */
  liveEnqueue(event: CorrelatedRunEvent): void {
    if (this.#ended || !this.#accepts(event)) {
      return;
    }
    if (this.#backfillActive) {
      // History is still being fetched: hold live events so they cannot
      // overtake unfetched store rows (merged by seq at flush time).
      this.#pending.push(event);
      this.#shedOverflow();
      return;
    }
    this.#enqueueToQueue(event);
  }

  /** Backfill row merged into the stream (already redacted + org-filtered). */
  backfillEnqueue(event: CorrelatedRunEvent): void {
    if (this.#ended) {
      return;
    }
    this.#enqueueToQueue(event);
  }

  /** Smallest live seq waiting in `pending` (merge stop boundary), or null. */
  pendingFloor(): number | null {
    const first = this.#pending[0];
    return first === undefined ? null : first.seq;
  }

  /** @internal — Last-Event-ID sanity clamp, before any delivery happens. */
  clampCheckpoint(maxSeq: number): void {
    if (maxSeq < this.#lastDeliveredSeq) {
      this.#lastDeliveredSeq = maxSeq;
    }
  }

  /** Live-buffered events flush in seq order once backfill completes. */
  flushPending(): void {
    this.#backfillActive = false;
    while (this.#pending.length > 0 && !this.#ended) {
      const event = this.#pending.shift();
      if (event !== undefined) {
        this.#enqueueToQueue(event);
      }
    }
  }

  backfillFailed(failure: EventBusFailure): void {
    this.end("backfill_failed", failure);
  }

  /** Backfill saw a §13.2 terminal row — end the stream once it is drained. */
  noteTerminalRow(seq: number): void {
    this.#terminalSeq = seq;
  }

  // -- consumer side -----------------------------------------------------------------------

  [Symbol.asyncIterator](): AsyncIterator<EventDelivery, undefined, undefined> {
    return {
      next: (): Promise<IteratorResult<EventDelivery, undefined>> => this.#pull(),
      return: (): Promise<IteratorResult<EventDelivery, undefined>> => {
        this.unsubscribe();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  onDelivery(callback: (delivery: EventDelivery) => void): () => void {
    this.#callback = callback;
    this.#scheduleCallbackDrain();
    return () => {
      if (this.#callback === callback) {
        this.#callback = null;
      }
    };
  }

  onEnd(callback: (end: StreamEnd) => void): () => void {
    if (this.#ended && this.#lastEnd !== null) {
      callback(this.#lastEnd); // stream already ended — replay once, no double-fire
      return () => undefined;
    }
    this.#endListeners.add(callback);
    return () => {
      this.#endListeners.delete(callback);
    };
  }

  unsubscribe(): void {
    this.#bus.removeSubscriber(this);
    this.end("unsubscribed");
  }

  end(reason: StreamEndReason, failure?: EventBusFailure): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    // Waiters only ever park on an empty queue (enqueues wake them), so
    // resolving them done can never strand a queued event; later #pull calls
    // drain any remaining queue BEFORE reporting done.
    const waiters = [...this.#waiters];
    this.#waiters.length = 0;
    for (const waiter of waiters) {
      waiter({ done: true, value: undefined });
    }
    const end: StreamEnd = { reason, failure, lastDeliveredSeq: this.#lastDeliveredSeq };
    this.#lastEnd = end;
    for (const listener of [...this.#endListeners]) {
      try {
        listener(end); // listener errors never propagate into the bus
      } catch {
        // swallowed by design: a broken listener must not break the stream
      }
    }
    this.#endListeners.clear();
    // In callback mode the queue keeps draining (terminal events must reach
    // the consumer); the callback is released once the queue runs dry.
    this.#scheduleCallbackDrain();
  }

  // -- internals -----------------------------------------------------------------------------

  #accepts(event: CorrelatedRunEvent): boolean {
    return this.#organizationFilter === null || event.organizationId === this.#organizationFilter;
  }

  #enqueueToQueue(event: CorrelatedRunEvent): void {
    this.#queue.push(event);
    this.#shedOverflow();
    this.#wakeOrDrain();
  }

  /**
   * Drop-slowest backpressure (§13.2): only THIS (slow) subscriber sheds; the
   * oldest events go first — the newest keep flowing so a reconnecting client
   * has a fresh Last-Event-ID checkpoint to resume from. The durable store
   * makes the loss recoverable (client reconnects with Last-Event-ID).
   *
   * The live `pending` buffer is shed BEFORE queued history while backfill is
   * still running: shed live seqs sit above the backfill cursor and get
   * re-fetched (healed) by later pages, whereas shed queued history is gone
   * (the cursor already passed it) and only recoverable via client resync.
   */
  #shedOverflow(): void {
    while (this.#queue.length + this.#pending.length > this.#queueCap) {
      const oldest = this.#pending.length > 0 ? this.#pending.shift() : this.#queue.shift();
      if (oldest === undefined) {
        break;
      }
      this.#dropped += 1;
    }
  }

  #wakeOrDrain(): void {
    if (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      const delivery = this.#nextDelivery();
      if (waiter !== undefined) {
        waiter(delivery === null ? { done: true, value: undefined } : { done: false, value: delivery });
      }
      return;
    }
    this.#scheduleCallbackDrain();
  }

  #scheduleCallbackDrain(): void {
    if (this.#callback === null || this.#drainScheduled) {
      return;
    }
    this.#drainScheduled = true;
    void Promise.resolve().then(() => {
      this.#drainScheduled = false;
      this.#drainIntoCallback();
    });
  }

  #drainIntoCallback(): void {
    const callback = this.#callback;
    if (callback === null) {
      return;
    }
    while (this.#queue.length > 0) {
      const delivery = this.#nextDelivery();
      if (delivery === null) {
        return;
      }
      try {
        callback(delivery); // callback exceptions never propagate into publish
      } catch {
        return; // stop draining this tick; the next enqueue reschedules
      }
    }
    if (this.#ended) {
      this.#callback = null; // stream is over and the queue ran dry
    }
  }

  #pull(): Promise<IteratorResult<EventDelivery, undefined>> {
    const delivery = this.#nextDelivery();
    if (delivery !== null) {
      return Promise.resolve({ done: false, value: delivery });
    }
    if (this.#ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<EventDelivery, undefined>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /**
   * Dequeues one delivery with drain-time gap detection: `resync` is flagged
   * when the event's seq is not exactly `lastDeliveredSeq + 1` (§13.2), and
   * events at or below the checkpoint are skipped (server-side seq dedupe, so
   * merge overlap can never double-deliver).
   */
  #nextDelivery(): EventDelivery | null {
    while (this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (event === undefined) {
        return null;
      }
      if (event.seq <= this.#lastDeliveredSeq) {
        continue; // already delivered to this consumer (merge overlap)
      }
      const resync = event.seq > this.#lastDeliveredSeq + 1;
      if (resync) {
        this.#needsResync = true;
      }
      this.#lastDeliveredSeq = event.seq;
      const delivery: EventDelivery = { event, resync };
      if (isTerminalRunEventType(event.type)) {
        this.end("terminal");
      }
      return delivery;
    }
    if (this.#ended) {
      return null;
    }
    if (this.#terminalSeq !== null && !this.#backfillActive) {
      // Backfill delivered the run's terminal row: close the stream after it
      // (covers the org-filtered-row case where the live path never fires).
      this.end("terminal");
    }
    return null;
  }
}

// --- The bus --------------------------------------------------------------------------------

export interface RunEventBusOptions {
  /** The durable sink (gateway wires it to `run_events` via drizzle). */
  readonly store: EventStoreLike;
  /** §22 redaction policy — default: redact everything sensitive. */
  readonly redaction?: RedactionPolicy;
  readonly queueCap?: number;
  readonly backfillPageLimit?: number;
  readonly maxBackfillPages?: number;
}

export interface PublishOptions {
  /** §22 correlation: the organization that owns the run (tenant root, §12.2). */
  readonly organizationId: string;
}

interface RunState {
  lastSeq: number;
  seqReady: boolean;
  organizationId: string | null;
  subscribers: Set<Subscriber>;
  /** Per-run publish serializer: seq allocation + append are strictly ordered. */
  chain: Promise<unknown>;
}

/**
 * Durable-first run event bus (§13.2). One instance per process; safe to share
 * across runs — all per-run bookkeeping is keyed by `runId`.
 */
export class RunEventBus {
  readonly #store: EventStoreLike;
  readonly #redaction: RedactionPolicy;
  readonly #queueCap: number;
  readonly #backfillPageLimit: number;
  readonly #maxBackfillPages: number;
  readonly #runs = new Map<string, RunState>();
  #closed = false;

  constructor(options: RunEventBusOptions) {
    this.#store = options.store;
    this.#redaction = options.redaction ?? new DefaultRedactionPolicy();
    this.#queueCap = options.queueCap ?? DEFAULT_SUBSCRIBER_QUEUE_CAP;
    this.#backfillPageLimit = options.backfillPageLimit ?? DEFAULT_BACKFILL_PAGE_LIMIT;
    this.#maxBackfillPages = options.maxBackfillPages ?? DEFAULT_MAX_BACKFILL_PAGES;
  }

  /**
   * Publishes one event: allocate seq → `store.append` (awaited — §22
   * durability over latency) → fan out to live subscribers. Terminal events
   * (§13.2) close every live stream for the run after delivery.
   *
   * Never throws: failures come back as typed envelopes. A failed append rolls
   * the seq counter back, so the sequence stays gapless (safe to retry).
   */
  publish<T extends RunEventType>(
    runId: string,
    type: T,
    payload: RunEventPayloadMap[T],
    options: PublishOptions,
  ): Promise<PublishResult<T>> {
    const state = this.#runState(runId);
    const prior = state.chain;
    const result = prior.then(() => this.#publishOne(runId, state, type, payload, options));
    state.chain = result.then(
      () => undefined,
      () => undefined, // the chain itself never rejects; failures go to the caller
    );
    return result;
  }

  /**
   * Subscribes to a run's stream: durable backfill from `fromSeq`
   * (Last-Event-ID, §13.2) and then live delivery, with per-subscriber
   * drop-slowest backpressure and drain-time gap detection (`resync` flags).
   */
  subscribe(runId: string, options: SubscribeOptions = {}): RunEventSubscription {
    const subscriber = new Subscriber(this, runId, options, this.#queueCap);
    const state = this.#runState(runId);
    state.subscribers.add(subscriber);
    if (this.#closed) {
      subscriber.end("closed");
      return subscriber;
    }
    void this.#backfill(subscriber, options.fromSeq ?? 0);
    return subscriber;
  }

  /** Ends every live stream (shutdown); future publishes still persist. */
  close(): void {
    this.#closed = true;
    for (const state of this.#runs.values()) {
      for (const subscriber of [...state.subscribers]) {
        subscriber.end("closed");
      }
      state.subscribers.clear();
    }
    this.#runs.clear();
  }

  /** @internal — Subscriber.unsubscribe hook. */
  removeSubscriber(subscriber: Subscriber): void {
    const state = this.#runs.get(subscriber.runId);
    if (state !== undefined) {
      state.subscribers.delete(subscriber);
    }
  }

  #runState(runId: string): RunState {
    let state = this.#runs.get(runId);
    if (state === undefined) {
      state = {
        lastSeq: 0,
        seqReady: false,
        organizationId: null,
        subscribers: new Set<Subscriber>(),
        chain: Promise.resolve(),
      };
      this.#runs.set(runId, state);
    }
    return state;
  }

  async #publishOne<T extends RunEventType>(
    runId: string,
    state: RunState,
    type: T,
    payload: RunEventPayloadMap[T],
    options: PublishOptions,
  ): Promise<PublishResult<T>> {
    // §15.1: a run belongs to exactly one organization — fail loudly on drift.
    if (state.organizationId === null) {
      state.organizationId = options.organizationId;
    } else if (state.organizationId !== options.organizationId) {
      return eventBusFailure("organization_mismatch", "run is owned by another organization", {
        hint: "publish with the organization that owns this run",
        retryable: false,
      });
    }
    if (!state.seqReady) {
      const loaded = await this.#loadMaxSeq(runId);
      if (!loaded.ok) {
        return loaded;
      }
      state.lastSeq = loaded.seq;
      state.seqReady = true;
    }
    // Gap-guard: the counter only advances AFTER a successful append, so a
    // failed publish leaves seq unallocated and the next publish reuses it.
    const seq = state.lastSeq + 1;
    const built = buildRunEvent(type, { seq, runId, at: new Date(), payload });
    const event: CorrelatedRunEvent<T> = { ...built, organizationId: options.organizationId };
    try {
      await this.#store.append(runId, {
        seq,
        type,
        payload, // raw payload — the durable record is complete (§15.3)
        at: event.at.toISOString(),
        organizationId: options.organizationId,
      });
    } catch {
      return eventBusFailure("event_persist_failed", "could not persist the run event", {
        hint: "seq counter rolled back; safe to retry the same publish",
        retryable: true,
      });
    }
    state.lastSeq = seq;
    this.#fanOut(event);
    if (isTerminalRunEventType(type)) {
      // §13.2: the client closes the stream after a terminal event — end every
      // live stream (draining first), then forget the run; a later publish
      // re-initializes its counter from the store (durable-first).
      for (const subscriber of [...state.subscribers]) {
        subscriber.end("terminal");
      }
      state.subscribers.clear();
      this.#runs.delete(runId);
    }
    return { ok: true, event };
  }

  async #loadMaxSeq(runId: string): Promise<{ ok: true; seq: number } | EventBusFailure> {
    try {
      if (this.#store.maxSeq !== undefined) {
        return { ok: true, seq: await this.#store.maxSeq(runId) };
      }
      // Fallback derivation: last row of a bounded ascending scan.
      const rows = [...(await this.#store.sinceSeq(runId, 0, SEQ_SCAN_CAP))].sort(
        (a, b) => a.seq - b.seq,
      );
      const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
      return { ok: true, seq: last === undefined ? 0 : last.seq };
    } catch {
      return eventBusFailure("event_store_unavailable", "run event store is unavailable", {
        hint: "retry the publish; the seq counter was not advanced",
        retryable: true,
      });
    }
  }

  /** Best-effort max-seq probe for the §13.2 clamp; `null` on any failure. */
  async #loadMaxSeqBestEffort(runId: string): Promise<number | null> {
    const loaded = await this.#loadMaxSeq(runId);
    return loaded.ok ? loaded.seq : null;
  }

  #fanOut(event: CorrelatedRunEvent): void {
    const state = this.#runs.get(event.runId);
    if (state === undefined) {
      return;
    }
    // Redact once per publish; every subscriber sees the same transformed payload.
    const delivered = this.#redaction.redactPayload(event.type, event.payload, {
      organizationId: event.organizationId,
      runId: event.runId,
    });
    const redactedEvent: CorrelatedRunEvent = { ...event, payload: delivered };
    for (const subscriber of [...state.subscribers]) {
      subscriber.liveEnqueue(redactedEvent);
    }
  }

  /**
   * Durable backfill, paged, merged against the live buffer so the two paths
   * never duplicate or reorder an event:
   *  - rows with `seq >=` the live buffer's floor are skipped (their live
   *    twins carry them);
   *  - the page cursor only advances past rows actually considered (enqueued
   *    or org-filtered), so events shed from the live buffer are re-fetched
   *    and healed;
   *  - once pages exhaust, the buffered live events flush in seq order.
   */
  async #backfill(subscriber: Subscriber, requestedFromSeq: number): Promise<void> {
    const fromSeq = Math.max(0, requestedFromSeq);
    let cursor = fromSeq;
    try {
      // §13.2 sanity clamp: a Last-Event-ID AHEAD of the durable tail (stale
      // client, pruned history) would otherwise swallow every future seq
      // (all <= the claimed checkpoint). Best-effort read: on store failure we
      // proceed unclamped and let the page reads surface the error.
      const tail = await this.#loadMaxSeqBestEffort(subscriber.runId);
      if (tail !== null) {
        subscriber.clampCheckpoint(Math.min(fromSeq, tail));
        cursor = Math.min(cursor, tail);
      }
      for (let page = 0; page < this.#maxBackfillPages; page += 1) {
        const rows = [...(await this.#store.sinceSeq(subscriber.runId, cursor, this.#backfillPageLimit))].sort(
          (a, b) => a.seq - b.seq,
        );
        let pagedThrough = cursor;
        let stoppedAtLive = false;
        let enqueuedAny = false;
        for (const row of rows) {
          if (isTerminalRunEventType(row.type)) {
            subscriber.noteTerminalRow(row.seq);
          }
          const floor = subscriber.pendingFloor();
          if (floor !== null && row.seq >= floor) {
            stoppedAtLive = true; // the live tail already buffers these seqs
            break;
          }
          pagedThrough = Math.max(pagedThrough, row.seq);
          if (subscriber.organizationFilter !== null && row.organizationId !== subscriber.organizationFilter) {
            continue; // §15.1 tenant filter; the seq jump flags at drain time
          }
          subscriber.backfillEnqueue(this.#rowToEvent(subscriber.runId, row));
          enqueuedAny = true;
        }
        if (stoppedAtLive) {
          break; // live tail is buffered; stop reading the store
        }
        if (rows.length < this.#backfillPageLimit) {
          break; // history exhausted
        }
        if (!enqueuedAny && pagedThrough === cursor) {
          break; // defensive: no progress possible (odd store behavior)
        }
        cursor = pagedThrough;
      }
    } catch {
      subscriber.backfillFailed(
        eventBusFailure("event_store_unavailable", "run event backfill failed", {
          hint: "end the SSE response so the client reconnects with Last-Event-ID",
          retryable: true,
        }),
      );
      return;
    }
    subscriber.flushPending();
  }

  #rowToEvent(runId: string, row: StoredEventRow): CorrelatedRunEvent {
    // Internal seam (rows come from our own appends): cast, then redact per
    // policy — identical delivery guarantees as the live path (§22).
    const delivered = this.#redaction.redactPayload(row.type, row.payload as RunEventPayloadMap[RunEventType], {
      organizationId: row.organizationId,
      runId,
    });
    return {
      seq: row.seq,
      runId,
      at: new Date(row.at),
      type: row.type,
      payload: delivered,
      organizationId: row.organizationId,
    };
  }
}
