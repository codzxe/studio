"use client";

/**
 * use-shell-toast (W2-01, §7.7) — the shell's toast plumbing.
 *
 * `ShellToastHost` mounts `ToastProvider` + `ToastViewport` exactly ONCE (in
 * `AppShell`) and exposes a null-safe imperative API through context:
 *
 * - `useShellToast()` NEVER returns null and never throws — when no host is
 *   mounted (unit tests, the shell unmounted mid-action) the hook hands back
 *   a no-op stand-in so consumers render and behave identically. That is the
 *   "null-safe helper" contract: a missing toast host degrades to silence,
 *   never to a crash.
 * - Toasts are §7.7-shaped: title + optional description, one of the four
 *   variants, auto-dismiss via the kit's `TOAST_DURATION_MS`, close button.
 *   The shell uses them only for transient outcomes (workspace switch, sign
 *   out) — decisions stay in dialogs/banners, never toasts.
 */

import {
  TOAST_DURATION_MS,
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@studio/ui";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/** The four kit variants (§7.7) — colour is never the only signal (icons). */
export type ShellToastVariant = "default" | "success" | "warning" | "danger";

/** One transient notification. */
export interface ShellToastInput {
  readonly title: string;
  readonly description?: string;
  readonly variant?: ShellToastVariant;
}

/** The imperative surface consumers get from {@link useShellToast}. */
export interface ShellToastApi {
  /** Fire one toast; safe to call when no host is mounted (no-op). */
  show(input: ShellToastInput): void;
}

interface QueuedToast extends ShellToastInput {
  readonly id: number;
  readonly variant: ShellToastVariant;
}

const NOOP_API: ShellToastApi = { show: () => {} };

const ShellToastContext = createContext<ShellToastApi | null>(null);

/** Mount once, above everything that may fire toasts (the app shell root). */
export function ShellToastHost({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly QueuedToast[]>([]);
  const nextId = useRef(0);

  const show = useCallback((input: ShellToastInput) => {
    nextId.current += 1;
    const toast: QueuedToast = {
      id: nextId.current,
      title: input.title,
      description: input.description,
      variant: input.variant ?? "default",
    };
    setToasts((current) => [...current, toast]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const api = useMemo<ShellToastApi>(() => ({ show }), [show]);

  return (
    <ToastProvider>
      <ShellToastContext.Provider value={api}>
        {children}
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            open
            onOpenChange={(open) => {
              if (!open) dismiss(toast.id);
            }}
            variant={toast.variant}
            duration={TOAST_DURATION_MS}
            data-testid={`shell-toast-${toast.variant}`}
          >
            <ToastTitle>{toast.title}</ToastTitle>
            {toast.description === undefined ? null : (
              <ToastDescription>{toast.description}</ToastDescription>
            )}
            <ToastClose />
          </Toast>
        ))}
        <ToastViewport />
      </ShellToastContext.Provider>
    </ToastProvider>
  );
}

/**
 * The null-safe consumer: the host's API when mounted, a no-op otherwise.
 * Destructure `const toast = useShellToast()` and call `toast.show({...})`.
 */
export function useShellToast(): ShellToastApi {
  const api = useContext(ShellToastContext);
  return api ?? NOOP_API;
}
