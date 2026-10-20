// EnginePool — allocation, tenant isolation, caps, idle eviction, watchdog, drain.
// Everything runs against FakeSpawner; no engine process is ever spawned.

import { describe, expect, it } from "vitest";

import { DEFAULT_IDLE_TIMEOUT_MS } from "../src/constants.js";
import { EnginePool } from "../src/pool.js";
import { isEnginePoolError, type EnginePoolError } from "../src/errors.js";
import type { EnginePoolOptions, PoolEvent, SessionSpec } from "../src/types.js";
import {
  FakeSpawner,
  ManualClock,
  expectEnginePoolError,
  expectEnginePoolReject,
} from "./fakes.js";

interface Harness {
  readonly pool: EnginePool;
  readonly spawner: FakeSpawner;
  readonly clock: ManualClock;
  readonly events: PoolEvent[];
}

const makePool = (overrides: Partial<EnginePoolOptions> = {}): Harness => {
  const spawner = new FakeSpawner();
  const clock = new ManualClock();
  const events: PoolEvent[] = [];
  const pool = new EnginePool({
    spawner,
    limits: { getLimits: () => ({ maxConcurrentEngineSessions: 1 }) },
    clock: clock.now,
    onSessionEvent: (event) => events.push(event),
    ...overrides,
  });
  return { pool, spawner, clock, events };
};

const spec = (organizationId = "org-1"): SessionSpec => ({
  organizationId,
  readRoot: `/ws/${organizationId}/read`,
  writeRoot: `/ws/${organizationId}/write`,
});

const processFor = (harness: Harness, index = 0) => {
  const process = harness.spawner.processes.at(index);
  if (!process) throw new Error(`expected fake process #${index}`);
  return process;
};

const eventTypes = (events: readonly PoolEvent[]): string[] => events.map((e) => e.type);

