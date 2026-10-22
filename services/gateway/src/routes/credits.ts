// @studio/gateway — /v1/credits (§7.2, §8.8, §9.1 credit_ledger).
//
// Balance = SUM(amount) over the append-only ledger (@studio/db). `reserved`
// is the outstanding hold of live runs, computed from the last ≤500 entries
// (v1 approximation — a db-side aggregate lands with the billing wave).

import { Hono } from "hono";

import {
  type CreditsSummary,
  LEDGER_KIND_SCHEMA,
  LEDGER_QUERY_SCHEMA,
  type LedgerEntry,
} from "@studio/contracts";

import { type LedgerEntry as DbLedgerEntry, outstandingReserve } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";

/** §10.1 illustrative monthly credit allowance per plan (stub until billing). */
export const PLAN_MONTHLY_CREDITS: Readonly<Record<string, number>> = Object.freeze({
  trial: 100,
  starter: 1000,
  pro: 3000,
  studio: 8000,
});

const RESERVED_SCAN_LIMIT = 500;

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

    let cursor: string | null = null;
    const entries: { kind: DbLedgerEntry["kind"]; amount: number }[] = [];
    // v1 approximation: the outstanding hold is folded from the newest
    // ≤500 entries (live runs are short-lived). A db-side aggregate lands
    // with the billing wave (FLEET NOTE in the worklog).
    while (entries.length < RESERVED_SCAN_LIMIT) {
      const result = await deps.repos.ledger.list(workspaceId, { cursor, limit: 100 });
      for (const entry of result.items) {
        entries.push({ kind: entry.kind, amount: entry.amount });
      }
      if (result.nextCursor === null || result.items.length === 0) break;
      cursor = result.nextCursor;
    }
    const reserved = outstandingReserve(entries);

    const body: CreditsSummary = {
      balance,
      includedCredits: PLAN_MONTHLY_CREDITS.trial ?? 0,
      purchasedCredits: 0,
      reserved,
      plan: "trial",
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

  return app;
}
