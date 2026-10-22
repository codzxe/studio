"use client";

/**
 * InlineEditBar — EDITOR_CHAT_UX §4.2 (BUILD_PLAN §M5.7; DECISIONS.md D-5:
 * inside the editor route Cmd/Ctrl+K means INLINE EDIT, never the command
 * palette).
 *
 * The compact command bar the chat panel slot mounts directly above the
 * composer while inline edit is open: a single text input, `Enter` submits,
 * `Escape` closes, focus is trapped inside the bar and restored by the slot.
 * The §4.2 preview/apply flow is the plan-card/apply peers' (M5-F/M5-G) — this
 * bar only STARTS the focused request.
 *
 * Submit seam (M5-I local seam — integrator note, see the worklog): the bar
 * hands the slot one `InlineEditSubmit` tagged `inlineEdit: true`; the slot
 * passes it to `api.send` unchanged. M5-F's `ChatSendInput`/`ChatRequest`
 * carry no metadata field yet, so the tag rides the call structurally and
 * reaches the wire only after the chat-controller seam grows
 * `inlineEdit?: boolean` (files M5-I does not own). It is NEVER smeared into
 * the user-visible message text.
 */

import { Button, Input, Kbd } from "@studio/ui";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

/** What the slot hands to `api.send` when the bar submits (D-5/§4.2). */
export interface InlineEditSubmit {
  /** The user's focused edit request, trimmed; never empty. */
  readonly message: string;
  /**
   * Tags the chat message as an inline-edit request (ECUX §4.2): the gateway
   * should answer with one focused batch (≤ 5 steps) instead of a long plan.
   */
  readonly inlineEdit: true;
}

export interface InlineEditBarProps {
  /** Renders nothing while closed (the slot owns open/close state). */
  readonly open: boolean;
  /**
   * §4.2 scope: the current selection's names, else the active comp's name,
   * else null → the caption falls back to the active composition.
   */
  readonly scopeLabel: string | null;
  /**
   * Non-null locks the submit (e.g. the composer's credits/plan lock) and
   * shows the reason — the same message the composer shows (§12).
   */
  readonly lockMessage: string | null;
  /** Bumped on every Cmd/Ctrl+K arrival; re-focuses the input (idempotent open). */
  readonly focusSeq: number;
  readonly onSubmit: (input: InlineEditSubmit) => void;
  readonly onClose: () => void;
}

/** The dialog's focusable elements in DOM order (input, then send). */
const FOCUSABLE_SELECTOR =
  'input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const CAPTION_FALLBACK = "the active composition";
const PLACEHOLDER = "Describe the edit…";

export function InlineEditBar({
  open,
  scopeLabel,
  lockMessage,
  focusSeq,
  onSubmit,
  onClose,
}: InlineEditBarProps): ReactElement | null {
  const [value, setValue] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus management: focus the input on open and on every re-trigger
  // (focusSeq) — a repeated Cmd/Ctrl+K re-focuses, it never clears the draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq is a deliberate re-focus trigger (the effect body only reads `open`)
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, focusSeq]);

  if (!open) return null;

  const submit = (): void => {
    const message = value.trim();
    if (message === "" || lockMessage !== null) return;
    setValue(""); // the bar starts fresh after a submit (an Esc keeps the draft)
    onSubmit({ message, inlineEdit: true });
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    // IME safety (§3.4): Enter mid-composition confirms the composition.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  // Dialog-level keys: Escape closes (§9 — and must NOT collapse the panel,
  // so both default + propagation are stopped); Tab wraps inside the bar
  // (focus trap — the editor keeps its own focus outside this layer).
  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = rootRef.current;
    if (root === null) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
    );
    if (focusables.length < 2) return;
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={rootRef}
      // biome-ignore lint/a11y/useSemanticElements: the §4.2 command bar is a NON-MODAL popover — native <dialog> implies showModal/top-layer focus semantics the additive editor overlay must not take (law #7)
      role="dialog"
      aria-label="Inline edit"
      data-testid="chat-inline-edit"
      onKeyDown={onRootKeyDown}
      className="flex w-full flex-col gap-2 rounded-sm border border-strong bg-elevated px-3 py-2"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <p
          data-testid="chat-inline-edit-scope"
          className="min-w-0 truncate text-caption text-secondary"
        >
          <span aria-hidden="true" className="mr-1 text-muted">
            ✎
          </span>
          Editing: {scopeLabel ?? CAPTION_FALLBACK}
        </p>
        <p className="flex shrink-0 items-center gap-1 text-caption text-muted">
          <Kbd>Esc</Kbd>
          to close
        </p>
      </div>
      <div className="flex w-full items-center gap-2">
        <Input
          ref={inputRef}
          type="text"
          inputSize="sm"
          aria-label="Inline edit request"
          placeholder={PLACEHOLDER}
          value={value}
          disabled={lockMessage !== null}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onInputKeyDown}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          data-testid="chat-inline-edit-send"
          disabled={lockMessage !== null || value.trim() === ""}
          onClick={() => submit()}
        >
          Send
        </Button>
      </div>
      {lockMessage !== null ? (
        <p data-testid="chat-inline-edit-locked" className="text-caption text-muted">
          {lockMessage}
        </p>
      ) : null}
    </div>
  );
}
