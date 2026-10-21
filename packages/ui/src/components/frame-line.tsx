import { type HTMLAttributes, type ReactNode, forwardRef } from "react";
import { cn } from "../lib/utils";

export interface FrameLineProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Timecode label, e.g. "00:00:12 — WORKFLOW" (§2.3). */
  label: ReactNode;
  /**
   * Play the 240ms scaleX draw once (§6.3) — set when the divider scrolls
   * into view; removed automatically when prefers-reduced-motion is set.
   */
  draw?: boolean;
}

/**
 * FrameLine — §2.3 signature element: a thin horizontal rule with a small
 * timecode label used as a section divider. It ties the shell to the timeline
 * without pretending to be the editor. The rule draws 0 → 1 over 240ms with
 * `data-draw`. The label is readable text; the rule itself is decorative.
 */
export const FrameLine = forwardRef<HTMLDivElement, FrameLineProps>(function FrameLine(
  { label, draw = false, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("frame-line w-full", className)}
      {...(draw ? { "data-draw": true } : undefined)}
      {...props}
    >
      <span className="frame-line-label tabular">{label}</span>
    </div>
  );
});
