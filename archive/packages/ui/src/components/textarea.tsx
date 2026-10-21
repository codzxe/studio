import type { ComponentProps } from "react";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "../lib/cn.js";

/**
 * Textarea — styled multiline input matching the Input conventions, including the
 * `aria-invalid` error hook (set `aria-invalid={hasError}` → destructive border/ring).
 */

export const textareaVariants = cva(
  "flex min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive",
  {
    variants: {
      size: {
        sm: "min-h-12 px-2.5 text-xs",
        md: "",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

export interface TextareaProps
  extends Omit<ComponentProps<"textarea">, "size">,
    VariantProps<typeof textareaVariants> {}

export function Textarea({ className, size, ...props }: TextareaProps) {
  return <textarea className={cn(textareaVariants({ size }), className)} {...props} />;
}
