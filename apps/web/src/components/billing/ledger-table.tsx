"use client";

// components/billing/ledger-table — the append-only credit ledger (W8-K,
// §12.2/§14.2): every reserve / commit / refund / grant (plus pack and
// adjustment) with its signed delta, running balance and note, newest
// first. Served by GET /v1/credits as opaque-cursor pages — pages accumulate
// behind the "Load more" button and the query key is shared with the
// credits summary card, so the whole page issues a single first request.
// The ledger is the audit surface: rows are never edited, only appended
// (§12.2), and the newest row's balance_after equals the balance card.

import { LoaderCircle } from "lucide-react";
import {
  formatCredits,
  formatDelta,
  useCreditsLedger,
  type LedgerEntry,
} from "./use-billing";

const CARD_CLASS = "rounded-lg border border-border bg-surface";
const ERROR_CLASS = "rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground";
const EMPTY_CLASS =
  "rounded-lg border border-dashed border-border bg-surface p-4 text-sm text-muted-foreground";
const RETRY_CLASS = "font-medium text-foreground underline underline-offset-2";
const CHIP_CLASS =
  "inline-flex items-center rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium capitalize";
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm font-medium transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// Fixed locale keeps markup identical across server render and hydration.
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

const SKELETON_ROW_IDS = ["row-a", "row-b", "row-c", "row-d"] as const;

export function LedgerTable() {
  const ledger = useCreditsLedger();

  return (
    <section aria-labelledby="ledger-heading">
      <h2 id="ledger-heading" className="text-base font-semibold">
        Credit ledger
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every credit movement in this workspace — reservations, charges, refunds and grants.
      </p>

      <div className="mt-3">
        {ledger.status === "loading" ? (
          <>
            <span role="status" className="sr-only">
              Loading the credit ledger…
            </span>
            <ul aria-hidden="true" className="flex flex-col gap-2">
              {SKELETON_ROW_IDS.map((id) => (
                <li key={id} className="h-10 w-full animate-pulse rounded-md bg-surface-muted" />
              ))}
            </ul>
          </>
        ) : ledger.status === "error" ? (
          <p role="status" className={ERROR_CLASS}>
            Couldn&apos;t load the ledger — {ledger.message ?? "please try again."}{" "}
            <button type="button" onClick={ledger.retry} className={RETRY_CLASS}>
              Retry
            </button>
          </p>
        ) : ledger.rows.length === 0 ? (
          <p className={EMPTY_CLASS}>
            No credit activity yet — trial credits and your first run will appear here.
          </p>
        ) : (
          <LedgerRows ledger={ledger} />
        )}
      </div>
    </section>
  );
}

function LedgerRows({ ledger }: { readonly ledger: ReturnType<typeof useCreditsLedger> }) {
  return (
    <>
      <div className={`${CARD_CLASS} overflow-x-auto`}>
        <table className="w-full min-w-160 border-collapse text-left text-sm">
          <caption className="sr-only">Credit ledger, newest first</caption>
          <thead>
            <tr className="border-b border-border text-xs font-medium text-muted-foreground">
              <th scope="col" className="px-4 py-2.5">
                Date
              </th>
              <th scope="col" className="px-4 py-2.5">
                Kind
              </th>
              <th scope="col" className="px-4 py-2.5 text-right">
                Change
              </th>
              <th scope="col" className="px-4 py-2.5">
                Note
              </th>
              <th scope="col" className="px-4 py-2.5 text-right">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {ledger.rows.map((entry) => (
              <LedgerRow key={entry.id} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
      {ledger.hasMore ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={ledger.loadMore}
            disabled={ledger.loadingMore}
            className={SECONDARY_BUTTON_CLASS}
          >
            {ledger.loadingMore ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Load more
          </button>
        </div>
      ) : null}
    </>
  );
}

function LedgerRow({ entry }: { readonly entry: LedgerEntry }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
        <time dateTime={entry.created_at.toISOString()}>
          {DATE_TIME_FORMAT.format(entry.created_at)}
        </time>
      </td>
      <td className="px-4 py-2.5">
        <KindChip kind={entry.kind} />
      </td>
      <td
        className={
          entry.delta > 0
            ? "px-4 py-2.5 text-right font-medium tabular-nums text-accent"
            : "px-4 py-2.5 text-right font-medium tabular-nums text-foreground"
        }
      >
        {formatDelta(entry.delta)}
      </td>
      <td className="max-w-64 truncate px-4 py-2.5 text-muted-foreground">
        <LedgerNote entry={entry} />
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
        {formatCredits(entry.balance_after)}
      </td>
    </tr>
  );
}

/** Chip for every §14.2 kind the gateway serves; unknown kinds pass through. */
function KindChip({ kind }: { readonly kind: string }) {
  return (
    <span className={CHIP_CLASS} title={`Ledger kind: ${kind}`}>
      {kind.replaceAll("_", " ")}
    </span>
  );
}

function LedgerNote({ entry }: { readonly entry: LedgerEntry }) {
  if (entry.note !== null) {
    return <span title={entry.note}>{entry.note}</span>;
  }
  if (entry.run_id !== null) {
    return (
      <span title={`Run ${entry.run_id}`} className="font-mono text-xs">
        run {entry.run_id.slice(0, 8)}
      </span>
    );
  }
  return <span aria-hidden="true">—</span>;
}
