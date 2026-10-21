"use client";

// apps/web/src/components/realtime — React glue for the presence client
// (W8-R). Spec anchors: §19 Phase 3 ("presence via Centrifugo, cursors
// optional"), §16.2 (SSE fallback first), §25 rule 3 (presence + display
// only — no cursors, no collaborative painting in v1).
//
// The hook owns the PresenceClient lifecycle so the presentational
// <PresenceBar> stays pure (see presence-bar.tsx):
//   • an INJECTED client is reused and never destroyed by the hook — the
//     caller owns it (W8-F can hoist one client for the whole editor and
//     subscribe several document channels);
//   • the DEFAULT client is created lazily inside the effect (never during
//     render — the NEXT_PUBLIC_ env contract must stay lazy per W1-K env.ts)
//     and destroyed on unmount/channel change.
//
// Status note: the default client reports PresenceStatus through the
// `onStatus` option the hook wires here; injected clients keep their own
// status handling (the PresenceClient interface intentionally exposes only
// subscribe/unsubscribe/destroy — construction options carry status), so
// `status` stays null for injected clients.

import { useEffect, useState } from "react";
import {
  createPresenceClient,
  type PresenceClient,
  type PresenceDelta,
  type PresenceMember,
  type PresenceStatus,
  type PresenceUpdate,
} from "@/lib/realtime/presence";

export interface UsePresenceOptions {
  /** `documentPresenceChannel(documentId)` → `doc:<id>`. */
  readonly channel: string;
  /** Injected client (caller-owned); omit for the lazy env-selected default. */
  readonly client?: PresenceClient;
  /** Current user's id — marks the "you" entry (from the session context). */
  readonly selfId?: string | null;
  /** Default true; false keeps the client dark (e.g. unauthenticated pages). */
  readonly enabled?: boolean;
}

export interface UsePresenceResult {
  readonly members: readonly PresenceMember[];
  /** Most recent delta (drives join/leave toasts); null until first update. */
  readonly lastDelta: PresenceDelta | null;
  readonly status: PresenceStatus | null;
}

const EMPTY: UsePresenceResult = { members: [], lastDelta: null, status: null };

/** Roster + join/leave deltas for one presence channel (§19 Phase 3). */
export function usePresence(options: UsePresenceOptions): UsePresenceResult {
  const { channel, client, selfId = null, enabled = true } = options;
  const [result, setResult] = useState<UsePresenceResult>(EMPTY);

  useEffect(() => {
    if (!enabled || channel === "") {
      return;
    }
    let live = true;
    let owned: PresenceClient | null = null;
    let active: PresenceClient;
    if (client !== undefined) {
      active = client; // caller owns the lifecycle — hook never destroys it
    } else {
      try {
        owned = createPresenceClient({
          selfId,
          onStatus: (status) => {
            if (live) {
              setResult((prev) => ({ members: prev.members, lastDelta: prev.lastDelta, status }));
            }
          },
        });
      } catch {
        // Optional presence chrome must never break the page — a bad env var
        // surfaces as a user-safe status instead of an error boundary.
        setResult({
          members: [],
          lastDelta: null,
          status: {
            transport: "none",
            state: "error",
            detail: "Realtime presence is misconfigured for this deployment.",
          },
        });
        return;
      }
      active = owned;
    }
    const listener = (update: PresenceUpdate): void => {
      if (!live || update.channel !== channel) {
        return;
      }
      setResult((prev) => ({
        members: update.roster,
        lastDelta: update.delta,
        status: prev.status,
      }));
    };
    active.subscribe(channel, listener);
    return () => {
      live = false;
      active.unsubscribe(channel, listener);
      owned?.destroy();
    };
  }, [channel, client, enabled, selfId]);

  return result;
}
