import { randomUUID } from "node:crypto";
/**
 * Prefixed text ids: `${prefix}_${uuid (no dashes)}` — stable across postgres.js
 * and drizzle, lexicographically sortable by prefix, never a bare number.
 */
export function createId(prefix) {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
//# sourceMappingURL=ids.js.map