import * as pgSchema from "./schema.js";
import * as sqliteSchema from "./schema-sqlite.js";
import { getDialect, type AnyDb, type Executor } from "./db.js";

/**
 * Dialect-aware table registry (W1-02/W1-03 seam, completed for the sqlite
 * dev server). Every table name exists in BOTH schemas with identical column
 * names; the twin differs only in column TYPES and DEFAULT expressions
 * (pg `now()` vs sqlite `unixepoch('subsec') * 1000`).
 *
 * WHY THIS EXISTS: a query built from a PG table carries pg column defaults
 * (`defaultNow()` → SQL `now()`) and pg column mappers (Date → ISO string).
 * On a sqlite dev handle the defaults reference a function sqlite does not
 * have ("no such function: now") and the mappers write ISO strings into
 * integer-ms columns. Selects happen to work (names match); INSERTs DO NOT.
 * Code that inserts/updates rows without pinning every timestamp explicitly
 * must pick its tables through this seam.
 *
 * Postgres callers may keep importing `./schema.js` directly — the pg module
 * IS the canonical production schema. This seam exists for dialect-agnostic
 * code (the seed, repos) that runs on either handle.
 */

/** The subset of the schema modules the table registry needs. */
type TableBundle = typeof pgSchema;

/**
 * The schema module matching the handle's runtime dialect: the sqlite twin on
 * a sqlite dev handle, the canonical pg schema on Postgres.
 *
 * Accepts a db handle OR a transaction handle (`Executor`) — every repo
 * helper that runs inside `db.transaction(cb)` resolves its tables from the
 * `tx` it receives (W3-A).
 */
export function tablesFor(db: AnyDb | Executor): TableBundle {
  return getDialect(db) === "sqlite" ? (sqliteSchema as unknown as TableBundle) : pgSchema;
}
