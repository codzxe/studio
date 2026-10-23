"use client";

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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  buttonVariants,
  cn,
} from "@studio/ui";
import { ArrowLeft, Share2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/**
 * The floating project bar (M3.5, BUILD_PLAN §M3 task 5) — auto-hide via CSS
 * ONLY (no JS polling, no pointer listeners): a 4px hover sliver at the top
 * edge reveals the bar (`group-hover`); hovering the bar keeps it open and
 * `focus-within` keeps it reachable by keyboard. When hidden the bar drops
 * its pointer events so it never occludes the editor's own menu bar.
 *
 * Contents: back to the workspace hub, project name, read-only badge (§9.3),
 * and the REAL Share button (W4-KILL, audit REPLACE-2): the share API is live
 * (POST /v1/projects/:id/share-links mints, GET lists, DELETE revokes), so
 * the button opens ShareDialog below — issue a link (token shown ONCE, copy
 * it), list the active links, revoke through ConfirmDialog. When no share
 * seam is passed (test sessions without an api client) the button is simply
 * not mounted — there is no "coming soon" chrome anywhere.
 */

/** The api-client slice the share dialog consumes (structural — tests inject fakes). */
export type ShareClient = Pick<ApiClient, "share">;

/** The live share seam: projectId + a client with the `share` region. */
export interface ProjectBarShareProps {
  readonly projectId: string;
  readonly client: ShareClient;
}

export interface ProjectBarProps {
  readonly projectName: string;
  readonly readOnly: boolean;
  /** The workspace hub the back button returns to. */
  readonly backHref?: string;
  /**
   * Live share seam. Absent/null → the Share button is not mounted (never an
   * inert placeholder).
   */
  readonly share?: ProjectBarShareProps | null;
}

export function ProjectBar({ projectName, readOnly, backHref = "/w", share }: ProjectBarProps) {
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <div className="group pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col items-center">
      {/* 4px reveal sliver — the only editor-visible chrome while hidden. */}
      <div
        data-testid="editor-bar-sliver"
        className="pointer-events-auto h-1 w-full"
        aria-hidden="true"
      />
      <div
        data-testid="editor-project-bar"
        className="pointer-events-none mt-1 mb-2 flex h-9 items-center gap-3 rounded-sm border border-border bg-panel/95 pr-1 pl-2 text-body text-primary opacity-0 shadow-pop transition-opacity duration-120 ease-out group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        <Link
          href={backHref}
          aria-label="Back to workspace"
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-secondary transition-colors hover:bg-elevated hover:text-primary"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </Link>
        <span className="max-w-64 truncate font-medium" title={projectName}>
          {projectName}
        </span>
        {readOnly ? (
          <Badge data-testid="editor-readonly-badge" variant="warning">
            Read-only
          </Badge>
        ) : null}
        {share !== null && share !== undefined ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Share project"
                  data-testid="editor-share-button"
                  onClick={() => setShareOpen(true)}
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-secondary")}
                >
                  <Share2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  Share
                </button>
              </TooltipTrigger>
              <TooltipContent>Share this project</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {share !== null && share !== undefined ? (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          projectName={projectName}
          projectId={share.projectId}
          client={share.client}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShareDialog — issue (shown-once copy) / list / revoke
// ---------------------------------------------------------------------------

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

interface ShareDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectName: string;
  readonly projectId: string;
  readonly client: ShareClient;
}

function ShareDialog({ open, onOpenChange, projectName, projectId, client }: ShareDialogProps) {
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
