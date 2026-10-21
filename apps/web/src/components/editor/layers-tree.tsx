"use client";

// apps/web/src/components/editor/layers-tree.tsx (W8-F)
//
// LayersTree — the left panel's compact layer tree (§10.1): one row per node
// in the engine's top-down order, groups indenting their children. Purely
// presentational: selection + the §13.1 manual `layer.setProps` visibility
// command (via POST /v1/documents/:id/commands) are wired by DocumentEditor,
// which owns the idempotency key, optimistic update and rollback.
//
// Payload: compact `layer.list`/`document.inspect`-shaped nodes passed in via
// props — see editor-model.ts `layerTreeSchema` for the documented shape
// (name/kind/visible required; opacity/locked/bounds/expanded optional).
//
// A11y: `role="tree"` with `role="treeitem"` rows (`aria-level`,
// `aria-selected`, `aria-expanded` on groups); every control is a real button.

import {
  ChevronDown,
  ChevronRight,
  Component,
  Eye,
  EyeOff,
  Folder,
  Image as ImageIcon,
  Layers,
  Lock,
  type LucideIcon,
  Shapes,
  SlidersHorizontal,
  Square,
  Type,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@studio/ui";
import {
  flattenLayerTree,
  formatBounds,
  formatOpacity,
  normalizeLayerKind,
  type LayerKindKey,
  type LayerNode,
} from "./editor-model";

const KIND_ICONS: Readonly<Record<LayerKindKey, LucideIcon>> = {
  group: Folder,
  text: Type,
  photo: ImageIcon,
  vector: Shapes,
  adjustment: SlidersHorizontal,
  component: Component,
  fill: Square,
  pixel: Layers,
};

export interface LayersTreeProps {
  /** Compact layer-tree payload (top-down; groups carry `children`). */
  readonly layers: readonly LayerNode[];
  /** Id of the selected layer, or null when nothing is selected. */
  readonly selectedLayerId: string | null;
  /** Id of the layer whose visibility command is in flight (eye disabled). */
  readonly busyLayerId: string | null;
  /** Fired when a row is clicked — DocumentEditor records the selection. */
  readonly onSelect: (layerId: string) => void;
  /** Fired on the eye toggle — DocumentEditor posts layer.setProps (§13.1). */
  readonly onToggleVisibility: (node: LayerNode) => void;
  readonly className?: string;
}

/** Groups shipped with `expanded: false` start collapsed (§13.1 layer.setExpanded). */
function initiallyCollapsed(layers: readonly LayerNode[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const walk = (nodes: readonly LayerNode[]): void => {
    for (const node of nodes) {
      if (node.children !== undefined && node.children.length > 0) {
        if (node.expanded === false) {
          ids.add(node.id);
        }
        walk(node.children);
      }
    }
  };
  walk(layers);
  return ids;
}

export function LayersTree({
  layers,
  selectedLayerId,
  busyLayerId,
  onSelect,
  onToggleVisibility,
  className,
}: LayersTreeProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() =>
    initiallyCollapsed(layers),
  );

  const toggleGroup = (id: string): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (layers.length === 0) {
    return (
      <p
        className={cn(
          "rounded-md border border-border bg-surface-muted px-3 py-4 text-sm text-muted-foreground",
          className,
        )}
      >
        No layers yet — create the document from a template, or describe what to
        build in the chat panel.
      </p>
    );
  }

  const rows = flattenLayerTree(layers, (id) => !collapsedGroups.has(id));

  return (
    <div role="tree" aria-label="Document layers" className={cn("flex flex-col gap-0.5", className)}>
      {rows.map(({ node, depth, hasChildren }) => {
        const collapsed = collapsedGroups.has(node.id);
        const selected = selectedLayerId === node.id;
        const busy = busyLayerId !== null;
        const bounds = formatBounds(node.bounds);
        const KindIcon = KIND_ICONS[normalizeLayerKind(node.kind)];
        const eyeLabel = `${node.visible ? "Hide" : "Show"} layer ${node.name}`;

        return (
          <div
            key={node.id}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={selected}
            aria-expanded={hasChildren ? !collapsed : undefined}
            data-selected={selected ? "true" : undefined}
            style={{ paddingLeft: depth * 12 }}
            className={cn(
              "flex items-center gap-1 rounded-sm py-1 pr-1",
              selected ? "bg-accent/40" : "hover:bg-surface-muted",
            )}
          >
            {hasChildren ? (
              <button
                type="button"
                onClick={() => toggleGroup(node.id)}
                aria-label={`${collapsed ? "Expand" : "Collapse"} group ${node.name}`}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {collapsed ? (
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                )}
              </button>
            ) : (
              <span aria-hidden="true" className="size-5 shrink-0" />
            )}

            <button
              type="button"
              onClick={() => onToggleVisibility(node)}
              disabled={busy}
              aria-label={eyeLabel}
              title={eyeLabel}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busyLayerId === node.id ? (
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-current motion-safe:animate-pulse"
                />
              ) : node.visible ? (
                <Eye className="size-3.5" aria-hidden="true" />
              ) : (
                <EyeOff className="size-3.5" aria-hidden="true" />
              )}
            </button>

            <KindIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />

            <button
              type="button"
              onClick={() => onSelect(node.id)}
              title={
                bounds === null
                  ? node.name
                  : `${node.name} — bounds ${bounds}, opacity ${formatOpacity(node.opacity)}`
              }
              className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex w-full min-w-0 items-center gap-1">
                <span
                  className={cn(
                    "truncate text-sm",
                    node.visible ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {node.name}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {formatOpacity(node.opacity)}
                </span>
              </span>
              {bounds === null ? null : (
                <span className="w-full truncate text-xs text-muted-foreground">{bounds}</span>
              )}
            </button>

            {node.locked === true ? (
              <Lock
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label={`Layer ${node.name} is locked`}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
