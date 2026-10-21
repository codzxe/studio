"use client";

// Template gallery shell (W8-J) — the in-app §16.2 template gallery:
// search + tag chips (AND semantics, §7.4) over `GET /v1/templates`, §7.4
// cards, "Use template" → compose preselect (`?template=id@version`,
// W8-D contract) and "Manifest" → the full inspect modal.
//
// Two observers over one endpoint: the unfiltered query feeds the tag chips;
// the filtered query drives the grid. When no filter is active both share
// one react-query cache entry (buildCatalogSearchParams normalizes the key),
// so chips and grid cost a single fetch.

import { Button, Input } from "@studio/ui";
import { Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { GalleryEmpty, GalleryError, GallerySkeleton } from "./gallery-state";
import { ManifestModal } from "./manifest-modal";
import { TagFilter } from "./tag-filter";
import { TemplateCardView } from "./template-card";
import {
  collectTagCounts,
  composeHref,
  DEFAULT_TAG_CHIP_LIMIT,
  useDebouncedValue,
  useTemplateCards,
  type ManifestTarget,
  type TemplateCard,
} from "./use-catalog";

/** One search input → one endpoint hit: the wire param is debounced. */
const SEARCH_DEBOUNCE_MS = 300;

export function TemplateGallery() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [selectedTags, setSelectedTags] = useState<readonly string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<ManifestTarget | null>(null);

  const filteredSearch = debouncedSearch.trim();
  const filterActive = selectedTags.length > 0 || filteredSearch.length > 0;

  const allCards = useTemplateCards();
  const cards = useTemplateCards(
    filterActive ? { tags: selectedTags, query: filteredSearch } : undefined,
  );

  const tagCounts = useMemo(
    () =>
      collectTagCounts(allCards.data?.templates ?? [], {
        limit: DEFAULT_TAG_CHIP_LIMIT,
        alwaysInclude: selectedTags,
      }),
    [allCards.data, selectedTags],
  );

  function toggleTag(tag: string): void {
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((candidate) => candidate !== tag)
        : [...current, tag],
    );
  }

  function openManifest(card: TemplateCard): void {
    setInspectTarget({ kind: "template", id: card.id, version: card.version });
    setModalOpen(true);
  }

  function clearFilters(): void {
    setSelectedTags([]);
    setSearch("");
  }

  // W8-D contract: compose preselects the pinned template via
  // `?template=id@version`. A full page load is deliberate — the compose
  // shell is a fresh session — and typedRoutes (next.config.ts) rejects
  // hrefs for routes that do not exist at build time, so window.location
  // keeps this decoupled from the compose wave. TODO(W8-D): typed <Link>.
  function startCompose(card: TemplateCard): void {
    window.location.assign(composeHref(card.ref));
  }

  const results = cards.data?.templates;
  const total = allCards.data?.templates.length;

  return (
    <section aria-labelledby="template-gallery-heading" className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 id="template-gallery-heading" className="text-2xl font-semibold tracking-tight">
          Templates
        </h1>
        <p className="text-sm text-muted-foreground">
          Pick a structured starting point — the agent fills the named slots and keeps every
          layer editable.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative max-w-sm">
          <Search
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search id, name or description"
            aria-label="Search templates"
            className="border-border pl-8"
          />
        </div>
        <TagFilter
          available={tagCounts}
          selected={selectedTags}
          onToggle={toggleTag}
          onClear={() => setSelectedTags([])}
        />
      </div>

      {cards.isPending ? (
        <GallerySkeleton label="Loading templates" />
      ) : cards.isError ? (
        <GalleryError error={cards.error} onRetry={() => void cards.refetch()} />
      ) : results === undefined || results.length === 0 ? (
        <GalleryEmpty
          title={
            filterActive
              ? "No templates match the current filters."
              : "No templates are published yet."
          }
          hint={filterActive ? "Try clearing a tag or changing the search." : undefined}
          action={
            filterActive ? (
              <Button
                variant="outline"
                className="border-border bg-surface hover:bg-surface-muted"
                onClick={clearFilters}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {filterActive && total !== undefined
              ? `${results.length} of ${total} templates match`
              : `${results.length} templates`}
          </p>
          <div
            className={cards.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((card) => (
                <TemplateCardView
                  key={card.ref}
                  card={card}
                  onUse={startCompose}
                  onInspect={openManifest}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <Link
        href="/components-gallery"
        className="text-sm text-accent underline-offset-4 hover:underline"
      >
        Browse the component library →
      </Link>

      <ManifestModal open={modalOpen} target={inspectTarget} onOpenChange={setModalOpen} />
    </section>
  );
}
