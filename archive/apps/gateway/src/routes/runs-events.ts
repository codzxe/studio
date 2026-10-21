// @studio/gateway — GET /v1/runs/:id/events: the §13.2 SSE run-event stream.
// Owner: W4-H (docs/AGENTS.md).
//
// Spec anchors:
//   §13.1  endpoint contract: SSE, backfill from `run_events` then live.
//   §13.2  events carry { seq, run_id, at, type, payload }; the client dedupes
//          by `seq`, resumes with Last-Event-ID, and closes after a terminal
//          event (run.succeeded/failed/cancelled).
//   §15.1  tenant scoping: cross-tenant runs 404 — existence is never revealed
//          across organizations; the org is also forwarded to the bus so
//          deliveries are filtered twice (gate + bus).
//   §22    correlation: the request-scoped child logger already carries the
//          request id; stream lifecycle lines add run_id.
//
// Mount contract: internal paths are `/runs/…` — mount this router at `/v1`
// (e.g. `v1.route("/", runEventRoutes)` in src/routes/index.ts).
//
// Wiring (the wave that mounts /v1 owns app.ts / routes/index.ts):
//   const eventStore = new DrizzleEventStore(db);        // services/event-store.js
//   const bus = new RunEventBus({ store: eventStore });  // @studio/agent (needs
//                                                        // a gateway dep entry)
//   v1.route("/", createRunEventRoutes({ auth, runLookup, bus }));
//   // …or keep the exported const: wireRunEventRoutes({ auth, runLookup, bus });
//   // and mount `runEventRoutes` unchanged.
// The injected seams adapt to the landed W4 surfaces with ~10-line adapters:
//   auth       — W4-B's middleware/auth-context.ts (requireAuth → c.get session)
//                or W4-G's services/runs.ts `AuthLike` (map Result → caller|null)
//   runLookup  — W4-G's services/runs.ts `RunsStore` (org-scoped run fetch)
// Live fan-out note: the worker is the only publisher (§5.1) and it lives in
// another process, so in-process bus live events only cover gateway-side
// publishes until the §3.1 Valkey/queue SSE-bridge lands. This router only
// consumes the `RunEventBusLike` seam, so the bridge swaps in WITHOUT touching
// this file.
//
// Structural mirror note (W3-M precedent): the bus seams below re-declare the
// EXACT shapes of W2-P's contracts (packages/agent/src/eventbus.ts:
// `RunEventBus.subscribe`, `RunEventSubscription`, `EventDelivery`,
// `CorrelatedRunEvent`) because the gateway does not depend on @studio/agent.
// The real bus satisfies them shape-for-shape; DO NOT let them drift — diff
// against packages/agent/src/eventbus.ts first.

import type { RunEventType } from "@studio/db";
import { type Context, Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import { AppError } from "../middleware/error-mapper.js";
import type { AppEnv } from "../types.js";

/** §13.1 keepalive: an SSE comment every 15 s while the stream is open. */
export const SSE_HEARTBEAT_MS = 15_000;

/** SSE response headers (mirrors hono's streamSSE helper; written manually). */
const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "connection": "keep-alive",
  "x-accel-buffering": "no",
};

/** §13.2 terminal events — the stream closes cleanly after one of these. */
const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.succeeded",
  "run.failed",
  "run.cancelled",
]);

// --- Auth + tenant seams (injected; the Better Auth wave wires the adapter) -------------

/** The authenticated caller (§13: session cookie for the web app, API keys otherwise). */
export interface RunEventsCaller {
  readonly userId: string;
  readonly organizationId: string;
}

/** Auth seam: resolves the caller, or null when the request is unauthenticated. */
export interface RunEventsAuthLike {
  authenticate(request: Request): Promise<RunEventsCaller | null>;
}

/** What the tenant check needs to know about a run (assertDocAccess-style). */
export interface RunOrganizationRef {
  readonly organizationId: string;
}

/**
 * Run existence + tenant seam (W4-G's services/runs can implement this once
 * it lands): the run's owning organization, or null when it does not exist.
 */
export interface RunLookupLike {
  findRun(runId: string): Promise<RunOrganizationRef | null>;
}

// --- Bus seams (structural mirrors of W2-P's contracts — see the header) ----------------

/** One §13.2 event as the bus delivers it (W2-P `CorrelatedRunEvent` mirror). */
export interface RunEventEnvelope {
  readonly seq: number;
  readonly runId: string;
  readonly at: Date;
  readonly type: RunEventType;
  readonly payload: unknown;
  /** §15.1 tenant root — used for filtering; never serialized to the wire. */
  readonly organizationId: string;
}

/** One delivery plus the §13.2 gap signal (W2-P `EventDelivery` mirror). */
export interface RunEventDelivery {
  readonly event: RunEventEnvelope;
  /** True when a seq gap preceded this event: end the response, client resyncs. */
  readonly resync: boolean;
}

