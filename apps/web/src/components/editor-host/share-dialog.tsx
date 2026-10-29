"use client";

/**
 * ShareDialog (extracted from project-bar.tsx, round-13 main-thread fix) —
 * issue (shown-once copy) / list / revoke.
 *
 * WHY EXTRACTED: the Share flow's UI (radix Dialog + ConfirmDialog + Input +
 * Spinner) is CLICK-triggered chrome, but as long as it lived in
 * project-bar.tsx every one of those packages sat in the editor route's
 * EAGER bundle and compiled/evaluated on the main thread during the LCP
 * render-delay window (the 4x-throttled field trace showed 185ms of Compile
 * script + EvaluateScript tasks fighting first paint). project-bar now lazy
 * imports this module on the FIRST Share click — the dialog chunks leave the
 * critical path entirely and cost nothing until a user actually shares.
 *
 * Behavior is UNCHANGED from the pre-extraction dialog (the flows are pinned
 * by project-bar.test.tsx): issue → /s/:token shown ONCE + copy; revoke
 * through ConfirmDialog; typed error copy; the raw token dies with the
 * dialog. The internal reset-on-close effect stays so the component is
 * correct standalone (the parent unmounts it while closed, which resets
 * state the same way).
 */

import type { ApiClient } from "@studio/api-client";
import { isApiError } from "@studio/api-client";
import type { ShareLinkIssued, ShareLinkView } from "@studio/contracts";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Spinner,
} from "@studio/ui";
import { useCallback, useEffect, useState } from "react";

/** The api-client slice the share dialog consumes (structural — tests inject fakes). */
export type ShareClient = Pick<ApiClient, "share">;

/** The active-links list state. */
type LinksState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly items: readonly ShareLinkView[] }
  | { readonly kind: "error"; readonly message: string };

/** Safe action-error copy: the typed server message when present, else neutral. */
function actionErrorCopy(error: unknown): string {
  if (isApiError(error)) return error.message;
  return "That didn't work. Try again in a moment.";
}

/** ISO timestamp → "Oct 21, 2026" (UTC, like the changelog's §14 dates). */
function formatShareDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface ShareDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectName: string;
  readonly projectId: string;
  readonly client: ShareClient;
}

