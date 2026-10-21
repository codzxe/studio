// @studio/contracts — credits (PRODUCT_ARCHITECTURE.md §7.2, §8.8, §9.1 `credit_ledger`).

import { z } from "zod";

import type { PlanId } from "../models.js";
import { type Id, PAGINATION_QUERY_SCHEMA } from "./common.js";

/** Ledger entry kinds (§9.1 `credit_ledger.kind`): grant|reserve|commit|refund|adjust. */
export const LEDGER_KINDS = [
  "grant",
  "reserve",
  "commit",
  "refund",
  "adjust",
] as const satisfies readonly string[];

export const LEDGER_KIND_SCHEMA = z.enum(LEDGER_KINDS);

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
export const LEDGER_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;

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
