import type { Page } from "../cursor.js";
import { DbError } from "../errors-lite.js";

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
export function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e !== null && typeof e === "object"; ) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Require a non-empty string. */
export function requireNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw DbError.validation(`${field} is required`);
  }
  return trimmed;
}

/** Require a non-negative integer. */
export function requireNonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw DbError.validation(`${field} must be a non-negative integer`);
  }
  return value;
}

/** Require a positive integer. */
export function requirePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw DbError.validation(`${field} must be a positive integer`);
  }
  return value;
}
