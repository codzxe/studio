"use client";

/**
 * `ShareLinksCard` — the §8.6 secondary "Share" action of the project hub's
 * Overview tab: the member share-link surface (contracts routes/share.ts +
 * `client.share`), mounted by `hub-overview.tsx`.
 *
 * Security pins carried into the UI:
 * - `share.issueLink` returns the raw token EXACTLY ONCE — the issued URL is
 *   shown in a highlighted once-box with Copy, and is dropped the moment the
 *   dialog closes. It is NEVER re-fetchable: the list (`share.listLinks`)
 *   carries no token material, only row metadata.
 * - The URL is `{origin}/s/{token}` (the public player route — anonymous
 *   visitors get the player, never the editor, v1 pin).
 * - `share.revokeLink` is a destructive action → ConfirmDialog that names the
 *   consequence (§7.5); revocation is idempotent upstream and the row leaves
 *   the active list on success. Revoke authority (creator-or-admin) is
 *   re-checked by the gateway — failures surface as typed §7.3 copy.
 *
 * The gateway floors: issue = editor+, list = viewer+, revoke =
 * creator-or-admin. `canManage` (editor+) gates the whole trigger — the
 * overview already computes the role floor.
 */

import type { ShareLinkIssued, ShareLinkView } from "@studio/contracts";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Skeleton,
} from "@studio/ui";
import { CircleAlert, Copy } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type HubActionError,
  type ShareLinksPort,
  boundedHubText,
  createShareLinksPort,
  hubErrorLine,
  toHubActionError,
} from "./hub-port";

