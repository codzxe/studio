"use client";

// Tag filter chips (W8-J) — multi-select with AND semantics: a card matches
// when it carries EVERY selected tag (§7.4 `template.list`, W4-J route).
// Chips are real toggle buttons so keyboard and screen-reader users get the
// selection state via aria-pressed, and selected chips always stay visible
// (collectTagCounts pins them past the limit).

import { cn } from "@studio/ui";
import type { TagCount } from "./use-catalog";

export interface TagFilterProps {
  readonly available: readonly TagCount[];
  /** Currently selected tags (lowercase, from the chip values). */
  readonly selected: readonly string[];
  readonly onToggle: (tag: string) => void;
  readonly onClear: () => void;
}

export function TagFilter({ available, selected, onToggle, onClear }: TagFilterProps) {
  if (available.length === 0) {
    return null;
  }
  const selectedSet = new Set(selected);
  return (
    <div role="group" aria-label="Filter by tag" className="flex flex-wrap items-center gap-1.5">
      {available.map((entry) => {
        const active = selectedSet.has(entry.tag);
        return (
          <button
            key={entry.tag}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(entry.tag)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              active
                ? "border-transparent bg-accent text-accent-foreground"
                : "border-border bg-surface text-muted-foreground hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {entry.tag}
            <span className={active ? "text-[10px] opacity-80" : "text-[10px] opacity-60"}>
              {entry.count}
            </span>
          </button>
        );
      })}
      {selected.length > 0 ? (
        <button
          type="button"
          onClick={onClear}
          className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
