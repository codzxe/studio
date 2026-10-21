import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { type ComponentProps, useSyncExternalStore } from "react";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "../lib/cn.js";
import { toastStore, type Toast, type ToastStore, type ToastVariant } from "../lib/toast-store.js";

/**
 * ToastViewport — renders the live snapshot of a toast store. Mount ONCE near the app
 * root (`<ToastViewport />`) and emit from anywhere via the `toast()` helpers:
 *
 *   toast.success("Document saved");
 *   toast.error({ title: "Render failed", description: envelope.hint });
 *
 * A11y: each toast is its own polite live region (`role="status"`), so screen readers
 * announce arrivals without the viewport itself having to be a live region. The
 * dismiss button is a labelled native `<button>`.
 */

const TOAST_VARIANT_STYLES: Record<ToastVariant, string> = {
  info: "border-border",
  success: "border-success/40",
  warning: "border-warning/40",
  error: "border-destructive/40",
};

const TOAST_VARIANT_ICON: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
};

const TOAST_VARIANT_ICON_COLOR: Record<ToastVariant, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

export const toastViewportVariants = cva(
  "pointer-events-none fixed z-50 flex w-full max-w-sm flex-col gap-2 outline-none",
  {
    variants: {
      position: {
        "bottom-right": "bottom-4 right-4 items-end",
        "bottom-center": "bottom-4 left-1/2 -translate-x-1/2 items-center",
        "top-right": "top-4 right-4 items-end",
      },
    },
    defaultVariants: {
      position: "bottom-right",
    },
  },
);

/**
 * Subscribe to a toast store from any component (the viewport uses this internally).
 * `useSyncExternalStore` handles subscribe/teardown and concurrent rendering.
 */
export function useToasts(store: ToastStore = toastStore): readonly Toast[] {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return snapshot.toasts;
}

export interface ToastViewportProps extends Omit<ComponentProps<"div">, "children"> {
  /** Store to render; defaults to the singleton `toastStore`. */
  store?: ToastStore;
  position?: VariantProps<typeof toastViewportVariants>["position"];
}

export function ToastViewport({
  store = toastStore,
  position,
  className,
  ...props
}: ToastViewportProps) {
  const toasts = useToasts(store);
  return (
    <div className={cn(toastViewportVariants({ position }), className)} {...props}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={store.dismiss} />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const Icon = TOAST_VARIANT_ICON[toast.variant];
  return (
    <div
      role="status"
      data-variant={toast.variant}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-md border bg-card p-3 text-card-foreground shadow-lg",
        TOAST_VARIANT_STYLES[toast.variant],
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", TOAST_VARIANT_ICON_COLOR[toast.variant])} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <p className="text-sm font-medium leading-5">{toast.title}</p>
        {toast.description === undefined ? null : (
          <p className="text-sm leading-5 text-muted-foreground">{toast.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ring-offset-card focus-visible:ring-offset-2 disabled:pointer-events-none"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
