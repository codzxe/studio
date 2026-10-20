import { ChevronsLeft, ChevronsRight } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  createContext,
  useContext,
  useId,
  useState,
} from "react";
import { cn } from "../lib/cn.js";

/**
 * Panel — collapsible side panel, the editor layout's building block (layers, chat,
 * versions rails). Composition: `<Panel side="left"><PanelHeader title=...
 * actions=... /><PanelContent>…</PanelContent></Panel>` plus a sibling
 * `<PanelResizeHandle />` between the panel and the canvas.
 *
 * A11y contract:
 * - The collapse toggle is a native button with `aria-expanded` + `aria-controls`
 *   bound to the content region; collapsed content is removed from the DOM (no hidden
 *   focus traps) and the region carries `role="region"` + `aria-labelledby`.
 * - PanelResizeHandle is a focusable `role="separator"` (vertical) resizable with
 *   ArrowLeft/ArrowRight; pointer-drag wiring is delegated to the layout (stub).
 */

export type PanelSide = "left" | "right";

interface PanelContextValue {
  side: PanelSide;
  collapsed: boolean;
  toggle: () => void;
  contentId: string;
  headerTitleId: string;
}

const PanelContext = createContext<PanelContextValue | null>(null);

function usePanelContext(component: string): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (ctx === null) {
    throw new Error(`${component} must be rendered inside <Panel>`);
  }
  return ctx;
}

export interface PanelProps extends ComponentProps<"aside"> {
  /** Which edge of the layout the panel hugs — decides border side + chevron direction. */
  side?: PanelSide;
  /** Controlled collapse state. Omit to let the panel manage itself. */
  collapsed?: boolean;
  /** Uncontrolled initial state (ignored when `collapsed` is provided). */
  defaultCollapsed?: boolean;
  /** Notified on toggle for controlled usage. */
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function Panel({
  side = "left",
  collapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  className,
  children,
  ...props
}: PanelProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const isCollapsed = collapsed ?? internalCollapsed;
  const rawId = useId().replaceAll(":", "");
  const contentId = `panel-${rawId}-content`;
  const headerTitleId = `panel-${rawId}-title`;

  const toggle = () => {
    const next = !isCollapsed;
    setInternalCollapsed(next);
    onCollapsedChange?.(next);
  };

  const value: PanelContextValue = {
    side,
    collapsed: isCollapsed,
    toggle,
    contentId,
    headerTitleId,
  };

  return (
    <PanelContext.Provider value={value}>
      <aside
        data-side={side}
        data-state={isCollapsed ? "collapsed" : "expanded"}
        className={cn(
          "flex h-full min-w-[var(--panel-collapsed-width)] flex-col overflow-hidden border-border bg-card text-card-foreground transition-[width] data-[state=collapsed]:w-[var(--panel-collapsed-width)] data-[state=expanded]:w-[var(--panel-width)] data-[state=expanded]:min-w-[var(--panel-min-width)] data-[state=expanded]:max-w-[var(--panel-max-width)]",
          side === "left" ? "border-r" : "border-l",
          className,
        )}
        {...props}
      >
        {children}
      </aside>
    </PanelContext.Provider>
  );
}

export interface PanelHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  /** Panel title — used for the collapse toggle's accessible name and the region label.
   *  (Replaces the native `title` tooltip attribute — the visible header is richer.) */
  title: ReactNode;
  /** Right-aligned action area (buttons, menus). */
  actions?: ReactNode;
}

export function PanelHeader({ title, actions, className, ...props }: PanelHeaderProps) {
  const { side, collapsed, toggle, contentId, headerTitleId } = usePanelContext("PanelHeader");
  const ExpandIcon = side === "left" ? ChevronsRight : ChevronsLeft;
  const CollapseIcon = side === "left" ? ChevronsLeft : ChevronsRight;

  return (
    <header
      className={cn("flex h-10 shrink-0 items-center gap-1 border-b border-border px-2", className)}
      {...props}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        aria-label={collapsed ? "Expand panel" : "Collapse panel"}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {collapsed ? (
          <ExpandIcon className="size-4" aria-hidden="true" />
        ) : (
          <CollapseIcon className="size-4" aria-hidden="true" />
        )}
      </button>
      <h3
        id={headerTitleId}
        className={cn(
          "min-w-0 flex-1 truncate text-sm font-semibold",
          collapsed ? "sr-only" : "text-foreground",
        )}
      >
        {title}
      </h3>
      {collapsed ? null : actions}
    </header>
  );
}

export function PanelContent({ className, children, ...props }: ComponentProps<"section">) {
  const { collapsed, contentId, headerTitleId } = usePanelContext("PanelContent");
  if (collapsed) {
    return null; // collapsed rails drop content from the a11y tree — no hidden focus traps
  }
  return (
    // <section aria-labelledby=…> carries an implicit role="region" — biome useSemanticElements
    <section
      id={contentId}
      aria-labelledby={headerTitleId}
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2", className)}
      {...props}
    >
      {children}
    </section>
  );
}

const RESIZE_STEP_PX = 16;

export interface PanelResizeHandleProps extends ComponentProps<"div"> {
  /** Which side the handle's panel sits on — flips the arrow-key direction. */
  side?: PanelSide;
  /** Stub seam for the layout: receives keyboard-driven resize deltas (+ = widen). */
  onResize?: (deltaPx: number) => void;
}

export function PanelResizeHandle({
  side = "left",
  onResize,
  className,
  onKeyDown,
  ...props
}: PanelResizeHandleProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    switch (event.key) {
      case "ArrowLeft": {
        delta = side === "left" ? -RESIZE_STEP_PX : RESIZE_STEP_PX;
        break;
      }
      case "ArrowRight": {
        delta = side === "left" ? RESIZE_STEP_PX : -RESIZE_STEP_PX;
        break;
      }
      default: {
        break;
      }
    }
    if (delta !== 0) {
      event.preventDefault();
      onResize?.(delta);
    }
    onKeyDown?.(event);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize panel"
      onKeyDown={handleKeyDown}
      data-resize-handle=""
      className={cn(
        "w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-border focus-visible:bg-ring focus-visible:outline-none data-[dragging=true]:bg-ring",
        className,
      )}
      {...props}
    />
  );
}
