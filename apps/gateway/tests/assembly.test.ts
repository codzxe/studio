// Gateway assembly tests (W4-R) — the composition root end-to-end.
//
// Boots buildApp with the REAL middleware stack + rate-limit presets and the
// REAL route groups, faking only the service seams (stores/ledger/bus store).
// Every mounted path answers (401 without auth, 200 with fake auth for GETs,
// health 200), /v1/openapi.json serves, rate-limit headers are present and the
// 100/min global bucket denies the 101st request. Deterministic, no network:
// postgres pools are lazy and DB-touching handlers are never invoked.
//
// Vitest + app.request() (AGENTS.md: <5 s units, no network). The 401-code
// reconciliation is asserted verbatim: uploads answers W4-B's `unauthenticated`
// while the group-owned gates answer the catalog spelling `unauthorized` — see
// the note in src/types.ts.

import { describe, expect, it } from "vitest";
import pino from "pino";
import type { Hono } from "hono";
import { RunEventBus } from "@studio/agent";
import { ok, parseGatewayEnv, type Result } from "@studio/config";
import type { Asset } from "@studio/db";
import type { LedgerStore, TrialGrantOutcome } from "@studio/billing";
import { billingFromLedger } from "../src/services/runs.js";
import type { RunsStore } from "../src/services/runs.js";
import { InMemoryKV, RateLimiter } from "../src/services/limiter.js";
import type { DbLike } from "../src/services/workspaces.js";
import type { DocumentsStore, StorageLike } from "../src/services/documents.js";
import type { EventStoreLike, StoredEventAppend } from "../src/services/event-store.js";
import type { AssetsService } from "../src/services/assets.js";
import { DEFAULT_UPLOAD_LIMITS } from "../src/services/assets.js";
import type { AuthProvider, SessionContext } from "../src/middleware/auth-context.js";
import {
  buildApp,
  createDefaultDeps,
  runCancelEvents,
  sessionAuthAdapters,
  type AppDeps,
} from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import { stubProbes } from "../src/routes/health.js";
import type { RunEventsDeps } from "../src/routes/runs-events.js";
import type { AppEnv } from "../src/types.js";

// --- constants -------------------------------------------------------------

const ORG = "org-assembly";
const USER = "user-assembly";
const TOKEN_EDITOR = "tok-editor";
const TOKEN_VIEWER = "tok-viewer";
const RUN_ID = "run-assembly-1";
const BASE_MS = 1_700_000_000_000;
const silentLogger = pino({ enabled: false });

function session(role: "editor" | "viewer"): SessionContext {
  return { userId: USER, organizationId: ORG, role, permissions: [] };
}

/** Fake AuthProvider: bearer-token map, cookie sessions resolve null. */
class MapAuthProvider implements AuthProvider {
  readonly #byBearer = new Map<string, SessionContext>([
    [TOKEN_EDITOR, session("editor")],
    [TOKEN_VIEWER, session("viewer")],
  ]);
  async getSession(): Promise<SessionContext | null> {
    return null;
  }
  async verifyApiKey(request: Request): Promise<SessionContext | null> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    return token === null ? null : (this.#byBearer.get(token) ?? null);
  }
}

// --- fakes -----------------------------------------------------------------

class FakeLedger implements LedgerStore {
  readonly entries: {
    organizationId: string;
    delta: number;
    kind: string;
    idempotencyKey: string;
  }[] = [];
  async append(entry: {
    organizationId: string;
    delta: number;
    kind: string;
    idempotencyKey: string;
  }): Promise<void> {
    this.entries.push(entry);
  }
  async balanceAfter(): Promise<number> {
    return this.entries.reduce((sum, entry) => sum + entry.delta, 0);
  }
  async findByIdempotency(idempotencyKey: string): Promise<boolean> {
    return this.entries.some((entry) => entry.idempotencyKey === idempotencyKey);
  }
}

/** Minimal RunsStore: the list page only — row shapes stay in W4-G's suite. */
const fakeRunsStore: RunsStore = {
  async findDocument() {
    return null;
  },
  async findByIdempotency() {
    return null;
  },
  async insertRun() {
    throw new Error("unused by the assembly suite");
  },
  async getRun() {
    return null;
  },
  async listRuns() {
    return { rows: [] };
  },
  async listSteps() {
    return [];
  },
  async transitionStatus() {
    return null;
  },
};

