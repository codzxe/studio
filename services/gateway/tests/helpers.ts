// W3-gw — shared test harness for the gateway suite.
//
// Two boot modes:
//   * stubDeps()   — buildApp with in-memory fakes (app.test.ts); no Postgres.
//   * bootServer() — a REAL HTTP server on an ephemeral port wired to real
//     Postgres + Better Auth + the MockRunner (integration tests). Those files
//     `describe.skipIf(!process.env.DATABASE_URL)`.
//
// Env note: the gateway reads DATABASE_URL from the PROCESS ENV only (fleet
// convention) — pass it explicitly when running vitest:
//   DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio MOCK_MODEL=true \
//     pnpm --filter @studio/gateway test

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ServerType, serve } from "@hono/node-server";
import { type StudioEnv, parseEnv } from "@studio/config";
import { type Repos, createAuth, createDb, createRepos } from "@studio/db";
import type { Page } from "@studio/db";

import { buildApp } from "../src/app.js";
import { type GatewayAuth, adaptBetterAuth } from "../src/auth.js";
import { type GatewayDeps, createInMemoryChatReplayStore } from "../src/context.js";
import { createInMemoryIdempotencyStore } from "../src/idempotency.js";
import { nullLogger } from "../src/logger.js";
import { createInMemoryRateLimiter } from "../src/rate-limit.js";
import { type AgentRunner, RunRegistry, createMockRunner } from "../src/runner.js";
import { LocalFSDriver } from "../src/storage.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** The origin browsers/the SPA would send — must be APP_URL (trusted origin). */
export const TEST_APP_ORIGIN = "http://localhost:3000";

/** The sandbox's portable dev Postgres (scripts/dev-postgres.sh). */
const SANDBOX_DATABASE_URL = "postgres://studio:studio@127.0.0.1:5432/studio";

/**
 * The gateway reads DATABASE_URL from the process env only — but the agent
 * sandbox may carry an unrelated DATABASE_URL (e.g. "file:…"), so: use an
 * explicitly passed postgres:// URL when present, else fall back to the
 * sandbox dev Postgres when it is reachable, else null (tests skip).
 */
