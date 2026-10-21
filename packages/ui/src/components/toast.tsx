import * as ToastPrimitive from "@radix-ui/react-toast";
import { type VariantProps, cva } from "class-variance-authority";
import { Check, CircleAlert, TriangleAlert, X } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
  forwardRef,
} from "react";
import { cn } from "../lib/utils";

/**
 * Toast — §7.6/§7.7. Radix Toast. Viewport bottom-right; variants default /
 * success / warning / danger; title + optional description; ONE action max;
 * close button. Slide 8px + fade, 180ms; auto-dismiss 5s (`duration` on the
 * Toast) with pause on hover (Radix default). Announced through the
 * viewport's live region. Never use a toast for a decision (§7.7) — use a
 * dialog or inline banner instead.
 */
export const ToastProvider = ToastPrimitive.Provider;

export const toastVariants = cva(
  cn(
    "group relative flex items-start gap-2.5 rounded-md border p-3 shadow-pop",
    "data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out",
    "data-[swipe=move]:transition-transform data-[swipe=end]:animate-toast-out",
  ),
  {
    variants: {
      variant: {
        default: "border-border bg-elevated",
        success: "border-success/40 bg-elevated",
        warning: "border-warning/40 bg-elevated",
        danger: "border-danger/40 bg-elevated",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/** Status is never colour-only (§3.1/§12) — every variant carries an icon. */
const variantIcon: Record<NonNullable<VariantProps<typeof toastVariants>["variant"]>, ReactNode> = {
  default: null,
  success: (
    <Check
      size={16}
      strokeWidth={1.75}
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-success"
    />
  ),
  warning: (
    <TriangleAlert
      size={16}
      strokeWidth={1.75}
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-warning"
    />
  ),
  danger: (
    <CircleAlert
      size={16}
      strokeWidth={1.75}
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-danger"
    />
  ),
};

export interface ToastProps
  extends ComponentPropsWithoutRef<typeof ToastPrimitive.Root>,
    VariantProps<typeof toastVariants> {}

export const Toast = forwardRef<ComponentRef<typeof ToastPrimitive.Root>, ToastProps>(
  function Toast({ className, variant, children, ...props }, ref) {
    return (
      <ToastPrimitive.Root
        ref={ref}
        className={cn(toastVariants({ variant }), className)}
        {...props}
      >
        {variantIcon[variant ?? "default"]}
        <div className="flex-1">{children}</div>
      </ToastPrimitive.Root>
    );
  },
);

export const ToastTitle = forwardRef<
  ComponentRef<typeof ToastPrimitive.Title>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(function ToastTitle({ className, ...props }, ref) {
  return (
    <ToastPrimitive.Title
      ref={ref}
      className={cn("text-body-s font-medium text-primary", className)}
      {...props}
    />
  );
});

export const ToastDescription = forwardRef<
  ComponentRef<typeof ToastPrimitive.Description>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(function ToastDescription({ className, ...props }, ref) {
  return (
    <ToastPrimitive.Description
      ref={ref}
      className={cn("mt-0.5 text-caption text-secondary", className)}
      {...props}
    />
  );
});

/** One action max (§7.7). */
export const ToastAction = forwardRef<
  ComponentRef<typeof ToastPrimitive.Action>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Action>
>(function ToastAction({ className, ...props }, ref) {
  return (
    <ToastPrimitive.Action
      ref={ref}
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-sm border border-border bg-input px-2 text-body-s font-medium text-primary transition-colors duration-120 hover:border-border-strong",
        className,
      )}
      {...props}
    />
  );
});

export const ToastClose = forwardRef<
  ComponentRef<typeof ToastPrimitive.Close>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(function ToastClose({ className, ...props }, ref) {
  return (
    <ToastPrimitive.Close
      ref={ref}
      aria-label="Dismiss notification"
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-muted transition-colors duration-120 hover:bg-input hover:text-primary",
        className,
      )}
      {...props}
    >
      <X size={16} strokeWidth={1.75} aria-hidden="true" />
    </ToastPrimitive.Close>
  );
});

/** Default auto-dismiss: 5s with pause on hover (§6.2). */
export const TOAST_DURATION_MS = 5000;

export const ToastViewport = forwardRef<
  ComponentRef<typeof ToastPrimitive.Viewport>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(function ToastViewport({ className, ...props }, ref) {
  return (
    <ToastPrimitive.Viewport
      ref={ref}
      className={cn(
        "fixed right-4 bottom-4 z-[100] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 outline-none",
        className,
      )}
      {...props}
    />
  );
});
