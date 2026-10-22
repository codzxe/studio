"use client";

/**
 * The chat panel footer (M4-G2 — M4-SEAMS Seam 7 + Wave-2 UI contract,
 * EDITOR_CHAT_UX §3.5): one 28px status line
 * `<modelLabel> · <creditEstimate> · <balance?> · <shortcutHint>`
 * (e.g. "Smart · ~12 credits · 42.50 credits left · ⌘↵ to send") in 13px muted
 * text.
 *
 * M4-J feeds the segments: `modelLabel` via `modelDisplayName(activeModelId)`,
 * `creditEstimate` from the tokens/context estimate surface (M4-C), and the
 * shortcut hint for the platform (⌘↵ on macOS, Ctrl+↵ elsewhere). The credit
 * estimate is a projection — the tooltip says so ("Estimate; actual usage is
 * metered"); real metering is the §8.8 reserve→commit ledger.
 *
 * M6-H (BUILD_PLAN §M6 task 4; D-12): the OPTIONAL balance segment shows the
 * CURRENT workspace balance — integer microcredits at the wire, converted to
 * whole credits with up to 2 decimals for display (the D-12 rule; `GET /v1/credits`
 * and `GET /v1/billing/state` report the same µc numbers). Two honest sources,
 * freshest wins:
 *  1. The §7.4 terminal `credits` event the gateway emits when it settles a
 *     run (it carries the post-run `balance`) — read from the ChatProvider
 *     context, so the display refreshes after EVERY run with zero polling
 *     (no intervals, no extra fetch; the run-terminal refresh IS the event).
 *  2. The optional `credits` prop — the value a host fetched from
 *     billingState/credits (initial display before the first run, plus the
 *     plan's monthly allowance for the "of N/mo" context).
 *
 * Null-tolerant context read (the thread.tsx pattern): a provider-less mount
 * (tests, embeds) renders the exact M4 three-segment line.
 */

import {
  formatCreditsDisplay,
  microcreditsToCreditsDisplay,
} from "@/components/billing/ledger-table";
import { ChatApiContext } from "@/lib/chat/provider";
import { latestCreditsSnapshot } from "@/lib/chat/run-state";
import { type ReactElement, useContext } from "react";

/**
 * M6-H: µc → the 2-decimal display string (D-12), via the billing tree's
 * single conversion (`components/billing/ledger-table.tsx` — imported, not
 * duplicated, so the footer and the billing page format identical numbers
 * identically). TOTAL (never throws): hostile or negative input → `null` →
 * the segment does not render (no fabricated balances; a negative zero can
 * never leak as "-0.00").
 */
export function formatMicrocredits(micro: number): string | null {
  if (!Number.isFinite(micro) || micro < 0) return null;
  const credits = microcreditsToCreditsDisplay(micro);
  if (credits === null || !Number.isFinite(credits)) return null;
  return formatCreditsDisplay(credits);
}

/** Plan allowances are whole credits (the catalog): "500.00" → "500/mo". */
function formatAllowance(micro: number | null | undefined): string | null {
  const text = micro === null || micro === undefined ? null : formatMicrocredits(micro);
  if (text === null) return null;
  return text.endsWith(".00") ? text.slice(0, -3) : text;
}

/** Wave-2 pinned contract — the M4-J consumption surface (verbatim). */
export interface ChatFooterProps {
  modelLabel: string;
  creditEstimate: string;
  shortcutHint: string;
  /**
   * M6-H optional seam (documented for the slot owner): host-fetched billing
   * numbers in integer microcredits (D-12). Absent → the footer shows the
   * stream-derived balance only (after the first run of the session).
   */
  credits?: ChatFooterCredits | null;
}

/** M6-H: the host-supplied billing context (see {@link ChatFooterProps.credits}). */
export interface ChatFooterCredits {
  /** Workspace balance in µc; `null` when the host could not load it. */
  readonly balanceMicro: number | null;
  /** The plan's monthly allowance in µc — the "N/mo included" context. */
  readonly planAllowanceMicro?: number | null;
}

function balanceTitle(allowanceCredits: string | null): string {
  return allowanceCredits === null
    ? "Current balance — refreshed after each run"
    : `Current balance — refreshed after each run. Plan includes ${allowanceCredits} credits monthly`;
}

export function ChatFooter({
  modelLabel,
  creditEstimate,
  shortcutHint,
  credits = null,
}: ChatFooterProps): ReactElement {
  // Null-tolerant: the provider-less mount keeps the exact M4 line (no hooks
  // that throw, no client APIs — the data rides the provider's SSE folds).
  const chatApi = useContext(ChatApiContext);
  const streamCredits = chatApi === null ? null : latestCreditsSnapshot(chatApi.snapshot);
  // Freshest wins: the terminal §7.4 credits event (post-run) beats the
  // host-fetched prop (fetched at panel open, may be stale by a run).
  const balanceMicro =
    streamCredits !== null ? streamCredits.balance : (credits?.balanceMicro ?? null);
  const balanceText = balanceMicro === null ? null : formatMicrocredits(balanceMicro);
  const allowanceText = formatAllowance(credits?.planAllowanceMicro);

  return (
    <footer
      data-testid="chat-footer"
      aria-label="Chat run status"
      className="flex h-7 shrink-0 items-center overflow-hidden border-t border-border bg-panel px-3 text-body-s text-muted"
    >
      <span data-testid="chat-footer-model" className="min-w-0 truncate whitespace-nowrap">
        {modelLabel}
      </span>
      <span aria-hidden="true" className="shrink-0">
        {" · "}
      </span>
      <span
        data-testid="chat-footer-credits"
        title="Estimate; actual usage is metered"
        className="min-w-0 truncate whitespace-nowrap"
      >
        {creditEstimate}
      </span>
      {balanceText !== null ? (
        <>
          <span aria-hidden="true" className="shrink-0">
            {" · "}
          </span>
          <span
            data-testid="chat-footer-balance"
            data-exhausted={balanceMicro === 0 ? "true" : undefined}
            title={balanceTitle(allowanceText)}
            className="min-w-0 truncate whitespace-nowrap"
          >
            {`${balanceText} credits left`}
            {allowanceText !== null ? ` · ${allowanceText}/mo included` : ""}
          </span>
        </>
      ) : null}
      <span aria-hidden="true" className="shrink-0">
        {" · "}
      </span>
      <span data-testid="chat-footer-shortcut" className="ml-auto shrink-0 whitespace-nowrap">
        {shortcutHint}
      </span>
    </footer>
  );
}
