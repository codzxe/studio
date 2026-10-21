import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";

/**
 * Kbd — keyboard key chip. Mono, radius-xs (§5.3), 11px (§4.2: keyboard hints
 * are the only 11px text in the app).
 */
export const Kbd = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function Kbd(
  { className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-xs border border-border bg-input px-1 font-mono text-hint leading-none text-secondary",
        className,
      )}
      {...props}
    />
  );
});
