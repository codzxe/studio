// Health routes (§13.1 liveness/deep; §22 observability surface). Owner: W4-Q.
//
//   GET /v1/health       — liveness: version + uptime. Touches NO dependency
//                          (O(1)): a 200 means "the process is up", nothing
//                          more, so orchestrators never flap on a broken dep.
//   GET /v1/health/deep  — dependency checks (§13.1: engine pool, DB, queue,
//                          storage, providers) behind injectable probes.
//                          503 with a `failed` name list when a dependency
//                          is DOWN. A DEGRADED dependency (reachable but
//                          limping — leaked probe object, open provider
//                          circuit with a healthy provider left) keeps 200
//                          and is listed in `degraded`.
//
// Probe wiring (W4-Q): every dependency check runs behind a minimal
// injectable client face — db (`select 1` through the Drizzle client),
// valkey (get/set round-trip through KVLike, the ADR-0004 queue/cache seam),
// storage (put+get+delete of a tiny object under the health/ namespace),
// engine_pool (supervisor ping, else allocate a scratch session and issue
// the cheap `session.list` control method), model_providers (per-provider
// config-present + last circuit state, §5.3/§17.4).
//
// Every probe is OPTIONAL, feature-flag style (§13.1 "dependency checks"):
// `buildProbes` runs a probe only when its client was injected AND its name
// passes the `enabled` set the bootstrap parses from GATEWAY_HEALTH_PROBES
// (see parseProbeFlags). With no clients and no flags every probe reports
// status:"skipped" — counted as healthy so CI/local deep checks pass with
// zero dependencies. A probe that is FLAGGED but has no client reports
// down: that is a bootstrap wiring bug and must not be papered over.
//
// W1-H back-compat: `stubProbes()` (the old stub set) still exists for
// src/index.ts and the sibling test suites — it is now buildProbes({}) with
// a `stub: true` marker. The wiring wave should swap src/index.ts to
// buildProbes({ enabled: parseProbeFlags(env.GATEWAY_HEALTH_PROBES), … }).

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { KVLike } from "../services/limiter.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Probe contracts
// ---------------------------------------------------------------------------

/**
 * Normalized probe verdict for the deep-health aggregate:
 *   ok      — dependency healthy
 *   degraded— reachable but limping; does NOT fail the endpoint
 *   down    — dependency failed; the endpoint answers 503
 *   skipped — not configured/disabled; counted as healthy (CI/local mode)
 */
export type ProbeStatus = "ok" | "degraded" | "down" | "skipped";

