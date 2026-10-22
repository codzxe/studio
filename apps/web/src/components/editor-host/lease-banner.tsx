"use client";

/**
 * `LeaseBanner` — the §M7 task 3 "Alex is editing" chrome (BUILD_PLAN §M7
 * task 3; PRODUCT_ARCHITECTURE §7.2/§9.3/§11; D-18: additive overlay only —
 * the editor is never restyled).
 *
 * THE state matrix, rendered from ONE poll of `GET /v1/projects/:id/lease-state`
 * (M7-C's banner endpoint: { holder, queue, youAre, canAcquire }):
 *
 *   * youAre = "viewer"  → the read-only strip: "Viewing — {holder} is
 *     editing" + the expiresAt countdown + [Request edit] (joins the queue).
 *   * youAre = "queued"  → "Viewing — {holder} is editing" + "You're #N in
 *     line" + [Cancel request].
 *   * youAre = "holder"  → "You have the edit lease" (+ "· N requests waiting"
 *     when the queue is non-empty).
 *   * the electNextHolder flip → the takeover toast: "The edit lease is now
 *     yours to take" + [Acquire] (+ dismiss). The gateway elects the OLDEST
 *     queued requester the moment the lease frees (release-time election in
 *     DELETE /lease; lazy expiry election on the first lease-state poll past
 *     the expiry) — the elected member OBSERVES the flip as "I was queued, I
 *     am no longer queued, nobody holds the lease and a POST /lease would
 *     win", so this banner arms exactly that transition (and stays quiet
 *     after the member's own cancel — a cancel is not an election).
 *   * free + not elected → hidden (the M3 session acquire owns taking a
 *     free lease on open/focus).
 *
 * This banner also DRIVES the client read-only gate (`lib/editor-session
 * read-only.ts`): after every poll it lands `gate.update(blocked, holder)`
 * where blocked = another member holds the ACTIVE (unexpired) lease. The
 * gateway's `requireLeaseForMutation` stays authoritative (409 LEASE_HELD);
 * the client gate is UX so a non-holder's Apply never executes a batch that
 * could not be saved (D-23: chat asking/proposing stays fully allowed — only
 * project mutations are gated).
 *
 * Host wiring: `onAcquired` fires after a successful Acquire so the host can
 * nudge the M3 session's lease check (which owns autosave adoption);
 * `onActiveChange` reports whether any banner chrome is visible (the host
 * suppresses the M3 read-only banner while THIS richer banner is up).
 */

