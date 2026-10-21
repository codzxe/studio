import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.js";

/**
 * Badge — status pill. Variants `running` / `succeeded` / `warning` / `failed` map to the
 * run states exposed over SSE (§13.2) and persisted in `agent_runs.status` (§5.1);
 * `default` / `secondary` / `outline` are the generic neutrals.
 */

export const badgeVariants = cva(
  "inline-flex select-none items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-4 transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        running: "border-transparent bg-info/15 text-info",
        succeeded: "border-transparent bg-success/15 text-success",
        warning: "border-transparent bg-warning/15 text-warning",
        failed: "border-transparent bg-destructive/15 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {children}
    </span>
  );
}

/**
 * run-state → Badge variant map (§13.2 / §5.1). Keys mirror `RUN_STATUSES` from
 * packages/db (queued…cancelled) plus the common aliases used by run-event streams
 * (started/running/warning/error). Kept as a standalone string map so the UI package
 * stays free of a @studio/db dependency — update both sides if statuses change.
 */
export const STATUS_BADGE_VARIANT: Readonly<Record<string, BadgeVariant>> = {
  // non-terminal + queued
  queued: "default",
  planning: "running",
  executing: "running",
  observing: "running",
  rendering: "running",
  validating: "running",
  critiquing: "running",
  repairing: "running",
  finalizing: "running",
  // stream aliases
  started: "running",
  running: "running",
  warning: "warning",
  error: "failed",
  // terminal
  succeeded: "succeeded",
  succeeded_with_warnings: "warning",
  failed: "failed",
  cancelled: "default",
  canceled: "default",
};

/** Resolve any status string to a Badge variant; unknown statuses render neutral. */
export function statusBadgeVariant(status: string): BadgeVariant {
  return STATUS_BADGE_VARIANT[status] ?? "default";
}