/** In-memory durable event store (the W2-P EventStoreLike shape). */
class FakeEventStore implements EventStoreLike {
  readonly rows = new Map<string, StoredEventAppend[]>();
  async append(runId: string, row: StoredEventAppend): Promise<void> {
    const list = this.rows.get(runId) ?? [];
    list.push(row);
    this.rows.set(runId, list);
  }
  async sinceSeq(runId: string, afterSeq: number): Promise<readonly StoredEventAppend[]> {
    return (this.rows.get(runId) ?? []).filter((row) => row.seq > afterSeq);
  }
  async maxSeq(runId: string): Promise<number> {
    const list = this.rows.get(runId) ?? [];
    return list.reduce((max, row) => Math.max(max, row.seq), 0);
  }
}

const fakeDocumentsStorage: StorageLike = {
  async get(): Promise<Uint8Array | null> {
    return null;
  },
  async put(): Promise<unknown> {
    return {};
  },
};

// One documented test-side cast each: partial stores stand in for the drizzle
// implementations (list paths only) — the fleet pattern from runs-events tests.
const fakeWorkspacesDb = {
  listWorkspacesForUser: async () => [],
} as unknown as DbLike;
const fakeDocumentsStore = {
  selectDocumentsPage: async () => [],
} as unknown as DocumentsStore;

/** Fake assets service: register + list answer; the rest fail closed. */
const fakeAssetsService: AssetsService = {
  async registerUpload() {
    return ok({
      asset: {
        id: "asset-1",
        kind: "image",
        bytes: 70,
        width: 1,
        height: 1,
        mime: "image/png",
        checksum: "deadbeef",
      } as unknown as Asset,
      duplicate: false,
    });
  },
  async list() {
    return ok({ assets: [], nextCursor: undefined });
  },
  async getSigned(): Promise<Result<never>> {
    throw new Error("unused by the assembly suite");
  },
  async remove(): Promise<Result<never>> {
    throw new Error("unused by the assembly suite");
  },
};

// --- harness ---------------------------------------------------------------

interface Harness {
  readonly app: Hono<AppEnv>;
  readonly eventStore: FakeEventStore;
  readonly bus: RunEventBus;
}

function makeHarness(provider: AuthProvider = new MapAuthProvider()): Harness {
  const eventStore = new FakeEventStore();
  const bus = new RunEventBus({ store: eventStore });
  const adapters = sessionAuthAdapters(provider, async () => "starter");
  const deps: AppDeps = {
    env: gatewayTransportSchema.parse({}),
    logger: silentLogger,
    version: "0.0.0-assembly",
    probes: stubProbes(),
    startedAt: BASE_MS,
    limiter: new RateLimiter({ kv: new InMemoryKV() }),
    workspacesDeps: {
      db: fakeWorkspacesDb,
      billing: {
        async grantTrial(organizationId): Promise<Result<TrialGrantOutcome>> {
          return ok({ organizationId, granted: true, credits: 30, duplicate: false });
        },
      },
      audit: { append: async () => undefined },
      auth: adapters.workspaces,
    },
    documentsDeps: {
      store: fakeDocumentsStore,
      storage: fakeDocumentsStorage,
      templates: { get: async () => undefined },
      now: () => new Date(BASE_MS),
      newId: () => "doc-assembly-1",
      auth: adapters.documents,
    },
    runsDeps: {
      auth: adapters.runs,
      billing: billingFromLedger(new FakeLedger()),
      store: fakeRunsStore,
      enqueue: { enqueue: async () => ok({ jobId: "job-1" }) },
      events: runCancelEvents(bus),
    },
    runEventsDeps: {
      auth: adapters.runEvents,
      runLookup: { findRun: async () => ({ organizationId: ORG }) },
      bus,
      heartbeatMs: 100,
    } satisfies RunEventsDeps,
    uploadsDeps: { service: fakeAssetsService, limits: DEFAULT_UPLOAD_LIMITS },
  };
  return { app: buildApp(deps), eventStore, bus };
}