import { type ReadOnlyGateHandle, createReadOnlyGate } from "@/lib/editor-session";
import type { ApiClient } from "@studio/api-client";
import { isApiError } from "@studio/api-client";
import type { LeaseStateResponse } from "@studio/contracts";
import { AlertTriangle, Eye, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

/** The lease-state poll cadence (snappy takeover UX; a cheap viewer+ read). */
const LEASE_STATE_POLL_MS = 15_000;
/** The countdown re-render tick while another member holds. */
const COUNTDOWN_TICK_MS = 1_000;

/** The api-client slice this banner consumes (structural — tests inject fakes). */
export type LeaseBannerClient = Pick<ApiClient, "leases" | "me">;

export interface LeaseBannerProps {
  /** `null` keeps the banner dormant (no api client → no chrome). */
  readonly client: LeaseBannerClient | null;
  readonly projectId: string;
  /** The read-only gate this banner drives (lib/editor-session read-only.ts). */
  readonly gate?: ReadOnlyGateHandle;
  /** Reports whether any lease chrome is visible (the host suppresses the M3 banner). */
  readonly onActiveChange?: (active: boolean) => void;
  /** Fires after a successful Acquire — the host nudges the M3 lease adoption. */
  readonly onAcquired?: () => void;
  /** Test seam: the state-poll cadence (default `LEASE_STATE_POLL_MS`). */
  readonly pollIntervalMs?: number;
  /** Test seam: the clock (default `Date.now`). */
  readonly now?: () => number;
}

type BannerView =
  | {
      readonly kind: "viewer";
      readonly holderName: string;
      readonly msLeft: number;
      readonly queueLength: number;
    }
  | {
      readonly kind: "queued";
      readonly holderName: string;
      readonly msLeft: number;
      readonly position: number | null;
      readonly queueLength: number;
    }
  | { readonly kind: "holder"; readonly waiting: number }
  | { readonly kind: "takeover" }
  | { readonly kind: "hidden" };

/** `expiresAt` countdown → `m:ss` (0:00 at/below zero; clamped, never negative). */
export function formatLeaseCountdown(msLeft: number): string {
  if (msLeft <= 0) return "0:00";
  const totalSeconds = Math.ceil(msLeft / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Safe action-error copy: the typed server message when present, else neutral. */
function actionErrorCopy(error: unknown): string {
  if (isApiError(error)) return error.message;
  return "That didn't work. Try again in a moment.";
}

/** Shared floating-panel chrome (the banners.tsx `panel()` pattern). */
function panel(className: string, children: ReactNode, testId?: string): ReactNode {
  return (
    <div
      data-testid={testId}
      className={`pointer-events-auto flex items-center gap-2 rounded-sm border border-border bg-panel/95 px-3 py-2 text-body-s text-primary shadow-pop ${className}`}
    >
      {children}
    </div>
  );
}

export function LeaseBanner(props: LeaseBannerProps): ReactNode {
  const { client, projectId, onActiveChange, onAcquired } = props;
  const pollIntervalMs = props.pollIntervalMs ?? LEASE_STATE_POLL_MS;
  // Stable clock seam: a fresh inline default would churn `poll`'s identity
  // (and with it the poll effect) on every render.
  const now = useMemo(() => props.now ?? ((): number => Date.now()), [props.now]);
  // The banner owns a gate when the host passes none (tests + isolated use).
  const fallbackGate = useRef<ReadOnlyGateHandle | null>(null);
  if (fallbackGate.current === null) fallbackGate.current = createReadOnlyGate();
  const gate = props.gate ?? fallbackGate.current;

  const [state, setState] = useState<LeaseStateResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "request" | "cancel" | "acquire">(null);
  /** Bumped by the countdown ticker; read by the view derivation. */
  const [tick, setTick] = useState(0);

  const meIdRef = useRef<string | null>(null);
  /** queuedAt from my own requestLease call (queue-position fallback). */
  const myQueuedAtRef = useRef<string | null>(null);
  /** armed ⇒ a queued→free transition happened that was NOT my cancel. */
  const electionArmedRef = useRef(false);
  /** queuedSinceCancel: the last poll saw me queued (and no cancel intervened). */
  const queuedSinceCancelRef = useRef(false);
  const dismissedElectionRef = useRef(false);
  const expiryRepollRef = useRef(false);
  /** The acquire session id: stable per banner mount (acquire = renew §7.2). */
  const acquireSessionIdRef = useRef<string | null>(null);
  if (acquireSessionIdRef.current === null) {
    acquireSessionIdRef.current = crypto.randomUUID();
  }

  // -- the poll ----------------------------------------------------------------
  const poll = useCallback(async (): Promise<void> => {
    if (client === null) return;
    try {
      const next = await client.leases.leaseState(projectId);
      setState(next);
      setActionError(null);

      // The election transition (the electNextHolder flip): I was queued,
      // now nobody holds and an acquire would win — and I did not cancel.
      const wasQueued = queuedSinceCancelRef.current;
      if (next.youAre === "queued") {
        queuedSinceCancelRef.current = true;
        dismissedElectionRef.current = false;
      } else if (next.holder === null) {
        queuedSinceCancelRef.current = false;
        if (wasQueued && next.canAcquire) {
          electionArmedRef.current = true; // stays armed until acted on/changed
          dismissedElectionRef.current = false;
        }
      } else {
        // Someone holds again (or still): no election to show.
        queuedSinceCancelRef.current = false;
        if (next.youAre !== "holder") electionArmedRef.current = false;
      }
      if (next.holder !== null) {
        electionArmedRef.current = false; // a holder absorbs any stale toast
        expiryRepollRef.current = false;
      }

      // The read-only gate follows the server's verdict (expiry checked
      // locally — a countdown past zero stops blocking even between polls).
      const expiresAt = next.holder === null ? null : new Date(next.holder.expiresAt).getTime();
      const blocked =
        next.holder !== null && next.youAre !== "holder" && expiresAt !== null && expiresAt > now();
      gate.update(blocked, next.holder === null ? null : next.holder.displayName);
    } catch {
      // Silent: the last state stays rendered; the next poll retries. The
      // gateway stays authoritative and the gate keeps its last verdict.
    }
  }, [client, projectId, gate, now]);

  // Poll on mount + on the interval + on window focus (a focused tab races
  // less), and once resolve my own user id for the queue-position lookup.
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void poll();
    const timer = setInterval(() => void poll(), pollIntervalMs);
    const onFocus = (): void => void poll();
    window.addEventListener("focus", onFocus);
    try {
      // A stub/test client may lack the me surface — the queue-position
      // lookup degrades to the queuedAt match instead.
      void client.me
        .get()
        .then((me) => {
          if (!cancelled) meIdRef.current = me.user.id;
        })
        .catch(() => undefined);
    } catch {
      /* dormant: no me endpoint on this client */
    }
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [client, poll, pollIntervalMs]);

  // -- the countdown ticker (only while another member holds) -------------------
  const tickerOn = state !== null && state.holder !== null && state.youAre !== "holder";
  useEffect(() => {
    if (!tickerOn) return;
    const timer = setInterval(() => setTick((current) => current + 1), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [tickerOn]);

  // -- actions -------------------------------------------------------------------
  const requestEdit = useCallback((): void => {
    if (client === null || busy !== null) return;
    setBusy("request");
    void client.leases
      .requestLease(projectId)
      .then(async (response) => {
        myQueuedAtRef.current = response.queuedAt;
        queuedSinceCancelRef.current = true; // I (re)joined — my own transition
        dismissedElectionRef.current = false;
        await poll();
      })
      .catch((error: unknown) => setActionError(actionErrorCopy(error)))
      .finally(() => setBusy(null));
  }, [client, projectId, busy, poll]);

  const cancelRequest = useCallback((): void => {
    if (client === null || busy !== null) return;
    // Clear BEFORE the poll lands: my own queued→viewer flip is never an
    // election (the dismissible distinction).
    queuedSinceCancelRef.current = false;
    myQueuedAtRef.current = null;
    setBusy("cancel");
    void client.leases
      .cancelLeaseRequest(projectId)
      .then(async () => poll())
      .catch((error: unknown) => setActionError(actionErrorCopy(error)))
      .finally(() => setBusy(null));
  }, [client, projectId, busy, poll]);

  const acquire = useCallback((): void => {
    if (client === null || busy !== null) return;
    const sessionId = acquireSessionIdRef.current ?? "";
    setBusy("acquire");
    void client.leases
      .acquire(projectId, { sessionId })
      .then(async (outcome) => {
        electionArmedRef.current = false;
        dismissedElectionRef.current = false;
        if (outcome.acquired) onAcquired?.();
        await poll();
      })
      .catch((error: unknown) => setActionError(actionErrorCopy(error)))
      .finally(() => setBusy(null));
  }, [client, projectId, busy, poll, onAcquired]);

  // -- the view (pure derivation from the latest state) --------------------------
  const view = useMemo<BannerView>((): BannerView => {
    void tick; // the countdown re-render signal
    if (state === null) return { kind: "hidden" };
    if (state.youAre === "holder") return { kind: "holder", waiting: state.queue.length };
    const holder = state.holder;
    if (holder === null) {
      if (electionArmedRef.current && !dismissedElectionRef.current && state.canAcquire) {
        return { kind: "takeover" };
      }
      return { kind: "hidden" };
    }
    const msLeft = new Date(holder.expiresAt).getTime() - now();
    const queueLength = state.queue.length;
    if (state.youAre === "queued") {
      // My position: my own queue entry (me.get id first, then my own
      // requestLease queuedAt), 1-based, oldest first — null when unknown
      // (e.g. a reload joined before this mount learned which entry is mine).
      const meId = meIdRef.current;
      const myQueuedAt = myQueuedAtRef.current;
      let position: number | null = null;
      if (meId !== null) {
        const index = state.queue.findIndex((entry) => entry.userId === meId);
        if (index >= 0) position = index + 1;
      }
      if (position === null && myQueuedAt !== null) {
        const index = state.queue.findIndex((entry) => entry.queuedAt === myQueuedAt);
        if (index >= 0) position = index + 1;
      }
      return { kind: "queued", holderName: holder.displayName, msLeft, position, queueLength };
    }
    return { kind: "viewer", holderName: holder.displayName, msLeft, queueLength };
  }, [state, tick, now]);

  // Expiry snappiness: the first countdown past zero re-polls immediately
  // (the gateway's lazy expiry election only happens on a lease-state poll).
  useEffect(() => {
    if (view.kind !== "viewer" && view.kind !== "queued") return;
    if (view.msLeft > 0 || expiryRepollRef.current) return;
    expiryRepollRef.current = true;
    void poll();
  }, [view, poll]);

  // Report chrome visibility to the host (suppress the M3 read-only banner).
  const active = view.kind !== "hidden";
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  if (view.kind === "hidden") return null;

  if (view.kind === "takeover") {
    return (
      <output
        data-testid="lease-takeover-toast"
        className="pointer-events-none absolute inset-x-0 top-12 z-20 mx-auto flex max-w-lg justify-center px-4"
      >
        {panel(
          "border-signal/40",
          <>
            <span data-testid="lease-takeover-line" className="max-w-64 truncate font-medium">
              The edit lease is now yours to take
            </span>
            <button
              type="button"
              data-testid="lease-acquire-button"
              disabled={busy !== null}
              onClick={acquire}
              className="rounded-sm border border-transparent bg-signal px-2 py-1 text-hint font-medium tracking-wide text-signal-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy === "acquire" ? "Taking…" : "Acquire"}
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              data-testid="lease-takeover-dismiss"
              onClick={() => {
                dismissedElectionRef.current = true;
                setTick((current) => current + 1);
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-secondary transition-colors hover:bg-elevated hover:text-primary"
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </>,
        )}
      </output>
    );
  }

  return (
    <output
      data-testid="lease-banner"
      data-youare={state?.youAre ?? ""}
      className="pointer-events-none absolute inset-x-0 top-12 z-20 mx-auto flex max-w-lg justify-center px-4"
    >
      {panel(
        view.kind === "holder" ? "border-success/40" : "border-warning/40",
        <>
          {view.kind === "holder" ? (
            <>
              <span
                data-testid="lease-holder-line"
                className="inline-block h-1.5 w-1.5 rounded-full bg-success"
                aria-hidden="true"
              />
              <span data-testid="lease-holder-status">
                You have the edit lease
                {view.waiting > 0
                  ? ` · ${view.waiting} ${view.waiting === 1 ? "request" : "requests"} waiting`
                  : ""}
              </span>
            </>
          ) : (
            <>
              <Eye size={16} strokeWidth={1.75} className="text-warning" aria-hidden="true" />
              <span data-testid="lease-readonly-strip">
                Viewing — <strong className="max-w-40 truncate">{view.holderName}</strong> is
                editing
              </span>
              {view.msLeft > 0 ? (
                <span
                  data-testid="lease-countdown"
                  className="rounded-xs border border-border bg-input px-1 text-hint text-secondary"
                  title="Time left on their edit lease"
                >
                  {formatLeaseCountdown(view.msLeft)} left
                </span>
              ) : (
                <span
                  data-testid="lease-countdown"
                  className="rounded-xs border border-border bg-input px-1 text-hint text-secondary"
                >
                  expiring…
                </span>
              )}
              {view.kind === "queued" ? (
                <span data-testid="lease-queue-line" className="text-secondary">
                  {view.position === null
                    ? "You're in the queue"
                    : `You're #${view.position} in line`}
                </span>
              ) : view.queueLength > 0 ? (
                <span className="text-muted">{view.queueLength} in queue</span>
              ) : null}
              {view.kind === "queued" ? (
                <button
                  type="button"
                  data-testid="lease-cancel-request-button"
                  disabled={busy !== null}
                  onClick={cancelRequest}
                  className="rounded-sm border border-border px-2 py-1 text-hint font-medium tracking-wide text-secondary transition-colors hover:bg-elevated hover:text-primary disabled:opacity-50"
                >
                  {busy === "cancel" ? "Cancelling…" : "Cancel request"}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="lease-request-button"
                  disabled={busy !== null}
                  onClick={requestEdit}
                  className="rounded-sm border border-transparent bg-signal px-2 py-1 text-hint font-medium tracking-wide text-signal-ink transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "request" ? "Requesting…" : "Request edit"}
                </button>
              )}
            </>
          )}
          {actionError !== null ? (
            <span data-testid="lease-banner-error" className="text-hint text-danger">
              <AlertTriangle
                size={12}
                strokeWidth={1.75}
                className="mr-1 inline"
                aria-hidden="true"
              />
              {actionError}
            </span>
          ) : null}
        </>,
      )}
    </output>
  );
}
