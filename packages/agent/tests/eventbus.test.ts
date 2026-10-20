// W2-P — §13.2 durable-first event bus: seq monotonicity, backfill-then-live
// merge, Last-Event-ID resume, drop-slowest backpressure, redaction, gap flags.
// All against a fake durable store: deterministic, no DB, no network, no timers
// except explicit `tick()` settles for callback-drain microtasks.
import { describe, expect, it } from "vitest";
import type { RunEventPayloadMap, RunEventType } from "../src/events.js";
import {
  type CorrelatedRunEvent,
  DefaultRedactionPolicy,
  type EventDelivery,
  type EventStoreLike,
  type RedactionPolicy,
  REDACTED,
  RunEventBus,
  type RunEventSubscription,
  type StoredEventAppend,
  type StoredEventRow,
  type StreamEnd,
} from "../src/eventbus.js";

const RUN_A = "run-aaaaaaaa-0000-4000-8000-00000000000a";
const RUN_B = "run-bbbbbbbb-0000-4000-8000-00000000000b";
const ORG = "11111111-1114-4111-8111-111111111111";
const ORG_OTHER = "22222222-2224-4222-8222-222222222222";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// --- helpers --------------------------------------------------------------------------

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Macrotask settle: flushes every pending microtask (callback drains). */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function queuedPayload(): RunEventPayloadMap["run.queued"] {
  return { tier: "quick" };
}

function startedPayload(): RunEventPayloadMap["run.started"] {
  return { revisionBefore: 1 };
}

function previewPayload(): RunEventPayloadMap["preview.updated"] {
  return { url: "https://cdn.example.test/p.png", revision: 3 };
}

function stepFinishedPayload(stepSeq: number): RunEventPayloadMap["step.finished"] {
  return { stepSeq, phase: "executing", tool: null, ok: true, durationMs: 3, deviationFromPlan: false };
}

function succeededPayload(): RunEventPayloadMap["run.succeeded"] {
  return { revisionAfter: 2, warnings: [] };
}

function failedPayload(): RunEventPayloadMap["run.failed"] {
  return {
    error: {
      code: "engine_timeout",
      message: "The editor did not respond in time",
      hint: "Try the run again",
    },
  };
}

function planPayload(): RunEventPayloadMap["run.plan"] {
  return {
    plan: {
      intent: "create_post",
      template: "instagram-post@3",
      assets: [],
      slots: { headline: "Launch day headline copy" },
      palette: ["#F4E7D3"],
      typography: {},
      steps: [{ tool: "text_add", args: { text: "Body copy from the user brief", name: "Headline" } }],
      checks: [],
      model_tier: "standard",
      notes_for_user: "Notes paraphrasing the brief",
    },
  };
}

/** Publishes with the union type (tests that drive many event types). */
function publish(
  bus: RunEventBus,
  runId: string,
  type: RunEventType,
  payload: RunEventPayloadMap[RunEventType],
  organizationId: string = ORG,
): Promise<{ ok: true; event: CorrelatedRunEvent } | { ok: false; code: string; message: string; retryable?: boolean }> {
  return bus.publish(runId, type, payload, { organizationId });
}

/** In-memory durable store: ascending `sinceSeq`, optional maxSeq, fault injection. */
class FakeStoreCore implements EventStoreLike {
  readonly rows = new Map<string, StoredEventRow[]>();
  readonly appendLog: Array<{ runId: string; row: StoredEventAppend }> = [];
  readonly sinceSeqCalls: Array<{ runId: string; afterSeq: number; limit: number }> = [];
  appendMicrotasks = 0;
  failAppendFor: ((row: StoredEventAppend) => string | null) | null = null;
  failSinceSeq = false;
  sinceSeqGate: (() => Promise<void>) | null = null;

  list(runId: string): StoredEventRow[] {
    let list = this.rows.get(runId);
    if (list === undefined) {
      list = [];
      this.rows.set(runId, list);
    }
    return list;
  }

  /** Direct row injection (store holes, foreign-org rows, pre-existing history). */
  seed(
    runId: string,
    row: { seq: number; type: RunEventType; payload: unknown; organizationId: string; at?: string },
  ): void {
    const list = this.list(runId);
    list.push({ at: new Date().toISOString(), ...row });
    list.sort((a, b) => a.seq - b.seq);
  }

