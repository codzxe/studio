"use client";

/**
 * ROUND 13 — the collapsible tool-calls bar.
 *
 * The raw per-tool cards stay (tool-card.tsx: one line + expandable args and
 * result), but they now live UNDER one collapsible bar so a working run reads
 * as a tidy activity log instead of flashing chips:
 * - While the message streams with tool calls: the bar is OPEN by default —
 *   the user watches each call light up (running → done/failed) live.
 * - When the run settles: it auto-collapses to one summary line
 *   ("Used 3 tools · 2 done · 1 failed"); one click re-expands.
 * - The user's manual toggle always wins over the auto behaviour.
 */

import type { ToolCardState } from "@/lib/chat/types";
import { ChevronDown } from "lucide-react";
import { type ReactElement, useState } from "react";
import { ToolCard, toolLabel } from "./tool-card";

export interface ToolCallsBlockProps {
  readonly cards: readonly ToolCardState[];
  /** True while this message's run is live-streaming. */
  readonly streaming: boolean;
}

export function ToolCallsBlock({ cards, streaming }: ToolCallsBlockProps): ReactElement | null {
  // The user's manual toggle wins over the auto open/collapse behaviour.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  if (cards.length === 0) return null;

  const running = cards.some((card) => card.status === "running" || card.status === "queued");
  const done = cards.filter((card) => card.status === "done").length;
  const failed = cards.filter((card) => card.status === "failed").length;
  // Auto: open while the run is live (the user watches the calls land), fold
  // to the summary line when the run settles.
  const open = userOpen ?? (streaming && cards.length > 0);
  // The header names the RUNNING call (the live activity), not the last one.
  const runningCard = [...cards]
    .reverse()
    .find((card) => card.status === "running" || card.status === "queued");

  const counts: string[] = [];
  if (running) counts.push("running");
  if (done > 0) counts.push(`${done} done`);
  if (failed > 0) counts.push(`${failed} failed`);

  return (
    <div data-testid="chat-tools" className="flex w-full min-w-0 flex-col items-start">
      <button
        type="button"
        data-testid="chat-tools-header"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        className="-mx-1 flex max-w-full items-center gap-1.5 rounded px-1 text-caption text-muted transition-colors hover:text-primary"
      >
        <ChevronDown
          aria-hidden="true"
          size={14}
          className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {streaming && running && runningCard !== undefined ? (
          <>
            <span
              data-testid="chat-tools-spinner"
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-signal"
            />
            <span className="italic">{toolLabel(runningCard.name)}</span>
          </>
        ) : (
          <span>
            Used {cards.length} tool {cards.length === 1 ? "call" : "calls"}
          </span>
        )}
        {counts.length > 0 ? (
          <span data-testid="chat-tools-counts" className="truncate">
            · {counts.join(" · ")}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 flex w-full min-w-0 flex-col gap-1.5">
          {cards.map((card) => (
            <ToolCard key={card.toolCallId} card={card} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
