"use client";

/**
 * StudioToast — the chat-first studio's window-event toast system.
 *
 * Decoupled by design: ANY module (chat surface, editor host, wire layer)
 * calls `fireStudioToast("Saved", "success")` — a `CustomEvent` on `window`.
 * No prop threading, no context, no store. `StudioToastHost` mounts ONCE
 * near the app root, listens for STUDIO_TOAST_EVENT and renders the stack.
 *
 * Contract:
 * - at most 3 visible toasts — keep-latest: toast #4 drops the oldest;
 * - each toast auto-dismisses after 3000ms (timers cleaned on unmount);
 * - bottom-center pill stack over the composer (bottom-24, z-50);
 * - tones map to real theme.css tokens (§3.1/§5.4): info = text-primary +
 *   border-subtle, success = border-signal, danger = text-danger +
 *   border-danger (`--color-danger: var(--danger)` is mapped in theme.css).
 */

import { X } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

/** The window event every module fires toasts through (the wire contract). */
export const STUDIO_TOAST_EVENT = "studio:chat-toast";

export type StudioToastTone = "info" | "success" | "danger";

export interface StudioToastDetail {
  /** Monotonic counter id (deterministic, so React keys + tests stay honest). */
  readonly id: number;
  readonly message: string;
  readonly tone: StudioToastTone;
}

const MAX_VISIBLE_TOASTS = 3;
const AUTO_DISMISS_MS = 3000;

/** tone → border/text token classes (base pill carries bg/border/shadow). */
const TONE_CLASS: Record<StudioToastTone, string> = {
  info: "text-primary border-subtle",
  success: "text-primary border-signal",
  danger: "text-danger border-danger",
};

let toastSeq = 0;

/**
 * Fire a toast from anywhere — SSR-safe no-op, no listener required, no
 * props threaded. The id is a module-level monotonic counter ("crypto-ish"
 * uniqueness without the nondeterminism of randomUUID).
 */
export function fireStudioToast(message: string, tone: StudioToastTone = "info"): void {
  if (typeof window === "undefined") return;
  toastSeq += 1;
  window.dispatchEvent(
    new CustomEvent<StudioToastDetail>(STUDIO_TOAST_EVENT, {
      detail: { id: toastSeq, message, tone },
    }),
  );
}

interface StudioToastItem {
  readonly id: number;
  readonly message: string;
  readonly tone: StudioToastTone;
}

/**
 * Mount ONCE (near the app root). Renders the fixed bottom-center toast
 * stack; everything else in the app just fires events at it.
 */
export function StudioToastHost(): ReactElement {
  const [toasts, setToasts] = useState<readonly StudioToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  /** Removes one toast by id; clears its auto-dismiss timer. Idempotent. */
  const dismissToast = useCallback((id: number): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => {
      const next = current.filter((toast) => toast.id !== id);
      // Bail out when a stale timer for an already-dropped toast fires.
      return next.length === current.length ? current : next;
    });
  }, []);

  useEffect(() => {
    const onToast = (event: Event): void => {
      const detail = (event as CustomEvent<StudioToastDetail | null>).detail;
      if (detail === null || detail === undefined) return;
      // Keep-latest: over capacity, slice drops the OLDEST from the front.
      setToasts((current) =>
        [...current, { id: detail.id, message: detail.message, tone: detail.tone }].slice(
          -MAX_VISIBLE_TOASTS,
        ),
      );
      const timer = setTimeout(() => dismissToast(detail.id), AUTO_DISMISS_MS);
      timers.current.set(detail.id, timer);
    };
    window.addEventListener(STUDIO_TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(STUDIO_TOAST_EVENT, onToast);
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, [dismissToast]);

  return (
    <div
      data-testid="studio-toast-host"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          // biome-ignore lint/a11y/useSemanticElements: the toast contract pins role="status" per pill — a native <output> cannot carry the pill layout
          role="status"
          data-testid="studio-toast"
          data-tone={toast.tone}
          className={`pointer-events-auto flex items-center gap-2 rounded-pill border bg-elevated px-3.5 py-2 text-body-s shadow-pop animate-toast-in ${TONE_CLASS[toast.tone]}`}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            data-testid="studio-toast-dismiss"
            onClick={() => {
              dismissToast(toast.id);
            }}
            className="shrink-0 text-muted duration-120 ease-out hover:text-primary"
          >
            <X size={13} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
