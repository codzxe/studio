import { ChevronDown } from "lucide-react";
import { type ComponentProps } from "react";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "../lib/cn.js";

/**
 * Select — styled NATIVE <select> (deliberately not a JS listbox):
 * - free keyboard + screen-reader semantics, no ARIA bookkeeping
 * - mobile OS pickers, form + autofill integration for free
 * Sizes and the `aria-invalid` error hook match the Input conventions.
 */

export const selectVariants = cva(
  "flex h-9 w-full appearance-none rounded-md border border-input bg-background px-3 py-1 pr-8 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive",
  {
    variants: {
      size: {
        sm: "h-8 px-2.5 text-xs",
        md: "",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

export interface SelectProps
  extends Omit<ComponentProps<"select">, "size">,
    VariantProps<typeof selectVariants> {
  /**
   * Classes for the relative wrapper that owns the chevron positioning (e.g. to
   * escape the default full-width layout inside toolbars).
   */
  wrapperClassName?: string;
}

export function Select({ className, wrapperClassName, size, children, ...props }: SelectProps) {
  return (
    <span className={cn("relative inline-flex w-full", wrapperClassName)}>
      <select className={cn(selectVariants({ size }), className)} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
