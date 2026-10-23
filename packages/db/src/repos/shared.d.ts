import type { Page } from "../cursor.js";
/** Workspace == Better Auth organization id (ADR-0003). */
export type WorkspaceId = string;
export type { Page };
/**
 * Postgres unique-violation (SQLSTATE 23505) — mapped to typed CONFLICT upstream.
 *
 * Walks the `.cause` chain because drizzle wraps the postgres.js PostgresError
 * (`Failed query …`) in its own error type: the 23505 code lives on the WRAPPED
 * cause, so a shallow `.code` check misses every unique violation raised through
 * a drizzle insert (M6-D finding; the real wrap is pinned by the integration
 * suites — e.g. a duplicate addStep insert).
 */
export declare function isUniqueViolation(error: unknown): boolean;
/** Require a non-empty string. */
export declare function requireNonEmpty(value: string | undefined, field: string): string;
/** Require a non-negative integer. */
export declare function requireNonNegativeInt(value: number, field: string): number;
/** Require a positive integer. */
export declare function requirePositiveInt(value: number, field: string): number;
