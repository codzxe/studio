import { type VariantProps, cva } from "class-variance-authority";
import { type HTMLAttributes, type ReactNode, forwardRef } from "react";
import { cn } from "../lib/utils";

/**
 * Badge — §7.8. 20px height, 6px horizontal padding, radius-xs, 11px uppercase
 * label (11px is allowed only for keyboard-hint-scale micro labels; badges
 * are the exception per §7.8).
 */
export const badgeVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-xs border px-1.5 font-sans text-hint font-medium tracking-[0.06em] uppercase whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "border-border bg-input text-secondary",
        signal: "border-transparent bg-signal text-signal-ink",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/10 text-warning",
        danger: "border-danger/30 bg-danger/10 text-danger",
        ice: "border-ice/30 bg-ice/10 text-ice",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children">,
    VariantProps<typeof badgeVariants> {
  children: ReactNode;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant, children, ...props },
  ref,
) {
  return (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props}>
      {children}
    </span>
  );
});

export type StatusTone = "neutral" | "signal" | "success" | "warning" | "danger" | "ice";

const statusToneClass: Record<StatusTone, string> = {
  neutral: "bg-muted",
  signal: "bg-signal",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  ice: "bg-ice",
};

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  /** Dot tone — the label carries the meaning; colour never stands alone. */
  tone?: StatusTone;
  /** Pulse while an agent is streaming (§6.3: 1.2s opacity pulse). */
  pulse?: boolean;
  /** REQUIRED label — status is never colour-only (§3.1/§12). */
  children: ReactNode;
}

/**
 * StatusDot — signal dot + label for live states (§2.3, §7.8). The dot is
 * decorative; the label is the status text.
 */
export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { tone = "signal", pulse = false, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn("inline-flex items-center gap-2 text-caption text-secondary", className)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-pill",
          statusToneClass[tone],
          pulse && "animate-pulse-dot",
        )}
      />
      {children}
    </span>
  );
});

export type RiskLevel = "low" | "medium" | "high";

const riskConfig: Record<RiskLevel, { variant: "neutral" | "warning" | "danger"; label: string }> =
  {
    low: { variant: "neutral", label: "Low risk" },
    medium: { variant: "warning", label: "Medium risk" },
    high: { variant: "danger", label: "High risk" },
  };

export interface RiskBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  level: RiskLevel;
  /** Override the default "Low/Medium/High risk" label. */
  label?: string;
}

/** RiskBadge — chat plan risk (§7.8): low = neutral, medium = warning, high = danger. */
export const RiskBadge = forwardRef<HTMLSpanElement, RiskBadgeProps>(function RiskBadge(
  { level, label, className, ...props },
  ref,
) {
  const config = riskConfig[level];
  return (
    <Badge ref={ref} variant={config.variant} className={cn("shrink-0", className)} {...props}>
      {label ?? config.label}
    </Badge>
  );
});
