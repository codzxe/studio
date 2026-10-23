# @studio/db

Drizzle schema + Better Auth factory + tenant-scoped repositories + migrations
+ demo seed for the studio control plane. **Dual dialect**: Postgres is the
canonical production dialect; a SQLite "dev twin" lets you run the whole stack
locally with zero infrastructure.

## 1. Dual dialect (the contract)

```
                DATABASE_URL
                |            \
   postgres://  |             \  file:… / sqlite:…
                v              v
        src/schema.ts    src/schema-sqlite.ts      (same table + column NAMES,
        (pg, canonical)   (the dev twin)            types differ: timestamps
                |              |                    are integer ms, booleans
        drizzle/           src/sqlite-bootstrap.ts  are 0/1)
        migrations         (idempotent CREATE TABLE
        (forward-only)     IF NOT EXISTS)
```

- **Postgres is canonical.** Production and the integration test suite run on
  it; `drizzle/` holds the only real migrations (forward-only, generated via
  `pnpm db:generate` -- never hand-edit applied migrations).
- **SQLite is a dev twin, not a port.** `createDb("file:…")` opens the twin
  through better-sqlite3 + drizzle, applies the pragmas
  (`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`) and
  bootstraps the schema. Dev databases are throwaway (section 4).
- The repos are dialect-aware internally: advisory locks, `FOR UPDATE SKIP
  LOCKED`, `now()`, json predicates, `count(*)::int` and unique-violation
  classification (`SQLSTATE 23505` and `SQLITE_CONSTRAINT_UNIQUE` both map to
  the typed CONFLICT path) all fork on the runtime dialect.
- `@studio/config` accepts `file:`/`sqlite:` URLs **only** when
  `APP_ENV=local`; production env parsing rejects them.

## 2. Dev workflow (PG-free)

```sh
scripts/dev-sqlite.sh start    # ensure .local/studio-dev.db + bootstrap + seed
scripts/dev-sqlite.sh reset    # delete the file, then start fresh
scripts/dev-sqlite.sh status   # file + tables + row counts (exit 3 if absent)
scripts/dev-sqlite.sh dump-schema
```

Then point the gateway (and anything else that reads DATABASE_URL) at it:

```
DATABASE_URL=file:/abs/path/to/repo/.local/studio-dev.db
APP_ENV=local
```

- Both `start` and the demo seed (`packages/db/scripts/seed.ts`) are
  idempotent -- re-running is always safe. Seeded demo: user `demo@studio.test`,
  demo workspace/project, 1000 credits.
- Overrides: `STUDIO_SQLITE_DB` (file path), `STUDIO_SQLITE_URL` (full URL).
- `file::memory:` / `sqlite::memory:` open an in-memory database (tests).
- The gateway's DB-gated test suite also runs on the twin:
  `cd services/gateway && DATABASE_URL=file:…/studio-dev.db pnpm exec vitest run`.
  Suites that genuinely need Postgres machinery gate on the helpers'
  `HAS_POSTGRES` and carry the skip reason in their describe title.

## 3. The seams (what dialect-aware code must use)

| Seam                    | What it does |
| ----------------------- | ------------ |
| `createDb(url)`         | Dialect switch on the URL (`isSqliteUrl`). The declared return type stays the pg-flavored `StudioDb` so every pg caller keeps compiling; a sqlite URL returns a runtime `StudioSqliteDb` behind that signature. |
| `getDialect(db or tx)`  | Runtime dialect of a handle. Key every dialect fork off THIS, never off the static type -- a sqlite handle flows through pg-typed signatures. |
| `tablesFor(db or tx)`   | Dialect-correct table registry. Any INSERT/UPDATE with drizzle builders MUST resolve its tables through this (pg tables carry `now()` defaults and ISO-string mappers that corrupt the twin's integer-ms columns). Pure selects may work either way; still use the seam. |
| `isSqliteUrl` / `sqlitePathFromUrl` | URL classification + path extraction (`file:`/`sqlite:`, optional `?query` ignored). |
| `bootstrapSqlite(url or db)` | One-shot bootstrap for CLI use (`dev-sqlite.sh`); app runtime bootstraps via `createDb` on open. |

Closing a handle is dialect-aware too: pg pools `$client.end()` (bounded drain),
sqlite handles `$client.close()`. Code that owns a handle should branch on
`getDialect` exactly like `services/gateway/src/index.ts` does.

## 4. Throwaway policy (bootstrap, not migrations)

- A dev sqlite database is **throwaway**: delete the file and it rebuilds from
  `sqlite-bootstrap.ts`. There is no migration machinery for the twin and none
  is wanted.
- **Never** run the `drizzle/` Postgres migrations against a sqlite database.
- Schema-change procedure:
  1. change the canonical `src/schema.ts` + generate a forward-only pg
     migration (`pnpm db:generate` from the repo root);
  2. mirror the change in `src/schema-sqlite.ts` (same names);
  3. regenerate `src/sqlite-bootstrap.ts` with drizzle-kit over the twin
     (dialect `sqlite`, statements ordered parent-first, converted to
     `IF NOT EXISTS`) and update `SQLITE_BOOTSTRAP_STATEMENTS`;
  4. `scripts/dev-sqlite.sh reset` locally -- existing dev files are not
     migrated, they are recreated.

## 5. better-sqlite3 is a dev-only dependency

`better-sqlite3` is a native module and lives in `devDependencies`. Both sqlite
factories load it lazily (`createSqliteDb` via dynamic `import()`,
`createDb`'s sqlite branch via bundler-invisible `createRequire`), so a
production (Postgres) process or bundle never pulls the native module in. Keep
it that way: never import `better-sqlite3` at module top level.

## 6. Tests

- `tests/*.test.ts` -- pure units (schema shapes, permissions, ledger math,
  version/lease logic). No database needed.
- `tests/integration/` -- real-Postgres suites; they gate on `DATABASE_URL`
  being a postgres URL and skip (with the reason in the suite name) otherwise.
- `tests/sqlite/` -- the PG-free dev-server suite: real repos, real
  better-auth sign-up, ledger/lease/render-queue semantics and transaction
  nesting, all against a temp sqlite file.

## 7. Scripts

Run inside this package, or through the repo-root aliases:

| Root                    | Here        | What |
| ----------------------- | ----------- | ---- |
| `pnpm db:generate`      | `generate`  | drizzle-kit: generate a pg migration from `src/schema.ts` |
| `pnpm db:migrate`       | `migrate`   | apply pending pg migrations (programmatic migrator) |
| `pnpm db:seed`          | `seed`      | idempotent demo seed (dialect-aware: pg or sqlite) |