const authed = { authorization: `Bearer ${TOKEN_EDITOR}` };
const viewerAuthed = { authorization: `Bearer ${TOKEN_VIEWER}` };

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// --- the suite -------------------------------------------------------------

describe("assembly: boots and serves health + openapi (W4-R)", () => {
  it("GET /v1/health answers 200 with the version", async () => {
    const { app } = makeHarness();
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gateway");
    expect(body.version).toBe("0.0.0-assembly");
  });

  it("health responses are not rate-limited (probe skip list)", async () => {
    const { app } = makeHarness();
    const res = await app.request("/v1/health");
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
  });

  it("GET /v1/openapi.json serves the mounted surface", async () => {
    const { app } = makeHarness();
    const res = await app.request("/v1/openapi.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.version).toBe("0.0.0-assembly");
    const paths = Object.keys(body.paths);
    for (const expected of [
      "/health",
      "/health/deep",
      "/workspaces",
      "/invites/{token}",
      "/documents",
      "/documents/{id}/versions",
      "/runs",
      "/runs/{id}",
      "/runs/{id}/cancel",
      "/runs/{id}/events",
      "/uploads",
      "/assets",
      "/assets/{id}",
    ]) {
      expect(paths).toContain(expected);
    }
  });
});

describe("assembly: every mounted path answers (401 without auth / 200 with)", () => {
  it("GET /v1/workspaces → 401 `unauthorized` without a session, 200 with one", async () => {
    const { app } = makeHarness();
    const denied = await app.request("/v1/workspaces");
    expect(denied.status).toBe(401);
    expect((await json(denied)).code).toBe("unauthorized");

    const res = await app.request("/v1/workspaces", { headers: authed });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.workspaces).toEqual([]);
  });

  it("GET /v1/documents → 401 without, 200 empty page with a session", async () => {
    const { app } = makeHarness();
    const denied = await app.request("/v1/documents");
    expect(denied.status).toBe(401);
    expect((await json(denied)).code).toBe("unauthorized");

    const res = await app.request("/v1/documents", { headers: authed });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.documents).toEqual([]);
  });

  it("GET /v1/runs → 401 without, 200 empty page with a session", async () => {
    const { app } = makeHarness();
    const denied = await app.request("/v1/runs");
    expect(denied.status).toBe(401);
    expect((await json(denied)).code).toBe("unauthorized");

    const res = await app.request("/v1/runs", { headers: authed });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.runs).toEqual([]);
  });

  it("POST /v1/runs is gated before any billing/enqueue work", async () => {
    const { app } = makeHarness();
    const denied = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);
  });

  it("GET /v1/runs/:id/events → 401 without, SSE 200 + terminal close with auth", async () => {
    const { app, bus } = makeHarness();
    const denied = await app.request(`/v1/runs/${RUN_ID}/events`);
    expect(denied.status).toBe(401);
    expect((await json(denied)).code).toBe("unauthorized");

    // Pre-publish the terminal event: backfill delivers it, the pump closes.
    await bus.publish(RUN_ID, "run.succeeded", { revisionAfter: 1, warnings: [] }, {
      organizationId: ORG,
    });
    const res = await app.request(`/v1/runs/${RUN_ID}/events`, { headers: authed });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: run.succeeded");
  });

  it("GET /v1/assets → 401 `unauthenticated` (the W4-B gate) without a session", async () => {
    const { app } = makeHarness();
    const denied = await app.request("/v1/assets");
    expect(denied.status).toBe(401);
    // 401-code reconciliation, asserted verbatim (src/types.ts note): the
    // uploads group mounts W4-B requireAuth — `unauthenticated` — while the
    // group-owned gates above answer the catalog spelling `unauthorized`.
    const body = await json(denied);
    expect(body.code).toBe("unauthenticated");
    expect(body.ok).toBe(false);
  });

  it("GET /v1/assets → 200 with a session; POST /v1/uploads works for editors", async () => {
    const { app } = makeHarness();
    const res = await app.request("/v1/assets", { headers: authed });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.assets).toEqual([]);

    // A real 1×1 PNG through the REAL validate gates (magic bytes, §20.2).
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (char) => char.charCodeAt(0),
    );
    const form = new FormData();
    form.append("file", new File([png], "px.png", { type: "image/png" }));
    const uploaded = await app.request("/v1/uploads", { method: "POST", headers: authed, body: form });
    expect(uploaded.status).toBe(201);
    const uploadBody = await json(uploaded);
    expect(uploadBody.ok).toBe(true);
    expect(uploadBody.duplicate).toBe(false);
  });

  it("POST /v1/uploads → 403 for viewers (role flows through the auth context)", async () => {
    const { app } = makeHarness();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }));
    const res = await app.request("/v1/uploads", { method: "POST", headers: viewerAuthed, body: form });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("forbidden");
  });

  it("unmounted §13.1 paths still answer the typed 501 (routes/index.ts catch-all)", async () => {
    const { app } = makeHarness();
    const res = await app.request("/v1/templates");
    expect(res.status).toBe(501);
    expect((await json(res)).code).toBe("not_implemented");
  });
});

