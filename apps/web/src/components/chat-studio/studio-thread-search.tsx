"use client";

/**
 * StudioThreadSearch — the in-conversation search bar for the chat-first
 * studio (the ChatGPT-style "find in thread" floating pill over the
 * transcript).
 *
 * Division of labor (the presentational contract):
 * - **The parent owns the query.** It feeds the pure `findMatches` helper
 *   below and passes the RESULT ids down as `messageIds` (thread order).
 *   Typing does nothing inside this component — it never filters, fetches,
 *   or stores the query text.
 * - **This component owns the moving match index.** Prev/next step through
 *   `messageIds` with wrap-around and report each landing spot through
 *   `onJump(messageId)`; the index resets when the bar (re)opens or the
 *   result count changes. A fresh result set starts "before the first
 *   match", so the first `next` lands on match 1 and the first `prev`
 *   wraps to the last — every match is reachable from a fresh open.
 *
 * Chrome: a compact absolute-positioned pill (the parent supplies the
 * positioning context — the surface root is `relative`), Escape or the ✕
 * closes it. No results disables stepping; the counter swaps to "No matches".
 */

import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from "react";

/** The minimal message shape `findMatches` needs (any richer message fits). */
export interface SearchableMessage {
  readonly id: string;
  readonly text: string;
}

/**
 * Pure in-thread matcher: case-insensitive substring match on `text`,
 * returning matching message ids in thread order (an id repeats in the
 * thread → it appears once). An empty or whitespace-only query matches
 * nothing.
 */
export function findMatches(
  messages: readonly SearchableMessage[],
  query: string,
): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const message of messages) {
    if (!message.text.toLowerCase().includes(q)) continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    matches.push(message.id);
  }
  return matches;
}

export interface StudioThreadSearchProps {
  /** Whether the floating bar is shown (the surface owns open state). */
  readonly open: boolean;
  /** Escape or the ✕ affordance — the surface hides/unmounts the bar. */
  readonly onClose: () => void;
  /** Matched message ids in thread order (the parent's `findMatches` output). */
  readonly messageIds: readonly string[];
  /** Prev/next landing report — the surface scrolls to this message. */
  readonly onJump: (messageId: string) => void;
  /**
   * Optional query echo (integration seam): the input stays uncontrolled,
   * but the surface needs the text to run `findMatches` and feed
   * `messageIds` back down. Absent ⇒ identical presentational behavior.
   */
  readonly onQueryChange?: (query: string) => void;
}

export function StudioThreadSearch({
  open,
  onClose,
  messageIds,
  onJump,
  onQueryChange,
}: StudioThreadSearchProps): ReactElement | null {
  // The moving match index. -1 = "before the first match" (a fresh result
  // set): the first `next` lands on match 1, the first `prev` wraps to the
  // last. Reset when the bar reopens or the result count changes.
  const [index, setIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultCount = messageIds.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: resultCount is the deliberate reset trigger (fresh result set → restart "before the first match"); the body reads only `open`
  useEffect(() => {
    if (open) setIndex(-1);
  }, [open, resultCount]);

  // Autofocus on open (the input re-mounts on every reopen, but focus via
  // effect keeps the behavior explicit and jsdom-deterministic).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const step = (delta: 1 | -1): void => {
    if (resultCount === 0) return;
    // Clamp against a result set that shrank mid-render (the reset effect
    // lands right after; this keeps a click in that window sane).
    const current = index >= 0 && index < resultCount ? index : -1;
    const next =
      current < 0
        ? delta === 1
          ? 0
          : resultCount - 1
        : (current + delta + resultCount) % resultCount;
    setIndex(next);
    const target = messageIds[next];
    if (target !== undefined) onJump(target);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    // The bar owns Escape — don't double-close surface chrome underneath.
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      data-testid="studio-thread-search"
      onKeyDown={handleKeyDown}
      className="absolute top-3 left-1/2 z-30 flex h-10 -translate-x-1/2 animate-pop-in items-center gap-2 rounded-pill border border-subtle bg-panel px-3 shadow-pop"
    >
      <Search size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        aria-label="Search in conversation"
        placeholder="Search"
        data-testid="studio-thread-search-input"
        onChange={(event) => onQueryChange?.(event.target.value)}
        className="w-36 bg-transparent text-body-s text-primary outline-none placeholder:text-muted"
      />
      <span
        data-testid="studio-thread-search-count"
        aria-live="polite"
        className="shrink-0 whitespace-nowrap text-caption text-muted"
      >
        {resultCount === 0
          ? "No matches"
          : `${resultCount} ${resultCount === 1 ? "result" : "results"}`}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        data-testid="studio-thread-search-prev"
        disabled={resultCount === 0}
        onClick={() => step(-1)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        data-testid="studio-thread-search-next"
        disabled={resultCount === 0}
        onClick={() => step(1)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Close search"
        data-testid="studio-thread-search-close"
        onClick={onClose}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-muted duration-120 ease-out hover:bg-elevated hover:text-primary"
      >
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
