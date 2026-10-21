"use client";

// apps/web — one document row/card for the library (W8-C). Pure presentational
// component: no fetching, no mutations. Two variants:
//   - "grid"  tile with a preview placeholder (real previews arrive with the
//             render/preview wiring wave — GET /v1/documents/:id/preview §13.1)
//   - "row"   compact list row
// Pending cards render an aria-busy, linkless placeholder while the optimistic
// create (use-documents.ts) is in flight.
//
// A11y: the whole card is one link (single tabstop, announced name = document
// name); meta is plain text inside the link so screen readers get it for free;
// the pending variant is a <div aria-busy> with an sr-only status.

import { FileImage } from "lucide-react";
import Link from "next/link";
import { Badge } from "@studio/ui";
import { isOptimisticDocument, type DocumentDto } from "./use-documents";

const CREATED_FORMAT = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** Deterministic (SSR-safe) "Jan 5, 2025" rendering of a document timestamp. */
export function formatDocumentDate(iso: string): string {
  return CREATED_FORMAT.format(new Date(iso));
}

export interface DocumentCardProps {
  readonly document: DocumentDto;
  readonly variant?: "grid" | "row";
  readonly className?: string;
}

export function DocumentCard({ document, variant = "grid", className }: DocumentCardProps) {
  if (isOptimisticDocument(document)) {
    return <PendingDocumentCard document={document} variant={variant} />;
  }

  const meta = `${document.width_px} × ${document.height_px} px`;

  if (variant === "row") {
    return (
      <Link
        href={`/documents/${document.id}`}
        className={`group flex items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring ${className ?? ""}`}
      >
        <FileImage aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium group-hover:underline">
          {document.name}
        </span>
        <span aria-hidden="true" className="hidden text-xs text-muted-foreground sm:inline">
          {meta}
        </span>
        {document.template_id === null ? null : (
          <Badge variant="outline" className="hidden sm:inline-flex">
            {document.template_id}
          </Badge>
        )}
        <Badge variant="outline">Rev {document.current_revision}</Badge>
        <span aria-hidden="true" className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground md:inline">
          {formatDocumentDate(document.created_at)}
        </span>
      </Link>
    );
  }

  return (
    <Link
      href={`/documents/${document.id}`}
      className={`group block rounded-lg border border-border bg-surface outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-ring ${className ?? ""}`}
    >
      {/* Preview placeholder until the preview endpoint ships (§13.1). */}
      <div className="flex aspect-video items-center justify-center rounded-t-lg border-b border-border bg-surface-muted">
        <span className="flex flex-col items-center gap-1 text-muted-foreground">
          <FileImage aria-hidden="true" className="size-8" />
          <span className="text-xs">{meta}</span>
        </span>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <span className="truncate font-medium group-hover:underline">{document.name}</span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Rev {document.current_revision}</Badge>
          {document.template_id === null ? null : (
            <Badge variant="outline" className="max-w-32 truncate">
              {document.template_id}
            </Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          Created {formatDocumentDate(document.created_at)}
        </span>
      </div>
    </Link>
  );
}

/** The optimistic-creation placeholder (linkless, announced as busy). */
function PendingDocumentCard({ document, variant }: DocumentCardProps) {
  const label = `Creating “${document.name}”…`;
  if (variant === "row") {
    return (
      <div
        aria-busy="true"
        className="flex items-center gap-3 px-4 py-3 text-muted-foreground"
      >
        <span className="sr-only" role="status">
          {label}
        </span>
        <span className="size-5 shrink-0 animate-pulse rounded bg-surface-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      </div>
    );
  }
  return (
    <div
      aria-busy="true"
      className="block rounded-lg border border-dashed border-border bg-surface"
    >
      <div className="flex aspect-video items-center justify-center rounded-t-lg border-b border-border bg-surface-muted">
        <span className="size-8 animate-pulse rounded bg-border" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-2 p-4">
        <span className="sr-only" role="status">
          {label}
        </span>
        <span aria-hidden="true" className="h-4 w-2/3 animate-pulse rounded bg-surface-muted" />
        <span aria-hidden="true" className="h-4 w-1/3 animate-pulse rounded bg-surface-muted" />
      </div>
    </div>
  );
}
