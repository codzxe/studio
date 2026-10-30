"use client";

/**
 * ThreadSwitcher — ROUND 12 "Chat UI v3" (docs/research/round12-design.md
 * "History on reload + thread switcher (list/create/switch)").
 *
 * Pure PRESENTATION dropdown: rows come in as props (the slot's
 * useThreadHistory list), switching goes out through `onOpenThread`
 * (the hook's `adoptThread` → the provider's `openThread` — the host page
 * owns controller recreation), and "New chat" rides the existing
 * `newThread` gesture through `onNewThread`. Disabled while a run streams:
 * switching mid-run would cancel the live controller (dispose on the
 * provider's thread effect) — the affordance waits.
 */

import type { Thread } from "@studio/contracts";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from "@studio/ui";
import { ChevronDown, MessageSquarePlus } from "lucide-react";
import type { ReactElement } from "react";

export interface ThreadSwitcherProps {
  /** The project's threads, NEWEST first (the hook's list). */
  readonly threads: readonly Thread[];
  /** The live thread id (highlighted row); null = fresh/lazy thread. */
  readonly activeThreadId: string | null;
  /** Disabled while a run is live (the switch would cancel it). */
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onOpenThread: (threadId: string, title: string | null) => void;
  readonly onNewThread: () => void;
}

/** Compact "3 days ago"-style label (never relative to a hidden clock). */
function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const UNTITLED = "Untitled chat";

export function threadSwitcherLabel(
  threads: readonly Thread[],
  activeThreadId: string | null,
  fallback: string,
): string {
  if (activeThreadId === null) return fallback;
  const active = threads.find((thread) => thread.id === activeThreadId);
  return active?.title ?? fallback;
}

export function ThreadSwitcher({
  threads,
  activeThreadId,
  disabled = false,
  loading = false,
  onOpenThread,
  onNewThread,
}: ThreadSwitcherProps): ReactElement {
  const label = threadSwitcherLabel(threads, activeThreadId, UNTITLED);
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 max-w-44 shrink-0 gap-1 px-1.5 text-secondary hover:text-primary"
          aria-label="Switch chat thread"
          data-testid="chat-thread-switcher"
          disabled={disabled}
        >
          <span className="truncate text-caption">{label}</span>
          <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        </Button>
      </MenuTrigger>
      <MenuContent align="start" data-testid="chat-thread-menu">
        {loading ? (
          <div data-testid="chat-thread-menu-loading" className="px-2 py-1 text-caption text-muted">
            Loading chats…
          </div>
        ) : null}
        {threads.length === 0 && !loading ? (
          <div className="px-2 py-1 text-caption text-muted">No past chats yet.</div>
        ) : null}
        {threads.map((thread) => {
          const active = thread.id === activeThreadId;
          const date = dateLabel(thread.updatedAt);
          return (
            <MenuItem
              key={thread.id}
              data-testid="chat-thread-option"
              data-thread-id={thread.id}
              aria-current={active ? "true" : undefined}
              onSelect={() => {
                if (!active) onOpenThread(thread.id, thread.title);
              }}
              className={active ? "text-primary" : undefined}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {thread.title !== null && thread.title !== "" ? thread.title : UNTITLED}
                </span>
                {date !== "" ? (
                  <span className="shrink-0 text-caption text-muted">{date}</span>
                ) : null}
              </span>
            </MenuItem>
          );
        })}
        <MenuItem
          data-testid="chat-thread-new"
          onSelect={() => onNewThread()}
          className="border-t border-border"
        >
          <MessageSquarePlus size={13} strokeWidth={1.75} aria-hidden="true" className="mr-1" />
          New chat
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
