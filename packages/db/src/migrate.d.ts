import type { StudioDb } from "./db.js";
/**
 * Programmatic migrations using the drizzle-orm/postgres-js migrator.
 * Drizzle migrations are forward-only; the folder is produced by
 * `pnpm --filter @studio/db generate` (drizzle-kit generate, offline-safe).
 */
export declare const DEFAULT_MIGRATIONS_FOLDER: string;
export declare function migrateDatabase(db: StudioDb, migrationsFolder?: string): Promise<void>;
