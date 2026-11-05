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
 */

import Link from "next/link";
import type { ReactElement } from "react";

export type StudioMode = "chat" | "engine";

export interface StudioModeBarProps {
  readonly projectName: string;
  readonly projectSlug: string;
  readonly mode: StudioMode;
  readonly onModeChange: (mode: StudioMode) => void;
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
}: StudioModeBarProps): ReactElement {
  return (
    <div
      data-testid="studio-mode-bar"
      className="flex h-12 shrink-0 items-center gap-3 border-b border-subtle bg-page px-4"
    >
      <Link
        href="/w"
        aria-label="Back to dashboard"
        data-testid="studio-back-link"
        className="flex h-7 items-center gap-1.5 rounded-pill px-2.5 text-label text-secondary duration-120 ease-out hover:bg-panel hover:text-primary"
      >
        <span aria-hidden="true">←</span>
        <span className="hidden sm:inline">Dashboard</span>
      </Link>
      <span className="min-w-0 truncate text-label font-medium text-primary">{projectName}</span>

      <div className="flex-1" />

      {/* The mode switch: Chat is the product's main surface; Engine is the
          full editor for hands-on work. aria-pressed carries the state. */}
      <div className="flex items-center rounded-pill border border-subtle bg-panel p-0.5">
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

      <span className="hidden text-hint text-muted md:inline">/w/{projectSlug}</span>
    </div>
  );
}
