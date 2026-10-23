import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { type Executor, getDialect, type StudioDb, type StudioTx } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { deriveIdempotencyKey, outstandingReserve, planSettlement } from "../ledger-math.js";
import type { LedgerEntry, LedgerKind } from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

/**
 * Credit ledger repository — §8.8 / §10.2.
 *
 * Balance strategy (documented decision):
 *   There is NO denormalized `credit_balances` row. `balance(workspaceId)` is
 *   SUM(amount) over the append-only ledger. Every mutating operation runs in
 *   a transaction that FIRST takes a per-workspace Postgres advisory lock
 *   (`pg_advisory_xact_lock(hashtext(workspace_id))`), then reads the sum,
 *   appends one entry with `balanceAfter`. This serializes all ledger writers
 *   for a workspace without extra tables and keeps read-only `balance()` a
 *   single indexed SUM. A 32-bit hash collision between two workspace ids
 *   could only over-serialize (never under-serialize) — harmless.
 *
 * Idempotency: `idempotencyKey` is globally UNIQUE. Replaying an operation
 *   with the same key returns the original entry (`replayed: true`) instead of
 *   double-charging. A key reused for a *different* workspace/shape is a
 *   typed CONFLICT.
 *
 * Sign conventions (see schema.ts Section 7): grant +N, adjust ±N,
 * reserve −N, commit −M, refund +R. On success a run nets −actual_cost;
 * on failure/cancel it nets 0 (full refund) — §8.8.
 *
 * Producer scope (M8-A): an entry is scoped to a RUN (`runId`) or a RENDER
 * (`renderId`) — never both. The XOR is enforced HERE (repo layer), not in
 * the DB: a CHECK over two nullable columns would be the only schema-level
 * option, and run-scoped rows legitimately leave render_id NULL (and vice
 * versa). `grant`/`adjust` may also be unscoped (top-ups have no producer);
 * hold operations (reserve/commit/refund/settle/refundAll) require exactly
 * one producer scope.
 */

/** M8-A: producer scope of a ledger entry — run XOR render (repo-enforced). */
export interface LedgerScope {
  readonly runId?: string | null;
  readonly renderId?: string | null;
}

export interface GrantInput {
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly runId?: string | null;
  /** M8-A: render-scoped grant (XOR with runId). */
  readonly renderId?: string | null;
  readonly metadata?: unknown;
}

export interface ReserveInput extends LedgerScope {
  /** The hold size — use computeReserveAmount() upstream (§8.8). */
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly metadata?: unknown;
}

export interface CommitInput extends LedgerScope {
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly metadata?: unknown;
}

export interface RefundInput extends LedgerScope {
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly metadata?: unknown;
}

export interface SettleInput extends LedgerScope {
  readonly actualCost: number;
  readonly idempotencyKey: string;
  readonly metadata?: unknown;
}

export interface AdjustInput {
  readonly amount: number; // may be negative (clawback / correction)
  readonly idempotencyKey: string;
  readonly runId?: string | null;
  /** M8-A: render-scoped adjustment (XOR with runId). */
  readonly renderId?: string | null;
  readonly metadata?: unknown;
  readonly allowNegativeBalance?: boolean;
}

export interface LedgerResult {
  readonly entry: LedgerEntry;
  readonly replayed: boolean;
}

export interface SettleResult {
  readonly commit: LedgerEntry | null;
  readonly refund: LedgerEntry | null;
  readonly replayed: boolean;
}

export interface RefundAllResult {
  readonly entry: LedgerEntry | null;
  readonly refunded: number;
}

export interface LedgerListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly kind?: LedgerKind;
  readonly runId?: string;
  /** M8-A: filter render-scoped entries (render history credits). */
  readonly renderId?: string;
}

export interface LedgerRepo {
  grant(workspaceId: WorkspaceId, input: GrantInput): Promise<LedgerResult>;
  reserve(workspaceId: WorkspaceId, input: ReserveInput): Promise<LedgerResult>;
  commit(workspaceId: WorkspaceId, input: CommitInput): Promise<LedgerResult>;
  refund(workspaceId: WorkspaceId, input: RefundInput): Promise<LedgerResult>;
  /** Atomic success path: commit actual + refund remainder of the hold. */
  settle(workspaceId: WorkspaceId, input: SettleInput): Promise<SettleResult>;
  /** Failure/cancel path: refund the producer's full outstanding hold. */
  refundAll(
    workspaceId: WorkspaceId,
    input: LedgerScope & { idempotencyKey: string; metadata?: unknown },
  ): Promise<RefundAllResult>;
  adjust(workspaceId: WorkspaceId, input: AdjustInput): Promise<LedgerResult>;
  balance(workspaceId: WorkspaceId): Promise<number>;
  list(workspaceId: WorkspaceId, options?: LedgerListOptions): Promise<Page<LedgerEntry>>;
  getEntryByIdempotencyKey(
    workspaceId: WorkspaceId,
    idempotencyKey: string,
  ): Promise<LedgerEntry | null>;
}

