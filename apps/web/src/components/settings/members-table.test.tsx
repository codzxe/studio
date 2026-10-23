/**
 * MembersTable tests (W2-06) — the §8.9 Members surface: roster rendering
 * (name/email/role/status/isCurrentUser/lastActiveAt null-honest), the role
 * matrix gating (admin+; owner-target owner-only), role change via Select
 * incl. the typed last-owner 409, remove/leave via ConfirmDialog, the
 * transfer-ownership type-to-confirm dialog (§7.5) with the role swap, and
 * the invite dialog with the W1-e 429 SEATS_EXCEEDED typed arm + the billing
 * link. Deterministic RTL + injected fake ports; no network.
 *
 * Radix Select in jsdom: the pointer-capture open path can't run (packages/ui
 * select.test.tsx precedent) — the keyboard path is deterministic, and the
 * CLOSED-trigger typeahead ("v" → Viewer, "a" → Admin) selects directly.
 */

import { ApiError } from "@studio/api-client";
import type { Invite, Member, OwnershipTransferred, Role } from "@studio/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MembersPort,
  MembersTable,
  canChangeRole,
  canInvite,
  canRemoveMember,
  canTransferOwnership,
} from "./members-table";

const USER = userEvent.setup();

// ---------------------------------------------------------------------------
// Fixtures (the real §7.2 wire shapes)
// ---------------------------------------------------------------------------

const OWNER_ROW: Member = {
  id: "u_owner",
  name: "Ada Owner",
  email: "ada@example.com",
  role: "owner",
  status: "active",
  lastActiveAt: null,
  isCurrentUser: true,
};

const ADMIN_ROW: Member = {
  id: "u_admin",
  name: "Bo Admin",
  email: "bo@example.com",
  role: "admin",
  status: "active",
  lastActiveAt: null,
  isCurrentUser: false,
};

const VIEWER_ROW: Member = {
  id: "u_viewer",
  name: "Cleo Viewer",
  email: "cleo@example.com",
  role: "viewer",
  status: "active",
  lastActiveAt: null,
  isCurrentUser: false,
};

const INVITE: Invite = {
  id: "inv_1",
  workspaceId: "ws_1",
  email: "new@example.com",
  role: "viewer",
  status: "pending",
  expiresAt: null,
  createdAt: "2026-10-23T00:00:00Z",
};

function createPort() {
  return {
    changeRole: vi.fn(),
    remove: vi.fn(),
    transferOwnership: vi.fn(),
    invite: vi.fn(),
  };
}

type FakePort = ReturnType<typeof createPort>;

interface RenderOptions {
  readonly currentRole?: Role;
  readonly members?: readonly Member[];
  readonly seatsLimit?: number | null;
  readonly membersTruncated?: boolean;
}

let port: FakePort;

function renderTable({
  currentRole = "owner",
  members = [OWNER_ROW, ADMIN_ROW, VIEWER_ROW],
  seatsLimit = 5,
  membersTruncated = false,
}: RenderOptions = {}): void {
  render(
    <MembersTable
      workspaceId="ws_1"
      workspaceName="First Films"
      currentRole={currentRole}
      initialMembers={members}
      seatsLimit={seatsLimit}
      membersTruncated={membersTruncated}
      api={port as unknown as MembersPort}
    />,
  );
}

beforeEach(() => {
  port = createPort();
});

// ---------------------------------------------------------------------------
// Roster rendering
// ---------------------------------------------------------------------------

