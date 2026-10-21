import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "./table";

describe("Table (§7.9)", () => {
  it("renders header, rows and numeric cells", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead numeric>Credits</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Launch film</TableCell>
            <TableCell numeric>1,200</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("Project")).toBeInTheDocument();
    expect(within(table).getByText("Launch film")).toBeInTheDocument();
    expect(within(table).getByText("1,200")).toBeInTheDocument();
  });

  it("marks the selected row with the signal left edge (§7.9)", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow data-testid="row-selected" selected>
            <TableCell>Launch film</TableCell>
          </TableRow>
          <TableRow data-testid="row-plain">
            <TableCell>Teaser</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const selected = container.querySelector('[data-testid="row-selected"]');
    const plain = container.querySelector('[data-testid="row-plain"]');
    expect(selected?.className).toContain("shadow-[inset_2px_0_0_0_var(--signal)]");
    expect(plain?.className).not.toContain("shadow-[inset");
    expect(selected?.hasAttribute("data-selected")).toBe(true);
  });

  it("renders the empty state INSIDE the table body (§7.9/§7.12)", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableEmpty colSpan={2}>No projects yet.</TableEmpty>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole("table");
    const empty = within(table).getByText("No projects yet.");
    // It sits in a td spanning every column, inside the body.
    expect(empty.closest("td")).toHaveAttribute("colspan", "2");
    expect(empty.closest("tbody")).not.toBeNull();
  });

  it("stickyHeader wires sticky positioning on the header", () => {
    const { container } = render(
      <Table stickyHeader>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    expect(container.querySelector("table")?.className).toContain("[&_thead]:sticky");
  });
});
