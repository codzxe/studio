"use client";

// apps/web — verdict cards (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §11.1  validate.report — deterministic validator outcome; issues by level
//          (blockers / majors / minors), zero blockers = pass.
//   §11.2  critique.report — six scores + ≤5 issues; only blocker/major issues
//          drive repairs (revise verdicts).
//   §24.4  failure card — typed error code/message/hint; a one-click retry
//          (new run, same brief) when the failure is retryable.
//
// All three are optimistic: while the run is active and no report has
// arrived, they render skeletons; a terminal run without a report says so.

import { RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { CritiqueReportPayload, RunFailure, ValidateReportPayload } from "./timeline-state";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function CardShell({
  title,
  badge,
  children,
}: {
  readonly title: string;
  readonly badge: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

function WaitingBody({ label }: { readonly label: string }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="h-2 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function EmptyBody({ label }: { readonly label: string }) {
  return <p className="mt-3 text-sm text-muted-foreground">{label}</p>;
}

// ---------------------------------------------------------------------------
// §11.1 validator verdict
// ---------------------------------------------------------------------------

export interface ValidateVerdictCardProps {
  readonly report: ValidateReportPayload | null;
  readonly terminal: boolean;
}

const VALIDATE_LEVELS = [
  { key: "blockers", label: "Blockers", chip: "border-red-200 bg-red-50 text-red-700" },
  { key: "majors", label: "Majors", chip: "border-amber-200 bg-amber-50 text-amber-700" },
  { key: "minors", label: "Minors", chip: "border-zinc-200 bg-zinc-50 text-zinc-600" },
] as const;

export function ValidateVerdictCard({ report, terminal }: ValidateVerdictCardProps) {
  if (report === null) {
    return (
      <CardShell
        title="Validation"
        badge={
          <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Pending
          </span>
        }
      >
        {terminal ? (
          <EmptyBody label="No validation report was recorded." />
        ) : (
          <WaitingBody label="Waiting for the validator…" />
        )}
      </CardShell>
    );
  }

  const totalIssues = report.blockers.length + report.majors.length + report.minors.length;

  return (
    <CardShell
      title="Validation"
      badge={
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
            report.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {report.ok ? "Passed" : "Failed"}
        </span>
      }
    >
      {totalIssues === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          The document passed every check with no issues.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {VALIDATE_LEVELS.map(({ key, label, chip }) => {
            const codes = report[key];
            if (codes.length === 0) {
              return null;
            }
            return (
              <div key={key}>
                <span
                  className={`mb-1 inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip}`}
                >
                  {label} · {codes.length}
                </span>
                <ul className="space-y-1">
                  {codes.map((code) => (
                    <li key={code} className="font-mono text-xs text-muted-foreground">
                      {code}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// §11.2 critic verdict
// ---------------------------------------------------------------------------

export interface CritiqueVerdictCardProps {
  readonly report: CritiqueReportPayload | null;
  readonly terminal: boolean;
}

const CRITIQUE_SCORES = [
  { key: "hierarchy", label: "Hierarchy" },
  { key: "balance", label: "Balance" },
  { key: "contrast", label: "Contrast" },
  { key: "brief_adherence", label: "Brief adherence" },
  { key: "brand_fit", label: "Brand fit" },
  { key: "editability", label: "Editability" },
] as const;

const CRITIQUE_SEVERITY_CHIPS = {
  blocker: "border-red-200 bg-red-50 text-red-700",
  major: "border-amber-200 bg-amber-50 text-amber-700",
  minor: "border-zinc-200 bg-zinc-50 text-zinc-600",
} as const;

export function CritiqueVerdictCard({ report, terminal }: CritiqueVerdictCardProps) {
  if (report === null) {
    return (
      <CardShell
        title="Critique"
        badge={
          <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Pending
          </span>
        }
      >
        {terminal ? (
          <EmptyBody label="No critique report was recorded." />
        ) : (
          <WaitingBody label="Waiting for the critic…" />
        )}
      </CardShell>
    );
  }

  const scores = CRITIQUE_SCORES.map(({ key, label }) => ({ label, value: report.scores[key] }));
  const average = scores.reduce((sum, entry) => sum + entry.value, 0) / scores.length;

  return (
    <CardShell
      title="Critique"
      badge={
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
            report.verdict === "accept"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700"
          }`}
        >
          {report.verdict === "accept" ? "Accepted" : "Revise requested"}
        </span>
      }
    >
      <div className="mt-3 space-y-2">
        {scores.map(({ label, value }) => {
          const width = `${Math.min(100, Math.max(0, (value / 5) * 100))}%`;
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
              <div
                aria-hidden="true"
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted"
              >
                <div className="h-full rounded-full bg-accent" style={{ width }} />
              </div>
              <span className="w-8 shrink-0 text-right font-mono text-xs">{value.toFixed(1)}</span>
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Average {average.toFixed(1)} of 5 · {report.issues.length} issue
        {report.issues.length === 1 ? "" : "s"}
      </p>

      {report.issues.length === 0 ? null : (
        <ul className="mt-3 space-y-2.5 border-t border-border pt-3">
          {report.issues.map((issue) => (
            <li key={`${issue.severity}-${issue.code}`} className="text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${CRITIQUE_SEVERITY_CHIPS[issue.severity]}`}
                >
                  {issue.severity}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{issue.code}</span>
                {issue.layer === undefined ? null : (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    on “{issue.layer}”
                  </span>
                )}
              </div>
              <p className="mt-1 text-muted-foreground">{issue.observation}</p>
              <p className="mt-0.5">Fix: {issue.fix}</p>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// §24.4 failure card — error + one-click retry
// ---------------------------------------------------------------------------

export interface FailureCardProps {
  readonly failure: RunFailure;
  readonly retryBusy: boolean;
  readonly retryNotice: string | null;
  /** §24.4 — the retry button only appears for retryable failures. */
  readonly onRetry: () => void;
}

export function FailureCard({ failure, retryBusy, retryNotice, onRetry }: FailureCardProps) {
  const retryable = failure.retryable === true;
  return (
    <section
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50/40 px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <TriangleAlert aria-hidden="true" className="size-4 text-red-600" />
        <h2 className="text-sm font-semibold text-red-700">Run failed</h2>
        <span className="rounded-full border border-red-200 bg-surface px-2 py-0.5 font-mono text-[11px] text-red-700">
          {failure.code}
        </span>
      </div>

      <p className="mt-2 text-sm">{failure.message}</p>
      {failure.hint === undefined ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{failure.hint}</p>
      )}

      {failure.retryable === undefined ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          {retryable
            ? "You can retry this run with the same brief at no extra charge for the first retry."
            : "This failure is not retryable as-is. Check the hint above or start a new run from the document."}
        </p>
      )}

      {retryable ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retryBusy}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          {retryBusy ? "Retrying…" : "Retry run"}
        </button>
      ) : null}

      {retryNotice === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground">{retryNotice}</p>
      )}
    </section>
  );
}
