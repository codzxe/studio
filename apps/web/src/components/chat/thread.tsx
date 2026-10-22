"use client";

/**
 * The chat thread (M4-F) — EDITOR_CHAT_UX §3.3/§8.4/§12: the message list with
 * system banners on top, a streaming caret on the active assistant message,
 * quick actions on an empty thread, windowed rendering past 50 messages and
 * bottom-anchored scrolling that never jumps when the user has scrolled up.
 *
 * Exported surface (docs/phases/M4-SEAMS.md "Wave-2 UI contract", binding):
 *   ChatThreadProps + ChatThread.
 *
 * Documented deviation from the pinned five fields: ChatThreadProps adds an
 * OPTIONAL `error?: ChatUiError` so behavior (4) of the M4-F brief is
 * renderable at all (RUN_PAUSED → RunPausedBanner; other errors → error banner
 * with the engine's message + Retry when retryable). The pinned five-field
 * call shape still typechecks — M4-J passes `error={state.error}`.
 *
 * Quick-action contract for M4-J: chips dispatch
 *   new CustomEvent(CHAT_QUICK_ACTION_EVENT, { detail: prompt })
 * on `window` — listen with window.addEventListener(CHAT_QUICK_ACTION_EVENT,
 * (event) => setComposerText((event as CustomEvent<string>).detail)).
 */

import type { ChatUiError, ChatUiMessage, RunPhase } from "@/lib/chat/types";
import { type ReactElement, useEffect, useRef } from "react";
import { ChatBanner, RunPausedBanner } from "./banners";
import { ChatMessageView } from "./message";

export interface ChatThreadProps {
  messages: readonly ChatUiMessage[];
  phase: RunPhase;
  activeRunId: string | null;
  onRetry(): void;
  /** Rendered as chips on an empty thread (EDITOR_CHAT_UX §4.4/§12). */
  emptyQuickActions: readonly { label: string; prompt: string }[];
  /**
   * Thread-level error snapshot (see the module header for the documented
   * deviation from the pinned five fields). RUN_PAUSED renders the §8.4
   * pause banner; anything else renders an error banner with Retry when
   * retryable.
   */
  error?: ChatUiError;
}

/** Window event quick-action chips dispatch (see the module header contract). */
export const CHAT_QUICK_ACTION_EVENT = "studio:chat-quick-action";

/** §3.3: virtualize the thread after 50 messages. */
const VIRTUALIZE_THRESHOLD = 50;
/** The rendered window: the last 40 messages (+ a 20px top spacer). */
const WINDOW_SIZE = 40;
/** §3.3: keep the scroll anchored to the bottom only when already there. */
const AT_BOTTOM_THRESHOLD = 32;

export function ChatThread({
  messages,
  phase,
  activeRunId,
  onRetry,
  emptyQuickActions,
  error,
}: ChatThreadProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const virtualize = messages.length > VIRTUALIZE_THRESHOLD;
  const hiddenCount = virtualize ? messages.length - WINDOW_SIZE : 0;
  const windowed = virtualize ? messages.slice(hiddenCount) : messages;
  const lastMessage = messages.at(-1);
  const lastTextLength = lastMessage?.text.length ?? 0;
  const liveStream = phase === "streaming" || phase === "reconnecting";

  // Bottom-anchoring: only while the user is already at the bottom — an
  // append/stream delta must never yank a scrolled-up reader back down.
  useEffect(() => {
    const el = scrollRef.current;
    if (el != null && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length/lastTextLength/phase are deliberate triggers for the DOM side effect (stream deltas change the text, not the array)
  }, [messages.length, lastTextLength, phase]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el == null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
  };

  const onQuickAction = (prompt: string) => {
    window.dispatchEvent(new CustomEvent<string>(CHAT_QUICK_ACTION_EVENT, { detail: prompt }));
  };

  return (
    <div data-testid="chat-thread" className="flex min-h-0 flex-1 flex-col">
      {error ? (
        error.code === "RUN_PAUSED" ? (
          <RunPausedBanner onRetry={onRetry} />
        ) : (
          <div className="px-3 pt-2">
            <ChatBanner
              kind="error"
              message={error.message}
              actionLabel={error.retryable ? "Retry" : undefined}
              onAction={error.retryable ? onRetry : undefined}
            />
          </div>
        )
      ) : phase === "reconnecting" ? (
        <div className="px-3 pt-2">
          <ChatBanner kind="info" message="Reconnecting…" />
        </div>
      ) : null}
      {/*
       * §9.2: the thread is a live region (role="log" + aria-live="polite").
       * The persistent scroller IS the thread list region, so the very first
       * message is announced too (a list that mounts with its first child
       * would miss it).
       */}
      <div
        ref={scrollRef}
        data-testid="chat-thread-scroll"
        role="log"
        aria-live="polite"
        aria-label="Agent conversation"
        onScroll={onScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <div data-testid="chat-empty-state" className="flex flex-col gap-4 px-4 py-8">
            <h2 className="font-display text-title-m text-primary">What should we build?</h2>
            {emptyQuickActions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {emptyQuickActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    data-testid="chat-quick-action"
                    data-prompt={action.prompt}
                    onClick={() => onQuickAction(action.prompt)}
                    className="h-8 rounded-pill border border-border bg-elevated px-3 text-body-s text-secondary transition-colors duration-120 hover:border-border-strong hover:text-primary"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div data-testid="chat-thread-list" className="flex flex-col gap-4 px-3 py-4">
            {virtualize ? (
              <div
                data-testid="chat-window-spacer"
                data-hidden-count={hiddenCount}
                aria-hidden="true"
                className="h-5 shrink-0"
              />
            ) : null}
            {windowed.map((message) => (
              <ChatMessageView
                key={message.id}
                message={message}
                isStreaming={
                  liveStream && message.role === "assistant" && message.runId === activeRunId
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
