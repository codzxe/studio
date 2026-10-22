"use client";

/**
 * LedgerTable — the §8.8 billing "Credits → ledger" surface (BUILD_PLAN §M6
 * task 4 "ledger table"; credit_ledger §9.1).
 *
 * Wire truth (D-12): every `amount` / `balanceAfter` on `LedgerEntry` is an
 * integer MICROcredit (1 credit = 1,000,000 µc; `GET /v1/credits/ledger`).
 * This module owns the UI-side of the route-boundary conversion: µc → whole
 * credits with up to 2 decimals, comma-grouped (UI_DS §14 "1,200 with
 * commas"), never a raw float. The math mirrors `@studio/config`
 * `microcreditsToCredits` (`Math.round(µc / 10_000) / 100`) but never throws —
 * display code degrades hostile numbers to "—" instead of crashing.
 *
 * Hostile-data safety (law #1 spirit, applied to props): every string that
 * reaches the DOM is bounded (`truncateForDisplay`), nothing from
 * `metadata` / `idempotencyKey` / `workspaceId` is ever rendered, unknown
 * `kind` values fall back to a neutral badge, and there is no raw-HTML path
 * anywhere (React text nodes only).
 *
 * Composition (M6-F): `LedgerTable` is a pure view (the house model-picker
 * pattern — the page owns fetching), plus an optional `useLedgerPages` hook
 * that manages cursor state against any `client.credits.ledger`-shaped
 * fetcher. Either wiring is sanctioned:
 *   const ledger = useLedgerPages((q) => client.credits.ledger(q));
 *   <LedgerTable {...ledger} onLoadMore={...} /> // hook wires loadMore/retry
 *
 * Exported surface (binding for M6-F):
 *   LedgerTableProps + LedgerTable
 *   LedgerPageFetcher + LedgerPagesState + useLedgerPages
 *   microcreditsToCreditsDisplay / formatCreditsDisplay / formatSignedCredits /
 *   formatLedgerTimestamp / truncateForDisplay / MICRO_CREDITS_PER_CREDIT
 */

import type { LedgerEntry, Page } from "@studio/contracts";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@studio/ui";
import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// D-12 display math (µc → credits, ≤2 decimals) — shared across the kit
// ---------------------------------------------------------------------------

/** 1 credit = 1,000,000 µc (D-12). Local pin; `@studio/config` is server truth. */
export const MICRO_CREDITS_PER_CREDIT = 1_000_000;

/** Max characters any ledger-derived string may occupy in the DOM. */
const MAX_DISPLAY_STRING = 200;

/**
 * Integer microcredits → credits number with ≤2 decimals (D-12 display rule:
 * `Math.round(µc / 10_000) / 100`, sign preserved for spend rows). Never
 * throws: non-finite input returns `null` and renders as "—".
 */
export function microcreditsToCreditsDisplay(microcredits: number): number | null {
  if (!Number.isFinite(microcredits)) return null;
  // Fractional µc is hostile (the wire is integer-only per D-12): normalize
  // to the nearest integer µc before the 2-decimal credit rounding.
  const micro = Math.round(microcredits);
  return Math.round(micro / 10_000) / 100;
}

