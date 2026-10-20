import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Skeleton — loading placeholder.
 *
 * Default is the quiet `animate-pulse` block; pass `shimmer` for the gradient sweep
 * (keyframes + `.ui-shimmer` utility live in tokens.css). Decorative by default
 * (`aria-hidden`) — for long waits render a labelled `role="progressbar"` sibling
 * instead of announcing raw skeletons.
 */
export interface SkeletonProps extends ComponentProps<"div"> {
  /** Use the token-driven shimmer sweep instead of the pulse animation. */
  shimmer?: boolean;
}

export function Skeleton({ className, shimmer = false, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(shimmer ? "ui-shimmer animate-none" : "animate-pulse", "rounded-md bg-muted", className)}
      {...props}
    />
  );
}
