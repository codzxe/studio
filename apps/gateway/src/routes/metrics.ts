// apps/gateway/src/routes/metrics.ts — §22 Prometheus metrics endpoint (W9-G).
//
//   GET /metrics — internal-only Prometheus text exposition of the
//   gateway-side registry, in this order:
//     1. HTTP request counters (GatewayMetrics + httpMetricsMiddleware)
//     2. the shared metrics instance from packages/agent/src/obs/metrics.ts
//        (W9-D registry), injected and rendered through its `render()`
//        contract — the ONLY coupling this route needs (structural seam)
//     3. queue depth gauges — BullMQ counts through the injected
//        QueueStatsLike (the W1-I health stats face: getQueueDepths())
//     4. engine session gauges — PoolLike.ping() (the W4-Q health probe
//        face, routes/health.ts: sessions=allocated, idle=ready)
//     5. gateway uptime + build info
//
// INTERNAL-ONLY (§22/§17.2). This router mounts at /metrics — NOT under the
// public versioned /v1 API (§13.1) — and the compose wiring must bind the
// listener to the internal compose network only (never route it through the
// public ingress; do not publish the port). WIRING NOTE (buildApp owner):
//
//     const http = createGatewayMetrics();
//     app.use(httpMetricsMiddleware(http));          // count every request
//     app.route("/metrics", metricsRoutes({          // via deps.mount hook
//       version, startedAt, token: env.METRICS_TOKEN,
//       shared: obsRegistry, queue, enginePool,
//     }));
//
// METRICS_TOKEN is the second layer (§15.2 defense in depth): HTTP Basic
// auth where the PASSWORD must equal the token (the username is arbitrary —
// Prometheus's own scrape config needs one, e.g. `metrics`). The token is
// parsed from env by the bootstrap through packages/config (ADR-0002) and
// injected here — this module never reads process.env. FAIL-CLOSED: when the
// token is UNSET every scrape is refused 401; an unconfigured auth seam must
// never silently expose operational data.
//
// Every source is optional (health.ts idiom): an uninjected source renders a
// `#` comment line and keeps the scrape 200 so Prometheus absent-series
// alerting covers it; a source that THROWS renders the same way (never a 503
// — a scrape endpoint answers with what it has, §22 durability over latency).

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { EnginePoolPing, PoolLike } from "./health.js";
import type { AppEnv } from "../types.js";

/** Prometheus text exposition content type (spec §22 wire format). */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** 401 challenge for the Basic-auth seam. */
export const METRICS_WWW_AUTHENTICATE = 'Basic realm="metrics", charset="UTF-8"';

// ---------------------------------------------------------------------------
// Structural seams (health.ts idiom: minimal faces the real clients satisfy)
// ---------------------------------------------------------------------------

/**
 * The W9-D shared registry face (packages/agent/src/obs/metrics.ts): renders
 * every registered shared metric in Prometheus text format. Structural, so
 * the obs wave's concrete class needs no import from this module.
 */
export interface MetricsRegistryLike {
  render(): string;
}

/**
 * One queue's BullMQ job counts — the W1-I QueueDepth shape
 * (apps/worker/src/health.ts) re-declared here because apps never import
 * across app boundaries; the gateway adapter adapts `queue.getJobCounts(...)`
 * (or the worker-style stats source) to it structurally.
 */
export interface QueueDepthLike {
  readonly queue: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly completed: number;
  readonly failed: number;
}

/**
 * Queue stats seam (W1-I health seam, §22 "queue depth and age"): the
 * bootstrap adapts the BullMQ queues (or the shared Valkey stats source) to
 * this face. Fetches happen per scrape — no background timer.
 */
export interface QueueStatsLike {
  getQueueDepths(): Promise<readonly QueueDepthLike[]>;
}

// ---------------------------------------------------------------------------
// Prometheus text rendering helpers (label hygiene, §22 wire format)
// ---------------------------------------------------------------------------

/** Bounded label alphabet: escape `\` `"` and newlines; clamp length. */
const MAX_LABEL_VALUE_LENGTH = 128;

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

function sample(name: string, labels: string, value: number): string {
  const rendered = metricValue(value);
  return labels.length > 0 ? `${name}{${labels}} ${rendered}` : `${name} ${rendered}`;
}

// ---------------------------------------------------------------------------
// GatewayMetrics — the gateway-side HTTP request counters registry
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function methodLabel(method: string): string {
  const upper = method.toUpperCase();
  return HTTP_METHODS.has(upper) ? upper : "_other";
}

