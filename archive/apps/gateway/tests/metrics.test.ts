// Gateway metrics route tests (W9-G) — §22 Prometheus exposition + the
// internal-only METRICS_TOKEN Basic-auth seam. Deterministic fakes, no
// network, no DB (docs/AGENTS.md test rules); routers are exercised through
// Hono's in-process request() like tests/health-audit.test.ts.
//
//   §22  registry rendering: HTTP counters + shared W9-D registry + queue
//        depth gauges + engine session gauges + uptime
//   §15.2 internal-only auth: token UNSET ⇒ fail-closed 401; wrong/missing
//        Basic password ⇒ 401 with the §13.3 envelope
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createGatewayMetrics,
  httpMetricsMiddleware,
  metricsRoutes,
  PROMETHEUS_CONTENT_TYPE,
  type MetricsRegistryLike,
  type MetricsRouteDeps,
  type QueueDepthLike,
  type QueueStatsLike
} from "../src/routes/metrics.js";
import type { PoolLike } from "../src/routes/health.js";
import type { AppEnv } from "../src/types.js";

const TOKEN = "metrics-s3cret";

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function build(overrides: Partial<MetricsRouteDeps> = {}): Hono<AppEnv> {
  return metricsRoutes({
    version: "0.0.0-test",
    startedAt: Date.now() - 61_000,
    token: TOKEN,
    ...overrides
  });
}

interface ErrorEnvelope {
  readonly error: { code: string; retryable: boolean };
}

// ---------------------------------------------------------------------------
// Fixtures: injected sources
// ---------------------------------------------------------------------------

const shared: MetricsRegistryLike = {
  render: () =>
    "# HELP shared_runs_total shared test counter\n# TYPE shared_runs_total counter\nshared_runs_total 7"
};

const depths: readonly QueueDepthLike[] = [
  { queue: "runs_standard", waiting: 3, active: 1, delayed: 0, completed: 12, failed: 1 }
];

const queue: QueueStatsLike = { getQueueDepths: () => Promise.resolve(depths) };

const enginePool: PoolLike = { ping: () => Promise.resolve({ sessions: 2, idle: 3 }) };

// ---------------------------------------------------------------------------
// Auth seam (internal-only)
// ---------------------------------------------------------------------------

