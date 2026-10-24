"use client";

/**
 * UsageSection — the §8.8 "Usage" card (BUILD_PLAN §M6 task 4; W2-08/W3-H),
 * the one billing section that had no surface: it finally mounts the
 * M6-G `UsageMeters` kit (tested-but-unrendered until now) and adds the
 * per-project renders table plus the cycle ledger summary.
 *
 * Data (three reads, one shared):
 * - `billing.state` (the page already holds it): the ENTITLEMENT side of
 *   every meter — seats, storage, render minutes, monthly credit allowance
 *   (D-12 integer µc). Never pinned plan quotas (BP §M6 task 1).
 * - `credits.ledger`: NO second fetch — the section summarizes the SAME
 *   `useLedgerPages` page the "Credit ledger" card below already loads
 *   (one request, two surfaces). Commits are the spent side of the credits
 *   meter; refunds return reserved-but-unused credits (§8.8), so the meter
 *   uses net committed µc.
 * - `renders.list` (§7.2, newest-first first page): grouped by `projectId`
 *   into the status/format/credits/size table. The section owns this fetch
 *   (loading skeletons, honest empty state, inline error + retry — the
 *   LedgerTable house pattern).
 *
 * Honest windows (manifest W2-08): `billing.state` carries
 * `currentPeriodEnd` but NO period START (routes/billing.ts), so the wire
 * does not carry period bounds and the "within the current period" arm
 * cannot fire. Every window here is therefore labeled "latest" —
 * "Latest renders" / "Latest ledger entries" — never "this cycle".
 *
 * NO storage meter (gateway gap, documented in the worklog): there is no
 * used-bytes read — per-plan `storageBytes` is enforced at upload only.
 * UsageMeters renders a storage (and render-minutes) row by design, so those
 * rows are fed the component's DESIGNED unknown (NaN → "— of 200 GB"), never
 * a fabricated number. The gap is stated in copy, not hidden.
 */

import type {
  BillingState,
  LedgerEntry,
  Page,
  RenderFormat,
  RenderJob,
  RenderStatus,
} from "@studio/contracts";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@studio/ui";
import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { truncateForDisplay } from "./ledger-table";
import { formatCount, formatCredits } from "./page-format";
import { UsageMeters, formatStorageBytes } from "./usage-meters";

// ---------------------------------------------------------------------------
// The api seam — a narrow fetcher the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/**
 * Structurally `client.renders.list` narrowed to the §7.2 cursor query
 * (the LedgerPageFetcher doctrine; tests fake it).
 */
export type UsageRendersFetcher = (query: {
  readonly cursor?: string;
  readonly limit?: number;
}) => Promise<Page<RenderJob>>;

/** How many renders the usage table loads (one §7.2 page, newest first). */
export const RENDERS_USAGE_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Ledger summary — commit/refund totals over the shared ledger page
// ---------------------------------------------------------------------------

/** Commit/refund roll-up over the loaded ledger rows (the honest window). */
export interface LedgerUsageSummary {
  /** Gross committed spend in integer µc (commit amounts are negative). */
  readonly committedMicrocredits: number;
  /** Refunded credits in integer µc (reserve differences + failures, §8.8). */
  readonly refundedMicrocredits: number;
  readonly commitCount: number;
  readonly refundCount: number;
  /**
   * Committed − refunded, floored at 0: the spent side of the credits meter.
   * A refund whose commit sits on an older, unloaded page can never produce
   * a negative "used".
   */
  readonly netCommittedMicrocredits: number;
}

