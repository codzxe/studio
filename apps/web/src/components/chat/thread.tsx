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

import { ChatApiContext } from "@/lib/chat/provider";
import type { ChatUiError, ChatUiMessage, RunPhase } from "@/lib/chat/types";
import { ArrowDown } from "lucide-react";
import { type ReactElement, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { ChatBanner, RunPausedBanner } from "./banners";
import { ChatMessageView, type PlanMessageWiring } from "./message";
import type { ChatPanelDensity } from "./panel-settings";

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
  /**
   * ROUND 12 (Chat UI v3): re-send from a user message — per-message Retry
   * (host maps the id to a re-send). Absent ⇒ the action hides.
   */
  onRetryFrom?: (messageId: string) => void;
  /** ROUND 12 (Chat UI v3): edit-and-resend a user message. */
  onEditResend?: (messageId: string, nextText: string) => void;
  /** ROUND 12 (Chat UI v3): the settings knob's spacing mode. */
  density?: ChatPanelDensity;
  /**
   * ChatGPT-class surface affordance (chat-first studio): a floating
   * scroll-to-bottom pill while the reader has scrolled up. Default OFF —
   * the editor panel keeps its exact M4 behavior; only the full-page chat
   * surface opts in.
   */
  scrollButton?: boolean;
  /**
   * ChatGPT-class surface affordance (chat-first studio): renders a hover
   * toolbar node under each ASSISTANT message (copy / export / run chip).
   * Absent ⇒ nothing renders (the editor panel keeps its exact shape).
   */
  renderAssistantToolbar?: (message: ChatUiMessage) => ReactNode;
}

// Re-exported for the thread layer's consumers (the wiring type is part of the
// M5-Q seam — message.tsx consumes it).
export type { PlanMessageWiring } from "./message";

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
  onRetryFrom,
  onEditResend,
  density = "normal",
  scrollButton = false,
  renderAssistantToolbar,
}: ChatThreadProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  // The scroll pill mirrors the anchor ref into render state (only when the
  // affordance is on — the editor panel keeps zero extra renders).
  const [showJump, setShowJump] = useState(false);

  // M5-Q: the plan-card wiring — read straight from the ChatProvider context
  // (NULL-TOLERANT: a provider-less mount — the M4 thread tests, embeds — reads
  // null and every card stays the read-only M4 shape; no engine, no Apply).
  // The slot (chat-panel-slot.tsx) keeps its pinned props: the wiring rides
  // the context, not a new slot prop.
  const chatApi = useContext(ChatApiContext);
  const wiringApi = chatApi?.planWiring;
  const planWiring: PlanMessageWiring | null =
    wiringApi === undefined || wiringApi === null
      ? null
      : {
          ready: wiringApi.ready,
          controller: wiringApi.controller,
          bridge: wiringApi.bridge,
          sessionVersionId: wiringApi.sessionVersionId,
          phase,
          activeRunId,
        };

  const virtualize = messages.length > VIRTUALIZE_THRESHOLD;
  const hiddenCount = virtualize ? messages.length - WINDOW_SIZE : 0;
  const windowed = virtualize ? messages.slice(hiddenCount) : messages;
  const liveStream = phase === "streaming" || phase === "reconnecting";
  // Cheap content fingerprint: any append, streamed delta or tool-card arrival
  // moves it (the steered queue can leave the streaming message mid-list, so
  // "last message" alone is not enough).
  const contentSignature = messages.reduce(
    (sum, message) => sum + message.text.length + message.toolCards.length,
    0,
  );

  // Bottom-anchoring: only while the user is already at the bottom — an
  // append/stream delta must never yank a scrolled-up reader back down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentSignature/messages.length are deliberate change triggers for a DOM side effect (stream deltas mutate text, not the array identity)
  useEffect(() => {
    const el = scrollRef.current;
    if (el != null && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, contentSignature, phase]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el == null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
    if (scrollButton) setShowJump(!atBottomRef.current);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el == null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setShowJump(false);
  };

  const onQuickAction = (prompt: string) => {
    window.dispatchEvent(new CustomEvent<string>(CHAT_QUICK_ACTION_EVENT, { detail: prompt }));
  };

  return (
    <div data-testid="chat-thread" className="flex min-h-0 flex-1 flex-col">
      {error ? (
        error.code === "RUN_PAUSED" || error.code === "TURN_PAUSED" ? (
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
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-testid="chat-thread-scroll"
          role="log"
          aria-live="polite"
          aria-label="Agent conversation"
          onScroll={onScroll}
          className="scrollbar-thin h-full overflow-y-auto"
        >
          {messages.length === 0 ? (
            <div data-testid="chat-empty-state" className="flex flex-col gap-4 px-4 py-8">
              <h2 className="font-display text-title-m text-primary">What should we build?</h2>
              {emptyQuickActions.length > 0 ? (
                <div className="mo-stagger-pop flex flex-wrap gap-2">
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
            <div
              data-testid="chat-thread-list"
              className={`flex flex-col px-3 py-4 ${density === "compact" ? "gap-2.5" : "gap-4"}`}
            >
              {virtualize ? (
                <div
                  data-testid="chat-window-spacer"
                  data-hidden-count={hiddenCount}
                  aria-hidden="true"
                  className="h-5 shrink-0"
                />
              ) : null}
              {windowed.map((message) => (
                <div key={message.id} className="mo-msg-in">
                  <ChatMessageView
                    message={message}
                    planWiring={planWiring}
                    isStreaming={
                      liveStream && message.role === "assistant" && message.runId === activeRunId
                    }
                    onRetryFrom={onRetryFrom}
                    onEditResend={onEditResend}
                    assistantToolbar={
                      message.role === "assistant" && renderAssistantToolbar !== undefined
                        ? renderAssistantToolbar(message)
                        : undefined
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {scrollButton && showJump ? (
          <button
            type="button"
            data-testid="chat-scroll-to-bottom"
            aria-label="Scroll to bottom"
            onClick={scrollToBottom}
            className="mo-pill-in absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-pill border border-subtle bg-elevated text-secondary shadow-pop duration-120 ease-out hover:text-primary"
          >
            <ArrowDown size={15} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
