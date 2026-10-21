import { LoaderCircle } from "lucide-react";
import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLOutputElement>, "children"> {
  /** Icon size in px — Lucide set: 16/20/24 (§10). */
  size?: 16 | 20 | 24;
  /** Accessible label announced to screen readers. */
  label?: string;
}

/**
 * Spinner — loading indicator (§7.13: use only for content that is loading).
 * `<output>` carries the implicit `status` role, so the label is announced.
 * Rotation is removed automatically under `prefers-reduced-motion` (§6.2).
 */
export const Spinner = forwardRef<HTMLOutputElement, SpinnerProps>(function Spinner(
  { size = 16, label = "Loading", className, ...props },
  ref,
) {
  return (
    <output
      ref={ref}
      aria-label={label}
      className={cn("inline-flex animate-spin text-muted", className)}
      {...props}
    >
      <LoaderCircle size={size} strokeWidth={1.75} aria-hidden="true" />
    </output>
  );
});
