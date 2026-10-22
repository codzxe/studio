"use client";

/**
 * UsageMeters — the §8.8 "Usage" quota meters (BUILD_PLAN §M6 task 4):
 * seats, storage, render minutes and credits used vs the monthly allowance.
 *
 * Inputs are the RAW wire numbers (D-12): `entitlements` is the
 * `GET /v1/billing/state` entitlement bundle (storage in BYTES, monthly
 * credit allowance in integer MICROcredits) and `usage` is what the page
 * measured this cycle. The UI reads entitlements — it never hardcodes plan
 * quotas (BP §M6 task 1).
 *
 * Progress bars follow the §7.11 credit-meter language (1.5px track,
 * success/warning/danger fill, numeric value ALWAYS beside the meter).
 * WARNING fires at ≥ 90% of the quota (task pin); a quota at 100%+ escalates
 * to the exhausted state — status is never colour-only (§3.1): each state
 * also carries an icon + text.
 *
 * Exported surface (binding for M6-F):
 *   UsageMetersProps + UsageMeters + UsageEntitlements + UsageSnapshot
 *   + formatStorageBytes (§14 byte display)
 */

import { Button, cn } from "@studio/ui";
import { CircleAlert, TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import {
  formatCreditsDisplay,
  microcreditsToCreditsDisplay,
  truncateForDisplay,
} from "./ledger-table";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * The quota side — structurally `BillingEntitlements` narrowed to the four
 * metered numbers (any superset, e.g. the full wire bundle, is accepted).
 */
export interface UsageEntitlements {
  readonly seats: number;
  readonly storageBytes: number;
  readonly renderMinutesPerMonth: number;
  /** Monthly credit allowance in integer microcredits (D-12). */
  readonly monthlyCreditAllowance: number;
}

/** The used side — measured this cycle by the page. */
export interface UsageSnapshot {
  readonly seatsUsed: number;
  readonly storageUsedBytes: number;
  readonly renderMinutesUsed: number;
  /** Credits used this cycle in integer microcredits (D-12). */
  readonly creditsUsedMicrocredits: number;
}

export interface UsageMetersProps {
  readonly usage: UsageSnapshot;
  readonly entitlements: UsageEntitlements;
  /** Top-up CTA on the credits row (§7.11); wire to the top-up flow. */
  readonly onTopUp?: () => void;
  readonly className?: string;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** §14 byte sizes: "12.4 MB", "20 GB", "1 TB" (binary 1024 steps). */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || Number.isInteger(value) ? 0 : 1;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })} ${units[unit]}`;
}

/** Locale-grouped integers for seats / minutes; hostile values degrade. */
function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  return Math.round(value).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// MeterRow — the §7.11 meter language for one quota
// ---------------------------------------------------------------------------

type MeterState = "healthy" | "warning" | "exhausted";

/** Warning at ≥ 90% of the quota (task pin); exhausted at 100%+. */
export const USAGE_WARNING_PERCENT = 90;

interface MeterRowProps {
  /** Accessible row label, e.g. "Seats used". */
  readonly label: string;
  readonly testId: string;
  readonly used: number;
  readonly limit: number;
  /** Right-hand numeric text, already formatted. */
  readonly valueText: string;
  /** Exhausted-state copy (quota-specific: "Allowance used" vs "Full"). */
  readonly exhaustedLabel: string;
  readonly onTopUp?: () => void;
}

function meterState(used: number, limit: number): MeterState {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "healthy";
  if (used >= limit) return "exhausted";
  if (used * 100 >= limit * USAGE_WARNING_PERCENT) return "warning";
  return "healthy";
}

const stateTrack: Record<MeterState, string> = {
  healthy: "bg-success",
  warning: "bg-warning",
  exhausted: "bg-danger",
};

function MeterRow({
  label,
  testId,
  used,
  limit,
  valueText,
  exhaustedLabel,
  onTopUp,
}: MeterRowProps) {
  const state = meterState(used, limit);
  const pct =
    Number.isFinite(used) && Number.isFinite(limit) && limit > 0
      ? Math.min(Math.max((used / limit) * 100, 0), 100)
      : 0;

  return (
    <div
      data-testid={testId}
      data-state={state}
      className="flex min-w-0 flex-wrap items-center gap-2.5"
    >
      <span className="w-32 shrink-0 truncate text-caption text-secondary">
        {truncateForDisplay(label, 40)}
      </span>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Number.isFinite(used) ? Math.max(used, 0) : 0}
        aria-valuemin={0}
        aria-valuemax={Number.isFinite(limit) ? Math.max(limit, 0) : 0}
        className="h-1.5 w-full min-w-16 max-w-40 shrink-0 overflow-hidden rounded-pill bg-input"
      >
        <div
          className={cn(
            "h-full rounded-pill transition-[width] duration-240 ease-out",
            stateTrack[state],
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular shrink-0 text-body-s text-primary">{valueText}</span>
      {state === "warning" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-warning">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>Nearing limit</span>
        </span>
      ) : null}
      {state === "exhausted" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-danger">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{exhaustedLabel}</span>
        </span>
      ) : null}
      {onTopUp ? (
        <Button size="sm" variant="secondary" data-testid="usage-topup" onClick={onTopUp}>
          Buy credits
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UsageMeters
// ---------------------------------------------------------------------------

export function UsageMeters({ usage, entitlements, onTopUp, className }: UsageMetersProps) {
  const creditsUsed = microcreditsToCreditsDisplay(usage.creditsUsedMicrocredits);
  const creditsAllowance = microcreditsToCreditsDisplay(entitlements.monthlyCreditAllowance);
  const creditsValueText =
    creditsUsed === null || creditsAllowance === null
      ? "—"
      : `${formatCreditsDisplay(creditsUsed)} of ${formatCreditsDisplay(creditsAllowance)} credits`;

  const rows: ReactElement[] = [
    <MeterRow
      key="seats"
      label="Seats used"
      testId="usage-meter-seats"
      used={usage.seatsUsed}
      limit={entitlements.seats}
      valueText={`${formatCount(usage.seatsUsed)} / ${formatCount(entitlements.seats)} seats`}
      exhaustedLabel="Seat limit reached"
    />,
    <MeterRow
      key="storage"
      label="Storage used"
      testId="usage-meter-storage"
      used={usage.storageUsedBytes}
      limit={entitlements.storageBytes}
      valueText={`${formatStorageBytes(usage.storageUsedBytes)} of ${formatStorageBytes(entitlements.storageBytes)}`}
      exhaustedLabel="Storage full"
    />,
    <MeterRow
      key="render"
      label="Render minutes"
      testId="usage-meter-render"
      used={usage.renderMinutesUsed}
      limit={entitlements.renderMinutesPerMonth}
      valueText={`${formatCount(usage.renderMinutesUsed)} / ${formatCount(entitlements.renderMinutesPerMonth)} min`}
      exhaustedLabel="Render minutes used"
    />,
    <MeterRow
      key="credits"
      label="Credits used"
      testId="usage-meter-credits"
      used={creditsUsed ?? Number.NaN}
      limit={creditsAllowance ?? Number.NaN}
      valueText={creditsValueText}
      exhaustedLabel="Allowance used"
      onTopUp={onTopUp}
    />,
  ];

  return (
    <section
      aria-label="Workspace usage"
      data-testid="usage-meters"
      className={cn("flex flex-col gap-2.5", className)}
    >
      {rows}
    </section>
  );
}
