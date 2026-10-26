import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { StudioDb } from "./db.js";
import * as schema from "./schema.js";

/**
 * Programmatic migrations using the drizzle-orm/postgres-js migrator.
 * Drizzle migrations are forward-only; the folder is produced by
 * `pnpm --filter @studio/db generate` (drizzle-kit generate, offline-safe).
 */
// The migrations folder only exists at MIGRATION-CLI runtime. Bundles that
// embed this file (the apps/web gateway bundle) must not resolve it as a
// build-time asset — but magic comments (turbopackIgnore) are STRIPPED by the
// inner esbuild pass before the outer Turbopack ever sees the artifact, and a
// plain string constant gets const-folded back into the literal. The
// two-element join() is neither folded by esbuild (no --minify) nor
// statically evaluable by Turbopack, so the outer bundler gives up on the
// reference entirely — the only reliable shield that survives bundling.
const DRIZZLE_DIR = ["..", "drizzle"].join("/");
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL(DRIZZLE_DIR, import.meta.url));

export async function migrateDatabase(
  db: StudioDb,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}

function isInvokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // biome-ignore lint/suspicious/noConsole: CLI migrate entrypoint — reports missing DATABASE_URL to stderr before exit
    console.error("DATABASE_URL is required to run migrations");
    process.exitCode = 1;
    return;
  }
  const folder = process.argv[2] ?? DEFAULT_MIGRATIONS_FOLDER;
  const client = postgres(databaseUrl, { max: 1 });
  const db: StudioDb = drizzle(client, { schema });
  try {
    await migrateDatabase(db, folder);
    // biome-ignore lint/suspicious/noConsole: CLI migrate entrypoint — logs completion to stdout
    console.info(`[db] migrations applied from ${folder}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (isInvokedDirectly()) {
  await main();
}
