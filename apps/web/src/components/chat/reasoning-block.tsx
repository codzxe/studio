"use client";

/**
 * ROUND 13 — the live thinking block (Claude-style collapsible reasoning bar).
 *
 * Three states, one component:
 * 1. NO reasoning tokens + the turn is thinking (no text yet) → the animated
 *    "Thinking · Ns" indicator line (keeps the `chat-thinking` test id) — the
 *    user sees a LIVE clock instead of a frozen "Thinking…" string.
 * 2. Reasoning tokens streaming (reasoning.delta events) → the bar is OPEN by
 *    default, shows the thinking text as it types (smoothed by the stream
 *    pacer), auto-scrolls, with a pulsing dot + live elapsed clock.
 * 3. Thinking finished (text started or the turn completed) → auto-collapses
 *    to "Thought for Ns"; one click re-expands. The user's manual toggle
 *    always wins over the auto behaviour.
 */

import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";

export interface ReasoningBlockProps {
  /** The thinking text accumulated so far ("" when the model emits none). */
  readonly reasoning: string;
  /** True while the turn is streaming AND no visible text yet (thinking live). */
  readonly active: boolean;
  /** Epoch-ms of the first reasoning delta (drives the duration label). */
  readonly startedAt?: number;
  /** Epoch-ms when thinking stopped (first text token or the turn terminal). */
  readonly endedAt?: number;
}

/** Live "now" clock while `active` (500 ms resolution — a visible ticking feel). */
function useElapsed(tick: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!tick) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [tick]);
  return now;
}

function secondsLabel(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  return `${whole}s`;
}

export function ReasoningBlock({
  reasoning,
  active,
  startedAt,
  endedAt,
}: ReasoningBlockProps): ReactElement | null {
  // The user's manual toggle wins over the auto open/collapse behaviour.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const showBody = reasoning !== "" && (userOpen ?? active);
  const now = useElapsed(active && reasoning !== "");

  // Auto-scroll the streaming tail into view (only while the body is shown).
  // `reasoningLength` re-runs the effect as the thinking text grows.
  const reasoningLength = reasoning.length;
  useEffect(() => {
    if (!showBody || !active) return;
    void reasoningLength; // the dependency that re-triggers the scroll
    const body = bodyRef.current;
    if (body !== null) body.scrollTop = body.scrollHeight;
  }, [showBody, active, reasoningLength]);

  // Nothing to render: no reasoning text and no active thinking phase.
  if (reasoning === "" && !active) return null;

  // State 1 — no reasoning tokens: the live indicator line only.
  if (reasoning === "") {
    const elapsed = startedAt !== undefined ? Math.max(0, (now - startedAt) / 1000) : Number.NaN;
    return (
      <p
        data-testid="chat-thinking"
        className="flex items-center gap-1.5 text-sm text-muted italic"
      >
        <span
          data-testid="chat-thinking-dot"
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"
        />
        Thinking
        {Number.isFinite(elapsed) ? (
          <span data-testid="chat-thinking-elapsed" className="tabular-nums not-italic">
            · {secondsLabel(elapsed)}
          </span>
        ) : null}
      </p>
    );
  }

  // State 2 + 3 — the collapsible reasoning bar.
  const open = showBody;
  const elapsedSeconds =
    startedAt !== undefined
      ? Math.max(0, ((active ? now : (endedAt ?? now)) - startedAt) / 1000)
      : Number.NaN;

  return (
    <div data-testid="chat-reasoning" className="flex w-full min-w-0 flex-col items-start">
      <button
        type="button"
        data-testid="chat-reasoning-header"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        className="-mx-1 flex items-center gap-1.5 rounded px-1 text-caption text-muted transition-colors hover:text-primary"
      >
        <ChevronDown
          aria-hidden="true"
          size={14}
          className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {active ? (
          <>
            <span
              data-testid="chat-reasoning-dot"
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-signal"
            />
            <span className="italic">Thinking</span>
            {Number.isFinite(elapsedSeconds) ? (
              <span data-testid="chat-reasoning-elapsed" className="tabular-nums">
                · {secondsLabel(elapsedSeconds)}
              </span>
            ) : null}
          </>
        ) : Number.isFinite(elapsedSeconds) ? (
          <span data-testid="chat-reasoning-done">Thought for {secondsLabel(elapsedSeconds)}</span>
        ) : (
          <span data-testid="chat-reasoning-done">Thinking</span>
        )}
      </button>
      {open ? (
        <div
          ref={bodyRef}
          data-testid="chat-reasoning-body"
          className="mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-solid border-border-subtle bg-elevated px-3 py-2"
        >
          <p className="whitespace-pre-wrap text-caption leading-relaxed text-muted">
            {reasoning}
            {active ? (
              <span
                data-testid="chat-reasoning-caret"
                aria-hidden="true"
                className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-signal align-middle"
              />
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
