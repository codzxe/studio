"use client";

/**
 * ApiKeysView — the §8.9 "API keys" surface (PRODUCT_ARCHITECTURE §7.1
 * "scoped, hashed, revocable API keys"; W2-07, manifest "SETTINGS PART 2").
 *
 * Wire truth (contracts routes/api-keys.ts + gateway routes/api-keys.ts):
 * - `GET /v1/workspaces/:id/api-keys` → newest-first `Page<ApiKey>` — the
 *   list NEVER carries key material; `lastUsedAt` stays null until the key
 *   first authenticates (rendered "Never used", never a fake date).
 * - `POST …/api-keys` → `CreatedApiKey` — the plaintext `studio_…` key
 *   crosses the wire EXACTLY ONCE, on create. This view shows it in a
 *   show-once panel with copy + "we cannot show it again"; dismissing the
 *   panel drops it from state for good (the server stores only a SHA-256
 *   hash — there is no read-back to fake).
 * - `DELETE …/api-keys/:keyId` → idempotent revoke; the row re-renders as
 *   "Revoked". The confirm dialog is type-to-confirm naming the KEY NAME
 *   (§7.5 destructive dialogs name the action).
 *
 * Scope chips are Checkbox-less BY DESIGN (§8.9 + the W2-07 manifest): each
 * scope is a real toggle button wearing the Badge styles (`badgeVariants`),
 * `aria-pressed` carrying the selection state — the vocabulary mirrors
 * `API_KEY_SCOPES` from @studio/contracts, pinned by `typeof` (apps/web never
 * runtime-imports the contracts barrel; lib/editor-session/read-only.ts
 * precedent).
 *
 * Role truth: every api-keys route is owner/admin (the `manageApiKeys`
 * capability — resolveWorkspaceContext("admin")). `canManage` comes from the
 * RSC host's membership role; viewers get the honest managed-by note instead
 * of a doomed 403 fetch.
 *
 * Hostile-data safety (law #1 spirit): every wire string is bounded before
 * the DOM, ids never render as copy, and there is no raw-HTML path.
 */

