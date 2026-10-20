// HealthMonitor — §3.2 session health probe: methods roundtrip with timeout,
// healthy|slow|dead classification, liveness → registry touch, watchdog sweep.
// All fakes; the only real timers are the tiny probe windows tests opt into.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEALTH_THRESHOLDS,
  HealthMonitor,
  classifyHealthProbe,
  createLivenessRecorder,
  resolveHealthThresholds,
  type HealthProbeClient,
  type HealthProbeOutcome,
  type HealthThresholds,
  type LivenessRecorder,
  type SessionHealthStatus,
} from "../src/health.js";
import { SessionRegistry } from "../src/registry.js";
import type { EngineSession } from "../src/types.js";
import { ManualClock } from "./fakes.js";

// ---------------------------------------------------------------------------
// Deterministic fakes
// ---------------------------------------------------------------------------

const session = (sessionId: string): EngineSession => ({
  sessionId,
  organizationId: "org-1",
  documentId: "doc-1",
  token: "0".repeat(64),
  startedAt: 0,
  lastActivityAt: 0,
  state: "attached",
});

type Role = "ok" | "slow" | "hang" | "reject";

class ScriptedProbeClient implements HealthProbeClient {
  readonly probed: string[] = [];
  readonly script: Record<string, Role> = {};
  readonly #clock: ManualClock | undefined;

  constructor(clock?: ManualClock) {
    this.#clock = clock;
  }

  async methods(current: EngineSession): Promise<readonly string[]> {
    this.probed.push(current.sessionId);
    const role = this.script[current.sessionId] ?? "ok";
    if (role === "reject") {
      throw new Error("fake: connection refused (token 0xdeadbeef)");
    }
    if (role === "hang") {
      return await new Promise<never>(() => undefined);
    }
    if (role === "slow") {
      this.#clock?.advance(DEFAULT_HEALTH_THRESHOLDS.slowMs + 200);
    }
    return ["methods", "doc.save", "batch"];
  }
}

class RecordingLiveness implements LivenessRecorder {
  readonly touches: Array<[string, number]> = [];
  fail = false;

  touch(sessionId: string, at: number): void {
    if (this.fail) throw new Error("raced with recycle");
    this.touches.push([sessionId, at]);
  }
}

interface LogSink {
  readonly warns: Array<{ message: string; data?: Record<string, unknown> }>;
}

const logger = (): { warn: (message: string, data?: Record<string, unknown>) => void } & LogSink => {
  const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
  return {
    warns,
    warn: (message, data): void => {
      warns.push({ message, data });
    },
  };
};

// ---------------------------------------------------------------------------
// Pure classification table
// ---------------------------------------------------------------------------

interface ClassifyRow {
  readonly name: string;
  readonly outcome: HealthProbeOutcome;
  readonly expected: SessionHealthStatus;
}

const classifyRows: readonly ClassifyRow[] = [
  { name: "instant reply is healthy", outcome: { ok: true, latencyMs: 0 }, expected: "healthy" },
  { name: "just under slow is healthy", outcome: { ok: true, latencyMs: 999 }, expected: "healthy" },
  {
    name: "at the slow threshold is slow",
    outcome: { ok: true, latencyMs: DEFAULT_HEALTH_THRESHOLDS.slowMs },
    expected: "slow",
  },
  {
    name: "just under dead is slow",
    outcome: { ok: true, latencyMs: DEFAULT_HEALTH_THRESHOLDS.deadMs - 1 },
    expected: "slow",
  },
  {
    name: "at the dead threshold is dead",
    outcome: { ok: true, latencyMs: DEFAULT_HEALTH_THRESHOLDS.deadMs },
    expected: "dead",
  },
  { name: "pathologically slow reply is dead", outcome: { ok: true, latencyMs: 9_999 }, expected: "dead" },
  { name: "timeout is dead", outcome: { ok: false, reason: "timeout" }, expected: "dead" },
  { name: "error is dead", outcome: { ok: false, reason: "error" }, expected: "dead" },
];

describe("classifyHealthProbe", () => {
  it.each(classifyRows)("$name", ({ outcome, expected }) => {
    expect(classifyHealthProbe(outcome)).toBe(expected);
  });

  it("honors custom thresholds", () => {
    const tight: HealthThresholds = { slowMs: 50, deadMs: 100, probeTimeoutMs: 1_000 };
    expect(classifyHealthProbe({ ok: true, latencyMs: 49 }, tight)).toBe("healthy");
    expect(classifyHealthProbe({ ok: true, latencyMs: 50 }, tight)).toBe("slow");
    expect(classifyHealthProbe({ ok: true, latencyMs: 100 }, tight)).toBe("dead");
  });
});