export function resolveDatabaseUrl(): string | null {
  const raw = process.env.DATABASE_URL ?? "";
  if (/^postgres(ql)?:\/\//.test(raw)) return raw;
  try {
    execSync('timeout 1 bash -c "echo > /dev/tcp/127.0.0.1/5432"', { stdio: "ignore" });
    return SANDBOX_DATABASE_URL;
  } catch {
    return null;
  }
}

export const DATABASE_URL: string | null = resolveDatabaseUrl();
export const HAS_DATABASE = DATABASE_URL !== null;
export const INTEGRATION_SKIP = DATABASE_URL === null;

export interface EnvOverrides {
  readonly [key: string]: string | undefined;
}

/** A complete env source: required vars filled with test-safe values. */
export function testEnvSource(overrides: EnvOverrides = {}): EnvOverrides {
  const base: Record<string, string> = {
    APP_URL: TEST_APP_ORIGIN,
    APP_ENV: "local",
    LOG_LEVEL: "error",
    MOCK_MODEL: "true",
    DATABASE_URL: DATABASE_URL ?? SANDBOX_DATABASE_URL,
    ASSET_MAX_BYTES: "10485760",
    PROJECT_MAX_BYTES: "20971520",
    STRIPE_WEBHOOK_SECRET: "whsec_test_not_configured",
    STRIPE_PRICE_IDS: '{"starter":"price_test","pro":"price_test","studio":"price_test"}',
    AUTH_SECRET: "test-secret-test-secret-test-secret-32",
    AUTH_GOOGLE_ID: "disabled",
    AUTH_GOOGLE_SECRET: "disabled",
    AUTH_GITHUB_ID: "disabled",
    AUTH_GITHUB_SECRET: "disabled",
    LITELLM_BASE_URL: "http://127.0.0.1:4000",
    LITELLM_API_KEY: "sk-test-not-configured",
    CHAT_MAX_STEPS: "20",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    base[key] = value;
  }
  return base;
}

/** Parsed typed env for deps wiring. */
export function testEnv(overrides: EnvOverrides = {}): StudioEnv {
  return parseEnv(testEnvSource(overrides));
}

// ---------------------------------------------------------------------------
// Unique ids (each run gets fresh users/workspaces/projects in the shared DB)
// ---------------------------------------------------------------------------

let counter = 0;

/** Unique-per-run suffix (safe in slugs + emails). */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function uniqueEmail(prefix = "user"): string {
  return `${unique(prefix)}@w3gw.test`;
}

// ---------------------------------------------------------------------------
// HTTP helpers (Origin + cookie jar — mirrors a real browser session)
// ---------------------------------------------------------------------------

export class CookieJar {
  private readonly store = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      if (pair === undefined) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.store.delete(name);
      else this.store.set(name, value);
    }
  }

  get header(): string {
    return [...this.store.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export interface JsonRequestInit {
  readonly method?: string;
  readonly jar?: CookieJar;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: BodyInit;
}

/**
 * fetch with the trusted Origin header and a cookie jar. better-auth requires
 * Origin on cookie-bearing POSTs (CSRF), exactly like a browser.
 */
export async function api(
  base: string,
  path: string,
  init: JsonRequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: TEST_APP_ORIGIN,
    ...init.headers,
  };
  const jar = init.jar;
  if (jar !== undefined && jar.header !== "") headers.cookie = jar.header;
  const method = init.method ?? "GET";
  let body: BodyInit | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  } else if (method !== "GET" && method !== "HEAD") {
    body = "{}";
  }
  const response = await fetch(`${base}${path}`, { method, headers, body, redirect: "manual" });
  jar?.absorb(response);
  return response;
}

