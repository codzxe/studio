"use client";

/**
 * MembersTable — the `/w/settings/members` client root (W2-06, §8.9
 * "Members": table with name, email, role, status, last active; invite
 * dialog).
 *
 * The RSC route (`app/(app)/w/(shell)/settings/members/page.tsx`) resolves
 * the workspace, loads the roster (bounded pages of `GET
 * /v1/workspaces/:id/members`) and the plan's seat limit (`GET
 * /v1/billing/state → entitlements.seats`), then hands over ONE serializable
 * payload. Every mutation lives here through `@studio/api-client` same-origin
 * with the workspace header (the BillingPort pattern):
 *
 * - Role change — Select per row, admin+ (the gateway's `manageWorkspace`
 *   floor routes/members.ts:380); an OWNER-target row is owner-only
 *   (routes/members.ts:389); "owner" is never a select option — ownership
 *   moves only through the transfer-ownership dialog. The last-owner 409
 *   CONFLICT ("The workspace must keep an owner.") is typed-surfaced.
 * - Remove — ConfirmDialog (§7.5, danger; the button names the action).
 *   Self-removal renders as "Leave" (any member may leave, §7.1).
 * - Transfer ownership — owner-only danger dialog gated by typing the action
 *   name (§7.5 "destructive dialogs require the action name").
 * - Invite — Dialog with email + role (`invites.create`); the W1-e seat gate
 *   answers 429 SEATS_EXCEEDED, surfaced inline with the billing link.
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY — the
 * wire shapes below restate the §7.2 member/invite surfaces.
 */

import { type ApiClient, type CallOptions, createApiClient, isApiError } from "@studio/api-client";
import type { Invite, Member, MemberRemoved, OwnershipTransferred, Role } from "@studio/contracts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@studio/ui";
import { type FormEvent, useState } from "react";

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/** The member-management surface `@studio/api-client` exposes. */
export interface MembersPort {
  /** PATCH /v1/workspaces/:id/members/:memberId — change a member's role. */
  readonly changeRole: (memberId: string, role: Role, options?: CallOptions) => Promise<Member>;
  /** DELETE /v1/workspaces/:id/members/:memberId — remove (or leave). */
  readonly remove: (memberId: string, options?: CallOptions) => Promise<MemberRemoved>;
  /** POST /v1/workspaces/:id/transfer-ownership — owner only. */
  readonly transferOwnership: (
    memberId: string,
    options?: CallOptions,
  ) => Promise<OwnershipTransferred>;
  /** POST /v1/workspaces/:id/invites — email + role (W1-e seat gate applies). */
  readonly invite: (email: string, role: Role, options?: CallOptions) => Promise<Invite>;
}

/**
 * Compile-time pin (and tiny adapter): the production `ApiClient["members"]`
 * + `invites.create` satisfies {@link MembersPort} — the page never
 * hand-rolls a call.
 */
export function asMembersPort(client: ApiClient, workspaceId: string): MembersPort {
  return {
    changeRole: (memberId, role, options) =>
      client.members.changeRole(workspaceId, memberId, { role }, options),
    remove: (memberId, options) => client.members.remove(workspaceId, memberId, options),
    transferOwnership: (memberId, options) =>
      client.members.transferOwnership(workspaceId, { memberId }, options),
    invite: (email, role, options) => client.invites.create(workspaceId, { email, role }, options),
  };
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** Builds the production port for one workspace page load. */
function createDefaultMembersPort(workspaceId: string): MembersPort {
  return asMembersPort(
    createApiClient({ baseUrl: API_BASE_URL, headers: { "x-workspace-id": workspaceId } }),
    workspaceId,
  );
}

// ---------------------------------------------------------------------------
// Bounded §7.3 failure surface (§14: message + hint + request id)
// ---------------------------------------------------------------------------

interface MembersError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
  /** Stable §7.3 wire code (drives the seat-limit arm's billing link). */
  readonly code?: string;
}

