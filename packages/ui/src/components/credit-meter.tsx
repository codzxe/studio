import { CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./button";

export type CreditState = "healthy" | "low" | "exhausted";

export interface CreditMeterProps {
  /** Credits used this cycle. */
  used: number;
  /** Credits included this cycle. */
  included: number;
  /** Defaults to derived: exhausted at 0 remaining, low below 10% remaining. */
  state?: CreditState;
  /** Unit label (§14: "credits", never "tokens"). */
  label?: string;
  /** Top-up CTA — renders a compact secondary button when provided (§7.11). */
  onTopUp?: () => void;
  topUpLabel?: string;
  className?: string;
}

function defaultState(used: number, included: number): CreditState {
  const remaining = included - used;
  if (remaining <= 0) return "exhausted";
  if (included > 0 && remaining <= included * 0.1) return "low";
  return "healthy";
}

const stateTrack: Record<CreditState, string> = {
  healthy: "bg-success",
  low: "bg-warning",
  exhausted: "bg-danger",
};

/**
 * CreditMeter — §7.11. Compact horizontal meter with the numeric balance
 * ALWAYS visible next to it; state is never colour-only (§3.1): low and
 * exhausted add an icon + text label.
 */
export function CreditMeter({
  used,
  included,
  state,
  label = "credits",
  onTopUp,
  topUpLabel = "Buy credits",
  className,
}: CreditMeterProps) {
  const resolved = state ?? defaultState(used, included);
  const remaining = Math.max(included - used, 0);
  const pct = included > 0 ? Math.min(Math.max((used / included) * 100, 0), 100) : 100;

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2.5", className)}>
      <div
        role="meter"
        aria-label="Credits used this cycle"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={included}
        className="h-1.5 w-full min-w-16 max-w-40 shrink-0 overflow-hidden rounded-pill bg-input"
      >
        <div
          className={cn(
            "h-full rounded-pill transition-[width] duration-240 ease-out",
            stateTrack[resolved],
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular shrink-0 text-body-s text-primary">
        {remaining.toLocaleString("en-US")} <span className="text-muted">{label}</span>
      </span>
      {resolved === "low" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-warning">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>Low</span>
        </span>
      ) : null}
      {resolved === "exhausted" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-danger">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>Out of credits</span>
        </span>
      ) : null}
      {onTopUp ? (
        <Button size="sm" variant="secondary" onClick={onTopUp}>
          {topUpLabel}
        </Button>
      ) : null}
    </div>
  );
}