describe("MembersTable — roster", () => {
  it("renders name, email, role, status, last active (null-honest) and the You marker", () => {
    renderTable();
    for (const row of [OWNER_ROW, ADMIN_ROW, VIEWER_ROW]) {
      const cell = screen.getByTestId(`member-row-${row.id}`);
      expect(within(cell).getByText(row.name as string)).toBeInTheDocument();
      expect(within(cell).getByText(row.email as string)).toBeInTheDocument();
      expect(within(cell).getAllByText("Active")).toHaveLength(1);
      expect(within(cell).getByText("—")).toBeInTheDocument(); // lastActiveAt: null
    }
    expect(within(screen.getByTestId("member-row-u_owner")).getByText("You")).toBeInTheDocument();
    expect(screen.getByTestId("members-seats-line")).toHaveTextContent(
      "3 of 5 seats used in First Films.",
    );
  });

  it("degrades honestly when the seat limit is unknown — the member count alone", () => {
    renderTable({ seatsLimit: null });
    expect(screen.getByTestId("members-seats-line")).toHaveTextContent("3 members in First Films.");
  });

  it("marks a truncated roster load as N+ instead of lying with a count", () => {
    renderTable({ seatsLimit: null, membersTruncated: true });
    expect(screen.getByTestId("members-seats-line")).toHaveTextContent(
      "3+ members in First Films.",
    );
  });

  it("falls back to the email as the display name when the name is null", () => {
    const noName: Member = { ...VIEWER_ROW, id: "u_noname", name: null };
    renderTable({ members: [noName] });
    const cell = screen.getByTestId("member-row-u_noname");
    expect(within(cell).getAllByText("cleo@example.com").length).toBeGreaterThanOrEqual(1);
    expect(within(cell).queryByText("Cleo Viewer")).not.toBeInTheDocument();
  });

  it("renders the in-table empty state for an empty roster (§7.9)", () => {
    renderTable({ members: [] });
    expect(screen.getByText("No members to show.")).toBeInTheDocument();
  });

  it("viewers get no management affordances — no invite, no selects, no removes", () => {
    renderTable({ currentRole: "viewer", members: [ADMIN_ROW, VIEWER_ROW] });
    expect(screen.queryByTestId("members-invite-button")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByTestId("member-remove-u_admin")).not.toBeInTheDocument();
    // Roles render as read-only badges for non-admins.
    expect(screen.getByTestId("member-role-u_admin")).toHaveTextContent("Admin");
  });
});

// ---------------------------------------------------------------------------
// Role change
// ---------------------------------------------------------------------------

