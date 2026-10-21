// Health + audit tests (W4-Q) — deterministic fakes, no network, no DB
// (AGENTS.md test rules).
//
// Deep health: exercised through healthRoutes() with injected probes; the
// §13.1 probe factories (db/valkey/storage/engine_pool/model_providers) are
// driven by in-memory client fakes, covering the pass/fail table, degraded vs
// down, feature flags and the W1-H stubProbes back-compat contract.
//
// Audit: AuditService over an in-memory AuditStoreLike. The fake implements
// the keyset/page semantics INDEPENDENTLY of DrizzleAuditStore (the W4-H
// DrizzleEventStore pattern: the thin drizzle adapter is verified by CI
// typecheck + inspection; the fake proves the service's cursor math).
//
//   §13.1 GET /v1/health + /v1/health/deep (liveness / dependency checks)
//   §15.3 metadata redaction (never store raw prompts)
//   §22    audit append (rate-limited, append-only) + per-workspace export

import type { NewAuditLog } from "@studio/db";
import { describe, expect, it } from "vitest";
import {
  buildProbes,
  dbProbe,
  enginePoolProbe,
  healthRoutes,
  parseProbeFlags,
  providersProbe,
  stubProbes,
  storageProbe,
  valkeyProbe,
  type DeepCheckReport,
  type EngineSessionProbeLike,
  type HealthDbLike,
  type PoolLike,
  type Probe,
  type ProbeCheck,
  type ProbeDeps,
  type ProbeName,
  type ProviderHealthLike,
  type ProviderHealthSnapshot,
  type StorageLike
} from "../src/routes/health.js";
import {
  AUDIT_DROPPED,
  AUDIT_REDACTED,
  AUDIT_TRUNCATED,
  AuditService,
  type AuditExportRow,
  type AuditPageOptions,
  type AuditRow,
  type AuditStoreLike,
  decodeCursor,
  encodeCursor,
  redactMetadata
} from "../src/services/audit.js";
import { InMemoryKV, type KVLike } from "../src/services/limiter.js";

// ---------------------------------------------------------------------------
// Fixtures: deep-health fakes
// ---------------------------------------------------------------------------

const VERSION = "0.0.0-test";

interface DeepHealthBody {
  ok: boolean;
  service: string;
  version: string;
  uptime_seconds: number;
  checks: DeepCheckReport[];
  degraded: string[];
  failed: string[];
}

async function deep(
  probes: readonly Probe[],
  probeTimeoutMs = 250
): Promise<{ status: number; body: DeepHealthBody }> {
  const app = healthRoutes({ version: VERSION, startedAt: Date.now(), probes, probeTimeoutMs });
  const res = await app.request("/deep");
  return { status: res.status, body: (await res.json()) as DeepHealthBody };
}

// HealthDbLike is a Drizzle client face (db.execute); the fakes only need to
// resolve or reject, so they are cast through unknown — no pg typings here.
const okDb = { execute: async (): Promise<string> => "ok" } as unknown as HealthDbLike;
const failDb = {
  execute: async (): Promise<string> => {
    throw new Error("connection refused");
  }
} as unknown as HealthDbLike;

class MismatchKV implements KVLike {
  async get(): Promise<string | null> {
    return "someone-elses-nonce";
  }
  async set(): Promise<void> {}
}

class FailSetKV implements KVLike {
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {
    throw new Error("valkey down");
  }
}

class FakeStorage implements StorageLike {
  readonly objects = new Map<string, string>();
  readonly deleted: string[] = [];
  failPut = false;
  failGet = false;
  failDelete = false;

  async put(key: string, body: string): Promise<void> {
    if (this.failPut) {
      throw new Error("storage down");
    }
    this.objects.set(key, body);
  }

