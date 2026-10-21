"use client";

// Component library shell (W8-J) — the reusable, variable-driven pieces
// (§8): search + tag chips over `GET /v1/components`, §8.3 cards, "Manifest"
// → the full §8.2 inspect modal, and "Place in document" → the document
// picker modal stub (the real picker lands with the editor shell wave).

import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Input } from "@studio/ui";
import { Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ComponentCardView } from "./component-card";
import { GalleryEmpty, GalleryError, GallerySkeleton } from "./gallery-state";
import { ManifestModal } from "./manifest-modal";
import { TagFilter } from "./tag-filter";
import {
  collectTagCounts,
  DEFAULT_TAG_CHIP_LIMIT,
  useComponentCards,
  useDebouncedValue,
  type ComponentCard,
  type ManifestTarget,
} from "./use-catalog";

const SEARCH_DEBOUNCE_MS = 300;

export function ComponentGallery() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [selectedTags, setSelectedTags] = useState<readonly string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<ManifestTarget | null>(null);
  const [pickerTarget, setPickerTarget] = useState<ComponentCard | null>(null);

  const filteredSearch = debouncedSearch.trim();
  const filterActive = selectedTags.length > 0 || filteredSearch.length > 0;

  const allComponents = useComponentCards();
  const components = useComponentCards(
    filterActive ? { tags: selectedTags, query: filteredSearch } : undefined,
  );

  const tagCounts = useMemo(
    () =>
      collectTagCounts(allComponents.data?.components ?? [], {
        limit: DEFAULT_TAG_CHIP_LIMIT,
        alwaysInclude: selectedTags,
      }),
    [allComponents.data, selectedTags],
  );

  function toggleTag(tag: string): void {
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((candidate) => candidate !== tag)
        : [...current, tag],
    );
  }

  function openManifest(card: ComponentCard): void {
    setInspectTarget({ kind: "component", id: card.id, version: card.version });
    setModalOpen(true);
  }

  function clearFilters(): void {
    setSelectedTags([]);
    setSearch("");
  }

  const results = components.data?.components;
  const total = allComponents.data?.components.length;

  return (
    <section aria-labelledby="component-gallery-heading" className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 id="component-gallery-heading" className="text-2xl font-semibold tracking-tight">
          Component library
        </h1>
        <p className="text-sm text-muted-foreground">
          Variable-driven pieces you can place in any document — the placed instance stays
          fully editable.
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
            placeholder="Search id or name"
            aria-label="Search components"
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

      {components.isPending ? (
        <GallerySkeleton label="Loading components" />
      ) : components.isError ? (
        <GalleryError error={components.error} onRetry={() => void components.refetch()} />
      ) : results === undefined || results.length === 0 ? (
        <GalleryEmpty
          title={
            filterActive
              ? "No components match the current filters."
              : "No components are published yet."
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
              ? `${results.length} of ${total} components match`
              : `${results.length} components`}
          </p>
          <div
            className={components.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((card) => (
                <ComponentCardView
                  key={card.ref}
                  card={card}
                  onPlace={setPickerTarget}
                  onInspect={openManifest}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <Link href="/templates" className="text-sm text-accent underline-offset-4 hover:underline">
        Browse the template gallery →
      </Link>

      <ManifestModal open={modalOpen} target={inspectTarget} onOpenChange={setModalOpen} />

      {/*
        Document picker stub (W8-J placeholder): the real picker lists the
        workspace's documents and calls the editor's component.place flow.
        TODO(W8 editor wave): wire the documents list + placement here.
      */}
      <Dialog
        open={pickerTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPickerTarget(null);
          }
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="max-w-md bg-surface text-foreground"
        >
          <DialogTitle>
            {`Place “${pickerTarget?.name ?? "component"}” in a document`}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Choose the document that receives the component. The placed instance is a fresh
            copy of the master and stays fully editable.
          </p>
          <div className="rounded-md border border-dashed border-border bg-surface-muted p-4 text-sm text-muted-foreground">
            Your workspace documents will be listed here once the editor shell wires the
            documents list — this picker is the flow placeholder.
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-border bg-surface hover:bg-surface-muted"
              onClick={() => setPickerTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled
              title="Placement lands with the editor shell"
              className="bg-accent text-accent-foreground"
            >
              Place
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
