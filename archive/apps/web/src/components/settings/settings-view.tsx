"use client";

// apps/web — settings shell (W8-L): the five tabs over one workspace.
//
// General (rename), Brand (tokens editor), Members (roster + invites),
// API keys (personal scoped keys), Danger zone (owner-only delete + leave).
// The active workspace comes from the session context (W8-A/W8-B shell);
// every server call keys by it, and the caller's role for the §15.2 guards
// comes from GET /v1/workspaces/:id (`role` in the response — the same
// source the gateway's assertCan reads server-side).
//
// TABS NOTE: the @studio/ui Tabs wrap Radix Tabs (roving tabindex,
// ArrowLeft/Right, aria-selected). The kit's default classes lean on tokens
// this app does not map (W8-C token note) — the explicit className overrides
// below (bg-surface-muted / data-[state=active]:bg-surface) keep the tab bar
// legible with the app's own 9-token theme.

import {
  Badge,
  Button,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useFieldIds,
} from "@studio/ui";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { BrandTokensEditor } from "@/components/settings/brand-tokens-editor";
import { ApiKeysSection } from "@/components/settings/api-keys";
import { MembersTable } from "@/components/settings/members-table";
import { useSession } from "@/hooks/use-session";
import {
  ROLE_DESCRIPTIONS,
  canManageWorkspace,
  formatDate,
  isWorkspaceOwner,
  toSettingsError,
  useDeleteWorkspace,
  useLeaveWorkspace,
  useUpdateWorkspace,
  useWorkspace,
  type WorkspaceRole,
} from "@/components/settings/use-settings";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsView() {
  const { activeWorkspaceId, workspacesState } = useSession();
  const { workspace, status, message, refetch } = useWorkspace(activeWorkspaceId);

  if (activeWorkspaceId === null) {
    return (
      <section aria-labelledby="settings-heading" className="flex max-w-3xl flex-col gap-3">
        <h1 id="settings-heading" className="text-2xl font-semibold tracking-tight">
          Settings
        </h1>
        {workspacesState.status === "loading" ? (
          <div aria-busy="true" className="h-24 rounded-md bg-surface-muted" />
        ) : (
          <p className="text-sm text-muted-foreground">
            No active workspace yet — create one from the workspace switcher, then settings open
            here.
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 id="settings-heading" className="text-2xl font-semibold tracking-tight">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          {status === "ready" && workspace !== null ? (
            <>
              <span className="font-medium text-foreground">{workspace.name}</span> · you are{" "}
              <Badge variant="outline" className="border-border capitalize">
                {workspace.role}
              </Badge>
            </>
          ) : (
            "Workspace settings"
          )}
        </p>
      </header>

      {status === "loading" ? (
        <div aria-busy="true" className="h-40 rounded-md bg-surface-muted" />
      ) : status === "error" ? (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-border bg-surface-muted p-4 text-sm">
          <p className="font-medium">{message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void refetch();
            }}
            className="w-fit border-border"
          >
            Try again
          </Button>
        </div>
      ) : workspace === null ? null : (
        <Tabs defaultValue="general" className="flex flex-col gap-4">
          <TabsList className="bg-surface-muted">
            <TabsTrigger
              value="general"
              className="data-[state=active]:bg-surface data-[state=active]:text-foreground"
            >
              General
            </TabsTrigger>
            <TabsTrigger
              value="brand"
              className="data-[state=active]:bg-surface data-[state=active]:text-foreground"
            >
              Brand
            </TabsTrigger>
            <TabsTrigger
              value="members"
              className="data-[state=active]:bg-surface data-[state=active]:text-foreground"
            >
              Members
            </TabsTrigger>
            <TabsTrigger
              value="api-keys"
              className="data-[state=active]:bg-surface data-[state=active]:text-foreground"
            >
              API keys
            </TabsTrigger>
            <TabsTrigger
              value="danger"
              className="data-[state=active]:bg-surface data-[state=active]:text-foreground"
            >
              Danger zone
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general">
            <GeneralPanel
              workspaceId={workspace.id}
              name={workspace.name}
              slug={workspace.slug}
              role={workspace.role}
              createdAt={workspace.createdAt}
            />
          </TabsContent>
          <TabsContent value="brand">
            <BrandTokensEditor
              workspaceId={activeWorkspaceId}
              tokens={workspace.brandTokens}
              role={workspace.role}
            />
          </TabsContent>
          <TabsContent value="members">
            <MembersTable workspaceId={activeWorkspaceId} role={workspace.role} />
          </TabsContent>
          <TabsContent value="api-keys">
            <ApiKeysSection workspaceId={activeWorkspaceId} />
          </TabsContent>
          <TabsContent value="danger">
            <DangerZonePanel
              workspaceId={activeWorkspaceId}
              name={workspace.name}
              role={workspace.role}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// General — identity + rename (PATCH /v1/workspaces/:id, admin+)
// ---------------------------------------------------------------------------

function GeneralPanel({
  workspaceId,
  name,
  slug,
  role,
  createdAt,
}: {
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly role: WorkspaceRole;
  readonly createdAt: Date;
}) {
  const ids = useFieldIds("workspace-name");
  const rename = useUpdateWorkspace(workspaceId);
  const canRename = canManageWorkspace(role);
  const [draftName, setDraftName] = useState(name);
  const [nameError, setNameError] = useState<string | null>(null);
  const trimmed = draftName.trim();
  const dirty = trimmed !== name && trimmed !== "";

  function submit(): void {
    if (trimmed === "") {
      setNameError("The workspace name cannot be empty.");
      return;
    }
    if (trimmed.length > 120) {
      setNameError("Names are at most 120 characters.");
      return;
    }
    setNameError(null);
    rename.mutate({ name: trimmed });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      {!canRename ? (
        <p className="rounded-md border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
          Renaming requires the admin role — enforced server-side (§15.2). Your role:{" "}
          <strong>{role}</strong>.
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.inputId}>Workspace name</Label>
        <div className="flex max-w-md items-start gap-2">
          <Input
            id={ids.inputId}
            value={draftName}
            maxLength={140}
            autoComplete="off"
            disabled={!canRename}
            aria-invalid={nameError !== null}
            aria-describedby={nameError !== null ? ids.errorId : undefined}
            onChange={(event) => setDraftName(event.target.value)}
            className="border-border"
          />
          <Button
            type="button"
            onClick={submit}
            disabled={!canRename || !dirty || rename.isPending}
            aria-busy={rename.isPending}
            className="bg-accent text-accent-foreground hover:opacity-90"
          >
            {rename.isPending ? "Saving…" : "Save name"}
          </Button>
        </div>
        {nameError === null ? null : (
          <p id={ids.errorId} className="text-xs text-red-600">
            {nameError}
          </p>
        )}
        {rename.error === null ? null : (
          <p role="alert" className="text-xs text-red-600">
            {toSettingsError(rename.error).message}
          </p>
        )}
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {rename.isSuccess && !dirty ? "Name saved." : undefined}
        </p>
      </div>

      <dl className="grid max-w-2xl gap-3 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">Slug</dt>
          <dd className="font-mono text-xs">{slug}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">Your role</dt>
          <dd className="flex items-center gap-2">
            <Badge variant="outline" className="border-border capitalize">
              {role}
            </Badge>
            <span className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">Created</dt>
          <dd>{formatDate(createdAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger zone — delete (owner) / leave (any member, last-owner protected)
// ---------------------------------------------------------------------------

function DangerZonePanel({
  workspaceId,
  name,
  role,
}: {
  readonly workspaceId: string;
  readonly name: string;
  readonly role: WorkspaceRole;
}) {
  const remove = useDeleteWorkspace(workspaceId);
  const leave = useLeaveWorkspace(workspaceId);
  const [typed, setTyped] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const isOwner = isWorkspaceOwner(role);
  const ids = useFieldIds("delete-workspace");

  const deleteError = remove.error === null ? null : toSettingsError(remove.error);
  const leaveError = leave.error === null ? null : toSettingsError(leave.error);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="rounded-md border border-red-200 bg-surface p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-red-600">
          <AlertTriangle aria-hidden="true" className="size-4" />
          Delete workspace
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Permanently removes the workspace for every member. This cannot be undone — documents
          and assets are wiped by the platform&apos;s retention job.
        </p>
        {!isOwner ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Only the workspace owner can delete it (§15.2).
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <Label htmlFor={ids.inputId}>
              Type <span className="font-mono">{name}</span> to confirm
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={ids.inputId}
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
                aria-describedby={ids.descriptionId}
                className="max-w-xs border-red-200"
              />
              <Button
                type="button"
                disabled={typed !== name || remove.isPending}
                aria-busy={remove.isPending}
                onClick={() => {
                  remove.mutate();
                }}
                className="bg-red-600 text-white hover:opacity-90"
              >
                {remove.isPending ? "Deleting…" : "Delete forever"}
              </Button>
            </div>
            <p id={ids.descriptionId} className="sr-only">
              Deleting the workspace removes it for all members and cannot be undone.
            </p>
          </div>
        )}
        {deleteError === null ? null : (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {deleteError.message}
          </p>
        )}
      </div>

      <div className="rounded-md border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold text-foreground">Leave workspace</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          You lose access immediately; the workspace continues for remaining members. The last
          owner cannot leave (§15.2 owner protection).
        </p>
        {confirmLeave ? (
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirmLeave(false);
              }}
              className="border-border"
            >
              Stay
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={leave.isPending}
              aria-busy={leave.isPending}
              onClick={() => {
                leave.mutate();
              }}
              className="bg-red-600 text-white hover:opacity-90"
            >
              {leave.isPending ? "Leaving…" : "Confirm leave"}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setConfirmLeave(true);
            }}
            className="mt-3 border-border"
          >
            Leave workspace
          </Button>
        )}
        {leaveError === null ? null : (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {leaveError.message}
          </p>
        )}
      </div>
    </div>
  );
}
