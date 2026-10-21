"use client";

// apps/web — document overview (W8-C): meta bar (name, revision, created)
// above the editor surface. The editor itself is the W8-F placeholder
// (document-editor.tsx — see the frozen CONTRACT note there); this component
// owns the document fetch (useDocument), its loading skeleton and the §13.3
// error envelope with a retry.
//
// Shell contract (W8-A): no layout assumptions — see documents-library.tsx.

import { Badge, Button, Skeleton } from "@studio/ui";
import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { formatDocumentDate } from "./document-card";
import { DocumentEditor } from "./document-editor";
import { toErrorEnvelope, useDocument } from "./use-documents";

export interface DocumentOverviewProps {
  /** Route id (already validated non-empty by the server page). */
  readonly documentId: string;
}

export function DocumentOverview({ documentId }: DocumentOverviewProps) {
  const { document, isLoading, error, refetch, isRefetching } = useDocument(documentId);

  if (isLoading) {
    return <OverviewSkeleton />;
  }

  if (document === null) {
    const envelope = toErrorEnvelope(error);
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6"
      >
        <p className="font-medium">Couldn&apos;t open this document</p>
        <p className="text-sm text-muted-foreground">{envelope.message}</p>
        <p className="text-xs text-muted-foreground">
          {envelope.hint === undefined
            ? `Code: ${envelope.code}`
            : `${envelope.hint} (code ${envelope.code})`}
        </p>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" className="border-border">
            <Link href="/documents">Back to documents</Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void refetch();
            }}
            disabled={isRefetching}
            aria-busy={isRefetching}
            className="border-border"
          >
            <RefreshCw aria-hidden="true" className={isRefetching ? "animate-spin" : undefined} />
            {isRefetching ? "Retrying…" : "Try again"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div>
          <Link
            href="/documents"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            All documents
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="document-heading" className="truncate text-2xl font-semibold tracking-tight">
            {document.name}
          </h1>
          <Badge variant="outline">Revision {document.current_revision}</Badge>
          <Badge variant="outline">
            {document.width_px} × {document.height_px} px
          </Badge>
          {document.template_id === null ? null : (
            <Badge variant="outline">{document.template_id}</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Created {formatDocumentDate(document.created_at)}
          {document.latest_version === null
            ? ""
            : ` — current version “${document.latest_version.label}”`}
        </p>
      </header>

      {/* Editor surface — W8-F placeholder contract (document-editor.tsx). */}
      <DocumentEditor documentId={documentId} document={document} />
    </div>
  );
}

/** Meta bar + canvas skeletons (polite status via <output>, not raw pulses). */
function OverviewSkeleton() {
  return (
    <output aria-label="Opening document" className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24 bg-surface-muted" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-64 bg-surface-muted" />
          <Skeleton className="h-5 w-24 bg-surface-muted" />
        </div>
        <Skeleton className="h-4 w-48 bg-surface-muted" />
      </div>
      <Skeleton className="min-h-96 w-full rounded-lg bg-surface-muted" />
    </output>
  );
}
