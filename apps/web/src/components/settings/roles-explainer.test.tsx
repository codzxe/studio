/**
 * RolesExplainer tests (W2-06) — the §8.9 Roles surface renders the REAL
 * matrix: all 15 capabilities of packages/db/src/permissions.ts
 * (CAPABILITIES × ROLE_CAPABILITIES) across the four wire roles, sourced —
 * not invented. The expectations below are transcribed from the db source so
 * drift in either place fails here.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RolesExplainer } from "./roles-explainer";

/** permissions.ts `CAPABILITIES` — all 15, in source order. */
const CAPABILITY_KEYS = [
  "read",
  "comment",
  "openEditor",
  "createProjects",
  "takeLease",
  "runAgent",
  "uploadAssets",
  "render",
  "invite",
  "removeMembers",
  "manageBilling",
  "manageApiKeys",
  "manageWorkspace",
  "deleteWorkspace",
  "transferOwnership",
] as const;

/**
 * permissions.ts `ROLE_CAPABILITIES` — the source of truth, transcribed:
 *   VIEWER = read, comment, openEditor
 *   EDITOR = VIEWER + createProjects, takeLease, runAgent, uploadAssets, render
 *   ADMIN  = EDITOR + invite, removeMembers, manageBilling, manageApiKeys,
 *            manageWorkspace
 *   OWNER  = ADMIN + deleteWorkspace, transferOwnership
 */
const SOURCE_MATRIX: Record<(typeof CAPABILITY_KEYS)[number], string[]> = {
  read: ["viewer", "editor", "admin", "owner"],
  comment: ["viewer", "editor", "admin", "owner"],
  openEditor: ["viewer", "editor", "admin", "owner"],
  createProjects: ["editor", "admin", "owner"],
  takeLease: ["editor", "admin", "owner"],
  runAgent: ["editor", "admin", "owner"],
  uploadAssets: ["editor", "admin", "owner"],
  render: ["editor", "admin", "owner"],
  invite: ["admin", "owner"],
  removeMembers: ["admin", "owner"],
  manageBilling: ["admin", "owner"],
  manageApiKeys: ["admin", "owner"],
  manageWorkspace: ["admin", "owner"],
  deleteWorkspace: ["owner"],
  transferOwnership: ["owner"],
};

function allowedOf(row: HTMLElement, role: string): boolean {
  // The row's cell for a role is the (index + 1)th cell — capability first,
  // then viewer/editor/admin/owner in column order.
  const cells = within(row).getAllByRole("cell");
  const order = ["viewer", "editor", "admin", "owner"];
  const index = order.indexOf(role) + 1;
  const cell = cells[index];
  if (cell === undefined) throw new Error(`no cell for role ${role}`);
  return within(cell).queryByText("Allowed") !== null;
}

describe("RolesExplainer — the real 15 × 4 matrix", () => {
  it("renders all 15 capabilities from permissions.ts CAPABILITIES", () => {
    render(<RolesExplainer />);
    for (const key of CAPABILITY_KEYS) {
      expect(screen.getByTestId(`capability-${key}`)).toBeInTheDocument();
    }
    // …and nothing invented on top (exactly 15 rows).
    const rows = screen.getAllByTestId(/^capability-/);
    expect(rows).toHaveLength(15);
  });

  it("matches every cell to the permissions.ts ROLE_CAPABILITIES source", () => {
    render(<RolesExplainer />);
    for (const key of CAPABILITY_KEYS) {
      const row = screen.getByTestId(`capability-${key}`);
      for (const role of ["viewer", "editor", "admin", "owner"] as const) {
        expect(allowedOf(row, role)).toBe(SOURCE_MATRIX[key].includes(role));
      }
    }
  });

  it("spot-checks the load-bearing arms a reader would rely on", () => {
    render(<RolesExplainer />);
    const viewerRow = screen.getByTestId("capability-invite");
    expect(allowedOf(viewerRow, "viewer")).toBe(false);
    expect(allowedOf(viewerRow, "editor")).toBe(false);
    expect(allowedOf(viewerRow, "admin")).toBe(true);

    const deleteRow = screen.getByTestId("capability-deleteWorkspace");
    expect(allowedOf(deleteRow, "admin")).toBe(false);
    expect(allowedOf(deleteRow, "owner")).toBe(true);

    const readRow = screen.getByTestId("capability-read");
    expect(allowedOf(readRow, "viewer")).toBe(true);
  });

  it("explains each role in one line before the matrix", () => {
    render(<RolesExplainer />);
    for (const role of ["owner", "admin", "editor", "viewer"] as const) {
      const summary = screen.getByTestId(`role-summary-${role}`);
      expect(within(summary).getByText(role)).toBeInTheDocument();
      expect(summary.textContent?.length).toBeGreaterThan(20);
    }
  });

  it("says the server enforces the matrix — UI hiding is never the enforcement", () => {
    render(<RolesExplainer />);
    expect(screen.getByTestId("roles-explainer")).toHaveTextContent(
      /server re-checks every action/i,
    );
  });
});
