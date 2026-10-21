import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** One clear sentence, sentence case, no exclamation (§7.12, §14). */
  title: string;
  /** One primary action, e.g. <Button>New project</Button>. */
  action?: ReactNode;
  /** One secondary link (§7.12). */
  secondaryLink?: { label: string; href: string };
  /**
   * Optional 1px line illustration (§7.12) — geometric only. Defaults to a
   * small frame-and-horizon mark in --line-strong.
   */
  illustration?: ReactNode;
  /** Set to false to drop the illustration entirely. */
  withIllustration?: boolean;
}

/** Default mark: a frame, a horizon rule and a dot — geometric, 1px stroke. */
function DefaultIllustration() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 96 48"
      className="h-12 w-24 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <rect x="0.5" y="0.5" width="95" height="47" stroke="var(--line-strong)" />
      <path d="M0 32h96" stroke="var(--line-strong)" />
      <circle cx="48" cy="16" r="4" stroke="var(--line-strong)" />
    </svg>
  );
}

/**
 * EmptyState — §7.12. One sentence, one primary action, one secondary link.
 * Optional geometric 1px illustration; no 3D characters, no emoji.
 */
export function EmptyState({
  title,
  action,
  secondaryLink,
  illustration,
  withIllustration = true,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-4 py-16 text-center", className)} {...props}>
      {withIllustration ? (illustration ?? <DefaultIllustration />) : null}
      <p className="max-w-[68ch] text-balance text-body text-secondary">{title}</p>
      {(action || secondaryLink) && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryLink ? (
            <a
              href={secondaryLink.href}
              className="text-body text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
            >
              {secondaryLink.label}
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}
