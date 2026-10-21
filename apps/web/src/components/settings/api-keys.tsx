"use client";

// apps/web — API keys section (W8-L; §15.2 scoped, revocable keys).
//
// Keys are PERSONAL (Better Auth api_key.owner_id = the creating user) and
// workspace-bound through the reserved `org:<id>` scope entry the gateway
// mints (auth/api-keys.ts buildApiKeyScopes); effective grants are the key
// scopes INTERSECTED with the owner's current workspace role (ADR-0003) —
// the section therefore renders for every member, with the cap noted.
//
// SHOW-ONCE PATTERN (§15.2 + task contract): the raw key is returned by the
// create endpoint exactly once. It lives in the mutation RESULT (never the
// react-query cache) and one piece of local state, is displayed in the modal
// immediately after creation, and is destroyed when the modal closes
// (reset()). The list never carries it — rows show name/created/last-used/
// enabled/scopes only.
//
// HONEST STATE — the gateway routes are PLANNED (flagged for the gateway
// owner; exact contract in use-settings.ts): Better Auth's apiKey plugin
// cannot serve this UI today (missing @studio/db api_key columns, W4-A gap)
// and its browser create endpoint refuses scopes outright (server-only
// property). Until the routes land, this section renders its typed
// "not available yet" explainer — no fake success, no dead forms.

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useFieldIds,
} from "@studio/ui";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  API_KEY_SCOPES,
  formatDate,
  isApiKeysUnavailable,
  toSettingsError,
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  useSetApiKeyEnabled,
  type ApiKeyRow,
  type ApiKeyScope,
} from "./use-settings";

// ---------------------------------------------------------------------------
// Props + scope display data
// ---------------------------------------------------------------------------

export interface ApiKeysSectionProps {
  readonly workspaceId: string | null;
}

const SCOPE_LABELS: Readonly<Record<ApiKeyScope, string>> = {
  "documents:read": "Read documents",
  "documents:write": "Edit documents",
  "runs:create": "Run the agent",
  "exports:create": "Create exports",
};

