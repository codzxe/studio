// packages/agent/src/obs/metrics.test.ts — W9-D: zero-dep Prometheus text
// format — canonical rendering pinned with known output strings, validation,
// and the §22 metric set.

import { describe, expect, it } from "vitest";
import {
  ObsMetricError,
  RENDER_CONTENT_TYPE,
  RUN_DURATION_SECONDS_BUCKETS,
  STEPS_PER_RUN_BUCKETS,
  createLabeledCounter,
  createLabeledHistogram,
  createObsMetricRegistry,
  createObsMetrics,
  createUnlabeledCounter,
  createUnlabeledGauge,
  createUnlabeledHistogram,
  type ObsMetrics,
} from "./metrics.js";

function thrownCode(action: () => void): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ObsMetricError) {
      return error.code;
    }
    return `unexpected-error-type: ${String(error)}`;
  }
  return "no-throw";
}

describe("registry render (known output string)", () => {
  it("renders counter + histogram + gauge in canonical Prometheus format", () => {
    const registry = createObsMetricRegistry();
    const runs = createLabeledCounter<{ readonly status: string; readonly tier: string }>({
      name: "studio_runs_total",
      help: "Runs by terminal status and tier.",
      labelNames: ["status", "tier"],
      registry,
    });
    runs.inc({ status: "succeeded", tier: "standard" }, 2);
    runs.inc({ status: "failed", tier: "quick" });
    const steps = createUnlabeledHistogram({
      name: "studio_steps_per_run",
      help: "Steps per run.",
      buckets: [1, 2, 4],
      registry,
    });
    steps.observe(3);
    steps.observe(1);
    const depth = createUnlabeledGauge({ name: "studio_queue_depth", help: "Pending jobs.", registry });
    depth.set(3);

    expect(registry.render()).toBe(
      [
        "# HELP studio_runs_total Runs by terminal status and tier.",
        "# TYPE studio_runs_total counter",
        'studio_runs_total{status="failed",tier="quick"} 1',
        'studio_runs_total{status="succeeded",tier="standard"} 2',
        "# HELP studio_steps_per_run Steps per run.",
        "# TYPE studio_steps_per_run histogram",
        'studio_steps_per_run_bucket{le="1"} 1',
        'studio_steps_per_run_bucket{le="2"} 1',
        'studio_steps_per_run_bucket{le="4"} 2',
        'studio_steps_per_run_bucket{le="+Inf"} 2',
        "studio_steps_per_run_sum 4",
        "studio_steps_per_run_count 2",
        "# HELP studio_queue_depth Pending jobs.",
        "# TYPE studio_queue_depth gauge",
        "studio_queue_depth 3",
        "",
      ].join("\n"),
    );
  });

  it("empty registry and empty families render as empty strings", () => {
    const registry = createObsMetricRegistry();
    expect(registry.render()).toBe("");
    createUnlabeledCounter({ name: "unused_total", help: "Never touched.", registry });
    expect(registry.render()).toBe("");
  });

  it("escapes label values (backslash, quote, newline) per the text format", () => {
    const registry = createObsMetricRegistry();
    const spend = createLabeledCounter<{ readonly workspace: string }>({
      name: "studio_ai_cost_usd_per_day",
      help: "Spend.",
      labelNames: ["workspace"],
      registry,
    });
    spend.inc({ workspace: 'ws-"x\\y' });
    expect(registry.render()).toBe(
      [
        "# HELP studio_ai_cost_usd_per_day Spend.",
        "# TYPE studio_ai_cost_usd_per_day counter",
        'studio_ai_cost_usd_per_day{workspace="ws-\\"x\\\\y"} 1',
        "",
      ].join("\n"),
    );
  });

  it("labeled histogram renders le FIRST (Go-client parity) with cumulative buckets", () => {
    const registry = createObsMetricRegistry();
    const durations = createLabeledHistogram<{ readonly tier: string }>({
      name: "studio_run_duration_seconds",
      help: "Duration.",
      labelNames: ["tier"],
      buckets: [1, 10],
      registry,
    });
    durations.observe({ tier: "standard" }, 0.5);
    durations.observe({ tier: "standard" }, 5);
    durations.observe({ tier: "standard" }, 42);
    expect(registry.render()).toBe(
      [
        "# HELP studio_run_duration_seconds Duration.",
        "# TYPE studio_run_duration_seconds histogram",
        'studio_run_duration_seconds_bucket{le="1",tier="standard"} 1',
        'studio_run_duration_seconds_bucket{le="10",tier="standard"} 2',
        'studio_run_duration_seconds_bucket{le="+Inf",tier="standard"} 3',
        'studio_run_duration_seconds_sum{tier="standard"} 47.5',
        'studio_run_duration_seconds_count{tier="standard"} 3',
        "",
      ].join("\n"),
    );
  });

  it("reset clears every family (test isolation; never shipped paths)", () => {
    const registry = createObsMetricRegistry();
    const counter = createUnlabeledCounter({ name: "studio_runs_total", help: "Runs.", registry });
    counter.inc();
    expect(registry.render()).toContain("studio_runs_total 1");
    registry.reset();
    expect(registry.render()).toBe("");
  });
});