import { isApiError } from "@studio/api-client";
import type * as Contracts from "@studio/contracts";
import type { ApiKey, ApiKeyScope, CreatedApiKey } from "@studio/contracts";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  badgeVariants,
  cn,
} from "@studio/ui";
import { Check, CircleAlert, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import {
  type SettingsPort,
  createDefaultSettingsPort,
  toSettingsActionError,
} from "./settings-port";

// ---------------------------------------------------------------------------
// The scope vocabulary — a typed mirror of contracts API_KEY_SCOPES
// ---------------------------------------------------------------------------

/**
 * Mirror of `API_KEY_SCOPES` (`@studio/contracts` routes/api-keys.ts). The
 * `typeof` pin (read-only.ts precedent) makes any vocabulary change on the
 * contracts side a TYPECHECK failure here: order and membership are locked.
 * `"*"` grants the full v1 vocabulary (expanded server-side at mint time).
 */
export const API_KEY_SCOPES: typeof Contracts.API_KEY_SCOPES = [
  "projects:read",
  "projects:write",
  "renders:queue",
  "chat:run",
  "billing:read",
  "*",
];

/** Max characters any key-derived string may occupy in the DOM (law #1). */
const MAX_NAME_DISPLAY = 40;

function truncateForDisplay(value: string, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Time formatting (§14 date style, UTC-pinned, hostile ISO → "—")
// ---------------------------------------------------------------------------

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function parseInstant(iso: string | null): Date | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const date = new Date(iso.length > 100 ? iso.slice(0, 100) : iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 21, 2026" (§14); hostile ISO → "—". */
export function formatApiKeyDate(iso: string | null): string {
  const date = parseInstant(iso);
  return date === null ? "—" : DATE_FORMAT.format(date);
}

// ---------------------------------------------------------------------------
// Clipboard (the tool-card house pattern: clipboard API + legacy fallback)
// ---------------------------------------------------------------------------

/** Pre-clipboard fallback (non-secure contexts / headless shells). */
function legacyCopy(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard =
    typeof navigator === "undefined" || navigator.clipboard == null
      ? undefined
      : navigator.clipboard;
  if (clipboard != null && typeof clipboard.writeText === "function") {
    return clipboard.writeText(text).then(
      () => true,
      () => legacyCopy(text),
    );
  }
  return Promise.resolve(legacyCopy(text));
}

// ---------------------------------------------------------------------------
// Expiry options (the gateway enforces a 1-day min / 365-day max lifetime —
// every preset stays inside that window)
// ---------------------------------------------------------------------------

interface ExpiryOption {
  readonly value: string;
  readonly label: string;
  readonly days: number | null;
}

const EXPIRY_OPTIONS: readonly ExpiryOption[] = [
  { value: "none", label: "No expiry", days: null },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "365 days", days: 365 },
];

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// The keys list (race-guarded cursor pages — the useActivityPages pattern)
// ---------------------------------------------------------------------------

interface ApiKeysState {
  readonly keys: readonly ApiKey[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly reload: () => void;
}

function listErrorMessage(cause: unknown): string {
  if (isApiError(cause)) return truncateForDisplay(cause.message, 200);
  return "The API keys could not be loaded.";
}

function useApiKeysPage(port: SettingsPort, workspaceId: string, enabled: boolean): ApiKeysState {
  const [keys, setKeys] = useState<readonly ApiKey[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const inFlight = useRef(false);
  const portRef = useRef(port);
  portRef.current = port;

  const fetchFirst = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mySeq = seq.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const result = await portRef.current.listApiKeys(workspaceId, { limit: 50 });
      if (seq.current !== mySeq) return;
      setKeys(result.items);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (seq.current !== mySeq) return;
      setError(listErrorMessage(cause));
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }, [workspaceId]);

  const loadMore = useCallback((): void => {
    if (inFlight.current || loading || loadingMore) return;
    const cursor = nextCursor;
    if (cursor === null) return;
    inFlight.current = true;
    seq.current += 1;
    const mySeq = seq.current;
    setLoadingMore(true);
    setError(null);
    void (async () => {
      try {
        const result = await portRef.current.listApiKeys(workspaceId, { cursor, limit: 50 });
        if (seq.current !== mySeq) return;
        setKeys((current) => {
          const seen = new Set(current.map((key) => key.id));
          const fresh = result.items.filter((key) => !seen.has(key.id));
          return [...current, ...fresh];
        });
        setNextCursor(result.nextCursor);
      } catch (cause) {
        if (seq.current !== mySeq) return;
        setError(listErrorMessage(cause));
      } finally {
        inFlight.current = false;
        if (seq.current === mySeq) setLoadingMore(false);
      }
    })();
  }, [loading, loadingMore, nextCursor, workspaceId]);

  const retry = useCallback((): void => {
    if (keys.length === 0) void fetchFirst();
    else loadMore();
  }, [keys.length, fetchFirst, loadMore]);

  useEffect(() => {
    if (enabled) void fetchFirst();
    else setLoading(false);
  }, [enabled, fetchFirst]);

  return { keys, nextCursor, loading, loadingMore, error, loadMore, retry, reload: fetchFirst };
}

// ---------------------------------------------------------------------------
// Scope chips (Checkbox-less: toggle buttons wearing the Badge styles)
// ---------------------------------------------------------------------------

interface ScopeChipProps {
  readonly scope: ApiKeyScope;
  readonly selected: boolean;
  readonly onToggle: (scope: ApiKeyScope) => void;
}

function ScopeChip({ scope, selected, onToggle }: ScopeChipProps): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`scope-chip-${scope.replace(/[^a-z*]/g, "-").replace(/\*$/, "star")}`}
      onClick={() => onToggle(scope)}
      className={cn(
        badgeVariants({ variant: selected ? "signal" : "neutral" }),
        "cursor-pointer rounded-xs transition-colors duration-120",
        "hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
      )}
    >
      {scope}
    </button>
  );
}

