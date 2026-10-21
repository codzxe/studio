"use client";

// apps/web — brief textarea with a live character counter (W8-D).
//
// The brief is the run's prompt, capped at 8000 characters (§13.1 POST
// /v1/runs `prompt`; §5.7 caps user content). The counter is visible BEFORE
// submit so the cap is never a surprise — and the composer disables the run
// button while the gateway rules would reject the text (blank or over cap).

import { useId } from "react";
import { type BriefValidation, PROMPT_MAX_CHARS } from "./run-contract";

export interface BriefInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** True while a run is in flight — the textarea must not change intent. */
  readonly disabled?: boolean;
  /** Live validation of the current value (validateBrief, pure). */
  readonly validation: BriefValidation;
  /** Cap; defaults to the gateway's 8000 (W4-G CREATE_RUN_BODY_SCHEMA). */
  readonly maxChars?: number;
}

export function BriefInput({
  value,
  onChange,
  disabled = false,
  validation,
  maxChars = PROMPT_MAX_CHARS,
}: BriefInputProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const counterId = `${id}-counter`;
  const remaining = maxChars - value.length;
  // Warn as the cap approaches — colour, never silence (§16.2 truthfulness).
  const counterTone =
    remaining <= 0
      ? "text-red-600"
      : remaining <= Math.floor(maxChars / 10)
        ? "text-amber-600"
        : "text-muted-foreground";

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        Brief
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        disabled={disabled}
        required
        rows={6}
        maxLength={maxChars}
        aria-describedby={`${counterId} ${validation.error === null ? "" : errorId}`}
        aria-invalid={validation.error !== null}
        placeholder="Describe the outcome — what to make, the text it must contain, colours, where photos go…"
        className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex items-center justify-between gap-3">
        {validation.error === null ? (
          <p className="text-xs text-muted-foreground">
            Be specific — the agent works from this brief and validates its own output against it.
          </p>
        ) : (
          <p id={errorId} role="alert" className="text-xs text-red-600">
            {validation.error}
          </p>
        )}
        <p id={counterId} className={`shrink-0 font-mono text-xs ${counterTone}`}>
          {value.length.toLocaleString("en-US")} / {maxChars.toLocaleString("en-US")}
        </p>
      </div>
    </div>
  );
}
