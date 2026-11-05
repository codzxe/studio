"use client";

/**
 * StudioModeBar — the slim persistent bar for the chat-first studio route
 * (`/w/[slug]`). It is the ONE place the two modes meet:
 *
 * - **Chat** (default): the full-page ChatGPT-style surface. No engine chrome
 *   is visible — the engine mounts live but HIDDEN underneath (the agent's
 *   tool bridge needs it; the user never sees it).
 * - **Engine**: the classic full editor (EditorHost — canvas, timeline,
 *   docked sidebar chat) takes over the surface below this bar.
 *
 * The bar sits OUTSIDE the editor surface (D-18 discipline: the editor only
 * ever sees a viewport resize; nothing restyles the iframe), so switching
 * modes never remounts the engine session: one boot, one lease, continuous
 * state in both directions.
 *
 * ChatGPT-class chrome (optional props — the original shell contract is
 * unchanged when they are absent): a sidebar toggle, the live conversation
 * title, the model picker slot, and a New-chat gesture. They render only
 * while `mode === "chat"` (in Engine mode the editor's own chrome rules).
 */

import { MessageSquarePlus, PanelLeft, Search, Settings } from "lucide-react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

export type StudioMode = "chat" | "engine";

export interface StudioModeBarProps {
  readonly projectName: string;
  readonly projectSlug: string;
  readonly mode: StudioMode;
  readonly onModeChange: (mode: StudioMode) => void;
  /** Chat chrome: the sidebar visibility toggle (rail on md+, drawer below). */
  readonly onToggleSidebar?: () => void;
  /** Chat chrome: the live conversation title (null = a fresh chat). */
  readonly threadTitle?: string | null;
  /** Chat chrome: the New-chat gesture (⌘⇧O shares it). */
  readonly onNewChat?: () => void;
  /** Chat chrome: the model picker slot (right-aligned before the switch). */
  readonly modelPicker?: ReactNode;
  /** Chat chrome: opens the in-conversation search bar. */
  readonly onOpenSearch?: () => void;
  /** Chat chrome: opens the settings popover. */
  readonly onOpenSettings?: () => void;
}

const MODES: readonly { readonly id: StudioMode; readonly label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "engine", label: "Engine" },
];

export function StudioModeBar({
  projectName,
  projectSlug,
  mode,
  onModeChange,
  onToggleSidebar,
  threadTitle,
  onNewChat,
  modelPicker,
  onOpenSearch,
  onOpenSettings,
}: StudioModeBarProps): ReactElement {
  const chatChrome = mode === "chat";
  const title =
    chatChrome && threadTitle !== null && threadTitle !== "" && threadTitle !== undefined
      ? threadTitle
      : projectName;

  return (
    <div
      data-testid="studio-mode-bar"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle bg-page px-3 sm:px-4"
    >
      {chatChrome && onToggleSidebar !== undefined ? (
        <button
          type="button"
          aria-label="Toggle sidebar"
          aria-pressed={false}
          data-testid="studio-sidebar-toggle"
          onClick={onToggleSidebar}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-panel hover:text-primary"
        >
          <PanelLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}

      <Link
        href="/w"
        aria-label="Back to dashboard"
        data-testid="studio-back-link"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-pill px-2 text-label text-secondary duration-120 ease-out hover:bg-panel hover:text-primary"
      >
        <span aria-hidden="true">←</span>
        <span className="hidden md:inline">Dashboard</span>
      </Link>

      <span
        className="min-w-0 truncate text-label font-medium text-primary"
        title={chatChrome && threadTitle ? threadTitle : undefined}
      >
        {title}
      </span>

      <div className="flex-1" />

      {chatChrome && modelPicker !== undefined ? (
        <div className="shrink-0">{modelPicker}</div>
      ) : null}

      {chatChrome && onOpenSearch !== undefined ? (
        <button
          type="button"
          aria-label="Search this conversation"
          title="Search this conversation"
          data-testid="studio-open-search"
          onClick={onOpenSearch}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-panel hover:text-primary"
        >
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}

      {chatChrome && onOpenSettings !== undefined ? (
        <button
          type="button"
          aria-label="Chat settings"
          title="Chat settings"
          data-testid="studio-open-settings"
          onClick={onOpenSettings}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-panel hover:text-primary"
        >
          <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}

      {chatChrome && onNewChat !== undefined ? (
        <button
          type="button"
          aria-label="New chat"
          title="New chat (⌘⇧O)"
          data-testid="studio-new-chat"
          onClick={onNewChat}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-panel hover:text-primary"
        >
          <MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}

      {/* The mode switch: Chat is the product's main surface; Engine is the
          full editor for hands-on work. aria-pressed carries the state. */}
      <div className="flex shrink-0 items-center rounded-pill border border-subtle bg-panel p-0.5">
        {MODES.map((entry) => {
          const active = mode === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              data-testid={`studio-mode-${entry.id}`}
              onClick={() => onModeChange(entry.id)}
              className={`flex h-7 items-center rounded-pill px-3.5 text-label duration-120 ease-out ${
                active ? "bg-signal text-signal-ink" : "text-secondary hover:text-primary"
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <span className="hidden text-hint text-muted lg:inline">/w/{projectSlug}</span>
    </div>
  );
}
