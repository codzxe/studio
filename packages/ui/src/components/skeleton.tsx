import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";

/**
 * Skeleton — §7.13. Use only for content that is actually loading; preserve
 * final layout dimensions to avoid shift. bg ink-3, 1px radius, 1.4s shimmer
 * at 6% opacity (transform-only). Reduced motion makes it static (global
 * override in theme.css).
 */
export const Skeleton = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Skeleton({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn("relative overflow-hidden rounded-[1px] bg-elevated", className)}
        {...props}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1/2 animate-shimmer bg-paper opacity-[0.06]"
        />
      </div>
    );
  },
);