/** Pure roll-up: commits spend, refunds return; hostile amounts count as 0. */
export function summarizeLedgerUsage(entries: readonly LedgerEntry[]): LedgerUsageSummary {
  let committedMicrocredits = 0;
  let refundedMicrocredits = 0;
  let commitCount = 0;
  let refundCount = 0;
  for (const entry of entries) {
    const amount =
      typeof entry.amount === "number" && Number.isFinite(entry.amount) ? entry.amount : 0;
    if (entry.kind === "commit") {
      committedMicrocredits += Math.abs(amount);
      commitCount += 1;
    } else if (entry.kind === "refund") {
      refundedMicrocredits += Math.abs(amount);
      refundCount += 1;
    }
  }
  return {
    committedMicrocredits,
    refundedMicrocredits,
    commitCount,
    refundCount,
    netCommittedMicrocredits: Math.max(0, committedMicrocredits - refundedMicrocredits),
  };
}

// ---------------------------------------------------------------------------
// useUsageRenders — first-page fetch state (the useLedgerPages recipe)
// ---------------------------------------------------------------------------

interface UsageRendersState {
  readonly entries: readonly RenderJob[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly retry: () => void;
}

/** Wire-safe error text: bounded, never a raw dump of a hostile throw. */
function rendersFetchMessage(cause: unknown): string {
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0) {
    return truncateForDisplay(cause.message);
  }
  return "Renders could not be loaded.";
}

/**
 * Loads ONE newest-first `renders.list` page. Race-guarded by a request
 * sequence (only the newest request may write state); `retry` re-fetches
 * from empty — the same contract `useLedgerPages` gives the ledger card.
 */
export function useUsageRenders(
  fetchRenders: UsageRendersFetcher,
  pageSize = RENDERS_USAGE_PAGE_SIZE,
): UsageRendersState {
  const [entries, setEntries] = useState<readonly RenderJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const fetchRef = useRef(fetchRenders);
  fetchRef.current = fetchRenders;

  const fetchFirst = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mySeq = seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchRef.current({ limit: pageSize });
      if (seq.current !== mySeq) return;
      setEntries(result.items);
    } catch (cause) {
      if (seq.current !== mySeq) return;
      setError(rendersFetchMessage(cause));
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }, [pageSize]);

  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst]);

  const retry = useCallback((): void => {
    void fetchFirst();
  }, [fetchFirst]);

  return { entries, loading, error, retry };
}

// ---------------------------------------------------------------------------
// Renders grouping + display (D-11 statuses, D-2 formats, D-12 credits)
// ---------------------------------------------------------------------------

/** One project's slice of the loaded renders page, newest-first. */
export interface ProjectRenderGroup {
  readonly projectId: string;
  readonly renders: readonly RenderJob[];
}

/**
 * Groups the newest-first page by `projectId` (insertion order = the
 * newest-render-first project order). The wire carries no project name on
 * `RenderJob` (projects.list is out of the W2-08 read set), so groups are
 * labeled by a bounded short id — the LedgerTable `shortRunId` precedent.
 */
export function groupRendersByProject(
  renders: readonly RenderJob[],
): readonly ProjectRenderGroup[] {
  const groups: { projectId: string; renders: RenderJob[] }[] = [];
  const byProject = new Map<string, { projectId: string; renders: RenderJob[] }>();
  for (const job of renders) {
    const key =
      typeof job.projectId === "string" && job.projectId.length > 0 ? job.projectId : "unknown";
    let group = byProject.get(key);
    if (group === undefined) {
      group = { projectId: key, renders: [] };
      byProject.set(key, group);
      groups.push(group);
    }
    group.renders.push(job);
  }
  return groups;
}

/** Hostile ids are long: project ids print as a bounded short form. */
function shortProjectId(projectId: string): string {
  return projectId.length <= 16 ? projectId : `${projectId.slice(0, 15)}…`;
}

/**
 * D-11 status chips — MIRRORS `renders-panel.tsx` RENDER_STATUS_CHIPS (the
 * billing kit stays self-contained; the label copy has one source of truth
 * per surface, the page-format/ledger-table precedent).
 */
const RENDER_STATUS_META: Readonly<
  Record<
    RenderStatus,
    {
      readonly label: string;
      readonly tone: "neutral" | "signal" | "success" | "warning" | "danger";
    }
  >
