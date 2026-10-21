import { type VariantProps, cva } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";
import { Spinner } from "./spinner";

/**
 * Button — §7.1.
 * Sizes: sm 28 / md 36 / lg 44; icon-only 32 (`iconSm`) / 36 (`icon`) with an
 * `aria-label` + tooltip. Loading keeps width: the original content becomes
 * invisible while a spinner + "Working…" overlays it. Disabled uses opacity .45
 * plus `aria-disabled`.
 */
export const buttonVariants = cva(
  "relative inline-flex shrink-0 select-none items-center justify-center gap-2 rounded-sm font-medium whitespace-nowrap transition-colors duration-120 ease-out disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "bg-signal text-signal-ink hover:bg-signal-hover active:bg-signal-press",
        secondary:
          "border border-border bg-elevated text-primary hover:border-border-strong hover:bg-input",
        ghost: "text-secondary hover:bg-elevated hover:text-primary",
        danger: "bg-danger text-signal-ink hover:brightness-110 active:brightness-95",
        link: "rounded-none px-0 text-primary underline underline-offset-3 hover:text-signal",
      },
      size: {
        sm: "h-7 px-3 text-body-s",
        md: "h-9 px-4 text-body",
        lg: "h-11 px-5 text-body",
        iconSm: "h-8 w-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Busy state: replaces content with a spinner + "Working…" while keeping the
   * button at its original width. The button is non-interactive while loading.
   */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    loading = false,
    disabled = false,
    children,
    type = "button",
    ...props
  },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span
            className="absolute inset-0 flex items-center justify-center gap-2"
            data-testid="button-loading"
          >
            <Spinner size={size === "lg" ? 20 : 16} label="Working" />
            <span>Working…</span>
          </span>
          <span className="invisible" aria-hidden="true">
            {children}
          </span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