  async append(runId: string, row: StoredEventAppend): Promise<void> {
    for (let i = 0; i < this.appendMicrotasks; i += 1) {
      await Promise.resolve(); // force interleaved store I/O
    }
    const message = this.failAppendFor === null ? null : this.failAppendFor(row);
    if (message !== null) {
      throw new Error(message);
    }
    const list = this.list(runId);
    list.push({ ...row });
    list.sort((a, b) => a.seq - b.seq);
    this.appendLog.push({ runId, row });
  }

  async sinceSeq(runId: string, afterSeq: number, limit: number): Promise<readonly StoredEventRow[]> {
    this.sinceSeqCalls.push({ runId, afterSeq, limit });
    await this.sinceSeqGate?.();
    if (this.failSinceSeq) {
      throw new Error("store read failed");
    }
    return this.list(runId).filter((row) => row.seq > afterSeq).slice(0, limit);
  }
}

/** Full store: adds the optional `maxSeq` fast path. */
class FakeEventStore extends FakeStoreCore {
  failMaxSeq = false;

  async maxSeq(runId: string): Promise<number> {
    if (this.failMaxSeq) {
      throw new Error("maxSeq failed");
    }
    const list = this.list(runId);
    return list.length > 0 ? (list[list.length - 1] as StoredEventRow).seq : 0;
  }
}

async function collect(subscription: RunEventSubscription, count: number): Promise<EventDelivery[]> {
  const out: EventDelivery[] = [];
  for await (const delivery of subscription) {
    out.push(delivery);
    if (out.length >= count) {
      break; // return() → unsubscribe
    }
  }
  return out;
}

async function collectToEnd(subscription: RunEventSubscription): Promise<EventDelivery[]> {
  const out: EventDelivery[] = [];
  for await (const delivery of subscription) {
    out.push(delivery);
  }
  return out;
}