/** Result of one dependency probe. */
export interface ProbeCheck {
  readonly ok: boolean;
  /** Normalized status; derived by the runner when the probe omits it. */
  readonly status?: ProbeStatus;
  readonly latency_ms?: number;
  readonly detail?: string;
  /**
   * W1-H marker kept only for the stubProbes() shim (index.ts + sibling
   * tests): true while the probe is an unconfigured stub.
   */
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

// ---------------------------------------------------------------------------
// Deep-health runner
// ---------------------------------------------------------------------------

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

class ProbeTimeoutError extends Error {
  constructor() {
    super("probe timed out");
    this.name = "ProbeTimeoutError";
  }
}

function withTimeout(promise: Promise<ProbeCheck>, timeoutMs: number): Promise<ProbeCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
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

/**
 * Run every probe in parallel, each under its own timeout. A probe that
 * rejects or hangs is reported as down with a generic detail (§15.2: never
 * leak error internals); a probe's own `detail` is passed through verbatim.
 */
async function runProbes(probes: readonly Probe[], timeoutMs: number): Promise<DeepCheckReport[]> {
  return Promise.all(
    probes.map(async (probe): Promise<DeepCheckReport> => {
      const start = performance.now();
      try {
        const result = await withTimeout(probe.check(), timeoutMs);
        return {
          name: probe.name,
          ...result,
          status: !result.ok ? "down" : (result.status ?? "ok"),
          latency_ms: result.latency_ms ?? Math.round(performance.now() - start)
        };
      } catch {
        return {
          name: probe.name,
          ok: false,
          status: "down",
          latency_ms: Math.round(performance.now() - start),
          detail: "probe failed or timed out"
        };
      }
    })
  );
}

// ---------------------------------------------------------------------------
// §13.1 probe seams + factories (one per dependency)
// ---------------------------------------------------------------------------

/**
 * Drizzle client face for the DB probe — `execute(sql\`select 1\`)` is the
 * cheapest real server round-trip. The real `Db` (packages/db createDb)
 * satisfies it structurally; the wiring wave passes it straight in.
 */
export type HealthDbLike = Pick<NodePgDatabase, "execute">;

/** DB probe: `select 1` (§13.1). A rejection means the pool is unusable. */
export function dbProbe(db: HealthDbLike): Probe {
  return {
    name: "db",
    check: async (): Promise<ProbeCheck> => {
      await db.execute(sql`select 1`);
      return { ok: true, detail: "select 1 ok" };
    }
  };
}

const VALKEY_PROBE_TTL_SEC = 5;

/**
 * Queue/cache probe (§13.1 "queue"; ADR-0004 Valkey) over the KVLike seam:
 * set + get round-trip of a fresh nonce. The key is per-call with a short
 * TTL so concurrent gateway instances cannot see each other's nonce and the
 * probe is self-cleaning.
 */
export function valkeyProbe(kv: KVLike): Probe {
  return {
    name: "valkey",
    check: async (): Promise<ProbeCheck> => {
      const key = `health:ping:${randomUUID()}`;
      const nonce = randomUUID();
      await kv.set(key, nonce, VALKEY_PROBE_TTL_SEC);
      const got = await kv.get(key);
      return got === nonce
        ? { ok: true, detail: "get/set round-trip ok" }
        : { ok: false, status: "down", detail: "round-trip mismatch after set" };
    }
  };
}

/**
 * Object-storage probe (§13.1 "storage", §15.1 storage layer): put + get +
 * delete of a tiny object under the health/ namespace. A put/get failure (or
 * a missing/mismatched read) is DOWN; a failed delete is DEGRADED only —
 * the round-trip proved the dependency, a leftover probe object is noise.
 * The body is a stable constant so multiple gateway instances agree on the
 * same object; adapters should expire the health/ prefix.
 */
export interface StorageLike {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export const DEFAULT_STORAGE_PROBE_KEY = "health/gateway-deep-probe.json";
const STORAGE_PROBE_BODY = '{"probe":"gateway-deep"}';

export function storageProbe(storage: StorageLike, key: string = DEFAULT_STORAGE_PROBE_KEY): Probe {
  return {
    name: "storage",
    check: async (): Promise<ProbeCheck> => {
      await storage.put(key, STORAGE_PROBE_BODY);
      const got = await storage.get(key);
      if (got !== STORAGE_PROBE_BODY) {
        return {
          ok: false,
          status: "down",
          detail: got === null ? "object missing after put" : "object content mismatch after put"
        };
      }
      try {
        await storage.delete(key);
      } catch {
        return {
          ok: true,
          status: "degraded",
          detail: "put/get ok; delete failed (probe object left under health/)"
        };
      }
      return { ok: true, detail: "put/get/delete round-trip ok" };
    }
  };
}

/**
 * Engine-pool probe (§13.1, §3.1 engine session model). Two paths, cheapest
 * first: a supervisor `ping` when the pool exposes one; otherwise the
 * SCRATCH-SESSION path — allocate a session, issue the cheap `session.list`
 * control method (open documents + active index; see
 * vendor/photocraft/docs/control-protocol.md "Headless server"), release.
 * The scratch path exercises allocate → command → release end to end, on
 * an empty scratch session that never touches tenant data (§15.1). A failed
 * release leaves a leaked session: reported DEGRADED, not down.
 */
export interface EnginePoolPing {
  /** Engine sessions currently allocated (supervisor bookkeeping). */
  readonly sessions: number;
  /** Idle sessions ready to hand out. */
  readonly idle: number;
}

/** The scratch-session face the probe borrows when `ping` is absent. */
export interface EngineSessionProbeLike {
  /** Cheap `session.list` control method on this session. */
  list(): Promise<unknown>;
  release(): Promise<void>;
}

export interface PoolLike {
  /** Cheap supervisor RPC — preferred probe path. Resolves void as undefined. */
  ping?(): Promise<EnginePoolPing | undefined>;
  /** Scratch-session probe path (heavier: may spawn an engine process). */
  allocate?(): Promise<EngineSessionProbeLike>;
}

export function enginePoolProbe(pool: PoolLike): Probe {
  return {
    name: "engine_pool",
    check: async (): Promise<ProbeCheck> => {
      if (pool.ping !== undefined) {
        const ping = await pool.ping();
        return ping === undefined
          ? { ok: true, detail: "supervisor ping ok" }
          : {
              ok: true,
              detail: `supervisor ping ok (sessions=${ping.sessions}, idle=${ping.idle})`
            };
      }
      if (pool.allocate === undefined) {
        return { ok: false, status: "down", detail: "pool exposes neither ping nor allocate" };
      }
      let releaseFailed = false;
      let session: EngineSessionProbeLike | undefined;
      try {
        session = await pool.allocate();
        await session.list();
      } finally {
        if (session !== undefined) {
          try {
            await session.release();
          } catch {
            releaseFailed = true;
          }
        }
      }
      return releaseFailed
        ? {
            ok: true,
            status: "degraded",
            detail: "scratch session.list ok; release failed (session may leak)"
          }
        : { ok: true, detail: "scratch session allocate -> session.list -> release ok" };
    }
  };
}

/**
 * Model-provider probe (§13.1 "providers"; circuits §5.3/§17.4): reads the
 * registry's per-provider config-present + last circuit state. Verdict:
 *   - no configured provider, or every configured provider OPEN  → down
 *   - ≥1 healthy (closed/half-open) + ≥1 open circuit           → degraded
 *   - every configured provider closed/half-open                 → ok
 * Unconfigured providers are ignored (not configured is not an outage).
 */
export type CircuitState = "closed" | "half-open" | "open" | "unknown";

export interface ProviderHealthSnapshot {
  /** Provider slug (e.g. "anthropic"); sanitized before it reaches a detail. */
  readonly provider: string;
  /** Config-present (credentials/secrets resolved at boot). */
  readonly configured: boolean;
  /** Last known circuit-breaker state. */
  readonly circuit: CircuitState;
}

export interface ProviderHealthLike {
  snapshot(): Promise<readonly ProviderHealthSnapshot[]>;
}

function providerToken(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unknown";
}

export function providersProbe(providers: ProviderHealthLike): Probe {
  return {
    name: "model_providers",
    check: async (): Promise<ProbeCheck> => {
      let entries: readonly ProviderHealthSnapshot[];
      try {
        entries = await providers.snapshot();
      } catch {
        return { ok: false, status: "down", detail: "provider health snapshot unavailable" };
      }
      const configured = entries.filter((entry) => entry.configured);
      if (configured.length === 0) {
        return { ok: false, status: "down", detail: "no model providers configured" };
      }
      const names = (list: readonly ProviderHealthSnapshot[]): string =>
        list.map((entry) => providerToken(entry.provider)).join(", ");
      const healthy = configured.filter(
        (entry) => entry.circuit === "closed" || entry.circuit === "half-open"
      );
      const open = configured.filter((entry) => entry.circuit === "open");
      if (healthy.length === 0) {
        return {
          ok: false,
          status: "down",
          detail: `no healthy provider (open circuits: ${names(configured)})`
        };
      }
      if (open.length > 0) {
        return { ok: true, status: "degraded", detail: `open circuits: ${names(open)}` };
      }
      return { ok: true, detail: `${healthy.length} provider(s) healthy` };
    }
  };
}

// ---------------------------------------------------------------------------
// Feature-flag assembly
// ---------------------------------------------------------------------------

/** §13.1 dependency names, canonical deep-check order. */
export const PROBE_NAMES = [
  "db",
  "valkey",
  "storage",
  "engine_pool",
  "model_providers"
] as const;

export type ProbeName = (typeof PROBE_NAMES)[number];

/** Injectable dependency clients for buildProbes — every one optional. */
export interface ProbeDeps {
  /**
   * Allowlist parsed from the environment by the bootstrap (§13.1 flags).
   * Undefined = no flags configured: every injected client is probed and
   * missing clients are skipped. An empty set = all probes disabled.
   */
  readonly enabled?: ReadonlySet<ProbeName>;
  readonly db?: HealthDbLike;
  readonly kv?: KVLike;
  readonly storage?: StorageLike;
  readonly enginePool?: PoolLike;
  readonly providers?: ProviderHealthLike;
}

/**
 * Parse a comma-separated flag list (e.g. GATEWAY_HEALTH_PROBES="db,valkey")
 * into a ProbeName allowlist. Unknown tokens are ignored (typo-safe): pass
 * the result as `ProbeDeps.enabled`. Undefined input → undefined (no flags).
 */
export function parseProbeFlags(raw: string | undefined): ReadonlySet<ProbeName> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const names: readonly string[] = PROBE_NAMES;
  const set = new Set<ProbeName>();
  for (const token of raw.split(",")) {
    const name = token.trim().toLowerCase();
    if (names.includes(name)) {
      set.add(name as ProbeName);
    }
  }
  return set;
}

function staticProbe(name: ProbeName, check: ProbeCheck): Probe {
  return { name, check: () => Promise.resolve(check) };
}

function resolveProbe(
  name: ProbeName,
  enabled: ReadonlySet<ProbeName> | undefined,
  make: (() => Probe) | undefined
): Probe {
  if (enabled !== undefined && !enabled.has(name)) {
    return staticProbe(name, { ok: true, status: "skipped", detail: "disabled by probe flag" });
  }
  if (make === undefined) {
    return enabled === undefined
      ? staticProbe(name, {
          ok: true,
          status: "skipped",
          detail: "not configured (no client injected)"
        })
      : staticProbe(name, {
          ok: false,
          status: "down",
          detail: "flagged but no client injected (bootstrap wiring bug)"
        });
  }
  return make();
}

/**
 * Assemble the §13.1 probe set in canonical order. Probe inclusion rules:
 * injected client + flag allows → real probe; no flags → missing clients are
 * skipped (healthy, CI/local); flagged + missing client → down (wiring bug);
 * flagged off → skipped. NEVER touches the environment — the bootstrap owns
 * process.env and calls parseProbeFlags.
 */
export function buildProbes(deps: ProbeDeps): Probe[] {
  const { enabled, db, kv, storage, enginePool, providers } = deps;
  const makers: Record<ProbeName, (() => Probe) | undefined> = {
    db: db !== undefined ? () => dbProbe(db) : undefined,
    valkey: kv !== undefined ? () => valkeyProbe(kv) : undefined,
    storage: storage !== undefined ? () => storageProbe(storage) : undefined,
    engine_pool: enginePool !== undefined ? () => enginePoolProbe(enginePool) : undefined,
    model_providers: providers !== undefined ? () => providersProbe(providers) : undefined
  };
  return PROBE_NAMES.map((name) => resolveProbe(name, enabled, makers[name]));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface HealthDeps {
  /** Service version string (image/build tag) for the liveness payload. */
  readonly version: string;
  /** Epoch ms uptime anchor (injected for deterministic tests). */
  readonly startedAt: number;
  /** Dependency probes for the deep check. */
  readonly probes: readonly Probe[];
  /** Per-probe timeout in ms. Default 2000; inject small for tests. */
  readonly probeTimeoutMs?: number;
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
  // 503 names every down dependency in `failed` (§13.1); `degraded` lists the
  // limping ones that do not fail the check.
  router.get("/deep", async (c) => {
    const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const checks = await runProbes(deps.probes, timeoutMs);
    const failed = checks.filter((check) => check.status === "down").map((check) => check.name);
    const degraded = checks
      .filter((check) => check.status === "degraded")
      .map((check) => check.name);
    const allOk = checks.length > 0 && failed.length === 0;
    return c.json(
      {
        ok: allOk,
        service: "gateway",
        version: deps.version,
        uptime_seconds: uptimeSeconds(deps.startedAt),
        checks,
        degraded,
        failed
      },
      allOk ? 200 : 503
    );
  });

  return router;
}

/**
 * W1-H back-compat shim: the five §13.1 probe names, all reported as
 * skipped-healthy with the historical `stub: true` marker. Kept only for
 * src/index.ts and the sibling test suites; the wiring wave should replace
 * those call sites with buildProbes({ enabled: parseProbeFlags(…), … }).
 */
export function stubProbes(): Probe[] {
  return buildProbes({}).map((probe) => ({
    name: probe.name,
    check: async (): Promise<ProbeCheck> => ({ ...(await probe.check()), stub: true })
  }));
}
