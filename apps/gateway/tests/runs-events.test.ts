// W4-H — GET /v1/runs/:id/events (§13.2 SSE): backfill ordering, seq dedupe,
// Last-Event-ID resume (header + ?lastEventId= fallback + precedence), resync
// sentinel, terminal close, heartbeat presence, disconnect abort, auth/tenant
// gates and the wired-const export — all against a fake store+bus, reading the
// raw SSE chunks. No DB, no network, no real timers (heartbeatMs is injected);
// the router is mounted through buildApp's `mount` hook so the full middleware
// stack (errorMapper → 401/404/400 envelopes) is exercised exactly as in prod.

import type { RunEventType } from "@studio/db";
import type { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import {
  type RunEventBusLike,
  type RunEventDelivery,
  type RunEventEnvelope,
  type RunEventSubscribeOptions,
  type RunEventSubscriptionLike,
  type RunEventsAuthLike,
  type RunEventsCaller,
  type RunEventsDeps,
  type RunLookupLike,
  type RunOrganizationRef,
  createRunEventRoutes,
  runEventRoutes,
  wireRunEventRoutes,
} from "../src/routes/runs-events.js";
import type {
  EventStoreLike,
  StoredEventAppend,
  StoredEventRow,
} from "../src/services/event-store.js";
import type { AppEnv } from "../src/types.js";

// --- fixtures --------------------------------------------------------------------------

const ORG = "11111111-1114-4111-8111-111111111111";
const OTHER_ORG = "22222222-2224-4222-8222-222222222222";
const RUN_ID = "run-018f8a12-2222-4222-8222-333333333333";
const AT = "2026-01-15T10:00:00.000Z";

const CALLER: RunEventsCaller = { userId: "user-1", organizationId: ORG };
const RUN_REF: RunOrganizationRef = { organizationId: ORG };

const testLogger = pino({ enabled: false });

const eventsUrl = (runId: string, query = ""): string => `/v1/runs/${runId}/events${query}`;

function seedRow(
  seq: number,
  type: RunEventType,
  options: { payload?: unknown; at?: string; organizationId?: string } = {},
): StoredEventAppend {
  return {
    seq,
    type,
    payload: options.payload ?? {},
    at: options.at ?? AT,
    organizationId: options.organizationId ?? ORG,
  };
}

/** A seq-gap delivery the bus flags `resync` (drop-slowest / store hole). */
const GAP_EVENT: RunEventEnvelope = {
  seq: 9,
  runId: RUN_ID,
  at: new Date(AT),
  type: "run.plan",
  payload: { plan: { steps: [] } },
  organizationId: ORG,
};

// --- fakes -----------------------------------------------------------------------------

/** In-memory durable store (§13.2 backfill rows) implementing the seam. */
class FakeStore implements EventStoreLike {
  readonly rowsByRun = new Map<string, StoredEventRow[]>();

  /** Direct seeding — no awaits, so tests stay deterministic. */
  seed(runId: string, rows: StoredEventAppend[]): void {
    this.rowsByRun.set(
      runId,
      [...rows].sort((a, b) => a.seq - b.seq).map((row) => ({ ...row })),
    );
  }

  async append(runId: string, row: StoredEventAppend): Promise<void> {
    const rows = this.#rows(runId);
    rows.push({ ...row });
    rows.sort((a, b) => a.seq - b.seq);
  }

  async sinceSeq(
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly StoredEventRow[]> {
    return this.#rows(runId)
      .filter((row) => row.seq > afterSeq)
      .slice(0, Math.max(0, limit));
  }

  async maxSeq(runId: string): Promise<number> {
    const rows = this.#rows(runId);
    const last = rows[rows.length - 1];
    return last === undefined ? 0 : last.seq;
  }

  #rows(runId: string): StoredEventRow[] {
    const existing = this.rowsByRun.get(runId);
    if (existing === undefined) {
      const created: StoredEventRow[] = [];
      this.rowsByRun.set(runId, created);
      return created;
    }
    return existing;
  }
}

function envelopeOf(runId: string, row: StoredEventRow): RunEventEnvelope {
  return {
    seq: row.seq,
    runId,
    at: new Date(row.at),
    type: row.type,
    payload: row.payload,
    organizationId: row.organizationId,
  };
}

/** Bus-shaped fake: durable backfill first, then live (the W2-P contract). */
class FakeSubscription implements RunEventSubscriptionLike {
  readonly runId: string;
  readonly options: RunEventSubscribeOptions;
  lastDeliveredSeq: number;
  ended = false;
  unsubscribed = false;
  readonly #queue: RunEventDelivery[] = [];
  #waiter: ((result: IteratorResult<RunEventDelivery, undefined>) => void) | null = null;

  constructor(runId: string, options: RunEventSubscribeOptions) {
    this.runId = runId;
    this.options = options;
    this.lastDeliveredSeq = options.fromSeq ?? 0;
  }

  push(delivery: RunEventDelivery): void {
    if (this.ended) {
      return;
    }
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter({ value: delivery, done: false });
      return;
    }
    this.#queue.push(delivery);
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  unsubscribe(): void {
    this.unsubscribed = true;
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEventDelivery, undefined, undefined> {
    return {
      next: (): Promise<IteratorResult<RunEventDelivery, undefined>> => {
        const queued = this.#queue.shift();
        if (queued !== undefined) {
          this.lastDeliveredSeq = queued.event.seq;
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
    };
  }
}

class FakeBus implements RunEventBusLike {
  readonly subscriptions: FakeSubscription[] = [];
  readonly #store: FakeStore;

  constructor(store: FakeStore) {
    this.#store = store;
  }

  subscribe(runId: string, options?: RunEventSubscribeOptions): FakeSubscription {
    const subscription = new FakeSubscription(runId, options ?? {});
    this.subscriptions.push(subscription);
    // Durable backfill from the fake store (rows with seq > checkpoint).
    void this.#store.sinceSeq(runId, subscription.lastDeliveredSeq, 10_000).then((rows) => {
      for (const row of rows) {
        subscription.push({ event: envelopeOf(runId, row), resync: false });
      }
    });
    return subscription;
  }

  /** Live publish: durable append first (§22), then live fan-out. */
  async publish(runId: string, row: StoredEventAppend): Promise<void> {
    await this.#store.append(runId, row);
    const event = envelopeOf(runId, { ...row });
    for (const subscription of this.subscriptions) {
      if (subscription.runId === runId) {
        subscription.push({ event, resync: false });
      }
    }
  }

  /** Simulates the drop-slowest / store-hole case: a gap reached the consumer. */
  flagResync(runId: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.runId === runId) {
        subscription.push({ event: GAP_EVENT, resync: true });
      }
    }
  }
}

