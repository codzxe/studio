"use client";

// apps/web — template picker for "new document from template" (W8-D).
//
// Compact discovery cards straight from the gateway catalog (§13.1
// GET /v1/templates → TemplateCard, W4-J): name, the immutable `id@version`
// pin (§7.2), canvas size, slot count and tags — no manifests, no thumbnails
// (cards do not carry them). Selection is a radio group: one template or
// none, so a run's template choice is always unambiguous.

import type { TemplateCard } from "./run-contract";

export interface TemplatePickerProps {
  readonly templates: readonly TemplateCard[];
  readonly status: "loading" | "error" | "ready";
  /** User-safe error text for the `error` state (§13.3). */
  readonly errorMessage?: string;
  /** The selected pin (`id@version`), or null when nothing is selected. */
  readonly selectedRef: string | null;
  readonly onSelect: (card: TemplateCard) => void;
  readonly onReload?: () => void;
  readonly disabled?: boolean;
}

function TemplateCardTile({
  card,
  selected,
  disabled,
  onSelect,
}: {
  readonly card: TemplateCard;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (card: TemplateCard) => void;
}) {
  // Keep the card compact: at most three tags, then a "+N" overflow hint.
  const visibleTags = card.tags.slice(0, 3);
  const overflow = card.tags.length - visibleTags.length;
  return (
    <label
      className={
        selected
          ? "flex cursor-pointer flex-col gap-2 rounded-lg border border-accent bg-accent/10 p-3 transition hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
          : "flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
      }
    >
      <span className="flex w-full items-start justify-between gap-2">
        <input
          type="radio"
          name="template-ref"
          value={card.ref}
          checked={selected}
          disabled={disabled}
          onChange={() => {
            onSelect(card);
          }}
          className="sr-only"
        />
        <span className="text-sm font-semibold leading-snug">{card.name}</span>
        {/* Canvas-shaped placeholder keeps proportions honest at a glance. */}
        <span
          aria-hidden
          className="shrink-0 rounded border border-border bg-surface-muted"
          style={{
            aspectRatio: `${card.canvas.width} / ${card.canvas.height}`,
            width: card.canvas.width >= card.canvas.height ? "2.5rem" : "1.4rem",
          }}
        />
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">
        {card.ref} · {card.canvas.width}×{card.canvas.height} ·{" "}
        {card.slots.length} slot{card.slots.length === 1 ? "" : "s"}
      </span>
      {visibleTags.length === 0 && overflow <= 0 ? null : (
        <span className="flex flex-wrap gap-1">
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          {overflow > 0 ? (
            <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              +{overflow}
            </span>
          ) : null}
        </span>
      )}
    </label>
  );
}

export function TemplatePicker({
  templates,
  status,
  errorMessage,
  selectedRef,
  onSelect,
  onReload,
  disabled = false,
}: TemplatePickerProps) {
  if (status === "loading") {
    return (
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-busy>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span
            key={index}
            className="h-24 animate-pulse rounded-lg bg-surface-muted"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <p className="text-xs text-muted-foreground">
        The template catalog could not be loaded. {errorMessage ?? ""}
        {onReload === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              onReload();
            }}
            className="ml-2 font-medium text-foreground underline underline-offset-2"
          >
            Retry
          </button>
        )}
      </p>
    );
  }

  if (templates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No templates are published yet — check back soon, or create the
        document without one.
      </p>
    );
  }

  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-1 text-sm font-medium">
        Template
      </legend>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map((card) => (
          <TemplateCardTile
            key={card.ref}
            card={card}
            selected={card.ref === selectedRef}
            disabled={disabled}
            onSelect={onSelect}
          />
        ))}
      </div>
    </fieldset>
  );
}
