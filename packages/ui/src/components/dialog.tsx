import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
  forwardRef,
  useId,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Input } from "./input";

/**
 * Dialog — §7.5. Radix Dialog: scrim `--overlay`, panel bg-panel + radius-lg +
 * elevation 2, max width 560 (default) / 720 (`large`). Focus trap, Esc to
 * close and focus restoration come from Radix. Below 640px the panel docks to
 * the bottom as a sheet with a drag handle (max-height 90vh).
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  size?: "default" | "large";
}

export const DialogContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent({ size = "default", className, children, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-50 bg-overlay",
          "data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out",
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed top-[20vh] left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-y-auto rounded-lg border border-border bg-panel shadow-modal scrollbar-thin",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
          // Mobile: bottom sheet (§7.5)
          "max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[90vh] max-sm:w-full max-sm:translate-x-0 max-sm:rounded-b-none",
          size === "large" ? "max-w-[var(--dialog-w-large)]" : "max-w-[var(--dialog-w)]",
          className,
        )}
        {...props}
      >
        {/* Drag handle (mobile sheet affordance, decorative) */}
        <span
          aria-hidden="true"
          className="mx-auto mt-2 hidden h-1 w-10 rounded-pill bg-strong max-sm:block"
        />
        <div className="p-6">
          {children}
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted transition-colors duration-120 hover:bg-elevated hover:text-primary"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

/** Title 20px (§7.5). Radix warns if a dialog lacks a title — always include. */
export const DialogTitle = forwardRef<
  ComponentRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn("text-title-m font-medium text-primary", className)}
      {...props}
    />
  );
});

/** Description 14px muted (§7.5). */
export const DialogDescription = forwardRef<
  ComponentRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("mt-2 text-[14px] leading-relaxed text-secondary", className)}
      {...props}
    />
  );
});

/**
 * Actions row — right-aligned; put the primary action LAST (§7.5) so it sits
 * closest to the right edge.
 */
export function DialogActions({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("mt-6 flex flex-wrap items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /**
   * §7.5 — destructive dialogs require typing the action name, not just "OK".
   * When set, the confirm action stays disabled until the input matches
   * (case-insensitive, whitespace-trimmed).
   */
  confirmText?: string;
  danger?: boolean;
  /** Marks the confirm action busy (keeps width, shows "Working…"). */
  busy?: boolean;
}

/**
 * ConfirmDialog — destructive confirmation with optional type-to-confirm
 * gating (§7.5). Esc closes; focus is trapped and restored by Radix.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  confirmText,
  danger = true,
  busy = false,
}: ConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const gated = confirmText !== undefined;
  const matches = gated
    ? typed.trim().toLowerCase() === (confirmText ?? "").trim().toLowerCase()
    : true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        {gated ? (
          <div className="mt-4">
            <Input
              id={inputId}
              label={`Type "${confirmText}" to confirm`}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              data-testid="confirm-input"
            />
          </div>
        ) : null}
        <DialogActions>
          <DialogClose asChild>
            <Button variant="secondary">{cancelLabel}</Button>
          </DialogClose>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={!matches}
            loading={busy}
            onClick={() => onConfirm()}
            data-testid="confirm-confirm"
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