describe("assembly: rate-limit presets (§1.5 rule 5 / §15.2)", () => {
  it("authenticated responses carry the 600/min org-preset headers", async () => {
    const { app } = makeHarness();
    const res = await app.request("/v1/workspaces", { headers: authed });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("600");
    expect(res.headers.get("x-ratelimit-remaining")).not.toBeNull();
  });

  it("the global 100/min IP preset denies request 101 with a typed 429", async () => {
    const { app } = makeHarness();
    let last: Response | undefined;
    for (let i = 0; i < 101; i += 1) {
      last = await app.request("/v1/workspaces");
    }
    expect(last).toBeDefined();
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).not.toBeNull();
    expect(last?.headers.get("x-ratelimit-limit")).toBe("100");
    const body = last ? await json(last) : undefined;
    expect(body?.code).toBe("rate_limited");
    expect(body?.ok).toBe(false);
  });
});

describe("assembly: default wiring (createDefaultDeps, §4 fail-fast)", () => {
  function fakeGatewayEnvSource(): Record<string, string> {
    return {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://gateway:pw@127.0.0.1:5432/studio",
      VALKEY_URL: "valkey://127.0.0.1:6379",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_BUCKET: "studio",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "assemblykey",
      S3_SECRET_ACCESS_KEY: "assemblysecret",
      AUTH_SECRET: "a".repeat(32),
      STRIPE_SECRET_KEY: "sk_test_assembly",
      STRIPE_WEBHOOK_SECRET: "whsec_assembly",
      APP_URL: "http://127.0.0.1:3000",
    };
  }

  const localStorageEnv = {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: "/tmp/gateway-assembly-probe",
    STORAGE_SIGNING_SECRET: "0123456789abcdef",
    STORAGE_PUBLIC_BASE_URL: "http://127.0.0.1:8787",
  };

  it("boots the full DI graph without touching the network (lazy pools)", async () => {
    const env = parseGatewayEnv(fakeGatewayEnvSource());
    const gateway = createDefaultDeps(env, {
      storageEnv: localStorageEnv,
      overrides: { auth: new MapAuthProvider() },
    });
    const app = buildApp({
      ...gateway,
      env: gatewayTransportSchema.parse({}),
      logger: silentLogger,
      version: "0.0.0-defaults",
      startedAt: BASE_MS,
    });

    const health = await app.request("/v1/health");
    expect(health.status).toBe(200);

    // Runs group mounted with default seams: 401 before any ledger/db work.
    const denied = await app.request("/v1/runs");
    expect(denied.status).toBe(401);

    // Uploads mounted, AssetsStore seam absent → the router's typed 503.
    const uploads = await app.request("/v1/assets", { headers: authed });
    expect(uploads.status).toBe(503);
    expect((await json(uploads)).code).toBe("service_unavailable");

    const spec = await app.request("/v1/openapi.json");
    expect(spec.status).toBe(200);
    expect(Object.keys(((await spec.json()) as { paths: Record<string, unknown> }).paths)).toContain(
      "/runs/{id}/events",
    );
  });

  it("fails fast on an unusable storage driver (§4, no silent default)", () => {
    const env = parseGatewayEnv(fakeGatewayEnvSource());
    expect(() =>
      createDefaultDeps(env, { storageEnv: { STORAGE_DRIVER: "minio" } }),
    ).toThrowError(/storage/i);
  });
});
