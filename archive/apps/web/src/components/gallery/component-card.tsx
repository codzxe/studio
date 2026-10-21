"use client";

// Component library card (W8-J) — the §8.2/§8.3 discovery shape from
// `GET /v1/components`: name, version pin, variable chips, comps and the
// default placement size. "Place in document" opens the document picker
// stub; "Manifest" the full inspect modal. Both are shell-owned callbacks.

import { Badge, Button } from "@studio/ui";
import { aspectLabel, type ComponentCard } from "./use-catalog";

export interface ComponentCardViewProps {
  readonly card: ComponentCard;
  /** "Place in document" → the document picker (modal stub, W8 editor). */
  readonly onPlace: (card: ComponentCard) => void;
  /** "Manifest" → the full inspect payload modal. */
  readonly onInspect: (card: ComponentCard) => void;
}

export function ComponentCardView({ card, onPlace, onInspect }: ComponentCardViewProps) {
  const ratio = aspectLabel(card.defaultSize.width, card.defaultSize.height);
  const size = `${card.defaultSize.width} × ${card.defaultSize.height} px${
    ratio === null ? "" : ` · ${ratio}`
  }`;
  const metaLines = [
    card.comps.length > 0 ? `Comps: ${card.comps.join(", ")}` : undefined,
    card.tags.length > 0 ? card.tags.map((tag) => `#${tag}`).join(" ") : undefined,
  ].filter((line) => line !== undefined);
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

      {/* Decorative default-size proportion preview (§8.2 defaultSize). */}
      <div
        aria-hidden="true"
        className="max-h-24 w-full rounded-md border border-border bg-surface-muted"
        style={{ aspectRatio: `${card.defaultSize.width} / ${card.defaultSize.height}` }}
      />

      <VariableChips variables={card.variables} />

      {metaLines.length > 0 ? (
        <p className="text-xs text-muted-foreground">{metaLines.join(" · ")}</p>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="bg-accent text-accent-foreground hover:bg-accent/90"
          onClick={() => onPlace(card)}
        >
          Place in document
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

function VariableChips({ variables }: { readonly variables: readonly string[] }) {
  if (variables.length === 0) {
    return <p className="text-xs text-muted-foreground">No variables</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Variables">
      {variables.map((name) => (
        <li key={name}>
          <Badge variant="outline" className="font-mono text-[10px]">
            {name}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
