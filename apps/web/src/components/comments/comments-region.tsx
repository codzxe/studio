"use client";

/**
 * `CommentsRegion` — the M7-F MOUNT of the comments UI: the editor-right
 * slide-over toggle + panel (UI_DESIGN_SYSTEM §8.7 — additive floating chrome
 * over the frozen editor; law #7: the editor itself is never touched).
 *
 * OWNERSHIP NOTE (wave coordination): the editor-host files are M7-G's this
 * wave, so this region mounts at the page level (the comments slot region of
 * the editor RSC route) and is SELF-SUFFICIENT: it boots its own workspace-
 * scoped `ApiClient`, discovers the editor iframe (the M4-J precedent — a
 * second/third bridge attach on the same iframe is fine) and attaches a
 * dedicated read-only bridge for anchors. The in-host one-line mount for the
 * integrator, when editor-host is free to edit:
 *
 *   <CommentsRegion
 *     workspaceId={payload.workspaceId}
 *     projectId={payload.manifest.project.id}
 *     projectName={payload.manifest.project.name}
 *     client={sessionHandle.api}
 *     bridge={chatBridge}
 *   />
 *
 * (then DELETE the page-level slot in page.tsx — one mount, not two).
 *
 * The lease snapshot (M7-C lease-state) is a READ: it never gates anything
 * here — per D-23 the lease scopes project WRITES, and the comments panel
 * pins that reviewing still works while another member edits.
 *
 * STACKING (verified against editor-host chrome): the layer sits at z-[36]
 * — above the chat overlay (z-35) and the floating project bar (z-30), below
 * the boot/conflict overlays (z-40) and Radix portals (z-50). The editor
 * iframe receives no style, no resize, no event: the region is a sibling.
 */

import { createApiClient } from "@studio/api-client";
import { type EditorBridge, attachEditorBridge } from "@studio/editor-bridge";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@studio/ui";
import { MessageSquare } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { CommentsPanel } from "./comments-panel";
import type { CommentsClient, LeaseSnapshot } from "./types";

/** Same-origin API root (session-client.ts precedent). */
const API_BASE_URL = "/v1";

/** The host-rendered editor iframe (M3.5 testid — the one this page mounts). */
const DEFAULT_IFRAME_SELECTOR = 'iframe[data-testid="editor-iframe"]';

/** Bounded iframe discovery (~5 s) — the panel degrades without a bridge. */
const DISCOVER_INTERVAL_MS = 100;
const DISCOVER_ATTEMPTS = 50;

export interface CommentsRegionProps {
  /** Workspace scope for the default ApiClient (`x-workspace-id`). */
  readonly workspaceId: string;
  readonly projectId: string;
  /** Project display name (the panel header chip). */
  readonly projectName?: string | null;
  /**
   * Injected comments client (tests, or the in-host mount passing the
   * session's ApiClient). Default: a fresh workspace-scoped ApiClient.
   */
  readonly client?: CommentsClient;
  /**
   * Injected bridge (tests, or the in-host mount passing the chat bridge).
   * Default: discover the editor iframe and attach a dedicated bridge.
   */
  readonly bridge?: EditorBridge | null;
  /** Selector seam for the iframe discovery (default: the editor testid). */
  readonly iframeSelector?: string;
}

export function CommentsRegion({
  workspaceId,
  projectId,
  projectName,
  client: clientProp,
  bridge: bridgeProp,
  iframeSelector = DEFAULT_IFRAME_SELECTOR,
}: CommentsRegionProps): ReactElement {
  // One client per region mount (the session-client pattern: pure factory,
  // no network until a call happens).
  const [client] = useState<CommentsClient>(
    () =>
      clientProp ??
      createApiClient({
        baseUrl: API_BASE_URL,
        headers: { "x-workspace-id": workspaceId },
      }),
  );

  const [open, setOpen] = useState(false);
  const [bridge, setBridge] = useState<EditorBridge | null>(bridgeProp ?? null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [lease, setLease] = useState<LeaseSnapshot | null>(null);

  // -- bridge discovery (only when no bridge prop — the owner's bridge is
  //    never disposed by us; an attached bridge is) ---------------------------
  const ownsBridgeRef = useRef(bridgeProp === undefined || bridgeProp === null);
  useEffect(() => {
    if (bridgeProp !== undefined && bridgeProp !== null) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      if (cancelled) return;
      const iframe = document.querySelector(iframeSelector);
      if (iframe instanceof HTMLIFrameElement) {
        attachEditorBridge(iframe).then(
          (attached) => {
            if (cancelled) attached.dispose();
            else setBridge(attached);
          },
          () => {
            // Handshake failed (editor booting/failed): the panel still
            // works — rows show raw anchors, the create box explains.
          },
        );
        return;
      }
      attempt += 1;
      if (attempt >= DISCOVER_ATTEMPTS) return;
      timer = setTimeout(tick, DISCOVER_INTERVAL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (ownsBridgeRef.current) {
        setBridge((current) => {
          current?.dispose();
          return current;
        });
      }
    };
  }, [bridgeProp, iframeSelector]);

  // -- viewer id + lease snapshot per OPEN (read-only; degrade to null) ------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const mePort = client.me;
    if (mePort !== undefined) {
      mePort.get().then(
        (response) => {
          if (!cancelled) setViewerId(response.user.id);
        },
        () => {
          if (!cancelled) setViewerId(null);
        },
      );
    }
    const leasePort = client.leases;
    if (leasePort !== undefined) {
      leasePort.leaseState(projectId).then(
        (state) => {
          if (!cancelled) {
            setLease({
              holderName: state.holder === null ? null : state.holder.displayName,
              youAre: state.youAre,
            });
          }
        },
        () => {
          if (!cancelled) setLease(null);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [client, open, projectId]);

  const close = useCallback((): void => {
    setOpen(false);
  }, []);

  return (
    <div
      data-testid="comments-layer"
      data-open={open}
      className="pointer-events-none fixed inset-0 z-[36]"
    >
      {!open ? (
        <div className="pointer-events-auto absolute top-14 right-3">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="iconSm"
                  className="h-9 w-9 rounded-full border-border bg-panel shadow-pop"
                  aria-label="Comments"
                  aria-pressed={open}
                  data-testid="comments-toggle"
                  onClick={() => setOpen(true)}
                >
                  <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Comments</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : null}
      {/* The layer root swallows no editor clicks; the panel re-enables
          pointer events on its own subtree (the chat-layer pattern). */}
      <div className="pointer-events-none absolute inset-0">
        <CommentsPanel
          client={client}
          projectId={projectId}
          projectName={projectName}
          bridge={bridge}
          viewerId={viewerId}
          lease={lease}
          open={open}
          onClose={close}
        />
      </div>
    </div>
  );
}
