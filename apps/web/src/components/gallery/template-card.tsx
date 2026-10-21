"use client";

// Template gallery card (W8-J) — the §7.4 discovery shape from
// `GET /v1/templates` (NOT the full manifest): name, canvas size, slot
// chips, tags and the immutable `id@version` pin. "Use template" and
// "Manifest" are callbacks the gallery shell owns (compose preselect and
// the full inspect modal).

import { Badge, Button } from "@studio/ui";
import { aspectLabel, type TemplateCard } from "./use-catalog";

export interface TemplateCardViewProps {
  readonly card: TemplateCard;
  /** "Use template" → compose preselect (`?template=id@version`, W8-D). */
  readonly onUse: (card: TemplateCard) => void;
  /** "Manifest" → the full inspect payload modal. */
  readonly onInspect: (card: TemplateCard) => void;
}

export function TemplateCardView({ card, onUse, onInspect }: TemplateCardViewProps) {
  const ratio = aspectLabel(card.canvas.width, card.canvas.height);
  const size = `${card.canvas.width} × ${card.canvas.height} px${ratio === null ? "" : ` · ${ratio}`}`;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm">
      <header className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-tight">{card.name}</h3>
          <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
            {card.ref}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{size}</p>
      </header>

      {/* Decorative canvas-proportion preview (§7.2 canvas). */}
      <div
        aria-hidden="true"
        className="max-h-24 w-full rounded-md border border-border bg-surface-muted"
        style={{ aspectRatio: `${card.canvas.width} / ${card.canvas.height}` }}
      />

      <SlotChips slots={card.slots} />

      {card.tags.length > 0 ? (
        <p className="text-xs text-muted-foreground">{card.tags.map((tag) => `#${tag}`).join(" ")}</p>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="bg-accent text-accent-foreground hover:bg-accent/90"
          onClick={() => onUse(card)}
        >
          Use template
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-border bg-surface hover:bg-surface-muted"
          onClick={() => onInspect(card)}
        >
          Manifest
        </Button>
      </div>
    </article>
  );
}

function SlotChips({ slots }: { readonly slots: readonly string[] }) {
  if (slots.length === 0) {
    return <p className="text-xs text-muted-foreground">No slots</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Slots">
      {slots.map((slot) => (
        <li key={slot}>
          <Badge variant="outline" className="font-mono text-[10px]">
            {slot}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