function toMembersError(error: unknown): MembersError {
  if (isApiError(error)) {
    return {
      message: error.message,
      hint: error.hint,
      requestId: error.requestId,
      code: error.code,
    };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

// ---------------------------------------------------------------------------
// Role gating (the gateway re-checks every capability; this only shapes UI)
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

/** admin+ (the gateway's changeRole/remove floor). */
export function isAdminPlus(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Role changes: admin+ — except an OWNER-target row, which is owner-only
 * (routes/members.ts:389). The gateway floors are the enforcement; this only
 * avoids offering an action that would always 403.
 */
export function canChangeRole(current: Role, row: Member): boolean {
  if (!isAdminPlus(current)) return false;
  if (row.role === "owner" && current !== "owner") return false;
  return true;
}

/**
 * Removal: any member may remove THEMSELVES (leave, §7.1); removing others is
 * admin+; removing another OWNER is owner-only (routes/members.ts:464-467).
 */
export function canRemoveMember(current: Role, row: Member): boolean {
  if (row.isCurrentUser) return true;
  if (!isAdminPlus(current)) return false;
  if (row.role === "owner" && current !== "owner") return false;
  return true;
}

/** Transfer ownership: owner-only, to another non-owner member. */
export function canTransferOwnership(current: Role, row: Member): boolean {
  return current === "owner" && !row.isCurrentUser && row.role !== "owner";
}

/** Invites: admin+ (routes/invites.ts:83 `resolveWorkspaceContext(… "admin")`). */
export function canInvite(current: Role): boolean {
  return isAdminPlus(current);
}

function displayNameOf(row: Member): string {
  return row.name ?? row.email ?? "Member";
}

/** Client-side email shape check (UX only — the gateway re-validates, §7.2). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface MembersTableProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** The caller's role in THIS workspace (drives the admin/owner affordances). */
  readonly currentRole: Role;
  /** The server-loaded roster (bounded pages; see the RSC route). */
  readonly initialMembers: readonly Member[];
  /** Plan seat limit from billing.state entitlements; null = unknown (honest). */
  readonly seatsLimit: number | null;
  /** True when the bounded load stopped before the roster ended ("N+"). */
  readonly membersTruncated?: boolean;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: MembersPort;
}

export function MembersTable({
  workspaceId,
  workspaceName,
  currentRole,
  initialMembers,
  seatsLimit,
  membersTruncated = false,
  api,
}: MembersTableProps) {
  const port = api ?? createDefaultMembersPort(workspaceId);

  // After a successful transfer the CALLER becomes admin (previousOwnerId is
  // always the caller — only owners can transfer); the affordances follow
  // without waiting for a page refresh.
  const [effectiveRole, setEffectiveRole] = useState<Role>(currentRole);
  const [members, setMembers] = useState<readonly Member[]>(initialMembers);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<MembersError | null>(null);

  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [transferTarget, setTransferTarget] = useState<Member | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("viewer");
  const [inviteError, setInviteError] = useState<MembersError | null>(null);
  const [inviteSentTo, setInviteSentTo] = useState<string | null>(null);

  const seatCount = members.length;
  const seatsLine =
    seatsLimit === null
      ? `${seatCount}${membersTruncated ? "+" : ""} ${seatCount === 1 && !membersTruncated ? "member" : "members"}`
      : `${seatCount}${membersTruncated ? "+" : ""} of ${seatsLimit} ${seatsLimit === 1 ? "seat" : "seats"} used`;

  // -- actions --------------------------------------------------------------

  async function changeRole(row: Member, role: Role): Promise<void> {
    if (role === row.role || busy !== null) return;
    setBusy(`role:${row.id}`);
    setActionError(null);
    try {
      const updated = await port.changeRole(row.id, role);
      setMembers((prev) => prev.map((member) => (member.id === updated.id ? updated : member)));
    } catch (error) {
      setActionError(toMembersError(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(): Promise<void> {
    const row = removeTarget;
    if (row === null || busy !== null) return;
    setBusy(`remove:${row.id}`);
    setActionError(null);
    try {
      await port.remove(row.id);
      setMembers((prev) => prev.filter((member) => member.id !== row.id));
      setRemoveTarget(null);
    } catch (error) {
      // Typed arms: the last-owner 409 CONFLICT lands here with its hint.
      setActionError(toMembersError(error));
      setRemoveTarget(null);
    } finally {
      setBusy(null);
    }
  }

  async function transferTo(row: Member): Promise<void> {
    if (busy !== null) return;
    setBusy(`transfer:${row.id}`);
    setActionError(null);
    try {
      const result = await port.transferOwnership(row.id);
      setMembers((prev) =>
        prev.map((member) => {
          if (member.id === result.ownerId) return { ...member, role: "owner" };
          if (member.id === result.previousOwnerId) return { ...member, role: "admin" };
          return member;
        }),
      );
      setEffectiveRole("admin");
      setTransferTarget(null);
    } catch (error) {
      setActionError(toMembersError(error));
      setTransferTarget(null);
    } finally {
      setBusy(null);
    }
  }

  function submitInvite(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy !== null) return;
    const email = inviteEmail.trim();
    if (!EMAIL_PATTERN.test(email)) {
      setInviteError({ message: "Enter a valid email address." });
      return;
    }
    setBusy("invite");
    setInviteError(null);
    port
      .invite(email, inviteRole)
      .then(() => {
        setBusy(null);
        setInviteOpen(false);
        setInviteEmail("");
        setInviteRole("viewer");
        setInviteSentTo(email);
      })
      .catch((error: unknown) => {
        setBusy(null);
        setInviteError(toMembersError(error));
      });
  }

  // -- render ---------------------------------------------------------------

  return (
    <section data-testid="members-table" className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-title-l font-medium text-primary">Members</h1>
          <p className="text-body-s text-muted" data-testid="members-seats-line">
            {seatsLine} in {workspaceName}.
          </p>
        </div>
        {canInvite(effectiveRole) ? (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setInviteOpen(true);
              setInviteError(null);
            }}
            data-testid="members-invite-button"
          >
            Invite member
          </Button>
        ) : null}
      </header>

      {inviteSentTo ? (
        <p data-testid="members-invite-sent" className="text-caption text-success">
          Invitation sent to {inviteSentTo}. They appear here once they accept.
        </p>
      ) : null}

      {actionError ? (
        <div role="alert" data-testid="members-error" className="flex flex-col gap-1">
          <p className="text-caption text-danger">{actionError.message}</p>
          {actionError.hint ? <p className="text-caption text-muted">{actionError.hint}</p> : null}
          {actionError.requestId ? (
            <p className="text-caption text-muted">Request {actionError.requestId}</p>
          ) : null}
        </div>
      ) : null}

      <Card className="p-0" data-testid="members-card">
        <Table data-testid="members-list">
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableEmpty colSpan={5}>No members to show.</TableEmpty>
            ) : (
              members.map((row) => {
                const name = displayNameOf(row);
                return (
                  <TableRow key={row.id} data-testid={`member-row-${row.id}`}>
                    <TableCell>
                      <span className="flex items-center gap-3">
                        <Avatar name={name} size="sm" />
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-body-s font-medium text-primary">
                              {name}
                            </span>
                            {row.isCurrentUser ? (
                              <Badge variant="ice" data-testid={`member-you-${row.id}`}>
                                You
                              </Badge>
                            ) : null}
                          </span>
                          <span className="truncate text-caption text-muted">
                            {row.email ?? "—"}
                          </span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell data-testid={`member-role-${row.id}`}>
                      {canChangeRole(effectiveRole, row) ? (
                        <Select
                          value={row.role}
                          onValueChange={(value) => {
                            void changeRole(row, value as Role);
                          }}
                        >
                          <SelectTrigger
                            triggerSize="sm"
                            aria-label={`Role for ${name}`}
                            className="w-32"
                            disabled={busy !== null}
                          />
                          <SelectContent>
                            {/* Ownership is never granted through a role
                                change — the transfer dialog is the ceremony. */}
                            <SelectItem value="owner" disabled>
                              Owner
                            </SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="editor">Editor</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant={row.role === "owner" ? "signal" : "neutral"}>
                          {ROLE_LABELS[row.role]}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="success">Active</Badge>
                    </TableCell>
                    <TableCell>{row.lastActiveAt ?? "—"}</TableCell>
                    <TableCell>
                      {canTransferOwnership(effectiveRole, row) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => {
                            setTransferTarget(row);
                          }}
                          data-testid={`member-transfer-${row.id}`}
                        >
                          Transfer ownership
                        </Button>
                      ) : null}
                      {canRemoveMember(effectiveRole, row) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => {
                            setRemoveTarget(row);
                          }}
                          data-testid={`member-remove-${row.id}`}
                        >
                          {row.isCurrentUser ? "Leave" : "Remove"}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <p className="text-caption text-muted">
        Last-active stamps aren&apos;t recorded yet — the column fills in when per-member activity
        tracking ships.
        {seatsLimit !== null
          ? " Pending invitations also count toward the seat limit (a pending invite holds its seat reserved)."
          : ""}
      </p>

      {canInvite(effectiveRole) ? (
        <Card>
          <CardHeader>
            <CardTitle>Inviting</CardTitle>
            <CardDescription>
              Invitations expire if they aren&apos;t accepted. Admins can invite as viewer, editor
              or admin — new owners are made by transferring ownership, never by invite.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* Remove / leave — destructive confirm; the button names the action. */}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (busy !== null) return;
          if (!open) setRemoveTarget(null);
        }}
        title={
          removeTarget?.isCurrentUser
            ? `Leave ${workspaceName}?`
            : `Remove ${removeTarget === null ? "" : displayNameOf(removeTarget)} from ${workspaceName}?`
        }
        description={
          removeTarget?.isCurrentUser ? (
            <>
              You lose access to {workspaceName} immediately. Your projects, compositions and
              versions stay — nothing is deleted.
            </>
          ) : (
            <>
              {removeTarget === null ? "" : displayNameOf(removeTarget)} loses access to{" "}
              {workspaceName} immediately. Their projects, compositions and versions stay — nothing
              is deleted.
            </>
          )
        }
        confirmLabel={removeTarget?.isCurrentUser ? "Leave workspace" : "Remove member"}
        busy={busy?.startsWith("remove:") ?? false}
        onConfirm={() => {
          void removeMember();
        }}
      />

      {/* Transfer ownership — §7.5: type the action name to confirm. */}
      <ConfirmDialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (busy !== null) return;
          if (!open) setTransferTarget(null);
        }}
        title={`Transfer ownership to ${transferTarget === null ? "" : displayNameOf(transferTarget)}?`}
        description={
          <>
            {transferTarget === null ? "" : displayNameOf(transferTarget)} becomes the workspace
            owner — full control, including billing and deleting the workspace. You become an admin.
            This takes effect immediately.
          </>
        }
        confirmLabel="Transfer ownership"
        confirmText="transfer"
        busy={busy?.startsWith("transfer:") ?? false}
        onConfirm={() => {
          if (transferTarget !== null) void transferTo(transferTarget);
        }}
      />

      {/* Invite — email + role; the W1-e seat gate answers 429 SEATS_EXCEEDED. */}
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (busy === "invite") return;
          setInviteOpen(open);
          if (!open) setInviteError(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            They receive an email invitation and appear in this list once they accept.
          </DialogDescription>
          <form className="mt-4 flex flex-col gap-4" onSubmit={submitInvite} noValidate>
            <Input
              id="invite-email"
              type="email"
              label="Email"
              autoComplete="off"
              value={inviteEmail}
              disabled={busy === "invite"}
              onChange={(event) => {
                setInviteEmail(event.target.value);
              }}
              error={
                inviteError !== null && inviteError.code === undefined ? inviteError.message : null
              }
              required
            />
            <Select
              value={inviteRole}
              onValueChange={(value) => {
                setInviteRole(value as Role);
              }}
            >
              <SelectTrigger
                id="invite-role"
                label="Role"
                disabled={busy === "invite"}
                helperText="Ownership is transferred from the member list — it can't be granted by invite."
              />
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>

            {inviteError && inviteError.code !== undefined ? (
              <div role="alert" data-testid="invite-error" className="flex flex-col gap-1">
                <p className="text-caption text-danger">{inviteError.message}</p>
                {inviteError.hint ? (
                  <p className="text-caption text-muted">{inviteError.hint}</p>
                ) : null}
                {inviteError.code === "SEATS_EXCEEDED" ? (
                  <a
                    href="/w/billing"
                    className="text-caption text-secondary underline underline-offset-3 hover:text-signal"
                  >
                    Manage the plan in Billing
                  </a>
                ) : null}
                {inviteError.requestId ? (
                  <p className="text-caption text-muted">Request {inviteError.requestId}</p>
                ) : null}
              </div>
            ) : null}

            <DialogActions>
              <DialogClose asChild>
                <Button variant="secondary" disabled={busy === "invite"}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                loading={busy === "invite"}
                disabled={busy !== null && busy !== "invite"}
                data-testid="invite-submit"
              >
                Send invitation
              </Button>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
