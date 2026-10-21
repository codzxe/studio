// apps/worker/src/metrics.ts — worker-side Prometheus collector + /metrics
// server (W9-G, spec §22).
//
// Collector (WorkerMetrics): run lifecycle counters by status/tier, tool
// call/error counters, validator + critic verdict counters, credits
// reserved/committed accumulators, and AI token/cost accumulators that
// consume usage rows (the W9-C shape, see UsageSample).
//
// INPUT SEAMS (both injected by the wiring wave — this module never touches
// the environment, the broker or the DB):
//   - observeRunEvent(event) — the run manager's emit seam (§13.2/§22): the
//     bootstrap subscribes this collector to the SAME durable run events the
//     timeline persists (eventbus pattern, packages/agent/src/eventbus.ts —
//     feed it the published RunEvent, e.g. by wrapping the EmitRunEvent seam
//     or subscribing per-run). @studio/agent's RunEvent keys `payload` by
//     generic instantiation (no discriminated narrowing), so each switch
//     case casts the payload to the §13.2 type keyed by that event type.
//   - observeUsage(sample) — W9-C usage rows (per-step model usage): the
//     wiring adapts each row to UsageSample. runId is accepted for
//     correlation but never used as a LABEL (unbounded cardinality; per-run
//     cost is a log/trace concern per §22).
//
// SERVER (startMetricsServer): GET /metrics rendered through a tiny
// node:http listener — the W1-I health server (src/health.ts) PATTERN,
// extended, NOT edited: health.ts keeps GET /health on its own listener;
// this module adds a separate internal listener for the Prometheus scrape.
// Both default to loopback; the compose wiring binds them to the internal
// compose network only (never published through the public ingress, §17.2).
//
// AUTH: same METRICS_TOKEN Basic-auth seam as the gateway route — the
// password must equal the token (username ignored, timing-safe compare).
// FAIL-CLOSED: token UNSET ⇒ every scrape is refused 401; an unconfigured
// auth seam must never silently expose operational data. Prometheus scrapes
// with `basic_auth: { username: prometheus, password: <METRICS_TOKEN> }`.
//
// The render() contract matches the W9-D shared registry face
// (packages/agent/src/obs/metrics.ts, render(): string) — when that registry
// lands, the bootstrap may concatenate its render() into this server's
// response the same way the gateway route does (structural seam, no import
// needed from this module).

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CritiqueReportPayload,
  CreditsChargedPayload,
  CreditsReservedPayload,
  RunEvent,
  RunQueuedPayload,
  StepFinishedPayload,
  ValidateReportPayload
} from "@studio/agent";
import type { RunTierId } from "@studio/config";
import type { Logger } from "./logger.js";

/** Prometheus text exposition content type (spec §22 wire format). */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** 401 challenge for the Basic-auth seam. */
export const METRICS_WWW_AUTHENTICATE = 'Basic realm="metrics", charset="UTF-8"';

/** Label for dimensions with no observed value (tier on recovery paths, missing model/workspace). */
const DEFAULT_LABEL_VALUE = "unspecified";

/** Tier memory cap: a run that never reaches terminal must not leak a slot. */
const MAX_TRACKED_RUNS = 10_000;

/** §13.2 terminal events → run status label. */
const TERMINAL_STATUS = {
  "run.succeeded": "succeeded",
  "run.failed": "failed",
  "run.cancelled": "cancelled"
} as const;

// ---------------------------------------------------------------------------
// Prometheus text rendering helpers (label hygiene, §22 wire format)
// ---------------------------------------------------------------------------

const MAX_LABEL_VALUE_LENGTH = 128;

/** One label pair — constructed through the `labels(...)` helper for tuples. */
type LabelPair = readonly [name: string, value: string];
type LabelPairs = readonly LabelPair[];

function labels(...pairs: readonly LabelPair[]): LabelPairs {
  return pairs;
}

