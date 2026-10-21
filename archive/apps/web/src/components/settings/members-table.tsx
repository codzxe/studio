"use client";

// apps/web — members & invites table (W8-L; §15.2 RBAC, §13.1 invites).
//
// Sources:
//  - GET /v1/workspaces/:id/members (W4-E, admin+) — authoritative roles +
//    joined dates. Viewers/editors receive a typed 403 envelope; the table
//    then degrades to the Better Auth directory (any member can read it) so
//    the roster stays visible, with management actions hidden.
//  - GET /v1/workspaces/:id/invites (admin+) + POST invites (§13.1): the
//    token is returned in-band until the email wave (TODO(email), routes/
//    workspaces.ts) — after creating an invite the UI shows the /invite/:id
//    accept link with a copy affordance, so the flow works without email.
//
// Actions and their server-side enforcement (§15.2: "UI hiding is not
// enforcement" — every disabled control here is convenience, never the guard):
//  - role change: Better Auth updateMemberRole — the plugin enforces
//    member:update (admin+) plus owner protections; owner rows render
//    read-only (ownership transfer is not offered);
//  - remove: DELETE /v1/workspaces/:id/members/:userId — admin+; the gateway
//    protects the last owner (409 conflict envelope, W4-E removeMember);
//  - invite/cancel: POST / DELETE invites — admin+.
//
// A11y: the roster is a real <table> with a caption + scoped column headers;
// role selects are native <select> labelled per row; inline confirms and
// error envelopes ride role="alert" / aria-live regions.

import { Badge, Button, Input, Label, useFieldIds } from "@studio/ui";
import { Copy, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useSession } from "@/hooks/use-session";
import { isApiError } from "@/lib/api";
import {
  INVITABLE_ROLE_OPTIONS,
  ROLE_DESCRIPTIONS,
  canManageWorkspace,
  formatDate,
  isWorkspaceOwner,
  toSettingsError,
  useCancelInvite,
  useChangeMemberRole,
  useCreateInvite,
  useInvites,
  useMemberDirectory,
  useMembers,
  useRemoveMember,
  type MemberRow,
  type SettingsError,
  type WorkspaceRole,
} from "./use-settings";

// ---------------------------------------------------------------------------
// Props + small helpers
// ---------------------------------------------------------------------------

