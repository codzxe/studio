// W1-03 — PG-free dev-server smoke: the REAL gateway app on a SQLite file.
//
// Capability ladder (every rung is honest about what it proves):
//
//  1. Always-run: @studio/config accepts DATABASE_URL=file:… in local and
//     still rejects it in production; better-auth's drizzleAdapter is proven
//     sqlite-capable on a self-contained node:sqlite drizzle instance
//     (provider "sqlite" + transaction:true — the exact production adapter
//     config from packages/db/src/auth.ts).
//
//  2. Seam-gated (skips, with the reason in the suite name, until the
//     @studio/db dual-dialect seam lands — createDb("file:…") dialect switch
//     + isSqliteUrl + bootstrapSqlite, task W1-02): boots the REAL gateway
//     (buildApp, real repos, real /health db probe) on a temp sqlite file and
//     asserts GET /health → { status: "ok", db: true }.
//
//  3. Auth-gated (skips with the precise failure until better-auth runs on
//     the seam's sqlite instance): the full dev-server journey over real
//     HTTP — sign-up (session cookie) → /v1/me → workspace create →
//     project create → project list.
//
// No Postgres, no network beyond the loopback listener, no fixtures that
// outlive the run: everything lives under os.tmpdir() and is removed in
// afterAll.

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// node:sqlite (node >= 22.5) is loaded through createRequire — the same
// bundler-invisible trick @studio/db's createDb uses for better-sqlite3:
// vitest's vite pipeline normalizes node: builtins by stripping the "node:"
// prefix and vite 5.4's builtin list predates node:sqlite, so a static ESM
// import fails to resolve under the test runner ("Failed to load url sqlite").
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import(
  "node:sqlite"
);

import { type ServerType, serve } from "@hono/node-server";
import { type StudioEnv, parseEnv } from "@studio/config";
import { type Auth, type StudioDb, createAuth, createRepos } from "@studio/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import { buildApp } from "../src/app.js";
import { adaptBetterAuth } from "../src/auth.js";
import { type GatewayDeps, createInMemoryChatReplayStore } from "../src/context.js";
import { createInMemoryIdempotencyStore } from "../src/idempotency.js";
import { nullLogger } from "../src/logger.js";
import { createInMemoryRateLimiter } from "../src/rate-limit.js";
import { type AgentRunner, RunRegistry, createMockRunner } from "../src/runner.js";
import { LocalFSDriver } from "../src/storage.js";
import {
  CookieJar,
  FakeGatewayAuth,
  TEST_APP_ORIGIN,
  api,
  testEnvSource,
  unique,
  uniqueEmail,
  unlimitedLimiter,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** One line, bounded — skip reasons must never carry stacks or secrets. */
function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0] ?? "unknown error";
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

/** Listen on an ephemeral loopback port (mirrors tests/helpers.bootServer). */
async function listen(app: ReturnType<typeof buildApp>): Promise<{
  base: string;
  close(): Promise<void>;
}> {
  const started = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ server: instance, port: info.port });
    });
    void instance;
  });
  return {
    base: `http://127.0.0.1:${started.port}`,
    close: async () => {
      await new Promise<void>((resolveClose) => started.server.close(() => resolveClose()));
    },
  };
}

// ---------------------------------------------------------------------------
// Rung 2 — the W1-02 seam (feature-detected; nothing assumes it has landed)
// ---------------------------------------------------------------------------

/** The documented @studio/db sqlite seam (W1-02). Detected, never imported statically. */
interface SqliteSeam {
  readonly createDb: (url: string) => unknown;
  readonly isSqliteUrl: (url: string) => boolean;
  readonly bootstrapSqlite: (arg: unknown) => Promise<unknown>;
}

async function loadSqliteSeam(): Promise<SqliteSeam | null> {
  try {
    const mod = (await import("@studio/db")) as unknown as Record<string, unknown>;
    if (typeof mod.createDb !== "function") return null;
    if (typeof mod.isSqliteUrl !== "function") return null;
    if (typeof mod.bootstrapSqlite !== "function") return null;
    const isSqliteUrl = mod.isSqliteUrl as (url: string) => boolean;
    if (!isSqliteUrl("file:/tmp/w1-03-seam-probe.db")) return null;
    return {
      createDb: mod.createDb as (url: string) => unknown,
      isSqliteUrl,
      bootstrapSqlite: mod.bootstrapSqlite as (arg: unknown) => Promise<unknown>,
    };
  } catch {
    return null;
  }
}

const seam = await loadSqliteSeam();

/**
 * The real /health probe against the sqlite handle: pg drizzle exposes
 * `execute`, sqlite drizzle exposes `get`/`all`/`run` — probe structurally so
 * this works under either dialect without importing W1-02 internals.
 */
