import type { ComponentProps } from "react";
import { cn } from "../lib/cn.js";

/**
 * Progress — accessible progress bar (role="progressbar" with value/min/max wiring).
 * Omit `value` for an indeterminate bar (e.g. engine render jobs with unknown size).
 * Give it an accessible name via `aria-label` (e.g. "Export progress") — required by
 * the progressbar role.
 */
export interface ProgressProps extends Omit<ComponentProps<"div">, "role"> {
  /** Current value within [0, max]; omit for an indeterminate bar. */
  value?: number;
  /** Upper bound (default 100). */
  max?: number;
  /** Customize the announced value, e.g. `(${v}, ${m}) => \`${v} of ${m} steps\``. */
  getValueLabel?: (value: number, max: number) => string;
  size?: "sm" | "md";
}

export function Progress({
  value,
  max = 100,
  getValueLabel,
  size = "md",
  className,
  ...props
}: ProgressProps) {
  const indeterminate = value === undefined;
  const clamped = Math.min(Math.max(value ?? 0, 0), max);
  const percent = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-valuetext={
        indeterminate || getValueLabel === undefined ? undefined : getValueLabel(clamped, max)
      }
      className={cn(
        "w-full overflow-hidden rounded-full bg-secondary",
        size === "sm" ? "h-1" : "h-2",
        className,
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-200",
          indeterminate && "w-full animate-pulse",
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}
