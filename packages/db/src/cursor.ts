import { DbError } from "./errors-lite.js";

/**
 * Opaque keyset cursor: base64url(JSON `{ t: ISO, id }`).
 * Sorting is (createdAt DESC, id DESC); the cursor encodes the last item.
 */
export interface Cursor {
  readonly t: string; // createdAt ISO string
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw DbError.validation("Invalid pagination cursor");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { t?: unknown }).t === "string" &&
    typeof (parsed as { id?: unknown }).id === "string"
  ) {
    const { t, id } = parsed as { t: string; id: string };
    return { t, id };
  }
  throw DbError.validation("Invalid pagination cursor");
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Default page size for repo list methods. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw DbError.validation("limit must be a positive integer");
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}