async function balanceUnderLock(exec: Executor, workspaceId: WorkspaceId): Promise<number> {
  // Dialect-aware tables (W3-A): the pg table carries now() defaults that
  // sqlite cannot execute; every repo resolves its tables per handle.
  const { creditLedger } = tablesFor(exec);
  const [row] = await exec
    .select({ total: sql<string>`coalesce(sum(${creditLedger.amount}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.workspaceId, workspaceId));
  return Number(row?.total ?? 0);
}

/** Outstanding (un-consumed) hold of ONE producer scope — its run OR its render. */
async function scopeOutstanding(
  exec: Executor,
  workspaceId: WorkspaceId,
  scope: NormalizedScope,
): Promise<number> {
  const { creditLedger } = tablesFor(exec);
  const filter =
    scope.runId !== null
      ? eq(creditLedger.runId, scope.runId)
      : eq(creditLedger.renderId, scope.renderId);
  const rows = await exec
    .select({ kind: creditLedger.kind, amount: creditLedger.amount })
    .from(creditLedger)
    .where(and(eq(creditLedger.workspaceId, workspaceId), filter));
  return outstandingReserve(rows);
}

/** Exactly one producer — the discriminated result of scope normalization. */
export type NormalizedScope =
  | { readonly runId: string; readonly renderId: null }
  | { readonly runId: null; readonly renderId: string };

type OptionalNormalizedScope = NormalizedScope | { readonly runId: null; readonly renderId: null };

/**
 * M8-A scope normalization — a ledger entry is scoped to at most ONE
 * producer (run XOR render); unscoped is legal (top-up grants, adjustments).
 */
function optionalScope(scope: LedgerScope): OptionalNormalizedScope {
  const runId = scope.runId?.trim() || null;
  const renderId = scope.renderId?.trim() || null;
  if (runId !== null && renderId !== null) {
    throw DbError.validation("A ledger entry is scoped to exactly one of runId or renderId");
  }
  if (runId !== null) return { runId, renderId: null };
  if (renderId !== null) return { runId: null, renderId };
  return { runId: null, renderId: null };
}

/** Scope for hold operations — exactly ONE producer required. */
function requireScope(scope: LedgerScope): NormalizedScope {
  const normalized = optionalScope(scope);
  if (normalized.runId === null && normalized.renderId === null) {
    throw DbError.validation("A hold requires a producer scope: pass runId or renderId");
  }
  return normalized;
}

async function findExisting(exec: Executor, idempotencyKey: string): Promise<LedgerEntry | null> {
  const { creditLedger } = tablesFor(exec);
  const [row] = await exec
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

interface AppendArgs {
  readonly workspaceId: WorkspaceId;
  readonly kind: LedgerKind;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly runId?: string | null;
  readonly renderId?: string | null;
  readonly idempotencyKey: string;
  readonly metadata?: unknown;
}

async function appendEntry(exec: Executor, args: AppendArgs): Promise<LedgerEntry> {
  const { creditLedger } = tablesFor(exec);
  const [entry] = await exec
    .insert(creditLedger)
    .values({
      id: createId("led"),
      workspaceId: args.workspaceId,
      kind: args.kind,
      amount: args.amount,
      balanceAfter: args.balanceAfter,
      runId: args.runId ?? null,
      renderId: args.renderId ?? null,
      idempotencyKey: args.idempotencyKey,
      metadata: args.metadata,
    })
    .returning();
  if (!entry) throw DbError.conflict("Could not append ledger entry");
  return entry;
}

/** Serialize ledger writers per workspace, then run `fn` inside the tx. */
function withWorkspaceLock<T>(
  db: StudioDb,
  workspaceId: WorkspaceId,
  fn: (tx: StudioTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Postgres: cross-connection writer serialization. SQLite dev server:
    // better-sqlite3 is ONE serialized connection — writers are serialized by
    // construction, so the advisory lock is skipped (it does not exist there).
    if (getDialect(db) === "postgres") {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
    }
    return fn(tx);
  });
}

export function createLedgerRepo(db: StudioDb): LedgerRepo {
  const { creditLedger } = tablesFor(db);
  return {
    async grant(workspaceId, input) {
      requireNonEmpty(input.idempotencyKey, "idempotencyKey");
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        throw DbError.validation("grant amount must be a positive integer");
      }
      const scope = optionalScope(input); // M8-A: run XOR render, or unscoped
      return withWorkspaceLock(db, workspaceId, async (tx) => {
        const existing = await findExisting(tx, input.idempotencyKey);
        if (existing) {
          if (existing.workspaceId !== workspaceId) {
            throw DbError.conflict("Idempotency key already used by another workspace");
          }
          return { entry: existing, replayed: true };
        }
        const balance = await balanceUnderLock(tx, workspaceId);
        const entry = await appendEntry(tx, {
          workspaceId,
          kind: "grant",
          amount: input.amount,
          balanceAfter: balance + input.amount,
          ...scope,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });
        return { entry, replayed: false };
      });
    },

    async reserve(workspaceId, input) {
      const scope = requireScope(input); // M8-A: exactly one producer
      requireNonEmpty(input.idempotencyKey, "idempotencyKey");
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        throw DbError.validation("reserve amount must be a positive integer (≥ 1, §8.8)");
      }
      return withWorkspaceLock(db, workspaceId, async (tx) => {
        const existing = await findExisting(tx, input.idempotencyKey);
        if (existing) {
          if (existing.workspaceId !== workspaceId) {
            throw DbError.conflict("Idempotency key already used by another workspace");
          }
          return { entry: existing, replayed: true };
        }
        const balance = await balanceUnderLock(tx, workspaceId);
        if (balance < input.amount) {
          // §8.8: never start a run/render on insufficient credits.
          throw DbError.insufficientCredits({ required: input.amount, available: balance });
        }
        const entry = await appendEntry(tx, {
          workspaceId,
          kind: "reserve",
          amount: -input.amount,
          balanceAfter: balance - input.amount,
          ...scope,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });
        return { entry, replayed: false };
      });
    },

    async commit(workspaceId, input) {
      const scope = requireScope(input); // M8-A: exactly one producer
      requireNonEmpty(input.idempotencyKey, "idempotencyKey");
      if (!Number.isInteger(input.amount) || input.amount < 0) {
        throw DbError.validation("commit amount must be a non-negative integer");
      }
      return withWorkspaceLock(db, workspaceId, async (tx) => {
        const existing = await findExisting(tx, input.idempotencyKey);
        if (existing) {
          if (existing.workspaceId !== workspaceId) {
            throw DbError.conflict("Idempotency key already used by another workspace");
          }
          return { entry: existing, replayed: true };
        }
        const outstanding = await scopeOutstanding(tx, workspaceId, scope);
        if (input.amount > outstanding) {
          throw DbError.validation(
            `commit (${input.amount}) exceeds the scope's outstanding reserve (${outstanding})`,
            "Use ledger.settle() or adjust the reserve first.",
          );
        }
        const balance = await balanceUnderLock(tx, workspaceId);
        const entry = await appendEntry(tx, {
          workspaceId,
          kind: "commit",
          amount: -input.amount,
          balanceAfter: balance - input.amount,
          ...scope,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });
        return { entry, replayed: false };
      });
    },

    async refund(workspaceId, input) {
      const scope = requireScope(input); // M8-A: exactly one producer
      requireNonEmpty(input.idempotencyKey, "idempotencyKey");
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        throw DbError.validation("refund amount must be a positive integer");
      }
      return withWorkspaceLock(db, workspaceId, async (tx) => {
        const existing = await findExisting(tx, input.idempotencyKey);
        if (existing) {
          if (existing.workspaceId !== workspaceId) {
            throw DbError.conflict("Idempotency key already used by another workspace");
          }
          return { entry: existing, replayed: true };
        }
        const outstanding = await scopeOutstanding(tx, workspaceId, scope);
        if (input.amount > outstanding) {
          throw DbError.validation(
            `refund (${input.amount}) exceeds the scope's outstanding reserve (${outstanding})`,
          );
        }
        const balance = await balanceUnderLock(tx, workspaceId);
        const entry = await appendEntry(tx, {
          workspaceId,
          kind: "refund",
          amount: input.amount,
          balanceAfter: balance + input.amount,
          ...scope,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });
        return { entry, replayed: false };
      });
    },

    async settle(workspaceId, input) {
      const scope = requireScope(input); // M8-A: exactly one producer
      requireNonEmpty(input.idempotencyKey, "idempotencyKey");
      if (!Number.isInteger(input.actualCost) || input.actualCost < 0) {
        throw DbError.validation("actualCost must be a non-negative integer");
      }
      const commitKey = deriveIdempotencyKey(input.idempotencyKey, "commit");
      const refundKey = deriveIdempotencyKey(input.idempotencyKey, "refund");
      return withWorkspaceLock(db, workspaceId, async (tx) => {
        const existingCommit = await findExisting(tx, commitKey);
        if (existingCommit) return { commit: existingCommit, refund: null, replayed: true };

        const outstanding = await scopeOutstanding(tx, workspaceId, scope);
        const plan = planSettlement(outstanding, input.actualCost);
        const balance = await balanceUnderLock(tx, workspaceId);

        let commitEntry: LedgerEntry | null = null;
        let refundEntry: LedgerEntry | null = null;
        if (plan.commit > 0) {
          commitEntry = await appendEntry(tx, {
            workspaceId,
            kind: "commit",
            amount: -plan.commit,
            balanceAfter: balance - plan.commit,
            ...scope,
            idempotencyKey: commitKey,
            metadata: input.metadata,
          });
        }
        if (plan.refund > 0) {
          refundEntry = await appendEntry(tx, {
            workspaceId,
            kind: "refund",
            amount: plan.refund,
            balanceAfter: balance - plan.commit + plan.refund,
            ...scope,
            idempotencyKey: refundKey,
            metadata: input.metadata,
          });
        }
        return { commit: commitEntry, refund: refundEntry, replayed: false };
      });
    },

    async refundAll(workspaceId, input) {
      const scope = requireScope(input); // M8-A: exactly one producer
      requireNonEmpty(input.idempotencyKey, "idempotencyKey");
      return withWorkspaceLock(db, workspaceId, async (tx) => {
        const existing = await findExisting(tx, input.idempotencyKey);
        if (existing) {
          return { entry: existing, refunded: existing.amount, replayed: true };
        }
        const outstanding = await scopeOutstanding(tx, workspaceId, scope);
        if (outstanding === 0) return { entry: null, refunded: 0 };
        const balance = await balanceUnderLock(tx, workspaceId);
        const entry = await appendEntry(tx, {
          workspaceId,
          kind: "refund",
          amount: outstanding,
          balanceAfter: balance + outstanding,
          ...scope,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });
        return { entry, refunded: outstanding, replayed: false };
      });
    },

    async adjust(workspaceId, input) {
      requireNonEmpty(input.idempotencyKey, "idempotencyKey");
      if (!Number.isInteger(input.amount) || input.amount === 0) {
        throw DbError.validation("adjust amount must be a non-zero integer");
      }
      const scope = optionalScope(input); // M8-A: run XOR render, or unscoped
      return withWorkspaceLock(db, workspaceId, async (tx) => {
        const existing = await findExisting(tx, input.idempotencyKey);
        if (existing) {
          if (existing.workspaceId !== workspaceId) {
            throw DbError.conflict("Idempotency key already used by another workspace");
          }
          return { entry: existing, replayed: true };
        }
        const balance = await balanceUnderLock(tx, workspaceId);
        const after = balance + input.amount;
        if (after < 0 && !input.allowNegativeBalance) {
          throw DbError.validation(
            `adjustment would make the balance negative (${after}); pass allowNegativeBalance for clawbacks`,
          );
        }
        const entry = await appendEntry(tx, {
          workspaceId,
          kind: "adjust",
          amount: input.amount,
          balanceAfter: after,
          ...scope,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });
        return { entry, replayed: false };
      });
    },

    async balance(workspaceId) {
      // Read-only: single indexed SUM; consistency per-entry is guaranteed by
      // the advisory-locked writers (balanceAfter chain).
      return balanceUnderLock(db, workspaceId);
    },

    async list(workspaceId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select()
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.workspaceId, workspaceId),
            options?.kind === undefined ? undefined : eq(creditLedger.kind, options.kind),
            options?.runId === undefined ? undefined : eq(creditLedger.runId, options.runId),
            options?.renderId === undefined
              ? undefined
              : eq(creditLedger.renderId, options.renderId),
            cursor
              ? or(
                  lt(creditLedger.createdAt, new Date(cursor.t)),
                  and(
                    eq(creditLedger.createdAt, new Date(cursor.t)),
                    lt(creditLedger.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async getEntryByIdempotencyKey(workspaceId, idempotencyKey) {
      const [row] = await db
        .select()
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.workspaceId, workspaceId),
            eq(creditLedger.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
