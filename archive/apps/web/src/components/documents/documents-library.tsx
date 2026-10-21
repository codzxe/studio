"use client";

// apps/web — documents library composition (W8-C). Client boundary under the
// server page apps/web/src/app/(app)/documents/page.tsx, which seeds the
// `?q=` server query param (§13.1 list endpoint has no server-side `q` yet —
// routes/documents.ts schema is strict over cursor/limit/include_archived —
// so filtering is a client-side placeholder, mirrored into the URL for
// shareable state via history.replaceState: no navigation, no keystroke churn).
//
// Layout contract with the (app) shell (W8-A, parallel): this component makes
// NO assumptions about the route group layout — it renders a page container
// that works under the root layout today and inside the app shell later, and
// it owns its own <h1> (id below). The create modal, grid/list toggle and
// empty state live here; the editor route (W8-F placeholder) is a link away.
//
// TOKEN NOTE (shell owner — W8-A / theme wave): apps/web's Tailwind v4
// @theme (globals.css) maps a SUBSET of the @studio/ui token names
// (surface/surface-muted/border/accent/accent-foreground/muted-foreground/
// ring only) — the kit's own classes (bg-primary, bg-card, bg-muted,
// border-input, text-destructive…) currently generate nothing. These
// components therefore pass explicit app-token overrides (className=
// "bg-surface", "border-border", …) wherever the kit's defaults are dead
// (tailwind-merge lets the override win). Bridging the full kit token set
// into the app's @theme (or shipping a v4-native tokens.css) makes those
// overrides redundant without breaking anything here.

import { Button } from "@studio/ui";
import { LayoutGrid, List, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CreateDocumentModal } from "./create-document-modal";
import { DEFAULT_PLAN_CEILING_MP, matchesQuery } from "./document-sizes";
import { DocumentsGrid } from "./documents-grid";
import { SearchBar } from "./search-bar";
import { useDocuments } from "./use-documents";

export interface DocumentsLibraryProps {
  /** `?q=` from the server page — initial search box value. */
  readonly initialQuery?: string;
  /**
   * Plan canvas ceiling (MP) for the create modal's client-side validation.
   * The shell should pass the workspace's real plan once `GET /v1/me`
   * (contract-only) ships; until then the starter floor applies.
   */
  readonly planMaxMegapixels?: number;
}

type ViewMode = "grid" | "list";

export function DocumentsLibrary({
  initialQuery = "",
  planMaxMegapixels = DEFAULT_PLAN_CEILING_MP,
}: DocumentsLibraryProps) {
  const [query, setQuery] = useState(initialQuery);
  const [view, setView] = useState<ViewMode>("grid");
  const [createOpen, setCreateOpen] = useState(false);

  // Mirror the debounced query into the URL (?q=) without a navigation —
  // replaceState keeps the entry shareable/bookmarkable and the server page
  // re-seeds it on hard loads.
  useEffect(() => {
    const timer = setTimeout(() => {
      const url = query === "" ? "/documents" : `/documents?q=${encodeURIComponent(query)}`;
      window.history.replaceState(window.history.state, "", url);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useDocuments();

  // All loaded pages flattened; the grid applies the client-side filter.
  const documents = useMemo(
    () => (list.data === undefined ? [] : list.data.pages.flatMap((page) => page.documents)),
    [list.data],
  );
  const visibleCount = useMemo(
    () =>
      documents.filter((document) => matchesQuery(query, document.name, document.template_id))
        .length,
    [documents, query],
  );

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 id="documents-heading" className="text-2xl font-semibold tracking-tight">
              Documents
            </h1>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {visibleCount} document{visibleCount === 1 ? "" : "s"}
              {list.hasNextPage ? " or more" : ""} in this workspace
            </p>
          </div>
          <Button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="bg-accent text-accent-foreground hover:opacity-90"
          >
            <Plus aria-hidden="true" />
            New document
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchBar query={query} onQueryChange={setQuery} resultCount={visibleCount} />
          {/* Grid/list toggle — icon-only buttons carry aria-label (a11y kit law). */}
          <fieldset
            aria-label="Document view"
            className="flex items-center gap-1 rounded-md border border-border bg-surface p-1"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
              className={view === "grid" ? "bg-surface-muted" : undefined}
            >
              <LayoutGrid aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              className={view === "list" ? "bg-surface-muted" : undefined}
            >
              <List aria-hidden="true" />
            </Button>
          </fieldset>
        </div>
      </header>

      <DocumentsGrid
        documents={documents}
        isLoading={list.isPending}
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
        retrying={list.isRefetching}
        query={query}
        view={view}
        onCreate={() => setCreateOpen(true)}
        onClearSearch={() => setQuery("")}
        hasNextPage={list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => {
          void list.fetchNextPage();
        }}
      />

      <CreateDocumentModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        planMaxMegapixels={planMaxMegapixels}
      />
    </div>
  );
}
