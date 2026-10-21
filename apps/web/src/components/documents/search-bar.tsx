"use client";

// apps/web — documents search bar (W8-C). Client-side placeholder filter
// control: typing filters the already-loaded documents (documents-library.tsx)
// and mirrors the value into the `?q=` URL param for shareable/bookmarkable
// state. The gateway list endpoint has no server-side `q` yet (strict schema,
// routes/documents.ts); when it grows one, this control keeps its debounced
// URL write and the library swaps the local filter for a server query.

import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button, Input, Label } from "@studio/ui";

export interface SearchBarProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Announced politely to assistive tech (the visible match count). */
  readonly resultCount?: number;
  readonly placeholder?: string;
  readonly className?: string;
}

export function SearchBar({
  query,
  onQueryChange,
  resultCount,
  placeholder = "Search documents by name or template",
  className,
}: SearchBarProps) {
  // One local id (label ↔ input); no error/description wiring is needed, so
  // useFieldIds() would be overkill — the id is made SSR-stable via useId.
  const uid = useId().replaceAll(":", "");
  const inputId = `documents-search-${uid}`;
  const statusId = `documents-search-status-${uid}`;

  // Local keystroke state; debounced (200 ms) before notifying the parent so
  // URL writes + list filtering don't run on every keypress.
  const [value, setValue] = useState(query);
  useEffect(() => setValue(query), [query]);
  useEffect(() => {
    if (value === query) {
      return;
    }
    const timer = setTimeout(() => onQueryChange(value), 200);
    return () => clearTimeout(timer);
  }, [value, query, onQueryChange]);

  return (
    <div className={className}>
      <Label htmlFor={inputId} className="sr-only">
        Search documents
      </Label>
      <div className="relative flex items-center">
        <Input
          id={inputId}
          type="search"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value !== "") {
              event.preventDefault();
              setValue("");
              onQueryChange("");
            }
          }}
          placeholder={placeholder}
          aria-describedby={resultCount === undefined ? undefined : statusId}
          className="w-full sm:w-72 border-border bg-surface"
        />
        {value === "" ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear search"
            onClick={() => {
              setValue("");
              onQueryChange("");
            }}
            className="absolute right-1 size-7 text-muted-foreground"
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {/* Polite announcement: the match count updates as the query changes. */}
      {resultCount === undefined ? null : (
        <span id={statusId} role="status" className="sr-only">
          {resultCount} matching document{resultCount === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}
