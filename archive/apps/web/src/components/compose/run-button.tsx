"use client";

// apps/web — the run button + typed failure feedback (W8-D).
//
// §16.2 truthfulness at the point of commitment: the button itself states the
// credit cost before the run starts ("Run — 2 credits"). Every failure of
// POST /v1/runs renders from the typed RunCreateError states:
//   402 insufficient_credits → server message + the credits top-up CTA (§14.2
//     rule 1: the run never started)
//   429 rate_limited → the cool-down window parsed from the envelope
//     (§13.3 Retry-After)
// Nothing else leaks — no codes, no stack traces, no internal ids (§13.3).

import Link from "next/link";
import { CREDITS_ROUTE, type ComposableTier, type RunCreateError } from "./run-contract";

export interface RunButtonProps {
  readonly tier: ComposableTier;
  /** §5.2 resolved credit cost of the selected tier (creditsForTier). */
  readonly credits: number;
  readonly pending: boolean;
  /** True while the form cannot submit yet (no target / invalid brief). */
  readonly disabled: boolean;
  readonly error: RunCreateError | null;
  readonly onSubmit: () => void;
  /** Offered on non-pending errors; clears the message and remints the key. */
  readonly onDismissError?: () => void;
}

function RetryAfterNote({ seconds }: { readonly seconds: number | null }) {
  return (
    <span className="ml-1">
      {seconds === null
        ? "Try again shortly."
        : `You can retry in ${String(seconds)} second${seconds === 1 ? "" : "s"}.`}
    </span>
  );
}

/** One typed failure → its user-facing feedback block. */
function RunErrorFeedback({ error }: { readonly error: RunCreateError }) {
  switch (error.kind) {
    case "insufficient_credits":
      return (
        <p role="alert" className="text-sm text-red-600">
          {error.message}{" "}
          {/* TODO(wiring, billing wave): native <a> until /credits exists —
              typedRoutes (next.config.ts) types only existing routes. */}
          <a
            href={CREDITS_ROUTE}
            className="font-medium text-foreground underline underline-offset-2"
          >
            Top up credits
          </a>
          <span className="text-muted-foreground"> to start this run.</span>
        </p>
      );
    case "rate_limited":
      return (
        <p role="alert" className="text-sm text-red-600">
          {error.message}
          <RetryAfterNote seconds={error.retryAfterSec} />
        </p>
      );
    case "auth":
      return (
        <p role="alert" className="text-sm text-red-600">
          {error.message}{" "}
          <Link
            href="/sign-in"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Sign in
          </Link>
          <span className="text-muted-foreground"> to continue.</span>
        </p>
      );
    case "validation":
    case "conflict":
    case "not_found":
      return (
        <p role="alert" className="text-sm text-red-600">
          {error.message}
          {error.hint === undefined ? null : (
            <span className="text-muted-foreground"> {error.hint}</span>
          )}
        </p>
      );
    case "network":
    case "server":
      return (
        <p role="alert" className="text-sm text-red-600">
          {error.message}
        </p>
      );
    default:
      return (
        <p role="alert" className="text-sm text-red-600">
          {error.message}
        </p>
      );
  }
}

export function RunButton({
  tier,
  credits,
  pending,
  disabled,
  error,
  onSubmit,
  onDismissError,
}: RunButtonProps) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => {
          onSubmit();
        }}
        disabled={pending || disabled}
        className="w-full rounded-md bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending
          ? "Starting the run…"
          : // §16.2: the cost is on the commitment button itself.
            `Run ${tier} — ${credits} credit${credits === 1 ? "" : "s"}`}
      </button>
      {error === null ? null : (
        <div className="space-y-1">
          <RunErrorFeedback error={error} />
          {pending || onDismissError === undefined ? null : (
            <button
              type="button"
              onClick={() => {
                onDismissError();
              }}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
