"use client";

/**
 * LowCreditBanner — §8.8 "Low credits: warning banner with 'Buy credits';
 * never auto-charge a top-up" + BUILD_PLAN §M6 task 4 "block runs at zero
 * balance before the model call" (the banner carries that block messaging).
 *
 * Thresholds (task pin):
 *  - warning: balance ≤ 20% of the monthly allowance;
 *  - urgent:   balance ≤ 5% of the allowance OR ≤ 3 credits absolute —
 *    urgent adds the zero-balance block copy (“New runs are blocked once
 *    credits reach zero”).
 *
 * The “Buy credits” CTA (§8.8 “Low credits: warning banner with ‘Buy
 * credits’”) renders on BOTH levels whenever the page passes an action —
 * never an auto-charge, always a click.
 *
 * Inputs are the RAW ledger numbers from `GET /v1/billing/state` in integer
 * MICROcredits (D-12: `credits.balance` + `entitlements.monthlyCreditAllowance`).
 * The comparison is integer cross-multiplication — no float division, no
 * drift at the exact boundary. Hostile/non-finite numbers render NOTHING
 * (a broken number must not nag the user into a purchase).
 *
 * Dismissal: per-session, IN-MEMORY only. ECUX §3.3 has no persistence key
 * for system-notice dismissal, so none is written (no storage law conflicts).
 * A dismissal sticks for that level; if the level ESCALATES (warning →
 * urgent), the banner re-appears — a worse state is new information.
 *
 * Exported surface (binding for M6-F):
 *   LowCreditBannerProps + LowCreditBanner
 *   lowCreditLevel + LowCreditLevel + LOW_CREDIT_* threshold constants
 */

import { Button, cn } from "@studio/ui";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import { formatCreditsDisplay, microcreditsToCreditsDisplay } from "./ledger-table";

// ---------------------------------------------------------------------------
// Thresholds (exported for M6-F + tests)
// ---------------------------------------------------------------------------

/** Warning when the balance is at or under this % of the monthly allowance. */
export const LOW_CREDIT_WARNING_PERCENT = 20;

/** Urgent when the balance is at or under this % of the monthly allowance. */
export const LOW_CREDIT_URGENT_PERCENT = 5;

/** Urgent when the balance is at or under this many credits (3 = 3,000,000 µc). */
export const LOW_CREDIT_URGENT_BALANCE_MICROCREDITS = 3 * 1_000_000;

export type LowCreditLevel = "none" | "warning" | "urgent";

/** Integer µc → finite integer µc, or null for hostile input. */
function sanitizeMicrocredits(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * Threshold classification on RAW ledger µc (D-12). Integer math only:
 * `balance * 100 <= allowance * percent` — exact at the boundary, no float
 * division. Non-finite balance → "none" (render nothing, never a scare).
 */
export function lowCreditLevel(
  balanceMicrocredits: number,
  allowanceMicrocredits: number,
): LowCreditLevel {
  const balance = sanitizeMicrocredits(balanceMicrocredits);
  if (balance === null) return "none";
  const allowance = sanitizeMicrocredits(allowanceMicrocredits) ?? 0;

  if (balance <= LOW_CREDIT_URGENT_BALANCE_MICROCREDITS) return "urgent";
  if (allowance > 0 && balance * 100 <= allowance * LOW_CREDIT_URGENT_PERCENT) {
    return "urgent";
  }
  if (allowance > 0 && balance * 100 <= allowance * LOW_CREDIT_WARNING_PERCENT) {
    return "warning";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// LowCreditBanner
// ---------------------------------------------------------------------------

export interface LowCreditBannerProps {
  /** Current balance in integer microcredits (`BillingState.credits.balance`). */
  readonly balanceMicrocredits: number;
  /** Monthly allowance in µc (`BillingState.entitlements.monthlyCreditAllowance`). */
  readonly allowanceMicrocredits: number;
  /** "Buy credits" action (§8.8). Wire to the top-up flow or the billing page. */
  readonly onTopUp?: () => void;
  /** Link variant of the CTA, when a navigation fits better than a callback. */
  readonly topUpHref?: string;
  readonly className?: string;
}

export function LowCreditBanner({
  balanceMicrocredits,
  allowanceMicrocredits,
  onTopUp,
  topUpHref,
  className,
}: LowCreditBannerProps): ReactElement | null {
  const [dismissedLevel, setDismissedLevel] = useState<LowCreditLevel | null>(null);

  const level = lowCreditLevel(balanceMicrocredits, allowanceMicrocredits);
  if (level === "none" || level === dismissedLevel) return null;

  const balanceText = formatCreditsDisplay(microcreditsToCreditsDisplay(balanceMicrocredits));
  const urgent = level === "urgent";

  const message = urgent
    ? `You have ${balanceText} credits left. New runs are blocked once credits reach zero.`
    : `Credits are running low — ${balanceText} credits left, at or under ${LOW_CREDIT_WARNING_PERCENT}% of your monthly allowance.`;

  const dismiss = (): void => setDismissedLevel(level);

  return (
    <div
      data-testid="low-credit-banner"
      data-level={level}
      role={urgent ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-sm border px-3 py-2 text-caption text-primary",
        urgent ? "border-danger/40 bg-danger/10" : "border-warning/40 bg-warning/10",
        className,
      )}
    >
      {urgent ? (
        <CircleAlert
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-danger"
        />
      ) : (
        <TriangleAlert
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-warning"
        />
      )}
      <p className="min-w-0 flex-1">{message}</p>
      {onTopUp ? (
        <Button
          size="sm"
          variant={urgent ? "primary" : "secondary"}
          data-testid="low-credit-topup"
          onClick={onTopUp}
        >
          Buy credits
        </Button>
      ) : null}
      {!onTopUp && topUpHref ? (
        <a
          data-testid="low-credit-topup"
          href={topUpHref}
          className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Buy credits
        </a>
      ) : null}
      <button
        type="button"
        data-testid="low-credit-dismiss"
        aria-label="Dismiss"
        onClick={dismiss}
        className="shrink-0 text-muted transition-colors duration-120 hover:text-primary"
      >
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