/** Live subscription (W2-P `RunEventSubscription` mirror — iterator view). */
export interface RunEventSubscriptionLike {
  /** Highest seq handed to this consumer (Last-Event-ID checkpoint). */
  readonly lastDeliveredSeq: number;
  readonly ended: boolean;
  [Symbol.asyncIterator](): AsyncIterator<RunEventDelivery, undefined, undefined>;
  unsubscribe(): void;
}

/** `subscribe` options (W2-P `SubscribeOptions` mirror). */
export interface RunEventSubscribeOptions {
  /** §13.2 Last-Event-ID: deliver events with `seq > fromSeq`. */
  readonly fromSeq?: number;
  /** §15.1 tenant filter for backfill rows and live deliveries. */
  readonly organizationId?: string;
}

/** The run-event bus seam (W2-P `RunEventBus.subscribe` mirror). */
export interface RunEventBusLike {
  subscribe(runId: string, options?: RunEventSubscribeOptions): RunEventSubscriptionLike;
}

/** Everything the router needs, injected (buildApp deps / bootstrap wiring). */
export interface RunEventsDeps {
  readonly auth: RunEventsAuthLike;
  readonly runLookup: RunLookupLike;
  readonly bus: RunEventBusLike;
  /** Heartbeat interval override (default `SSE_HEARTBEAT_MS`); tests inject small values. */
  readonly heartbeatMs?: number;
}

// --- Wire frames -----------------------------------------------------------------------

/** Flushed immediately on stream open so proxies deliver headers promptly. */
const OPEN_FRAME = ": sse open\n\n";
/** §13.1 keepalive comment — clients ignore comment lines per the SSE spec. */
const HEARTBEAT_FRAME = ": hb\n\n";

/** One §13.2 event as SSE: `id:` = seq (resume anchor), `event:` = type, full envelope as data. */
function eventFrame(event: RunEventEnvelope): string {
  const envelope = {
    seq: event.seq,
    run_id: event.runId,
    at: event.at.toISOString(),
    type: event.type,
    payload: event.payload,
  };
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * The §13.2 resync sentinel. Its `id` is the last seq the consumer received
 * CONTIGUOUSLY (not the gap-jumped event), so the client's reconnect with
 * Last-Event-ID re-heals the gap from the durable store; §13.2 dedupe drops
 * any overlap. The jumped event itself is NOT forwarded — the reconnect
 * backfill delivers it in order instead.
 */
function resyncFrame(runId: string, lastSentSeq: number): string {
  const envelope = { run_id: runId, last_seq: lastSentSeq };
  return `id: ${lastSentSeq}\nevent: run.resync\ndata: ${JSON.stringify(envelope)}\n\n`;
}

// --- Last-Event-ID (§13.2) --------------------------------------------------------------

// ≤ 15 digits keeps the seq inside Number.MAX_SAFE_INTEGER; the bus clamps
// absurd-but-valid checkpoints against the durable tail anyway.
const lastEventIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}$/, "must be a non-negative integer seq")
  .transform((value) => Number(value));

/**
 * §13.2 resume anchor: the `Last-Event-ID` header wins; `?lastEventId=` is the
 * fallback for non-EventSource clients. Absent/empty → 0 (full replay). A
 * malformed value is a 400 envelope (§13.3 validation) thrown as an AppError —
 * the W1-H mapper would turn a raw ZodError into 422; the header is validated
 * explicitly here so the status stays §13.3-literal either way.
 */
function resolveFromSeq(headerValue: string | undefined, queryValue: string | undefined): number {
  const raw = headerValue !== undefined && headerValue !== "" ? headerValue : queryValue;
  if (raw === undefined || raw === "") {
    return 0;
  }
  const parsed = lastEventIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "validation_failed", "The Last-Event-ID value is invalid.", {
      hint: "Send the numeric seq of the last event you received, or omit it to replay.",
      retryable: false,
    });
  }
  return parsed.data;
}

// --- The stream ------------------------------------------------------------------------

/** Why the pump stopped — for the §22 lifecycle log line. */
type StreamEndReason = "terminal" | "resync" | "disconnected" | "drained" | "failed";

