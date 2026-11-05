"use client";

/**
 * ChatSidebar — the chat-first studio's ChatGPT-style conversation rail.
 *
 * What lives here (and nowhere else):
 * - **New chat** — the pinned first action (the provider's `newThread`
 *   gesture via the surface's `onNewThread`; the hook's `refreshThreads`
 *   rides along on the surface).
 * - **Search** — client-side filter over the loaded thread titles (the
 *   bounded 30-thread list the hook already fetched; no wire call).
 * - **Date-grouped thread list** — Today / Yesterday / Previous 7 days /
 *   Previous 30 days / Older, newest first (the hook's order). The ACTIVE
 *   thread renders highlighted; switching mid-run stays disabled for the
 *   same reason the ThreadSwitcher is (a switch would cancel the live
 *   controller).
 * - **Open Engine** — the persistent second face CTA at the rail's foot.
 *
 * Layout contract: on `md+` the rail is a static flex column the surface
 * reserves width for; below `md` it is an off-canvas drawer over a backdrop
 * (the surface mounts it conditionally, so this component stays presentational).
 */

import type { Thread } from "@studio/contracts";
import { Clapperboard, MessageSquarePlus, Search, X } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";

export interface ChatSidebarProps {
  /** The project's threads, NEWEST first (the hook's list). */
  readonly threads: readonly Thread[];
  /** The live thread id (highlighted row); null = fresh/lazy thread. */
  readonly activeThreadId: string | null;
  /** Disabled while a run is live (a switch would cancel it). */
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onOpenThread: (threadId: string, title: string | null) => void;
  readonly onNewThread: () => void;
  /** The second face CTA (the mode flip the shell owns). */
  readonly onOpenEngine: () => void;
  /** Mobile drawer dismissal (no-op on desktop — the surface decides). */
  readonly onClose?: () => void;
  /** Custom scroll region instead of the page (drawer mode). */
  readonly variant?: "rail" | "drawer";
}

const UNTITLED = "Untitled chat";

/** Day-boundary grouping for the thread list (ChatGPT's buckets, UTC-safe). */
export function threadDateGroup(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Older";
  const startOfDay = (d: Date): number =>
    Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
  const days = startOfDay(now) - startOfDay(date);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

/** Pure search + group derivation (exported for tests). */
export function groupThreads(
  threads: readonly Thread[],
  query: string,
  now: Date,
): readonly { readonly label: string; readonly items: readonly Thread[] }[] {
  const q = query.trim().toLowerCase();
  const filtered =
    q === ""
      ? threads
      : threads.filter((thread) => (thread.title ?? UNTITLED).toLowerCase().includes(q));
  const buckets = new Map<string, Thread[]>();
  for (const thread of filtered) {
    const label = threadDateGroup(thread.updatedAt, now);
    const bucket = buckets.get(label);
    if (bucket === undefined) buckets.set(label, [thread]);
    else bucket.push(thread);
  }
  return GROUP_ORDER.filter((label) => buckets.has(label)).map((label) => ({
    label,
    items: buckets.get(label) ?? [],
  }));
}

export function ChatSidebar({
  threads,
  activeThreadId,
  disabled = false,
  loading = false,
  onOpenThread,
  onNewThread,
  onOpenEngine,
  onClose,
  variant = "rail",
}: ChatSidebarProps): ReactElement {
  const [query, setQuery] = useState("");
  // A stable "now" per mount keeps grouping deterministic in tests and
  // honest enough in product (a long-lived tab crossing midnight re-groups
  // on the next sidebar remount — chat-first remounts it on every open).
  const now = useMemo(() => new Date(), []);
  const groups = useMemo(() => groupThreads(threads, query, now), [threads, query, now]);

  const pickThread = (thread: Thread): void => {
    if (disabled) return;
    if (thread.id === activeThreadId) {
      onClose?.();
      return;
    }
    onOpenThread(thread.id, thread.title);
    onClose?.();
  };

  return (
    <div
      data-testid="studio-sidebar"
      data-variant={variant}
      className={`flex h-full flex-col bg-panel ${
        variant === "drawer" ? "w-72 border-r border-subtle shadow-modal" : "w-full"
      }`}
    >
      {/* -- header: brand row + close (drawer) ------------------------------ */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span
          aria-hidden="true"
          className="font-display text-body-m italic text-signal select-none"
        >
          ✦ studio
        </span>
        <span className="flex-1" />
        {variant === "drawer" && onClose !== undefined ? (
          <button
            type="button"
            aria-label="Close sidebar"
            data-testid="studio-sidebar-close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* -- New chat --------------------------------------------------------- */}
      <div className="px-3 pb-2">
        <button
          type="button"
          data-testid="studio-sidebar-new-chat"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onNewThread();
            onClose?.();
          }}
          className="flex h-9 w-full items-center gap-2 rounded-sm border border-subtle bg-elevated px-2.5 text-label text-primary duration-120 ease-out hover:border-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MessageSquarePlus
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-signal"
          />
          New chat
          <span className="ml-auto text-caption text-muted" aria-hidden="true">
            ⌘⇧O
          </span>
        </button>
      </div>

      {/* -- Search ----------------------------------------------------------- */}
      <div className="px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-sm bg-input px-2.5">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            data-testid="studio-sidebar-search"
            className="min-w-0 flex-1 bg-transparent text-body-s text-primary outline-none placeholder:text-muted"
          />
          {query !== "" ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="shrink-0 text-muted duration-120 ease-out hover:text-primary"
            >
              <X size={13} strokeWidth={1.9} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {/* -- Thread list (date-grouped) --------------------------------------- */}
      <div
        data-testid="studio-thread-list"
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {loading ? (
          <p data-testid="studio-sidebar-loading" className="px-2 py-1 text-caption text-muted">
            Loading chats…
          </p>
        ) : null}
        {!loading && groups.length === 0 ? (
          <p className="px-2 py-1 text-caption text-muted">
            {query === "" ? "No past chats yet." : "No chats match."}
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.label} className="mb-1">
            <h3 className="px-2 pt-2 pb-1 text-hint text-muted uppercase tracking-wide">
              {group.label}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((thread) => {
                const active = thread.id === activeThreadId;
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      data-testid="studio-thread-row"
                      data-thread-id={thread.id}
                      aria-current={active ? "true" : undefined}
                      disabled={disabled && !active}
                      onClick={() => pickThread(thread)}
                      className={`flex h-9 w-full items-center rounded-sm px-2 text-left text-body-s duration-120 ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                        active
                          ? "bg-elevated text-primary"
                          : "text-secondary hover:bg-elevated hover:text-primary"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {thread.title !== null && thread.title !== "" ? thread.title : UNTITLED}
                      </span>
                      {active ? (
                        <span
                          aria-hidden="true"
                          className="ml-2 h-1.5 w-1.5 shrink-0 rounded-pill bg-signal"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {/* -- foot: the second face -------------------------------------------- */}
      <div className="shrink-0 border-t border-subtle p-2">
        <button
          type="button"
          data-testid="studio-sidebar-open-engine"
          onClick={onOpenEngine}
          className="flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-label text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary"
        >
          <Clapperboard
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-signal"
          />
          Open Engine
          <span className="ml-auto text-caption text-muted" aria-hidden="true">
            →
          </span>
        </button>
      </div>
    </div>
  );
}