/** UTC day label for created/expires copy: "Nov 4, 2026" (§14, deterministic). */
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function parseInstant(iso: string): Date | null {
  const date = new Date(iso.length > 100 ? iso.slice(0, 100) : iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Created Nov 4, 2026 · No expiry" / "… · Expires Nov 11, 2026 · Password". */
export function shareLinkRowCopy(link: ShareLinkView, nowIso: string): string {
  const created = parseInstant(link.createdAt);
  const parts: string[] = [
    created === null ? "Created —" : `Created ${DAY_FORMAT.format(created)}`,
  ];
  if (link.expiresAt === null) {
    parts.push("No expiry");
  } else {
    const expires = parseInstant(link.expiresAt);
    const now = parseInstant(nowIso);
    if (expires === null || now === null) {
      parts.push("Expires —");
    } else if (expires.getTime() <= now.getTime()) {
      parts.push("Expired");
    } else {
      parts.push(`Expires ${DAY_FORMAT.format(expires)}`);
    }
  }
  if (link.hasPassword) parts.push("Password protected");
  return parts.join(" · ");
}

/** The public player URL for a freshly minted token (the ONLY token surface). */
export function shareLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/s/${token}`;
}

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
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export interface ShareLinksCardProps {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly projectName: string;
  /** Editor+ — the issue route's floor; gates the whole Share surface. */
  readonly canManage: boolean;
  /** ISO instant stamped by the RSC — pins expiry copy (deterministic). */
  readonly nowIso: string;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: ShareLinksPort;
  /** Origin for the shown-once URL (default: `window.location.origin`). */
  readonly origin?: string;
}

export function ShareLinksCard({
  projectId,
  workspaceId,
  projectName,
  canManage,
  nowIso,
  api,
  origin,
}: ShareLinksCardProps): ReactElement | null {
  // One port per mount (the session-client pattern: pure factory).
  const [port] = useState<ShareLinksPort>(
    () => api ?? createShareLinksPort(workspaceId, projectId),
  );

  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<readonly ShareLinkView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // The shown-once issuance: present until the dialog closes, then gone.
  const [issued, setIssued] = useState<ShareLinkIssued | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<HubActionError | null>(null);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const refresh = useCallback((): void => {
    setLoading(true);
    setListError(null);
    void port
      .listLinks()
      .then((page) => {
        // "Active links": revoked rows never render.
        setLinks(page.items.filter((link) => link.revokedAt === null));
      })
      .catch((cause: unknown) => {
        setLinks([]);
        setListError(hubErrorLine(toHubActionError(cause)));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [port]);

  // Load (and reload) on every open; drop the once-token on close.
  useEffect(() => {
    if (!open) {
      setIssued(null);
      setCopied(false);
      return;
    }
    refresh();
  }, [open, refresh]);

  const issue = useCallback((): void => {
    if (issuing) return;
    setIssuing(true);
    setActionError(null);
    setCopied(false);
    void port
      .issueLink()
      .then((issuedLink) => {
        setIssued(issuedLink);
        refresh();
      })
      .catch((cause: unknown) => {
        setActionError(toHubActionError(cause));
      })
      .finally(() => {
        setIssuing(false);
      });
  }, [issuing, port, refresh]);

  const displayedOrigin = origin ?? (typeof window === "undefined" ? "" : window.location.origin);

  const copyIssued = useCallback((): void => {
    if (issued === null) return;
    const url = shareLinkUrl(displayedOrigin, issued.token);
    const clipboard =
      typeof navigator === "undefined" || navigator.clipboard == null
        ? undefined
        : navigator.clipboard;
    if (clipboard != null && typeof clipboard.writeText === "function") {
      clipboard.writeText(url).then(
        () => setCopied(true),
        () => setCopied(legacyCopy(url)),
      );
    } else {
      setCopied(legacyCopy(url));
    }
  }, [displayedOrigin, issued]);

  const revoke = useCallback((): void => {
    if (confirmId === null || revoking) return;
    setRevoking(true);
    setActionError(null);
    void port
      .revokeLink(confirmId)
      .then(() => {
        setConfirmId(null);
        setLinks((previous) =>
          previous === null ? previous : previous.filter((link) => link.id !== confirmId),
        );
      })
      .catch((cause: unknown) => {
        setActionError(toHubActionError(cause));
      })
      .finally(() => {
        setRevoking(false);
      });
  }, [confirmId, port, revoking]);

  if (!canManage) return null;

  return (
    <div data-testid="hub-share-card" className="flex flex-col gap-3">
      <Dialog open={open} onOpenChange={setOpen}>
        <Button
          variant="secondary"
          size="sm"
          data-testid="hub-share-trigger"
          onClick={() => setOpen(true)}
        >
          Share
        </Button>
        <DialogContent data-testid="hub-share-dialog">
          <DialogTitle>Share “{boundedHubText(projectName, 60)}”</DialogTitle>
          <DialogDescription>
            Anyone with the link can watch a preview and leave comments in review mode. They never
            get the editor.
          </DialogDescription>

          {/* The shown-once issuance — the raw token's ONLY appearance. */}
          {issued !== null ? (
            <div
              data-testid="hub-share-issued"
              className="mt-4 rounded-md border border-signal/40 bg-signal/10 p-3"
            >
              <p data-testid="hub-share-issued-note" className="text-caption text-primary">
                Copy this link now — it&apos;s shown only once and can&apos;t be shown again.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code
                  data-testid="hub-share-issued-url"
                  className="min-w-0 flex-1 truncate rounded-sm border border-border bg-input px-2 py-1 font-sans text-caption text-primary"
                >
                  {shareLinkUrl(displayedOrigin, issued.token)}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="hub-share-copy"
                  onClick={copyIssued}
                >
                  <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          ) : null}

          {actionError !== null ? (
            <div
              role="alert"
              data-testid="hub-share-error"
              className="mt-4 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
            >
              <CircleAlert
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-danger"
              />
              <span className="min-w-0 flex-1">{hubErrorLine(actionError)}</span>
            </div>
          ) : null}

          <div className="mt-4" data-testid="hub-share-list">
            {loading && links === null ? (
              <div data-testid="hub-share-loading" className="flex flex-col gap-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-2/3" />
              </div>
            ) : listError !== null ? (
              <div className="flex flex-col items-start gap-2 text-caption text-danger">
                <p data-testid="hub-share-list-error">{listError}</p>
                <Button variant="secondary" size="sm" onClick={refresh}>
                  Try again
                </Button>
              </div>
            ) : links !== null && links.length === 0 ? (
              <p data-testid="hub-share-empty" className="text-caption text-muted">
                No active links yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {(links ?? []).map((link) => (
                  <li
                    key={link.id}
                    data-testid={`hub-share-row-${link.id}`}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-sm border border-border bg-elevated/40 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-caption text-secondary">
                      {shareLinkRowCopy(link, nowIso)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                      data-testid={`hub-share-revoke-${link.id}`}
                      onClick={() => setConfirmId(link.id)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogActions>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={issuing}
              disabled={issuing}
              data-testid="hub-share-create"
              onClick={issue}
            >
              Create link
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmId !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmId(null);
        }}
        title="Revoke this share link?"
        description="Anyone with the link loses access immediately. This can't be undone."
        confirmLabel="Revoke link"
        busy={revoking}
        onConfirm={revoke}
      />
    </div>
  );
}