/** Parse a response as the §7.3 envelope; throws with the body if not JSON. */
export async function envelope(response: Response): Promise<{
  status: number;
  requestId: string;
  ok?: Record<string, unknown>;
  err?: { code: string; message: string; hint?: string; retryable: boolean; requestId: string };
}> {
  const requestId = response.headers.get("x-request-id") ?? "";
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
  const record = parsed as Record<string, unknown>;
  if ("error" in record) {
    const error = record.error as Record<string, unknown>;
    return {
      status: response.status,
      requestId,
      err: {
        code: String(error.code),
        message: String(error.message),
        hint: error.hint === undefined ? undefined : String(error.hint),
        retryable: Boolean(error.retryable),
        requestId: String(error.requestId),
      },
    };
  }
  return { status: response.status, requestId, ok: record as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export interface SseEvent {
  readonly id: number;
  readonly data: Record<string, unknown>;
}

/** Reads an SSE body to completion and returns ordered parsed events. */
export async function readSse(response: Response): Promise<SseEvent[]> {
  const body = response.body;
  if (body === null) throw new Error("no SSE body");
  const text = await new Response(body).text();
  const events: SseEvent[] = [];
  for (const frame of text.split("\n\n")) {
    let id: number | null = null;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = Number.parseInt(line.slice(3).trim(), 10);
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    events.push({
      id: id ?? -1,
      data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Stub deps (no Postgres) — in-memory auth + repos fakes
// ---------------------------------------------------------------------------

interface FakeUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly token: string;
}

interface FakeOrg {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
  readonly members: Map<string, string>; // userId → role
}

export class FakeGatewayAuth implements GatewayAuth {
  readonly users = new Map<string, FakeUser>();
  readonly orgs = new Map<string, FakeOrg>();
  private nextId = 0;
  readonly inviteLog: readonly { organizationId: string; email: string; role: string }[] = [];
  private readonly inviteLogMut: { organizationId: string; email: string; role: string }[] = [];
  slugTaken = new Set<string>();

  /** Registers a user; returns the bearer token tests send as a cookie. */
  signUp(role: "owner" | "editor" | "viewer" = "owner"): { user: FakeUser; org: FakeOrg } {
    this.nextId += 1;
    const user: FakeUser = {
      id: `fake_user_${this.nextId}`,
      name: `Fake ${this.nextId}`,
      email: `fake${this.nextId}@w3gw.test`,
      token: `fake-session-token-${this.nextId}`,
    };
    this.users.set(user.token, user);
    const org: FakeOrg = {
      id: `fake_org_${this.nextId}`,
      name: `Fake Org ${this.nextId}`,
      slug: `fake-org-${this.nextId}`,
      createdAt: new Date().toISOString(),
      members: new Map([[user.id, role]]),
    };
    this.orgs.set(org.id, org);
    return { user, org };
  }

  private sessionFrom(headers: Headers): FakeUser | null {
    const cookie = headers.get("cookie") ?? "";
    const match = /fake-session-token-(\d+)/.exec(cookie);
    if (match === null) return null;
    return this.users.get(`fake-session-token-${match[1]}`) ?? null;
  }

  handler = async (): Promise<Response> => new Response('{"ok":true}', { status: 200 });

  async getSession(headers: Headers) {
    const user = this.sessionFrom(headers);
    if (user === null) return null;
    return {
      user: { id: user.id, name: user.name, email: user.email },
      session: { id: `sess_${user.id}`, userId: user.id, activeOrganizationId: null },
    };
  }

  async listOrganizations(headers: Headers) {
    const user = this.sessionFrom(headers);
    if (user === null) return [];
    return [...this.orgs.values()]
      .filter((org) => org.members.has(user.id))
      .map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        metadata: null,
      }));
  }

  async getFullWorkspace(headers: Headers, candidate: string) {
    const user = this.sessionFrom(headers);
    if (user === null) return null;
    const org =
      this.orgs.get(candidate) ??
      [...this.orgs.values()].find((entry) => entry.slug === candidate) ??
      null;
    if (org === null || !org.members.has(user.id)) return null;
    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        metadata: null,
      },
      members: [...org.members.entries()].map(([userId, role]) => ({
        userId,
        role,
        userName:
          this.users.get(`fake-session-token-${userId.replace("fake_user_", "")}`)?.name ?? userId,
        userEmail: null,
      })),
    };
  }

  async createWorkspace(headers: Headers, body: { name: string; slug: string }) {
    const user = this.sessionFrom(headers);
    if (user === null) throw new Error("no session");
    const org: FakeOrg = {
      id: `fake_org_${this.nextId + 1}`,
      name: body.name,
      slug: body.slug,
      createdAt: new Date().toISOString(),
      members: new Map([[user.id, "owner"]]),
    };
    this.nextId += 1;
    this.orgs.set(org.id, org);
    return { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt, metadata: null };
  }

  async updateWorkspace(
    headers: Headers,
    body: { organizationId: string; data: { name?: string; slug?: string } },
  ) {
    const org = this.orgs.get(body.organizationId);
    if (org === undefined) throw new Error("org missing");
    return {
      id: org.id,
      name: body.data.name ?? org.name,
      slug: body.data.slug ?? org.slug,
      createdAt: org.createdAt,
      metadata: null,
    };
  }

  async inviteMember(
    _headers: Headers,
    body: { organizationId: string; email: string; role: string },
  ) {
    this.inviteLogMut.push({
      organizationId: body.organizationId,
      email: body.email,
      role: body.role,
    });
    return {
      id: `fake_invite_${this.inviteLogMut.length}`,
      organizationId: body.organizationId,
      email: body.email,
      role: body.role,
      status: "pending",
      expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    };
  }

  async acceptInvitation(_headers: Headers, invitationId: string) {
    const entry =
      this.inviteLogMut[Number.parseInt(invitationId.replace("fake_invite_", ""), 10) - 1];
    return {
      inviteId: invitationId,
      organizationId: entry?.organizationId ?? "",
      role: entry?.role ?? "viewer",
    };
  }

  async checkSlug(_headers: Headers, slug: string) {
    const taken =
      this.slugTaken.has(slug) || [...this.orgs.values()].some((org) => org.slug === slug);
    return { available: !taken };
  }
}

