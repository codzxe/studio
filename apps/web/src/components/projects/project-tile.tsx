import { Button, cn } from "@studio/ui";
import { Copy, Ellipsis } from "lucide-react";
import { type HTMLAttributes, forwardRef } from "react";

/**
 * ProjectTile (W2-B4, M9 honesty) — the §8.4 project card the dashboard
 * Recent grid and the /w/projects browser share, WITHOUT the
 * `duration · comps` metadata line.
 *
 * Why this exists beside packages/ui's `ProjectCard`: the kit card requires
 * `duration: string` + `comps: number` props and always renders them, but the
 * §7.2 `Project` wire row carries NEITHER field (and a per-project manifest
 * read is not a grid-scale derivation), so the views used to fake
 * `duration="—" comps={0}` — a "— · 0 comps" line on every card, exactly the
 * fake-metadata class M9 bans. This tile keeps the kit card's structure
 * (16:9 slate frame, hover/focus action overlay, name + updated) and renders
 * NOTHING for metadata that does not exist. When the wire grows a
 * duration/comps seam (or the kit card's metadata props become optional),
 * fold this back into the kit card.
 *
 * Differences from the kit card, deliberate:
 * - no metadata line under the name (see above);
 * - `onDuplicate`/`onMore` render their buttons ONLY when a handler is
 *   supplied — an action row with dead buttons is a faked affordance, so a
 *   surface that only opens (the dashboard) shows only "Open".
 */

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

export interface ProjectTileProps extends Omit<HTMLAttributes<HTMLElement>, "onError"> {
  name: string;
  /** Relative time, e.g. "Updated 2h ago" (§14). */
  updated: string;
  onOpen?: () => void;
  onDuplicate?: () => void;
  onMore?: () => void;
  /**
   * Slate shuffle stagger in ms (§6.3): the frame reveals with a 4px upward
   * fade; the parent grid passes `index * 40` (max 8 tiles).
   */
  stagger?: number;
}

/**
 * ProjectTile — §8.4. 16:9 slate frame dominates; name + updated below.
 * Hover (and keyboard focus-within) reveals the wired actions over the
 * frame. No duration/comps metadata: the Project wire carries neither.
 */
export const ProjectTile = forwardRef<HTMLElement, ProjectTileProps>(function ProjectTile(
  { name, updated, onOpen, onDuplicate, onMore, stagger, className, ...props },
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
          <SlatePlaceholder />
        </div>
        {/* Actions overlay — revealed on hover and focus-within (keyboard).
            Only wired actions render (no dead buttons). */}
        <div className="absolute inset-x-0 bottom-0 flex translate-y-1 items-center gap-1 bg-overlay p-2 opacity-0 transition-[opacity,transform] duration-180 ease-out group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100">
          <Button size="sm" variant="secondary" onClick={onOpen}>
            Open
          </Button>
          {onDuplicate !== undefined ? (
            <Button size="sm" variant="ghost" onClick={onDuplicate}>
              <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
              Duplicate
            </Button>
          ) : null}
          {onMore !== undefined ? (
            <Button
              size="iconSm"
              variant="ghost"
              aria-label={`More actions for ${name}`}
              onClick={onMore}
            >
              <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="p-4">
        <h3 className="truncate text-body font-medium text-primary">{name}</h3>
        <p className="mt-0.5 text-caption text-muted">{updated}</p>
      </div>
    </article>
  );
});
