"use client";

// Asset card (W8-I) — one library tile: lazy signed-URL thumbnail (§15.1,
// fetched only when the card nears the viewport), metadata, the §20.2 EXIF
// notice badge for JPEGs, delete affordance, and — when an `onPick` handler
// is supplied (the W8-D attach-picked contract) — an Attach button that
// resolves a fresh signed URL and hands the picked asset to the embedder.

import { useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, LoaderCircle, Paperclip, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { formatBytes } from "./guards";
import {
  assetUrlQueryKey,
  resolveAssetUrl,
  useSignedAssetUrl,
  type AssetPickedHandler,
  type AssetSummary,
} from "./use-assets";

/**
 * Viewport probe for lazy thumbnails. Resolves once (observer disconnected
 * on first intersect); engines without IntersectionObserver fall back to
 * eager loading.
 */
function useInView<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) {
      return; // already resolved — nothing to observe
    }
    const node = ref.current;
    if (node === null) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "200px" }, // start signing a little before it scrolls in
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [inView]);
  return [ref, inView];
}

type AttachState = "idle" | "busy" | "done" | "failed";

export interface AssetCardProps {
  readonly asset: AssetSummary;
  /** Opens the delete confirmation (page-level state). */
  readonly onRequestDelete: (asset: AssetSummary) => void;
  /** Present only in picker flows — renders the Attach affordance. */
  readonly onPick?: AssetPickedHandler;
}

export function AssetCard({ asset, onRequestDelete, onPick }: AssetCardProps) {
  const queryClient = useQueryClient();
  const [thumbRef, thumbInView] = useInView<HTMLDivElement>();
  const urlQuery = useSignedAssetUrl(asset.id, { enabled: thumbInView });
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [attachState, setAttachState] = useState<AttachState>("idle");
  // A signature that stops working mid-session (a card can outlive the
  // §15.1 15-minute ttl) gets exactly ONE fresh signature; a second failure
  // means the preview is genuinely unavailable.
  const refreshedRef = useRef(false);

  const src = urlQuery.data?.url.url ?? null;
  const thumbFailed =
    (urlQuery.isError || (src !== null && failedSrc === src)) && !urlQuery.isFetching;

  function onThumbError(): void {
    if (refreshedRef.current || src === null) {
      setFailedSrc(src);
      return;
    }
    refreshedRef.current = true;
    void queryClient.invalidateQueries({ queryKey: assetUrlQueryKey(asset.id) });
  }

  async function handleAttach(): Promise<void> {
    if (onPick === undefined || attachState === "busy") {
      return;
    }
    setAttachState("busy");
    try {
      const signed = await resolveAssetUrl(queryClient, asset.id);
      await onPick({
        asset,
        url: signed.url.url,
        expiresAt: signed.url.expires_at,
      });
      setAttachState("done");
    } catch {
      setAttachState("failed");
    }
  }

  const meta =
    asset.width !== null && asset.height !== null
      ? `${asset.width} × ${asset.height} · ${formatBytes(asset.bytes)}`
      : formatBytes(asset.bytes);

  return (
    <figure className="group relative overflow-hidden rounded-lg border border-border bg-surface">
      <div ref={thumbRef} className="relative aspect-square bg-surface-muted">
        {src !== null && !thumbFailed ? (
          <img
            src={src}
            alt={asset.name}
            loading="lazy"
            decoding="async"
            onError={onThumbError}
            className="size-full object-cover"
          />
        ) : thumbFailed ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ImagePlus className="size-6" aria-hidden="true" />
            <p className="text-xs">Preview unavailable</p>
          </div>
        ) : (
          <div aria-hidden="true" className="size-full animate-pulse" />
        )}

        {onPick !== undefined ? (
          <button
            type="button"
            onClick={() => {
              void handleAttach();
            }}
            disabled={attachState === "busy"}
            className="absolute inset-x-2 bottom-2 inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {attachState === "busy" ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : attachState === "done" ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Paperclip className="size-3.5" aria-hidden="true" />
            )}
            {attachState === "busy"
              ? "Attaching…"
              : attachState === "done"
                ? "Attached"
                : attachState === "failed"
                  ? "Retry attach"
                  : "Attach"}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => {
            onRequestDelete(asset);
          }}
          aria-label={`Delete ${asset.name}`}
          className="absolute right-1.5 top-1.5 rounded-md bg-background/80 p-1.5 text-muted-foreground opacity-0 transition focus-visible:opacity-100 focus:opacity-100 group-hover:opacity-100 hover:text-red-600"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>

      <figcaption className="space-y-1 p-2">
        <p className="truncate text-sm font-medium" title={asset.name}>
          {asset.name}
        </p>
        <p className="text-xs text-muted-foreground">{meta}</p>
        {/* §20.2: EXIF never survives a JPEG upload (PNGs carry none by
         * construction) — the notice rides every JPEG tile. */}
        {asset.mime === "image/jpeg" ? (
          <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
            EXIF stripped on upload
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
