import {
  type HTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  forwardRef,
} from "react";
import { cn } from "../lib/utils";

/**
 * Table — §7.9. Header 12px uppercase muted; rows 44–52px; 1px dividers;
 * numeric right-aligned + tabular; hover ink-3; selected row carries a 2px
 * signal left border; sticky header; empty state renders INSIDE the body.
 */
export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Sticky header for long tables (§7.9). Header cells use bg-app. */
  stickyHeader?: boolean;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { stickyHeader = false, className, ...props },
  ref,
) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        ref={ref}
        className={cn(
          "w-full caption-bottom border-collapse text-body-s",
          stickyHeader && "[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app",
          className,
        )}
        {...props}
      />
    </div>
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} className={cn("text-left", className)} {...props} />;
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn("", className)} {...props} />;
});

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Selected rows get a 2px signal left border (§7.9) — inset, no layout shift. */
  selected?: boolean;
}

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(function TableRow(
  { selected = false, className, ...props },
  ref,
) {
  return (
    <tr
      ref={ref}
      data-selected={selected || undefined}
      className={cn(
        "border-b border-border transition-colors duration-120 hover:bg-elevated",
        selected ? "shadow-[inset_2px_0_0_0_var(--signal)]" : undefined,
        className,
      )}
      {...props}
    />
  );
});

export interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Numeric columns: right-aligned header to match numeric cells (§7.9). */
  numeric?: boolean;
}

export const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>(function TableHead(
  { numeric = false, className, ...props },
  ref,
) {
  return (
    <th
      ref={ref}
      scope="col"
      className={cn(
        "h-11 px-3 align-middle text-label font-medium uppercase tracking-[0.06em] text-muted",
        numeric ? "text-right tabular-nums" : "text-left",
        className,
      )}
      {...props}
    />
  );
});

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /** Numeric columns: right-aligned with tabular numerals (§7.9). */
  numeric?: boolean;
}

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(function TableCell(
  { numeric = false, className, ...props },
  ref,
) {
  return (
    <td
      ref={ref}
      className={cn(
        "h-11 px-3 align-middle text-secondary",
        numeric && "text-right tabular-nums text-primary",
        className,
      )}
      {...props}
    />
  );
});

export interface TableEmptyProps extends HTMLAttributes<HTMLTableRowElement> {
  colSpan: number;
  /** e.g. "No projects yet." (§7.12) */
  children?: React.ReactNode;
}

/** Empty state INSIDE the table body (§7.9), never a separate blank page. */
export const TableEmpty = forwardRef<HTMLTableRowElement, TableEmptyProps>(function TableEmpty(
  { colSpan, className, children, ...props },
  ref,
) {
  return (
    <tr ref={ref} className={cn("border-b border-border", className)} {...props}>
      <td colSpan={colSpan} className="h-44 px-3 text-center text-body-s text-muted">
        {children}
      </td>
    </tr>
  );
});
