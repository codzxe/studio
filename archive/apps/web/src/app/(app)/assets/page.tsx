"use client";

// Asset library page (W8-I) — §13.1 `GET /v1/assets` as a lazy thumbnail
// grid (signed URLs, §15.1), upload dropzone with the §20.2 client-side
// mirrors (JPEG/PNG, 25 MB, friendly 60 MP warning), client-side name
// search, delete-with-confirm, and the W8-D attach-picked flow.
//
// Picker mode: `/assets?picker=1` adds Attach buttons; a picked asset is
// postMessage'd to the opening tab at its referrer origin (Referrer-Policy
// is strict-origin-when-cross-origin, so document.referrer carries exactly
// the origin we need — never "*", and nothing is sent when the origin is
// unknown). See use-assets.ts for the full contract (embedders can also
// render <AssetGrid onPick={…}> directly).

import { Paperclip, RotateCcw, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { AssetGrid } from "@/components/assets/asset-grid";
import { DeleteDialog } from "@/components/assets/delete-dialog";
import { describeLibraryFailure } from "@/components/assets/guards";
import { UploadDropzone } from "@/components/assets/upload-dropzone";
import {
  ASSET_PICKED_MESSAGE_TYPE,
  useAssetsPages,
  type AssetPickedHandler,
  type AssetSummary,
} from "@/components/assets/use-assets";

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"] as const;

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function AssetLibrary() {
  const searchParams = useSearchParams();
  const pickerMode = searchParams.get("picker") === "1";
  const listQuery = useAssetsPages();
  const [query, setQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AssetSummary | null>(null);
  const [pickedNotice, setPickedNotice] = useState<string | null>(null);

  const assets = useMemo(() => {
    const all = listQuery.data?.pages.flatMap((page) => page.assets) ?? [];
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return all;
    }
    // §13.1's list endpoint has no server-side search parameter yet — the
    // box filters the loaded pages client-side; swap to a ?q= param when
    // the API grows one.
    return all.filter((asset) => asset.name.toLowerCase().includes(needle));
  }, [listQuery.data, query]);

  const onPick: AssetPickedHandler = (picked) => {
    const opener: Window | null = window.opener;
    if (opener !== null) {
      const referrerOrigin = safeOrigin(document.referrer);
      if (referrerOrigin !== null) {
        opener.postMessage(
          {
            type: ASSET_PICKED_MESSAGE_TYPE,
            asset: picked.asset,
            url: picked.url,
            expires_at: picked.expiresAt,
          },
          referrerOrigin,
        );
      }
    }
    setPickedNotice(`"${picked.asset.name}" is attached to your prompt.`);
  };

  const trimmedQuery = query.trim();
  const listFailure =
    listQuery.error === null ? null : describeLibraryFailure(listQuery.error);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Assets</h1>
        <p className="text-sm text-muted-foreground">
          Your workspace image library — JPEG or PNG, up to 25 MB. EXIF
          metadata is stripped from uploads; images over 60 MP are rejected.
        </p>
      </div>

      {listFailure !== null ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-red-600">
            {listFailure.title}
            {listFailure.hint !== undefined ? (
              <span className="block text-xs text-muted-foreground">{listFailure.hint}</span>
            ) : null}
          </p>
          <button
            type="button"
            onClick={() => {
              void listQuery.refetch();
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : null}

      {pickerMode ? (
        <div className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
          <Paperclip className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          <p>
            Pick an image to attach to your prompt.
            {pickedNotice !== null ? (
              <span className="font-medium"> {pickedNotice}</span>
            ) : null}
          </p>
        </div>
      ) : null}

      <UploadDropzone />

      <div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Search by name…"
            aria-label="Search assets by name"
            className="w-full max-w-sm rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        {trimmedQuery === "" ? null : (
          <p className="mt-2 text-xs text-muted-foreground">
            {assets.length} {assets.length === 1 ? "match" : "matches"} in the loaded
            pages
          </p>
        )}
      </div>

      <AssetGrid
        assets={assets}
        loading={listQuery.isLoading}
        hasNextPage={listQuery.hasNextPage}
        loadingMore={listQuery.isFetchingNextPage}
        onLoadMore={() => {
          void listQuery.fetchNextPage();
        }}
        onPick={pickerMode ? onPick : undefined}
        onRequestDelete={(asset) => {
          setDeleteTarget(asset);
        }}
        emptyTitle={trimmedQuery === "" ? "No assets yet" : `No assets match "${trimmedQuery}"`}
        emptyHint={
          trimmedQuery === ""
            ? "Drop your first image above to start the library."
            : "Try a different name, or load more assets."
        }
      />

      <DeleteDialog
        asset={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

export default function AssetsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6" aria-busy="true">
          <div className="h-8 w-40 animate-pulse rounded-md bg-surface-muted" />
          <div className="h-28 animate-pulse rounded-lg bg-surface-muted" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {SKELETON_KEYS.map((key) => (
              <div
                key={`skeleton-${key}`}
                aria-hidden="true"
                className="aspect-square animate-pulse rounded-lg bg-surface-muted"
              />
            ))}
          </div>
        </div>
      }
    >
      <AssetLibrary />
    </Suspense>
  );
}
