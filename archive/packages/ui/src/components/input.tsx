import { type VariantProps, cva } from "class-variance-authority";
import { type ComponentProps, useId } from "react";
import { cn } from "../lib/cn.js";

/**
 * Input — styled text input (§16.3 shadcn pattern).
 *
 * Error-state styling hook: set `aria-invalid` (e.g. `aria-invalid={hasError}`) and the
 * destructive border + ring styles apply automatically — no extra prop needed. Pair with
 * `useFieldIds()` + `<Label htmlFor>` + `aria-describedby={ids.errorId}` for the full
 * accessible field wiring (label → input → message announcement).
 */
export const inputVariants = cva(
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive file:border-0 file:bg-transparent file:text-sm file:font-medium",
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

export interface InputProps
  extends Omit<ComponentProps<"input">, "size">,
    VariantProps<typeof inputVariants> {}

// `size` is the cva variant (sm/md) — the native input's numeric `size` attribute is
// replaced by CSS sizing in this kit (Omit above resolves the prop collision).

export function Input({ className, size, type = "text", ...props }: InputProps) {
  return <input type={type} className={cn(inputVariants({ size }), className)} {...props} />;
}

export interface FieldIds {
  /** Value for `<Label htmlFor>` / `<Input id>` */
  inputId: string;
  /** Value for the label element id (for aria-labelledby on the wrapper, if any) */
  labelId: string;
  /** Optional helper text id — wire via `aria-describedby` when present */
  descriptionId: string;
  /** Validation message id — wire via `aria-describedby` when present */
  errorId: string;
}

/**
 * htmlFor-binding helper: deterministic, SSR-safe id bundle for one field's
 * label/input/description/error wiring. Example:
 *
 *   const ids = useFieldIds("layer-rename");
 *   <Label htmlFor={ids.inputId}>Layer name</Label>
 *   <Input id={ids.inputId} aria-describedby={error ? ids.errorId : undefined} />
 */
export function useFieldIds(prefix = "field"): FieldIds {
  // React ids can contain ":" which is legal in HTML but awkward in selectors — strip it.
  const id = useId().replaceAll(":", "");
  return {
    inputId: `${prefix}-${id}-input`,
    labelId: `${prefix}-${id}-label`,
    descriptionId: `${prefix}-${id}-description`,
    errorId: `${prefix}-${id}-error`,
  };
}
