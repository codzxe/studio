/**
 * @studio/db — public surface.
 *
 * - schema: Drizzle pgTables + inferred domain types + relations
 * - auth: Better Auth factory (organization + apiKey + admin plugins)
 * - permissions: §3.3 role matrix as pure functions
 * - errors: §8.9 error catalog + typed DbError
 * - repos: tenant-scoped repositories (every method filters by workspaceId)
 * - migrate/seed: programmatic migrator + demo seed
 */
export * from "./schema.js";
export * from "./permissions.js";
export * from "./errors-lite.js";
export * from "./ledger-math.js";
export * from "./lease-logic.js";
export * from "./version-logic.js";
export * from "./statuses.js";
export * from "./cursor.js";
export * from "./slug.js";
export { createId } from "./ids.js";
export {
  createDb,
  createSqliteDb,
  isSqliteUrl,
  getDialect,
  sqlitePathFromUrl,
  bootstrapSqlite,
  type StudioDb,
  type StudioTx,
  type Executor,
  type StudioSqliteDb,
  type AnyDb,
  type Dialect,
} from "./db.js";
export { bootstrapSqliteDatabase, SQLITE_BOOTSTRAP_STATEMENTS } from "./sqlite-bootstrap.js";
export { tablesFor } from "./tables.js";
export { createAuth, type Auth, type AuthEnv, type AuthHandler } from "./auth.js";
export { createRepos, type Repos } from "./repos/index.js";
// W1-b (§M1 tasks 1+2): the apiKeys repo row type the gateway route consumes.
export type { ApiKeysRepo, ApiKeyRecord, ApiKeysListOptions } from "./repos/index.js";
export { migrateDatabase, DEFAULT_MIGRATIONS_FOLDER } from "./migrate.js";
