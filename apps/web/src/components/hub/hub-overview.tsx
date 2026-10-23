"use client";

/**
 * `HubOverview` — the §8.6 Overview tab of the project hub
 * (`history-view.tsx` mounts it as the first of the five hub tabs).
 *
 * Data (one pass per activation, all through the shared {@link HubPort}):
 * - project name (RSC payload) + `updated` (`projects.manifest.updatedAt`);
 * - owner display name — the project's `createdBy` resolved against
 *   `members.list` page 1 (§7.2 pages are 50 rows; miss → honest fallback);
 * - current version label/size/time — `versions.list` page 1, row 1;
 * - asset-library count — `assets.list` page 1 ("50+" when a cursor follows);
 * - compositions — HONEST GAP: `ProjectManifest` carries no comps count on
 *   the wire (contracts routes/projects.ts), so the row degrades to "—"
 *   (data-known="false") instead of inventing a number. A gateway follow-up
 *   (comps on the manifest) unlocks it with zero client redesign.
 *
 * The primary CTA is LEASE-AWARE per §8.6: while `leases.leaseState` says
 * another member holds the edit lease, "Open editor" becomes "Open
 * read-only" plus "Request edit" (`leases.requestLease` — dedupe keeps the
 * original position; cancel leaves the queue via `cancelLeaseRequest`).
 * Viewers (workspace role) get the §8.11 `PermissionState` instead — the
 * gateway re-checks every capability either way.
 *
 * The Radix TabsContent unmount keeps this tab dark until first activation,
 * so every fetch below happens exactly when the user opens the tab.
 */

import type { Asset, LeaseStateResponse, Member, VersionTimelineEntry } from "@studio/contracts";
import { Button, Card, Skeleton } from "@studio/ui";
import { CircleAlert } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { formatTimeAgo } from "@/components/activity/activity-feed";
import { PermissionState } from "@/components/system/system-states";
import {
  formatTimelineTimestamp,
  formatVersionBytes,
  truncateTimelineString,
} from "@/components/versions/version-timeline";
import {
  type HubActionError,
  type HubPort,
  type ShareLinksPort,
  boundedHubText,
  createHubPort,
  hubErrorLine,
  toHubActionError,
} from "./hub-port";
import { ShareLinksCard } from "./share-links-card";

/** Members page bound (§7.2 cursor pages are 50 rows — one page is ample). */
const MEMBERS_LIMIT = 50;

/** Assets page bound — the "50+" threshold rides the wire's own page size. */
const ASSETS_LIMIT = 50;

/** Versions bound — the Overview only needs the newest (current) row. */
const VERSIONS_LIMIT = 1;

/** Display bound for member/project names (CSS `truncate` guards layout). */
const NAME_MAX = 60;

/** One metadata row: caption label left, bounded value right. */
function MetaRow(props: {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3" data-testid={props.testId}>
      <dt className="shrink-0 text-caption text-muted">{props.label}</dt>
      <dd
        className="min-w-0 truncate text-body-s text-secondary"
        title={props.title ?? props.value}
      >
        {props.value}
      </dd>
    </div>
  );
}

/** Owner display name from the roster row (ids never surface — law #1). */
export function ownerDisplayName(
  members: readonly Member[],
  ownerId: string | null,
  viewerId: string | null,
): string {
  if (ownerId !== null && viewerId !== null && ownerId === viewerId) return "You";
  const row = ownerId === null ? undefined : members.find((member) => member.id === ownerId);
  if (row !== undefined) {
    const name = row.name ?? row.email;
    if (name !== null && name.length > 0) return truncateTimelineString(name, NAME_MAX);
  }
  return "—";
}

/** "v3 · Launch cut · 2.0 KB · Oct 21, 2026, 14:32" (or the empty arm). */
export function currentVersionLabel(entry: VersionTimelineEntry | null): string {
  if (entry === null) return "No versions yet";
  const label = entry.label === null ? "" : ` · ${truncateTimelineString(entry.label, NAME_MAX)}`;
  return `v${entry.version}${label} · ${formatVersionBytes(entry.sizeBytes)} · ${formatTimelineTimestamp(entry.createdAt)}`;
}