/**
 * Gateway HTTP request counters (§22): `gateway_http_requests_total` by
 * {method,status} + an in-flight gauge. One instance is created by the
 * bootstrap, shared between httpMetricsMiddleware (increments) and
 * metricsRoutes (renders); instances are plain state + render, no timers.
 */
export class GatewayMetrics {
  private readonly requests = new Map<string, { method: string; status: number; count: number }>();
  private inFlight = 0;

  /** One completed request observed by the middleware. */
  incRequest(method: string, status: number): void {
    const method_ = methodLabel(method);
    const key = `${method_}\u0000${status}`;
    const row = this.requests.get(key);
    if (row === undefined) {
      this.requests.set(key, { method: method_, status, count: 1 });
    } else {
      row.count += 1;
    }
  }

  /** A request entered the pipeline (in-flight gauge +1). */
  incInFlight(): void {
    this.inFlight += 1;
  }

  /** A request left the pipeline (in-flight gauge -1, floored at 0). */
  decInFlight(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Prometheus text for the HTTP counter family (deterministic order). */
  render(): string {
    const lines = [
      "# HELP gateway_http_requests_total Total HTTP requests handled by the gateway.",
      "# TYPE gateway_http_requests_total counter"
    ];
    const rows = Array.from(this.requests.values()).sort(
      (a, b) => a.method.localeCompare(b.method) || a.status - b.status
    );
    for (const row of rows) {
      const labels = `method="${labelValue(row.method)}",status="${row.status}"`;
      lines.push(sample("gateway_http_requests_total", labels, row.count));
    }
    lines.push(
      "# HELP gateway_http_requests_in_flight HTTP requests currently in the pipeline.",
      "# TYPE gateway_http_requests_in_flight gauge",
      sample("gateway_http_requests_in_flight", "", this.inFlight)
    );
    return lines.join("\n");
  }
}

export function createGatewayMetrics(): GatewayMetrics {
  return new GatewayMetrics();
}

/**
 * Wire the HTTP counters: mount BEFORE the route groups (app.ts middleware
 * block, or the first line of deps.mount). Counts every request that reaches
 * the Hono pipeline with the FINAL response status (SSE included).
 */
export function httpMetricsMiddleware(metrics: GatewayMetrics): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    metrics.incInFlight();
    try {
      await next();
    } finally {
      metrics.decInFlight();
      metrics.incRequest(c.req.method, c.res.status);
    }
  };
}

// ---------------------------------------------------------------------------
// Gauge renderers (queue depth, engine sessions, uptime/build)
// ---------------------------------------------------------------------------

const QUEUE_STATES = ["waiting", "active", "delayed", "completed", "failed"] as const;

function renderQueueDepths(depths: readonly QueueDepthLike[]): string {
  const lines = [
    "# HELP queue_depth BullMQ job counts per queue and state (§22 queue depth).",
    "# TYPE queue_depth gauge"
  ];
  const sorted = Array.from(depths).sort((a, b) => a.queue.localeCompare(b.queue));
  for (const depth of sorted) {
    for (const state of QUEUE_STATES) {
      const labels = `queue="${labelValue(depth.queue)}",state="${state}"`;
      lines.push(sample("queue_depth", labels, depth[state]));
    }
  }
  return lines.join("\n");
}

function renderEngineSessions(ping: EnginePoolPing): string {
  return [
    "# HELP engine_sessions Engine sessions by state (§22 sessions active/idle).",
    "# TYPE engine_sessions gauge",
    sample("engine_sessions", 'state="active"', ping.sessions),
    sample("engine_sessions", 'state="idle"', ping.idle)
  ].join("\n");
}

