import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.js";

/**
 * EmptyState — icon + title + description + action slot for list/library panes with
 * nothing to show yet (documents, assets, gallery filters, data tables).
 *
 * Purely presentational; the icon and action are plain slots so callers stay in
 * control of semantics (pass `<Button asChild><Link …/></Button>` etc.).
 */
export interface EmptyStateProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  /** Decorative icon node (e.g. a lucide icon); rendered inside a muted disc. */
  icon?: ReactNode;
  /** Primary line — a real heading so screen-reader users get structure. */
  title: string;
  /** Optional secondary explanation. */
  description?: string;
  /** Optional action slot (usually a `<Button>`), rendered below the copy. */
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-md px-6 py-8 text-center",
        className,
      )}
      {...props}
    >
      {icon === undefined ? null : (
        <div
          aria-hidden="true"
          className="mb-1.5 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5 [&_svg]:shrink-0"
        >
          {icon}
        </div>
      )}
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description === undefined ? null : (
        <p className="max-w-sm text-sm leading-5 text-muted-foreground">{description}</p>
      )}
      {action === undefined ? null : (
        <div className="mt-2 flex items-center gap-2">{action}</div>
      )}
    </div>
  );
}
