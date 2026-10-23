"use client";

import { LowCreditBanner } from "@/components/billing/low-credit-banner";
import { ChatApiContext } from "@/lib/chat/provider";
import { latestCreditsSnapshot } from "@/lib/chat/run-state";
import { type ChatUiState, INSUFFICIENT_CREDITS_CODE } from "@/lib/chat/types";
import { Button, Textarea, useAutoGrow } from "@studio/ui";
import { ArrowUp, Square } from "lucide-react";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useContext,
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
 * §9 envelope (UI_DESIGN_SYSTEM §9 “composer 96–160px”): the input box
 * carries `--chat-composer-min-h`/`--chat-composer-max-h` (tokens.css:140-141)
 * via its `min-h`/`max-h` classes, and the auto-grow cap is CLAMPED inside
 * that envelope (autoGrowCapPx below — unit-tested). jsdom has no layout, so
 * the computed cap no-ops there and the token classes alone carry the
 * envelope (the documented no-op path; tests assert the classes).
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
 *
 * M6-H credits block (BUILD_PLAN §M6 task 4, §12 "No credits", §8.8): before
 * the composer sends, HONEST client-side evidence of a zero balance blocks
 * the send and renders the M6-G LowCreditBanner (imported from
 * components/billing — its `low-credit-topup` anchor links to the billing
 * surface via `topUpHref`). Evidence sources, freshest first: the thread's
 * typed `blocked` state (402 INSUFFICIENT_CREDITS), the same code on
 * `snapshot.error`, the host's `disabled.reason === "credits"` prop, or a
 * KNOWN balance of exactly 0 (the terminal §7.4 `credits` event, µc). The
 * block is UX ONLY — the server already enforces (402) — so the banner CTA
 * consumes the evidence and re-arms sends: the next POST is the re-check,
 * and a still-empty wallet re-blocks with fresh evidence (never a permanent
 * client lock, never a fabricated balance).
 *
 * Window events RETIRED (M6-H): "studio:chat-upgrade" — the M4 placeholder
 * had no listener anywhere (verified by grep); the real navigation is the
 * banner CTA's href.
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
/** §12 copy for the derived zero-balance arm (the 402 arm uses the §7.3 message). */
const OUT_OF_CREDITS_MESSAGE = "You're out of credits.";
/** The billing surface M6-F/G own; overridable for the workspace-scoped route. */
const DEFAULT_TOP_UP_HREF = "/w/billing";

export interface ChatComposerProps {
  streaming: boolean;
  /** Read-only lease NEVER disables chat (M4-SEAMS). */
  disabled?: { reason: "credits" | "plan" | "editor"; message: string } | null;
  /** Rendered when the thread is empty (the parent decides; §4.4 chips). */
  quickActions?: readonly { label: string; prompt: string }[];
  /** e.g. "Smart · ~12 credits" — the composer's bottom-row hint slot (§3.5). */
  creditHint?: string;
  /**
   * M6-H: the Top-up CTA's destination. Defaults to `/w/billing`; the slot
   * should pass the workspace-scoped route (`/w/<slug>/billing`) once the
   * M6-F/G billing pages land.
   */
  topUpHref?: string;
  onSend(message: string): void;
  onStop(): void;
}

/**
 * M6-H: one piece of zero-balance evidence. `key` is the source object's
 * identity (a fold-committed state slice — referentially stable between
 * renders, fresh per occurrence), so a banner action can CONSUME exactly
 * this evidence and a fresh 402 / a newer credits event re-blocks.
 */
type CreditsBlockEvidence = {
  readonly source: "http-402" | "zero-balance";
  readonly key: object;
  readonly message: string;
};

/**
 * M6-H: derives the current zero-balance evidence, freshest first. Pure —
 * reads the provider's committed snapshot + the host's `disabled` prop;
 * `null` when the balance is unknown (before the first run of a session,
 * with no 402 seen — the server still enforces, so no fabricated lock).
 */
function creditsBlockEvidence(
  snapshot: ChatUiState | undefined,
  disabled: { reason: "credits" | "plan" | "editor"; message: string } | null,
): CreditsBlockEvidence | null {
  if (snapshot !== undefined) {
    const blocked = snapshot.blocked;
    if (blocked !== undefined) {
      return { source: "http-402", key: blocked, message: blocked.message };
    }
    const error = snapshot.error;
    if (error !== undefined && error.code === INSUFFICIENT_CREDITS_CODE) {
      return { source: "http-402", key: error, message: error.message };
    }
  }
  if (disabled !== null && disabled.reason === "credits") {
    return { source: "http-402", key: disabled, message: disabled.message };
  }
  if (snapshot !== undefined) {
    const credits = latestCreditsSnapshot(snapshot);
    if (credits !== null && credits.balance === 0) {
      return { source: "zero-balance", key: credits, message: OUT_OF_CREDITS_MESSAGE };
    }
  }
  return null;
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

/**
 * §9 envelope clamp (exported for the unit test): the §3.4 auto-grow cap
 * (MAX_ROWS lines + vertical padding, in px) may never exceed the resolved
 * `--chat-composer-max-h` token. Returns `null` when line-height is
 * unavailable — the jsdom no-op path (no computed layout), where the token
 * classes alone enforce the envelope.
 */
export function autoGrowCapPx(
  lineHeightPx: number,
  padYPx: number,
  envelopeMaxPx: number,
): number | null {
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) return null;
  const rowsCap = Math.ceil(
    MAX_ROWS * lineHeightPx + (Number.isFinite(padYPx) ? padYPx : 0),
  );
  if (!Number.isFinite(envelopeMaxPx) || envelopeMaxPx <= 0) return rowsCap;
  return Math.min(rowsCap, envelopeMaxPx);
}

