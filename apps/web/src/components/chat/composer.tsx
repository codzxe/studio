"use client";

import { Button, Textarea, useAutoGrow } from "@studio/ui";
import { ArrowUp, Square } from "lucide-react";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * ChatComposer — ECUX §3.4 (seam 8, docs/phases/M4-SEAMS.md wave-2).
 *
 * Auto-growing draft box (1–6 rows, then scroll), Enter/Cmd-Ctrl+Enter send,
 * Shift+Enter newline, IME-safe Enter, Stop-while-streaming, credits/plan/editor
 * disabled states (§12) and quick-action chips (§4.4) when the parent passes
 * them (the parent decides the thread is empty).
 *
 * Keyboard law (§9 + M4-SEAMS pins):
 * - Enter sends (also while `streaming` — steer messages, §3.4: the composer
 *   stays enabled and the run queue appends; M4-J maps that in the controller).
 * - Shift+Enter inserts a newline (default action NOT prevented).
 * - Cmd/Ctrl+Enter sends — this listener is on the composer's own textarea;
 *   the panel-level Cmd/Ctrl+Enter listener is M4-J's (independent).
 * - Escape does NOTHING inside the composer (popovers → panel dismissal is
 *   owned by M4-E/M4-J; pinned in the seam).
 * - Enter during IME composition (`nativeEvent.isComposing`, plus the legacy
 *   keyCode 229) never sends — it confirms the composition.
 *
 * Window events dispatched for M4-J (prop-free wiring, documented):
 * - "studio:chat-quick-action" — detail: the chip's prompt (string).
 * - "studio:chat-upgrade" — no detail (the §12 Upgrade CTA; navigation is
 *   the panel's job, this placeholder only announces the intent).
 *
 * Length guard: CHAT_MESSAGE_SCHEMA (packages/contracts/src/routes/chat.ts)
 * is `z.string().min(1).max(8000)` — sends are disabled (not sliced) beyond
 * 8,000 characters with a visible hint.
 */

/** `CHAT_MESSAGE_SCHEMA` max length — sends are blocked (never sliced) beyond it. */
const MAX_MESSAGE_CHARS = 8000;
/** §3.4: the textarea auto-grows 1–6 rows, then scrolls internally. */
const MAX_ROWS = 6;
const TOO_LONG_HINT = "Message too long — 8,000 characters max.";
const PLACEHOLDER = "Ask for an edit, or describe what you want to build…";

export interface ChatComposerProps {
  streaming: boolean;
  /** Read-only lease NEVER disables chat (M4-SEAMS). */
  disabled?: { reason: "credits" | "plan" | "editor"; message: string } | null;
  /** Rendered when the thread is empty (the parent decides; §4.4 chips). */
  quickActions?: readonly { label: string; prompt: string }[];
  /** e.g. "Smart · ~12 credits" — the composer's bottom-row hint slot (§3.5). */
  creditHint?: string;
  onSend(message: string): void;
  onStop(): void;
}

/**
 * Deterministic §3.4 row math (newline count, clamped 1..MAX_ROWS). jsdom has
 * no layout, so `rows` — not scrollHeight — is the testable truth; the
 * design-system `useAutoGrow` hook (scrollHeight sizing) covers soft-wrapped
 * lines in real browsers, capped by a computed max-height.
 */
function rowsForValue(value: string): number {
  if (!value) return 1;
  return Math.min(MAX_ROWS, Math.max(1, value.split("\n").length));
}

export function ChatComposer({
  streaming,
  disabled = null,
  quickActions,
  creditHint,
  onSend,
  onStop,
}: ChatComposerProps): ReactElement {
  const [value, setValue] = useState("");
  // Design-system auto-grow (packages/ui textarea.tsx): sizes the textarea to
  // its scrollHeight on every edit. Composed with our own node ref below.
  const autoGrowRef = useAutoGrow(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const attachTextarea = useCallback(
    (node: HTMLTextAreaElement | null): void => {
      autoGrowRef(node);
      textareaRef.current = node;
    },
    [autoGrowRef],
  );

  // Cap the auto-grow at MAX_ROWS lines, then scroll internally (§3.4). Runs
  // once per mount in real browsers; jsdom reports no computed line-height,
  // so it no-ops there and the `rows` attribute stays the deterministic base.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const computed = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight);
    const padY = Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom);
    if (Number.isFinite(lineHeight) && lineHeight > 0) {
      el.style.maxHeight = `${Math.ceil(MAX_ROWS * lineHeight + (Number.isFinite(padY) ? padY : 0))}px`;
    }
  }, []);

  const trimmed = value.trim();
  const isLocked = disabled !== null;
  const tooLong = trimmed.length > MAX_MESSAGE_CHARS;
  const canSend = !isLocked && !tooLong && trimmed.length > 0;
  const rows = rowsForValue(value);

  const send = useCallback((): void => {
    if (!canSend) return;
    onSend(trimmed);
    setValue("");
    textareaRef.current?.focus();
  }, [canSend, onSend, trimmed]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== "Enter") return;
      // IME safety (§3.4): Enter mid-composition confirms the composition —
      // it must never send. keyCode 229 covers IME-fed legacy events.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      const withModifier = event.metaKey || event.ctrlKey;
      if (event.shiftKey && !withModifier) return; // Shift+Enter → newline (default action)
      // Plain Enter and Cmd/Ctrl+Enter both send (§9.1).
      event.preventDefault();
      send();
    },
    [send],
  );

  const dispatchQuickAction = (prompt: string): void => {
    window.dispatchEvent(new CustomEvent("studio:chat-quick-action", { detail: prompt }));
    textareaRef.current?.focus();
  };

  const dispatchUpgrade = (): void => {
    window.dispatchEvent(new CustomEvent("studio:chat-upgrade"));
  };

  // Bottom-row hint: the lock reason explains the composer better than the
  // length hint, so it wins while disabled (§12 messages are prop-supplied).
  const hint = disabled?.message ?? (tooLong ? TOO_LONG_HINT : null);

  return (
    <div className="flex w-full flex-col gap-2" data-testid="chat-composer">
      {quickActions && quickActions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {quickActions.map((action) => (
            <Button
              key={action.label}
              data-testid="chat-composer-quick-action"
              variant="secondary"
              size="sm"
              onClick={() => dispatchQuickAction(action.prompt)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="relative w-full">
        <Textarea
          ref={attachTextarea}
          rows={rows}
          aria-label="Message the agent"
          placeholder={PLACEHOLDER}
          value={value}
          disabled={isLocked}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          className="overflow-y-auto pr-11"
        />
        {streaming ? (
          // Stop outranks even the credits lock while a run is live (§8.3:
          // the user can always cancel). aria-label per the seam pin.
          <Button
            data-testid="chat-composer-send"
            aria-label="Stop streaming"
            variant="secondary"
            size="iconSm"
            className="absolute right-1.5 bottom-1.5"
            onClick={() => onStop()}
          >
            <Square size={12} strokeWidth={2} aria-hidden="true" />
          </Button>
        ) : disabled?.reason === "credits" ? (
          // §12 "You're out of credits" + Upgrade CTA — link-styled placeholder;
          // navigation belongs to the panel (M4-J listens for the event).
          <Button
            data-testid="chat-composer-send"
            variant="link"
            className="absolute right-2 bottom-1.5"
            onClick={dispatchUpgrade}
          >
            Upgrade
          </Button>
        ) : (
          <Button
            data-testid="chat-composer-send"
            aria-label="Send"
            variant="primary"
            size="iconSm"
            className="absolute right-1.5 bottom-1.5"
            disabled={!canSend}
            onClick={() => send()}
          >
            <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
          </Button>
        )}
      </div>

      {hint !== null || creditHint !== undefined ? (
        <div className="flex w-full items-start justify-between gap-2 text-caption text-muted">
          {hint !== null ? (
            // <output> carries the implicit role="status" (aria-live polite):
            // the §12 lock message and the length hint announce themselves.
            <output className={tooLong && !isLocked ? "text-danger" : undefined}>{hint}</output>
          ) : null}
          {creditHint !== undefined ? (
            <p className="shrink-0 whitespace-nowrap">{creditHint}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