function seqs(deliveries: readonly EventDelivery[]): number[] {
  return deliveries.map((delivery) => delivery.event.seq);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

// --- publish: seq monotonicity + durability (§13.2/§22) ----------------------------------

describe("eventbus publish: seq monotonicity + durability", () => {
  it("allocates strictly monotonic, gapless seq under concurrent interleaved publishes", async () => {
    const store = new FakeEventStore();
    store.appendMicrotasks = 3; // store appends overlap; the bus must serialize per run
    const bus = new RunEventBus({ store });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1))),
    );
    const allocated = results.map((r) => (r.ok ? r.event.seq : -1)).sort((a, b) => a - b);
    expect(allocated).toEqual(range(1, 40));
    // the durable backlog is exactly the allocated sequence, in append order
    expect(store.list(RUN_A).map((row) => row.seq)).toEqual(range(1, 40));
    expect(store.appendLog.filter((entry) => entry.runId === RUN_A).map((entry) => entry.row.seq)).toEqual(
      range(1, 40),
    );
    // §22 correlation on every persisted row
    for (const entry of store.appendLog) {
      expect(entry.row.organizationId).toBe(ORG);
      expect(entry.row.at).toMatch(ISO_RE);
      expect(entry.row.type).toBe("step.finished");
    }
  });

  it("keeps per-run seq counters independent across interleaved runs", async () => {
    const store = new FakeEventStore();
    store.appendMicrotasks = 2;
    const bus = new RunEventBus({ store });
    const calls: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i += 1) {
      calls.push(publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1)));
      calls.push(publish(bus, RUN_B, "step.finished", stepFinishedPayload(i + 1)));
    }
    await Promise.all(calls);
    expect(store.list(RUN_A).map((row) => row.seq)).toEqual(range(1, 10));
    expect(store.list(RUN_B).map((row) => row.seq)).toEqual(range(1, 10));
  });

  it("continues the sequence from the store's max seq on a new bus instance (maxSeq + fallback derivation)", async () => {
    const stores: Array<() => FakeStoreCore> = [
      () => new FakeEventStore(), // authoritative maxSeq
      () => new FakeStoreCore(), // sinceSeq-derived fallback
    ];
    for (const makeStore of stores) {
      const store = makeStore();
      const first = new RunEventBus({ store });
      for (let i = 0; i < 3; i += 1) {
        await publish(first, RUN_A, "step.finished", stepFinishedPayload(i + 1));
      }
      first.close();
      const second = new RunEventBus({ store });
      const result = await publish(second, RUN_A, "step.finished", stepFinishedPayload(4));
      expect(result.ok).toBe(true);
      expect(result.ok ? result.event.seq : -1).toBe(4); // no reuse, no gap
    }
  });

  it("rolls the seq counter back on a failed append — retry reuses the seq, no gap (gap-guard)", async () => {
    const store = new FakeEventStore();
    store.failAppendFor = (row) => (row.seq === 3 ? "unique violation" : null);
    const bus = new RunEventBus({ store });
    const seen: EventDelivery[] = [];
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    sub.onDelivery((delivery) => seen.push(delivery));
    await tick();

    expect((await publish(bus, RUN_A, "run.queued", queuedPayload())).ok).toBe(true);
    expect((await publish(bus, RUN_A, "run.started", startedPayload())).ok).toBe(true);
    const failed = await publish(bus, RUN_A, "step.started", {
      stepSeq: 1,
      phase: "executing",
      tool: null,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("event_persist_failed");
      expect(failed.retryable).toBe(true);
    }
    store.failAppendFor = null;
    const retried = await publish(bus, RUN_A, "preview.updated", previewPayload());
    expect(retried.ok ? retried.event.seq : -1).toBe(3); // seq 3 was never lost

    await tick();
    expect(seqs(seen)).toEqual([1, 2, 3]);
    expect(seen.every((delivery) => !delivery.resync)).toBe(true); // contiguous stream
    expect(store.list(RUN_A).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("surfaces a typed failure when the seq bootstrap read fails, then recovers", async () => {
    const store = new FakeEventStore();
    store.failMaxSeq = true;
    const bus = new RunEventBus({ store });
    const first = await publish(bus, RUN_A, "run.queued", queuedPayload());
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.code).toBe("event_store_unavailable");
      expect(first.retryable).toBe(true);
    }
    expect(store.appendLog.length).toBe(0); // nothing persisted, counter not advanced
    store.failMaxSeq = false;
    const second = await publish(bus, RUN_A, "run.queued", queuedPayload());
    expect(second.ok ? second.event.seq : -1).toBe(1); // bootstrap retried cleanly
  });

  it("rejects a publish from another organization (§15.1: one run, one org)", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    const ok = await bus.publish(RUN_A, "run.queued", queuedPayload(), { organizationId: ORG });
    expect(ok.ok).toBe(true);
    const foreign = await bus.publish(RUN_A, "run.queued", queuedPayload(), { organizationId: ORG_OTHER });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.code).toBe("organization_mismatch");
      expect(foreign.retryable).toBe(false);
    }
    expect(store.list(RUN_A).length).toBe(1);
  });

  it("returns the correlated event and stores the raw row (§22: runId + organizationId + at + seq)", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    const result = await bus.publish(RUN_A, "run.queued", queuedPayload(), { organizationId: ORG });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.runId).toBe(RUN_A);
      expect(result.event.organizationId).toBe(ORG);
      expect(result.event.seq).toBe(1);
      expect(result.event.at).toBeInstanceOf(Date);
    }
    const entry = store.appendLog[0];
    expect(entry?.runId).toBe(RUN_A);
    expect(entry?.row.seq).toBe(1);
    expect(entry?.row.organizationId).toBe(ORG);
    expect(entry?.row.at).toMatch(ISO_RE);
    expect(entry?.row.payload).toEqual({ tier: "quick" }); // raw, pre-redaction (§15.3)
  });
});

// --- subscribe: backfill + live (§13.2) --------------------------------------------------