> = {
  queued: { label: "Queued", tone: "warning" },
  running: { label: "Rendering", tone: "signal" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const UNKNOWN_STATUS_META = { label: "Unknown", tone: "neutral" } as const;

/** D-2 format labels — mirrors `renders-panel.tsx` RENDER_FORMAT_LABELS. */
const RENDER_FORMAT_LABELS: Readonly<Record<RenderFormat, string>> = {
  mp4: "MP4",
  prores: "ProRes",
  "png-seq": "PNG sequence",
  gif: "GIF",
  wav: "WAV",
};

const UNKNOWN_FORMAT_LABEL = "Unknown";

/** Whole-credit display number (D-12): `14` → "14", null/poison → "—". */
function formatRenderCredits(credits: number | null): string {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return "—";
  return credits.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Output size (§14 bytes); null until the artifact exists. */
function formatRenderSize(sizeBytes: number | null): string {
  return sizeBytes === null ? "—" : formatStorageBytes(sizeBytes);
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/** The shared ledger slice the page already fetched (no second request). */
export interface UsageLedgerSlice {
  readonly entries: readonly LedgerEntry[];
  readonly loading: boolean;
  readonly error: string | null;
}

export interface UsageSectionProps {
  /** The billing state (entitlements side of every meter). */
  readonly state: BillingState;
  /** Seats in use, when a member-count read exists (absent → honest "—"). */
  readonly seatsUsed?: number;
  /** The ledger page state the "Credit ledger" card owns (shared read). */
  readonly ledger: UsageLedgerSlice;
  /** GET /v1/renders fetcher (§7.2 newest-first page). */
  readonly renders: UsageRendersFetcher;
  /** Top-up CTA on the credits row (§7.11); wire to the top-up flow. */
  readonly onTopUp?: () => void;
  readonly className?: string;
}

const RENDERS_COLUMNS = 4;

function RendersGroupHeader({ group }: { group: ProjectRenderGroup }): ReactElement {
  return (
    <TableRow data-testid="usage-renders-group" data-project-id={group.projectId}>
      <TableCell
        colSpan={RENDERS_COLUMNS}
        className="text-caption uppercase tracking-[0.06em] text-muted"
      >
        Project {shortProjectId(group.projectId)} · {formatCount(group.renders.length)}{" "}
        {group.renders.length === 1 ? "render" : "renders"}
      </TableCell>
    </TableRow>
  );
}

function RendersRow({ job }: { job: RenderJob }): ReactElement {
  const status = RENDER_STATUS_META[job.status] ?? UNKNOWN_STATUS_META;
  const formatLabel =
    job.format in RENDER_FORMAT_LABELS ? RENDER_FORMAT_LABELS[job.format] : UNKNOWN_FORMAT_LABEL;
  return (
    <TableRow data-testid="usage-render-row" data-status={job.status}>
      <TableCell>
        <Badge variant={status.tone} data-testid="usage-render-status">
          {status.label}
        </Badge>
      </TableCell>
      <TableCell data-testid="usage-render-format">{formatLabel}</TableCell>
      <TableCell numeric data-testid="usage-render-credits">
        {formatRenderCredits(job.credits)}
      </TableCell>
      <TableCell numeric data-testid="usage-render-size">
        {formatRenderSize(job.sizeBytes)}
      </TableCell>
    </TableRow>
  );
}

export function UsageSection({
  state,
  seatsUsed,
  ledger,
  renders,
  onTopUp,
  className,
}: UsageSectionProps): ReactElement {
  const rendersState = useUsageRenders(renders);
  const summary = summarizeLedgerUsage(ledger.entries);

  // The meter reads real numbers only: while the ledger page is in flight or
  // failed, the credits row renders its designed unknown ("—"), never 0.
  const ledgerKnown = !ledger.loading && ledger.error === null;
  const creditsUsedMicrocredits = ledgerKnown ? summary.netCommittedMicrocredits : Number.NaN;

  return (
    <Card data-testid="billing-usage" className={className}>
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>
          Credits committed, renders and refunds from this workspace&apos;s latest activity.
        </CardDescription>
      </CardHeader>

      {/* Meters: credits from the ledger page; seats when the page knows the
       * count. Storage and render minutes have NO usage read (the gap note
       * below) — their rows degrade to "—", never a fabricated number. */}
      <UsageMeters
        usage={{
          seatsUsed: seatsUsed ?? Number.NaN,
          storageUsedBytes: Number.NaN,
          renderMinutesUsed: Number.NaN,
          creditsUsedMicrocredits,
        }}
        entitlements={state.entitlements}
        onTopUp={onTopUp}
      />
      <p className="mt-2 text-caption text-muted" data-testid="usage-meter-gap-note">
        Storage and render-minute usage aren&apos;t metered yet — plan limits are enforced per
        upload and per render.
      </p>

      {/* ── Latest renders (per project) ─────────────────────────────── */}
      <h3 className="mt-6 text-body-s font-medium text-primary" data-testid="usage-renders-title">
        Latest renders
      </h3>
      {rendersState.loading && rendersState.entries.length === 0 ? (
        <div data-testid="usage-renders-loading" className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full max-w-[420px]" />
        </div>
      ) : rendersState.error !== null ? (
        <div
          role="alert"
          data-testid="usage-renders-error"
          className="mt-2 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-danger"
          />
          <p className="min-w-0 flex-1">{rendersState.error}</p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="usage-renders-retry"
            onClick={rendersState.retry}
          >
            Try again
          </Button>
        </div>
      ) : rendersState.entries.length === 0 ? (
        <EmptyState data-testid="usage-renders-empty" title="No renders yet." className="py-8" />
      ) : (
        <Table aria-label="Latest renders" data-testid="usage-renders-table" className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Format</TableHead>
              <TableHead numeric>Credits</TableHead>
              <TableHead numeric>Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupRendersByProject(rendersState.entries).map((group) => (
              <RendersGroupRows key={group.projectId} group={group} />
            ))}
          </TableBody>
        </Table>
      )}

      {/* ── Ledger summary (the honest window label) ─────────────────── */}
      <h3 className="mt-6 text-body-s font-medium text-primary" data-testid="usage-ledger-title">
        Latest ledger entries
      </h3>
      {ledger.loading && ledger.entries.length === 0 ? (
        <div data-testid="usage-ledger-loading" className="mt-2 flex flex-col gap-2">
          {/* max-w-full: §12 no-horizontal-scroll at 320px — w-56 (224px)
           * alone overflows the card's 211px content box there by 13px
           * (m9-visual w-billing @320 gate, W1-E; the loading state is
           * user-visible chrome, so the clamp is the page fix, not a
           * spec-side wait). */}
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : ledger.error !== null ? (
        <p className="mt-2 text-body-s text-muted" data-testid="usage-ledger-error">
          The credit ledger could not be loaded — try again from the ledger below.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <dl
            className="grid grid-cols-1 gap-x-8 gap-y-2 text-body-s sm:grid-cols-2"
            data-testid="usage-ledger-summary"
          >
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Committed</dt>
              <dd className="text-secondary tabular-nums" data-testid="usage-ledger-committed">
                {formatCredits(summary.committedMicrocredits)} credits
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Refunded</dt>
              <dd className="text-secondary tabular-nums" data-testid="usage-ledger-refunded">
                {formatCredits(summary.refundedMicrocredits)} credits
              </dd>
            </div>
          </dl>
          <p className="text-caption text-muted" data-testid="usage-ledger-window">
            Commits and refunds across the {formatCount(ledger.entries.length)} newest ledger rows.
          </p>
        </div>
      )}
    </Card>
  );
}

/** One project group: the bounded-id header row + its render rows. */
function RendersGroupRows({ group }: { group: ProjectRenderGroup }): ReactElement {
  return (
    <>
      <RendersGroupHeader group={group} />
      {group.renders.map((job) => (
        <RendersRow key={job.id} job={job} />
      ))}
    </>
  );
}