/** "3 assets" / "50+" (a cursor means more than one page — never a false total). */
export function assetCountLabel(assets: readonly Asset[], hasMore: boolean): string {
  if (hasMore) return "50+";
  const count = assets.length;
  return `${count} ${count === 1 ? "asset" : "assets"}`;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface HubOverviewProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly workspaceId: string;
  readonly slug: string;
  /** The calling user (`GET /v1/me` via the RSC payload) — "You" labels. */
  readonly viewerId: string | null;
  /** The project's `createdBy` — resolved to a name via `members.list`. */
  readonly ownerId: string | null;
  /** Editor+ (role owner/admin/editor) — the lease CTA surface. */
  readonly canEdit: boolean;
  /** ISO instant stamped by the RSC — pins relative times. */
  readonly nowIso: string;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: HubPort;
  /** Injectable share port (tests). Production leaves it undefined. */
  readonly shareApi?: ShareLinksPort;
}

export function HubOverview({
  projectId,
  projectName,
  workspaceId,
  slug,
  viewerId,
  ownerId,
  canEdit,
  nowIso,
  api,
  shareApi,
}: HubOverviewProps): ReactElement {
  // One port per mount (the session-client pattern: a pure factory, no
  // network until a call happens).
  const [client] = useState<HubPort>(() => api ?? createHubPort(workspaceId, projectId));

  // -- metadata slices (each degrades to "—" on failure; the card never dies)
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [versionText, setVersionText] = useState<string | null>(null);
  const [assetsText, setAssetsText] = useState<string | null>(null);

  // -- lease slice (the CTA state machine)
  const [lease, setLease] = useState<LeaseStateResponse | null>(null);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<HubActionError | null>(null);

  const editorHref = `/w/${encodeURIComponent(slug)}/editor`;

  // One pass per mount: manifest, versions page 1, assets page 1, members,
  // lease state. Failures degrade per-row ("—"), never to a stack (law #1).
  useEffect(() => {
    let cancelled = false;
    const settle = (): void => {
      if (!cancelled) setLoaded(true);
    };

    void client
      .getManifest()
      .then((manifest) => {
        if (!cancelled) setUpdatedAt(manifest.updatedAt);
      })
      .catch(settle)
      .then(settle);

    void client
      .listVersions({ limit: VERSIONS_LIMIT })
      .then((page) => {
        if (!cancelled) setVersionText(currentVersionLabel(page.items[0] ?? null));
      })
      .catch(settle)
      .then(settle);

    void client
      .listAssets({ limit: ASSETS_LIMIT })
      .then((page) => {
        if (!cancelled) setAssetsText(assetCountLabel(page.items, page.nextCursor !== null));
      })
      .catch(settle)
      .then(settle);

    void client
      .listMembers({ limit: MEMBERS_LIMIT })
      .then((page) => {
        if (!cancelled) setOwner(ownerDisplayName(page.items, ownerId, viewerId));
      })
      .catch(settle)
      .then(settle);

    void client
      .leaseState()
      .then((state) => {
        if (!cancelled) {
          setLease(state);
          if (state.youAre === "queued") {
            const position = state.queue.findIndex((entry) => entry.userId === viewerId) + 1;
            setQueueNote(
              position > 0
                ? `You're number ${position} in the edit queue.`
                : "You're in the edit queue.",
            );
          }
        }
      })
      .catch(settle)
      .then(settle);

    return () => {
      cancelled = true;
    };
  }, [client, ownerId, viewerId]);

  const holder = lease === null ? null : lease.holder;
  const heldByOther = lease !== null && lease.holder !== null && lease.youAre !== "holder";

  const requestEdit = useCallback((): void => {
    if (requesting) return;
    setRequesting(true);
    setActionError(null);
    void client
      .requestLease()
      .then((response) => {
        setLease((previous) =>
          previous === null ? previous : { ...previous, youAre: "queued" as const },
        );
        setQueueNote(
          `You're number ${response.position} of ${response.queueLength} in the edit queue.`,
        );
      })
      .catch((cause: unknown) => {
        setActionError(toHubActionError(cause));
      })
      .finally(() => {
        setRequesting(false);
      });
  }, [client, requesting]);

  const cancelRequest = useCallback((): void => {
    if (cancelling) return;
    setCancelling(true);
    setActionError(null);
    void client
      .cancelLeaseRequest()
      .then(() => {
        setLease((previous) =>
          previous === null ? previous : { ...previous, youAre: "viewer" as const },
        );
        setQueueNote(null);
      })
      .catch((cause: unknown) => {
        setActionError(toHubActionError(cause));
      })
      .finally(() => {
        setCancelling(false);
      });
  }, [cancelling, client]);

  return (
    <Card data-testid="hub-overview" className="flex flex-col gap-6">
      {/* Large preview stand-in — the honest 16/9 frame until a thumbnail
          route exists (the W2-03 ProjectCard slate precedent, §7.3). */}
      <div
        data-testid="hub-overview-preview"
        aria-label={`${projectName} preview`}
        className="flex aspect-video w-full max-w-[440px] items-center justify-center overflow-hidden rounded-md border border-border bg-input/30"
      >
        <span className="max-w-[80%] truncate px-4 text-body text-muted">
          {truncateTimelineString(projectName, NAME_MAX)}
        </span>
      </div>

      <dl className="flex flex-col gap-2" data-testid="hub-overview-meta">
        {!loaded ? (
          <div className="flex flex-col gap-2" data-testid="hub-overview-skeleton">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <>
            <MetaRow
              testId="hub-overview-updated"
              label="Updated"
              value={updatedAt === null ? "—" : formatTimeAgo(updatedAt, nowIso)}
              title={updatedAt ?? undefined}
            />
            <MetaRow
              testId="hub-overview-owner"
              label="Owner"
              value={owner ?? "—"}
              title={owner ?? undefined}
            />
            <MetaRow
              testId="hub-overview-version"
              label="Current version"
              value={versionText ?? "—"}
            />
            <MetaRow
              testId="hub-overview-assets"
              label="Asset library"
              value={assetsText ?? "—"}
              title="Assets in this workspace's library"
            />
            {/* Honest gap: no comps count exists on the manifest wire — "—",
                never an invented number (the usage-section precedent). */}
            <MetaRow
              testId="hub-overview-comps"
              label="Compositions"
              value="—"
              title="Composition count isn't available yet."
            />
          </>
        )}
      </dl>

      {/* Primary CTA — lease-aware per §8.6; the editor route re-checks. */}
      {canEdit ? (
        <div className="flex flex-col gap-3" data-testid="hub-overview-actions">
          <div className="flex flex-wrap items-center gap-2">
            {heldByOther ? (
              <a
                href={editorHref}
                className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-elevated px-4 text-body-s font-medium text-primary transition-colors duration-120 hover:border-border-strong hover:bg-input"
                data-testid="hub-open-readonly"
              >
                Open read-only
              </a>
            ) : (
              <a
                href={editorHref}
                className="inline-flex h-9 items-center justify-center rounded-md bg-signal px-4 text-body-s font-medium text-signal-ink transition-colors duration-120 hover:bg-signal-hover"
                data-testid="hub-open-editor"
              >
                Open editor
              </a>
            )}
            {holder !== null && lease !== null && lease.youAre !== "holder" ? (
              <span
                data-testid="hub-lease-holder"
                className="text-caption text-muted"
                title={`${holder.displayName} holds the edit lease`}
              >
                {boundedHubText(holder.displayName, 80)} is editing
              </span>
            ) : null}
            {lease !== null && lease.queue.length > 0 && lease.youAre !== "queued" ? (
              <span data-testid="hub-queue-length" className="text-caption text-muted">
                {lease.queue.length} {lease.queue.length === 1 ? "member is" : "members are"}{" "}
                waiting
              </span>
            ) : null}
          </div>

          {heldByOther ? (
            queueNote !== null ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="hub-request-row">
                <p data-testid="hub-queue-note" className="text-caption text-secondary">
                  {queueNote}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={cancelling}
                  disabled={cancelling}
                  data-testid="hub-cancel-request"
                  onClick={cancelRequest}
                >
                  Cancel request
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2" data-testid="hub-request-row">
                <Button
                  variant="primary"
                  size="sm"
                  loading={requesting}
                  disabled={requesting}
                  data-testid="hub-request-edit"
                  onClick={requestEdit}
                >
                  Request edit
                </Button>
              </div>
            )
          ) : null}

          {actionError !== null ? (
            <div
              role="alert"
              data-testid="hub-lease-error"
              className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
            >
              <CircleAlert
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-danger"
              />
              <span className="min-w-0 flex-1">
                {hubErrorLine(actionError)}
                {actionError.hint === undefined ? null : (
                  <span className="block text-muted">{boundedHubText(actionError.hint, 160)}</span>
                )}
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <div data-testid="hub-viewer-note" className="rounded-md border border-border p-2">
          <PermissionState />
        </div>
      )}

      {/* Secondary "Share" — the §8.6 secondary action (the one this wave's
          manifest scoped to the hub; Duplicate lives on the projects list). */}
      {canEdit ? (
        <ShareLinksCard
          projectId={projectId}
          workspaceId={workspaceId}
          projectName={projectName}
          canManage={canEdit}
          nowIso={nowIso}
          api={shareApi}
        />
      ) : null}
    </Card>
  );
}
