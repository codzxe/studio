"use client";

// components/billing/credits-summary — balance + 30-day spend card (W8-K,
// §14/§22): the workspace's current credit balance (GET /v1/credits — the
// derived Σ of every ledger delta, §12.2), credits held by in-flight runs,
// and the rolling 30-day spend from GET /v1/credits/summary. The balance
// and the ledger table share one query key (useCreditsLedger), so the page
// issues a single GET /v1/credits.

import { Zap } from "lucide-react";
import {
  formatCredits,
  useCreditsLedger,
  useCreditsSummary,
  type CreditsSummaryResponse,
} from "./use-billing";

const CARD_CLASS = "rounded-lg border border-border bg-surface";
const ERROR_CLASS = "rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground";
const RETRY_CLASS = "font-medium text-foreground underline underline-offset-2";
const CHIP_CLASS =
  "inline-flex items-center rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium";

export function CreditsSummary() {
  // Same query key as the ledger table → shared cache, one request.
  const ledger = useCreditsLedger();
  const summaryQuery = useCreditsSummary();

  return (
    <section aria-labelledby="credits-summary-heading" className={`${CARD_CLASS} p-5`}>
      <h2 id="credits-summary-heading" className="text-base font-semibold">
        Credits
      </h2>

      {ledger.status === "loading" ? (
        <span role="status" className="sr-only">
          Loading your credit balance…
        </span>
      ) : null}
      <div
        aria-hidden={ledger.status === "loading"}
        className="mt-3 flex flex-wrap items-end gap-6"
      >
        <div>
          <p className="flex items-baseline gap-2">
            <span
              className={
                ledger.status === "loading"
                  ? "inline-block h-9 w-20 animate-pulse rounded bg-surface-muted"
                  : "text-3xl font-semibold tabular-nums"
              }
            >
              {ledger.status === "ready" && ledger.balance !== null
                ? formatCredits(ledger.balance)
                : ""}
            </span>
            {ledger.status === "ready" ? (
              <span className="text-sm text-muted-foreground">credits available</span>
            ) : null}
          </p>
          {ledger.status === "error" ? (
            <p role="status" className="mt-1 max-w-md text-sm text-muted-foreground">
              Couldn&apos;t load your balance — {ledger.message ?? "please try again."}{" "}
              <button type="button" onClick={ledger.retry} className={RETRY_CLASS}>
                Retry
              </button>
            </p>
          ) : null}
        </div>
        <SummaryLine query={summaryQuery} />
      </div>
    </section>
  );
}

function SummaryLine({ query }: { readonly query: ReturnType<typeof useCreditsSummary> }) {
  if (query.isPending) {
    return <p className="text-sm text-muted-foreground">Loading 30-day summary…</p>;
  }
  if (query.isError) {
    return (
      <p role="status" className="max-w-md text-sm text-muted-foreground">
        30-day summary unavailable —{" "}
        {query.error instanceof Error ? query.error.message : "please try again."}{" "}
        <button
          type="button"
          onClick={() => {
            void query.refetch();
          }}
          className={RETRY_CLASS}
        >
          Retry
        </button>
      </p>
    );
  }
  return <SummaryFacts summary={query.data} />;
}

function SummaryFacts({ summary }: { readonly summary: CreditsSummaryResponse }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <span className={CHIP_CLASS}>
        <Zap className="mr-1 size-3.5 text-accent" aria-hidden="true" />
        {formatCredits(summary.spend_credits)} spent in the last {summary.window_days} days
      </span>
      {summary.open_holds > 0 ? (
        <span className={CHIP_CLASS}>{formatCredits(summary.open_holds)} held by active runs</span>
      ) : null}
      {summary.trial ? <span className={CHIP_CLASS}>Trial</span> : null}
    </div>
  );
}
