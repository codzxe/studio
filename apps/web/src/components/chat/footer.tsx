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
 * CURRENT workspace balance. UNITS PIN (w3-b01) — the two honest sources
 * carry DIFFERENT units and are never mixed:
 *  1. The §7.4 terminal `credits` event the gateway emits when it settles a
 *     run (whole-credit DISPLAY units — gateway routes/chat.ts: "the SSE
 *     `credits` event carries whole-credit display units";
 *     `microcreditsToDisplayCredits` at the emitter, e.g. `42.5`), read from
 *     the ChatProvider context. In the ROUND-12 TURN WIRE this event never
 *     fires — `turn.completed` carries `credits: { committed }` only and the
 *     fold marks the balance UNKNOWN (NaN), so this source is skipped and
 *     the host prop below is the live truth. A host that wants a per-run
 *     refresh refetches the credits endpoint on the run-terminal transition
 *     (the app-shell `billing.state` pattern) and re-passes the prop — the
 *     footer never trusts a fabricated snapshot number.
 *  2. The optional `credits` prop — the value a host fetched from the
 *     credits endpoint (billingState / `GET /v1/credits`): integer
 *     MICROcredits on the wire (D-12), converted ONCE here, plus the plan's
 *     monthly allowance for the "of N/mo" context.
 * Unknown on both sides ⇒ the segment does not render (no fabricated
 * "0.00 credits left").
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
  // UNITS PIN (w3-b01): source 1 (the §7.4 `credits` event) carries
  // whole-credit DISPLAY units — format DIRECTLY, never through the µc
  // divider (the old code divided display credits by 10⁶, so a real 42.50
  // printed "0.00"). Source 2 (the host prop) carries integer µc (D-12,
  // the credits-endpoint contract) — convert ONCE here. The stream balance
  // is UNKNOWN (NaN) in the round-12 turn wire, so the prop — the real
  // credits-endpoint number — is the fallback; unknown on both sides
  // renders NO segment (never a fabricated "0.00 credits left").
  const streamBalanceCredits =
    streamCredits !== null && Number.isFinite(streamCredits.balance) ? streamCredits.balance : null;
  const propBalanceCredits = microcreditsToCreditsDisplay(credits?.balanceMicro ?? Number.NaN);
  const balanceCredits = streamBalanceCredits ?? propBalanceCredits;
  const balanceText =
    balanceCredits === null || !Number.isFinite(balanceCredits)
      ? null
      : formatCreditsDisplay(balanceCredits);
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
            data-exhausted={balanceCredits === 0 ? "true" : undefined}
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
