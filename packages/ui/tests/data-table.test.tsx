import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "../src/components/empty-state.js";
import {
  compareSortValues,
  DataTable,
  sortDataTableRows,
  type DataTableColumn,
  type DataTableSortState,
} from "../src/components/data-table.js";

interface Doc {
  id: string;
  name: string;
  credits: number;
  status: string | null;
}

const DOCS: readonly Doc[] = [
  { id: "d1", name: "Post launch", credits: 5, status: "succeeded" },
  { id: "d2", name: "Thumb A/B", credits: 1, status: null },
  { id: "d3", name: "Menu redo", credits: 2, status: "failed" },
  { id: "d4", name: "Deck cover", credits: 0, status: "succeeded" },
  { id: "d5", name: "Banner set", credits: 3, status: "running" },
];

function columns(): DataTableColumn<Doc>[] {
  return [
    {
      id: "name",
      header: "Document",
      cell: (row) => row.name,
      sortValue: (row) => row.name,
    },
    {
      id: "credits",
      header: "Credits",
      cell: (row) => String(row.credits),
      sortValue: (row) => row.credits,
      align: "right",
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => row.status ?? "—",
      sortValue: (row) => row.status,
    },
  ];
}

function cellTexts(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1) // skip the header row
    .map((row) =>
      Array.from(row.querySelectorAll("td"))
        .map((cell) => cell.textContent ?? "")
        .join("|"),
    )
    .filter((line) => line !== ""); // skip the empty-state row if present
}

describe("compareSortValues (pure)", () => {
  // Table-driven: numbers compare numerically, nulls always sort last, direction is
  // the caller's job (see sortDataTableRows).
  it.each([
    [1, 2, -1],
    [2, 1, 1],
    ["a", "b", -1],
    ["b", "a", 1],
    [true, false, 1], // booleans degrade to string compare: "true" > "false"
    [null, null, 0],
    [null, "anything", 1],
    ["anything", null, -1],
    ["same", "same", 0],
  ] as const)("%j vs %j → %d", (a, b, expected) => {
    expect(compareSortValues(a, b)).toBe(expected);
  });
});

describe("sortDataTableRows (pure, stable)", () => {
  it("sorts by the named column ascending and descending", () => {
    const cols = columns();
    const asc = sortDataTableRows(DOCS, cols, { columnId: "credits", direction: "asc" });
    expect(asc.map((row) => row.credits)).toEqual([0, 1, 2, 3, 5]);
    const desc = sortDataTableRows(DOCS, cols, { columnId: "credits", direction: "desc" });
    expect(desc.map((row) => row.credits)).toEqual([5, 3, 2, 1, 0]);
  });

  it("keeps original order for ties (stable) and for unsorted state", () => {
    const cols: DataTableColumn<Doc>[] = [
      { id: "status", header: "Status", cell: (r) => r.status ?? "", sortValue: (r) => r.status },
    ];
    const sorted = sortDataTableRows(DOCS, cols, { columnId: "status", direction: "asc" });
    // null row goes last; the two "succeeded" rows keep d1 before d4 (registry order)
    expect(sorted.map((row) => row.id)).toEqual(["d3", "d5", "d1", "d4", "d2"]);
    const untouched = sortDataTableRows(DOCS, cols, { columnId: null, direction: "asc" });
    expect(untouched.map((row) => row.id)).toEqual(["d1", "d2", "d3", "d4", "d5"]);
  });

  it("falls back to a copy when the sorted column has no sortValue", () => {
    const cols: DataTableColumn<Doc>[] = [{ id: "name", header: "Document", cell: (r) => r.name }];
    const sorted = sortDataTableRows(DOCS, cols, { columnId: "name", direction: "desc" });
    expect(sorted).not.toBe(DOCS); // copied, never mutates the input
    expect(sorted.map((row) => row.id)).toEqual(DOCS.map((row) => row.id));
  });
});

