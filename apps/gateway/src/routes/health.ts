// Health routes (§13.1: liveness / dependency checks).
//
//   GET /v1/health       — liveness: version + uptime (no dependencies touched).
//   GET /v1/health/deep  — dependency checks behind an injectable probe
//                          interface (db, valkey, storage, engine pool, model
//                          providers); 503 when any probe reports down.
//
// Probes are injected so tests (and later waves) can wire real clients
// (drizzle `select 1`, ioredis ping, S3 head-bucket, engine-pool supervisor
// RPC, provider health) without touching this file.

import { Hono } from "hono";
import type { AppEnv } from "../types.js";

/** Result of one dependency probe. */
export interface ProbeCheck {
  readonly ok: boolean;
  readonly latency_ms?: number;
  readonly detail?: string;
  /** True while the probe is a skeleton stub — TODO(W2+): remove once real wires land. */
  readonly stub?: boolean;
}

/** A named dependency check, injectable via buildApp deps. */
export interface Probe {
  readonly name: string;
  check(): Promise<ProbeCheck>;
}

/** A ProbeCheck annotated with the probe name for the deep-health response. */
export interface DeepCheckReport extends ProbeCheck {
  readonly name: string;
}

const PROBE_TIMEOUT_MS = 2_000;

class ProbeTimeoutError extends Error {
  constructor() {
    super("probe timed out");
    this.name = "ProbeTimeoutError";
  }
}

function withTimeout(promise: Promise<ProbeCheck>): Promise<ProbeCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function uptimeSeconds(startedAt: number): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

async function runProbes(probes: readonly Probe[]): Promise<DeepCheckReport[]> {
  return Promise.all(
    probes.map(async (probe): Promise<DeepCheckReport> => {
      const start = performance.now();
      try {
        const result = await withTimeout(probe.check());
        return {
          name: probe.name,
          ...result,
          latency_ms: result.latency_ms ?? Math.round(performance.now() - start)
        };
      } catch {
        return {
          name: probe.name,
          ok: false,
          latency_ms: Math.round(performance.now() - start),
          detail: "probe failed or timed out"
        };
      }
    })
  );
}

export interface HealthDeps {
  /** Service version string (image/build tag) for the liveness payload. */
  readonly version: string;
  /** Epoch ms uptime anchor (injected for deterministic tests). */
  readonly startedAt: number;
  /** Dependency probes for the deep check. */
  readonly probes: readonly Probe[];
}

/** Health router, mounted at /v1/health by src/routes/index.ts. */
export function healthRoutes(deps: HealthDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Liveness: process is up. No dependencies touched — keep this endpoint O(1).
  router.get("/", (c) =>
    c.json({
      ok: true,
      service: "gateway",
      version: deps.version,
      uptime_seconds: uptimeSeconds(deps.startedAt)
    })
  );

  // Deep: dependency checks (db / valkey / storage / engine pool / providers).
  router.get("/deep", async (c) => {
    const checks = await runProbes(deps.probes);
    const allOk = checks.length > 0 && checks.every((check) => check.ok);
    return c.json(
      {
        ok: allOk,
        service: "gateway",
        version: deps.version,
        uptime_seconds: uptimeSeconds(deps.startedAt),
        checks
      },
      allOk ? 200 : 503
    );
  });

  return router;
}

/**
 * Skeleton probes (W1-H). TODO(W2+) — replace with real checks:
 *   db              — packages/db client, `select 1` (Drizzle)
 *   valkey          — ioredis ping (queue/cache, §3.1)
 *   storage         — S3/R2 head-bucket (objects, §3.1)
 *   engine_pool     — engine-pool supervisor health RPC (§3.1 engine session model)
 *   model_providers — paid provider health/circuit-breaker state (§5.3, §17.4)
 */
export function stubProbes(): Probe[] {
  const stub = (name: string): Probe => ({
    name,
    check: () =>
      Promise.resolve({
        ok: true,
        stub: true,
        detail: `probe not wired yet (TODO W2+: ${name})`
      } satisfies ProbeCheck)
  });
  return [
    stub("db"),
    stub("valkey"),
    stub("storage"),
    stub("engine_pool"),
    stub("model_providers")
  ];
}
