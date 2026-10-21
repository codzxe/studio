"use client";

// apps/web/src/components/editor/preview-canvas.tsx (W8-F)
//
// PreviewCanvas — the center panel. Renders the cached preview PNG behind a
// short-lived signed URL from `GET /v1/documents/:id/preview?w=1024`
// (§13.1; W4-L routes/exports.ts — the worker's PreviewPipeline writes the
// cache, so a 404 `preview_not_rendered` shows a friendly empty state).
//
// The refresh key is the REVISION: DocumentEditor bumps it after every
// §13.1 command/undo/redo reply and every committed run (§13.2
// `preview.updated` carries `revision` too), which re-runs the fetch and
// re-mounts the <img> via React `key` — no cache-busting hacks on the URL.
//
// A plain <img> on purpose (not next/image): previews arrive from the
// workspace's object storage via per-request signed URLs (≤15 min TTL,
// §13), so next.config.ts has no remotePatterns for them (W1-K note).
//
// Zoom: Fit (fit-to-stage, capped at 100%) vs 100% (document scale: one
// document pixel per screen pixel via an explicit CSS width; falls back to
// the preview's intrinsic size when canvas dimensions are unknown).

import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Skeleton, cn } from "@studio/ui";
import type { GatewayClient } from "../../lib/api";
import {
  errorText,
  fitScale,
  previewPath,
  previewReplySchema,
  type PreviewReply,
} from "./editor-model";

const PREVIEW_WIDTH = 1_024; // §13.1 preview width

type ZoomMode = "fit" | "actual";

export interface PreviewCanvasProps {
  /** Typed gateway client (apps/web/src/lib/api.ts). */
  readonly client: GatewayClient;
  readonly documentId: string;
  /** Document display name for the img alt text. */
  readonly documentName?: string;
  /** Refresh key — the canvas refetches whenever the revision changes. */
  readonly revision: number;
  /** Canvas size from GET /v1/documents/:id — drives the 100% zoom + fit label. */
  readonly documentWidthPx?: number;
  readonly documentHeightPx?: number;
  readonly className?: string;
}

export function PreviewCanvas({
  client,
  documentId,
  documentName,
  revision,
  documentWidthPx,
  documentHeightPx,
  className,
}: PreviewCanvasProps) {
  const [preview, setPreview] = useState<PreviewReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<ZoomMode>("fit");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Signed-URL fetch — cancelled effects never touch state.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client
      .get(previewPath(documentId, PREVIEW_WIDTH), { schema: previewReplySchema })
      .then((reply) => {
        if (!cancelled) {
          setPreview(reply);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          // §13.3 messages are user-safe (e.g. the documented
          // preview_not_rendered miss); anything else collapses.
          setError(errorText(cause, "Could not load the preview. Try again in a moment."));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, documentId, revision, reloadNonce]);

  // Stage measurement for the fit-percentage label (best effort; 0 = hide).
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) {
        return;
      }
      const box = entry.contentRect;
      setStageSize({ w: box.width, h: box.height });
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, []);

  const fitPercent =
    documentWidthPx !== undefined &&
    documentHeightPx !== undefined &&
    stageSize.w > 0 &&
    stageSize.h > 0
      ? Math.round(fitScale(stageSize.w, stageSize.h, documentWidthPx, documentHeightPx) * 100)
      : null;

  const actualWidthStyle =
    zoom === "actual" && documentWidthPx !== undefined
      ? { width: `${documentWidthPx}px` }
      : undefined;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Badge variant="outline" title="Document revision the preview was rendered at">
          Revision {revision}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {documentName ?? documentId}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadNonce((nonce) => nonce + 1)}
          aria-label="Refresh preview"
          title="Refresh preview (the signed link expires after a few minutes)"
          className="gap-1"
        >
          <RotateCw className="size-3.5" aria-hidden="true" />
          Refresh
        </Button>
        <div role="group" aria-label="Preview zoom" className="flex items-center gap-1">
          <Button
            variant={zoom === "fit" ? "default" : "ghost"}
            size="sm"
            onClick={() => setZoom("fit")}
            aria-pressed={zoom === "fit"}
          >
            Fit{fitPercent === null ? "" : ` · ${fitPercent}%`}
          </Button>
          <Button
            variant={zoom === "actual" ? "default" : "ghost"}
            size="sm"
            onClick={() => setZoom("actual")}
            aria-pressed={zoom === "actual"}
          >
            100%
          </Button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="editor-checkerboard flex min-h-0 flex-1 overflow-auto p-4"
      >
        {loading && preview === null ? (
          <Skeleton className="m-auto h-48 w-48 rounded-sm" />
        ) : preview === null ? (
          <div
            role="alert"
            className="m-auto max-w-sm rounded-md border border-border bg-surface px-4 py-3 text-center text-sm text-muted-foreground"
          >
            {error ?? "No preview yet."}
            {error === null ? (
              <span className="mt-1 block text-xs">
                Previews render after the first edit or open of the document.
              </span>
            ) : null}
          </div>
        ) : (
          // key = revision: a fresh signed URL re-mounts the image (§13.2 preview.updated).
          <img
            key={preview.revision}
            src={preview.url}
            alt={`Preview of ${documentName ?? "document"} at revision ${preview.revision}`}
            draggable={false}
            style={actualWidthStyle}
            className={cn(
              "m-auto select-none",
              zoom === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none",
            )}
          />
        )}
      </div>
    </div>
  );
}
