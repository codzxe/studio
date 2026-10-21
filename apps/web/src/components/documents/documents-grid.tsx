"use client";

// apps/web — documents grid/list renderer (W8-C). Presentational container:
// loading skeletons, error envelope, empty states and the load-more control;
// rows/cards come from document-card.tsx. All data plumbing lives in
// documents-library.tsx (useDocuments + optimistic create wiring).

import { Plus, RefreshCw } from "lucide-react";
import { Button, Skeleton } from "@studio/ui";
import { matchesQuery } from "./document-sizes";
import { DocumentCard } from "./document-card";
import { toErrorEnvelope, type DocumentDto } from "./use-documents";

export interface DocumentsGridProps {
  /** Every loaded document (all pages), unfiltered. */
  readonly documents: readonly DocumentDto[];
  /** First-page load in flight (skeletons). */
  readonly isLoading: boolean;
  /** Latest list error, if any (displayed as a §13.3 envelope). */
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  /** Active client-side search query. */
  readonly query: string;
  readonly view: "grid" | "list";
  /** Empty-state CTA — opens the create modal. */
  readonly onCreate: () => void;
  readonly onClearSearch: () => void;
  readonly hasNextPage: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
}

export function DocumentsGrid({
  documents,
  isLoading,
  error,
  onRetry,
  retrying,
  query,
  view,
  onCreate,
  onClearSearch,
  hasNextPage,
  loadingMore,
  onLoadMore,
}: DocumentsGridProps) {
  if (isLoading) {
    return <GridSkeleton view={view} />;
  }

  if (error !== null) {
    return <GridError envelope={toErrorEnvelope(error)} onRetry={onRetry} retrying={retrying} />;
  }

  // Client-side placeholder filter (see search-bar.tsx header).
  const visible =
    query.trim() === ""
      ? documents
      : documents.filter((document) => matchesQuery(query, document.name, document.template_id));

  if (visible.length === 0) {
    return (
      <GridEmpty
        hasAny={documents.length > 0}
        query={query}
        onCreate={onCreate}
        onClearSearch={onClearSearch}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {view === "grid" ? (
        <ul className="grid list-none gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((document) => (
            <li key={document.id}>
              <DocumentCard document={document} variant="grid" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="list-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {visible.map((document) => (
            <li key={document.id}>
              <DocumentCard document={document} variant="row" />
            </li>
          ))}
        </ul>
      )}
      {hasNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => onLoadMore()}
            disabled={loadingMore}
            aria-busy={loadingMore}
            className="border-border"
          >
            <RefreshCw aria-hidden="true" className={loadingMore ? "animate-spin" : undefined} />
            {loadingMore ? "Loading…" : "Load more documents"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** First-page loading skeleton + polite screen-reader status. */
function GridSkeleton({ view }: { readonly view: "grid" | "list" }) {
  const count = view === "grid" ? 8 : 5;
  return (
    <div role="status" aria-label="Loading documents">
      {view === "grid" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="rounded-lg border border-border bg-surface">
              <Skeleton className="aspect-video w-full rounded-b-none bg-surface-muted" />
              <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-4 w-2/3 bg-surface-muted" />
                <Skeleton className="h-4 w-1/3 bg-surface-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Skeleton className="size-5 bg-surface-muted" />
              <Skeleton className="h-4 flex-1 bg-surface-muted" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Error state — displays the flat error envelope (code + message + hint) per
 * docs/AGENTS.md / §13.3; retry is offered for retryable envelopes (network,
 * 5xx, 429) and harmless for the rest.
 */
function GridError({
  envelope,
  onRetry,
  retrying,
}: {
  readonly envelope: ReturnType<typeof toErrorEnvelope>;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6"
    >
      <p className="font-medium">Couldn&apos;t load your documents</p>
      <p className="text-sm text-muted-foreground">{envelope.message}</p>
      <p className="text-xs text-muted-foreground">
        {envelope.hint === undefined ? `Code: ${envelope.code}` : `${envelope.hint} (code ${envelope.code})`}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => onRetry()}
        disabled={retrying}
        aria-busy={retrying}
        className="border-border"
      >
        <RefreshCw aria-hidden="true" className={retrying ? "animate-spin" : undefined} />
        {retrying ? "Retrying…" : "Try again"}
      </Button>
    </div>
  );
}

/** Empty states: never created anything vs. no search matches. */
function GridEmpty({
  hasAny,
  query,
  onCreate,
  onClearSearch,
}: {
  readonly hasAny: boolean;
  readonly query: string;
  readonly onCreate: () => void;
  readonly onClearSearch: () => void;
}) {
  if (hasAny) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border bg-surface p-8">
        <p className="font-medium">No documents match your search</p>
        <p className="text-sm text-muted-foreground">
          Nothing matches “{query.trim()}”. Try a different name or template.
        </p>
        <Button type="button" variant="outline" onClick={() => onClearSearch()} className="border-border">
          Clear search
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border bg-surface p-12 text-center">
      <p className="text-lg font-medium">No documents yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Create your first document — pick a canvas size preset or enter custom dimensions, then
        let the agent design it with you.
      </p>
      <Button type="button" onClick={() => onCreate()} className="bg-accent text-accent-foreground hover:opacity-90">
        <Plus aria-hidden="true" />
        New document
      </Button>
    </div>
  );
}