// --- harness ---------------------------------------------------------------------------

const authOf = (caller: RunEventsCaller | null): RunEventsAuthLike => ({
  authenticate: () => Promise.resolve(caller),
});

const lookupOf = (run: RunOrganizationRef | null): RunLookupLike => ({
  findRun: () => Promise.resolve(run),
});

function baseDeps(): AppDeps {
  return {
    env: gatewayTransportSchema.parse({}),
    logger: testLogger,
    version: "0.0.0-test",
    probes: [],
    startedAt: Date.now(),
  };
}

interface HarnessOptions {
  caller?: RunEventsCaller | null;
  run?: RunOrganizationRef | null;
  heartbeatMs?: number;
}

interface Harness {
  readonly app: Hono<AppEnv>;
  readonly store: FakeStore;
  readonly bus: FakeBus;
}

function mountApp(mount: (app: Hono<AppEnv>) => void): Hono<AppEnv> {
  return buildApp({ ...baseDeps(), mount });
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const store = new FakeStore();
  const bus = new FakeBus(store);
  const deps: RunEventsDeps = {
    auth: authOf(options.caller === undefined ? CALLER : options.caller),
    runLookup: lookupOf(options.run === undefined ? RUN_REF : options.run),
    bus,
    heartbeatMs: options.heartbeatMs,
  };
  const app = mountApp((a) => {
    a.route("/v1", createRunEventRoutes(deps));
  });
  return { app, store, bus };
}

