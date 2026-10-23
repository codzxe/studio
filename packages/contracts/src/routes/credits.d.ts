import { z } from "zod";
import type { PlanId } from "../models.js";
import { type Id } from "./common.js";
/** Ledger entry kinds (§9.1 `credit_ledger.kind`): grant|reserve|commit|refund|adjust. */
export declare const LEDGER_KINDS: readonly ["grant", "reserve", "commit", "refund", "adjust"];
export declare const LEDGER_KIND_SCHEMA: z.ZodEnum<{
    grant: "grant";
    reserve: "reserve";
    commit: "commit";
    refund: "refund";
    adjust: "adjust";
}>;
export type LedgerKind = z.infer<typeof LEDGER_KIND_SCHEMA>;
/** `GET /v1/credits` → balance + plan allowance (§7.2). */
export interface CreditsSummary {
    readonly balance: number;
    readonly includedCredits: number;
    readonly purchasedCredits: number;
    /** Currently held by live run reserves (§8.8 reserve → commit → refund). */
    readonly reserved: number;
    readonly plan: PlanId;
    readonly renewsAt: string | null;
}
/** `GET /v1/credits/ledger` query (append-only log, cursor-paginated). */
export declare const LEDGER_QUERY_SCHEMA: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export type LedgerQuery = z.infer<typeof LEDGER_QUERY_SCHEMA>;
/** One append-only ledger row (§9.1; every mutation idempotent via idempotency_key). */
export interface LedgerEntry {
    readonly id: Id;
    readonly workspaceId: Id;
    readonly kind: LedgerKind;
    /** Signed credits delta: negative for reserve/commit spends, positive for grants/refunds. */
    readonly amount: number;
    readonly balanceAfter: number;
    readonly runId: Id | null;
    readonly idempotencyKey: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
}