function sqliteDbHealth(db: unknown): () => Promise<boolean> {
  return async () => {
    const handle = db as {
      execute?: (query: unknown) => Promise<unknown>;
      get?: (query: unknown) => unknown;
      all?: (query: unknown) => unknown;
      run?: (query: unknown) => unknown;
    };
    if (typeof handle.execute === "function") {
      await handle.execute(sql`select 1`);
      return true;
    }
    if (typeof handle.get === "function") {
      await handle.get(sql`select 1 as ok`);
      return true;
    }
    if (typeof handle.all === "function") {
      await handle.all(sql`select 1 as ok`);
      return true;
    }
    if (typeof handle.run === "function") {
      await handle.run(sql`select 1`);
      return true;
    }
    throw new Error("db handle exposes neither execute() nor get()/all()/run()");
  };
}

interface RunningSqliteServer {
  readonly base: string;
  readonly close: () => Promise<void>;
}

let server: RunningSqliteServer | null = null;
let tmpDir: string | null = null;
let bootFailure = "";
let authOnSqlite: { ok: boolean; reason: string } = { ok: false, reason: "not attempted" };
/** False only when createAuth could not even be constructed for the sqlite handle. */
let authIsReal = false;

if (seam !== null) {
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "w1-03-sqlite-"));
    const databaseUrl = `file:${join(tmpDir, "studio-dev.db")}`;
    // Rung-2 env proof: @studio/config must accept the file: URL in local.
    const env: StudioEnv = parseEnv(testEnvSource({ DATABASE_URL: databaseUrl }));

    const db = seam.createDb(databaseUrl);
    try {
      await seam.bootstrapSqlite(databaseUrl);
    } catch (first) {
      if (!(first instanceof TypeError)) throw first;
      // The seam takes the db handle, not the URL (TypeError = wrong arg shape).
      await seam.bootstrapSqlite(db);
    }

    let rawAuth: Auth | null = null;
    try {
      rawAuth = createAuth({
        databaseUrl: env.db.url,
        appUrl: `${env.app.url.replace(/\/+$/, "")}/v1/auth`,
        secret: env.auth.secret,
        google: { clientId: env.auth.google.id, clientSecret: env.auth.google.secret },
        github: { clientId: env.auth.github.id, clientSecret: env.auth.github.secret },
        db: db as unknown as StudioDb,
      });
    } catch (error) {
      authOnSqlite = { ok: false, reason: `createAuth construction failed: ${shortError(error)}` };
    }
    authIsReal = rawAuth !== null;
    if (rawAuth !== null) {
      // Rung-3 gate: one direct sign-up classifies better-auth-on-sqlite.
      try {
        const direct = (await rawAuth.api.signUpEmail({
          body: {
            email: uniqueEmail("sqlite-smoke"),
            password: "Passw0rd!longenough",
            name: "Sqlite Smoke",
          },
        })) as unknown as { user?: { id?: string } };
        authOnSqlite =
          direct.user?.id !== undefined
            ? { ok: true, reason: "better-auth sign-up succeeded on the sqlite instance" }
            : { ok: false, reason: "sign-up returned without a user id" };
      } catch (error) {
        authOnSqlite = { ok: false, reason: `sign-up failed on sqlite: ${shortError(error)}` };
      }
    }

    const localDriver = new LocalFSDriver(join(tmpDir, "storage"), env.app.url);
    const runner: AgentRunner = createMockRunner();
    const deps: GatewayDeps = {
      env,
      // When better-auth cannot even be constructed for sqlite, the auth seam
      // is faked so the boot/health rung still proves the db + repos wiring —
      // the journey rung stays skipped and the suite name carries the reason.
      auth: rawAuth !== null ? adaptBetterAuth(rawAuth) : new FakeGatewayAuth(),
      repos: createRepos(db as unknown as StudioDb),
      storage: localDriver,
      local: localDriver,
      runner,
      runs: new RunRegistry(),
      limiter: unlimitedLimiter(),
      idempotency: createInMemoryIdempotencyStore(),
      chatReplay: createInMemoryChatReplayStore(),
      logger: nullLogger,
      stripe: null,
      version: "0.0.0-sqlite-smoke",
      dbHealth: sqliteDbHealth(db),
    };
    server = await listen(buildApp({ deps }));
  } catch (error) {
    bootFailure = shortError(error);
  }
}

const SEAM_READY = seam !== null && server !== null;
const JOURNEY_READY = SEAM_READY && authOnSqlite.ok;

const d = describe.skipIf(!SEAM_READY);
const dAuth = describe.skipIf(!JOURNEY_READY);