describe("resolveHealthThresholds", () => {
  it("merges partials over the defaults", () => {
    expect(resolveHealthThresholds({ slowMs: 250 })).toEqual({
      slowMs: 250,
      deadMs: DEFAULT_HEALTH_THRESHOLDS.deadMs,
      probeTimeoutMs: DEFAULT_HEALTH_THRESHOLDS.probeTimeoutMs,
    });
  });

  it.each([
    ["slowMs must be positive", { slowMs: 0 }],
    ["slowMs must be finite", { slowMs: Number.POSITIVE_INFINITY }],
    ["deadMs cannot precede slowMs", { deadMs: 100 }],
    ["probe window cannot precede deadMs", { probeTimeoutMs: 2_000 }],
  ])("fails fast when %s", (_name, partial) => {
    expect(() => resolveHealthThresholds(partial)).toThrow(/0 < slowMs <= deadMs <= probeTimeoutMs/);
  });
});

// ---------------------------------------------------------------------------
// HealthMonitor.probe
// ---------------------------------------------------------------------------

describe("HealthMonitor.probe (methods roundtrip, §Appendix B)", () => {
  it("classifies a fast reply healthy and records liveness in the registry", async () => {
    const clock = new ManualClock(10_000);
    const client = new ScriptedProbeClient();
    const liveness = new RecordingLiveness();
    const monitor = new HealthMonitor({ client, liveness, clock: clock.now });

    const report = await monitor.probe(session("s-1"));

    expect(client.probed).toEqual(["s-1"]);
    expect(report).toEqual({
      sessionId: "s-1",
      status: "healthy",
      latencyMs: 0,
      detail: "engine replied to the methods roundtrip within budget",
      checkedAt: 10_000,
    });
    expect(liveness.touches).toEqual([["s-1", 10_000]]);
  });

  it("classifies a slow reply slow and still records liveness", async () => {
    const clock = new ManualClock(0);
    const client = new ScriptedProbeClient(clock);
    client.script["s-1"] = "slow";
    const liveness = new RecordingLiveness();
    const monitor = new HealthMonitor({ client, liveness, clock: clock.now });

    const report = await monitor.probe(session("s-1"));

    expect(report.status).toBe("slow");
    expect(report.latencyMs).toBe(DEFAULT_HEALTH_THRESHOLDS.slowMs + 200);
    expect(liveness.touches).toHaveLength(1);
  });

  it("classifies a reply past the dead threshold dead and touches nothing", async () => {
    const clock = new ManualClock(0);
    const client = new ScriptedProbeClient(clock);
    const liveness = new RecordingLiveness();
    const monitor = new HealthMonitor({
      client,
      liveness,
      clock: clock.now,
      thresholds: { slowMs: 50, deadMs: 100 },
    });
    // "slow" advances the clock well past the tight dead threshold, but the reply
    // still arrives inside the (default) probe window.
    client.script["s-1"] = "slow";

    const report = await monitor.probe(session("s-1"));

    expect(report.status).toBe("dead");
    expect(report.latencyMs).toBe(DEFAULT_HEALTH_THRESHOLDS.slowMs + 200);
    expect(report.reason).toBeUndefined();
    expect(report.detail).toBe("engine replied beyond the dead threshold");
    expect(liveness.touches).toHaveLength(0);
  });

  it("classifies a hung engine dead by timeout without real waiting", async () => {
    const clock = new ManualClock(0);
    const client = new ScriptedProbeClient();
    client.script["s-1"] = "hang";
    const liveness = new RecordingLiveness();
    const monitor = new HealthMonitor({
      client,
      liveness,
      clock: clock.now,
      deadline: () => Promise.resolve("timeout"),
    });

    const report = await monitor.probe(session("s-1"));

    expect(report.status).toBe("dead");
    expect(report.latencyMs).toBeNull();
    expect(report.reason).toBe("timeout");
    expect(report.detail).toBe("engine did not reply to the probe within the window");
    expect(liveness.touches).toHaveLength(0);
  });

  it("exercises the default timer deadline on a hung engine (tiny real window)", async () => {
    const client = new ScriptedProbeClient();
    client.script["s-1"] = "hang";
    const monitor = new HealthMonitor({
      client,
      thresholds: { probeTimeoutMs: 10 },
    });

    const report = await monitor.probe(session("s-1"));

    expect(report.status).toBe("dead");
    expect(report.reason).toBe("timeout");
  });

  it("classifies a rejected probe dead with a generic, leak-free detail", async () => {
    const clock = new ManualClock(0);
    const client = new ScriptedProbeClient();
    client.script["s-1"] = "reject";
    const sink = logger();
    const liveness = new RecordingLiveness();
    const monitor = new HealthMonitor({
      client,
      liveness,
      clock: clock.now,
      logger: { warn: sink.warn },
    });

    const report = await monitor.probe(session("s-1"));

    expect(report.status).toBe("dead");
    expect(report.reason).toBe("error");
    expect(report.detail).toBe("engine probe failed");
    expect(JSON.stringify(report)).not.toContain("0xdeadbeef");
    expect(liveness.touches).toHaveLength(0);
    expect(sink.warns).toHaveLength(1);
  });

  it("survives a liveness recorder that throws (probe result is unaffected)", async () => {
    const clock = new ManualClock(0);
    const client = new ScriptedProbeClient();
    const sink = logger();
    const liveness = new RecordingLiveness();
    liveness.fail = true;
    const monitor = new HealthMonitor({
      client,
      liveness,
      clock: clock.now,
      logger: { warn: sink.warn },
    });

    const report = await monitor.probe(session("s-1"));

    expect(report.status).toBe("healthy");
    expect(sink.warns).toHaveLength(1);
    expect(sink.warns.at(0)?.message).toBe("engine-pool: liveness recorder failed");
  });
});