/** Show the §15.2 vocabulary as chips; hide internal entries (org binding). */
function visibleScopes(scopes: readonly string[]): readonly ApiKeyScope[] {
  return API_KEY_SCOPES.filter((scope) => scopes.includes(scope));
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function ApiKeysSection({ workspaceId }: ApiKeysSectionProps) {
  const keys = useApiKeys(workspaceId);
  const setEnabled = useSetApiKeyEnabled(workspaceId);
  const revoke = useRevokeApiKey(workspaceId);

  const [createOpen, setCreateOpen] = useState(false);
  const unavailable = keys.isError && isApiKeysUnavailable(keys.error);
  const listError = keys.isError ? toSettingsError(keys.error) : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-md border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
        Keys are personal and hashed at rest. Scopes never exceed your own workspace role
        (ADR-0003), keys are revocable, carry last-used metadata and per-key rate limits (§15.2).
      </p>

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Your keys in this workspace</h3>
        <Button
          type="button"
          onClick={() => {
            setCreateOpen(true);
          }}
          disabled={unavailable}
          className="bg-accent text-accent-foreground hover:opacity-90"
        >
          <Plus aria-hidden="true" />
          Create key
        </Button>
      </div>

      {keys.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <div className="h-14 rounded-md bg-surface-muted" />
          <div className="h-14 rounded-md bg-surface-muted" />
        </div>
      ) : unavailable ? (
        <div className="rounded-md border border-border bg-surface-muted p-4 text-sm">
          <p className="font-medium text-foreground">API keys are almost here</p>
          <p className="mt-1 text-muted-foreground">
            This page is wired and waiting on the workspace key routes. Once they ship, keys
            will be scoped, revocable and shown exactly once at creation (§15.2).
          </p>
        </div>
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
              void keys.refetch();
            }}
            className="w-fit border-border"
          >
            Try again
          </Button>
        </div>
      ) : keys.data === undefined || keys.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No API keys yet. Create one to use the public API — the same commands surface the
          agent uses (§13.4).
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.data.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3 text-sm"
            >
              <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="min-w-[8rem] font-medium">{key.name ?? "Unnamed key"}</span>
              <span className="text-xs text-muted-foreground">
                Created {formatDate(key.createdAt)}
              </span>
              <span className="text-xs text-muted-foreground">
                Last used {key.lastUsedAt === null ? "never" : formatDate(key.lastUsedAt)}
              </span>
              <span className="flex flex-wrap gap-1">
                {visibleScopes(key.scopes).map((scope) => (
                  <span
                    key={scope}
                    className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {scope}
                  </span>
                ))}
              </span>
              <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  role="switch"
                  checked={key.enabled}
                  aria-label={`Enable key ${key.name ?? "unnamed key"}`}
                  disabled={setEnabled.isPending && setEnabled.variables?.id === key.id}
                  onChange={(event) => {
                    setEnabled.mutate({ id: key.id, enabled: event.target.checked });
                  }}
                  className="size-4 accent-accent"
                />
                {key.enabled ? "Enabled" : "Disabled"}
              </label>
              <RevokeButton
                name={key.name ?? "unnamed key"}
                pending={revoke.isPending && revoke.variables === key.id}
                onRevoke={() => {
                  revoke.mutate(key.id);
                }}
              />
            </li>
          ))}
          {revoke.error === null ? null : (
            <li role="alert" className="text-xs text-red-600">
              {toSettingsError(revoke.error).message}
            </li>
          )}
          {setEnabled.error === null ? null : (
            <li role="alert" className="text-xs text-red-600">
              {toSettingsError(setEnabled.error).message}
            </li>
          )}
        </ul>
      )}

      <CreateApiKeyModal
        workspaceId={workspaceId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revoke (two-click confirm)
// ---------------------------------------------------------------------------

function RevokeButton({
  name,
  pending,
  onRevoke,
}: {
  readonly name: string;
  readonly pending: boolean;
  readonly onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Revoke key ${name}`}
        onClick={() => {
          setConfirming(true);
        }}
        className="text-muted-foreground hover:text-red-600"
      >
        <Trash2 aria-hidden="true" />
        Revoke
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setConfirming(false);
        }}
        className="text-muted-foreground"
      >
        Keep
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={onRevoke}
        className="bg-red-600 text-white hover:opacity-90"
      >
        {pending ? "Revoking…" : "Confirm revoke"}
      </Button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Create modal + show-once reveal
// ---------------------------------------------------------------------------

function CreateApiKeyModal({
  workspaceId,
  open,
  onOpenChange,
}: {
  readonly workspaceId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateApiKey(workspaceId);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<readonly ApiKeyScope[]>(["documents:read"]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ids = useFieldIds("create-api-key");

  // Show-once: the raw key is mirrored from the mutation result into local
  // state only for the reveal, then destroyed on close. mutation.reset()
  // clears the react-query-held copy.
  const [revealed, setRevealed] = useState<{ row: ApiKeyRow; key: string } | null>(null);

  function reset(): void {
    setName("");
    setScopes(["documents:read"]);
    setNameError(null);
    setScopesError(null);
    setCopied(false);
    setRevealed(null);
    create.reset();
  }

  function handleOpenChange(next: boolean): void {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  }

  function submit(): void {
    const trimmed = name.trim();
    setNameError(
      trimmed === ""
        ? "Give the key a name so you can recognize it later."
        : trimmed.length > 64
          ? "Names are at most 64 characters."
          : null,
    );
    setScopesError(scopes.length === 0 ? "Pick at least one scope." : null);
    if (trimmed === "" || trimmed.length > 64 || scopes.length === 0) {
      return;
    }
    create.mutate({ name: trimmed, scopes }, {
      onSuccess: (created) => {
        setRevealed({ row: created.row, key: created.key });
      },
    });
  }

  const createError = create.error === null ? null : toSettingsError(create.error);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md border-border bg-surface text-foreground">
        {revealed === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Scoped to this workspace, capped by your own role. The key is shown once —
                store it somewhere safe (§15.2).
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.inputId}>Name</Label>
                <Input
                  id={ids.inputId}
                  value={name}
                  placeholder="CI renders"
                  autoComplete="off"
                  maxLength={80}
                  aria-invalid={nameError !== null}
                  aria-describedby={nameError !== null ? ids.errorId : undefined}
                  onChange={(event) => setName(event.target.value)}
                  className="border-border"
                />
                {nameError === null ? null : (
                  <p id={ids.errorId} className="text-xs text-red-600">
                    {nameError}
                  </p>
                )}
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-foreground">Scopes</legend>
                {API_KEY_SCOPES.map((scope) => (
                  <label
                    key={scope}
                    className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm transition-colors has-checked:border-accent has-checked:bg-surface-muted"
                  >
                    <input
                      type="checkbox"
                      value={scope}
                      checked={scopes.includes(scope)}
                      onChange={(event) => {
                        setScopes(
                          event.target.checked
                            ? [...scopes, scope]
                            : scopes.filter((entry) => entry !== scope),
                        );
                      }}
                      className="size-4 accent-accent"
                    />
                    <span className="flex flex-1 flex-col">
                      <span className="font-mono text-xs">{scope}</span>
                      <span className="text-xs text-muted-foreground">{SCOPE_LABELS[scope]}</span>
                    </span>
                  </label>
                ))}
                {scopesError === null ? null : (
                  <p className="text-xs text-red-600">{scopesError}</p>
                )}
              </fieldset>

              {createError === null ? null : (
                <div
                  role="alert"
                  className="rounded-md border border-border bg-surface-muted p-3 text-sm"
                >
                  <p className="font-medium">{createError.message}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {createError.hint === undefined
                      ? `Code: ${createError.code}`
                      : `${createError.hint} (code ${createError.code})`}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                className="border-border"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={submit}
                disabled={create.isPending}
                aria-busy={create.isPending}
                className="bg-accent text-accent-foreground hover:opacity-90"
              >
                {create.isPending ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Save your key now</DialogTitle>
              <DialogDescription>
                This is the only time the full key is shown. It is stored hashed — not even
                support can recover it. Treat it like a password.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={revealed.key}
                  aria-label="New API key"
                  className="w-full border-border bg-surface font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={copied ? "Key copied" : "Copy key"}
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(revealed.key)
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
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Name: <strong>{revealed.row.name ?? "Unnamed key"}</strong> · scopes:{" "}
                {visibleScopes(revealed.row.scopes).join(", ")}
              </p>
            </div>

            <DialogFooter>
              <Button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="bg-accent text-accent-foreground hover:opacity-90"
              >
                I saved it — done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
