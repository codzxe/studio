"use client";

// Shared non-data states for the catalog galleries (W8-J): loading
// skeletons, typed error panels and empty results. Presentational only —
// each state renders exactly what it is given. The error panel unwraps the
// gateway envelope (src/lib/api.ts ApiError) without ever leaking stack
// traces or internal ids (§13.3).

import { Button, Skeleton } from "@studio/ui";
import type { ReactNode } from "react";
import { isApiError } from "../../lib/api";

export interface GallerySkeletonProps {
  /** Card placeholders to render (default grid: 6). */
  readonly count?: number;
  /** Accessible label while the catalog loads. */
  readonly label: string;
}

export function GallerySkeleton({ count = 6, label }: GallerySkeletonProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: count }, (_, index) => (
        <div
          key={`skeleton-${index}`}
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
          <Skeleton className="h-5 w-2/3 bg-surface-muted" />
          <Skeleton className="h-4 w-1/3 bg-surface-muted" />
          <Skeleton className="h-24 w-full bg-surface-muted" />
          <Skeleton className="h-4 w-full bg-surface-muted" />
          <Skeleton className="h-8 w-full bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}

export interface GalleryErrorProps {
  readonly error: unknown;
  readonly onRetry: () => void;
}

export function GalleryError({ error, onRetry }: GalleryErrorProps) {
  const message = isApiError(error) ? error.message : "The catalog could not be loaded.";
  const hint = isApiError(error) ? error.hint : undefined;
  return (
    <div
      role="alert"
      className="rounded-lg border border-border bg-surface p-6 text-sm shadow-sm"
    >
      <p className="font-medium">{message}</p>
      {hint !== undefined ? <p className="mt-1 text-muted-foreground">{hint}</p> : null}
      <Button
        variant="outline"
        className="mt-4 border-border bg-surface hover:bg-surface-muted"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

export interface GalleryEmptyProps {
  readonly title: string;
  readonly hint?: string;
  /** Optional action node (e.g. a "Clear filters" button). */
  readonly action?: ReactNode;
}

export function GalleryEmpty({ title, hint, action }: GalleryEmptyProps) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center">
      <p className="font-medium">{title}</p>
      {hint !== undefined ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