  async get(key: string): Promise<string | null> {
    if (this.failGet) {
      throw new Error("storage down");
    }
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete) {
      throw new Error("storage down");
    }
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

function pingPool(ok: boolean): PoolLike {
  return {
    ping: async () => {
      if (!ok) {
        throw new Error("supervisor down");
      }
      return { sessions: 2, idle: 1 };
    }
  };
}

function scratchPool(
  behavior: "ok" | "list-fails" | "release-fails"
): PoolLike & { ops: string[] } {
  const ops: string[] = [];
  const pool: PoolLike & { ops: string[] } = {
    ops,
    allocate: async (): Promise<EngineSessionProbeLike> => {
      ops.push("allocate");
      return {
        list: async () => {
          ops.push("list");
          if (behavior === "list-fails") {
            throw new Error("engine broken");
          }
        },
        release: async () => {
          ops.push("release");
          if (behavior === "release-fails") {
            throw new Error("release failed");
          }
        }
      };
    }
  };
  return pool;
}

class FakeProviders implements ProviderHealthLike {
  constructor(
    private readonly entries: readonly ProviderHealthSnapshot[] | undefined
  ) {}

  async snapshot(): Promise<readonly ProviderHealthSnapshot[]> {
    if (this.entries === undefined) {
      throw new Error("registry down");
    }
    return this.entries;
  }
}

function providers(entries: readonly ProviderHealthSnapshot[]): FakeProviders {
  return new FakeProviders(entries);
}

function healthyRealDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    db: okDb,
    kv: new InMemoryKV(),
    storage: new FakeStorage(),
    enginePool: pingPool(true),
    providers: providers([
      { provider: "anthropic", configured: true, circuit: "closed" },
      { provider: "google", configured: true, circuit: "closed" }
    ]),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Fixtures: audit fakes
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

/** In-memory AuditStoreLike — implements the keyset/page semantics itself. */
class FakeAuditStore implements AuditStoreLike {
  readonly rows: AuditRow[] = [];
  readonly pageLimits: number[] = [];
  failInsert = false;
  failPage = false;
  #idSeq = 0;

  async insert(row: NewAuditLog): Promise<void> {
    if (this.failInsert) {
      throw new Error("db down");
    }
    this.#idSeq += 1;
    const id = `00000000-0000-4000-8000-${String(this.#idSeq).padStart(12, "0")}`;
    this.rows.push({
      id: row.id ?? id,
      organizationId: row.organizationId ?? null,
      actorId: row.actorId ?? null,
      action: row.action,
      target: row.target,
      metadata: row.metadata ?? {},
      createdAt: row.createdAt ?? new Date()
    });
  }

