import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn.js";

/**
 * DataTable — typed generic table (columns definition, rows, sorting, pagination,
 * empty-state slot). No dependencies beyond react: rendering + local interaction
 * only, so it composes with any data source the app picks (SWR, query cache, SSE).
 *
 * Sorting: a column opts in by defining `sortValue`. Controlled mode: pass `sort` +
 * `onSortChange` (e.g. server-side sort). Uncontrolled: omit `sort` and the table
 * sorts rows locally with a stable tie-break on the original index.
 * Pagination: pass `pageSize` to slice pages locally, or `pageIndex` +
 * `onPageIndexChange` to drive it from the app (e.g. server pagination).
 *
 * A11y: native <table> semantics; sortable headers carry `aria-sort` and toggle via
 * real <button>s; the caption slot is a visually hidden <caption> naming the table;
 * the pager buttons are labelled native buttons, disabled at the bounds.
 */

export type DataTableSortDirection = "asc" | "desc";

export interface DataTableSortState {
  /** id of the sorted column; null = registry order (unsorted). */
  columnId: string | null;
  direction: DataTableSortDirection;
}

/** Sortable cell values — primitives only; null sorts last. */
export type DataTableSortValue = string | number | boolean | null;

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row, index: number) => ReactNode;
  /** Defining this opts the column into sorting. */
  sortValue?: (row: Row) => DataTableSortValue;
  align?: "left" | "right";
  /** Extra classes for this column's th + td. */
  className?: string;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  /** Stable key source; defaults to positional `row-<index>`. */
  getRowId?: (row: Row, index: number) => string;
  /** Accessible table name — rendered as a visually hidden <caption>. */
  caption?: string;
  /** Controlled sort; omit for internal (uncontrolled) sorting. */
  sort?: DataTableSortState;
  onSortChange?: (sort: DataTableSortState) => void;
  /** Rows per page; omit to render all rows and hide the pager. */
  pageSize?: number;
  /** Controlled 0-based page index; omit for internal state. */
  pageIndex?: number;
  onPageIndexChange?: (pageIndex: number) => void;
  /** Rendered in a full-width cell when `rows` is empty (e.g. <EmptyState/>). */
  emptyState?: ReactNode;
  className?: string;
}

/** Pure comparator: nulls last, numbers numerically, everything else as strings. */
export function compareSortValues(a: DataTableSortValue, b: DataTableSortValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Pure sort used by the table — stable (ties keep original order). Exported for tests. */
export function sortDataTableRows<Row>(
  rows: readonly Row[],
  columns: readonly DataTableColumn<Row>[],
  sort: DataTableSortState,
): Row[] {
  const column =
    sort.columnId === null ? undefined : columns.find((candidate) => candidate.id === sort.columnId);
  const sorter = column?.sortValue;
  if (sorter === undefined) return [...rows];
  const factor = sort.direction === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const cmp = factor * compareSortValues(sorter(x.row), sorter(y.row));
      return cmp !== 0 ? cmp : x.index - y.index;
    })
    .map((entry) => entry.row);
}

const PAGER_BUTTON_CLASSES =
  "inline-flex size-7 items-center justify-center rounded-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  caption,
  sort: sortProp,
  onSortChange,
  pageSize,
  pageIndex: pageIndexProp,
  onPageIndexChange,
  emptyState,
  className,
}: DataTableProps<Row>) {
  const [internalSort, setInternalSort] = useState<DataTableSortState>({
    columnId: null,
    direction: "asc",
  });
  const [internalPageIndex, setInternalPageIndex] = useState(0);

  const sort = sortProp ?? internalSort;
  const applySort = (next: DataTableSortState): void => {
    setInternalSort(next);
    onSortChange?.(next);
  };
  const toggleSort = (column: DataTableColumn<Row>): void => {
    if (column.sortValue === undefined) return;
    applySort(
      sort.columnId === column.id
        ? { columnId: column.id, direction: sort.direction === "asc" ? "desc" : "asc" }
        : { columnId: column.id, direction: "asc" },
    );
  };

  const sortedRows = sortDataTableRows(rows, columns, sort);
  const total = sortedRows.length;

  const effectivePageSize = pageSize !== undefined && pageSize > 0 ? pageSize : undefined;
  const pageCount = effectivePageSize === undefined ? 1 : Math.max(1, Math.ceil(total / effectivePageSize));
  // Clamp, don't emit: an out-of-range controlled page still renders a valid page.
  const pageIndex = Math.min(Math.max(pageIndexProp ?? internalPageIndex, 0), pageCount - 1);
  const gotoPage = (next: number): void => {
    setInternalPageIndex(next);
    onPageIndexChange?.(next);
  };

  const pageRows =
    effectivePageSize === undefined
      ? sortedRows
      : sortedRows.slice(pageIndex * effectivePageSize, (pageIndex + 1) * effectivePageSize);
  const rangeStart = pageIndex * (effectivePageSize ?? 0);
  const rangeEnd = Math.min(rangeStart + (effectivePageSize ?? total), total);

  const rowKey = (row: Row, index: number): string => getRowId?.(row, index) ?? `row-${index}`;

  return (
    <div className={cn("w-full", className)}>
      <div className="w-full overflow-x-auto">
        <table className="w-full caption-bottom text-sm">
          {caption === undefined ? null : <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => {
                const sortable = column.sortValue !== undefined;
                const isSorted = sort.columnId === column.id;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      !sortable
                        ? undefined
                        : isSorted
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                    }
                    className={cn(
                      "h-10 px-3 align-middle font-medium text-muted-foreground",
                      column.align !== "right" && "text-left",
                      column.align === "right" && "text-right",
                      column.className,
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isSorted && "text-foreground",
                        )}
                      >
                        {column.header}
                        {isSorted ? (
                          sort.direction === "asc" ? (
                            <ChevronUp className="size-3.5" aria-hidden="true" />
                          ) : (
                            <ChevronDown className="size-3.5" aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  {emptyState ?? (
                    <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                      No rows to display.
                    </p>
                  )}
                </td>
              </tr>
            ) : (
              pageRows.map((row, index) => (
                <tr key={rowKey(row, index)} className="border-b border-border last:border-0 hover:bg-muted/40">
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        "px-3 py-2.5 align-middle",
                        column.align === "right" && "text-right",
                        column.className,
                      )}
                    >
                      {column.cell(row, index)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {effectivePageSize === undefined ? null : (
        <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
          <span aria-live="polite">
            {total === 0 ? "0 rows" : `Showing ${rangeStart + 1}–${rangeEnd} of ${total}`}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={pageIndex <= 0}
              onClick={() => gotoPage(pageIndex - 1)}
              className={PAGER_BUTTON_CLASSES}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <span>
              Page {pageIndex + 1} of {pageCount}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={pageIndex >= pageCount - 1}
              onClick={() => gotoPage(pageIndex + 1)}
              className={PAGER_BUTTON_CLASSES}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