describe("eventbus subscribe: backfill-then-live + Last-Event-ID", () => {
  it("backfills history first, then live — events published during backfill are never lost nor duplicated", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    for (let i = 0; i < 3; i += 1) {
      await publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1));
    }
    const gate = deferred();
    store.sinceSeqGate = () => gate.promise; // park the backfill read
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    const done = collect(sub, 6);
    // live events land while the backfill read is still parked (they must not
    // overtake history, and must not be double-delivered from the store)
    for (let i = 0; i < 3; i += 1) {
      await publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 4));
    }
    gate.resolve();
    const deliveries = await done;
    expect(seqs(deliveries)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(deliveries.every((delivery) => !delivery.resync)).toBe(true);
    expect(sub.lastDeliveredSeq).toBe(6);
  });

  it("resumes mid-stream with Last-Event-ID (§13.2 fromSeq)", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    for (let i = 0; i < 6; i += 1) {
      await publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1));
    }
    const sub = bus.subscribe(RUN_A, { fromSeq: 3 }); // client saw 1..3
    const done = collect(sub, 4);
    await tick(); // backfill delivers 4..6
    await publish(bus, RUN_A, "step.finished", stepFinishedPayload(7)); // live
    const deliveries = await done;
    expect(seqs(deliveries)).toEqual([4, 5, 6, 7]);
    expect(deliveries.every((delivery) => !delivery.resync)).toBe(true);
    expect(sub.lastDeliveredSeq).toBe(7);
  });

  it("clamps a Last-Event-ID ahead of the durable tail instead of swallowing the live tail", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    for (let i = 0; i < 3; i += 1) {
      await publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1));
    }
    const sub = bus.subscribe(RUN_A, { fromSeq: 99 }); // stale client claim
    await tick(); // clamp (tail=3) + empty backfill settle
    await publish(bus, RUN_A, "step.finished", stepFinishedPayload(4));
    const deliveries = await collect(sub, 1);
    expect(seqs(deliveries)).toEqual([4]);
    expect(deliveries[0]?.resync).toBe(false); // contiguous against the clamped checkpoint
  });

  it("pages the backfill when history exceeds the page limit", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store, backfillPageLimit: 3 });
    for (let i = 0; i < 10; i += 1) {
      await publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1));
    }
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    const deliveries = await collect(sub, 10);
    expect(seqs(deliveries)).toEqual(range(1, 10));
    expect(store.sinceSeqCalls.map((call) => call.afterSeq)).toEqual([0, 3, 6, 9]);
  });

  it("ends the stream after a terminal event, live or via backfill; later publishes still persist", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    const ends: StreamEnd[] = [];
    sub.onEnd((end) => ends.push(end));
    const done = collectToEnd(sub);
    await tick();
    await publish(bus, RUN_A, "run.queued", queuedPayload());
    await publish(bus, RUN_A, "run.succeeded", succeededPayload());
    const liveDeliveries = await done;
    expect(seqs(liveDeliveries)).toEqual([1, 2]);
    expect(sub.ended).toBe(true);
    expect(ends[0]?.reason).toBe("terminal");
    // durable-first: publishing post-terminal still persists (no listener breaks)
    const after = await publish(bus, RUN_A, "run.failed", failedPayload());
    expect(after.ok ? after.event.seq : -1).toBe(3);
    // a late subscriber backfills the full history and ends at the terminal row
    const late = bus.subscribe(RUN_A, { fromSeq: 0 });
    const lateDeliveries = await collectToEnd(late);
    expect(seqs(lateDeliveries)).toEqual([1, 2, 3]);
    expect(late.ended).toBe(true);
  });

  it("callback mode receives ordered deliveries and can be unregistered", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    const seen: EventDelivery[] = [];
    const off = sub.onDelivery((delivery) => seen.push(delivery));
    await tick();
    await publish(bus, RUN_A, "run.queued", queuedPayload());
    await publish(bus, RUN_A, "run.started", startedPayload());
    await tick();
    expect(seqs(seen)).toEqual([1, 2]);
    off();
    await publish(bus, RUN_A, "preview.updated", previewPayload());
    await tick();
    expect(seqs(seen)).toEqual([1, 2]); // unregistered: no delivery
    const rest = await collect(sub, 1); // iterator mode picks up the buffered event
    expect(seqs(rest)).toEqual([3]);
  });

  it("unsubscribe ends the iterator and reports 'unsubscribed'", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    const ends: StreamEnd[] = [];
    sub.onEnd((end) => ends.push(end));
    const done = collectToEnd(sub);
    sub.unsubscribe();
    expect(await done).toEqual([]);
    expect(sub.ended).toBe(true);
    expect(ends[0]?.reason).toBe("unsubscribed");
  });

  it("close() ends every subscription with reason 'closed'; publishes still persist", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    const first = bus.subscribe(RUN_A, { fromSeq: 0 });
    const second = bus.subscribe(RUN_B, { fromSeq: 0 });
    const ends: StreamEnd[] = [];
    first.onEnd((end) => ends.push(end));
    second.onEnd((end) => ends.push(end));
    bus.close();
    expect(first.ended && second.ended).toBe(true);
    expect(ends.map((end) => end.reason)).toEqual(["closed", "closed"]);
    const result = await publish(bus, RUN_A, "run.queued", queuedPayload());
    expect(result.ok ? result.event.seq : -1).toBe(1); // durable-first at shutdown
    expect(store.list(RUN_A).length).toBe(1);
  });

  it("ends the stream with a typed failure when the backfill read fails", async () => {
    const store = new FakeEventStore();
    store.failSinceSeq = true;
    const bus = new RunEventBus({ store });
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    const ends: StreamEnd[] = [];
    sub.onEnd((end) => ends.push(end));
    const deliveries = await collectToEnd(sub);
    expect(deliveries).toEqual([]);
    expect(sub.ended).toBe(true);
    const end = ends[0];
    expect(end?.reason).toBe("backfill_failed");
    expect(end?.failure?.code).toBe("event_store_unavailable");
    expect(end?.failure?.retryable).toBe(true);
  });
});

