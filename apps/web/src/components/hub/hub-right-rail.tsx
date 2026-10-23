"use client";

/**
 * `HubRightRail` — the §8.6 right rail of the project hub:
 * members with access, live lease status ("X is editing"), asset-library
 * count. Page-level chrome: `history-view.tsx` mounts it beside the tabs so
 * every hub tab carries it (§8.6 "Right rail: members with access, lease
 * status, asset count").
 *
 * Lease status polls `leases.leaseState` at ~30 s while the tab is visible —
 * the M7-B presence-cadence recipe (visibilitychange → hidden PAUSES the
 * timer → visible resumes; an in-flight guard collapses overlapping ticks;
 * unmount cancels). Failures are silent: the last state stays rendered.
 *
 * Members come from `members.list` page 1 (§7.2 pages are 50 rows); the
 * asset count from `assets.list` page 1 — the WORKSPACE library (the typed
 * wire has no project-scoped asset count; the copy says "library" so the
 * number never lies).
 */

import type { LeaseStateResponse, Member } from "@studio/contracts";
import { Avatar, Badge, Card, Skeleton, StatusDot } from "@studio/ui";
import { type ReactElement, useEffect, useState } from "react";

import { assetCountLabel } from "./hub-overview";
import { type HubPort, boundedHubText, createHubPort } from "./hub-port";

/** Lease banner refresh cadence (§8.6 "polled ~30s"). */
export const HUB_LEASE_POLL_INTERVAL_MS = 30_000;

/** Members page bound (§7.2 cursor pages are 50 rows). */
const RAIL_MEMBERS_LIMIT = 50;

/** Assets page bound — the "50+" threshold rides the wire's page size. */
const RAIL_ASSETS_LIMIT = 50;

/** Bounded roster list (huge workspaces get "+N more", never a wall). */
const RAIL_MEMBER_ROWS = 8;

const ROLE_LABELS: Readonly<Record<Member["role"], string>> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

/** Row display name: name → email → "Member" (ids never surface, law #1). */
export function memberDisplayName(member: Member): string {
  const name = member.name ?? member.email;
  if (name !== null && name.length > 0) return name;
  return "Member";
}

export interface HubRightRailProps {
  readonly workspaceId: string;
  readonly projectId: string;
  /** The calling user (RSC payload) — the "(you)" marker. */
  readonly viewerId: string | null;
  /** Editor+ — the "Free to edit" copy arm. */
  readonly canEdit: boolean;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: HubPort;
  /** Lease poll cadence in ms (default 30 000; tests shrink it). */
  readonly pollMs?: number;
}

export function HubRightRail({
  workspaceId,
  projectId,
  viewerId,
  canEdit,
  api,
  pollMs,
}: HubRightRailProps): ReactElement {
  // One port per mount (the session-client pattern: pure factory).
  const [port] = useState<HubPort>(() => api ?? createHubPort(workspaceId, projectId));

  const [lease, setLease] = useState<LeaseStateResponse | null>(null);
  const [members, setMembers] = useState<readonly Member[] | null>(null);
  const [assets, setAssets] = useState<string | null>(null);

  // -- members + assets: one read each, per mount ----------------------------
  useEffect(() => {
    let cancelled = false;
    void port
      .listMembers({ limit: RAIL_MEMBERS_LIMIT })
      .then((page) => {
        if (!cancelled) setMembers(page.items);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    void port
      .listAssets({ limit: RAIL_ASSETS_LIMIT })
      .then((page) => {
        if (!cancelled) setAssets(assetCountLabel(page.items, page.nextCursor !== null));
      })
      .catch(() => {
        if (!cancelled) setAssets("—");
      });
    return () => {
      cancelled = true;
    };
  }, [port]);

  // -- lease state: initial read + the ~30 s visibility-aware poller ---------
  const intervalMs = pollMs ?? HUB_LEASE_POLL_INTERVAL_MS;
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const state = await port.leaseState();
        if (!cancelled) setLease(state);
      } catch {
        // Silent — the last banner stays rendered (presence posture).
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => void tick(), intervalMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    if (document.visibilityState === "visible") start();

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, port]);

  const holder = lease === null ? null : lease.holder;
  const queueLength = lease === null ? 0 : lease.queue.length;
  const shownMembers = members === null ? [] : members.slice(0, RAIL_MEMBER_ROWS);
  const hiddenMembers = members === null ? 0 : Math.max(members.length - RAIL_MEMBER_ROWS, 0);

  return (
    <aside
      aria-label="Project details"
      data-testid="hub-right-rail"
      className="flex w-full shrink-0 flex-col gap-4 lg:w-[264px]"
    >
      {/* Lease status — the §8.6 "X is editing" banner. */}
      <Card className="p-4" data-testid="hub-rail-lease">
        {lease === null ? (
          <Skeleton className="h-5 w-3/4" />
        ) : holder !== null ? (
          <div className="flex flex-col gap-1">
            <StatusDot tone="signal" pulse data-testid="hub-rail-lease-held">
              {boundedHubText(holder.displayName, 60)} is editing
            </StatusDot>
            {queueLength > 0 ? (
              <p data-testid="hub-rail-queue" className="text-caption text-muted">
                {queueLength} {queueLength === 1 ? "member is" : "members are"} queued
              </p>
            ) : null}
          </div>
        ) : (
          <StatusDot tone="success" data-testid="hub-rail-lease-free">
            {canEdit ? "Free to edit" : "No one is editing"}
          </StatusDot>
        )}
      </Card>

      {/* Members with access. */}
      <Card className="p-4" data-testid="hub-rail-members">
        <h3 className="text-caption tracking-[0.06em] font-medium text-muted uppercase">
          With access
        </h3>
        {members === null ? (
          <div className="mt-3 flex flex-col gap-2" data-testid="hub-rail-members-loading">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : members.length === 0 ? (
          <p data-testid="hub-rail-members-empty" className="mt-3 text-caption text-muted">
            No other members have access yet.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {shownMembers.map((member) => (
              <li
                key={member.id}
                data-testid={`hub-rail-member-${member.id}`}
                className="flex min-w-0 items-center gap-2"
              >
                <Avatar name={memberDisplayName(member)} size="sm" />
                <span className="min-w-0 flex-1 truncate text-body-s text-primary">
                  {memberDisplayName(member)}
                  {member.isCurrentUser || (viewerId !== null && member.id === viewerId) ? (
                    <span className="text-muted"> (you)</span>
                  ) : null}
                </span>
                <Badge className="shrink-0">{ROLE_LABELS[member.role]}</Badge>
              </li>
            ))}
            {hiddenMembers > 0 ? (
              <li data-testid="hub-rail-members-more" className="text-caption text-muted">
                +{hiddenMembers} more
              </li>
            ) : null}
          </ul>
        )}
      </Card>

      {/* Asset-library count (honest scope: the workspace library). */}
      <Card className="p-4" data-testid="hub-rail-assets">
        <h3 className="text-caption tracking-[0.06em] font-medium text-muted uppercase">
          Asset library
        </h3>
        <p data-testid="hub-rail-assets-count" className="mt-2 text-body-s text-secondary">
          {assets ?? "—"}
        </p>
        <p className="mt-1 text-hint text-muted">Assets shared across this workspace</p>
      </Card>
    </aside>
  );
}
