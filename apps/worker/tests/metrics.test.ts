// Worker metrics tests (W9-G) — §22 Prometheus collectors + the internal
// /metrics server. Deterministic fakes, no broker, no DB; the server tests
// use an ephemeral loopback listener only (docs/AGENTS.md test rules).
//
//   §13.2/§22 run lifecycle counters (queued → succeeded / failed / cancelled)
//   §22    tool errors, validator blocker rate, critic revise rate,
//          credits reserved/committed, tokens in/out/cache, AI cost
//   §15.2  internal-only auth seam: METRICS_TOKEN basic auth, 401 fail-closed
import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventPayloadMap, RunEventType } from "@studio/agent";
import {
  createWorkerMetrics,
  PROMETHEUS_CONTENT_TYPE,
  startMetricsServer,
  type MetricsServer,
  type UsageSample
} from "../src/metrics.js";

// ---------------------------------------------------------------------------
// Event fixtures (the §13.2 emit-seam shape the wiring feeds observeRunEvent)
// ---------------------------------------------------------------------------

let seq = 0;

function ev<T extends RunEventType>(type: T, payload: RunEventPayloadMap[T], runId = "run_1"): RunEvent {
  seq += 1;
  return { seq, runId, at: new Date(), type, payload };
}

function scriptedSucceededRun(runId = "run_1"): RunEvent[] {
  return [
    ev("run.queued", { tier: "standard" }, runId),
    ev("run.started", { revisionBefore: 3 }, runId),
    ev("step.started", { stepSeq: 1, phase: "executing", tool: "style_apply" }, runId),
    ev(
      "step.finished",
      { stepSeq: 1, phase: "executing", tool: "style_apply", ok: false, durationMs: 120, deviationFromPlan: false },
      runId
    ),
    ev("validate.report", { ok: false, blockers: ["naming", "structure"], majors: ["balance"], minors: [] }, runId),
    ev(
      "critique.report",
      {
        verdict: "revise",
        scores: { hierarchy: 5, balance: 4, contrast: 4, brief_adherence: 3, brand_fit: 4, editability: 5 },
        issues: []
      },
      runId
    ),
    ev("credits.reserved", { reserved: 2 }, runId),
    ev("credits.charged", { charged: 2, partial: false }, runId),
    ev("run.succeeded", { revisionAfter: 4, warnings: [] }, runId)
  ];
}

// ---------------------------------------------------------------------------
// Collector: scripted run lifecycles
// ---------------------------------------------------------------------------

describe("WorkerMetrics run lifecycle counters", () => {
  it("counts a queued→succeeded lifecycle into the right families (§22)", () => {
    const metrics = createWorkerMetrics();
    for (const event of scriptedSucceededRun()) {
      metrics.observeRunEvent(event);
    }
    const text = metrics.render();
    expect(text).toContain("# TYPE studio_runs_total counter");
    expect(text).toContain('studio_runs_total{status="queued",tier="standard"} 1');
    expect(text).toContain('studio_runs_total{status="running",tier="standard"} 1');
    expect(text).toContain('studio_runs_total{status="succeeded",tier="standard"} 1');
    expect(text).toContain("studio_runs_in_flight 0");
    expect(text).toContain('studio_tool_calls_total{tool="style_apply"} 1');
    expect(text).toContain('studio_tool_errors_total{tool="style_apply"} 1');
    expect(text).toContain('studio_validator_reports_total{result="blocked"} 1');
    expect(text).toContain("studio_validator_blockers_total 2");
    expect(text).toContain('studio_critic_verdicts_total{verdict="revise"} 1');
    expect(text).toContain("studio_credits_reserved_total 2");
    expect(text).toContain("studio_credits_committed_total 2");
    expect(text).toContain('studio_credits_charged_events_total{partial="false"} 1');
  });

  it("labels failed and cancelled terminals with the tier remembered from queued", () => {
    const metrics = createWorkerMetrics();
    metrics.observeRunEvent(ev("run.queued", { tier: "quick" }, "run_q"));
    metrics.observeRunEvent(ev("run.failed", { error: { code: "engine_unavailable", message: "boom" } }, "run_q"));
    metrics.observeRunEvent(ev("run.queued", { tier: "complex" }, "run_c"));
    metrics.observeRunEvent(ev("run.cancelled", { reason: "user" }, "run_c"));
    const text = metrics.render();
    expect(text).toContain('studio_runs_total{status="failed",tier="quick"} 1');
    expect(text).toContain('studio_runs_total{status="cancelled",tier="complex"} 1');
    expect(text).toContain("studio_runs_in_flight 0");
  });

  it("renders an untracked terminal (recovery path) as tier=unspecified and never goes negative", () => {
    const metrics = createWorkerMetrics();
    metrics.observeRunEvent(ev("run.succeeded", { revisionAfter: 1, warnings: [] }, "run_ghost"));
    const text = metrics.render();
    expect(text).toContain('studio_runs_total{status="succeeded",tier="unspecified"} 1');
    expect(text).toContain("studio_runs_in_flight 0");
  });

  it("counts passing validators and accepted critics (§22 blocker/revise rates)", () => {
    const metrics = createWorkerMetrics();
    metrics.observeRunEvent(ev("validate.report", { ok: true, blockers: [], majors: [], minors: [] }, "run_v"));
    metrics.observeRunEvent(
      ev("critique.report", {
        verdict: "accept",
        scores: { hierarchy: 5, balance: 5, contrast: 5, brief_adherence: 5, brand_fit: 5, editability: 5 },
        issues: []
      }, "run_v")
    );
    const text = metrics.render();
    expect(text).toContain('studio_validator_reports_total{result="pass"} 1');
    expect(text).toContain("studio_validator_blockers_total 0");
    expect(text).toContain('studio_critic_verdicts_total{verdict="accept"} 1');
  });

  it("ignores plan/preview events and steps without a tool", () => {
    const metrics = createWorkerMetrics();
    metrics.observeRunEvent(ev("run.plan", {} as RunEventPayloadMap["run.plan"], "run_x"));
    metrics.observeRunEvent(
      ev("step.finished", { stepSeq: 2, phase: "planning", tool: null, ok: true, durationMs: 5, deviationFromPlan: false }, "run_x")
    );
    metrics.observeRunEvent(ev("preview.updated", { url: "https://internal/preview.png", revision: 2 }, "run_x"));
    const text = metrics.render();
    // Families render their HELP/TYPE headers but no sample line (counters
    // are implicitly 0 until first increment — Prometheus convention).
    expect(text).toContain("# TYPE studio_runs_total counter");
    expect(text).not.toContain("studio_runs_total{");
    expect(text).toContain("# TYPE studio_tool_calls_total counter");
    expect(text).not.toContain("studio_tool_calls_total{");
  });
});