describe("EnginePool", () => {
  it("allocates a session with a fresh 256-bit token and wires the spawner (§3.2)", async () => {
    const harness = makePool();
    const session = await harness.pool.allocate(spec("org-1"));
    expect(session.state).toBe("allocated");
    expect(session.organizationId).toBe("org-1");
    expect(session.lastActivityAt).toBe(session.startedAt);
    // §3.2: unique random token — 256 bits, hex-encoded.
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);

    const request = harness.spawner.requests.at(0);
    if (!request) throw new Error("spawner.spawn was never called");
    expect(request.sessionId).toBe(session.sessionId);
    expect(request.organizationId).toBe("org-1");
    expect(request.readRoot).toBe("/ws/org-1/read");
    expect(request.writeRoot).toBe("/ws/org-1/write");
    expect(request.token).toBe(session.token);

    const process = processFor(harness);
    expect(process.startCalls).toHaveLength(1);
    expect(process.startCalls.at(0)?.token).toBe(session.token);
    expect(typeof process.pid).toBe("number");
    expect(harness.pool.get(session.sessionId, "org-1").sessionId).toBe(session.sessionId);
    expect(eventTypes(harness.events)).toContain("session_allocated");
  });

  it("mints a distinct id and token for every session", async () => {
    const harness = makePool({
      limits: { getLimits: () => ({ maxConcurrentEngineSessions: 2 }) },
    });
    const first = await harness.pool.allocate(spec("org-1"));
    const second = await harness.pool.allocate(spec("org-1"));
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.token).not.toBe(second.token);
  });

  it("rejects cross-tenant access as session_not_found — no existence leak (§25 rule 4)", async () => {
    const harness = makePool({
      limits: { getLimits: () => ({ maxConcurrentEngineSessions: 2 }) },
    });
    const session = await harness.pool.allocate(spec("org-1"));
    await harness.pool.allocate(spec("org-2"));
    expectEnginePoolError(() => harness.pool.get(session.sessionId, "org-2"), "session_not_found");
    expectEnginePoolError(
      () => harness.pool.attach(session.sessionId, "org-2", "doc-1"),
      "session_not_found",
    );
    expectEnginePoolError(
      () => harness.pool.touch(session.sessionId, "org-2"),
      "session_not_found",
    );
    expectEnginePoolError(
      () => harness.pool.markIdle(session.sessionId, "org-2"),
      "session_not_found",
    );
    // The owning tenant is unaffected.
    expect(harness.pool.get(session.sessionId, "org-1").state).toBe("allocated");
  });

  it("enforces per-organization concurrency caps from the plan provider (§3.2)", async () => {
    const harness = makePool();
    const first = await harness.pool.allocate(spec("org-1"));
    const error = await expectEnginePoolReject(
      harness.pool.allocate(spec("org-1")),
      "session_limit_reached",
    );
    expect(error.toEnvelope().hint).toBeDefined();
    // Caps are per organization: org-2 is not blocked by org-1's session.
    const other = await harness.pool.allocate(spec("org-2"));
    expect(harness.pool.get(other.sessionId, "org-2").state).toBe("allocated");
    // Releasing frees the slot.
    await harness.pool.release(first.sessionId);
    expect(eventTypes(harness.events)).toContain("session_released");
    const third = await harness.pool.allocate(spec("org-1"));
    expect(harness.pool.get(third.sessionId, "org-1").state).toBe("allocated");
  });

  it("does not oversubscribe when two allocations race", async () => {
    const harness = makePool();
    const outcomes = await Promise.allSettled([
      harness.pool.allocate(spec("org-1")),
      harness.pool.allocate(spec("org-1")),
    ]);
    const rejected = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected.at(0);
    expect(isEnginePoolError(reason)).toBe(true);
    expect((reason as EnginePoolError).code).toBe("session_limit_reached");
  });

  it("wraps spawner failures as spawn_failed without leaking internals", async () => {
    const harness = makePool();
    harness.spawner.spawnBehavior = "throw";
    const error = await expectEnginePoolReject(
      harness.pool.allocate(spec("org-1")),
      "spawn_failed",
    );
    // §4: no absolute paths or internals in user-facing messages.
    expect(error.toEnvelope().message).not.toContain("/opt/secret");
    expect(harness.spawner.processes).toHaveLength(0);
    // The failed attempt consumed no cap slot.
    harness.spawner.spawnBehavior = "ok";
    const session = await harness.pool.allocate(spec("org-1"));
    expect(harness.pool.get(session.sessionId, "org-1").state).toBe("allocated");
  });

  it("wraps process start failures as spawn_failed", async () => {
    const harness = makePool();
    harness.spawner.startBehavior = "reject";
    await expectEnginePoolReject(harness.pool.allocate(spec("org-1")), "spawn_failed");
    expect(harness.pool.snapshot().total).toBe(0);
  });

  it("recycles idle sessions on the watchdog tick (§3.4: per-session idle 15 min)", async () => {
    const harness = makePool();
    const session = await harness.pool.allocate(spec("org-1"));
    const process = processFor(harness);
    harness.clock.advance(DEFAULT_IDLE_TIMEOUT_MS + 1);
    const report = await harness.pool.watchdogTick();
    expect(report.inspected).toBe(1);
    expect(report.evicted).toEqual([session.sessionId]);
    expect(process.stopCalls).toEqual(["SIGTERM"]);
    expectEnginePoolError(
      () => harness.pool.get(session.sessionId, "org-1"),
      "session_not_found",
    );
    expect(eventTypes(harness.events)).toContain("session_evicted");
    // A fresh session survives the next tick.
    const fresh = await harness.pool.allocate(spec("org-1"));
    const second = await harness.pool.watchdogTick();
    expect(second.evicted).toEqual([]);
    expect(harness.pool.get(fresh.sessionId, "org-1").state).toBe("allocated");
  });

  it("marks crashed sessions and lets the tenant recover (§3.4 crash recovery)", async () => {
    const harness = makePool();
    const session = await harness.pool.allocate(spec("org-1"));
    processFor(harness).crash();
    expect(harness.pool.get(session.sessionId, "org-1").state).toBe("crashed");
    expect(eventTypes(harness.events)).toContain("session_crashed");
    const report = await harness.pool.watchdogTick();
    expect(report.crashed).toEqual([session.sessionId]);
    expect(report.evicted).toEqual([]);
    // A crashed session does not consume the plan cap: the worker's replay may
    // allocate a replacement immediately.
    const replacement = await harness.pool.allocate(spec("org-1"));
    expect(harness.pool.get(replacement.sessionId, "org-1").state).toBe("allocated");
    expectEnginePoolError(
      () => harness.pool.attach(session.sessionId, "org-1", "doc-1"),
      "engine_unavailable",
    );
  });

  it("reports watchdog_timeout when a session ignores SIGTERM", async () => {
    const harness = makePool({ drainGraceMs: 20, idleTimeoutMs: 10 });
    harness.spawner.stopBehavior = "hang";
    const session = await harness.pool.allocate(spec("org-1"));
    harness.clock.advance(50);
    const report = await harness.pool.watchdogTick();
    expect(report.evicted).toEqual([]);
    expect(report.stopFailures).toHaveLength(1);
    const failure = report.stopFailures.at(0);
    if (!failure) throw new Error("expected a stop failure");
    expect(failure.sessionId).toBe(session.sessionId);
    expect(failure.envelope.code).toBe("watchdog_timeout");
    // Kept visible as crashed instead of vanishing; Wave 2 escalates to SIGKILL.
    expect(harness.pool.get(session.sessionId, "org-1").state).toBe("crashed");
  });

  it("drains every session gracefully and refuses new allocations", async () => {
    const harness = makePool();
    const first = await harness.pool.allocate(spec("org-1"));
    const second = await harness.pool.allocate(spec("org-2"));
    await harness.pool.drain();
    expect(processFor(harness, 0).stopCalls).toEqual(["SIGTERM"]);
    expect(processFor(harness, 1).stopCalls).toEqual(["SIGTERM"]);
    expectEnginePoolError(
      () => harness.pool.get(first.sessionId, "org-1"),
      "session_not_found",
    );
    expectEnginePoolError(
      () => harness.pool.get(second.sessionId, "org-2"),
      "session_not_found",
    );
    expect(harness.pool.snapshot().total).toBe(0);
    expect(eventTypes(harness.events)).toContain("pool_drained");
    await expectEnginePoolReject(harness.pool.allocate(spec("org-1")), "engine_unavailable");
  });

  it("drains even when a session refuses to stop", async () => {
    const harness = makePool({ drainGraceMs: 20 });
    harness.spawner.stopBehavior = "hang";
    const session = await harness.pool.allocate(spec("org-1"));
    await harness.pool.drain();
    expect(harness.pool.snapshot().total).toBe(0);
    expectEnginePoolError(
      () => harness.pool.get(session.sessionId, "org-1"),
      "session_not_found",
    );
  });

  it("runs the allocate → attach → run → idle lifecycle (§3.2)", async () => {
    const harness = makePool();
    const session = await harness.pool.allocate(spec("org-1"));
    const attached = harness.pool.attach(session.sessionId, "org-1", "doc-1");
    expect(attached.state).toBe("attached");
    expect(attached.documentId).toBe("doc-1");
    // Re-attaching the same document is idempotent.
    expect(harness.pool.attach(session.sessionId, "org-1", "doc-1").state).toBe("attached");
    // A session belongs to exactly one document; rebinding is refused.
    expectEnginePoolError(
      () => harness.pool.attach(session.sessionId, "org-1", "doc-2"),
      "session_not_found",
    );
    // touch resets the idle clock.
    harness.clock.advance(60_000);
    const touched = harness.pool.touch(session.sessionId, "org-1");
    expect(touched.lastActivityAt).toBe(harness.clock.now());
    const idle = harness.pool.markIdle(session.sessionId, "org-1");
    expect(idle.state).toBe("idle");
    expect(eventTypes(harness.events)).toContain("session_idle");
  });

  it("never lets observer errors affect pool state (§22)", async () => {
    const spawner = new FakeSpawner();
    const clock = new ManualClock();
    const pool = new EnginePool({
      spawner,
      limits: { getLimits: () => ({ maxConcurrentEngineSessions: 1 }) },
      clock: clock.now,
      onSessionEvent: () => {
        throw new Error("observer bug");
      },
    });
    const session = await pool.allocate(spec("org-1"));
    expect(pool.get(session.sessionId, "org-1").state).toBe("allocated");
    await pool.release(session.sessionId);
    expect(pool.snapshot().total).toBe(0);
  });
});