// --- backpressure: drop-slowest + gap detection + healing (§13.2) ------------------------

describe("eventbus backpressure + gap detection", () => {
  it("drop-slowest: a stalled consumer sheds its OLDEST events and flags resync; a keeping-pace consumer is unaffected", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store, queueCap: 4 });
    const slow = bus.subscribe(RUN_A, { fromSeq: 0 });
    const fastSeen: EventDelivery[] = [];
    const fast = bus.subscribe(RUN_A, { fromSeq: 0 });
    fast.onDelivery((delivery) => fastSeen.push(delivery));
    await tick(); // both backfills settle against an empty store
    for (let i = 0; i < 20; i += 1) {
      await publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1));
    }
    await tick();
    // the keeping-pace consumer got everything — no shedding, no resync
    expect(seqs(fastSeen)).toEqual(range(1, 20));
    expect(fast.dropped).toBe(0);
    expect(fast.needsResync).toBe(false);
    // the stalled (slowest) consumer shed its oldest events, kept the newest
    expect(slow.dropped).toBe(16);
    const slowDeliveries = await collect(slow, 4);
    expect(seqs(slowDeliveries)).toEqual([17, 18, 19, 20]); // newest kept for Last-Event-ID
    expect(slowDeliveries.map((delivery) => delivery.resync)).toEqual([true, false, false, false]);
    expect(slow.needsResync).toBe(true);
    expect(slow.lastDeliveredSeq).toBe(20);
  });

  it("flags resync when the durable store has a hole (external writer / pruned history)", async () => {
    const store = new FakeEventStore();
    store.seed(RUN_A, { seq: 1, type: "run.queued", payload: queuedPayload(), organizationId: ORG });
    store.seed(RUN_A, { seq: 2, type: "run.started", payload: startedPayload(), organizationId: ORG });
    store.seed(RUN_A, { seq: 4, type: "preview.updated", payload: previewPayload(), organizationId: ORG });
    const bus = new RunEventBus({ store });
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    const deliveries = await collect(sub, 3);
    expect(seqs(deliveries)).toEqual([1, 2, 4]);
    expect(deliveries.map((delivery) => delivery.resync)).toEqual([false, false, true]);
    expect(sub.needsResync).toBe(true);
  });

  it("re-fetches (heals) live events shed during backfill — the consumer sees a contiguous stream, no resync flag", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store, queueCap: 4, backfillPageLimit: 1 });
    const gates: Deferred[] = [];
    store.sinceSeqGate = () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    };
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    await tick(); // backfill opens page 1 and parks on the gate
    expect(gates.length).toBe(1);

    // 6 live events while backfill is parked: queueCap 4 sheds seqs 1, 2 from
    // the live buffer (they sit above the backfill cursor — healable)
    for (let i = 0; i < 6; i += 1) {
      await publish(bus, RUN_A, "step.finished", stepFinishedPayload(i + 1));
    }
    expect(sub.dropped).toBe(2);

    const iterator = sub[Symbol.asyncIterator]();
    const pulls: Array<Promise<IteratorResult<EventDelivery, undefined>>> = [
      iterator.next(), // parks on the empty queue
    ];
    await tick();

    gates[0]?.resolve(); // page 1: store row seq 1 — heals the first shed event
    let deliveries: EventDelivery[] = [];
    let result = await (pulls[0] as Promise<IteratorResult<EventDelivery, undefined>>);
    expect(result.done).toBe(false);
    if (!result.done) {
      deliveries.push(result.value);
    }

    pulls.push(iterator.next());
    await tick();
    gates[1]?.resolve(); // page 2: store row seq 2 — heals the second shed event
    result = await (pulls[1] as Promise<IteratorResult<EventDelivery, undefined>>);
    expect(result.done).toBe(false);
    if (!result.done) {
      deliveries.push(result.value);
    }

    pulls.push(iterator.next());
    await tick();
    gates[2]?.resolve(); // page 3: row seq 3 >= live floor → stop; live tail flushes
    result = await (pulls[2] as Promise<IteratorResult<EventDelivery, undefined>>);
    expect(result.done).toBe(false);
    if (!result.done) {
      deliveries.push(result.value);
    }
    for (let i = 0; i < 3; i += 1) {
      const next = await iterator.next(); // 4, 5, 6 already buffered
      expect(next.done).toBe(false);
      if (!next.done) {
        deliveries.push(next.value);
      }
    }
    expect(seqs(deliveries)).toEqual([1, 2, 3, 4, 5, 6]); // contiguous despite shedding
    expect(deliveries.every((delivery) => !delivery.resync)).toBe(true);
    expect(sub.needsResync).toBe(false); // healed: the gap never reached the consumer
    expect(sub.lastDeliveredSeq).toBe(6);
  });
});

