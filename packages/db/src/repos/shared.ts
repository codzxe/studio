import type { Page } from "../cursor.js";
import { DbError } from "../errors-lite.js";

/** Workspace == Better Auth organization id (ADR-0003). */
export type WorkspaceId = string;

export type { Page };

/** postgres unique-violation (SQLSTATE 23505) — mapped to typed CONFLICT upstream. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
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
