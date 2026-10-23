import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { type StudioDb, getDialect } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { ShareToken } from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty, requirePositiveInt } from "./shared.js";

/**
 * Share-token repository — the §M7 task 5 share/review capability.
 *
 * SECURITY MODEL: `share_tokens.token_hash` stores ONLY sha256(raw token).
 * The raw token is minted by the gateway route (node:crypto), returned ONCE
 * in the issue response, and never persisted anywhere — the repo takes the
 * finished hash. `password_hash` is the finished `scrypt$salt$hash` string
 * the gateway produced (no db-side crypto deps); the repo validates shape
 * only and never re-derives it.
 *
 * The public lookups (`verifyByHash`/`getByHash`/`resolveByHash`) are
 * deliberately NOT workspace-filtered: the token IS the capability, and the
 * anonymous share page has no workspace context. They never return rows that
 * are revoked or expired. Every member-facing method keeps the house rule:
 * `workspaceId` first, cross-tenant = NOT_FOUND (§12.1).
 */

/** sha256 lowercase hex (the only token material the repo ever sees). */
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * `scrypt$<saltHex(32)>$<hashHex(128)>` — salt = 16 random bytes, hash =
 * scryptSync(password, salt, 64). Format pinned so the repo can reject junk
 * without any crypto dependency.
 */
const PASSWORD_HASH_RE = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

export interface ShareTokenIssueInput {
  readonly projectId: string;
  readonly createdBy: string;
  /** sha256(raw token), lowercase hex — minted by the calling route. */
  readonly tokenHash: string;
  /** Finished `scrypt$salt$hash` string; null/undefined = no password gate. */
  readonly passwordHash?: string | null;
  /** Whole days from now; null/undefined = never expires. */
  readonly expiresInDays?: number | null;
}

export interface ShareTokenRevokeInput {
  readonly id: string;
  /** Acting user (authorization is the route's job; recorded for the audit). */
  readonly byUserId: string;
}

/**
 * A share-token row WITHOUT secrets for member-facing lists — the raw token
 * does not exist anymore and the hash/password never leave the db package.
 */
export interface ShareTokenView {
  readonly id: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly hasPassword: boolean;
}

/** Share token + the owning project/workspacae context resolved by hash. */
export interface ResolvedShare {
  readonly token: ShareToken;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly projectName: string;
}

export interface ShareTokensRepo {
  issue(workspaceId: WorkspaceId, input: ShareTokenIssueInput): Promise<ShareToken>;
  /** Public capability check scoped to a known project; revoked/expired → null. */
  verifyByHash(projectId: string, tokenHash: string): Promise<ShareToken | null>;
  /** Public capability check by hash alone (the share page knows only the token). */
  getByHash(tokenHash: string): Promise<ShareToken | null>;
  /** Public lookup + project/workspace resolution in one query. */
  resolveByHash(tokenHash: string): Promise<ResolvedShare | null>;
  /** Row + owning workspaceId by share-token id (for the authed revoke route). */
  findById(id: string): Promise<(ShareToken & { workspaceId: string }) | null>;
  list(workspaceId: WorkspaceId, projectId: string): Promise<ShareTokenView[]>;
  revoke(workspaceId: WorkspaceId, input: ShareTokenRevokeInput): Promise<ShareToken>;
}

/** Active filter: not revoked AND (no expiry OR expiry in the future). */
function activeFilter(db: StudioDb) {
  // Dialect-aware tables (W3-A, tables.ts seam) — the column objects must
  // come from the handle's dialect for correct timestamp mapping.
  const { shareTokens } = tablesFor(db);
  return and(
    isNull(shareTokens.revokedAt),
    or(
      isNull(shareTokens.expiresAt),
      // Dialect fork: pg now() vs the twin's integer-ms clock (unixepoch ms).
      gt(
        shareTokens.expiresAt,
        getDialect(db) === "sqlite" ? sql`(unixepoch('subsec') * 1000)` : sql`now()`,
      ),
    ),
  );
}