describe("DataTable (render)", () => {
  it("renders caption, column headers and all rows", () => {
    render(<DataTable columns={columns()} rows={DOCS} caption="Documents" />);
    const caption = screen.getByText("Documents");
    expect(caption.tagName).toBe("CAPTION");
    expect(caption.className).toContain("sr-only");
    expect(screen.getByRole("columnheader", { name: "Document" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Credits" })).toBeDefined();
    expect(screen.getAllByRole("row")).toHaveLength(6); // 1 header + 5 body
    expect(cellTexts()[0]).toBe("Post launch|5|succeeded");
  });

  it("sorts on header click: aria-sort none → ascending → descending", () => {
    render(<DataTable columns={columns()} rows={DOCS} />);
    const nameHeader = screen.getByRole("columnheader", { name: "Document" });
    expect(nameHeader).toHaveAttribute("aria-sort", "none");

    screen.getByRole("button", { name: "Document" }).click();
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    expect(cellTexts().map((line) => line.split("|")[0])).toEqual([
      "Banner set",
      "Deck cover",
      "Menu redo",
      "Post launch",
      "Thumb A/B",
    ]);

    screen.getByRole("button", { name: "Document" }).click();
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    expect(cellTexts().map((line) => line.split("|")[0])).toEqual([
      "Thumb A/B",
      "Post launch",
      "Menu redo",
      "Deck cover",
      "Banner set",
    ]);
  });

  it("supports controlled sorting via sort + onSortChange", () => {
    const onSortChange = vi.fn();
    const initial: DataTableSortState = { columnId: "credits", direction: "desc" };
    render(<DataTable columns={columns()} rows={DOCS} sort={initial} onSortChange={onSortChange} />);
    expect(screen.getByRole("columnheader", { name: "Credits" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    screen.getByRole("button", { name: "Credits" }).click();
    expect(onSortChange).toHaveBeenCalledWith({ columnId: "credits", direction: "asc" });
  });

  it("paginates: pager text, next/prev bounds and page content", () => {
    render(
      <DataTable columns={columns()} rows={DOCS} pageSize={2} caption="Documents" />,
    );
    expect(screen.getByText("Showing 1–2 of 5")).toBeDefined();
    expect(screen.getByText("Page 1 of 3")).toBeDefined();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(cellTexts()).toHaveLength(2);

    screen.getByRole("button", { name: "Next page" }).click();
    expect(screen.getByText("Page 2 of 3")).toBeDefined();
    expect(cellTexts().map((line) => line.split("|")[0])).toEqual(["Menu redo", "Deck cover"]);

    screen.getByRole("button", { name: "Next page" }).click();
    screen.getByRole("button", { name: "Next page" }).click(); // clamped at last page
    expect(screen.getByText("Page 3 of 3")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();

    screen.getByRole("button", { name: "Previous page" }).click();
    expect(screen.getByText("Page 2 of 3")).toBeDefined();
  });

  it("supports controlled pagination via pageIndex + onPageIndexChange", () => {
    const onPageIndexChange = vi.fn();
    render(
      <DataTable
        columns={columns()}
        rows={DOCS}
        pageSize={2}
        pageIndex={2}
        onPageIndexChange={onPageIndexChange}
      />,
    );
    expect(screen.getByText("Page 3 of 3")).toBeDefined();
    screen.getByRole("button", { name: "Previous page" }).click();
    expect(onPageIndexChange).toHaveBeenCalledWith(1);
  });

  it("renders the empty-state slot when rows is empty (falls back to a muted default)", () => {
    const { rerender } = render(
      <DataTable columns={columns()} rows={[]} emptyState={<EmptyState title="No documents yet" />} />,
    );
    expect(screen.getByRole("heading", { name: "No documents yet" })).toBeDefined();

    rerender(<DataTable columns={columns()} rows={[]} />);
    expect(screen.getByText("No rows to display.")).toBeDefined();
  });
});