describe("MembersTable — role change via Select", () => {
  it("an admin changes a member's role through the select", async () => {
    port.changeRole.mockResolvedValue({ ...ADMIN_ROW, role: "viewer" });
    renderTable({ currentRole: "admin" });

    const trigger = screen.getByRole("combobox", { name: "Role for Bo Admin" });
    trigger.focus();
    await USER.keyboard("v"); // closed-trigger typeahead → Viewer
    expect(port.changeRole).toHaveBeenCalledWith("u_admin", "viewer");

    const updated = await screen.findByRole("combobox", { name: "Role for Bo Admin" });
    expect(updated).toHaveTextContent("Viewer");
  });

  it("owner-target rows are owner-only — an admin sees a badge, not a select", () => {
    renderTable({ currentRole: "admin" });
    expect(
      within(screen.getByTestId("member-row-u_owner")).queryByRole("combobox"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("member-role-u_owner")).toHaveTextContent("Owner");
    // …while other rows stay editable for the admin.
    expect(screen.getByRole("combobox", { name: "Role for Bo Admin" })).toBeInTheDocument();
  });

  it("surfaces the typed last-owner 409 (message + hint + request id) and keeps the role", async () => {
    port.changeRole.mockRejectedValue(
      new ApiError({
        code: "CONFLICT",
        status: 409,
        message: "The workspace must keep an owner.",
        hint: "Transfer ownership to another member first.",
        requestId: "req_owner_409",
      }),
    );
    renderTable({ currentRole: "owner", members: [OWNER_ROW, ADMIN_ROW] });

    const trigger = screen.getByRole("combobox", { name: "Role for Ada Owner" });
    trigger.focus();
    await USER.keyboard("a"); // → Admin (the disabled Owner option is typeahead-skipped)
    expect(port.changeRole).toHaveBeenCalledWith("u_owner", "admin");

    const banner = await screen.findByTestId("members-error");
    expect(banner).toHaveTextContent("The workspace must keep an owner.");
    expect(banner).toHaveTextContent("Transfer ownership to another member first.");
    expect(banner).toHaveTextContent("Request req_owner_409");
    // The demotion never landed — the row still says Owner.
    expect(await screen.findByRole("combobox", { name: "Role for Ada Owner" })).toHaveTextContent(
      "Owner",
    );
  });

  it("never offers Owner as a select option — ownership moves only via transfer", async () => {
    renderTable({ currentRole: "admin" });
    const trigger = screen.getByRole("combobox", { name: "Role for Bo Admin" });
    trigger.focus();
    await USER.keyboard("{ArrowDown}"); // open (keyboard path, §12)
    const ownerOption = await screen.findByRole("option", { name: "Owner" });
    expect(ownerOption).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Admin" })).toBeInTheDocument();
    await USER.keyboard("{Escape}");
  });
});

// ---------------------------------------------------------------------------
// Remove / leave
// ---------------------------------------------------------------------------

describe("MembersTable — remove via ConfirmDialog", () => {
  it("names the member and the action; success drops the row", async () => {
    port.remove.mockResolvedValue({ id: "u_viewer", removed: true });
    renderTable({ currentRole: "admin" });

    await USER.click(screen.getByTestId("member-remove-u_viewer"));
    expect(screen.getByText("Remove Cleo Viewer from First Films?")).toBeInTheDocument();
    expect(screen.getByText(/loses access to First Films immediately/)).toBeInTheDocument();

    await USER.click(screen.getByTestId("confirm-confirm"));
    expect(port.remove).toHaveBeenCalledWith("u_viewer");
    await act(async () => {});
    expect(screen.queryByTestId("member-row-u_viewer")).not.toBeInTheDocument();
  });

  it("self-removal renders as Leave; the last-owner 409 surfaces typed", async () => {
    port.remove.mockRejectedValue(
      new ApiError({
        code: "CONFLICT",
        status: 409,
        message: "The workspace must keep an owner.",
        hint: "Transfer ownership to another member first.",
        requestId: "req_leave_409",
      }),
    );
    renderTable({ currentRole: "owner", members: [OWNER_ROW, ADMIN_ROW] });

    await USER.click(screen.getByTestId("member-remove-u_owner"));
    expect(screen.getByText("Leave First Films?")).toBeInTheDocument();

    await USER.click(screen.getByTestId("confirm-confirm"));
    expect(port.remove).toHaveBeenCalledWith("u_owner");
    const banner = await screen.findByTestId("members-error");
    expect(banner).toHaveTextContent("The workspace must keep an owner.");
    // The owner row stays.
    expect(screen.getByTestId("member-row-u_owner")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Transfer ownership
// ---------------------------------------------------------------------------

describe("MembersTable — transfer ownership (§7.5 type-the-action-name)", () => {
  it("is owner-only and hidden on own/owner rows", () => {
    renderTable({ currentRole: "admin" });
    expect(screen.queryByTestId("member-transfer-u_admin")).not.toBeInTheDocument();

    renderTable({ currentRole: "owner" });
    expect(screen.queryByTestId("member-transfer-u_owner")).not.toBeInTheDocument();
    expect(screen.getByTestId("member-transfer-u_admin")).toBeInTheDocument();
  });

  it("gates the confirm on typing the action name, then swaps the roles", async () => {
    const result: OwnershipTransferred = {
      workspaceId: "ws_1",
      ownerId: "u_admin",
      previousOwnerId: "u_owner",
    };
    port.transferOwnership.mockResolvedValue(result);
    renderTable({ currentRole: "owner" });

    await USER.click(screen.getByTestId("member-transfer-u_admin"));
    expect(screen.getByText("Transfer ownership to Bo Admin?")).toBeInTheDocument();
    expect(screen.getByText(/becomes the workspace owner/)).toBeInTheDocument();

    const confirm = screen.getByTestId("confirm-confirm");
    expect(confirm).toBeDisabled();
    await USER.type(screen.getByTestId("confirm-input"), "own");
    expect(confirm).toBeDisabled();
    await USER.type(screen.getByTestId("confirm-input"), "er"); // "owner" — still not the action name
    expect(confirm).toBeDisabled();
    await USER.clear(screen.getByTestId("confirm-input"));
    await USER.type(screen.getByTestId("confirm-input"), "transfer");
    expect(confirm).toBeEnabled();

    await USER.click(confirm);
    expect(port.transferOwnership).toHaveBeenCalledWith("u_admin");
    await act(async () => {});

    // The rows swap: Bo becomes Owner; the caller becomes Admin (and, being
    // an admin now, loses the transfer affordances).
    expect(screen.getByTestId("member-role-u_admin")).toHaveTextContent("Owner");
    expect(screen.getByTestId("member-role-u_owner")).toHaveTextContent("Admin");
    expect(screen.queryByTestId("member-transfer-u_admin")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

describe("MembersTable — invite dialog", () => {
  it("sends the invite with email + role and confirms honestly", async () => {
    port.invite.mockResolvedValue(INVITE);
    renderTable({ currentRole: "admin" });

    await USER.click(screen.getByTestId("members-invite-button"));
    const dialog = screen.getByRole("dialog");
    // Role defaults to viewer (least privilege).
    expect(within(dialog).getByRole("combobox", { name: /role/i })).toHaveTextContent("Viewer");

    await USER.type(within(dialog).getByLabelText(/Email/), "new@example.com");
    await USER.click(within(dialog).getByTestId("invite-submit"));

    expect(port.invite).toHaveBeenCalledWith("new@example.com", "viewer");
    const note = await screen.findByTestId("members-invite-sent");
    expect(note).toHaveTextContent("Invitation sent to new@example.com.");
    // Invited members are pending — they do NOT join the roster table.
    expect(screen.queryByTestId("member-row-new@example.com")).not.toBeInTheDocument();
  });

  it("surfaces the W1-e 429 SEATS_EXCEEDED typed arm with the billing link", async () => {
    port.invite.mockRejectedValue(
      new ApiError({
        code: "SEATS_EXCEEDED",
        status: 429,
        message: "This workspace is at its plan's seat limit.",
        hint: "Upgrade the plan, or remove a member, before inviting more people.",
        requestId: "req_seats_429",
      }),
    );
    renderTable({ currentRole: "admin" });

    await USER.click(screen.getByTestId("members-invite-button"));
    await USER.type(screen.getByLabelText(/Email/), "new@example.com");
    await USER.click(screen.getByTestId("invite-submit"));

    const error = await screen.findByTestId("invite-error");
    expect(error).toHaveTextContent("This workspace is at its plan's seat limit.");
    expect(error).toHaveTextContent(
      "Upgrade the plan, or remove a member, before inviting more people.",
    );
    expect(error).toHaveTextContent("Request req_seats_429");
    const billing = within(error).getByRole("link", { name: "Manage the plan in Billing" });
    expect(billing).toHaveAttribute("href", "/w/billing");
    // The dialog stays open — this is a decision, not a toast (§7.7).
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("members-invite-sent")).not.toBeInTheDocument();
  });

  it("validates the email client-side before any call", async () => {
    renderTable({ currentRole: "admin" });
    await USER.click(screen.getByTestId("members-invite-button"));
    await USER.type(screen.getByLabelText(/Email/), "not-an-email");
    await USER.click(screen.getByTestId("invite-submit"));

    expect(port.invite).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
  });

  it("offers admin/editor/viewer — Owner is never granted by invite", async () => {
    renderTable({ currentRole: "admin" });
    await USER.click(screen.getByTestId("members-invite-button"));
    const trigger = screen.getByRole("combobox", { name: /role/i });
    trigger.focus();
    await USER.keyboard("{ArrowDown}");
    expect(await screen.findByRole("option", { name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Viewer" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
    await USER.keyboard("{Escape}");
  });
});

// ---------------------------------------------------------------------------
// Pure gating helpers (the gateway floors restated — see members-table.tsx)
// ---------------------------------------------------------------------------

describe("MembersTable — gating helpers", () => {
  it("role change is admin+ and owner-target is owner-only", () => {
    expect(canChangeRole("owner", OWNER_ROW)).toBe(true);
    expect(canChangeRole("admin", OWNER_ROW)).toBe(false);
    expect(canChangeRole("admin", ADMIN_ROW)).toBe(true);
    expect(canChangeRole("editor", ADMIN_ROW)).toBe(false);
    expect(canChangeRole("viewer", ADMIN_ROW)).toBe(false);
  });

  it("self-removal is always allowed; removing others is admin+ (owner rows owner-only)", () => {
    expect(canRemoveMember("viewer", { ...VIEWER_ROW, isCurrentUser: true })).toBe(true);
    expect(canRemoveMember("viewer", ADMIN_ROW)).toBe(false);
    expect(canRemoveMember("admin", ADMIN_ROW)).toBe(true);
    const otherOwner: Member = { ...OWNER_ROW, isCurrentUser: false };
    expect(canRemoveMember("admin", otherOwner)).toBe(false);
    expect(canRemoveMember("owner", otherOwner)).toBe(true);
  });

  it("transfer is owner-only, to another non-owner member", () => {
    expect(canTransferOwnership("owner", ADMIN_ROW)).toBe(true);
    expect(canTransferOwnership("owner", OWNER_ROW)).toBe(false);
    expect(canTransferOwnership("admin", ADMIN_ROW)).toBe(false);
  });

  it("invites are admin+", () => {
    expect(canInvite("admin")).toBe(true);
    expect(canInvite("owner")).toBe(true);
    expect(canInvite("editor")).toBe(false);
    expect(canInvite("viewer")).toBe(false);
  });
});