export function ShareDialog({
  open,
  onOpenChange,
  projectName,
  projectId,
  client,
}: ShareDialogProps) {
  const [links, setLinks] = useState<LinksState>({ kind: "loading" });
  /** The freshly issued link — the ONLY place the raw token is ever shown. */
  const [issued, setIssued] = useState<ShareLinkIssued | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "issue" | "revoke">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The link id pending revoke confirmation (null = confirm closed). */
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const loadLinks = useCallback(async (): Promise<void> => {
    setLinks({ kind: "loading" });
    try {
      const result = await client.share.listLinks(projectId);
      setLinks({ kind: "loaded", items: result.items });
    } catch (error) {
      setLinks({ kind: "error", message: actionErrorCopy(error) });
    }
  }, [client, projectId]);

  // Load on open; reset the transient state on close (the raw token dies with
  // the dialog — it can never be re-fetched, only sha256(token) is stored).
  useEffect(() => {
    if (open) void loadLinks();
    else {
      setIssued(null);
      setCopied(false);
      setActionError(null);
      setRevokeId(null);
    }
  }, [open, loadLinks]);

  const shareUrl = issued === null ? null : `${window.location.origin}/s/${issued.token}`;

  const copyIssued = useCallback((): void => {
    if (shareUrl === null) return;
    const clipboard =
      typeof navigator !== "undefined" && navigator.clipboard != null
        ? navigator.clipboard
        : undefined;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      clipboard.writeText(shareUrl).then(
        () => setCopied(true),
        () => setCopied(legacyCopy(shareUrl)),
      );
    } else {
      setCopied(legacyCopy(shareUrl));
    }
  }, [shareUrl]);

  const issueLink = useCallback((): void => {
    if (busy !== null) return;
    setBusy("issue");
    setActionError(null);
    void client.share
      .issueLink(projectId)
      .then(async (link) => {
        setIssued(link);
        setCopied(false);
        await loadLinks();
      })
      .catch((error: unknown) => setActionError(actionErrorCopy(error)))
      .finally(() => setBusy(null));
  }, [busy, client, projectId, loadLinks]);

  const revoke = useCallback((): void => {
    if (revokeId === null || busy !== null) return;
    const id = revokeId;
    setBusy("revoke");
    setActionError(null);
    void client.share
      .revokeLink(id)
      .then(async () => {
        setRevokeId(null);
        await loadLinks();
      })
      .catch((error: unknown) => setActionError(actionErrorCopy(error)))
      .finally(() => setBusy(null));
  }, [revokeId, busy, client, loadLinks]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="editor-share-dialog">
          <DialogTitle data-testid="editor-share-title">Share “{projectName}”</DialogTitle>
          <DialogDescription>
            Anyone with the link can review this project in the share player — never the editor.
            Create a link, copy it, revoke it any time.
          </DialogDescription>

          {issued !== null && shareUrl !== null ? (
            <div
              data-testid="editor-share-issued"
              className="mt-4 flex flex-col gap-2 rounded-sm border border-signal/40 bg-elevated p-3"
            >
              <p className="text-body-s text-primary">
                Link created — copy it now. It&apos;s shown only once and can&apos;t be recovered
                later.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={shareUrl}
                  data-testid="editor-share-url"
                  onFocus={(event) => event.currentTarget.select()}
                  className="font-mono"
                />
                <Button
                  variant={copied ? "secondary" : "primary"}
                  size="sm"
                  onClick={copyIssued}
                  data-testid="editor-share-copy"
                  className="shrink-0"
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          ) : null}

          {actionError !== null ? (
            <p data-testid="editor-share-error" className="mt-3 text-body-s text-danger">
              {actionError}
            </p>
          ) : null}

          <section className="mt-5 flex flex-col gap-2" aria-label="Active links">
            <h3 className="text-label uppercase tracking-[0.06em] text-muted">Active links</h3>
            {links.kind === "loading" ? (
              <p data-testid="editor-share-links-loading" className="flex items-center gap-2 py-2">
                <Spinner size={16} />
                <span className="text-body-s text-secondary">Loading links…</span>
              </p>
            ) : null}
            {links.kind === "error" ? (
              <div
                data-testid="editor-share-links-error"
                className="flex flex-col gap-2 py-1 text-body-s text-danger"
              >
                <span>{links.message}</span>
                <div>
                  <Button variant="secondary" size="sm" onClick={() => void loadLinks()}>
                    Try again
                  </Button>
                </div>
              </div>
            ) : null}
            {links.kind === "loaded" ? (
              links.items.length === 0 ? (
                <p data-testid="editor-share-links-empty" className="py-1 text-body-s text-muted">
                  No active links yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {links.items.map((link) => (
                    <li
                      key={link.id}
                      data-testid="editor-share-link"
                      data-link-id={link.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border px-3 py-2 text-body-s text-secondary"
                    >
                      <span data-testid="editor-share-link-created">
                        Created {formatShareDate(link.createdAt)}
                      </span>
                      <span className="text-muted">
                        {link.expiresAt === null
                          ? "No expiry"
                          : `Expires ${formatShareDate(link.expiresAt)}`}
                      </span>
                      {link.hasPassword ? <Badge variant="neutral">Password</Badge> : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-danger"
                        disabled={busy !== null}
                        onClick={() => setRevokeId(link.id)}
                        data-testid="editor-share-revoke"
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>

          <DialogActions>
            <Button
              variant="primary"
              size="sm"
              loading={busy === "issue"}
              onClick={issueLink}
              data-testid="editor-share-create"
            >
              Create link
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeId !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeId(null);
        }}
        title="Revoke this link?"
        description="Anyone with the link immediately loses access. This can't be undone — create a new link if you need to share again."
        confirmLabel="Revoke link"
        busy={busy === "revoke"}
        onConfirm={revoke}
      />
    </>
  );
}