describe("validation (fail fast, typed errors)", () => {
  it("rejects invalid metric and label names", () => {
    expect(
      thrownCode(() => createUnlabeledCounter({ name: "9bad", help: "x" })),
    ).toBe("invalid_name");
    const registry = createObsMetricRegistry();
    expect(
      thrownCode(() =>
        createLabeledCounter<{ readonly "bad-label"?: string }>({
          name: "ok_total",
          help: "x",
          labelNames: ["bad-label"],
          registry,
        }),
      ),
    ).toBe("invalid_label_name");
  });

  it("rejects duplicate family names in one registry", () => {
    const registry = createObsMetricRegistry();
    createUnlabeledCounter({ name: "studio_runs_total", help: "one", registry });
    expect(
      thrownCode(() => createUnlabeledCounter({ name: "studio_runs_total", help: "two", registry })),
    ).toBe("duplicate_name");
  });

  it("enforces the exact label set (no partial or unknown labels)", () => {
    const registry = createObsMetricRegistry();
    const runs = createLabeledCounter<{ readonly status: string; readonly tier: string }>({
      name: "studio_runs_total",
      help: "Runs.",
      labelNames: ["status", "tier"],
      registry,
    });
    expect(
      thrownCode(() =>
        runs.inc({ status: "succeeded" } as unknown as Parameters<typeof runs.inc>[0]),
    ),
    ).toBe("invalid_label_set");
    const withExtra = { status: "succeeded", tier: "quick", extra: "x" };
    expect(thrownCode(() => runs.inc(withExtra))).toBe("invalid_label_set");
    // Number label values are stringified.
    const steps = createLabeledCounter<{ readonly step: number }>({
      name: "steps_total",
      help: "Steps.",
      labelNames: ["step"],
      registry,
    });
    steps.inc({ step: 3 });
    expect(registry.render()).toContain('steps_total{step="3"} 1');
  });

  it("rejects bad values and bad bucket sets", () => {
    const counter = createUnlabeledCounter({ name: "studio_runs_total", help: "Runs." });
    expect(thrownCode(() => counter.inc(-1))).toBe("invalid_value");
    expect(thrownCode(() => counter.inc(Number.NaN))).toBe("invalid_value");

    const gauge = createUnlabeledGauge({ name: "studio_queue_depth", help: "Depth." });
    expect(thrownCode(() => gauge.set(Number.POSITIVE_INFINITY))).toBe("invalid_value");

    const histogram = createUnlabeledHistogram({ name: "studio_steps_per_run", help: "x", buckets: [1, 4] });
    expect(thrownCode(() => histogram.observe(-2))).toBe("invalid_value");

    expect(
      thrownCode(() => createUnlabeledHistogram({ name: "h", help: "x", buckets: [] })),
    ).toBe("invalid_buckets");
    expect(
      thrownCode(() => createUnlabeledHistogram({ name: "h2", help: "x", buckets: [4, 1] })),
    ).toBe("invalid_buckets");
    expect(
      thrownCode(() => createUnlabeledHistogram({ name: "h3", help: "x", buckets: [-1, 1] })),
    ).toBe("invalid_buckets");
  });
});

