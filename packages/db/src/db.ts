import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Options as PostgresOptions } from "postgres";

import * as schema from "./schema.js";

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

export function createDb(databaseUrl: string, options?: PostgresOptions<never>): StudioDb {
  const client = postgres(databaseUrl, { max: 10, ...options });
  return drizzle(client, { schema });
}
