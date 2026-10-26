import type { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

export interface SlateProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Project name. */
  name: string;
  /** Duration as timecode, e.g. "00:12:04" (§14). */
  duration: string;
  /** Composition count. */
  comps: number;
  /** Relative time, e.g. "Updated 2h ago". */
  updated?: string;
  /** Right-aligned slot (StatusDot, Badge, …). */
  children?: React.ReactNode;
}

/**
 * Slate — §2.3 signature element: a compact project header with name, duration
 * and comp count, like a film slate. Styling lives in the `.slate` utility
 * (utilities.css) so it can be reused for non-React surfaces.
 */
export function Slate({
  name,
  duration,
  comps,
  updated,
  children,
  className,
  ...props
}: SlateProps) {
  return (
    <div className={cn("slate", className)} {...props}>
      <div className="flex items-center justify-between gap-4">
        <h3 className="truncate text-body font-medium text-primary">{name}</h3>
        {children}
      </div>
      <p className="tabular text-caption text-muted">
        {duration} · {comps} {comps === 1 ? "comp" : "comps"}
        {updated ? ` · ${updated}` : ""}
      </p>
    </div>
  );
}