  async page(
    organizationId: string,
    options: AuditPageOptions
  ): Promise<readonly AuditRow[]> {
    if (this.failPage) {
      throw new Error("db down");
    }
    this.pageLimits.push(options.limit);
    const { from, to, before } = options;
    let rows = this.rows.filter((row) => row.organizationId === organizationId);
    if (from !== undefined) {
      rows = rows.filter((row) => row.createdAt.getTime() >= from.getTime());
    }
    if (to !== undefined) {
      rows = rows.filter((row) => row.createdAt.getTime() <= to.getTime());
    }
    if (before !== undefined) {
      const at = before.createdAt.getTime();
      rows = rows.filter(
        (row) =>
          row.createdAt.getTime() < at ||
          (row.createdAt.getTime() === at && row.id < before.id)
      );
    }
    const sorted = [...rows].sort((a, b) => {
      const diff = b.createdAt.getTime() - a.createdAt.getTime();
      return diff !== 0 ? diff : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return sorted.slice(0, options.limit);
  }
}

interface AuditHarness {
  readonly svc: AuditService;
  readonly store: FakeAuditStore;
  advance(ms: number): void;
}

function makeAudit(appendRate?: { limit: number; windowSec: number }): AuditHarness {
  let clockMs = T0;
  const store = new FakeAuditStore();
  const svc = new AuditService({
    store,
    now: () => new Date(clockMs),
    appendRate
  });
  return { svc, store, advance: (ms: number) => (clockMs += ms) };
}

// ---------------------------------------------------------------------------
// GET /v1/health — liveness only
// ---------------------------------------------------------------------------

describe("GET /v1/health (liveness, §13.1)", () => {
  it("stays 200 while every dependency is down — no deps touched", async () => {
    const app = healthRoutes({
      version: VERSION,
      startedAt: Date.now(),
      probes: [dbProbe(failDb)]
    });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; version: string };
    expect(body).toEqual({ ok: true, service: "gateway", version: VERSION });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/health/deep — §13.1 pass/fail table
// ---------------------------------------------------------------------------

describe("GET /v1/health/deep — pass/fail table (§13.1)", () => {
  interface Row {
    readonly name: string;
    readonly probes: () => Probe[];
    readonly status: number;
    readonly ok: boolean;
    readonly failed: string[];
    readonly degraded: string[];
  }

  const unconfiguredProviders = providers([
    { provider: "anthropic", configured: false, circuit: "unknown" }
  ]);

  const table: readonly Row[] = [
    {
      name: "all five real probes healthy → 200, nothing failed or degraded",
      probes: () => buildProbes(healthyRealDeps()),
      status: 200,
      ok: true,
      failed: [],
      degraded: []
    },
    {
      name: "db select-1 rejected → 503 naming db",
      probes: () => [dbProbe(failDb)],
      status: 503,
      ok: false,
      failed: ["db"],
      degraded: []
    },
    {
      name: "valkey set rejected → 503",
      probes: () => [valkeyProbe(new FailSetKV())],
      status: 503,
      ok: false,
      failed: ["valkey"],
      degraded: []
    },
    {
      name: "valkey round-trip mismatch → 503",
      probes: () => [valkeyProbe(new MismatchKV())],
      status: 503,
      ok: false,
      failed: ["valkey"],
      degraded: []
    },
    {
      name: "storage put rejected → 503",
      probes: () => {
        const storage = new FakeStorage();
        storage.failPut = true;
        return [storageProbe(storage)];
      },
      status: 503,
      ok: false,
      failed: ["storage"],
      degraded: []
    },
    {
      name: "storage delete rejected → degraded, still 200",
      probes: () => {
        const storage = new FakeStorage();
        storage.failDelete = true;
        return [storageProbe(storage)];
      },
      status: 200,
      ok: true,
      failed: [],
      degraded: ["storage"]
    },
    {
      name: "engine pool supervisor ping rejected → 503",
      probes: () => [enginePoolProbe(pingPool(false))],
      status: 503,
      ok: false,
      failed: ["engine_pool"],
      degraded: []
    },
    {
      name: "engine pool scratch session.list rejected → 503",
      probes: () => [enginePoolProbe(scratchPool("list-fails"))],
      status: 503,
      ok: false,
      failed: ["engine_pool"],
      degraded: []
    },
    {
      name: "engine pool release rejected → degraded, still 200",
      probes: () => [enginePoolProbe(scratchPool("release-fails"))],
      status: 200,
      ok: true,
      failed: [],
      degraded: ["engine_pool"]
    },
    {
      name: "providers: no configured provider → 503",
      probes: () => [providersProbe(unconfiguredProviders)],
      status: 503,
      ok: false,
      failed: ["model_providers"],
      degraded: []
    },
    {
      name: "providers: all configured circuits open → 503",
      probes: () =>
        providersProbe(
          providers([
            { provider: "anthropic", configured: true, circuit: "open" },
            { provider: "google", configured: true, circuit: "open" }
          ])
        ),
      status: 503,
      ok: false,
      failed: ["model_providers"],
      degraded: []
    },
    {
      name: "providers: one open circuit with a healthy provider → degraded",
      probes: () =>
        providersProbe(
          providers([
            { provider: "anthropic", configured: true, circuit: "closed" },
            { provider: "google", configured: true, circuit: "open" }
          ])
        ),
      status: 200,
      ok: true,
      failed: [],
      degraded: ["model_providers"]
    },
    {
      name: "providers: snapshot rejects → 503",
      probes: () => [providersProbe(new FakeProviders(undefined))],
      status: 503,
      ok: false,
      failed: ["model_providers"],
      degraded: []
    },
    {
      name: "db down + storage degraded → 503 with both named",
      probes: () => {
        const storage = new FakeStorage();
        storage.failDelete = true;
        return [dbProbe(failDb), storageProbe(storage)];
      },
      status: 503,
      ok: false,
      failed: ["db"],
      degraded: ["storage"]
    },
    {
      name: "legacy W1-H probe shape (ok:false, no status) → down, detail kept",
      probes: () => [
        { name: "db", check: () => Promise.resolve({ ok: false, detail: "connection refused" }) }
      ],
      status: 503,
      ok: false,
      failed: ["db"],
      degraded: []
    }
  ];

  for (const row of table) {
    it(row.name, async () => {
      const { status, body } = await deep(row.probes());
      expect(status).toBe(row.status);
      expect(body.ok).toBe(row.ok);
      expect(body.failed).toEqual(row.failed);
      expect(body.degraded).toEqual(row.degraded);
    });
  }

  it("reports all five §13.1 names in canonical order with status ok", async () => {
    const { body } = await deep(buildProbes(healthyRealDeps()));
    expect(body.checks.map((check) => check.name)).toEqual([
      "db",
      "valkey",
      "storage",
      "engine_pool",
      "model_providers"
    ]);
    expect(body.checks.every((check) => check.ok && check.status === "ok")).toBe(true);
  });

  it("reports a hung probe as down after the injected timeout", async () => {
    const hung: Probe = {
      name: "db",
      check: () => new Promise<ProbeCheck>(() => {})
    };
    const { status, body } = await deep([hung], 30);
    expect(status).toBe(503);
    expect(body.failed).toEqual(["db"]);
    expect(body.checks[0]?.detail).toBe("probe failed or timed out");
  });
});

// ---------------------------------------------------------------------------
// Probe factories — direct behavior
// ---------------------------------------------------------------------------

describe("probe factories (§13.1 seams)", () => {
  it("dbProbe resolves ok on a successful select 1", async () => {
    expect(await dbProbe(okDb).check()).toEqual({ ok: true, detail: "select 1 ok" });
  });

  it("scratch engine session path runs allocate → session.list → release", async () => {
    const pool = scratchPool("ok");
    const check = await enginePoolProbe(pool).check();
    expect(check.ok).toBe(true);
    expect(pool.ops).toEqual(["allocate", "list", "release"]);
  });

  it("storage probe cleans its health/ object up", async () => {
    const storage = new FakeStorage();
    const check = await storageProbe(storage).check();
    expect(check).toEqual({ ok: true, detail: "put/get/delete round-trip ok" });
    expect(storage.objects.size).toBe(0);
    expect(storage.deleted).toEqual(["health/gateway-deep-probe.json"]);
  });

  it("valkey probe round-trips a fresh nonce through KVLike", async () => {
    const check = await valkeyProbe(new InMemoryKV()).check();
    expect(check.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature flags + stubProbes back-compat
// ---------------------------------------------------------------------------

describe("buildProbes feature flags + stubProbes (§13.1)", () => {
  it("no clients and no flags → every probe skipped, deep stays 200", async () => {
    const { status, body } = await deep(buildProbes({}));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.every((check) => check.status === "skipped" && check.ok)).toBe(true);
  });

  it("allowlist flags: disabled probes are skipped, not failed", async () => {
    const probes = buildProbes({ ...healthyRealDeps(), enabled: new Set<ProbeName>(["db"]) });
    const { status, body } = await deep(probes);
    expect(status).toBe(200);
    const valkey = body.checks.find((check) => check.name === "valkey");
    expect(valkey?.status).toBe("skipped");
    expect(valkey?.detail).toBe("disabled by probe flag");
    expect(body.checks.find((check) => check.name === "db")?.status).toBe("ok");
  });

  it("flagged but no client injected → down (bootstrap wiring bug)", async () => {
    const { status, body } = await deep(buildProbes({ enabled: new Set<ProbeName>(["storage"]) }));
    expect(status).toBe(503);
    expect(body.failed).toEqual(["storage"]);
  });

  it("parseProbeFlags is case-insensitive and ignores unknown tokens", () => {
    expect(parseProbeFlags("db, storage, bogus, DB")).toEqual(new Set(["db", "storage"]));
    expect(parseProbeFlags(undefined)).toBeUndefined();
    expect(parseProbeFlags("nope").size).toBe(0);
  });

  it("stubProbes() keeps the W1-H contract: five skipped stubs, ok:true", async () => {
    const probes = stubProbes();
    expect(probes.map((probe) => probe.name)).toEqual([
      "db",
      "valkey",
      "storage",
      "engine_pool",
      "model_providers"
    ]);
    const results = await Promise.all(probes.map((probe) => probe.check()));
    expect(results.every((result) => result.ok && result.stub === true)).toBe(true);
    expect(results.every((result) => result.status === "skipped")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit: metadata redaction (§15.3)
// ---------------------------------------------------------------------------

describe("redactMetadata (§15.3 — never store raw prompts)", () => {
  interface RedactRow {
    readonly name: string;
    readonly input: unknown;
    readonly expected: Record<string, unknown>;
  }

  const table: readonly RedactRow[] = [
    {
      name: "prompt keys never survive",
      input: { prompt: "make a poster", user_prompt: "x", systemPrompt: "y" },
      expected: {
        prompt: AUDIT_REDACTED,
        user_prompt: AUDIT_REDACTED,
        systemPrompt: AUDIT_REDACTED
      }
    },
    {
      name: "secret / content / image keys never survive",
      input: {
        api_key: "sk-1",
        Authorization: "Bearer t",
        password: "p",
        sessionToken: "t",
        requestBody: "{}",
        text: "hello",
        imageUrl: "http://x/y.png"
      },
      expected: {
        api_key: AUDIT_REDACTED,
        Authorization: AUDIT_REDACTED,
        password: AUDIT_REDACTED,
        sessionToken: AUDIT_REDACTED,
        requestBody: AUDIT_REDACTED,
        text: AUDIT_REDACTED,
        imageUrl: AUDIT_REDACTED
      }
    },
    {
      name: "safe context survives",
      input: { tier: "standard", idempotencyKey: "idem-1", count: 3, flag: true },
      expected: { tier: "standard", idempotencyKey: "idem-1", count: 3, flag: true }
    },
    {
      name: "nested denied keys",
      input: { layer: { text: "Headline", opacity: 0.5 }, messages: [{ role: "user" }] },
      expected: { layer: { text: AUDIT_REDACTED, opacity: 0.5 }, messages: AUDIT_REDACTED }
    },
    {
      name: "long strings truncated",
      input: { note: "a".repeat(600) },
      expected: { note: "a".repeat(512) + AUDIT_TRUNCATED }
    },
    {
      name: "control characters stripped",
      input: { note: "a\u0000b\u0007c" },
      expected: { note: "abc" }
    },
    {
      name: "raw string metadata dropped entirely (could be a prompt)",
      input: "just a string",
      expected: {}
    },
    { name: "array metadata dropped entirely", input: ["a", "b"], expected: {} },
    { name: "null metadata", input: null, expected: {} },
    { name: "undefined metadata", input: undefined, expected: {} },
    {
      name: "exotic values dropped",
      input: { when: new Date(0), map: new Map() },
      expected: { when: AUDIT_DROPPED, map: AUDIT_DROPPED }
    },
    { name: "NaN dropped", input: { n: Number.NaN }, expected: { n: AUDIT_DROPPED } },
    {
      name: "values beyond maxDepth dropped",
      input: { a: { b: { c: { d: { e: "x" } } } } },
      expected: { a: { b: { c: { d: { e: AUDIT_DROPPED } } } } }
    },
    {
      name: "array items are walked",
      input: { tags: ["a", "b", "c"] },
      expected: { tags: ["a", "b", "c"] }
    }
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(redactMetadata(row.input)).toEqual(row.expected);
    });
  }

  it("caps object keys and array items at the policy limit", () => {
    const input = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`k${i}`, i] as const)
    );
    const expected = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`k${i}`, i] as const)
    );
    expected["[truncated]"] = true;
    expect(redactMetadata(input)).toEqual(expected);

    const cappedArray = Array.from({ length: 70 }, (_, i) => `t${i}`);
    expect(redactMetadata({ tags: cappedArray })).toEqual({
      tags: [...cappedArray.slice(0, 64), AUDIT_TRUNCATED]
    });
  });

  it("cursor codec round-trips and rejects garbage", () => {
    const anchor = { createdAt: new Date(T0 + 123), id: "00000000-0000-4000-8000-000000000009" };
    expect(decodeCursor(encodeCursor(anchor))).toEqual(anchor);
    expect(decodeCursor("!!!not-a-cursor!!!")).toBeNull();
    const wrongShape = Buffer.from(JSON.stringify({ v: 2, at: "nope", id: "x" })).toString(
      "base64url"
    );
    expect(decodeCursor(wrongShape)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit: append (§22 — plain append, rate-limited, redacted)
// ---------------------------------------------------------------------------

describe("AuditService.append (§22)", () => {
  it("stores one redacted row with the injected clock", async () => {
    const { svc, store } = makeAudit();
    const res = await svc.append("auth.login", {
      actorId: "user-1",
      metadata: { ip: "127.0.0.1", prompt: "secret prompt" }
    });
    expect(res.ok).toBe(true);
    expect(store.rows.length).toBe(1);
    const row = store.rows[0];
    if (row === undefined) {
      throw new Error("row missing");
    }
    expect(row.action).toBe("auth.login");
    expect(row.actorId).toBe("user-1");
    expect(row.organizationId).toBeNull();
    expect(row.target).toBe("platform:none");
    expect(row.metadata).toEqual({ ip: "127.0.0.1", prompt: AUDIT_REDACTED });
    expect(row.createdAt.getTime()).toBe(T0);
  });

  it("is a plain append — repeating the same event writes two rows", async () => {
    const { svc, store } = makeAudit();
    await svc.append("role.changed", { organizationId: "org-a", target: "member:user-2" });
    await svc.append("role.changed", { organizationId: "org-a", target: "member:user-2" });
    expect(store.rows.length).toBe(2);
  });

  it("rejects invalid actions and writes nothing", async () => {
    const { svc, store } = makeAudit();
    for (const action of ["", "Login", "auth login", "auth.", "x".repeat(129)]) {
      const res = await svc.append(action);
      expect(res).toMatchObject({ ok: false, code: "invalid_action", retryable: false });
    }
    expect(store.rows.length).toBe(0);
  });

  it("validates target and references", async () => {
    const { svc, store } = makeAudit();
    expect(await svc.append("auth.login", { target: "no-colon-here" })).toMatchObject({
      ok: false,
      code: "invalid_target"
    });
    expect(await svc.append("auth.login", { target: "has space:123" })).toMatchObject({
      ok: false,
      code: "invalid_target"
    });
    expect(await svc.append("auth.login", { organizationId: "" })).toMatchObject({
      ok: false,
      code: "invalid_org"
    });
    expect(await svc.append("auth.login", { actorId: "u".repeat(65) })).toMatchObject({
      ok: false,
      code: "invalid_actor"
    });
    expect(await svc.append("auth.login", { target: "document:abc-123" })).toMatchObject({
      ok: true
    });
    expect(store.rows.length).toBe(1);
  });

  it("rate-limits per (organization, action) and denies after the burst", async () => {
    const { svc, store, advance } = makeAudit({ limit: 2, windowSec: 60 });
    expect((await svc.append("export.created", { organizationId: "org-a" })).ok).toBe(true);
    expect((await svc.append("export.created", { organizationId: "org-a" })).ok).toBe(true);
    const denied = await svc.append("export.created", { organizationId: "org-a" });
    expect(denied).toMatchObject({ ok: false, code: "rate_limited", retryable: true });
    expect(store.rows.length).toBe(2);
    // separate buckets keep flowing: other org, other action, platform subject
    expect((await svc.append("export.created", { organizationId: "org-b" })).ok).toBe(true);
    expect((await svc.append("document.deleted", { organizationId: "org-a" })).ok).toBe(true);
    expect((await svc.append("auth.login")).ok).toBe(true);
    // one full window later the bucket has refilled
    advance(60_000);
    expect((await svc.append("export.created", { organizationId: "org-a" })).ok).toBe(true);
    expect(store.rows.length).toBe(6);
  });

  it("maps a failed insert to a typed envelope (no throw)", async () => {
    const { svc, store } = makeAudit();
    store.failInsert = true;
    const res = await svc.append("auth.login");
    expect(res).toMatchObject({ ok: false, code: "storage_unavailable", retryable: true });
  });

  it("refuses to construct with an invalid rate policy (fail fast)", () => {
    expect(
      () =>
        new AuditService({
          store: new FakeAuditStore(),
          appendRate: { limit: 0, windowSec: 10 }
        })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Audit: export (§22 — per-workspace, cursor-paged)
// ---------------------------------------------------------------------------

describe("AuditService.export (§22 exportable per workspace)", () => {
  async function seedFive(h: AuditHarness): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const res = await h.svc.append("document.deleted", {
        organizationId: "org-a",
        target: `document:d${i}`
      });
      expect(res.ok).toBe(true);
      h.advance(1_000);
    }
    const other = await h.svc.append("document.deleted", {
      organizationId: "org-b",
      target: "document:other-org"
    });
    expect(other.ok).toBe(true);
  }

  it("pages newest-first with cursors and never repeats a row", async () => {
    const h = makeAudit();
    await seedFive(h);

    const pages: AuditExportRow[][] = [];
    const cursors: (string | undefined)[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = await h.svc.export("org-a", { limit: 2, cursor });
      if (!page.ok) {
        throw new Error("export failed");
      }
      pages.push([...page.rows]);
      cursors.push(page.nextCursor);
      cursor = page.nextCursor;
    }

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(cursors[0]).toBeDefined();
    expect(cursors[1]).toBeDefined();
    expect(cursors[2]).toBeUndefined();
    expect(pages.flat().map((row) => row.target)).toEqual([
      "document:d4",
      "document:d3",
      "document:d2",
      "document:d1",
      "document:d0"
    ]);
    // org scoping: the other workspace never leaks into this export
    expect(pages.flat().every((row) => row.organization_id === "org-a")).toBe(true);
    const first = pages[0]?.[0];
    expect(first?.created_at).toBe(new Date(T0 + 4_000).toISOString());
  });

  it("honors inclusive from/to window bounds", async () => {
    const h = makeAudit();
    await seedFive(h);
    const page = await h.svc.export("org-a", {
      from: new Date(T0 + 1_000),
      to: new Date(T0 + 3_000)
    });
    if (!page.ok) {
      throw new Error("export failed");
    }
    expect(page.rows.map((row) => row.target)).toEqual([
      "document:d3",
      "document:d2",
      "document:d1"
    ]);
  });

  it("validates org, window and cursor inputs", async () => {
    const h = makeAudit();
    await seedFive(h);
    expect(await h.svc.export("")).toMatchObject({ ok: false, code: "invalid_org" });
    expect(
      await h.svc.export("org-a", { from: new Date(T0 + 2_000), to: new Date(T0 + 1_000) })
    ).toMatchObject({ ok: false, code: "invalid_window" });
    expect(await h.svc.export("org-a", { cursor: "!!!not-a-cursor!!!" })).toMatchObject({
      ok: false,
      code: "invalid_cursor",
      retryable: false
    });
    const wrongShape = Buffer.from(JSON.stringify({ v: 2 })).toString("base64url");
    expect(await h.svc.export("org-a", { cursor: wrongShape })).toMatchObject({
      ok: false,
      code: "invalid_cursor"
    });
  });

  it("clamps the page size and asks the store for limit+1", async () => {
    const h = makeAudit();
    await seedFive(h);
    const zero = await h.svc.export("org-a", { limit: 0 });
    expect(zero.ok).toBe(true);
    expect(h.store.pageLimits.at(-1)).toBe(2); // 0 clamps to 1, +1 lookahead
    const huge = await h.svc.export("org-a", { limit: 9_999 });
    expect(huge.ok).toBe(true);
    expect(h.store.pageLimits.at(-1)).toBe(501); // 500 cap, +1 lookahead
    const def = await h.svc.export("org-a");
    expect(def.ok).toBe(true);
    expect(h.store.pageLimits.at(-1)).toBe(101); // default 100, +1 lookahead
  });

  it("maps a failed page query to a typed envelope", async () => {
    const h = makeAudit();
    h.store.failPage = true;
    expect(await h.svc.export("org-a")).toMatchObject({
      ok: false,
      code: "storage_unavailable",
      retryable: true
    });
  });
});