/** The row's scope badges (read-only; "*" reads as the full grant). */
function ScopeBadges({ scopes }: { readonly scopes: readonly ApiKeyScope[] }): ReactElement {
  return (
    <span className="flex max-w-72 flex-wrap gap-1" data-testid="api-key-scopes">
      {scopes.map((scope) => (
        <Badge key={scope} variant={scope === "*" ? "signal" : "neutral"}>
          {scope}
        </Badge>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface ApiKeysViewProps {
  readonly workspaceId: string;
  /** owner/admin (`manageApiKeys`) — the create/revoke surface; else a note. */
  readonly canManage: boolean;
  /** ISO instant stamped by the RSC — expiry presets compute deterministically. */
  readonly nowIso: string;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: SettingsPort;
}

const COLUMNS = 6;

export function ApiKeysView({
  workspaceId,
  canManage,
  nowIso,
  api,
}: ApiKeysViewProps): ReactElement {
  // ONE production construction path (the billing view's useMemo pattern,
  // state-held so a ?ws change mid-session never swaps identity mid-flight).
  const [port] = useState<SettingsPort>(() =>
    api === undefined ? createDefaultSettingsPort(workspaceId) : api,
  );

  const list = useApiKeysPage(port, workspaceId, canManage);

  // -- create dialog ---------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<readonly ApiKeyScope[]>([]);
  const [expiry, setExpiry] = useState("none");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // -- show-once panel -------------------------------------------------------
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  // -- revoke confirm --------------------------------------------------------
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function resetCreateForm(): void {
    setName("");
    setScopes([]);
    setExpiry("none");
    setCreateError(null);
  }

  function toggleScope(scope: ApiKeyScope): void {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function submitCreate(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 32) {
      setCreateError("Names are 1–32 characters.");
      return;
    }
    if (scopes.length < 1) {
      setCreateError("Pick at least one scope.");
      return;
    }
    const option = EXPIRY_OPTIONS.find((candidate) => candidate.value === expiry);
    const base = new Date(nowIso).getTime();
    const expiresAt =
      option !== undefined && option.days !== null && Number.isFinite(base)
        ? new Date(base + option.days * DAY_MS).toISOString()
        : undefined;
    setCreating(true);
    setCreateError(null);
    try {
      const minted = await port.createApiKey(workspaceId, {
        name: trimmed,
        scopes: [...scopes],
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      setCreateOpen(false);
      resetCreateForm();
      setCopied(false);
      setCreated(minted);
      void list.reload();
    } catch (cause) {
      setCreateError(toSettingsActionError(cause).message);
    } finally {
      setCreating(false);
    }
  }

  async function submitRevoke(): Promise<void> {
    const target = revokeTarget;
    if (target === null) return;
    setRevoking(true);
    setActionError(null);
    try {
      await port.revokeApiKey(workspaceId, target.id);
      setRevokeTarget(null);
      void list.reload();
    } catch (cause) {
      setActionError(toSettingsActionError(cause).message);
    } finally {
      setRevoking(false);
    }
  }

  // -- the honest read-only arm (viewers/editors: the routes are admin-only) --
  if (!canManage) {
    return (
      <Card data-testid="api-keys-readonly">
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            API keys are managed by workspace owners and admins. Ask one to mint or revoke a key for
            an integration.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <section data-testid="api-keys-view" aria-label="API keys">
      {/* Show-once panel — the ONLY place plaintext key material ever lives. */}
      {created !== null ? (
        <Card data-testid="api-key-created" className="mb-4 border-signal/50">
          <CardHeader>
            <CardTitle>
              Key “{truncateForDisplay(created.name, MAX_NAME_DISPLAY)}” is ready
            </CardTitle>
            <CardDescription data-testid="api-key-created-warning">
              Copy it now — we cannot show it again. The server stores only a hash; if you lose it,
              revoke the key and mint a new one.
            </CardDescription>
          </CardHeader>
          <div className="flex flex-wrap items-center gap-2 px-6 pb-6">
            <Kbd
              data-testid="api-key-secret"
              className="h-auto min-h-5 w-full max-w-full items-start whitespace-normal break-all px-2 py-1.5 text-left leading-relaxed"
            >
              {created.key}
            </Kbd>
            <span className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                data-testid="api-key-copy"
                onClick={() => {
                  void copyTextToClipboard(created.key).then((ok) => setCopied(ok));
                }}
              >
                {copied ? (
                  <>
                    <Check size={14} strokeWidth={2} aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                    Copy key
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="api-key-done"
                onClick={() => {
                  setCreated(null);
                  setCopied(false);
                }}
              >
                I saved it
              </Button>
            </span>
          </div>
        </Card>
      ) : null}

      {actionError !== null ? (
        <div
          role="alert"
          data-testid="api-keys-action-error"
          className="mb-4 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-danger"
          />
          <p className="min-w-0 flex-1">{actionError}</p>
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>API keys</CardTitle>
            <CardDescription>
              Scoped, hashed at rest, revocable. Use them for the API and integrations — never in a
              browser.
            </CardDescription>
          </div>
          <Button
            variant="primary"
            size="sm"
            data-testid="api-key-create-open"
            onClick={() => {
              resetCreateForm();
              setCreateOpen(true);
            }}
          >
            Create key
          </Button>
        </CardHeader>

        {list.error !== null ? (
          <div
            role="alert"
            data-testid="api-keys-error"
            className="mx-6 mb-2 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
          >
            <CircleAlert
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-danger"
            />
            <p className="min-w-0 flex-1">{list.error}</p>
            <Button
              variant="secondary"
              size="sm"
              data-testid="api-keys-error-retry"
              disabled={list.loading}
              onClick={list.retry}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {list.loading && list.keys.length === 0 ? (
          <div className="flex flex-col gap-2 px-6 pb-6" data-testid="api-keys-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : list.keys.length === 0 && list.error === null ? (
          <div className="px-6 pb-6">
            <EmptyState data-testid="api-keys-empty" title="No API keys yet." />
          </div>
        ) : (
          <div className="px-2 pb-4 sm:px-4">
            <Table aria-label="API keys" data-testid="api-keys-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.keys.map((key) => (
                  <TableRow
                    key={key.id}
                    data-testid="api-key-row"
                    data-enabled={key.enabled ? "true" : "false"}
                  >
                    <TableCell className="font-medium text-primary">
                      {truncateForDisplay(key.name, MAX_NAME_DISPLAY)}
                    </TableCell>
                    <TableCell>
                      <ScopeBadges scopes={key.scopes} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatApiKeyDate(key.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {key.expiresAt === null ? (
                        <span className="text-muted">Never</span>
                      ) : (
                        formatApiKeyDate(key.expiresAt)
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {key.lastUsedAt === null ? (
                        <span className="text-muted" data-testid="api-key-never-used">
                          Never used
                        </span>
                      ) : (
                        formatApiKeyDate(key.lastUsedAt)
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {key.enabled ? (
                          <Badge variant="success" data-testid="api-key-status">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="danger" data-testid="api-key-status">
                            Revoked
                          </Badge>
                        )}
                        {key.enabled ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-danger"
                            data-testid="api-key-revoke"
                            onClick={() => setRevokeTarget(key)}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {list.keys.length === 0 ? (
                  <TableEmpty colSpan={COLUMNS} data-testid="api-keys-empty-row">
                    No API keys yet.
                  </TableEmpty>
                ) : null}
              </TableBody>
            </Table>
            {list.nextCursor !== null ? (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="api-keys-load-more"
                  loading={list.loadingMore}
                  disabled={list.loading || list.loadingMore}
                  onClick={list.loadMore}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      {/* Create dialog: name + scope chips + expiry preset. */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreateForm();
        }}
      >
        <DialogContent aria-describedby="api-key-create-description">
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription id="api-key-create-description">
            The key works immediately and is shown once when you create it.
          </DialogDescription>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <label className="flex flex-col gap-2">
              <span className="text-label uppercase tracking-[0.06em] text-secondary">
                Name
                <span className="ml-1 text-danger" aria-hidden="true">
                  *
                </span>
              </span>
              <input
                type="text"
                className="h-9 w-full rounded-sm border border-border bg-input px-2 text-body text-primary outline-offset-2 focus-visible:outline-2 focus-visible:outline-signal"
                placeholder="CI renders"
                value={name}
                maxLength={32}
                autoComplete="off"
                data-testid="api-key-name-input"
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-label uppercase tracking-[0.06em] text-secondary">
                Scopes
                <span className="ml-1 text-danger" aria-hidden="true">
                  *
                </span>
              </legend>
              <div className="flex flex-wrap gap-1.5" data-testid="api-key-scope-chips">
                {API_KEY_SCOPES.map((scope) => (
                  <ScopeChip
                    key={scope}
                    scope={scope}
                    selected={scopes.includes(scope)}
                    onToggle={toggleScope}
                  />
                ))}
              </div>
              <p className="text-caption text-muted">
                “*” grants the full v1 vocabulary — every scope above.
              </p>
            </fieldset>

            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger label="Expiry" data-testid="api-key-expiry-trigger" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent data-testid="api-key-expiry-content">
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {createError !== null ? (
              <p
                role="alert"
                data-testid="api-key-create-error"
                className="text-caption text-danger"
              >
                {createError}
              </p>
            ) : null}

            <DialogActions>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCreateOpen(false);
                  resetCreateForm();
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={creating}
                disabled={creating}
                data-testid="api-key-create-submit"
              >
                Create key
              </Button>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm — type the KEY NAME (§7.5: the action is named). */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke API key"
        description={
          revokeTarget === null
            ? null
            : `“${truncateForDisplay(revokeTarget.name, MAX_NAME_DISPLAY)}” stops working immediately — every request using it gets a 401. This cannot be undone.`
        }
        confirmLabel="Revoke key"
        confirmText={revokeTarget === null ? undefined : revokeTarget.name}
        busy={revoking}
        onConfirm={() => {
          void submitRevoke();
        }}
      />
    </section>
  );
}