// --- SSE reading helpers ---------------------------------------------------------------

const decoder = new TextDecoder();
type StreamReader = ReturnType<ReadableStream<Uint8Array>["getReader"]>;

async function readAll(reader: StreamReader): Promise<string> {
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** One decoded chunk, or null on done/timeout — for open-stream assertions. */
async function readChunk(reader: StreamReader, timeoutMs = 1_000): Promise<string | null> {
  const read = reader.read().then((result): string | null =>
    result.done ? null : decoder.decode(result.value, { stream: true }),
  );
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([read, timeout]);
}

/** Microtask flushes — settles the fake backfill before out-of-band pushes. */
async function tick(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

interface ParsedFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: unknown;
}

function parseSse(text: string): { comments: string[]; frames: ParsedFrame[] } {
  const comments: string[] = [];
  const frames: ParsedFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (block === "") {
      continue;
    }
    let sawField = false;
    let id: string | null = null;
    let event: string | null = null;
    let data: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        continue; // comment line (open frame / heartbeat)
      }
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
        sawField = true;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        sawField = true;
      } else if (line.startsWith("data:")) {
        data = line.slice(5).trim();
        sawField = true;
      }
    }
    if (!sawField) {
      comments.push(block);
      continue;
    }
    frames.push({ id, event, data: data === null ? null : (JSON.parse(data) as unknown) });
  }
  return { comments, frames };
}

async function bodyReader(res: Response): Promise<StreamReader> {
  if (res.body === null) {
    throw new Error("expected a streaming body");
  }
  return res.body.getReader();
}

// --- tests -----------------------------------------------------------------------------

