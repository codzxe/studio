"use client";

/**
 * Edit cards — EDITOR_CHAT_UX §6.4 + §8.6 "clarify" (BUILD_PLAN §M5.7, M5-I).
 *
 * The two actionable cards of the agent-edit loop, mounted by the chat panel
 * slot above the composer (the peer thread owns the in-thread banners; these
 * are the composer-adjacent "needs your attention" surfaces):
 *
 * - `EditErrorCard`: a TYPED failure renders human, actionable copy — never a
 *   stack trace, absolute path, object key or internal id (law #1). Unknown or
 *   internal-looking payloads degrade to the generic §13 line ("this edit
 *   didn't go through; nothing changed") — a failed batch always rolls back
 *   (law #6), so the copy never claims more than that. Everything renders as
 *   DATA (React text nodes; no `dangerouslySetInnerHTML`, no raw strings in
 *   attributes).
 * - `ClarifyCard`: `EditPlan.intent === "clarify"` (§8.6) — the model asked one
 *   question; the card renders the question plus answer chips for the
 *   candidate layers (`affectedLayers`), each handing the parent an answer
 *   prompt through the `onAnswer` seam (the slot seeds the composer).
 */

import type { EditPlan } from "@studio/contracts";
import { Button } from "@studio/ui";
import { X } from "lucide-react";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Error card — typed failure → human copy (law #1)
// ---------------------------------------------------------------------------

export interface EditErrorFailure {
  /** The typed error code (envelope/tool seam-6/apply outcome). Never rendered. */
  readonly code: string;
  /** Optional human message; sanitized before it is ever shown. */
  readonly message?: string;
}

export interface EditErrorCardProps {
  readonly failure: EditErrorFailure;
  /** Offered only when the parent has a retry path (§6.4: "one retry"). */
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
}

/**
 * §13 copy for KNOWN codes only (codes evidenced in the codebase: run-state
 * RUN_PAUSED, provider THREAD_CREATE_FAILED, chat-controller NETWORK_ERROR,
 * §7.3 INSUFFICIENT_CREDITS / MODEL_NOT_ENTITLED / RATE_LIMITED, M5-E apply
 * 409 VERSION_CONFLICT). The raw `code` itself is NEVER rendered.
 */
const ERROR_COPY: Readonly<Record<string, string>> = {
  RUN_PAUSED: "The run paused. Check your connection and retry.",
  THREAD_CREATE_FAILED: "Could not start a new chat. Try again.",
  NETWORK_ERROR: "Could not reach the server. Retry in a moment.",
  INSUFFICIENT_CREDITS: "You're out of credits for this run. Top up to continue.",
  MODEL_NOT_ENTITLED: "This model isn't in your plan. Pick another model.",
  RATE_LIMITED: "Too many requests in a row. Wait a moment and retry.",
  VERSION_CONFLICT: "This project changed elsewhere. Reload to compare versions.",
};

/** Nothing human is longer than a plan summary (§8.6 bound). */
const MAX_HUMAN_MESSAGE_CHARS = 280;

/**
 * Markers of machine-shaped payloads: stack frames (`at fn(`), source
 * positions (`plan.rs:44`), object literals, package/source paths, hex
 * addresses. A message containing any of these is an internal leak — never
 * rendered. (Deliberately narrow: "Add overshoot at 0.45s" stays human.)
 */
const INTERNAL_MARKER =
  /node_modules|\bat [A-Za-z_$][\w$]*\s*\(|\.(rs|tsx?|jsx?|py|wasm):\d|\{\s*["{[]|\/home\/|\/Users\/|\/root\/|\/tmp\/|[A-Za-z]:\\\\|0x[0-9a-fA-F]{4,}/;

/**
 * Generic §6.4/§13 line — the honest claim for a failed agent edit: the batch
 * is atomic (law #6), so nothing changed.
 */
export const EDIT_ERROR_GENERIC_COPY =
  "This edit didn't go through. Nothing in the project changed.";

/**
 * Map a typed failure to the human copy that renders (pure, exported for
 * tests): curated copy for known codes; the message only when it is short and
 * looks human; the generic line otherwise. The `code` is never part of the
 * returned copy.
 */
export function humanizeEditError(failure: EditErrorFailure): string {
  const curated = ERROR_COPY[failure.code];
  if (curated !== undefined) return curated;
  const message = typeof failure.message === "string" ? failure.message.trim() : "";
  if (
    message !== "" &&
    message.length <= MAX_HUMAN_MESSAGE_CHARS &&
    !INTERNAL_MARKER.test(message)
  ) {
    return message;
  }
  return EDIT_ERROR_GENERIC_COPY;
}

export function EditErrorCard({
  failure,
  onRetry,
  onDismiss,
}: EditErrorCardProps): ReactElement {
  const copy = humanizeEditError(failure);
  return (
    <section
      data-testid="edit-error-card"
      role="alert"
      className="flex w-full items-start gap-2 rounded-sm border border-danger/40 bg-elevated px-3 py-2"
    >
      <p data-testid="edit-error-copy" className="min-w-0 flex-1 text-body-s text-primary">
        <span aria-hidden="true" className="mr-1 font-bold text-danger">
          !
        </span>
        {copy}
      </p>
      <div className="flex shrink-0 items-center gap-1">
        {onRetry !== undefined ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid="edit-error-retry"
            onClick={() => onRetry()}
          >
            Retry
          </Button>
        ) : null}
        {onDismiss !== undefined ? (
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Dismiss the error"
            data-testid="edit-error-dismiss"
            className="h-7 w-7 p-0 text-secondary hover:text-primary"
            onClick={() => onDismiss()}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Clarify card — EditPlan.intent === "clarify" (§8.6)
// ---------------------------------------------------------------------------

/** §6.4-style chips: at most four candidates keep the row one line. */
export const CLARIFY_ANSWER_CHIPS_MAX = 4;

/** The answer prompt a candidate chip hands the composer (deterministic). */
export function clarifyAnswerPrompt(name: string): string {
  return `Go with “${name}”.`;
}

export interface ClarifyCardProps {
  /** The plan with `intent === "clarify"`; anything else renders nothing. */
  readonly plan: EditPlan;
  /** The candidate the user picked, as an answer prompt for the composer. */
  readonly onAnswer: (answer: string) => void;
  readonly onDismiss?: () => void;
}

export function ClarifyCard({ plan, onAnswer, onDismiss }: ClarifyCardProps): ReactElement | null {
  // Defensive guard: the mounter keys off `intent === "clarify"`, but the card
  // itself never renders a non-clarify plan.
  if (plan.intent !== "clarify") return null;
  const candidates = plan.affectedLayers
    .map((layer) => layer.name)
    .filter((name) => typeof name === "string" && name.trim() !== "")
    .slice(0, CLARIFY_ANSWER_CHIPS_MAX);
  return (
    <section
      data-testid="edit-clarify-card"
      className="flex w-full flex-col gap-2 rounded-sm border border-strong bg-elevated px-3 py-2"
    >
      <div className="flex w-full items-start gap-2">
        <p
          data-testid="edit-clarify-question"
          className="min-w-0 flex-1 text-body-s text-primary"
        >
          <span aria-hidden="true" className="mr-1 text-muted">
            ?
          </span>
          {plan.summary}
        </p>
        {onDismiss !== undefined ? (
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Dismiss the question"
            data-testid="edit-clarify-dismiss"
            className="h-6 w-6 shrink-0 p-0 text-secondary hover:text-primary"
            onClick={() => onDismiss()}
          >
            <X size={13} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {candidates.length > 0 ? (
        <div
          data-testid="edit-clarify-answers"
          className="flex w-full flex-wrap gap-1.5"
          role="group"
          aria-label="Suggested answers"
        >
          {candidates.map((name, index) => (
            <button
              key={`${index}-${name}`}
              type="button"
              data-testid="edit-clarify-answer"
              data-answer={name}
              onClick={() => onAnswer(clarifyAnswerPrompt(name))}
              className="h-7 shrink-0 rounded-pill border border-border bg-input px-2.5 text-body-s text-secondary transition-colors duration-120 hover:border-border-strong hover:text-primary"
            >
              {name}
            </button>
          ))}
        </div>
      ) : (
        <p data-testid="edit-clarify-hint" className="text-caption text-muted">
          Answer with the composer below.
        </p>
      )}
    </section>
  );
}
