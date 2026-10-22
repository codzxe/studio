"use client";

/**
 * One thread message (M4-F) — EDITOR_CHAT_UX §3.3/§10: max 72ch of text; user
 * messages sit on a subtle raised `--bg-elevated` surface with a "You" label;
 * assistant messages are plain on the panel background with a sparkle mark —
 * NO avatars. System-style notices (credits) are inline lines, not toasts.
 *
 * Exported surface (docs/phases/M4-SEAMS.md "Wave-2 UI contract", binding):
 *   ChatMessageViewProps + ChatMessageView.
 */

import type { ChatUiMessage } from "@/lib/chat/types";
import type { ReactElement } from "react";
import { Markdown } from "./markdown";
import { PlanCard } from "./plan-card";
import { ToolCard } from "./tool-card";

export interface ChatMessageViewProps {
  message: ChatUiMessage;
  /** Caret shows only on the ACTIVE assistant message while its run streams. */
  isStreaming: boolean;
}

/** The §9 streaming caret: 6×14px signal block, 1s step blink (tokens.css). */
function StreamingCaret() {
  return (
    <span
      data-testid="chat-caret"
      aria-hidden="true"
      className="mt-1 inline-block h-[var(--chat-caret-h)] w-[var(--chat-caret-w)] animate-caret-blink bg-signal"
    />
  );
}

export function ChatMessageView({ message, isStreaming }: ChatMessageViewProps): ReactElement {
  const isUser = message.role === "user";
  const showCaret = isStreaming && !isUser;
  return (
    <article
      data-testid="chat-message"
      data-role={message.role}
      className="flex min-w-0 flex-col items-start gap-1.5"
    >
      {isUser ? (
        <p data-testid="chat-message-label" className="text-label text-muted uppercase">
          You
        </p>
      ) : (
        <p data-testid="chat-message-label" className="text-label text-muted uppercase">
          <span aria-hidden="true" className="mr-1">
            ✦
          </span>
          {" Agent"}
        </p>
      )}
      {isUser ? (
        <div className="max-w-[72ch] rounded-[var(--chat-message-radius)] border border-subtle bg-elevated px-3 py-2">
          <Markdown text={message.text} />
        </div>
      ) : (
        <div className="flex max-w-[72ch] min-w-0 flex-col items-start">
          {message.text.length > 0 ? (
            <Markdown text={message.text} />
          ) : showCaret ? (
            <p data-testid="chat-thinking" className="text-sm text-muted italic">
              Thinking…
            </p>
          ) : null}
          {showCaret ? <StreamingCaret /> : null}
        </div>
      )}
      {message.toolCards.length > 0 ? (
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          {message.toolCards.map((card) => (
            <ToolCard key={card.toolCallId} card={card} />
          ))}
        </div>
      ) : null}
      {message.plan ? <PlanCard plan={message.plan} applied={false} /> : null}
      {message.credits ? (
        <p data-testid="chat-credits" className="text-caption text-muted">
          {message.credits.committed} credits used · balance {message.credits.balance}
        </p>
      ) : null}
    </article>
  );
}