export function ChatComposer({
  streaming,
  disabled = null,
  quickActions,
  creditHint,
  topUpHref = DEFAULT_TOP_UP_HREF,
  onSend,
  onStop,
}: ChatComposerProps): ReactElement {
  const [value, setValue] = useState("");
  // M6-H: the banner action consumes the CURRENT evidence — the block is
  // client-side UX only, so the re-check is the NEXT send (server re-enforces
  // the §8.8 gate); fresh evidence re-blocks.
  const [consumedEvidence, setConsumedEvidence] = useState<CreditsBlockEvidence | null>(null);
  // Null-tolerant provider read (the thread.tsx pattern): a provider-less
  // mount derives evidence from the `disabled` prop only.
  const chatApi = useContext(ChatApiContext);
  const evidence = creditsBlockEvidence(chatApi?.snapshot, disabled);
  const creditsBlocked =
    evidence !== null &&
    (consumedEvidence === null ||
      consumedEvidence.source !== evidence.source ||
      consumedEvidence.key !== evidence.key);
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

  // Cap the auto-grow at MAX_ROWS lines, then scroll internally (§3.4) —
  // CLAMPED into the §9 96–160px envelope (autoGrowCapPx reads the resolved
  // --chat-composer-max-h from the max-h token class below). Runs once per
  // mount in real browsers; jsdom reports no computed line-height, so it
  // no-ops there and the `rows` attribute stays the deterministic base.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const computed = window.getComputedStyle(el);
    const cap = autoGrowCapPx(
      Number.parseFloat(computed.lineHeight),
      Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom),
      Number.parseFloat(computed.maxHeight),
    );
    if (cap !== null) el.style.maxHeight = `${cap}px`;
  }, []);

  const trimmed = value.trim();
  // M6-H: the credits evidence locks the composer like §12 "No credits"; a
  // CONSUMED credits prop-lock (the user hit the banner CTA) re-arms sends.
  // The plan/editor locks keep their exact M4 semantics (never consumable).
  const otherLock = disabled !== null && disabled.reason !== "credits";
  const isLocked = otherLock || creditsBlocked;
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

  // M6-H: the banner action — the Top-up CTA (M6-G's LowCreditBanner anchor,
  // `low-credit-topup`). The wrapper listens in CAPTURE phase so the host
  // owns the policy without editing the peer component: a CTA click consumes
  // the current evidence (sends re-arm; the next POST is the re-check — the
  // server re-enforces the §8.8 gate) and the anchor still navigates to the
  // billing surface. The banner's own Dismiss does NOT re-arm sends (the
  // block is evidence, not the banner).
  const onBannerClickCapture = (event: ReactMouseEvent<HTMLElement>): void => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-testid="low-credit-topup"]') === null) return;
    if (evidence !== null) setConsumedEvidence(evidence);
  };

  // Bottom-row hint: while blocked the §12 message rides BOTH surfaces (the
  // low-credit banner carries the level-styled detail + the Buy-credits CTA;
  // this row keeps the pinned "message under the composer" and survives a
  // banner dismissal). The other locks keep their exact M4 hint semantics.
  const hint = creditsBlocked
    ? (evidence?.message ?? OUT_OF_CREDITS_MESSAGE)
    : (disabled?.message ?? (tooLong ? TOO_LONG_HINT : null));

  return (
    <div className="flex w-full flex-col gap-2" data-testid="chat-composer">
      {creditsBlocked ? (
        // M6-H — the M6-G LowCreditBanner (imported; the §8.8/§M6-task-4
        // low-credits surface). Both block paths mean the workspace cannot
        // fund a run (the §8.8 server gate fires at < 1 µc), so the banner
        // renders the zero-balance block copy with the Buy-credits CTA
        // linking to the billing surface. The wrapper (capture phase) owns
        // the re-arm policy — see onBannerClickCapture above.
        <div
          data-testid="chat-credits-block"
          data-block-source={evidence?.source}
          className="w-full"
          onClickCapture={onBannerClickCapture}
        >
          <LowCreditBanner
            balanceMicrocredits={0}
            allowanceMicrocredits={0}
            topUpHref={topUpHref}
          />
        </div>
      ) : null}

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
          // §9 envelope (96–160px): the token classes carry the min/max; the
          // useAutoGrow hook sizes inside them (autoGrowCapPx clamps the cap).
          className="min-h-[var(--chat-composer-min-h)] max-h-[var(--chat-composer-max-h)] overflow-y-auto pr-11"
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
        ) : (
          // M6-H: while blocked the banner carries the Top-up CTA (above) and
          // the send button stays the honest disabled send — the block never
          // fabricates a working affordance (the server 402s on the wire).
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