describe("createObsMetrics — the §22 metric set", () => {
  it("registers the full §22 set with the right names and kinds", () => {
    const metrics: ObsMetrics = createObsMetrics();
    const families = metrics.registry.families.map((family) => `${family.name}:${family.kind}`);
    expect(families).toEqual([
      "studio_runs_total:counter",
      "studio_run_duration_seconds:histogram",
      "studio_steps_per_run:histogram",
      "studio_tool_errors_total:counter",
      "studio_validator_blockers_total:counter",
      "studio_critic_revise_total:counter",
      "studio_credits_reserved_total:counter",
      "studio_credits_committed_total:counter",
      "studio_ai_cost_usd_per_day:counter",
      "studio_tokens_in_total:counter",
      "studio_tokens_out_total:counter",
      "studio_tokens_cache_total:counter",
      "studio_queue_depth:gauge",
      "studio_engine_sessions:gauge",
    ]);
    expect(RENDER_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect([...RUN_DURATION_SECONDS_BUCKETS]).toEqual([0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]);
    expect([...STEPS_PER_RUN_BUCKETS]).toEqual([1, 2, 4, 8, 16, 24, 32, 48, 64]);
  });

  it("instruments a run end-to-end and renders scrapeable §22 lines", () => {
    const metrics = createObsMetrics();
    metrics.runsTotal.inc({ status: "succeeded", tier: "standard" });
    metrics.runsTotal.inc({ status: "failed", tier: "complex" });
    metrics.runDurationSeconds.observe({ tier: "standard" }, 45);
    metrics.stepsPerRun.observe(9);
    metrics.toolErrorsTotal.inc({ tool: "template_apply" });
    metrics.validatorBlockersTotal.inc();
    metrics.criticReviseTotal.inc(2);
    metrics.creditsReservedTotal.inc(40);
    metrics.creditsCommittedTotal.inc(28);
    metrics.aiCostUsdPerDay.inc({ workspace: "ws_1" }, 1.5);
    metrics.tokensInTotal.inc(1200);
    metrics.tokensOutTotal.inc(300);
    metrics.tokensCacheTotal.inc(500);
    metrics.queueDepth.set(7);
    metrics.engineSessions.set({ state: "active" }, 2);
    metrics.engineSessions.set({ state: "idle" }, 1);

    const body = metrics.registry.render();
    expect(body).toContain('studio_runs_total{status="failed",tier="complex"} 1');
    expect(body).toContain('studio_runs_total{status="succeeded",tier="standard"} 1');
    expect(body).toContain('studio_run_duration_seconds_bucket{le="30",tier="standard"} 0');
    expect(body).toContain('studio_run_duration_seconds_bucket{le="60",tier="standard"} 1');
    expect(body).toContain('studio_run_duration_seconds_count{tier="standard"} 1');
    expect(body).toContain('studio_steps_per_run_bucket{le="8"} 0');
    expect(body).toContain('studio_steps_per_run_bucket{le="16"} 1');
    expect(body).toContain('studio_tool_errors_total{tool="template_apply"} 1');
    expect(body).toContain("studio_validator_blockers_total 1");
    expect(body).toContain("studio_critic_revise_total 2");
    expect(body).toContain("studio_credits_reserved_total 40");
    expect(body).toContain("studio_credits_committed_total 28");
    expect(body).toContain('studio_ai_cost_usd_per_day{workspace="ws_1"} 1.5');
    expect(body).toContain("studio_tokens_in_total 1200");
    expect(body).toContain("studio_tokens_out_total 300");
    expect(body).toContain("studio_tokens_cache_total 500");
    expect(body).toContain("studio_queue_depth 7");
    expect(body).toContain('studio_engine_sessions{state="active"} 2');
    expect(body).toContain('studio_engine_sessions{state="idle"} 1');
  });

  it("typed label unions keep callers honest at compile time (type-level)", () => {
    const metrics = createObsMetrics();
    metrics.runsTotal.inc({ status: "cancelled", tier: "quick" });
    metrics.engineSessions.set({ state: "idle" }, 0);
    expect(metrics.registry.render()).toContain('studio_runs_total{status="cancelled",tier="quick"} 1');
    expect(metrics.registry.render()).toContain('studio_engine_sessions{state="idle"} 0');
  });
});