function labelValue(raw: string): string {
  const cleaned = raw
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .slice(0, MAX_LABEL_VALUE_LENGTH);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Prometheus accepts finite numbers only; never render NaN/Infinity. */
function metricValue(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

/** Deterministic, sorted exposition block for one metric family. */
class LabeledSamples {
  private readonly rows = new Map<string, { rendered: string; value: number }>();

  inc(pairs: LabelPairs, delta = 1): void {
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    const rendered = pairs.map(([name, value]) => `${name}="${labelValue(value)}"`).join(",");
    const row = this.rows.get(rendered);
    if (row === undefined) {
      this.rows.set(rendered, { rendered, value: delta });
    } else {
      row.value += delta;
    }
  }

  renderLines(name: string, help: string): string[] {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
    const rows = Array.from(this.rows.entries()).sort(([a], [b]) => (a < b ? -1 : a === b ? 0 : 1));
    for (const [rendered, row] of rows) {
      lines.push(
        rendered.length > 0 ? `${name}{${rendered}} ${metricValue(row.value)}` : `${name} ${metricValue(row.value)}`
      );
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Usage rows (W9-C seam)
// ---------------------------------------------------------------------------

/**
 * One W9-C usage row adapted for the accumulators (§22 tokens in/out/cache,
 * AI cost). All ids are correlation context — only bounded label dimensions
 * (model, workspace) become labels; runId never does.
 */
export interface UsageSample {
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly model?: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCacheRead?: number;
  readonly costUsd: number;
}

/** The collector face the /metrics server renders (matches the W9-D render contract). */
export interface WorkerMetricsLike {
  render(): string;
}

// ---------------------------------------------------------------------------
// WorkerMetrics — the collector
// ---------------------------------------------------------------------------

/**
 * Worker-side §22 collectors, fed from the emit seam (observeRunEvent) and
 * the usage rows (observeUsage). Pure in-process state: no timers, no I/O,
 * deterministic render — trivially testable per docs/AGENTS.md.
 */
export class WorkerMetrics implements WorkerMetricsLike {
  private readonly runs = new LabeledSamples();
  private readonly toolCalls = new LabeledSamples();
  private readonly toolErrors = new LabeledSamples();
  private readonly validatorReports = new LabeledSamples();
  private readonly criticVerdicts = new LabeledSamples();
  private readonly chargeEvents = new LabeledSamples();
  private readonly tokens = new LabeledSamples();
  private readonly cost = new LabeledSamples();
  private readonly tierByRun = new Map<string, RunTierId>();
  private inFlight = 0;
  private validatorBlockers = 0;
  private creditsReserved = 0;
  private creditsCommitted = 0;

  /**
   * One §13.2 run event from the emit seam. Terminal events release the
   * run's tier slot; in-flight is floored at 0 so recovery paths that emit
   * a terminal without a queued event cannot drive the gauge negative.
   */
  observeRunEvent(event: RunEvent): void {
    switch (event.type) {
      case "run.queued": {
        const payload = event.payload as RunQueuedPayload;
        this.rememberTier(event.runId, payload.tier);
        this.runs.inc(labels(["status", "queued"], ["tier", payload.tier]));
        this.inFlight += 1;
        return;
      }
      case "run.started": {
        this.runs.inc(labels(["status", "running"], ["tier", this.tierOf(event.runId)]));
        return;
      }
      case "step.finished": {
        const payload = event.payload as StepFinishedPayload;
        if (payload.tool !== null) {
          this.toolCalls.inc(labels(["tool", payload.tool]));
          if (!payload.ok) {
            this.toolErrors.inc(labels(["tool", payload.tool]));
          }
        }
        return;
      }
      case "validate.report": {
        const payload = event.payload as ValidateReportPayload;
        this.validatorReports.inc(labels(["result", payload.ok ? "pass" : "blocked"]));
        this.validatorBlockers += payload.blockers.length;
        return;
      }
      case "critique.report": {
        const payload = event.payload as CritiqueReportPayload;
        this.criticVerdicts.inc(labels(["verdict", payload.verdict]));
        return;
      }
      case "credits.reserved": {
        const payload = event.payload as CreditsReservedPayload;
        this.creditsReserved += payload.reserved;
        return;
      }
      case "credits.charged": {
        const payload = event.payload as CreditsChargedPayload;
        this.creditsCommitted += payload.charged;
        this.chargeEvents.inc(labels(["partial", String(payload.partial)]));
        return;
      }
      case "run.succeeded":
      case "run.failed":
      case "run.cancelled": {
        this.runs.inc(labels(["status", TERMINAL_STATUS[event.type]], ["tier", this.tierOf(event.runId)]));
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.tierByRun.delete(event.runId);
        return;
      }
      default:
        return; // run.plan / step.started / preview.updated: no §22 counter here
    }
  }

  /** One W9-C usage row → token/cost accumulators (§22 tokens in/out/cache, AI cost). */
  observeUsage(sample: UsageSample): void {
    const model = sample.model ?? DEFAULT_LABEL_VALUE;
    this.tokens.inc(labels(["model", model], ["direction", "in"]), sample.tokensIn);
    this.tokens.inc(labels(["model", model], ["direction", "out"]), sample.tokensOut);
    const cacheRead = sample.tokensCacheRead ?? 0;
    if (cacheRead !== 0) {
      this.tokens.inc(labels(["model", model], ["direction", "cache_read"]), cacheRead);
    }
    this.cost.inc(labels(["workspace", sample.workspaceId ?? DEFAULT_LABEL_VALUE]), sample.costUsd);
  }

  /** Full Prometheus text exposition (deterministic section order). */
  render(): string {
    const lines: string[] = [];
    const section = (block: readonly string[]): void => {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(...block);
    };
    section(this.runs.renderLines("runs_total", "Worker runs by lifecycle status and tier (§22)."));
    section([
      "# HELP runs_in_flight Runs between queued and terminal event (§22).",
      "# TYPE runs_in_flight gauge",
      `runs_in_flight ${metricValue(this.inFlight)}`
    ]);
    section(this.toolCalls.renderLines("tool_calls_total", "Tool-scoped steps executed (§22 tool error rate)."));
    section(this.toolErrors.renderLines("tool_errors_total", "Tool-scoped steps that failed (§22 tool error rate)."));
    section(this.validatorReports.renderLines("validator_reports_total", "Validator verdicts (§22 validator blocker rate)."));
    section([
      "# HELP validator_blockers_total Validator blocker findings (§22 validator blocker rate).",
      "# TYPE validator_blockers_total counter",
      `validator_blockers_total ${metricValue(this.validatorBlockers)}`
    ]);
    section(this.criticVerdicts.renderLines("critic_verdicts_total", "Critic verdicts by outcome (§22 critic revise rate)."));
    section([
      "# HELP credits_reserved_total Credits reserved for runs (§22 credits reserved/committed).",
      "# TYPE credits_reserved_total counter",
      `credits_reserved_total ${metricValue(this.creditsReserved)}`
    ]);
    section([
      "# HELP credits_committed_total Credits settled at run end (§22 credits reserved/committed).",
      "# TYPE credits_committed_total counter",
      `credits_committed_total ${metricValue(this.creditsCommitted)}`
    ]);
    section(this.chargeEvents.renderLines("credits_charged_events_total", "Credit charge events by partial flag (§14.2)."));
    section(this.tokens.renderLines("ai_tokens_total", "Model tokens consumed (§22 tokens in/out/cache)."));
    section(this.cost.renderLines("ai_cost_usd_total", "Model cost settled in USD (§22 AI cost per workspace)."));
    return `${lines.join("\n")}\n`;
  }

  private tierOf(runId: string): string {
    return this.tierByRun.get(runId) ?? DEFAULT_LABEL_VALUE;
  }

  private rememberTier(runId: string, tier: RunTierId): void {
    if (this.tierByRun.size >= MAX_TRACKED_RUNS && !this.tierByRun.has(runId)) {
      const oldest = this.tierByRun.keys().next();
      if (!oldest.done) {
        this.tierByRun.delete(oldest.value);
      }
    }
    this.tierByRun.set(runId, tier);
  }
}

export function createWorkerMetrics(): WorkerMetrics {
  return new WorkerMetrics();
}

// ---------------------------------------------------------------------------
// /metrics server (W1-I health-server pattern, extended — health.ts untouched)
// ---------------------------------------------------------------------------

export interface MetricsServerOptions {
  /** 0 binds an ephemeral port (see MetricsServer.url for the real one). */
  readonly port: number;
  /** Bind address; defaults to loopback (internal ops endpoint only). */
  readonly host?: string;
  /** The collector to render (or any WorkerMetricsLike face). */
  readonly metrics: WorkerMetricsLike;
  /** METRICS_TOKEN; UNDEFINED ⇒ fail-closed 401 (see header note). */
  readonly token?: string;
  readonly logger?: Logger;
}

export interface MetricsServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    handleMetricsRequest(request, response, options);
  });
  server.on("error", (error) => options.logger?.error("metrics server error", { err: error }));
  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, host, () => {
      resolve();
    });
    server.once("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    url: `http://${host}:${port}/metrics`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          resolve();
        });
      })
  };
}