export function createShareTokensRepo(db: StudioDb): ShareTokensRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { projects, shareTokens, user } = tablesFor(db);
  return {
    async issue(workspaceId, input) {
      const tokenHash = requireNonEmpty(input.tokenHash, "tokenHash").toLowerCase();
      if (!TOKEN_HASH_RE.test(tokenHash)) {
        throw DbError.validation("tokenHash must be a sha256 hex digest (64 chars)");
      }
      const createdBy = requireNonEmpty(input.createdBy, "createdBy");
      const passwordHash =
        input.passwordHash === undefined || input.passwordHash === null
          ? null
          : requireNonEmpty(input.passwordHash, "passwordHash");
      if (passwordHash !== null && !PASSWORD_HASH_RE.test(passwordHash)) {
        throw DbError.validation("passwordHash must be `scrypt$salt$hash` (gateway-produced)");
      }
      let expiresAt: Date | null = null;
      if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
        const days = requirePositiveInt(input.expiresInDays, "expiresInDays");
        if (days > 365) {
          throw DbError.validation("expiresInDays must be at most 365");
        }
        expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
      }

      // Tenant scoping (§12.1) + user existence, BEFORE any insert.
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, requireNonEmpty(input.projectId, "projectId")),
            eq(projects.workspaceId, workspaceId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project) throw DbError.notFound("project");
      const [creator] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, createdBy))
        .limit(1);
      if (!creator) throw DbError.notFound("user");

      try {
        const [row] = await db
          .insert(shareTokens)
          .values({
            id: createId("shr"),
            projectId: project.id,
            tokenHash,
            passwordHash,
            expiresAt,
            createdBy,
          })
          .returning();
        if (!row) throw DbError.conflict("Could not issue share token");
        return row;
      } catch (error) {
        // A second token minted with the SAME hash would mean a raw-token
        // collision (256-bit random) or a route bug — typed CONFLICT, never
        // a wrapped driver error.
        if (isWrappedUniqueViolation(error)) {
          throw DbError.conflict("This share token was already issued");
        }
        throw error;
      }
    },

    async verifyByHash(projectId, tokenHash) {
      if (!TOKEN_HASH_RE.test(tokenHash)) return null;
      const [row] = await db
        .select()
        .from(shareTokens)
        .where(
          and(
            eq(shareTokens.projectId, projectId),
            eq(shareTokens.tokenHash, tokenHash),
            activeFilter(db),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getByHash(tokenHash) {
      if (!TOKEN_HASH_RE.test(tokenHash)) return null;
      const [row] = await db
        .select()
        .from(shareTokens)
        .where(and(eq(shareTokens.tokenHash, tokenHash), activeFilter(db)))
        .limit(1);
      return row ?? null;
    },

    async resolveByHash(tokenHash) {
      if (!TOKEN_HASH_RE.test(tokenHash)) return null;
      const [row] = await db
        .select({
          token: shareTokens,
          projectId: projects.id,
          workspaceId: projects.workspaceId,
          projectName: projects.name,
        })
        .from(shareTokens)
        .innerJoin(projects, eq(shareTokens.projectId, projects.id))
        .where(
          and(eq(shareTokens.tokenHash, tokenHash), activeFilter(db), isNull(projects.deletedAt)),
        )
        .limit(1);
      if (!row) return null;
      return {
        token: row.token,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        projectName: row.projectName,
      };
    },

    async findById(id) {
      const [row] = await db
        .select({ token: shareTokens, workspaceId: projects.workspaceId })
        .from(shareTokens)
        .innerJoin(projects, eq(shareTokens.projectId, projects.id))
        .where(eq(shareTokens.id, id))
        .limit(1);
      if (!row) return null;
      return { ...row.token, workspaceId: row.workspaceId };
    },

    async list(workspaceId, projectId) {
      // Active rows only, NO secrets on the wire — the caller shape omits
      // tokenHash/passwordHash by construction (explicit column list).
      const rows = await db
        .select({
          id: shareTokens.id,
          projectId: shareTokens.projectId,
          createdBy: shareTokens.createdBy,
          createdAt: shareTokens.createdAt,
          expiresAt: shareTokens.expiresAt,
          revokedAt: shareTokens.revokedAt,
          hasPassword: sql<boolean>`${shareTokens.passwordHash} is not null`,
        })
        .from(shareTokens)
        .innerJoin(projects, eq(shareTokens.projectId, projects.id))
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            eq(shareTokens.projectId, projectId),
            activeFilter(db),
          ),
        )
        .orderBy(desc(shareTokens.createdAt));
      return rows.map((row) => ({ ...row, hasPassword: Boolean(row.hasPassword) }));
    },

    async revoke(workspaceId, input) {
      const id = requireNonEmpty(input.id, "id");
      requireNonEmpty(input.byUserId, "byUserId");

      const [current] = await db
        .select({ token: shareTokens })
        .from(shareTokens)
        .innerJoin(projects, eq(shareTokens.projectId, projects.id))
        .where(and(eq(shareTokens.id, id), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!current) throw DbError.notFound("share token");

      // Conditional (race-guarded) update: revoked_at flips exactly once;
      // a concurrent/second revoke returns the SAME row unchanged.
      if (current.token.revokedAt !== null) return current.token;
      const [updated] = await db
        .update(shareTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(shareTokens.id, id), isNull(shareTokens.revokedAt)))
        .returning();
      return updated ?? current.token;
    },
  };
}

/**
 * Local wrapper-walking unique-violation check (same as the shared helper in
 * repos/shared.ts; kept local so this repo compiles standalone for peers who
 * consume it before the barrel — identical behavior, M6-D precedent).
 */
function isWrappedUniqueViolation(error: unknown): boolean {
  for (let e = error; e !== null && typeof e === "object"; ) {
    const code = (e as { code?: unknown }).code;
    // 23505 = Postgres SQLSTATE; SQLITE_CONSTRAINT_UNIQUE = better-sqlite3
    // dev-dialect twin of the same condition (W3-A).
    if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