describe("GET /v1/runs/:id/events — SSE (§13.2)", () => {
  describe("backfill, framing and dedupe", () => {
    it("replays backfill rows in ascending seq with the exact §13.2 envelope", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, [
        seedRow(1, "run.queued", { payload: { tier: "standard" } }),
        seedRow(2, "run.started", { payload: { revisionBefore: 3 } }),
        seedRow(3, "run.plan", { payload: { plan: { steps: [] } } }),
        seedRow(4, "run.succeeded", {
          payload: { revisionAfter: 5, warnings: [] },
        }),
      ]);
      const res = await h.app.request(eventsUrl(RUN_ID));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const text = await res.text();
      const { comments, frames } = parseSse(text);
      expect(comments).toEqual([": sse open"]); // immediate flush frame
      expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "3", "4"]);
      expect(frames.map((frame) => frame.event)).toEqual([
        "run.queued",
        "run.started",
        "run.plan",
        "run.succeeded",
      ]);
      expect(frames[0]?.data).toEqual({
        seq: 1,
        run_id: RUN_ID,
        at: AT,
        type: "run.queued",
        payload: { tier: "standard" },
      });
      expect(frames[3]?.data).toEqual({
        seq: 4,
        run_id: RUN_ID,
        at: AT,
        type: "run.succeeded",
        payload: { revisionAfter: 5, warnings: [] },
      });
    });

    it("dedupes deliveries by seq (route-level §13.2 belt-and-braces)", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, [
        seedRow(1, "run.queued"),
        seedRow(2, "run.started"),
        seedRow(2, "run.started"), // drifted bus replayed seq 2 twice
        seedRow(3, "run.plan"),
        seedRow(4, "run.cancelled", { payload: { reason: "user" } }),
      ]);
      const res = await h.app.request(eventsUrl(RUN_ID));
      const text = await res.text();
      const { frames } = parseSse(text);
      expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "3", "4"]);
    });
  });

  describe("live delivery and terminal close", () => {
    it("streams live events after backfill and closes cleanly on the terminal event", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, [seedRow(1, "run.queued"), seedRow(2, "run.started")]);
      const res = await h.app.request(eventsUrl(RUN_ID));
      const reader = await bodyReader(res);
      await tick();
      await h.bus.publish(RUN_ID, seedRow(3, "run.plan", { payload: { plan: { steps: [] } } }));
      await h.bus.publish(
        RUN_ID,
        seedRow(4, "run.succeeded", { payload: { revisionAfter: 6, warnings: [] } }),
      );
      const text = await readAll(reader);
      const { frames } = parseSse(text);
      expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "3", "4"]);
      expect(frames.at(-1)?.event).toBe("run.succeeded");
    });
  });

  describe("Last-Event-ID resume (§13.2)", () => {
    const rows = (): StoredEventAppend[] => [
      seedRow(1, "run.queued"),
      seedRow(2, "run.started"),
      seedRow(3, "run.plan"),
      seedRow(4, "run.succeeded"),
    ];

    it("resumes from the Last-Event-ID header", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, rows());
      const res = await h.app.request(eventsUrl(RUN_ID), { headers: { "Last-Event-ID": "2" } });
      const text = await res.text();
      const { frames } = parseSse(text);
      expect(frames.map((frame) => frame.id)).toEqual(["3", "4"]);
    });

    it("falls back to the ?lastEventId= query when the header is absent", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, rows());
      const res = await h.app.request(eventsUrl(RUN_ID, "?lastEventId=2"));
      const text = await res.text();
      const { frames } = parseSse(text);
      expect(frames.map((frame) => frame.id)).toEqual(["3", "4"]);
    });

    it("prefers the header over the query fallback", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, rows());
      const res = await h.app.request(eventsUrl(RUN_ID, "?lastEventId=1"), {
        headers: { "Last-Event-ID": "3" },
      });
      const text = await res.text();
      const { frames } = parseSse(text);
      expect(frames.map((frame) => frame.id)).toEqual(["4"]);
    });

    it("forwards the resume cursor and tenant filter to the bus", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, rows());
      const res = await h.app.request(eventsUrl(RUN_ID), { headers: { "Last-Event-ID": "1" } });
      await res.text();
      const subscription = h.bus.subscriptions[0];
      expect(subscription?.options.fromSeq).toBe(1);
      expect(subscription?.options.organizationId).toBe(ORG);
    });

    it.each(["abc", "-1", "1e3", "12x", "99999999999999999999"])(
      "rejects a malformed Last-Event-ID (%s) with a 400 envelope",
      async (value) => {
        const h = makeHarness();
        const res = await h.app.request(eventsUrl(RUN_ID), { headers: { "Last-Event-ID": value } });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { ok: boolean; code: string; retryable: boolean };
        expect(body.ok).toBe(false);
        expect(body.code).toBe("validation_failed");
        expect(body.retryable).toBe(false);
      },
    );
  });

  describe("resync sentinel (§13.2 gap)", () => {
    it("ends the response with a run.resync sentinel anchored at the last contiguous seq", async () => {
      const h = makeHarness();
      h.store.seed(RUN_ID, [seedRow(1, "run.queued"), seedRow(2, "run.started")]);
      const res = await h.app.request(eventsUrl(RUN_ID));
      const reader = await bodyReader(res);
      await tick();
      h.bus.flagResync(RUN_ID); // seq 9 jumped over 3..8
      const text = await readAll(reader);
      const { frames } = parseSse(text);
      expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "2"]);
      expect(frames.at(-1)?.event).toBe("run.resync");
      expect(frames.at(-1)?.data).toEqual({ run_id: RUN_ID, last_seq: 2 });
      expect(text).not.toContain('"seq":9'); // the jumped event is withheld
    });

    it("resyncs to the client's checkpoint when nothing contiguous was sent yet", async () => {
      const h = makeHarness();
      const res = await h.app.request(eventsUrl(RUN_ID), { headers: { "Last-Event-ID": "2" } });
      const reader = await bodyReader(res);
      await tick();
      h.bus.flagResync(RUN_ID);
      const text = await readAll(reader);
      const { frames } = parseSse(text);
      expect(frames.length).toBe(1);
      expect(frames[0]?.id).toBe("2");
      expect(frames[0]?.event).toBe("run.resync");
      expect(frames[0]?.data).toEqual({ run_id: RUN_ID, last_seq: 2 });
    });
  });

  describe("heartbeat and disconnect", () => {
    it("emits a heartbeat comment while the stream is open", async () => {
      const h = makeHarness({ heartbeatMs: 15 });
      const controller = new AbortController();
      const res = await h.app.request(eventsUrl(RUN_ID), { signal: controller.signal });
      const reader = await bodyReader(res);
      const first = await readChunk(reader);
      expect(first?.startsWith(": sse open")).toBe(true);
      const heartbeat = await readChunk(reader);
      expect(heartbeat?.startsWith(": hb")).toBe(true);
      controller.abort();
      expect(await readChunk(reader)).toBe(null); // stream closed
    });

    it("unsubscribes and closes when the client disconnects", async () => {
      const h = makeHarness();
      const controller = new AbortController();
      const res = await h.app.request(eventsUrl(RUN_ID), { signal: controller.signal });
      const reader = await bodyReader(res);
      await tick();
      controller.abort();
      await tick();
      const subscription = h.bus.subscriptions[0];
      expect(subscription?.unsubscribed).toBe(true);
      expect(await readChunk(reader)).toBe(null);
    });
  });

  describe("auth and tenant gates (§15.1)", () => {
    it("401s unauthenticated requests without touching the bus", async () => {
      const h = makeHarness({ caller: null });
      const res = await h.app.request(eventsUrl(RUN_ID));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { ok: boolean; code: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("unauthorized");
      expect(h.bus.subscriptions.length).toBe(0);
    });

    it("404s unknown runs", async () => {
      const h = makeHarness({ run: null });
      const res = await h.app.request(eventsUrl(RUN_ID));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; code: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("run_not_found");
      expect(h.bus.subscriptions.length).toBe(0);
    });

    it("404s cross-tenant runs with the same envelope as missing ones", async () => {
      const h = makeHarness({ run: { organizationId: OTHER_ORG } });
      const res = await h.app.request(eventsUrl(RUN_ID));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; code: string; message: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("run_not_found");
      expect(body.message).toBe("Run not found.");
      expect(h.bus.subscriptions.length).toBe(0);
    });
  });

  describe("runEventRoutes const (wiring surface)", () => {
    it("answers a typed 503 while unwired", async () => {
      wireRunEventRoutes(null);
      const app = mountApp((a) => {
        a.route("/v1", runEventRoutes);
      });
      const res = await app.request(eventsUrl(RUN_ID));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; code: string; retryable: boolean };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("run_events_unavailable");
      expect(body.retryable).toBe(true);
    });

    it("streams once wired via wireRunEventRoutes", async () => {
      const store = new FakeStore();
      const bus = new FakeBus(store);
      store.seed(RUN_ID, [seedRow(1, "run.queued"), seedRow(2, "run.succeeded")]);
      wireRunEventRoutes({ auth: authOf(CALLER), runLookup: lookupOf(RUN_REF), bus });
      const app = mountApp((a) => {
        a.route("/v1", runEventRoutes);
      });
      const res = await app.request(eventsUrl(RUN_ID));
      const text = await res.text();
      const { frames } = parseSse(text);
      expect(frames.map((frame) => frame.id)).toEqual(["1", "2"]);
      wireRunEventRoutes(null); // leave the module state clean for other files
    });
  });
});