// ---------------------------------------------------------------------------
// HealthMonitor.sweep — the pool watchdog feed (§3.2)
// ---------------------------------------------------------------------------

describe("HealthMonitor.sweep (watchdog feed)", () => {
  it("probes concurrently and aggregates per status for the watchdog", async () => {
    const clock = new ManualClock(0);
    const client = new ScriptedProbeClient(clock);
    client.script["s-ok"] = "ok";
    client.script["s-slow"] = "slow";
    client.script["s-reject"] = "reject";
    client.script["s-hang"] = "hang";
    const liveness = new RecordingLiveness();
    const monitor = new HealthMonitor({
      client,
      liveness,
      clock: clock.now,
      thresholds: { probeTimeoutMs: 10 },
    });

    const sweep = await monitor.sweep([
      session("s-ok"),
      session("s-slow"),
      session("s-reject"),
      session("s-hang"),
    ]);

    expect(sweep.reports.map((report) => report.sessionId)).toEqual([
      "s-ok",
      "s-slow",
      "s-reject",
      "s-hang",
    ]);
    expect(sweep.byStatus).toEqual({ healthy: 1, slow: 1, dead: 2 });
    expect(sweep.healthy).toEqual(["s-ok"]);
    expect(sweep.slow).toEqual(["s-slow"]);
    expect(new Set(sweep.dead)).toEqual(new Set(["s-reject", "s-hang"]));
    // Liveness only for the sessions the watchdog would keep.
    expect(liveness.touches.map(([id]) => id).sort()).toEqual(["s-ok", "s-slow"]);
  });

  it("returns zeroed aggregates for an empty sweep", async () => {
    const monitor = new HealthMonitor({ client: new ScriptedProbeClient() });
    const sweep = await monitor.sweep([]);
    expect(sweep).toEqual({
      reports: [],
      byStatus: { healthy: 0, slow: 0, dead: 0 },
      healthy: [],
      slow: [],
      dead: [],
    });
  });
});

// ---------------------------------------------------------------------------
// createLivenessRecorder — registry touch
// ---------------------------------------------------------------------------

describe("createLivenessRecorder (liveness → registry touch)", () => {
  it("structurally fits the real SessionRegistry and touches lastActivityAt", () => {
    const registry = new SessionRegistry();
    registry.register(session("s-1"));
    const recorder = createLivenessRecorder(registry);

    recorder.touch("s-1", 12_345);

    expect(registry.get("s-1")?.lastActivityAt).toBe(12_345);
  });

  it("swallows the registry's unknown-session throw when a probe races a recycle", () => {
    const registry = new SessionRegistry();
    const sink = logger();
    const recorder = createLivenessRecorder(registry, { warn: sink.warn });

    expect(() => recorder.touch("s-gone", 1)).not.toThrow();
    expect(sink.warns).toHaveLength(1);
    expect(sink.warns.at(0)?.message).toBe(
      "engine-pool: liveness touch skipped (session raced with recycle)",
    );
  });
});
