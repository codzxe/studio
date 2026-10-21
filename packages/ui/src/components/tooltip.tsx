import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from "react";
import { cn } from "../lib/utils";

/**
 * Tooltip — §7.6. 250ms delay, 12px, ink-4 background, paper text, no arrow.
 * A tooltip must NEVER be the only source of an accessible name — label the
 * trigger itself (aria-label / visible text) and use the tooltip as a hint.
 *
 * Wrap the app (or the region using tooltips) in <TooltipProvider> once.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ComponentRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, avoidCollisions = true, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        avoidCollisions={avoidCollisions}
        className={cn(
          "z-50 animate-fade-in rounded-xs border border-border bg-input px-2 py-1 text-caption text-primary shadow-pop",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

/** Default delay for the app's single TooltipProvider (§7.6: 250ms). */
export const TOOLTIP_DELAY_MS = 250;
