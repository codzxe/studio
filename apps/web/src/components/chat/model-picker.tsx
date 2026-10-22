"use client";

/**
 * The chat model picker (M4-G2 — M4-SEAMS Seam 7 header slice + the Wave-2 UI
 * contract, EDITOR_CHAT_UX §3.1) — the ONLY model surface in the chat chrome.
 *
 * Entitlement law (PRODUCT_ARCHITECTURE §8.2/§10.1, Seam 1 as-built item 7):
 * the list comes EXCLUSIVELY from the workspace models entitlement surface
 * (`GET /v1/models`, fetched by the page via `client.models.list()` — M4-A2).
 * This component never imports the api-client and never hardcodes a catalog:
 * M4-J injects the wire list through props, so a trial plan renders exactly
 * `[studio-fast]` and off-plan models are simply never on the wire (the
 * gateway already filters — trust the wire, never re-gate here).
 *
 * `models` semantics (pinned by the Wave-2 contract):
 *   - `null` → entitlement surface still loading → inert "Model…" trigger;
 *   - `[]`   → surface loaded but empty/failed → the picker is HIDDEN entirely;
 *   - one    → single-model plans still OPEN the picker, but the option
 *              renders as a selected/locked row with a "Your plan includes
 *              this model" note — there is nothing else to pick.
 *
 * Visual: tokens only (§10), popover via @studio/ui (bg-elevated, border,
 * radius-md, elevation 1); the active model carries the --signal ring.
 */

import { Check, ChevronDown, Eye, Sparkles, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, cn } from "@studio/ui";

/** Wave-2 pinned contract: one `GET /v1/models` wire item (M4-A2, Seam 1). */
export interface ModelsListEntry {
  id: string;
  tier: string;
  use: string;
  creditsPer1kInput: number;
  creditsPer1kOutput: number;
}

/** Wave-2 pinned contract: the picker surface ChatHeader (and M4-J) consume. */
export interface ModelPickerProps {
  models: readonly ModelsListEntry[] | null;
  activeModelId: string | null;
  onPick(id: string): void;
}

// ---------------------------------------------------------------------------
// Display helpers (exported for M4-J's footer + any other chrome)
// ---------------------------------------------------------------------------

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "studio-fast": "Fast",
  "studio-smart": "Smart",
  "studio-vision": "Vision",
};

/** Split on separators and title-case each word; "" when nothing remains. */
function prettify(value: string): string {
  const words = value
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** "studio-fast" → "Fast" (§8.2 aliases); unknown ids fall back to a prettified id. */
export function modelDisplayName(id: string): string {
  const known = DISPLAY_NAMES[id];
  if (known !== undefined) return known;
  return prettify(id) || id;
}

/** Wire tier ("fast") → short label ("Fast"); unknown tiers → prettified. */
export function modelTierLabel(tier: string): string {
  return prettify(tier) || tier;
}

// ---------------------------------------------------------------------------
// Rate formatting (§3.1 "compact … credit rate"; MODEL_CATALOG illustrative)
// ---------------------------------------------------------------------------

/** Shortest exact decimal ("0.01", "0.4"); rounds away float noise. */
function formatCredits(value: number): string {
  const rounded = Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value;
  return String(rounded);
}

/** "≈0.01–0.03 cr /1k tokens"; flat "≈1 cr /1k tokens" when both rates match. */
function formatRate(entry: ModelsListEntry): string {
  const input = formatCredits(entry.creditsPer1kInput);
  const output = formatCredits(entry.creditsPer1kOutput);
  return input === output
    ? `≈${input} cr /1k tokens`
    : `≈${input}–${output} cr /1k tokens`;
}

// ---------------------------------------------------------------------------
// Tier glyphs (§10: status never colour-only — glyph + name + tier tag)
// ---------------------------------------------------------------------------

const TIER_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  fast: Zap,
  smart: Sparkles,
  vision: Eye,
};