/** Records calls per method name, e.g. "projects.create". */
export interface RepoCalls {
  [method: string]: number;
}

interface ProjectRow {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  thumbnailUrl: string | null;
  currentVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * In-memory repos for the stub suite: only the surface the tested routes use
 * is implemented; anything else throws so a route drift is loud, not silent.
 */
export function fakeRepos(auth: FakeGatewayAuth): { repos: Repos; calls: RepoCalls } {
  const calls: RepoCalls = {};
  const projects = new Map<string, ProjectRow>();
  const ledgerEntries: { kind: string; amount: number }[] = [];
  let balance = 0;

  function record(name: string): void {
    calls[name] = (calls[name] ?? 0) + 1;
  }

  const repos = {
    projects: {
      create(workspaceId: string, input: { name: string; createdBy: string }) {
        record("projects.create");
        const row: ProjectRow = {
          id: `prj_fake_${projects.size + 1}`,
          workspaceId,
          name: input.name,
          slug: input.name.toLowerCase().replace(/\s+/g, "-"),
          thumbnailUrl: null,
          currentVersionId: null,
          createdBy: input.createdBy,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        projects.set(row.id, row);
        return row;
      },
      list(workspaceId: string, _options?: unknown) {
        record("projects.list");
        const items = [...projects.values()].filter(
          (p) => p.workspaceId === workspaceId && p.deletedAt === null,
        );
        return { items, nextCursor: null } satisfies Page<unknown> as never;
      },
      get(_workspaceId: string, projectId: string) {
        record("projects.get");
        const row = projects.get(projectId);
        if (row === undefined || row.deletedAt !== null) throw new Error("project not found");
        return row;
      },
      manifest(_workspaceId: string, projectId: string) {
        record("projects.manifest");
        const project = projects.get(projectId);
        if (project === undefined) throw new Error("project not found");
        return { project, currentVersion: null, assets: [] };
      },
    },
    versions: {
      list() {
        record("versions.list");
        return { items: [], nextCursor: null };
      },
    },
    leases: {
      acquire() {
        record("leases.acquire");
        return {
          acquired: true,
          holderId: "fake_user_1",
          expiresAt: new Date(Date.now() + 300_000),
        };
      },
      release() {
        record("leases.release");
        return { released: true };
      },
    },
    threads: {
      get() {
        record("threads.get");
        throw new Error("threads.get not faked");
      },
      create() {
        record("threads.create");
        throw new Error("threads.create not faked");
      },
    },
    runs: {
      create() {
        record("runs.create");
        throw new Error("runs.create not faked");
      },
    },
    ledger: {
      async balance() {
        record("ledger.balance");
        return balance;
      },
      async list() {
        record("ledger.list");
        return { items: [], nextCursor: null } satisfies Page<unknown> as never;
      },
      async grant(workspaceId: string, input: { amount: number }) {
        record("ledger.grant");
        balance += input.amount;
        ledgerEntries.push({ kind: "grant", amount: input.amount });
        return { entry: { id: `led_${ledgerEntries.length}`, workspaceId }, replayed: false };
      },
    },
    audit: {
      async append() {
        record("audit.append");
        return {
          id: "aud_fake",
          workspaceId: "fake",
          actorId: null,
          action: "",
          targetType: "",
          targetId: null,
          metadata: null,
          createdAt: new Date(),
        };
      },
    },
  } as unknown as Repos;

  void auth;
  return { repos, calls };
}

/** A permissive limiter for the stub suite (rate limiting is tested directly). */
export function unlimitedLimiter() {
  return {
    check: () => ({ allowed: true, retryAfterSeconds: 0 }),
    reset: () => {},
  };
}

export interface TmpDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTmpDir(prefix = "w3gw-"): TmpDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Stub deps: everything in-memory; no Postgres required. */
export function stubDeps(
  env: StudioEnv,
  options: { auth?: FakeGatewayAuth; repos?: Repos } = {},
): GatewayDeps & {
  limiter: GatewayDeps["limiter"];
  dbHealth: GatewayDeps["dbHealth"];
} {
  const auth = options.auth ?? new FakeGatewayAuth();
  const localDriver = new LocalFSDriver(join(tmpdir(), unique("w3gw-store")), TEST_APP_ORIGIN);
  const runner: AgentRunner = createMockRunner();
  return {
    env,
    auth,
    repos: options.repos ?? fakeRepos(auth).repos,
    storage: localDriver,
    local: localDriver,
    runner,
    runs: new RunRegistry(),
    limiter: createInMemoryRateLimiter(),
    idempotency: createInMemoryIdempotencyStore(),
    chatReplay: createInMemoryChatReplayStore(),
    logger: nullLogger,
    stripe: null,
    version: "0.0.0-test",
    dbHealth: async () => true,
  };
}

// ---------------------------------------------------------------------------
// Integration server (real Postgres + Better Auth + MockRunner)
// ---------------------------------------------------------------------------

export interface RunningTestServer {
  readonly base: string;
  readonly port: number;
  readonly deps: GatewayDeps;
  close(): Promise<void>;
}

export interface ServerOptions {
  /** Extra env overrides (e.g. a short LEASE_TTL_MS for the expiry test). */
  readonly env?: EnvOverrides;
  /** Custom runner (defaults to MockRunner). */
  readonly runner?: AgentRunner;
  /** Permissive rate limiter (default) or the real one. */
  readonly realLimiter?: boolean;
  /** dbHealth probe (default: real SELECT 1). */
  readonly dbHealth?: () => Promise<boolean>;
}

/**
 * Boots the full gateway against real Postgres on an ephemeral port.
 * Mirrors src/index.ts startServer without the process-level signal wiring.
 */
export async function bootServer(options: ServerOptions = {}): Promise<RunningTestServer> {
  if (DATABASE_URL === null) throw new Error("bootServer: no DATABASE_URL resolved");
  const env = testEnv(options.env);
  const db = createDb(DATABASE_URL, { max: 5 });
  const auth = adaptBetterAuth(
    createAuth({
      databaseUrl: env.db.url,
      appUrl: `${env.app.url.replace(/\/+$/, "")}/v1/auth`,
      secret: env.auth.secret,
      google: { clientId: env.auth.google.id, clientSecret: env.auth.google.secret },
      github: { clientId: env.auth.github.id, clientSecret: env.auth.github.secret },
      db,
    }),
  );
  const repos = createRepos(db);
  const localDriver = new LocalFSDriver(join(tmpdir(), unique("w3gw-int-store")), env.app.url);
  const deps: GatewayDeps = {
    env,
    auth,
    repos,
    storage: localDriver,
    local: localDriver,
    runner: options.runner ?? createMockRunner(),
    runs: new RunRegistry(),
    limiter: options.realLimiter === true ? createInMemoryRateLimiter() : unlimitedLimiter(),
    idempotency: createInMemoryIdempotencyStore(),
    chatReplay: createInMemoryChatReplayStore(),
    logger: nullLogger,
    stripe: null,
    version: "0.0.0-test",
    dbHealth: options.dbHealth ?? (async () => true),
  };
  const app = buildApp({ deps });
  const server = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ server: instance, port: info.port });
    });
    void instance;
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    port: server.port,
    deps,
    close: async () => {
      await new Promise<void>((resolveClose) => server.server.close(() => resolveClose()));
      try {
        await db.$client.end({ timeout: 5 });
      } catch {
        // already gone
      }
    },
  };
}