describe("metrics route auth seam", () => {
  it("fails closed with 401 when METRICS_TOKEN is not configured", async () => {
    const router = build({ token: undefined });
    const res = await router.request("/", { headers: { authorization: basic("prom", "anything") } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('Basic realm="metrics"');
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("metrics_token_unconfigured");
    expect(body.error.retryable).toBe(false);
  });

  it("rejects missing or wrong Basic passwords with the §13.3 envelope", async () => {
    const router = build();
    const missing = await router.request("/");
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorEnvelope).error.code).toBe("unauthenticated");

    const wrong = await router.request("/", { headers: { authorization: basic("prom", "nope") } });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as ErrorEnvelope).error.code).toBe("unauthenticated");

    const notBasic = await router.request("/", { headers: { authorization: "Bearer s3cret" } });
    expect(notBasic.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Exposition rendering
// ---------------------------------------------------------------------------

describe("metrics route exposition", () => {
  it("renders every injected family in the documented order", async () => {
    const router = build({ shared, queue, enginePool });
    const res = await router.request("/", { headers: { authorization: basic("prometheus", TOKEN) } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);
    const text = await res.text();

    // HTTP counters → shared registry → queue → engine → uptime.
    const httpAt = text.indexOf("studio_gateway_http_requests_total");
    const sharedAt = text.indexOf("shared_runs_total 7");
    const queueAt = text.indexOf('studio_queue_depth{queue="runs_standard"');
    const engineAt = text.indexOf('studio_engine_sessions{state="active"}');
    const uptimeAt = text.indexOf("studio_gateway_uptime_seconds");
    expect(httpAt).toBeGreaterThanOrEqual(0);
    expect(sharedAt).toBeGreaterThan(httpAt);
    expect(queueAt).toBeGreaterThan(sharedAt);
    expect(engineAt).toBeGreaterThan(queueAt);
    expect(uptimeAt).toBeGreaterThan(engineAt);

    expect(text).toContain("# TYPE studio_gateway_http_requests_total counter");
    expect(text).toContain('studio_queue_depth{queue="runs_standard",state="waiting"} 3');
    expect(text).toContain('studio_queue_depth{queue="runs_standard",state="failed"} 1');
    expect(text).toContain('studio_engine_sessions{state="active"} 2');
    expect(text).toContain('studio_engine_sessions{state="idle"} 3');
    expect(text).toContain('studio_gateway_build_info{version="0.0.0-test"} 1');
    expect(text).toContain("studio_gateway_uptime_seconds 61");
  });

  it("renders the shared registry empty/uninjected/failing as comments, never 503", async () => {
    const plain = build();
    const ok = await plain.request("/", { headers: { authorization: basic("prom", TOKEN) } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("# shared metrics registry not injected (W9-D wiring pending)");

    const empty = await build({ shared: { render: () => "" } }).request("/", {
      headers: { authorization: basic("prom", TOKEN) }
    });
    expect(await empty.text()).toContain("# shared metrics registry rendered empty");

    const boom = await build({
      shared: {
        render: () => {
          throw new Error("registry exploded");
        }
      }
    }).request("/", { headers: { authorization: basic("prom", TOKEN) } });
    expect(boom.status).toBe(200);
    expect(await boom.text()).toContain("# shared metrics registry unavailable (render threw)");
  });

  it("notes an unavailable queue source and keeps the scrape 200 (§22 durability)", async () => {
    const failingQueue: QueueStatsLike = {
      getQueueDepths: () => Promise.reject(new Error("valkey unreachable"))
    };
    const router = build({ queue: failingQueue });
    const res = await router.request("/", { headers: { authorization: basic("prom", TOKEN) } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# queue depth source unavailable (queue gauges omitted)");
    expect(text).not.toContain("studio_queue_depth{");
  });

  it("handles a pool without ping and an absent snapshot", async () => {
    const noPing: PoolLike = {};
    const without = build({ enginePool: noPing });
    const resA = await without.request("/", { headers: { authorization: basic("prom", TOKEN) } });
    expect(await resA.text()).toContain("# engine pool stats not injected");

    const emptyPing: PoolLike = { ping: () => Promise.resolve(undefined) };
    const withEmpty = build({ enginePool: emptyPing });
    const resB = await withEmpty.request("/", { headers: { authorization: basic("prom", TOKEN) } });
    const bodyB = await resB.text();
    expect(bodyB).toContain("# engine pool stats unavailable (supervisor ping returned no snapshot)");
  });

  it("escapes and clamps queue label values (Prometheus wire format)", async () => {
    const weirdDepth: QueueDepthLike = {
      queue: 'weird "q" name',
      waiting: 1,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0
    };
    const weird: QueueStatsLike = { getQueueDepths: () => Promise.resolve([weirdDepth]) };
    const router = build({ queue: weird });
    const res = await router.request("/", { headers: { authorization: basic("prom", TOKEN) } });
    const text = await res.text();
    expect(text).toContain('studio_queue_depth{queue="weird \\"q\\" name",state="waiting"} 1');
  });

  it("serves under the documented /metrics mount through a host app", async () => {
    const host = new Hono<AppEnv>();
    host.route("/metrics", build({ queue }));
    const res = await host.request("/metrics", { headers: { authorization: basic("prom", TOKEN) } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('studio_queue_depth{queue="runs_standard",state="waiting"} 3');
  });
});

// ---------------------------------------------------------------------------
// GatewayMetrics + middleware wiring
// ---------------------------------------------------------------------------

describe("GatewayMetrics http counters", () => {
  it("counts methods/statuses and returns in-flight to zero", async () => {
    const metrics = createGatewayMetrics();
    const app = new Hono<AppEnv>();
    app.use(httpMetricsMiddleware(metrics));
    app.get("/ping", (c) => c.text("pong"));
    app.get("/boom", (c) => c.text("nope", 500));

    await app.request("/ping");
    await app.request("/ping");
    await app.request("/boom");

    const text = metrics.render();
    expect(text).toContain('studio_gateway_http_requests_total{method="GET",status="200"} 2');
    expect(text).toContain('studio_gateway_http_requests_total{method="GET",status="500"} 1');
    expect(text).toContain("studio_gateway_http_requests_in_flight 0");
  });

  it("buckets unknown methods into _other", () => {
    const metrics = createGatewayMetrics();
    metrics.incRequest("QUERY", 200);
    expect(metrics.render()).toContain('studio_gateway_http_requests_total{method="_other",status="200"} 1');
  });
});
