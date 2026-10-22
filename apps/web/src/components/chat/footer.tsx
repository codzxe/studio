/**
 * The chat panel footer (M4-G2 — M4-SEAMS Seam 7 + Wave-2 UI contract,
 * EDITOR_CHAT_UX §3.5): one 28px status line
 * `<modelLabel> · <creditEstimate> · <shortcutHint>`
 * (e.g. "Smart · ~12 credits · ⌘↵ to send") in 13px muted text.
 *
 * M4-J feeds the segments: `modelLabel` via `modelDisplayName(activeModelId)`,
 * `creditEstimate` from the tokens/context estimate surface (M4-C), and the
 * shortcut hint for the platform (⌘↵ on macOS, Ctrl+↵ elsewhere). The credit
 * estimate is a projection — the tooltip says so ("Estimate; actual usage is
 * metered"); real metering is the §8.8 reserve→commit ledger.
 *
 * Purely presentational (no hooks, no client APIs) — safe in any render mode.
 */

import type { ReactElement } from "react";

/** Wave-2 pinned contract — the M4-J consumption surface (verbatim). */
export interface ChatFooterProps {
  modelLabel: string;
  creditEstimate: string;
  shortcutHint: string;
}

export function ChatFooter({ modelLabel, creditEstimate, shortcutHint }: ChatFooterProps): ReactElement {
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
      <span aria-hidden="true" className="shrink-0">
        {" · "}
      </span>
      <span
        data-testid="chat-footer-shortcut"
        className="ml-auto shrink-0 whitespace-nowrap"
      >
        {shortcutHint}
      </span>
    </footer>
  );
}