/** Locale-grouped credits with exactly 2 decimals; `null` → "—" (hostile). */
export function formatCreditsDisplay(credits: number | null): string {
  if (credits === null || !Number.isFinite(credits)) return "—";
  return credits.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Signed delta for the Amount column: "+2,000.00" / "-1.20"; `null` → "—". */
export function formatSignedCredits(credits: number | null): string {
  if (credits === null || !Number.isFinite(credits)) return "—";
  const body = formatCreditsDisplay(Math.abs(credits));
  return credits < 0 ? `-${body}` : `+${body}`;
}

/**
 * Ledger timestamps: "Oct 21, 2026, 14:32" (UI_DS §14 date style + time for a
 * money log). Pinned to UTC so the display is deterministic everywhere;
 * invalid/hostile ISO strings degrade to "—".
 */
const LEDGER_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatLedgerTimestamp(iso: string): string {
  if (typeof iso !== "string" || iso.length === 0) return "—";
  const date = new Date(iso.length > 100 ? iso.slice(0, 100) : iso);
  if (Number.isNaN(date.getTime())) return "—";
  return LEDGER_DATE_FORMAT.format(date);
}

/** Hard string bound for anything rendered from wire data. */
export function truncateForDisplay(value: string, max = MAX_DISPLAY_STRING): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Kind badges (§7.8): one distinct tone per ledger kind, never colour-only —
// the label text carries the meaning.
// ---------------------------------------------------------------------------

interface LedgerKindMeta {
  readonly variant: "neutral" | "signal" | "success" | "warning" | "danger" | "ice";
  readonly label: string;
}

const LEDGER_KIND_META: Readonly<Record<string, LedgerKindMeta>> = {
  grant: { variant: "success", label: "Grant" },
  reserve: { variant: "ice", label: "Reserve" },
  commit: { variant: "neutral", label: "Commit" },
  refund: { variant: "signal", label: "Refund" },
  adjust: { variant: "warning", label: "Adjust" },
};

const UNKNOWN_KIND_META: LedgerKindMeta = { variant: "neutral", label: "Entry" };

/** Hostile ids are long: run ids print as a bounded short form ("run_1a2b…"). */
function shortRunId(runId: string): string {
  return runId.length <= 16 ? runId : `${runId.slice(0, 15)}…`;
}

// ---------------------------------------------------------------------------
// LedgerTable (pure view)
// ---------------------------------------------------------------------------

export interface LedgerTableProps {
  /** Accumulated rows, newest first (the wire order — `credit_ledger.list`). */
  readonly entries: readonly LedgerEntry[];
  /** Next-older page cursor; `null` = the log ends here. */
  readonly nextCursor?: string | null;
  /** Any ledger fetch (first page or load-more) is in flight. */
  readonly loading?: boolean;
  /** Human-safe inline error; rendering bounds it to 200 chars. */
  readonly error?: string | null;
  /** Absent = pagination controls are hidden (fully controlled pages). */
  readonly onLoadMore?: (cursor: string) => void;
  /** Retry after an error; absent = the Try again action is hidden. */
  readonly onRetry?: () => void;
  readonly className?: string;
}

const COLUMNS = 5;

function LedgerRow({ entry }: { entry: LedgerEntry }): ReactElement {
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  const meta = LEDGER_KIND_META[kind] ?? UNKNOWN_KIND_META;
  const runId = typeof entry.runId === "string" && entry.runId.length > 0 ? entry.runId : null;

  return (
    <TableRow data-testid="ledger-row" data-kind={kind}>
      <TableCell>
        <Badge variant={meta.variant} data-testid="ledger-row-kind">
          {kind in LEDGER_KIND_META ? meta.label : truncateForDisplay(kind, 12) || meta.label}
        </Badge>
      </TableCell>
      <TableCell numeric data-testid="ledger-row-amount">
        {formatSignedCredits(microcreditsToCreditsDisplay(entry.amount))}
      </TableCell>
      <TableCell numeric data-testid="ledger-row-balance">
        {formatCreditsDisplay(microcreditsToCreditsDisplay(entry.balanceAfter))}
      </TableCell>
      <TableCell>
        {runId === null ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="tabular text-caption" data-testid="ledger-row-run">
            {shortRunId(runId)}
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">{formatLedgerTimestamp(entry.createdAt)}</TableCell>
    </TableRow>
  );
}

export function LedgerTable({
  entries,
  nextCursor = null,
  loading = false,
  error = null,
  onLoadMore,
  onRetry,
  className,
}: LedgerTableProps): ReactElement {
  const canLoadMore = nextCursor !== null && onLoadMore !== undefined;
  const atEnd = !loading && nextCursor === null && entries.length > 0;

  return (
    <section data-testid="ledger-table" className={className}>
      {error ? (
        <div
          role="alert"
          data-testid="ledger-error"
          className="mb-2 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-danger"
          />
          <p className="min-w-0 flex-1">{truncateForDisplay(error)}</p>
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="ledger-error-retry"
              disabled={loading}
              onClick={onRetry}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      <Table stickyHeader aria-label="Credit ledger" data-testid="ledger-table-grid">
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead numeric>Amount</TableHead>
            <TableHead numeric>Balance</TableHead>
            <TableHead>Run</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 ? (
            <TableEmpty colSpan={COLUMNS} data-testid="ledger-empty">
              {loading ? "Loading the ledger…" : "No credit activity yet."}
            </TableEmpty>
          ) : (
            entries.map((entry, index) => <LedgerRow key={`${entry.id}-${index}`} entry={entry} />)
          )}
        </TableBody>
      </Table>

      {canLoadMore || atEnd ? (
        <div className="mt-3 flex items-center justify-center gap-3">
          {canLoadMore ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="ledger-load-more"
              loading={loading}
              disabled={loading}
              onClick={() => {
                if (nextCursor !== null && onLoadMore !== undefined) onLoadMore(nextCursor);
              }}
            >
              Load more
            </Button>
          ) : (
            <p data-testid="ledger-end" className="text-caption text-muted">
              That’s the whole ledger.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// useLedgerPages — cursor pagination state for any ledger-shaped fetcher
// ---------------------------------------------------------------------------

/** Structurally `client.credits.ledger` (`LedgerQueryInput → Page<LedgerEntry>`). */
export type LedgerPageFetcher = (query: {
  readonly cursor?: string;
  readonly limit?: number;
}) => Promise<Page<LedgerEntry>>;

export interface LedgerPagesState {
  readonly entries: readonly LedgerEntry[];
  readonly nextCursor: string | null;
  /** First page in flight (mount / reload / retry-from-empty). */
  readonly loading: boolean;
  /** A load-more page in flight. */
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly reload: () => void;
}

/** Wire-safe error text: bounded, never a raw dump of a hostile throw. */
function ledgerFetchMessage(cause: unknown): string {
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0) {
    return truncateForDisplay(cause.message);
  }
  return "The ledger could not be loaded.";
}

/**
 * Cursor-pagination state for the ledger. Race-guarded by a request sequence:
 * only the newest request may write state, so a stale response (reload wins
 * over an in-flight load-more, or vice versa) is dropped. `loadMore` is
 * replay-safe: it no-ops while any fetch is in flight, so a double click can
 * never double-fetch a page.
 */
export function useLedgerPages(
  fetchPage: LedgerPageFetcher,
  options?: { readonly pageSize?: number },
): LedgerPagesState {
  const pageSize = options?.pageSize ?? 50;

  const [entries, setEntries] = useState<readonly LedgerEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const fetchFirst = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mySeq = seq.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const result = await fetchRef.current({ limit: pageSize });
      if (seq.current !== mySeq) return;
      setEntries(result.items);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (seq.current !== mySeq) return;
      setError(ledgerFetchMessage(cause));
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }, [pageSize]);

  const loadMore = useCallback((): void => {
    if (loading || loadingMore) return;
    const cursor = nextCursor;
    if (cursor === null) return;
    seq.current += 1;
    const mySeq = seq.current;
    setLoadingMore(true);
    setError(null);
    void (async () => {
      try {
        const result = await fetchRef.current({ cursor, limit: pageSize });
        if (seq.current !== mySeq) return;
        setEntries((current) => [...current, ...result.items]);
        setNextCursor(result.nextCursor);
      } catch (cause) {
        if (seq.current !== mySeq) return;
        setError(ledgerFetchMessage(cause));
      } finally {
        if (seq.current === mySeq) setLoadingMore(false);
      }
    })();
  }, [loading, loadingMore, nextCursor, pageSize]);

  const retry = useCallback((): void => {
    if (entries.length === 0) void fetchFirst();
    else loadMore();
  }, [entries.length, fetchFirst, loadMore]);

  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst]);

  return { entries, nextCursor, loading, loadingMore, error, loadMore, retry, reload: fetchFirst };
}
