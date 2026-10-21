"use client";

// apps/web — preview panel (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §13.2  preview.updated carries { url, revision } — the LAST one wins; the
//          panel shows the latest render plus its revision number.
//   §20 #5 previews stream as the run progresses — before the first frame the
//          panel is an optimistic skeleton, never a fake image.
//
// The <img> is deliberate: preview URLs are gateway-signed and remote to the
// Next image optimizer; next/image would need a remotePatterns entry this
// page cannot own (next.config.ts is not in W8-E paths).

import type { RunTimeline } from "./timeline-state";

export interface PreviewPanelProps {
  readonly timeline: RunTimeline;
}

export function PreviewPanel({ timeline }: PreviewPanelProps) {
  const { preview, terminal } = timeline;

  if (preview === null) {
    return (
      <section
        aria-label="Preview"
        className="overflow-hidden rounded-lg border border-border bg-surface"
      >
        <div className="flex h-64 items-center justify-center bg-surface-muted">
          {terminal ? (
            <p className="px-6 text-center text-sm text-muted-foreground">
              No preview was captured for this run.
            </p>
          ) : (
            <div className="w-full max-w-xs space-y-2 px-6 text-center">
              <div className="mx-auto h-40 w-32 animate-pulse rounded-md bg-muted" />
              <p className="text-xs text-muted-foreground">Rendering the first preview…</p>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Preview" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">Preview</h2>
        <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Revision {preview.revision}
        </span>
      </div>
      <div className="flex max-h-[28rem] items-center justify-center bg-surface-muted p-4">
        <img
          src={preview.url}
          alt={`Document preview, revision ${preview.revision}`}
          className="max-h-64 w-auto max-w-full rounded-md border border-border object-contain"
          loading="lazy"
        />
      </div>
    </section>
  );
}
