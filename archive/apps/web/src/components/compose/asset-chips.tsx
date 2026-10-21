"use client";

// apps/web — asset attachment chips (W8-D) + the W8-I injection contract.
//
// The composer attaches uploaded assets to a run via `assetIds` (§13.1 POST
// /v1/runs, ≤16). The asset LIBRARY itself belongs to W8-I — the composer must
// not import it (parallel waves, no cross-ownership hard imports). Instead the
// library's data source is INJECTED as a hook through context:
//
//   // (app) layout owner or W8-I, once the library hook exists:
//   <AssetsHookProvider value={useAssetLibrary}>
//     {children}
//   </AssetsHookProvider>
//
// `UseAssets` below is the whole contract W8-I implements (React Query hook:
// loading / error / ready + a reload seam). Until it is injected the composer
// renders the default empty state — no crash, no fake data.
//
// Selection state (≤ MAX_ASSET_ATTACHMENTS) is owned by the composer page and
// passed down; these chips are pure presentation + toggle semantics.

import { type ReactNode, createContext, useContext } from "react";
import { MAX_ASSET_ATTACHMENTS } from "./run-contract";

// ---------------------------------------------------------------------------
// The W8-I contract (the ONLY shape the composer consumes)
// ---------------------------------------------------------------------------

/** One selectable library asset, as the chips render it. */
export interface AssetOption {
  readonly id: string;
  readonly name: string;
  /** Short kind label ("PNG", "Logo") — chip subtitle when present. */
  readonly kindLabel?: string;
  /** Signed thumbnail URL; chips degrade to a text tile without it. */
  readonly thumbnailUrl?: string;
}

/** The result shape the injected library hook returns. */
export interface AssetsQueryResult {
  readonly status: "loading" | "error" | "ready";
  readonly assets: readonly AssetOption[];
  /** Present only in the `error` state — a user-safe message (§13.3). */
  readonly errorMessage?: string;
  /** Re-runs the query (the error state's retry button). */
  readonly reload: () => void;
}

/** The hook W8-I's asset library exports and the provider injects. */
export type UseAssets = () => AssetsQueryResult;

const AssetsHookContext = createContext<UseAssets | null>(null);

export interface AssetsHookProviderProps {
  /** The library hook — e.g. `useAssetLibrary` from the W8-I module. */
  readonly value: UseAssets;
  readonly children: ReactNode;
}

/** Injects the W8-I asset-library hook for every compose surface below it. */
export function AssetsHookProvider({ value, children }: AssetsHookProviderProps) {
  return <AssetsHookContext.Provider value={value}>{children}</AssetsHookContext.Provider>;
}

/** The empty-but-ready fallback used while the real hook is not injected. */
const EMPTY_ASSETS: AssetsQueryResult = {
  status: "ready",
  assets: [],
  reload: () => undefined,
};

/**
 * Reads the injected library hook, or the empty fallback when nobody wired
 * W8-I yet. Returning a CONSTANT keeps `useQuery`-free components stable.
 */
export function useAssets(): AssetsQueryResult {
  const injected = useContext(AssetsHookContext);
  return injected === null ? EMPTY_ASSETS : injected();
}

// ---------------------------------------------------------------------------
// Chips (presentation)
// ---------------------------------------------------------------------------

export interface AssetChipsProps {
  /** Library assets to render (from useAssets().assets). */
  readonly assets: readonly AssetOption[];
  readonly status: "loading" | "error" | "ready";
  /** User-safe error text for the `error` state (§13.3). */
  readonly errorMessage?: string;
  /** The ids currently attached to the run. */
  readonly selectedIds: readonly string[];
  /** Toggles one asset; the composer enforces the ≤16 cap. */
  readonly onToggle: (assetId: string) => void;
  /** The error state's retry button. */
  readonly onReload?: () => void;
  /** Selection cap display; defaults to the gateway's 16 (W4-G schema). */
  readonly max?: number;
}

function Chip({
  asset,
  selected,
  disabled,
  onToggle,
}: {
  readonly asset: AssetOption;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onToggle: (assetId: string) => void;
}) {
  const initials = asset.name.trim().slice(0, 2).toUpperCase();
  return (
    <button
      key={asset.id}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => {
        onToggle(asset.id);
      }}
      title={asset.kindLabel === undefined ? asset.name : `${asset.name} (${asset.kindLabel})`}
      className={
        selected
          ? "inline-flex max-w-56 items-center gap-2 rounded-full border border-accent bg-accent/10 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          : "inline-flex max-w-56 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
      }
    >
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-muted font-mono text-[10px] text-muted-foreground"
      >
        {initials === "" ? "?" : initials}
      </span>
      <span className="truncate">{asset.name}</span>
    </button>
  );
}

export function AssetChips({
  assets,
  status,
  errorMessage,
  selectedIds,
  onToggle,
  onReload,
  max = MAX_ASSET_ATTACHMENTS,
}: AssetChipsProps) {
  const selected = new Set(selectedIds);
  const atCap = selectedIds.length >= max;

  if (status === "loading") {
    return (
      <div className="flex flex-wrap gap-2" aria-busy>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-8 w-24 animate-pulse rounded-full bg-surface-muted"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <p className="text-xs text-muted-foreground">
        The asset library could not be loaded. {errorMessage ?? ""}
        {onReload === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              onReload();
            }}
            className="ml-2 font-medium text-foreground underline underline-offset-2"
          >
            Retry
          </button>
        )}
      </p>
    );
  }

  if (assets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No assets in this workspace yet — upload files from the dashboard and attach them here.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {assets.map((asset) => (
          <Chip
            key={asset.id}
            asset={asset}
            selected={selected.has(asset.id)}
            disabled={atCap && !selected.has(asset.id)}
            onToggle={onToggle}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {selectedIds.length} / {max} attached
      </p>
    </div>
  );
}
