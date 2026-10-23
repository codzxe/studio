"use client";

/**
 * `HubComments` — the §8.6 Comments tab of the project hub: the M7-F
 * `CommentsPanel` in its DEGRADED mode (bridge `null`).
 *
 * There is no live editor on this surface, so the panel can't prefill a
 * comment anchor from the editor context — the composer explains that and
 * new comments anchor in the editor (the panel's own degraded design, M7-F).
 * Reading, replying and resolving all stay fully functional; the D-23 lease
 * pin keeps them enabled even while another member holds the edit lease.
 *
 * The wrapper:
 * - builds ONE workspace-scoped `CommentsClient` (the real ApiClient
 *   satisfies the port structurally; tests inject a fake);
 * - resolves the viewer id from the RSC payload (prop, not a `me` call — the
 *   page already has it) and the lease snapshot from `leases.leaseState`
 *   (degrades to null; the note never blocks anything);
 * - frames the panel's absolute-positioned aside inside a sized container so
 *   it paints in-flow (the panel component is not owned by this task and is
 *   mounted exactly as the editor region mounts it).
 */

import { createApiClient } from "@studio/api-client";
import { type ReactElement, useEffect, useState } from "react";

import { CommentsPanel } from "@/components/comments/comments-panel";
import type { CommentsClient, LeaseSnapshot } from "@/components/comments/types";
import { HUB_API_BASE_URL } from "./hub-port";

export interface HubCommentsProps {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName: string;
  /** The calling user (RSC payload) — "You"/"by you" labels in the panel. */
  readonly viewerId: string | null;
  /** Injectable comments client (tests). Production leaves it undefined. */
  readonly client?: CommentsClient;
}

export function HubComments({
  workspaceId,
  projectId,
  projectName,
  viewerId,
  client: clientProp,
}: HubCommentsProps): ReactElement {
  // One client per mount (the session-client pattern: pure factory, no
  // network until a call happens).
  const [client] = useState<CommentsClient>(
    () =>
      clientProp ??
      createApiClient({
        baseUrl: HUB_API_BASE_URL,
        headers: { "x-workspace-id": workspaceId },
      }),
  );

  // Lease snapshot (read-only; D-23: review is the point of read-only).
  const [lease, setLease] = useState<LeaseSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const leasePort = client.leases;
    if (leasePort === undefined) return;
    void leasePort.leaseState(projectId).then(
      (state) => {
        if (!cancelled) {
          setLease({
            holderName: state.holder === null ? null : state.holder.displayName,
            youAre: state.youAre,
          });
        }
      },
      () => {
        // Degrade to no note — reading never blocks (the region recipe).
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  return (
    <div
      data-testid="hub-comments"
      data-degraded="true"
      className="relative mx-auto h-[640px] max-h-[75vh] w-full max-w-[380px] overflow-hidden rounded-md border border-border bg-panel"
    >
      <CommentsPanel
        client={client}
        projectId={projectId}
        projectName={projectName}
        bridge={null}
        viewerId={viewerId}
        lease={lease}
        open
        onClose={() => {
          // No close affordance on a tab surface — the panel's Escape
          // handling lands here and intentionally does nothing.
        }}
      />
    </div>
  );
}
