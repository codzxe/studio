import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Options as PostgresOptions } from "postgres";

import * as schema from "./schema.js";
import * as sqliteSchema from "./schema-sqlite.js";
import { bootstrapSqliteDatabase } from "./sqlite-bootstrap.js";

/**
 * Studio db handle (postgres.js + drizzle). The auth factory and the repos
 * both accept one of these; create one per process and share it.
 *
 * `StudioTx` is the transaction handle passed to `db.transaction(async (tx) => …)`
 * callbacks. `Executor` is "db or tx" — usable for the shared read helpers
 * (both expose identical query-builder methods).
 */
export type StudioDb = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };
export type StudioTx = Parameters<Parameters<StudioDb["transaction"]>[0]>[0];
export type Executor = StudioDb | StudioTx;

/**
 * SQLite twin handle (W1-02 dev dialect) — better-sqlite3 + drizzle over the
 * twin schema (`./schema-sqlite.ts`), one serialized connection. The NATIVE
 * `better-sqlite3` module (and the drizzle better-sqlite3 driver, which
 * imports it at runtime) is loaded LAZILY — dynamic `import()` in
 * `createSqliteDb`, bundler-invisible `createRequire` in `createDb`'s sqlite
 * branch — so a production (Postgres) process or bundle never loads it.
 * The twin schema itself is plain drizzle sqlite-core (pure JS, no natives).
 */
export type StudioSqliteDb =
  import("drizzle-orm/better-sqlite3").BetterSQLite3Database<typeof sqliteSchema> & {
    $client: import("better-sqlite3").Database;
  };

/** Either dialect — what `createRepos` accepts and what repos execute on. */
export type AnyDb = StudioDb | StudioSqliteDb;

export type Dialect = "postgres" | "sqlite";

/**
 * A sqlite dev URL: `file:…` or `sqlite:…`. Everything else is Postgres
 * (the canonical production dialect). The dev server branches on this.
 */
export function isSqliteUrl(url: string): boolean {
  return url.startsWith("file:") || url.startsWith("sqlite:");
}

/**
 * Runtime dialect of a db OR transaction handle. Repos key every dialect
 * shim (advisory lock, SKIP LOCKED, jsonb predicate, ::int casts, now(),
 * greatest(), FOR UPDATE) off THIS check — never off the static type,
 * because a sqlite handle flows through the pg-typed repo signatures.
 *
 * Detection is structural: sqlite drizzle handles (db and tx) expose the
 * sync row helpers (.get/.all/.run), and the raw better-sqlite3 client
 * exposes .prepare; neither exists on any postgres.js/drizzle-pg object.
 */
export function getDialect(exec: unknown): Dialect {
  if (exec !== null && (typeof exec === "object" || typeof exec === "function")) {
    if (typeof (exec as { get?: unknown }).get === "function") return "sqlite";
    const client = (exec as { $client?: { prepare?: unknown } }).$client;
    if (client !== undefined && typeof client.prepare === "function") return "sqlite";
  }
  return "postgres";
}

/**
 * Path for a sqlite dev URL. Supported forms (dev ergonomics, documented in
 * README.md): `file::memory:` / `sqlite::memory:` → `:memory:`;
 * `file:<path>` / `sqlite:<path>` with optional `?query` (ignored).
 */
export function sqlitePathFromUrl(url: string): string {
  const rest = url.replace(/^(?:file|sqlite):/, "");
  const withoutQuery = rest.split("?")[0]?.split("#")[0] ?? "";
  if (withoutQuery === "" || withoutQuery === ":memory:") return ":memory:";
  return withoutQuery.replace(/^\/\//, "");
}

/** Pragmas every dev connection gets (W1-02 contract, see README.md). */
function applyPragmas(client: import("better-sqlite3").Database): void {
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
}

/**
 * Open a sqlite dev database (better-sqlite3 + drizzle over the twin schema)
 * with pragmas applied and the schema bootstrapped (idempotent CREATE TABLE
 * IF NOT EXISTS — see sqlite-bootstrap.ts). Pass `{ bootstrap: false }` to
 * skip bootstrapping (tests that manage DDL themselves).
 *
 * `better-sqlite3` is a DEV-ONLY dependency loaded via dynamic `import()` so
 * production (Postgres) bundles never include the native module. Prefer this
 * factory in dev-server boot code; `createDb("file:…")` delegates to the
 * same logic synchronously.
 */
export async function createSqliteDb(
  path: string,
  options?: { bootstrap?: boolean },
): Promise<StudioSqliteDb> {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle: drizzleSqlite } = await import("drizzle-orm/better-sqlite3");
  const client = new Database(path);
  applyPragmas(client);
  if (options?.bootstrap !== false) bootstrapSqliteDatabase(client);
  return drizzleSqlite(client, { schema: sqliteSchema });
}

/**
 * Synchronous open for `createDb`'s sqlite branch (the signature-preserving
 * seam). `createRequire` is the ONLY way to keep `createDb` synchronous; it
 * is invisible to bundlers, so production bundles stay clean of the native
 * module — the same guarantee `createSqliteDb` gets from dynamic `import()`.
 */
function createSqliteDbSync(path: string, bootstrap: boolean): StudioSqliteDb {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;
  const { drizzle: drizzleSqlite } = require("drizzle-orm/better-sqlite3") as typeof import(
    "drizzle-orm/better-sqlite3"
  );
  const client = new Database(path);
  applyPragmas(client);
  if (bootstrap) bootstrapSqliteDatabase(client);
  return drizzleSqlite(client, { schema: sqliteSchema });
}

/**
 * Create the studio db handle from a database URL — DIALECT-AWARE (W1-02):
 * - `file:…` / `sqlite:…` → sqlite dev mode (better-sqlite3 + twin schema,
 *   pragmas + bootstrap; dev databases are throwaway — no migrations).
 * - anything else → Postgres, byte-identical to the pre-W1-02 behavior
 *   (postgres.js pool max 10 + the canonical `./schema.ts`).
 *
 * SIGNATURE SEAM (documented + pinned by tests/sqlite/*): the declared return
 * type stays `StudioDb` so every existing pg caller keeps compiling
 * untouched. A sqlite URL returns a runtime `StudioSqliteDb` cast through
 * the seam — repos accept it because `createRepos` takes `AnyDb` and every
 * dialect fork inside the repos keys off `getDialect(db)`, never off the
 * static type. The cast is confined to this function (plus the `tablesFor`
 * seam in tables.ts) and the sqlite suite exercises the real repos
 * end-to-end through it.
 */
export function createDb(databaseUrl: string, options?: PostgresOptions<never>): StudioDb {
  if (isSqliteUrl(databaseUrl)) {
    return createSqliteDbSync(sqlitePathFromUrl(databaseUrl), true) as unknown as StudioDb;
  }
  const client = postgres(databaseUrl, { max: 10, ...options });
  return drizzle(client, { schema });
}