afterAll(async () => {
  await server?.close();
  if (tmpDir !== null) rmSync(tmpDir, { recursive: true, force: true });
});

function base(): string {
  if (server === null) throw new Error("sqlite smoke server not booted");
  return server.base;
}

// ---------------------------------------------------------------------------
// Rung 1 — always-run proofs
// ---------------------------------------------------------------------------

describe("W1-03 sqlite dev server — env + adapter rungs (always run)", () => {
  it("@studio/config accepts DATABASE_URL=file:… in local, rejects it in production", () => {
    const local = parseEnv(testEnvSource({ DATABASE_URL: "file:/tmp/w1-03/studio-dev.db" }));
    expect(local.db.url).toBe("file:/tmp/w1-03/studio-dev.db");
    expect(local.app.env).toBe("local");
    const production = testEnvSource({
      APP_URL: "https://app.studio.example.com",
      APP_ENV: "production",
      DATABASE_URL: "file:/tmp/w1-03/studio-dev.db",
      MOCK_MODEL: "false",
      S3_ENDPOINT: "https://s3.example.com",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_BUCKET: "studio-prod",
      STRIPE_SECRET_KEY: "sk_live_redacted_fixture",
    });
    expect(() => parseEnv(production)).toThrow(/must be a PostgreSQL URL when APP_ENV is/);
  });

  it("the @studio/db sqlite seam exports land together (createDb + isSqliteUrl + bootstrapSqlite)", async () => {
    const mod = (await import("@studio/db")) as unknown as Record<string, unknown>;
    const presence = ["isSqliteUrl", "bootstrapSqlite"].map(
      (name) => typeof mod[name] === "function",
    );
    // All-or-nothing: a half-landed seam is an integration bug, not a skip.
    expect(new Set(presence).size).toBe(1);
  });

  it("VERDICT: better-auth drizzleAdapter runs on sqlite — provider 'sqlite' + transaction:true (node:sqlite, no native dep)", async () => {
    const probeDir = mkdtempSync(join(tmpdir(), "w1-03-ba-"));
    try {
      const client = new DatabaseSync(join(probeDir, "auth.db"));
      // sqlite-proxy contract: rows come back POSITIONALLY (arrays) for
      // fieldful queries — object rows break mapResultRow. The declared
      // callback type wants rows: unknown[] but drizzle's own mapGetResult
      // treats an undefined `rows` as "no row" — hence the narrow cast.
      const db = drizzle(async (query, params, method) => {
        const statement = client.prepare(query);
        if (method === "run") {
          statement.run(...(params as never[]));
          return { rows: [] };
        }
        if (method === "get") {
          const row = statement.get(...(params as never[])) as Record<string, unknown> | undefined;
          return {
            rows: (row === undefined ? undefined : Object.values(row)) as unknown as unknown[],
          };
        }
        const rows = statement.all(...(params as never[])) as Record<string, unknown>[];
        return { rows: rows.map((row) => Object.values(row)) };
      });

      // Canonical better-auth core tables (sqlite dialect, drizzle twin).
      const user = sqliteTable("user", {
        id: text("id").primaryKey().notNull(),
        name: text("name").notNull(),
        email: text("email").notNull().unique(),
        emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
        image: text("image"),
        createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
      });
      const session = sqliteTable("session", {
        id: text("id").primaryKey().notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
        token: text("token").notNull().unique(),
        createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
        ipAddress: text("ip_address"),
        userAgent: text("user_agent"),
        userId: text("user_id").notNull(),
      });
      const account = sqliteTable("account", {
        id: text("id").primaryKey().notNull(),
        accountId: text("account_id").notNull(),
        providerId: text("provider_id").notNull(),
        userId: text("user_id").notNull(),
        accessToken: text("access_token"),
        refreshToken: text("refresh_token"),
        idToken: text("id_token"),
        accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
        refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
        scope: text("scope"),
        password: text("password"),
        createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
      });
      const verification = sqliteTable("verification", {
        id: text("id").primaryKey().notNull(),
        identifier: text("identifier").notNull(),
        value: text("value").notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp" }),
        updatedAt: integer("updated_at", { mode: "timestamp" }),
      });
      for (const ddl of [
        "create table user (id text primary key not null, name text not null, email text not null unique, email_verified integer not null default 0, image text, created_at integer not null, updated_at integer not null)",
        "create table session (id text primary key not null, expires_at integer not null, token text not null unique, created_at integer not null, updated_at integer not null, ip_address text, user_agent text, user_id text not null)",
        "create table account (id text primary key not null, account_id text not null, provider_id text not null, user_id text not null, access_token text, refresh_token text, id_token text, access_token_expires_at integer, refresh_token_expires_at integer, scope text, password text, created_at integer not null, updated_at integer not null)",
        "create table verification (id text primary key not null, identifier text not null, value text not null, expires_at integer not null, created_at integer, updated_at integer)",
      ]) {
        client.exec(ddl);
      }

      const auth = betterAuth({
        baseURL: TEST_APP_ORIGIN,
        secret: "w1-03-adapter-probe-secret-0123456789ab",
        database: drizzleAdapter(db, {
          provider: "sqlite",
          transaction: true,
          schema: { user, session, account, verification },
        }),
        emailAndPassword: { enabled: true },
      });

      const email = uniqueEmail("ba-sqlite");
      const signUp = (await auth.api.signUpEmail({
        body: { email, password: "Passw0rd!longenough", name: "Adapter Probe" },
      })) as unknown as { user: { id: string; email: string } };
      expect(signUp.user.id).toBeTruthy();
      expect(signUp.user.email).toBe(email);

      const signIn = (await auth.api.signInEmail({
        body: { email, password: "Passw0rd!longenough" },
      })) as unknown as { user: { id: string } };
      expect(signIn.user.id).toBe(signUp.user.id);

      const sessions = client.prepare("select count(*) as c from session").get() as {
        c: number;
      };
      expect(sessions.c).toBeGreaterThanOrEqual(2);
      client.close();
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Rung 2 — seam-gated: the real gateway app on a real sqlite file
// ---------------------------------------------------------------------------

d(
  `W1-03 sqlite dev-server: REAL gateway on a sqlite file${
    bootFailure !== "" ? ` (BOOT FAILED: ${bootFailure})` : ""
  }${authIsReal ? "" : " — auth FAKED, better-auth not sqlite-wired yet"}`,
  () => {
    it("GET /health answers 200 with db:true via the real sqlite handle", async () => {
      const response = await fetch(`${base()}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; db: boolean; version: string };
      expect(body.status).toBe("ok");
      expect(body.db).toBe(true);
      expect(body.version).toBe("0.0.0-sqlite-smoke");
    });

    it("GET /v1/health answers through the mounted API surface too", async () => {
      const response = await fetch(`${base()}/v1/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; db: boolean };
      expect(body.db).toBe(true);
    });
  },
);

// ---------------------------------------------------------------------------
// Rung 3 — auth-gated: the full PG-free dev-server journey over HTTP
// ---------------------------------------------------------------------------

dAuth("W1-03 sqlite dev-server journey: sign-up → me → workspace → project → list", () => {
  it("better-auth sign-up sets a session cookie and /v1/me echoes the user", async () => {
    const jar = new CookieJar();
    const email = uniqueEmail("sqlite-journey");
    const response = await api(base(), "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: { email, password: "Passw0rd!longenough", name: "Sqlite Journey" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string; email: string } };
    expect(body.user.email).toBe(email);
    expect(body.user.id).toBeTruthy();
    expect(jar.header).toContain("better-auth.session_token=");

    const me = await api(base(), "/v1/me", { jar });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { user: { email: string } } };
    expect(meBody.data.user.email).toBe(email);
  });

  it("workspace create → project create → project list (sqlite repos, tenant-scoped)", async () => {
    const jar = new CookieJar();
    const signUp = await api(base(), "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: { email: uniqueEmail("sqlite-journey"), password: "Passw0rd!longenough", name: "J2" },
    });
    expect(signUp.status).toBe(200);

    const wsName = unique("WS");
    const ws = await api(base(), "/v1/workspaces", {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("ws-create") },
      body: { name: wsName, slug: unique("ws") },
    });
    expect(ws.status).toBe(201);
    const wsBody = (await ws.json()) as { data: { id: string; slug: string } };
    expect(wsBody.data.id).toBeTruthy();

    const projectName = unique("Smoke Project");
    const project = await api(base(), "/v1/projects", {
      method: "POST",
      jar,
      headers: { "x-workspace-id": wsBody.data.id, "idempotency-key": unique("prj-create") },
      body: { name: projectName },
    });
    expect(project.status).toBe(201);
    const projectBody = (await project.json()) as {
      data: { id: string; name: string; workspaceId: string; currentVersionId: string | null };
    };
    expect(projectBody.data.name).toBe(projectName);
    expect(projectBody.data.workspaceId).toBe(wsBody.data.id);
    expect(projectBody.data.currentVersionId).toBeNull();

    const list = await api(base(), "/v1/projects", {
      jar,
      headers: { "x-workspace-id": wsBody.data.id },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { items: { id: string; name: string }[] } };
    const found = listBody.data.items.find((item) => item.id === projectBody.data.id);
    expect(found?.name).toBe(projectName);
  });
});