// ---------------------------------------------------------------------------
// Collector: W9-C usage rows → token/cost accumulators
// ---------------------------------------------------------------------------

describe("WorkerMetrics usage accumulators", () => {
  it("consumes usage rows into tokens in/out/cache and per-workspace cost (§22)", () => {
    const metrics = createWorkerMetrics();
    const row: UsageSample = {
      runId: "run_1",
      workspaceId: "ws_9",
      model: "economy",
      tokensIn: 1200,
      tokensOut: 300,
      tokensCacheRead: 800,
      costUsd: 0.012
    };
    metrics.observeUsage(row);
    const text = metrics.render();
    expect(text).toContain('studio_ai_tokens_total{model="economy",direction="in"} 1200');
    expect(text).toContain('studio_ai_tokens_total{model="economy",direction="out"} 300');
    expect(text).toContain('studio_ai_tokens_total{model="economy",direction="cache_read"} 800');
    expect(text).toContain('studio_ai_cost_usd_total{workspace="ws_9"} 0.012');
  });

  it("defaults missing model/workspace labels to unspecified and skips bad numbers", () => {
    const metrics = createWorkerMetrics();
    metrics.observeUsage({ tokensIn: Number.NaN, tokensOut: 5, costUsd: Number.NaN });
    const text = metrics.render();
    expect(text).toContain('studio_ai_tokens_total{model="unspecified",direction="out"} 5');
    // NaN deltas are dropped, so the cost family renders headers only.
    expect(text).toContain("# TYPE studio_ai_cost_usd_total counter");
    expect(text).not.toContain("studio_ai_cost_usd_total{");
  });
});

// ---------------------------------------------------------------------------
// Internal /metrics server (W1-I health-server pattern, METRICS_TOKEN seam)
// ---------------------------------------------------------------------------

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function withServer(
  options: { token?: string; metrics?: ReturnType<typeof createWorkerMetrics> },
  run: (origin: string) => Promise<void>
): Promise<void> {
  const server: MetricsServer = await startMetricsServer({
    port: 0,
    metrics: options.metrics ?? createWorkerMetrics(),
    token: options.token
  });
  try {
    await run(new URL(server.url).origin);
  } finally {
    await server.close();
  }
}

describe("metrics http server", () => {
  it("serves the rendered exposition to authorized scrapers", async () => {
    const metrics = createWorkerMetrics();
    for (const event of scriptedSucceededRun()) {
      metrics.observeRunEvent(event);
    }
    await withServer({ token: "s3cret", metrics }, async (origin) => {
      const res = await fetch(`${origin}/metrics`, { headers: { authorization: basic("prometheus", "s3cret") } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);
      const body = await res.text();
      expect(body).toContain("# TYPE studio_runs_total counter");
      expect(body).toContain('studio_runs_total{status="succeeded",tier="standard"} 1');
      expect(body).toContain("studio_runs_in_flight 0");
    });
  });

  it("401s scrapes without or with wrong credentials (internal-only seam)", async () => {
    await withServer({ token: "s3cret" }, async (origin) => {
      const missing = await fetch(`${origin}/metrics`);
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toContain('Basic realm="metrics"');
      const missingBody = (await missing.json()) as { code: string };
      expect(missingBody.code).toBe("unauthenticated");

      const wrong = await fetch(`${origin}/metrics`, { headers: { authorization: basic("prom", "nope") } });
      expect(wrong.status).toBe(401);
    });
  });

  it("fails closed (401) when METRICS_TOKEN is not configured", async () => {
    await withServer({}, async (origin) => {
      const res = await fetch(`${origin}/metrics`, { headers: { authorization: basic("prom", "anything") } });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("metrics_token_unconfigured");
    });
  });

  it("404s unknown paths like the W1-I health server", async () => {
    await withServer({ token: "s3cret" }, async (origin) => {
      const res = await fetch(`${origin}/other`, { headers: { authorization: basic("prom", "s3cret") } });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("not_found");
    });
  });
});
