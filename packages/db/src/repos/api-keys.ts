import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { type StudioDb, getDialect } from "../db.js";
import { tablesFor } from "../tables.js";
import type { WorkspaceId } from "./shared.js";

/**
 * API-keys repository (BUILD_PLAN §M1 tasks 1+2, AUD-1 gap #2) — READ-ONLY.
 *
 * Minting and revocation go through the better-auth apiKey plugin server API
 * (gateway auth seam): the plugin owns key generation, SHA-256 hashing at
 * rest, the show-once plaintext and the `enabled` flip. What the plugin
 * CANNOT do is list the keys of a whole WORKSPACE — its endpoints are
 * per-reference (session-owner) only — and that is exactly this repo's one
 * job: the tenant-scoped workspace list + single-key tenant gate.
 *
 * Workspace binding: keys are user-referenced (the plugin's session-mock is
 * user-referenced-only), so the workspace link rides the plugin's key
 * `metadata` JSON (`{workspaceId, createdBy}`, written at mint time by the
 * gateway). The binding filter is `metadata::jsonb ->> 'workspaceId'`.
 *
 * Law #3: every read takes `workspaceId` first and filters by it — a key id
 * from another workspace reads as null (§12.1: cross-tenant 404, never 403).
 * The hashed `key` column is NEVER selected.
 */

/** A plugin apikey row as the gateway consumes it (no key material, ever). */
export interface ApiKeyRecord {
  readonly id: string;
  /** The minting user (better-auth referenceId — the key acts as this user). */
  readonly referenceId: string;
  readonly name: string | null;
  /** Raw statements JSON (better-auth access-control map), nullable. */
  readonly permissions: string | null;
  /** Raw metadata JSON (`{workspaceId, createdBy}`), nullable. */
  readonly metadata: string | null;
  /** Schema truth: the better-auth column is `boolean | null` (default true); normalized to `true` in `toRecord` — a never-flipped key IS enabled. */
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date | null;
  /** Last successful verification (the plugin's `last_request`). */
  readonly lastRequest: Date | null;
}

export interface ApiKeysListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ApiKeysRepo {
  /** Newest-first, cursor-paginated keys bound to the workspace. */
  list(workspaceId: WorkspaceId, options?: ApiKeysListOptions): Promise<Page<ApiKeyRecord>>;
  /** One key bound to the workspace, or null (cross-tenant reads as null). */
  get(workspaceId: WorkspaceId, keyId: string): Promise<ApiKeyRecord | null>;
}

/**
 * Workspace binding predicate. Dialect fork (W1-03 sqlite dev server):
 * pg `metadata::jsonb ->> 'workspaceId'`; sqlite `json_extract(metadata, …)`
 * (the twin keeps metadata as plain TEXT in both dialects).
 */
function inWorkspace(db: StudioDb, workspaceId: WorkspaceId) {
  const { apiKey } = tablesFor(db);
  return getDialect(db) === "sqlite"
    ? sql`json_extract(${apiKey.metadata}, '$.workspaceId') = ${workspaceId}`
    : sql`(${apiKey.metadata})::jsonb ->> 'workspaceId' = ${workspaceId}`;
}

/** The better-auth `enabled` column is nullable (default true) — a never-flipped key IS enabled. */
function toRecord(row: {
  id: string;
  referenceId: string;
  name: string | null;
  permissions: string | null;
  metadata: string | null;
  enabled: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  lastRequest: Date | null;
}): ApiKeyRecord {
  return { ...row, enabled: row.enabled ?? true };
}

export function createApiKeysRepo(db: StudioDb): ApiKeysRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const apiKeyTable = tablesFor(db).apiKey;
  const RECORD_COLUMNS = {
    id: apiKeyTable.id,
    referenceId: apiKeyTable.referenceId,
    name: apiKeyTable.name,
    permissions: apiKeyTable.permissions,
    metadata: apiKeyTable.metadata,
    enabled: apiKeyTable.enabled,
    createdAt: apiKeyTable.createdAt,
    updatedAt: apiKeyTable.updatedAt,
    expiresAt: apiKeyTable.expiresAt,
    lastRequest: apiKeyTable.lastRequest,
  } as const;
  return {
    async list(workspaceId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = (
        await db
          .select(RECORD_COLUMNS)
          .from(apiKeyTable)
          .where(
            and(
              inWorkspace(db, workspaceId),
              cursor
                ? or(
                    lt(apiKeyTable.createdAt, new Date(cursor.t)),
                    and(
                      eq(apiKeyTable.createdAt, new Date(cursor.t)),
                      lt(apiKeyTable.id, cursor.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(apiKeyTable.createdAt), desc(apiKeyTable.id))
          .limit(limit + 1)
      ).map(toRecord);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async get(workspaceId, keyId) {
      const [row] = await db
        .select(RECORD_COLUMNS)
        .from(apiKeyTable)
        .where(and(eq(apiKeyTable.id, keyId), inWorkspace(db, workspaceId)))
        .limit(1);
      return row === undefined ? null : toRecord(row);
    },
  };
}
