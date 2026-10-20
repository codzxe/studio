// @studio/tools — ask_user (§6, model-orchestrated row + the note after row 18:
// "ask_user is a client-side affordance, not an engine tool"). Owner: W5-R.
//
// The agent calls ask_user when it lacks information that materially changes
// the outcome (§23.1 rule 10: "call ask_user once with specific options;
// otherwise make a reasonable choice and state it"; the planner prompt §23.2
// may also place it as the first step when the brief is ambiguous). This tool
// validates the question/options and returns a pause marker; it NEVER touches
// ctx.engine, ctx.db, or any other seam — the human answer loop is entirely
// the run manager's job, driven through the events seam.
//
// Run-pause contract (implemented by the worker/run manager, NOT here):
//   1. The run manager recognizes the call by tool NAME (`TOOLS.ask_user`)
//      before/at dispatch; no engine command may ever be derived from it.
//   2. On an ok result the run manager:
//       a. marks the run `awaiting_user` (paused — §5.2/§3.4 clocks stop while
//          the run waits, per run-manager policy),
//       b. emits ONE SSE event via the events seam (§13.2 envelope
//          `{ seq, run_id, at, type, payload }`) with
//          `type: "ask_user"` and `payload: { question, options }` — use
//          `askUserPauseEvent()` to build the payload,
//       c. persists the pending question so `GET /v1/runs/:id` can render it.
//   3. The client's answer comes back through the run API, is appended to the
//      run context as DATA — never as instructions (§5.7) — and the run
//      resumes with a fresh §3.4 deadline.
//   4. At most ONE ask_user per run (§23.1 rule 10); a second call should be
//      refused by the run manager, not by this tool (it stays stateless).
//
// Why the summary is JSON-in-a-string: `ok()` enforces the §6.1 compact-reply
// envelope whose summary is a capped string, so the structured pause marker
// `{ awaitingUser, options, question }` rides as one canonical JSON line —
// the same fleet precedent as template_apply/asset_place summaries. The run
// manager should key off the tool NAME; `parseAskUserSummary()` recovers the
// payload defensively for anything that only sees the result envelope.

import { z } from "zod";
import { cappedArray, cappedString, defineTool, ok, strictObject } from "../kit.js";
import { TOOLS } from "../registry.js";
import type { Tool } from "../types.js";

// ---------------------------------------------------------------------------
// Argument caps (task pin: question ≤ 300, 1–4 options, each ≤ 120)
// ---------------------------------------------------------------------------

/** The clarifying question, ≤ 300 chars (short enough to render in a card). */
export const MAX_QUESTION_CHARS = 300;
/** Each option label, ≤ 120 chars (a button caption, not a paragraph). */
export const MAX_OPTION_CHARS = 120;
/** Options are 1–4: zero never needs a pause; five is a form, not a question. */
export const MIN_OPTIONS = 1;
export const MAX_OPTIONS = 4;

const nonBlank = (value: string): boolean => value.trim().length > 0;

export const askUserArgsSchema = strictObject({
  question: cappedString(MAX_QUESTION_CHARS, 1).refine(nonBlank, {
    message: "question must not be blank",
  }),
  options: cappedArray(MAX_OPTIONS, cappedString(MAX_OPTION_CHARS, 1))
    .min(MIN_OPTIONS)
    .refine((options) => options.every(nonBlank), {
      message: "options must not be blank",
    }),
});

export type AskUserArgs = z.output<typeof askUserArgsSchema>;

// ---------------------------------------------------------------------------
// Pause marker (the ok summary) + its defensive reader
// ---------------------------------------------------------------------------

/** The structured pause marker serialized into the ok() summary string. */
export interface AskUserSummary {
  readonly awaitingUser: true;
  readonly question: string;
  readonly options: readonly string[];
}

/** Serializes the pause marker; keys are already in canonical sorted order. */
export function summarizeAskUser(question: string, options: readonly string[]): string {
  return JSON.stringify({ awaitingUser: true, options: [...options], question });
}

const ASK_USER_SUMMARY_SCHEMA = z.strictObject({
  awaitingUser: z.literal(true),
  question: z.string().min(1).max(MAX_QUESTION_CHARS),
  options: z.array(z.string().min(1).max(MAX_OPTION_CHARS)).min(MIN_OPTIONS).max(MAX_OPTIONS),
});

/**
 * Recovers the pause marker from a result summary — for run-manager code that
 * only sees the §6.1 envelope. Anything malformed (or another tool's summary)
 * yields `undefined`; this never throws.
 */
export function parseAskUserSummary(summary: string): AskUserSummary | undefined {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(summary);
  } catch {
    return undefined;
  }
  const parsed = ASK_USER_SUMMARY_SCHEMA.safeParse(parsedJson);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// SSE payload contract (events seam; built by the run manager, not this tool)
// ---------------------------------------------------------------------------

/** §13.2 event type the run manager emits when the run pauses. */
export const ASK_USER_EVENT_TYPE = "ask_user";

/** The `payload` of the ask_user SSE event; the envelope adds seq/run_id/at. */
export interface AskUserPauseEvent {
  readonly type: typeof ASK_USER_EVENT_TYPE;
  readonly question: string;
  readonly options: readonly string[];
}

/** Builds the exact SSE payload for the run manager from a parsed summary. */
export function askUserPauseEvent(summary: AskUserSummary): AskUserPauseEvent {
  return {
    type: ASK_USER_EVENT_TYPE,
    question: summary.question,
    options: [...summary.options],
  };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const askUserTool: Tool<AskUserArgs> = defineTool({
  name: TOOLS.ask_user,
  description:
    "Ask the user one clarifying question with 1-4 short options when the answer " +
    "materially changes the outcome; the run pauses until they answer.",
  args: askUserArgsSchema,
  async run(ctx, args) {
    // Affordance only: structured breadcrumbs, never engine payloads (§22).
    ctx.logger.debug("ask_user", { options: args.options.length });
    return ok({
      summary: summarizeAskUser(args.question, args.options),
      warnings:
        args.options.length < 2
          ? ["A single option makes the pause pointless; prefer 2-4 concrete options."]
          : undefined,
    });
  },
});
