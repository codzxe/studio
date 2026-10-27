"use client";

/**
 * MessageActions — ROUND 12 "Chat UI v3" per-message affordances
 * (research/round12-design.md "Per-message actions: copy, retry (re-run
 * from that user message), edit+resend").
 *
 * Presentational pair used by the USER message row (message.tsx):
 * - `MessageActions` — the hover/focus action row: Copy (clipboard with a
 *   "Copied" confirmation), Retry + Edit only when the host wired the
 *   callbacks (absent ⇒ hidden, never a dead button);
 * - `MessageEditBox` — the inline edit textarea: Enter saves (resend),
 *   Shift+Enter newlines, Escape cancels, Save/Cancel buttons mirror it.
 *
 * The callbacks are ID-based (`onRetryFrom(messageId)` /
 * `onEditResend(messageId, nextText)`) so the HOST maps them to a re-send —
 * this layer never touches the controller.
 */

import { Button, Textarea } from "@studio/ui";
import { Check, Copy, Pencil, RefreshCw, X } from "lucide-react";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface MessageActionsProps {
  readonly text: string;
  readonly onRetry?: () => void;
  readonly onEdit?: () => void;
  /** Which affordances the row shows (internal a11y: always "Copy"). */
  readonly showRetry?: boolean;
  readonly showEdit?: boolean;
}

/** Clipboard write with the execCommand fallback (jsdom/HTTP shells). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function MessageActions({
  text,
  onRetry,
  onEdit,
  showRetry = onRetry !== undefined,
  showEdit = onEdit !== undefined,
}: MessageActionsProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(() => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1600);
    });
  }, [text]);

  const buttonBase =
    "inline-flex h-6 w-6 items-center justify-center rounded-xs p-0 text-muted transition-colors duration-120 hover:bg-elevated hover:text-primary";

  return (
    <div
      data-testid="chat-message-actions"
      className="flex items-center gap-0.5 opacity-0 transition-opacity duration-120 focus-within:opacity-100 group-hover:opacity-100"
    >
      <button
        type="button"
        className={buttonBase}
        aria-label={copied ? "Copied" : "Copy message"}
        data-testid="chat-message-copy"
        data-copied={copied}
        onClick={onCopy}
      >
        {copied ? (
          <Check size={13} strokeWidth={1.9} aria-hidden="true" />
        ) : (
          <Copy size={13} strokeWidth={1.9} aria-hidden="true" />
        )}
      </button>
      {showRetry && onRetry !== undefined ? (
        <button
          type="button"
          className={buttonBase}
          aria-label="Retry from this message"
          title="Retry from this message"
          data-testid="chat-message-retry"
          onClick={onRetry}
        >
          <RefreshCw size={13} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
      {showEdit && onEdit !== undefined ? (
        <button
          type="button"
          className={buttonBase}
          aria-label="Edit and resend"
          title="Edit and resend"
          data-testid="chat-message-edit"
          onClick={onEdit}
        >
          <Pencil size={13} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export interface MessageEditBoxProps {
  readonly initialText: string;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}

export function MessageEditBox({
  initialText,
  onSave,
  onCancel,
}: MessageEditBoxProps): ReactElement {
  const [value, setValue] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(initialText.length, initialText.length);
  }, [initialText]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const next = value.trim();
      if (next !== "") onSave(next);
    }
  };

  return (
    <div
      data-testid="chat-message-edit-box"
      className="flex max-w-[72ch] flex-col gap-1.5 rounded-[var(--chat-message-radius)] bg-elevated px-2.5 py-2"
    >
      <Textarea
        ref={ref}
        rows={Math.min(6, Math.max(1, value.split("\n").length))}
        aria-label="Edit message"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-h-0"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-caption"
          data-testid="chat-message-edit-cancel"
          onClick={onCancel}
        >
          <X size={13} strokeWidth={1.9} aria-hidden="true" className="mr-1" />
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="h-7 px-2.5 text-caption"
          data-testid="chat-message-edit-save"
          disabled={value.trim() === ""}
          onClick={() => {
            const next = value.trim();
            if (next !== "") onSave(next);
          }}
        >
          <RefreshCw size={13} strokeWidth={1.9} aria-hidden="true" className="mr-1" />
          Send
        </Button>
      </div>
    </div>
  );
}
