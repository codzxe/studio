import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Options as PostgresOptions } from "postgres";

import * as sqliteSchema from "./schema-sqlite.js";
import * as schema from "./schema.js";
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
export type StudioSqliteDb = import("drizzle-orm/better-sqlite3").BetterSQLite3Database<
  typeof sqliteSchema
> & {
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
 * Module types for the two `require()` casts below. @types/better-sqlite3 is
 * an `export = Database` module (const + merged namespace), so
 * `typeof import("better-sqlite3")` IS the DatabaseConstructor — there is no
 * `default` member (TS2694). Keeping the casts on module-level aliases also
 * sidesteps biome's multi-line `import(…)` trailing-comma formatting (TS1005).
 */
type BetterSqlite3Module = typeof import("better-sqlite3");
type DrizzleSqliteModule = typeof import("drizzle-orm/better-sqlite3");

const SQLITE_TX_DEPTH = new WeakMap<object, number>();

/**
 * Make the drizzle better-sqlite3 handle's `transaction()` ASYNC-CALLBACK
 * capable (W1-03 dev-server completion).
 *
 * WHY: drizzle's better-sqlite3 session delegates `db.transaction(cb)` to
 * better-sqlite3's `client.transaction(cb)`, which REJECTS promise-returning
 * callbacks ("Transaction function cannot return a promise") — but every
 * repo writes `db.transaction(async (tx) => …)`. Instead of rewriting every
 * repo, the sqlite factories swap the method for an explicit
 * BEGIN/COMMIT/ROLLBACK driver with SAVEPOINT nesting:
 *   - top level  : BEGIN … COMMIT / ROLLBACK
 *   - nested call: SAVEPOINT sp_N … RELEASE / ROLLBACK TO (mirrors the pg
 *     driver's savepoint nesting semantics)
 * The callback receives the SAME handle (better-sqlite3 is one serialized
 * connection — statements issued while the explicit transaction is open
 * participate in it), which is what repo code already expects from `tx`.
 *
 * ALSO installs `execute()` — the pg-flavored statement API the gateway's
 * health probe (and other pg-era call sites) uses: `db.execute(sql…)`.
 * drizzle's sqlite core exposes `.run()` for the same job, so the alias
 * keeps the signature-preserving seam honest (a sqlite handle answers every
 * call the pg handle answered, W3-A).
 */
function makeSqliteTransactionAsyncAware(handle: StudioSqliteDb): StudioSqliteDb {
  const client = handle.$client;
  if (typeof (handle as { execute?: unknown }).execute !== "function") {
    const run = handle.run.bind(handle);
    (handle as unknown as { execute: (query: Parameters<typeof run>[0]) => unknown }).execute = (
      query,
    ) => run(query);
  }
  type TxCallback = (tx: never) => unknown;
  handle.transaction = ((callback: TxCallback, _config?: unknown) => {
    const depth = SQLITE_TX_DEPTH.get(client) ?? 0;
    const savepoint = `studio_sp_${depth}`;
    if (depth === 0) client.exec("BEGIN");
    else client.exec(`SAVEPOINT ${savepoint}`);
    SQLITE_TX_DEPTH.set(client, depth + 1);
    let result: unknown;
    try {
      result = callback(handle as unknown as never);
      const done = (value: unknown) => {
        SQLITE_TX_DEPTH.set(client, depth);
        if (depth === 0) client.exec("COMMIT");
        else client.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      };
      const fail = (error: unknown) => {
        SQLITE_TX_DEPTH.set(client, depth);
        try {
          if (depth === 0) client.exec("ROLLBACK");
          else client.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        } catch {
          /* connection already aborted — surface the original error */
        }
        throw error;
      };
      if (result instanceof Promise) return result.then(done, fail);
      return done(result);
    } catch (error) {
      SQLITE_TX_DEPTH.set(client, depth);
      try {
        if (depth === 0) client.exec("ROLLBACK");
        else client.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } catch {
        /* surface the original error */
      }
      throw error;
    }
  }) as StudioSqliteDb["transaction"];
  return handle;
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
  return makeSqliteTransactionAsyncAware(
    drizzleSqlite(client, { schema: sqliteSchema }) as StudioSqliteDb,
  );
}

/**
 * Synchronous open for `createDb`'s sqlite branch (the signature-preserving
 * seam). `createRequire` is the ONLY way to keep `createDb` synchronous; it
 * is invisible to bundlers, so production bundles stay clean of the native
 * module — the same guarantee `createSqliteDb` gets from dynamic `import()`.
 */
function createSqliteDbSync(path: string, bootstrap: boolean): StudioSqliteDb {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as BetterSqlite3Module;
  const { drizzle: drizzleSqlite } = require("drizzle-orm/better-sqlite3") as DrizzleSqliteModule;
  const client = new Database(path);
  applyPragmas(client);
  if (bootstrap) bootstrapSqliteDatabase(client);
  return makeSqliteTransactionAsyncAware(
    drizzleSqlite(client, { schema: sqliteSchema }) as StudioSqliteDb,
  );
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

/**
 * Bootstrap a sqlite dev database from EITHER a dev URL (`file:…`/`sqlite:…`)
 * or an already-open sqlite handle. Idempotent (CREATE TABLE IF NOT EXISTS —
 * see ./sqlite-bootstrap.ts). This is the seam `scripts/dev-sqlite.sh start`
 * consumes; it exists so the dev script never touches the better-sqlite3
 * client type directly.
 *
 * URL form: opens a fresh connection, bootstraps, and closes it again —
 * intended for one-shot CLI bootstrapping, not app runtime (app runtime
 * bootstraps via `createDb`/`createSqliteDb` on open).
 */
export function bootstrapSqlite(urlOrDb: string | StudioSqliteDb): void {
  if (typeof urlOrDb === "string") {
    if (!isSqliteUrl(urlOrDb)) {
      throw new TypeError(
        `bootstrapSqlite: not a sqlite dev URL (expected file:… or sqlite:…, got ${urlOrDb.slice(0, 40)})`,
      );
    }
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as BetterSqlite3Module;
    const client = new Database(sqlitePathFromUrl(urlOrDb));
    try {
      applyPragmas(client);
      bootstrapSqliteDatabase(client);
    } finally {
      client.close();
    }
    return;
  }
  bootstrapSqliteDatabase(urlOrDb.$client);
}