function TierGlyph({ tier, className }: { tier: string; className?: string }): ReactElement {
  const Glyph = TIER_GLYPHS[tier] ?? Sparkles;
  return <Glyph size={14} strokeWidth={1.75} aria-hidden="true" className={className} />;
}

// ---------------------------------------------------------------------------
// One option row
// ---------------------------------------------------------------------------

interface ModelOptionProps {
  entry: ModelsListEntry;
  /** The --signal ring + check (the active model, or the locked single option). */
  active: boolean;
  /** Single-model plan: rendered as a locked row, never a button. */
  locked: boolean;
  onPick(id: string): void;
}

function ModelOption({ entry, active, locked, onPick }: ModelOptionProps): ReactElement {
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <TierGlyph tier={entry.tier} className="shrink-0" />
        <span className="truncate text-body-s font-medium text-primary">
          {modelDisplayName(entry.id)}
        </span>
        <Badge
          variant="neutral"
          data-testid={`chat-model-tier-${entry.id}`}
          className="shrink-0"
        >
          {modelTierLabel(entry.tier)}
        </Badge>
        {active ? (
          <Check
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className="ml-auto shrink-0 text-signal"
          />
        ) : null}
      </span>
      <span className="truncate text-caption text-secondary">{entry.use}</span>
      <span className="tabular text-caption text-muted">{formatRate(entry)}</span>
    </>
  );

  const className = cn(
    "flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left",
    locked
      ? "cursor-default ring-1 ring-signal"
      : "cursor-pointer transition-colors duration-120 hover:bg-input focus-visible:outline-2 focus-visible:outline-signal",
    active && "ring-1 ring-signal",
  );

  if (locked) {
    return (
      <div
        className={className}
        data-testid={`chat-model-option-${entry.id}`}
        data-active={active || undefined}
        data-locked="true"
      >
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      data-testid={`chat-model-option-${entry.id}`}
      data-active={active || undefined}
      onClick={() => onPick(entry.id)}
    >
      {body}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ModelPicker
// ---------------------------------------------------------------------------

export function ModelPicker({
  models,
  activeModelId,
  onPick,
}: ModelPickerProps): ReactElement | null {
  const [open, setOpen] = useState(false);

  // Entitlement surface empty/failed → picker hidden entirely (pinned).
  if (models !== null && models.length === 0) return null;

  const single = models !== null && models.length === 1;
  const activeEntry = models?.find((entry) => entry.id === activeModelId) ?? null;
  const triggerLabel = activeEntry !== null ? modelDisplayName(activeEntry.id) : "Model…";

  const pick = (id: string): void => {
    setOpen(false);
    onPick(id);
  };

  const trigger = (
    <Button
      variant="secondary"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2"
      data-testid="chat-model-button"
      disabled={models === null}
      aria-label={activeEntry !== null ? `Model: ${triggerLabel}` : "Choose a model"}
    >
      {activeEntry !== null ? <TierGlyph tier={activeEntry.tier} /> : null}
      <span className="max-w-28 truncate">{triggerLabel}</span>
      <ChevronDown
        size={14}
        strokeWidth={2}
        aria-hidden="true"
        className="shrink-0 text-muted"
      />
    </Button>
  );

  // Loading (models === null): inert placeholder — no popover to open yet.
  if (models === null) return trigger;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-1.5"
        data-testid="chat-model-popover"
        aria-label="Choose a model"
      >
        <div className="flex flex-col gap-0.5">
          {models.map((entry) => (
            <ModelOption
              key={entry.id}
              entry={entry}
              active={entry.id === activeModelId || single}
              locked={single}
              onPick={pick}
            />
          ))}
        </div>
        {single ? (
          <p
            data-testid="chat-model-locked-note"
            className="mt-1.5 border-t border-border px-2 pt-1.5 text-caption text-muted"
          >
            Your plan includes this model
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