// --- redaction (§22 / §15.3) ---------------------------------------------------------------

describe("eventbus redaction policy", () => {
  it("delivers redacted payloads while the durable row keeps the raw record (§22 redaction, §15.3 retention)", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store }); // default policy: redact everything sensitive
    const seen: EventDelivery[] = [];
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    sub.onDelivery((delivery) => seen.push(delivery));
    await tick();
    await bus.publish(RUN_A, "run.plan", planPayload(), { organizationId: ORG });
    await bus.publish(RUN_A, "run.failed", failedPayload(), { organizationId: ORG });
    await bus.publish(RUN_A, "run.queued", queuedPayload(), { organizationId: ORG });
    await tick();

    const planDelivery = seen.find((delivery) => delivery.event.type === "run.plan");
    const plan = planDelivery?.event.payload as RunEventPayloadMap["run.plan"];
    expect(plan.plan.slots.headline).toBe(REDACTED); // §6.2 slot fill — user copy
    expect(plan.plan.notes_for_user).toBe(REDACTED);
    const stepArgs = plan.plan.steps[0]?.args as Record<string, unknown>;
    expect(stepArgs.text).toBe(REDACTED); // sensitive key
    expect(stepArgs.name).toBe("Headline"); // non-sensitive key passes through
    expect(plan.plan.intent).toBe("create_post"); // structural fields intact
    expect(plan.plan.template).toBe("instagram-post@3");
    expect(plan.plan.model_tier).toBe("standard");

    const failDelivery = seen.find((delivery) => delivery.event.type === "run.failed");
    const fail = failDelivery?.event.payload as RunEventPayloadMap["run.failed"];
    expect(fail.error.message).toBe("The editor did not respond in time"); // curated §13.3 envelope
    const queuedDelivery = seen.find((delivery) => delivery.event.type === "run.queued");
    expect((queuedDelivery?.event.payload as RunEventPayloadMap["run.queued"]).tier).toBe("quick");

    // the durable record is complete/raw (§15.3)
    const rawEntry = store.appendLog.find((entry) => entry.row.type === "run.plan");
    const raw = rawEntry?.row.payload as RunEventPayloadMap["run.plan"];
    expect(raw.plan.slots.headline).toBe("Launch day headline copy");
    expect(raw.plan.notes_for_user).toBe("Notes paraphrasing the brief");
    const rawArgs = raw.plan.steps[0]?.args as Record<string, unknown>;
    expect(rawArgs.text).toBe("Body copy from the user brief");
  });

  it("workspace opt-in delivers raw prompt text (boolean and predicate forms, §22)", async () => {
    const optedIn = new RunEventBus({
      store: new FakeEventStore(),
      redaction: new DefaultRedactionPolicy({ promptTextOptIn: true }),
    });
    const seenIn: EventDelivery[] = [];
    const subIn = optedIn.subscribe(RUN_A, { fromSeq: 0 });
    subIn.onDelivery((delivery) => seenIn.push(delivery));
    await tick();
    await optedIn.publish(RUN_A, "run.plan", planPayload(), { organizationId: ORG });
    await tick();
    const planIn = (seenIn[0]?.event.payload as RunEventPayloadMap["run.plan"]) ?? { plan: null };
    expect(planIn.plan?.slots.headline).toBe("Launch day headline copy");

    const predicateBus = new RunEventBus({
      store: new FakeEventStore(),
      redaction: new DefaultRedactionPolicy({ promptTextOptIn: (org) => org === ORG }),
    });
    const seenOpt: EventDelivery[] = [];
    const seenOther: EventDelivery[] = [];
    const subOpt = predicateBus.subscribe(RUN_A, { fromSeq: 0 });
    const subOther = predicateBus.subscribe(RUN_B, { fromSeq: 0 });
    subOpt.onDelivery((delivery) => seenOpt.push(delivery));
    subOther.onDelivery((delivery) => seenOther.push(delivery));
    await tick();
    await predicateBus.publish(RUN_A, "run.plan", planPayload(), { organizationId: ORG });
    await predicateBus.publish(RUN_B, "run.plan", planPayload(), { organizationId: ORG_OTHER });
    await tick();
    const planOpt = seenOpt[0]?.event.payload as RunEventPayloadMap["run.plan"];
    const planOther = seenOther[0]?.event.payload as RunEventPayloadMap["run.plan"];
    expect(planOpt.plan.slots.headline).toBe("Launch day headline copy"); // opted-in org: raw
    expect(planOther.plan.slots.headline).toBe(REDACTED); // everyone else: redacted
  });

  it("accepts any injectable policy and transforms payloads by event type", async () => {
    const upperCaseReasons: RedactionPolicy = {
      redactPayload: (type, payload) => {
        if (type !== "run.cancelled") {
          return payload;
        }
        const cancelled = payload as RunEventPayloadMap["run.cancelled"];
        return { ...cancelled, reason: cancelled.reason.toUpperCase() };
      },
    };
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store, redaction: upperCaseReasons });
    const seen: EventDelivery[] = [];
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 });
    sub.onDelivery((delivery) => seen.push(delivery));
    await tick();
    await bus.publish(RUN_A, "run.cancelled", { reason: "user hit stop" }, { organizationId: ORG });
    await tick();
    const cancelled = seen[0]?.event.payload as RunEventPayloadMap["run.cancelled"];
    expect(cancelled.reason).toBe("USER HIT STOP"); // policy applied by type
    const raw = store.appendLog[0]?.row.payload as RunEventPayloadMap["run.cancelled"];
    expect(raw.reason).toBe("user hit stop"); // durable row unaffected
  });

  it("redacts backfill deliveries identically to live ones, with §22 correlation fields", async () => {
    const store = new FakeEventStore();
    const bus = new RunEventBus({ store });
    await bus.publish(RUN_A, "run.plan", planPayload(), { organizationId: ORG }); // no live listener
    const sub = bus.subscribe(RUN_A, { fromSeq: 0 }); // everything arrives via backfill
    const deliveries = await collect(sub, 1);
    const delivery = deliveries[0];
    expect(delivery).toBeDefined();
    if (delivery !== undefined) {
      expect(delivery.event.type).toBe("run.plan");
      expect(delivery.event.runId).toBe(RUN_A);
      expect(delivery.event.organizationId).toBe(ORG);
      expect(delivery.event.seq).toBe(1);
      expect(delivery.event.at).toBeInstanceOf(Date);
      const plan = delivery.event.payload as RunEventPayloadMap["run.plan"];
      expect(plan.plan.slots.headline).toBe(REDACTED); // §22 applies to backfill too
    }
  });
});

// --- tenant filter (§15.1) --------------------------------------------------------------------

describe("eventbus tenant filter", () => {
  it("skips foreign-organization rows in backfill and flags the gap at drain time", async () => {
    const store = new FakeEventStore();
    store.seed(RUN_A, { seq: 1, type: "run.queued", payload: queuedPayload(), organizationId: ORG });
    store.seed(RUN_A, {
      seq: 2,
      type: "run.queued",
      payload: queuedPayload(),
      organizationId: ORG_OTHER, // never delivered to the ORG subscriber
    });
    store.seed(RUN_A, { seq: 3, type: "run.started", payload: startedPayload(), organizationId: ORG });
    const bus = new RunEventBus({ store });
    const sub = bus.subscribe(RUN_A, { fromSeq: 0, organizationId: ORG });
    const deliveries = await collect(sub, 2);
    expect(seqs(deliveries)).toEqual([1, 3]);
    expect(deliveries.map((delivery) => delivery.resync)).toEqual([false, true]);
    expect(sub.needsResync).toBe(true);
  });
});