export interface MembersTableProps {
  readonly workspaceId: string | null;
  /** Caller's role — admin+ unlocks management (§15.2, server-enforced). */
  readonly role: WorkspaceRole;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Masked fallback when no display name/email exists for a member row. */
function maskedId(userId: string): string {
  return `member-${userId.slice(0, 8)}`;
}

function inviteAcceptLink(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MembersTable({ workspaceId, role }: MembersTableProps) {
  const canManage = canManageWorkspace(role);
  const { user } = useSession();

  const members = useMembers(workspaceId);
  const directory = useMemberDirectory(workspaceId);
  const invites = useInvites(workspaceId);

  const changeRole = useChangeMemberRole(workspaceId);
  const removeMember = useRemoveMember(workspaceId);
  const createInvite = useCreateInvite(workspaceId);
  const cancelInvite = useCancelInvite(workspaceId);

  // Roster: the gateway list is authoritative (admin+); directory rows fill
  // display names and double as the viewer/editor fallback when the members
  // endpoint answers 403.
  const rows = useMemo<readonly MemberRow[] | null>(() => {
    if (members.data !== undefined) {
      return members.data.map((row) => {
        const directoryRow = directory.data?.get(row.id);
        return {
          ...row,
          name: row.name ?? directoryRow?.name ?? null,
          email: row.email ?? directoryRow?.email ?? null,
        };
      });
    }
    if (directory.data !== undefined) {
      return [...directory.data.values()];
    }
    return null;
  }, [members.data, directory.data]);

  const listForbidden =
    members.isError && isApiError(members.error) && members.error.status === 403;
  const listError = members.isError ? toSettingsError(members.error) : null;
  const directoryError = directory.isError ? toSettingsError(directory.error) : null;

  const ownerCount = rows?.filter((row) => isWorkspaceOwner(row.role)).length ?? 0;
  const lastOwnerProtected = ownerCount === 1;

  return (
    <div className="flex flex-col gap-6">
      {!canManage ? (
        <p className="rounded-md border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
          Managing members requires the admin role. Permissions are enforced server-side
          (§15.2) —
          you have the <strong>{role}</strong> role, so the roster is read-only for you.
        </p>
      ) : (
        <p className="rounded-md border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
          Roles: viewer (read + comment), editor (runs + commands), admin (members + invites),
          owner (delete). A changed role applies on the member&apos;s next request. Ownership
          transfer is not offered here.
        </p>
      )}

      {/* Roster */}
      {rows !== null ? (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Members of this workspace — name, email, role and join date.
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Member</th>
              <th scope="col" className="py-2 pr-3 font-medium">Email</th>
              <th scope="col" className="py-2 pr-3 font-medium">Role</th>
              <th scope="col" className="py-2 pr-3 font-medium">Joined</th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Remove member</span>
                <span aria-hidden="true">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <MemberTableRow
                key={row.id}
                row={row}
                isSelf={user?.id === row.userId}
                canManage={canManage}
                lastOwnerProtected={lastOwnerProtected}
                changePending={
                  changeRole.isPending && changeRole.variables?.memberId === row.id
                }
                removePending={removeMember.isPending && removeMember.variables === row.userId}
                rowError={
                  (changeRole.error !== null && changeRole.variables?.memberId === row.id) ||
                  (removeMember.error !== null && removeMember.variables === row.userId)
                    ? toSettingsError(changeRole.error ?? removeMember.error)
                    : null
                }
                onRoleChange={(nextRole) => {
                  changeRole.mutate({ memberId: row.id, role: nextRole });
                }}
                onRemove={() => {
                  removeMember.mutate(row.userId);
                }}
              />
            ))}
          </tbody>
        </table>
      ) : listForbidden ? (
        directoryError !== null ? (
          <div role="alert" className="flex flex-col gap-2 rounded-md border border-border bg-surface-muted p-4 text-sm">
            <p className="font-medium">{directoryError.message}</p>
            <p className="text-xs text-muted-foreground">
              The member roster could not be loaded for your role.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void directory.refetch();
              }}
              className="w-fit border-border"
            >
              Try again
            </Button>
          </div>
        ) : (
          <div aria-busy="true" className="flex flex-col gap-2">
            <div className="h-9 rounded-md bg-surface-muted" />
            <div className="h-9 rounded-md bg-surface-muted" />
            <div className="h-9 rounded-md bg-surface-muted" />
          </div>
        )
      ) : listError !== null ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-border bg-surface-muted p-4 text-sm">
          <p className="font-medium">{listError.message}</p>
          <p className="text-xs text-muted-foreground">
            {listError.hint === undefined ? `Code: ${listError.code}` : listError.hint}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void members.refetch();
            }}
            className="w-fit border-border"
          >
            Try again
          </Button>
        </div>
      ) : (
        <div aria-busy="true" className="flex flex-col gap-2">
          <div className="h-9 rounded-md bg-surface-muted" />
          <div className="h-9 rounded-md bg-surface-muted" />
          <div className="h-9 rounded-md bg-surface-muted" />
        </div>
      )}

      {/* Invite form (admin+) */}
      {canManage ? (
        <InviteForm
          pending={createInvite.isPending}
          error={createInvite.error === null ? null : toSettingsError(createInvite.error)}
          created={
            createInvite.data === undefined
              ? null
              : {
                  email: createInvite.data.email,
                  link: inviteAcceptLink(createInvite.data.token),
                }
          }
          onInvite={(email, inviteRole) => {
            createInvite.mutate({ email, role: inviteRole });
          }}
        />
      ) : null}

      {/* Invites (admin+) */}
      {canManage && invites.data !== undefined ? (
        <section aria-labelledby="invites-heading" className="flex flex-col gap-2">
          <h3 id="invites-heading" className="text-sm font-semibold text-foreground">
            Invites
          </h3>
          {invites.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No invites yet — invite a teammate above.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {invites.data.map((invite) => (
                <li
                  key={invite.token}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                >
                  <span className="font-medium">{invite.email}</span>
                  <Badge variant="outline" className="border-border capitalize">
                    {invite.role}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-border bg-surface-muted text-muted-foreground"
                  >
                    {invite.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Expires {formatDate(invite.expiresAt)}
                  </span>
                  {invite.status !== "pending" ? null : (
                    <>
                      <CopyLinkButton link={inviteAcceptLink(invite.token)} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          cancelInvite.isPending && cancelInvite.variables === invite.token
                        }
                        onClick={() => {
                          cancelInvite.mutate(invite.token);
                        }}
                        className="text-muted-foreground hover:text-red-600"
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {cancelInvite.error === null ? null : (
            <p role="alert" className="text-xs text-red-600">
              {toSettingsError(cancelInvite.error).message}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Invite links accept only the invited email and expire (§13.1). Email delivery is
            coming — until then, share the link directly.
          </p>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One roster row (own component — stable hook order, per-row confirm state)
// ---------------------------------------------------------------------------

function MemberTableRow({
  row,
  isSelf,
  canManage,
  lastOwnerProtected,
  changePending,
  removePending,
  rowError,
  onRoleChange,
  onRemove,
}: {
  readonly row: MemberRow;
  readonly isSelf: boolean;
  readonly canManage: boolean;
  readonly lastOwnerProtected: boolean;
  readonly changePending: boolean;
  readonly removePending: boolean;
  readonly rowError: SettingsError | null;
  readonly onRoleChange: (role: "admin" | "editor" | "viewer") => void;
  readonly onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const isOwnerRow = isWorkspaceOwner(row.role);
  const displayName = row.name ?? maskedId(row.userId);

  return (
    <>
      <tr className="border-b border-border align-middle">
        <td className="py-2.5 pr-3">
          <span className="font-medium">
            {displayName}
            {isSelf ? <span className="ml-1 text-xs text-muted-foreground">(you)</span> : null}
          </span>
        </td>
        <td className="py-2.5 pr-3 text-muted-foreground">
          {row.email ?? <span className="opacity-60">—</span>}
        </td>
        <td className="py-2.5 pr-3">
          <span className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={
                isOwnerRow
                  ? "border-border bg-accent/15 text-accent capitalize"
                  : "border-border capitalize"
              }
              title={ROLE_DESCRIPTIONS[row.role]}
            >
              {row.role}
            </Badge>
            {isOwnerRow && lastOwnerProtected ? (
              <span className="text-xs text-muted-foreground">Last owner — protected</span>
            ) : null}
          </span>
          {isOwnerRow ? null : (
            <select
              value={row.role}
              aria-label={`Change role for ${displayName}`}
              disabled={!canManage || changePending}
              onChange={(event) => {
                onRoleChange(event.target.value as "admin" | "editor" | "viewer");
              }}
              className="mt-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground disabled:opacity-50"
            >
              <option value="admin">Admin</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          )}
        </td>
        <td className="py-2.5 pr-3 text-muted-foreground">{formatDate(row.joinedAt)}</td>
        <td className="py-2.5">
          {!canManage || isOwnerRow ? (
            <span className="text-xs text-muted-foreground opacity-60">
              {isOwnerRow ? "Protected" : "—"}
            </span>
          ) : confirming ? (
            <span className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirming(false);
                }}
                className="border-border"
              >
                Keep
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={removePending}
                onClick={onRemove}
                className="bg-red-600 text-white hover:opacity-90"
              >
                {removePending ? "Removing…" : "Confirm remove"}
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${displayName} from the workspace`}
              onClick={() => {
                setConfirming(true);
              }}
              className="text-muted-foreground hover:text-red-600"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </td>
      </tr>
      {rowError === null ? null : (
        <tr>
          <td colSpan={5} className="pb-2">
            <p role="alert" className="text-xs text-red-600">
              {rowError.hint === undefined
                ? rowError.message
                : `${rowError.message} ${rowError.hint}`}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Invite form
// ---------------------------------------------------------------------------

function InviteForm({
  pending,
  error,
  created,
  onInvite,
}: {
  readonly pending: boolean;
  readonly error: SettingsError | null;
  readonly created: { readonly email: string; readonly link: string } | null;
  readonly onInvite: (email: string, role: "admin" | "editor" | "viewer") => void;
}) {
  const ids = useFieldIds("invite-member");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "editor" | "viewer">("viewer");
  const emailInvalid = email !== "" && !EMAIL_RE.test(email);

  function submit(): void {
    const trimmed = email.trim();
    if (trimmed === "" || !EMAIL_RE.test(trimmed)) {
      return;
    }
    onInvite(trimmed, inviteRole);
    setEmail("");
  }

  return (
    <section aria-labelledby="invite-heading" className="flex flex-col gap-3">
      <div>
        <h3 id="invite-heading" className="text-sm font-semibold text-foreground">
          Invite a teammate
        </h3>
        <p className="text-xs text-muted-foreground">
          The invite is emailed — pending the email wave, the accept link is shown here right
          after you send it.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.inputId}>Email</Label>
          <Input
            id={ids.inputId}
            type="email"
            value={email}
            placeholder="teammate@example.com"
            autoComplete="off"
            aria-invalid={emailInvalid}
            aria-describedby={emailInvalid ? ids.errorId : undefined}
            onChange={(event) => setEmail(event.target.value)}
            className="w-72 border-border"
          />
          {emailInvalid ? (
            <p id={ids.errorId} className="text-xs text-red-600">
              Enter a valid email address.
            </p>
          ) : null}
        </div>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Role</span>
          <select
            value={inviteRole}
            onChange={(event) => {
              setInviteRole(event.target.value as "admin" | "editor" | "viewer");
            }}
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
          >
            {INVITABLE_ROLE_OPTIONS.map((option) => (
              <option key={option.role} value={option.role}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          onClick={submit}
          disabled={pending || email.trim() === "" || emailInvalid}
          aria-busy={pending}
          className="bg-accent text-accent-foreground hover:opacity-90"
        >
          <UserPlus aria-hidden="true" />
          {pending ? "Inviting…" : "Send invite"}
        </Button>
      </div>

      {error === null ? null : (
        <div role="alert" className="rounded-md border border-border bg-surface-muted p-3 text-sm">
          <p className="font-medium">{error.message}</p>
          {error.hint === undefined ? null : (
            <p className="mt-1 text-xs text-muted-foreground">{error.hint}</p>
          )}
        </div>
      )}

      {created === null ? null : (
        <div
          aria-live="polite"
          className="rounded-md border border-border bg-surface-muted p-3 text-sm"
        >
          <p className="font-medium">Invited {created.email}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Share this accept link (shown here until email delivery lands):
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              readOnly
              value={created.link}
              aria-label="Invite accept link"
              className="w-full max-w-md border-border bg-surface font-mono text-xs"
            />
            <CopyLinkButton link={created.link} />
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Copy affordance
// ---------------------------------------------------------------------------

function CopyLinkButton({ link }: { readonly link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={copied ? "Link copied" : "Copy invite link"}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(link)
          .then(() => {
            setCopied(true);
          })
          .catch(() => {
            setCopied(false);
          });
      }}
      className="border-border"
    >
      <Copy aria-hidden="true" />
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