function handleMetricsRequest(request: IncomingMessage, response: ServerResponse, options: MetricsServerOptions): void {
  const url = new URL(request.url ?? "/", "http://worker.internal");
  if (request.method !== "GET" || url.pathname !== "/metrics") {
    sendJson(response, 404, {
      ok: false,
      code: "not_found",
      message: "unknown metrics route",
      hint: "GET /metrics"
    });
    return;
  }
  if (options.token === undefined || options.token.length === 0) {
    response.setHeader("WWW-Authenticate", METRICS_WWW_AUTHENTICATE);
    sendJson(response, 401, {
      ok: false,
      code: "metrics_token_unconfigured",
      message: "the metrics token is not configured; refusing to serve metrics",
      hint: "set METRICS_TOKEN and bind this endpoint to the internal network only"
    });
    return;
  }
  if (!tokenMatches(basicPassword(request.headers.authorization), options.token)) {
    response.setHeader("WWW-Authenticate", METRICS_WWW_AUTHENTICATE);
    sendJson(response, 401, {
      ok: false,
      code: "unauthenticated",
      message: "metrics credentials are required",
      hint: "HTTP Basic auth with password METRICS_TOKEN (username is ignored)"
    });
    return;
  }
  let body: string;
  try {
    body = options.metrics.render();
  } catch (error) {
    options.logger?.error("metrics render failed", { err: error });
    sendJson(response, 503, {
      ok: false,
      code: "metrics_render_failed",
      message: "metrics could not be rendered",
      hint: "inspect the worker metrics collector"
    });
    return;
  }
  response.writeHead(200, {
    "content-type": PROMETHEUS_CONTENT_TYPE,
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

/** Timing-safe string equality (constant-time when lengths match). */
function tokenMatches(got: string | undefined, want: string): boolean {
  if (got === undefined) {
    return false;
  }
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Extract the Basic-auth password from an Authorization header. Malformed
 * schemes and base64 resolve to undefined — the caller answers 401.
 */
function basicPassword(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Basic ")) {
    return undefined;
  }
  const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? decoded : decoded.slice(separator + 1);
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}
