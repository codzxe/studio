import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Button — accessible action primitive (§16.3 shadcn pattern, styles fully owned here).
 *
 * A11y contract:
 * - Native `<button>` semantics: reachable via Tab, activated via Enter/Space.
 * - `type` defaults to `"button"` so stray buttons never submit forms implicitly;
 *   pass `type="submit"` explicitly on submit buttons.
 * - Disabled uses the native `disabled` attribute (removed from tab order, announced
 *   as dimmed by screen readers, pointer + keyboard inert). With `asChild`, forward
 *   `aria-disabled` on the child element instead — the DOM element may not support
 *   `disabled`.
 * - Focus is always visible: a `focus-visible` ring offset by the background token.
 * - Icon-only buttons (`size="icon"`) MUST pass `aria-label` (see README contract).
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        sm: "h-8 rounded-sm px-3 text-xs",
        md: "h-9 px-4 py-2",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  /**
   * Render the child element instead of a `<button>` (e.g. `<a>`, router `<Link>`).
   * Classes and a11y props are merged onto the child via Radix Slot (single child only).
   */
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
