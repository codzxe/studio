import { Copy, Ellipsis } from "lucide-react";
import { type HTMLAttributes, type ReactNode, forwardRef } from "react";
import { cn } from "../lib/utils";
import { Button } from "./button";

/**
 * Card — §7.3. bg-panel, 1px border, radius-md, padding 20–24px. No drop
 * shadow at rest; hover raises border and background one step (colour only —
 * no layout animation, §6.2).
 */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-md border border-border bg-panel p-6 transition-colors duration-120 hover:border-border-strong hover:bg-elevated",
        className,
      )}
      {...props}
    />
  );
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn("mb-4 flex flex-col gap-1.5", className)} {...props} />;
  },
);

/** Card title: 16–18px medium (§7.3) — text-body-l is 17px. */
export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return (
      <h3
        ref={ref}
        className={cn("text-body-l leading-tight font-medium text-primary", className)}
        {...props}
      />
    );
  },
);

/** Metadata: 12px muted (§7.3). */
export const CardDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn("text-caption text-muted", className)} {...props} />;
});

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn("text-body-s text-secondary", className)} {...props} />;
  },
);

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return <div ref={ref} className={cn("mt-4 flex items-center gap-2", className)} {...props} />;
  },
);

export interface ProjectCardProps extends Omit<HTMLAttributes<HTMLElement>, "onError"> {
  name: string;
  /** Duration as timecode, e.g. "00:12" (§8.4 metadata: `duration · comps`). */
  duration: string;
  comps: number;
  /** Relative time, e.g. "Updated 2h ago" (§14). */
  updated: string;
  /** 16/9 thumbnail — pass an <img> or poster; a geometric slate fills in. */
  thumbnail?: ReactNode;
  onOpen?: () => void;
  onDuplicate?: () => void;
  onMore?: () => void;
  /**
   * Slate shuffle stagger in ms (§6.3): the thumbnail reveals with a 4px
   * upward fade; the parent grid passes `index * 40` (max 8 cards).
   */
  stagger?: number;
}

/** Default thumbnail stand-in — geometric 1px marks only (§7.12/§10). */
function SlatePlaceholder() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 160 90"
      className="h-full w-full text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <rect x="0.5" y="0.5" width="159" height="89" rx="1" stroke="var(--border-strong)" />
      <path d="M0 62h160" stroke="var(--border-strong)" />
      <circle cx="80" cy="45" r="7" stroke="var(--line-strong)" />
      <path d="M76.5 45h7M80 41.5v7" stroke="var(--line-strong)" />
    </svg>
  );
}

/**
 * ProjectCard — §8.4. 16/9 thumbnail dominates; metadata below (name,
 * `duration · comps`, updated). Hover (and keyboard focus-within) reveals
 * Open / Duplicate / ⋯ actions over the thumbnail. Use the whole card as a
 * link via the `onOpen` handler on the Open action.
 */
export const ProjectCard = forwardRef<HTMLElement, ProjectCardProps>(function ProjectCard(
  {
    name,
    duration,
    comps,
    updated,
    thumbnail,
    onOpen,
    onDuplicate,
    onMore,
    stagger,
    className,
    ...props
  },
  ref,
) {
  return (
    <article
      ref={ref}
      className={cn(
        "group overflow-hidden rounded-md border border-border bg-panel transition-colors duration-180 hover:border-border-strong",
        className,
      )}
      {...props}
    >
      <div className="relative aspect-video overflow-hidden bg-page">
        <div
          className="h-full w-full animate-slate-in"
          style={stagger ? { animationDelay: `${stagger}ms` } : undefined}
        >
          {thumbnail ?? <SlatePlaceholder />}
        </div>
        {/* Actions overlay — revealed on hover and focus-within (keyboard). */}
        <div className="absolute inset-x-0 bottom-0 flex translate-y-1 items-center gap-1 bg-overlay p-2 opacity-0 transition-[opacity,transform] duration-180 ease-out group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100">
          <Button size="sm" variant="secondary" onClick={onOpen}>
            Open
          </Button>
          <Button size="sm" variant="ghost" onClick={onDuplicate}>
            <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
            Duplicate
          </Button>
          <Button
            size="iconSm"
            variant="ghost"
            aria-label={`More actions for ${name}`}
            onClick={onMore}
          >
            <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="p-4">
        <h3 className="truncate text-body font-medium text-primary">{name}</h3>
        <p className="tabular mt-1 text-caption text-muted">
          {duration} · {comps} {comps === 1 ? "comp" : "comps"}
        </p>
        <p className="mt-0.5 text-caption text-muted">{updated}</p>
      </div>
    </article>
  );
});
