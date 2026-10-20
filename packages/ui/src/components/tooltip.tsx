import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Tooltip — Radix Tooltip wrapper (§16.3).
 *
 * A11y: the trigger is the only tabstop (tooltips appear on focus, not on aria
 * description duties — do not put essential info only in a tooltip). Content is
 * portalled, `role="tooltip"`, and hidden on Escape. Wrap the app (or a subtree) in
 * `<TooltipProvider>` once; it is re-exported below for that purpose.
 */

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipContentProps
  extends ComponentProps<typeof TooltipPrimitive.Content> {}

export function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-xs overflow-hidden rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
