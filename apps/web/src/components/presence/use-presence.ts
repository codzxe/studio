"use client";

/**
 * `usePresence` — the ONE shared presence poller hook (BUILD_PLAN §M7 task 2;
 * PRODUCT_ARCHITECTURE §7.2/§11). Project-scoped: mount it ONCE per project
 * surface and hand its state to every presence view (the strip is the only v1
 * consumer; a second surface reuses the hook instead of growing its own
 * cadence).
 *
 * The cadence is M7-B's pinned web recipe (services/gateway/src/routes/
 * presence.ts header — the authoritative version):
 *   * while the tab is VISIBLE, beat every `LEASE_HEARTBEAT_MS` (120 s) via
 *     `client.presence.beatPresence(projectId, { compId?, playheadTicks?,
 *     clientNonce })` — the beat response IS the viewers poll (one
 *     round-trip; no SSE in v1);
 *   * on `visibilitychange` → hidden: PAUSE the timer (no beats while
 *     hidden — no fake "I'm here"); no "leave" call on pagehide either —
 *     the server's TTL sweep (PRESENCE_TTL_MS = 2 × heartbeat) drops this
 *     viewer from everyone's list two missed beats later;
 *   * on `visibilitychange` → visible: beat IMMEDIATELY, then resume the
 *     interval;
 *   * `clientNonce` is FRESH per beat (a per-tab marker ≤ 64 chars; the
 *     (project_id, user_id) PK upsert makes retries duplicate-free, and
 *     this poller simply waits for the next tick rather than retrying a
 *     beat in place, so a nonce is never reused);
 *   * a bare `{}` body is a valid beat ("still here, context unchanged").
 *
 * Reads-only surfaces (hidden tabs, anonymous previews) would call
 * `listPresence` at the same cadence — v1 mounts this hook only on the
 * authenticated editor host, so every tick BEATS. The distinction is kept
 * in the port type so a read-only consumer can be added without touching
 * this file's cadence.
 *
 * Failures are silent by design: the last viewers list stays rendered and
 * `error` flags the missed beat — presence is ephemeral telemetry, never a
 * blocking surface (the recipe's posture).
 */

import type { ApiClient } from "@studio/api-client";
import type { PresenceBeatRequest, PresenceViewersResponse } from "@studio/contracts";
import { useEffect, useState } from "react";

/**
 * Mirror of `LEASE_HEARTBEAT_MS` (@studio/contracts routes/leases.ts) — the
 * beat cadence AND the presence freshness unit. Type-pinned against the
 * contracts const (apps/web may not import contracts at runtime).
 */
export const PRESENCE_BEAT_INTERVAL_MS: typeof import("@studio/contracts").LEASE_HEARTBEAT_MS =
  120_000;

/**
 * Mirror of `PRESENCE_TTL_MS` (contracts) — the sweep horizon after which a
 * viewer stops appearing server-side; consumers render "last seen" against it.
 */
export const PRESENCE_TTL_MS: typeof import("@studio/contracts").PRESENCE_TTL_MS = 240_000;

/** The presence slice of the api-client (structural — tests inject the same shape). */
export type PresenceClient = Pick<ApiClient, "presence">;

/** Extra context a beat may carry (both optional — a bare beat means "still here"). */
export interface PresenceBeatContext {
  readonly compId?: string;
  readonly playheadTicks?: number;
}

export interface UsePresenceOptions {
  /** `null` keeps the poller dormant (no api client → no beats, no errors). */
  readonly client: PresenceClient | null;
  readonly projectId: string;
  /** Beat cadence in ms (default `PRESENCE_BEAT_INTERVAL_MS`). */
  readonly intervalMs?: number;
  /** Read fresh before EVERY beat; a rejection degrades to a bare beat. */
  readonly getContext?: () => Promise<PresenceBeatContext | undefined>;
  /** Mount gate (e.g. the editor is open); `false` idles the poller. */
  readonly enabled?: boolean;
}

export interface UsePresenceState {
  /** The active viewers from the last successful beat (self flag included). */
  readonly viewers: readonly PresenceViewersResponse["viewers"][number][];
  /** `Date.now()` of the last successful beat; `null` before the first. */
  readonly lastBeatAt: number | null;
  /** The last beat failed (the stale list stays rendered — silent by design). */
  readonly error: boolean;
}

const INITIAL_STATE: UsePresenceState = { viewers: [], lastBeatAt: null, error: false };

/** A fresh per-tab beat nonce (≤ 64 chars, per the wire bound). */
function beatNonce(): string {
  return crypto.randomUUID();
}

/**
 * The shared project-scoped presence poller. Mount once per project surface;
 * the state is fresh from the last successful beat while the tab is visible
 * and freezes (does not error) while hidden.
 */
export function usePresence(options: UsePresenceOptions): UsePresenceState {
  const { client, projectId } = options;
  const intervalMs = options.intervalMs ?? PRESENCE_BEAT_INTERVAL_MS;
  const enabled = options.enabled ?? true;
  const getContext = options.getContext;

  const [state, setState] = useState<UsePresenceState>(INITIAL_STATE);

  useEffect(() => {
    if (!enabled || client === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    const beat = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const body: PresenceBeatRequest = { clientNonce: beatNonce() };
        if (getContext !== undefined) {
          // Context failures degrade to a bare beat — never fail a heartbeat
          // over optional comp/playhead metadata.
          try {
            const context = await getContext();
            if (context !== undefined) {
              if (context.compId !== undefined) body.compId = context.compId;
              if (context.playheadTicks !== undefined) body.playheadTicks = context.playheadTicks;
            }
          } catch {
            /* bare beat */
          }
        }
        const response = await client.presence.beatPresence(projectId, body);
        if (!cancelled) {
          setState({ viewers: [...response.viewers], lastBeatAt: Date.now(), error: false });
        }
      } catch {
        if (!cancelled) setState((current) => ({ ...current, error: true }));
      } finally {
        inFlight = false;
      }
    };

    const start = (): void => {
      if (timer !== null) return; // already beating
      void beat();
      timer = setInterval(() => void beat(), intervalMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    // Mount-while-visible beats immediately (the recipe's "beat on visible").
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
  }, [client, projectId, intervalMs, enabled, getContext]);

  return state;
}
