/**
 * Prefixed text ids: `${prefix}_${uuid (no dashes)}` — stable across postgres.js
 * and drizzle, lexicographically sortable by prefix, never a bare number.
 */
export declare function createId(prefix: string): string;
