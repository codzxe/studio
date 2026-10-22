// @studio/gateway — /v1/credits (§7.2, §8.8, §9.1 credit_ledger).
//
// Balance = SUM(amount) over the append-only ledger (@studio/db), in integer
// MICROcredits (D-12) — the same units `GET /v1/billing/state` reports. The
// included allowance comes from the plan catalog (entitlementsFor) through the
// resolvePlan seam — never a per-route hardcoded table.

import { Hono } from "hono";

import {
  type CreditsSummary,
  LEDGER_KIND_SCHEMA,
  LEDGER_QUERY_SCHEMA,
  type LedgerEntry,
} from "@studio/contracts";

import { type LedgerEntry as DbLedgerEntry, outstandingReserve } from "@studio/db";

import { entitlementsFor } from "@studio/config";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { resolvePlan } from "../plan.js";
import {
  RECONCILE_REQUEST_SCHEMA,
  createRepoReconcileSources,
  createSpendSource,
  reconcileWindowProblem,
  reconcileWorkspace,
} from "../reconciliation.js";

const RESERVED_SCAN_LIMIT = 500;

/**
 * The outstanding reserve of live runs, folded from the newest ≤500 ledger
 * entries (v1 approximation — a db-side aggregate lands with the billing
 * wave). Shared with `GET /v1/billing/state` so both reads agree exactly.
 */
export async function outstandingReserveForWorkspace(
  deps: GatewayDeps,
  workspaceId: string,
): Promise<number> {
  let cursor: string | null = null;
  const entries: { kind: DbLedgerEntry["kind"]; amount: number }[] = [];
  while (entries.length < RESERVED_SCAN_LIMIT) {
    const result = await deps.repos.ledger.list(workspaceId, { cursor, limit: 100 });
    for (const entry of result.items) {
      entries.push({ kind: entry.kind, amount: entry.amount });
    }
    if (result.nextCursor === null || result.items.length === 0) break;
    cursor = result.nextCursor;
  }
  return outstandingReserve(entries);
}

export function creditsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/credits/*", requireAuth());

  const toEntryDto = (entry: DbLedgerEntry): LedgerEntry => ({
    id: entry.id,
    workspaceId: entry.workspaceId,
    kind: entry.kind,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    runId: entry.runId,
    idempotencyKey: entry.idempotencyKey,
    metadata: (entry.metadata as Record<string, unknown> | null) ?? {},
    createdAt: entry.createdAt.toISOString(),
  });

  app.get("/v1/credits", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const workspaceId = c.get("workspace").id;
    const balance = await deps.repos.ledger.balance(workspaceId);

    const reserved = await outstandingReserveForWorkspace(deps, workspaceId);

    // M6 catalog swap (§M6 task 1): the plan + its monthly allowance come from
    // the subscription row through the resolvePlan seam → the @studio/config
    // catalog — never a route-local table. `purchasedCredits` stays summed at
    // the ledger level (top-up grants raise `balance`); `renewsAt` is null
    // here — `GET /v1/billing/state` carries the period end.
    const plan = await resolvePlan(workspaceId);
    const body: CreditsSummary = {
      balance,
      includedCredits: entitlementsFor(plan).monthlyCreditAllowance,
      purchasedCredits: 0,
      reserved,
      plan,
      renewsAt: null,
    };
    return ok(c, body, 200);
  });

  app.get(
    "/v1/credits/ledger",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const parsed = LEDGER_QUERY_SCHEMA.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Check the pagination parameters.",
          requestId: c.get("requestId"),
        });
      }
      const kind = LEDGER_KIND_SCHEMA.safeParse(c.req.query("kind"));
      const workspaceId = c.get("workspace").id;
      const result = await deps.repos.ledger.list(workspaceId, {
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
        kind: kind.success ? kind.data : undefined,
      });
      return page(c, result.items.map(toEntryDto), result.nextCursor);
    },
  );

  // ── Reconciliation job (BUILD_PLAN §M6 task 3; core in ../reconciliation.ts) ──
  //
  // REPORT-ONLY unless the caller passes { mode: "reconcile" }. Admin role;
  // Idempotency-Key is enforced by the global POST middleware (§7.2). The
  // external spend seam is createSpendSource(deps.env) — null on boxes without
  // LITELLM_SPEND_KEY (the local/test reality), so the job degrades to
  // local-ledger-only reconciliation. Batch/cron callers use
  // runReconciliationSweep() (services/gateway/src/reconciliation.ts header
  // has the operator recipe — no scheduler is wired in v1).
  app.post(
    "/v1/credits/reconcile",
    requireWorkspace("admin"),
    async (c: AppContext): Promise<Response> => {
      const parsed = RECONCILE_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Send sinceTs and uptoTs as ISO-8601 window bounds.",
          requestId: c.get("requestId"),
        });
      }
      const sinceTs = new Date(parsed.data.sinceTs);
      const uptoTs = new Date(parsed.data.uptoTs);
      const problem = reconcileWindowProblem({ sinceTs, uptoTs }, new Date());
      if (problem !== null) {
        throw new GatewayError("VALIDATION_FAILED", problem, {
          status: 400,
          hint: "The window must be ordered, at most 92 days, and end no later than now.",
          requestId: c.get("requestId"),
        });
      }
      const report = await reconcileWorkspace(
        c.get("workspace").id,
        { sinceTs, uptoTs },
        {
          sources: createRepoReconcileSources(deps.repos),
          spend: createSpendSource(deps.env),
          logger: deps.logger,
        },
        { mode: parsed.data.mode, note: parsed.data.note },
      );
      return ok(c, report);
    },
  );

  return app;
}