async function streamRunEvents(c: Context<AppEnv>, deps: RunEventsDeps): Promise<Response> {
  const paramId = c.req.param("id");
  if (paramId === undefined) {
    throw new AppError(400, "bad_request", "A run id is required.", { retryable: false });
  }
  const runId = paramId;
  // The requestLogger middleware owns this; a bare-mounted router (wiring
  // checks) may lack it — never let logging crash the stream.
  const logger: Logger | undefined = c.get("logger");

  // Gate 1 — auth (§13). Unauthenticated requests never reach the tenant check,
  // so existence is not revealed.
  const caller = await deps.auth.authenticate(c.req.raw);
  if (caller === null) {
    throw new AppError(401, "unauthorized", "Authentication is required to stream run events.", {
      hint: "Sign in via the web app or send a valid API key.",
      retryable: false,
    });
  }

  // Gate 2 — tenant, assertDocAccess-style on the run's org (§15.1): foreign
  // and missing runs are the same 404 envelope.
  const run = await deps.runLookup.findRun(runId);
  if (run === null || run.organizationId !== caller.organizationId) {
    throw new AppError(404, "run_not_found", "Run not found.", {
      hint: "Check the run id in the path.",
      retryable: false,
    });
  }

  // Gate 3 — §13.2 resume anchor, before the stream starts.
  const fromSeq = resolveFromSeq(c.req.header("last-event-id"), c.req.query("lastEventId"));
  const organizationId = caller.organizationId;
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_MS;

  // A request whose signal already fired (client vanished mid-dispatch) must
  // never open a stream: the abort listener below would never fire (signals
  // don't replay) and the subscription would park until the run ended.
  if (c.req.raw.signal.aborted) {
    throw new AppError(499, "client_disconnected", "The client went away before the stream opened.", {
      retryable: false,
    });
  }

  // Client-disconnect bridge: the request signal aborts on socket close and
  // the reader-side `cancel()` covers body aborts; both stop the pump.
  const disconnect = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => disconnect.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (frame: string): void => {
        if (!closed) {
          controller.enqueue(encoder.encode(frame));
        }
      };
      const closeStream = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          controller.close();
        } catch {
          // The reader cancelled first (client gone) — nothing left to close.
        }
      };

      // Backfill + live behind one subscription (§13.2): the bus registers the
      // live listener first, replays `run_events` rows after `fromSeq`, then
      // flushes live events merged by seq — ordering is the bus's contract.
      const subscription = deps.bus.subscribe(runId, { fromSeq, organizationId });
      const onAbort = (): void => {
        subscription.unsubscribe();
      };
      disconnect.signal.addEventListener("abort", onAbort, { once: true });
      const heartbeat = setInterval(() => send(HEARTBEAT_FRAME), heartbeatMs);

      // Server-side seq dedupe + the resync anchor start from the client's
      // claimed checkpoint (§13.2), so a gap before anything was sent still
      // resyncs to a safe cursor.
      let lastSentSeq = fromSeq;
      let end: StreamEndReason = "drained";
      try {
        send(OPEN_FRAME);
        for await (const delivery of subscription) {
          if (delivery.resync) {
            // §13.2 gap: end the response; the client reconnects with
            // Last-Event-ID = the sentinel id and re-heals from the store.
            send(resyncFrame(runId, lastSentSeq));
            end = "resync";
            break;
          }
          if (delivery.event.seq <= lastSentSeq) {
            continue; // already sent to this consumer (merge overlap)
          }
          send(eventFrame(delivery.event));
          lastSentSeq = delivery.event.seq;
          if (TERMINAL_RUN_EVENT_TYPES.has(delivery.event.type)) {
            end = "terminal"; // §13.2: clean close after the terminal event
            break;
          }
        }
      } catch (error) {
        end = "failed";
        logger?.warn({ err: error, run_id: runId }, "run_event_stream_failed");
      } finally {
        clearInterval(heartbeat);
        disconnect.signal.removeEventListener("abort", onAbort);
        if (end === "drained" && disconnect.signal.aborted) {
          end = "disconnected";
        }
        subscription.unsubscribe();
        closeStream();
        logger?.debug(
          { run_id: runId, last_seq: lastSentSeq, reason: end },
          "run_event_stream_closed",
        );
      }
    },
    cancel() {
      // Reader-side cancel (client aborted the body). The abort listener
      // above unsubscribes the pump; this closes every open path.
      disconnect.abort();
    },
  });

  return c.body(stream, 200, SSE_HEADERS);
}

// --- Routers ---------------------------------------------------------------------------

/**
 * Pure factory (the `healthRoutes(deps)` pattern): a fresh router with the
 * deps captured per instance — preferred for buildApp-style wiring and tests.
 */
export function createRunEventRoutes(deps: RunEventsDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get("/runs/:id/events", (c) => streamRunEvents(c, deps));
  return router;
}

/** Module-scoped deps for the exported const router below (set at bootstrap). */
let wiredDeps: RunEventsDeps | null = null;

/**
 * Wire the exported `runEventRoutes` const (bootstrap). Pass `null` to unwire
 * (tests); unmounted/unwired requests answer a typed 503, never a crash.
 */
export function wireRunEventRoutes(deps: RunEventsDeps | null): void {
  wiredDeps = deps;
}

/** GET /v1/runs/:id/events (§13.1) — mount at `/v1`; deps via `wireRunEventRoutes`. */
export const runEventRoutes = new Hono<AppEnv>();

runEventRoutes.get("/runs/:id/events", (c) => {
  const deps = wiredDeps;
  if (deps === null) {
    throw new AppError(
      503,
      "run_events_unavailable",
      "Run event streaming is not available.",
      { hint: "The service is starting up or misconfigured; retry shortly.", retryable: true },
    );
  }
  return streamRunEvents(c, deps);
});
