import * as LabelPrimitive from "@radix-ui/react-label";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Label — Radix Label styled (§16.3).
 *
 * A11y: pass `htmlFor={ids.inputId}` from `useFieldIds()` (see input.tsx), or nest the
 * control inside the label for automatic association (Radix wires it up). The
 * `peer-disabled` styles keep labels dimmed alongside their disabled input.
 */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        "flex select-none items-center gap-2 text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}
