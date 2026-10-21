"use client";

// Asset grid (W8-I) — the library surface: responsive tile grid over the
// keyset-paged list (§13.1 GET /v1/assets), initial-load skeletons, a
// friendly empty state (distinct copy when a search filter matched
// nothing), and a "Load more" pager for the next cursor page. Delegates
// per-tile rendering to AssetCard; the attach-picked contract flows through
// untouched.

import { ImagePlus, LoaderCircle } from "lucide-react";
import { AssetCard } from "./asset-card";
import type { AssetPickedHandler, AssetSummary } from "./use-assets";

const SKELETON_TILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

const GRID_CLASS =
  "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6" as const;

export interface AssetGridProps {
  readonly assets: readonly AssetSummary[];
  readonly onRequestDelete: (asset: AssetSummary) => void;
  /** Present only in picker flows — renders the Attach affordance. */
  readonly onPick?: AssetPickedHandler;
  /** Initial load (skeletons); paging shows on the Load more button. */
  readonly loading?: boolean;
  readonly hasNextPage?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => void;
  readonly emptyTitle?: string;
  readonly emptyHint?: string;
}

export function AssetGrid({
  assets,
  onRequestDelete,
  onPick,
  loading = false,
  hasNextPage = false,
  loadingMore = false,
  onLoadMore,
  emptyTitle,
  emptyHint,
}: AssetGridProps) {
  if (loading) {
    return (
      <div className={GRID_CLASS} aria-busy="true" aria-label="Loading assets">
        {SKELETON_TILES.map((tile) => (
          <div
            key={`skeleton-${tile}`}
            aria-hidden="true"
            className="aspect-square animate-pulse rounded-lg bg-surface-muted"
          />
        ))}
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center">
        <ImagePlus className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="mt-3 text-sm font-semibold">{emptyTitle ?? "No assets yet"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {emptyHint ?? "Drop your first image above to start the library."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <ul role="list" className={GRID_CLASS}>
        {assets.map((asset) => (
          <li key={asset.id}>
            <AssetCard
              asset={asset}
              onPick={onPick}
              onRequestDelete={onRequestDelete}
            />
          </li>
        ))}
      </ul>
      {hasNextPage && onLoadMore !== undefined ? (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
