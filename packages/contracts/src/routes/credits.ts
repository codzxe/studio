// @studio/contracts — credits (PRODUCT_ARCHITECTURE.md §7.2, §8.8, §9.1 `credit_ledger`).

import { z } from "zod";

import type { PlanId } from "../models.js";
import { type Id, ISO8601_SCHEMA, PAGINATION_QUERY_SCHEMA } from "./common.js";

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

// ---------------------------------------------------------------------------
// Reconciliation (BUILD_PLAN §M6 task 3) — POST /v1/credits/reconcile
// ---------------------------------------------------------------------------
//
// W5-09: the request schema moves from the gateway's reconciliation.ts (where
// it was pinned "local to this module — contracts routes are outside this
// task's ownership, law #12") into the wire contracts, so the typed client can
// call the admin route. The gateway keeps a byte-identical local copy until a
// gateway-owner task swaps it for this import (both are strictObjects — if
// they drift, the GATEWAY one is authoritative for what the route accepts).

/**
 * `POST /v1/credits/reconcile` body — an admin true-up over a bounded window
 * (ordered, ≤ 92 days, ending no later than now; the gateway enforces all
 * three). REPORT-ONLY unless `mode: "reconcile"`: the write arm appends ONE
 * idempotent `adjust` entry per (workspace, windowStart).
 */
export const RECONCILE_REQUEST_SCHEMA = z.strictObject({
  sinceTs: ISO8601_SCHEMA,
  uptoTs: ISO8601_SCHEMA,
  mode: z.enum(["report", "reconcile"]).optional(),
  note: z.string().min(1).max(280).optional(),
});

export type ReconcileRequest = z.infer<typeof RECONCILE_REQUEST_SCHEMA>;

/** One run whose committedCredits row disagrees with its own ledger commits. */
export interface ReconcileRunDrift {
  readonly runId: string;
  readonly ledgerCommits: number;
  readonly rowCommitted: number;
}

/** Ledger commit sum ≠ runs+renders usage over the window (§9.1 true-up). */
export interface LedgerUsageMismatch {
  readonly code: "ledger_usage_mismatch";
  readonly ledgerCommitSum: number;
  readonly usageSum: number;
  /** usageSum − ledgerCommitSum (positive: usage beyond what the ledger charged). */
  readonly delta: number;
  readonly runsUsage: number;
  readonly rendersUsage: number;
  readonly runCount: number;
  readonly renderCount: number;
  readonly runDrift: readonly ReconcileRunDrift[];
}

/** A run with outstanding reserve entries that should have settled (§8.8). */
export interface ZombieReserve {
  readonly code: "zombie_reserve";
  readonly runId: string;
  readonly outstanding: number;
  /** ISO timestamp of the run's newest reserve entry. */
  readonly reservedAt: string;
  readonly ageMs: number;
  /** agent_runs.status, or "missing" when the run row is gone (§9.3 cascade). */
  readonly runStatus: string;
}

/** Per-model external spend row (LiteLLM; 0 credits for unmapped aliases). */
export interface ModelSpendRow {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly credits: number;
}

/** Ledger commits ≠ the provider's spend for the window. */
export interface ExternalSpendMismatch {
  readonly code: "external_spend_mismatch";
  readonly ledgerCommitSum: number;
  readonly externalSpendCredits: number;
  readonly delta: number;
  readonly byModel: readonly ModelSpendRow[];
}

/** The ledger went negative — impossible by law #10, always a bug. */
export interface NegativeBalance {
  readonly code: "negative_balance";
  readonly balance: number;
}

export type ReconcileDiscrepancy =
  | LedgerUsageMismatch
  | ZombieReserve
  | ExternalSpendMismatch
  | NegativeBalance;

/** Typed, redacted external-spend failure (fixed human strings, never URLs/keys). */
export interface ReconcileSpendFailure {
  readonly code:
    | "unconfigured"
    | "unreachable"
    | "timeout"
    | "unauthorized"
    | "upstream_error"
    | "bad_response";
  readonly reason: string;
}

/** Σ ledger kinds over the window (positive magnitudes; adjusts signed). */
export interface ReconcileLedgerSums {
  readonly grants: number;
  readonly reserves: number;
  readonly outstandingReserves: number;
  readonly commits: number;
  readonly refunds: number;
  readonly adjusts: number;
  readonly entryCount: number;
}

/** Usage-side sums (runs + renders) for the same window. */
export interface ReconcileUsageSums {
  readonly runs: {
    readonly discovered: number;
    readonly settledInWindow: number;
    readonly committedCredits: number;
  };
  readonly renders: { readonly count: number; readonly credits: number };
  readonly usageSum: number;
}

/** The optional LiteLLM spend section; source "none" when unconfigured. */
export interface ReconcileExternalSection {
  readonly source: "none" | "litellm";
  readonly spendCredits: number | null;
  readonly perModel: readonly ModelSpendRow[];
  readonly unknownModels: readonly string[];
  readonly error: ReconcileSpendFailure | null;
}

/** What the reconcile arm actually did (safe machine reasons when skipped). */
export interface ReconcileActionSection {
  readonly attempted: boolean;
  readonly applied: boolean;
  readonly replayed: boolean;
  readonly adjustAmount: number | null;
  readonly entryId: string | null;
  readonly balanceAfter: number | null;
  /** Safe machine reason the action did not land ("report_only", "no_mismatch", …). */
  readonly skippedReason: string | null;
}

/** `POST /v1/credits/reconcile` response (admin; mirrors the gateway report). */
export interface ReconcileReport {
  readonly workspaceId: string;
  readonly window: { readonly sinceTs: string; readonly uptoTs: string };
  readonly mode: "report" | "reconcile";
  readonly ledger: ReconcileLedgerSums;
  readonly usage: ReconcileUsageSums;
  readonly balance: number;
  readonly discrepancies: readonly ReconcileDiscrepancy[];
  readonly external: ReconcileExternalSection;
  readonly action: ReconcileActionSection;
  readonly scan: { readonly truncated: boolean; readonly scannedEntries: number };
  readonly generatedAt: string;
}
