"use client";

// apps/web — run tier selector with the pre-run cost display (W8-D).
//
// §16.2 truthfulness applied to runs: the credit cost of every tier is shown
// BEFORE the run starts, resolved to real numbers — quick 1 / standard 2 /
// complex 5 / premium ×2 standard = 4 / max ×4 standard = 8 (§5.2, §14.1,
// §14.4 pins). Wall-clock and tool-call budgets come from the same §5.2 rows,
// so "what am I buying" and "what will it cost" are answered together.
//
// Selection stays enabled when the balance cannot cover a tier — the gateway
// is the money authority (§14.2 rule 1, 402) and disabling here would only
// hide the shortfall; the unaffordable badge makes it explicit instead.

import { type ComposableTier, TIER_COSTS, isTierUnaffordable } from "./run-contract";

export interface TierSelectorProps {
  readonly value: ComposableTier;
  readonly onChange: (tier: ComposableTier) => void;
  /**
   * Workspace balance (GET /v1/credits), undefined while loading — used only
   * for the per-tier affordability badge, never to block selection.
   */
  readonly balance: number | undefined;
  readonly disabled?: boolean;
}

/** Cost line: resolved credits, with the multiplier kept visible (§14.1). */
function costLabel(credits: number, multiplied: boolean): string {
  return multiplied
    ? `${credits} credits (×${credits / 2} standard)`
    : `${credits} credit${credits === 1 ? "" : "s"}`;
}

export function TierSelector({ value, onChange, balance, disabled = false }: TierSelectorProps) {
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-1 text-sm font-medium">Speed &amp; quality tier</legend>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {TIER_COSTS.map((tier) => {
          const selected = tier.tier === value;
          const unaffordable = isTierUnaffordable(tier.tier, balance);
          return (
            <label
              key={tier.tier}
              className={
                selected
                  ? "flex cursor-pointer flex-col gap-1 rounded-lg border border-accent bg-accent/10 p-3 transition hover:bg-accent/15"
                  : "flex cursor-pointer flex-col gap-1 rounded-lg border border-border bg-surface p-3 transition hover:bg-surface-muted"
              }
            >
              <span className="flex w-full items-center justify-between gap-2">
                <input
                  type="radio"
                  name="run-tier"
                  value={tier.tier}
                  checked={selected}
                  onChange={() => {
                    onChange(tier.tier);
                  }}
                  className="sr-only"
                />
                <span className="text-sm font-semibold capitalize">{tier.tier}</span>
                {/* §16.2: the credit cost is the loudest thing on the card. */}
                <span className="font-mono text-xs font-semibold text-foreground">
                  {costLabel(tier.credits, tier.multiplied)}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">{tier.modelLabel}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {tier.wallClockMin} min · {tier.toolCallCap} tool calls · {tier.revisions} revision
                {tier.revisions === 1 ? "" : "s"}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">{tier.summary}</span>
              {unaffordable ? (
                <span className="text-[11px] font-medium text-amber-600">
                  Needs {tier.credits} credits — below your current balance
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
