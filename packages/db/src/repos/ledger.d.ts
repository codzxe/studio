import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type LedgerEntry, type LedgerKind } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
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
    readonly amount: number;
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
    refundAll(workspaceId: WorkspaceId, input: LedgerScope & {
        idempotencyKey: string;
        metadata?: unknown;
    }): Promise<RefundAllResult>;
    adjust(workspaceId: WorkspaceId, input: AdjustInput): Promise<LedgerResult>;
    balance(workspaceId: WorkspaceId): Promise<number>;
    list(workspaceId: WorkspaceId, options?: LedgerListOptions): Promise<Page<LedgerEntry>>;
    getEntryByIdempotencyKey(workspaceId: WorkspaceId, idempotencyKey: string): Promise<LedgerEntry | null>;
}
/** Exactly one producer — the discriminated result of scope normalization. */
export type NormalizedScope = {
    readonly runId: string;
    readonly renderId: null;
} | {
    readonly runId: null;
    readonly renderId: string;
};
export declare function createLedgerRepo(db: StudioDb): LedgerRepo;
