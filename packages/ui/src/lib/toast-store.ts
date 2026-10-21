/**
 * toast-store — dependency-free publish/subscribe store powering <ToastViewport>
 * (§16.3 kit: primitives stay presentational; state lives in a tiny owned store).
 *
 * Pure TypeScript, no React import: usable from any client context and unit-testable
 * without rendering. <ToastViewport> subscribes via useSyncExternalStore.
 *
 * Auto-dismiss: `push()` schedules one timer per toast (default 5 s; `duration: 0`
 * keeps the toast until it is manually dismissed). Timers are cancelled on
 * dismiss/dismissAll so nothing leaks.
 *
 * Variants mirror the result-envelope / run-state display convention (§13.2 / §13.3,
 * same token palette as Badge STATUS_BADGE_VARIANT): ok → "success", ok:false /
 * error → "error", succeeded_with_warnings → "warning", everything else → "info".
 */

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface Toast {
  readonly id: string;
  readonly variant: ToastVariant;
  readonly title: string;
  /** Optional second line (e.g. an envelope hint). */
  readonly description?: string;
  /** Auto-dismiss delay in ms; 0 = sticky until dismissed. */
  readonly duration: number;
}

/** What callers pass to push/toast(); string shorthand = title only. */
export type ToastContent = ToastInput | string;

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Override the default auto-dismiss delay (ms). 0 = sticky. */
  duration?: number;
}

/** Immutable snapshot handed to subscribers (stable reference per change). */
export interface ToastSnapshot {
  readonly toasts: readonly Toast[];
}

export interface ToastStore {
  /** Current snapshot; safe as a useSyncExternalStore getSnapshot. */
  getState: () => ToastSnapshot;
  /** Subscribe for changes; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Add a toast (auto-dismisses per duration) and return its id. */
  push: (content: ToastContent) => string;
  /** Remove one toast and cancel its timer. Unknown ids are a no-op. */
  dismiss: (id: string) => void;
  /** Remove every toast and cancel all timers. */
  dismissAll: () => void;
  /** Patch a live toast in place (e.g. swap the title once work finishes). */
  update: (id: string, patch: Partial<Omit<Toast, "id">>) => void;
}

export const TOAST_DEFAULT_DURATION_MS = 5000;

let idSeq = 0;

function nextToastId(now: () => number): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `toast-${now().toString(36)}-${idSeq.toString(36)}`;
}

function toInput(content: ToastContent): ToastInput {
  return typeof content === "string" ? { title: content } : content;
}

/**
 * Factory for isolated stores (tests, multiple independent regions).
 * The default exported `toastStore` is one instance of this.
 */
export function createToastStore(now: () => number = Date.now): ToastStore {
  let toasts: readonly Toast[] = [];
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const getState = (): ToastSnapshot => ({ toasts });

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const dismiss = (id: string): void => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    const next = toasts.filter((toast) => toast.id !== id);
    if (next.length !== toasts.length) {
      toasts = next;
      emit();
    }
  };

  const dismissAll = (): void => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    if (toasts.length > 0) {
      toasts = [];
      emit();
    }
  };

  const push = (content: ToastContent): string => {
    const input = toInput(content);
    const toast: Toast = {
      id: nextToastId(now),
      variant: input.variant ?? "info",
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      duration: input.duration ?? TOAST_DEFAULT_DURATION_MS,
    };
    toasts = [...toasts, toast];
    if (toast.duration > 0) {
      // Bare global so fake timers (vitest) patch this at call time.
      timers.set(toast.id, setTimeout(() => dismiss(toast.id), toast.duration));
    }
    emit();
    return toast.id;
  };

  const update = (id: string, patch: Partial<Omit<Toast, "id">>): void => {
    let changed = false;
    toasts = toasts.map((toast) => {
      if (toast.id !== id) return toast;
      changed = true;
      return { ...toast, ...patch };
    });
    if (changed) emit();
  };

  return { getState, subscribe, push, dismiss, dismissAll, update };
}

/** The singleton store the `toast()` helpers emit into. */
export const toastStore: ToastStore = createToastStore();

export interface ToastEmitter {
  (content: ToastContent): string;
  success: (content: ToastContent) => string;
  error: (content: ToastContent) => string;
  warning: (content: ToastContent) => string;
  info: (content: ToastContent) => string;
}

/** Ergonomic emitter bound to the singleton store: `toast("Saved")`, `toast.error(...)`. */
export const toast: ToastEmitter = Object.assign(
  (content: ToastContent) => toastStore.push(content),
  {
    success: (content: ToastContent) => toastStore.push({ ...toInput(content), variant: "success" }),
    error: (content: ToastContent) => toastStore.push({ ...toInput(content), variant: "error" }),
    warning: (content: ToastContent) => toastStore.push({ ...toInput(content), variant: "warning" }),
    info: (content: ToastContent) => toastStore.push({ ...toInput(content), variant: "info" }),
  },
);

/**
 * run-state → toast variant map, mirroring Badge `STATUS_BADGE_VARIANT` (§13.2 stream
 * aliases / §5.1 statuses). Hand-mirrored on purpose — the ui package must not depend
 * on @studio/db. Unknown statuses degrade to neutral "info", so new states never break.
 */
export const TOAST_VARIANT_FROM_STATUS: Readonly<Record<string, ToastVariant>> = {
  // terminal
  succeeded: "success",
  succeeded_with_warnings: "warning",
  failed: "error",
  cancelled: "info",
  canceled: "info",
  // non-terminal + stream aliases
  queued: "info",
  started: "info",
  running: "info",
  planning: "info",
  executing: "info",
  observing: "info",
  rendering: "info",
  validating: "info",
  critiquing: "info",
  repairing: "info",
  finalizing: "info",
  warning: "warning",
  error: "error",
};

/** Resolve any status string to a toast variant; unknown statuses render neutral. */
export function toastVariantFromStatus(status: string): ToastVariant {
  return TOAST_VARIANT_FROM_STATUS[status] ?? "info";
}