function renderProcessInfo(version: string, startedAt: number): string {
  const uptime = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return [
    "# HELP gateway_build_info Gateway build version (value is always 1).",
    "# TYPE gateway_build_info gauge",
    sample("gateway_build_info", `version="${labelValue(version)}"`, 1),
    "# HELP gateway_uptime_seconds Seconds since the gateway process started.",
    "# TYPE gateway_uptime_seconds gauge",
    sample("gateway_uptime_seconds", "", uptime)
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Basic-auth seam (METRICS_TOKEN)
// ---------------------------------------------------------------------------

/** Timing-safe string equality (constant-time when lengths match). */
function tokenMatches(got: string, want: string): boolean {
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Extract the Basic-auth password from an Authorization header. Malformed
 * schemes and base64 resolve to undefined — the caller answers 401.
 * Prometheus's scrape config supplies any username; only the password (the
 * METRICS_TOKEN) is compared.
 */
function basicPassword(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Basic ")) {
    return undefined;
  }
  const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? decoded : decoded.slice(separator + 1);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Injectable deps for metricsRoutes — every source optional (health.ts idiom). */
export interface MetricsRouteDeps {
  /** Service version string (image/build tag). */
  readonly version: string;
  /** Epoch-ms uptime anchor (injected for deterministic tests). */
  readonly startedAt: number;
  /**
   * METRICS_TOKEN, parsed from env by the bootstrap via packages/config
   * (ADR-0002). UNDEFINED ⇒ fail-closed 401: the auth seam is not wired.
   */
  readonly token: string | undefined;
  /** Shared W9-D registry instance (packages/agent/src/obs/metrics.ts). */
  readonly shared?: MetricsRegistryLike;
  /** Gateway HTTP counters (createGatewayMetrics()). Defaults to zeros. */
  readonly http?: GatewayMetrics;
  /** Queue depth source (BullMQ adapter; W1-I health seam). */
  readonly queue?: QueueStatsLike;
  /** Engine pool stats face (the W4-Q PoolLike health probe seam). */
  readonly enginePool?: PoolLike;
}

/** Assemble the full exposition body (exported for tests; deterministic). */
export async function renderMetricsExposition(deps: MetricsRouteDeps): Promise<string> {
  const parts: string[] = [];

  const http = deps.http ?? createGatewayMetrics();
  parts.push(http.render());

  if (deps.shared !== undefined) {
    try {
      const text = deps.shared.render().trim();
      parts.push(text.length > 0 ? text : "# shared metrics registry rendered empty");
    } catch {
      parts.push("# shared metrics registry unavailable (render threw)");
    }
  } else {
    parts.push("# shared metrics registry not injected (W9-D wiring pending)");
  }

  if (deps.queue !== undefined) {
    try {
      parts.push(renderQueueDepths(await deps.queue.getQueueDepths()));
    } catch {
      parts.push("# queue depth source unavailable (queue gauges omitted)");
    }
  } else {
    parts.push("# queue depth source not injected");
  }

  if (deps.enginePool !== undefined && deps.enginePool.ping !== undefined) {
    try {
      const ping = await deps.enginePool.ping();
      parts.push(
        ping === undefined
          ? "# engine pool stats unavailable (supervisor ping returned no snapshot)"
          : renderEngineSessions(ping)
      );
    } catch {
      parts.push("# engine pool stats unavailable (ping failed)");
    }
  } else {
    parts.push("# engine pool stats not injected");
  }

  parts.push(renderProcessInfo(deps.version, deps.startedAt));
  return `${parts.join("\n")}\n`;
}

/**
 * Metrics router — mounted at /metrics by the bootstrap (NEVER under the
 * public /v1 group; bind the listener to the compose network only). Behind
 * the METRICS_TOKEN Basic-auth seam; fail-closed when the token is unset.
 */
export function metricsRoutes(deps: MetricsRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Internal-only Basic-auth seam (§22): token UNSET ⇒ fail closed; the
  // password must equal METRICS_TOKEN (username ignored, timing-safe).
  router.use(async (c, next) => {
    if (deps.token === undefined || deps.token.length === 0) {
      c.header("WWW-Authenticate", METRICS_WWW_AUTHENTICATE);
      return c.json(
        {
          error: {
            code: "metrics_token_unconfigured",
            message: "the metrics endpoint is not configured",
            hint: "set METRICS_TOKEN to enable internal metrics scrapes",
            retryable: false
          }
        },
        401
      );
    }
    const password = basicPassword(c.req.header("authorization"));
    if (password === undefined || !tokenMatches(password, deps.token)) {
      c.header("WWW-Authenticate", METRICS_WWW_AUTHENTICATE);
      return c.json(
        {
          error: {
            code: "unauthenticated",
            message: "valid metrics token required",
            hint: "basic auth password must equal METRICS_TOKEN",
            retryable: false
          }
        },
        401
      );
    }
    await next();
  });

  router.get("/", async (c) => {
    const body = await renderMetricsExposition(deps);
    return c.text(body, 200, { "content-type": PROMETHEUS_CONTENT_TYPE });
  });

  return router;
}
