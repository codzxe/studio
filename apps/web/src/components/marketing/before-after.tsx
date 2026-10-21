// Before / after (W8-M) — spec §16.2 section 4: before/after (flat image
// vs editable layers). Rendered with CSS boxes only — no fake screenshots
// (§16.2 truthfulness: never present pixels we did not produce).

const FLAT_POINTS: readonly string[] = [
  "one merged bitmap — nothing to select or restyle",
  "text baked into pixels; a typo means a full regenerate",
  "no layer names, no groups, no history",
] as const;

const LAYERED_POINTS: readonly string[] = [
  "named layers and groups — Background, Photo, Content, Brand, Effects",
  "text stays editable text; photos stay replaceable smart objects",
  "masks and adjustments, non-destructive; one undo reverts a whole run",
] as const;

export function BeforeAfter() {
  return (
    <section
      id="before-after"
      className="mx-auto w-full max-w-6xl scroll-mt-16 px-6 py-14"
      data-testid="marketing-before-after"
    >
      <h2 className="text-2xl font-semibold tracking-tight">Flat image vs. editable layers</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        The same subject, two different products. One is pixels. The other is a
        document you can keep working in.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* BEFORE: flat AI image */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border bg-surface-muted px-4 py-2.5">
            <span className="text-sm font-semibold">A flat AI image</span>
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
              you get: pixels only
            </span>
          </div>
          {/* single merged block — nothing to edit */}
          <div className="relative min-h-[220px]" style={{ background: "#6B5748" }}>
            <div className="absolute inset-x-8 top-8 bottom-16 rounded-sm" style={{ background: "#3B2A20" }} />
            <div className="absolute inset-x-8 bottom-6 font-mono text-white">
              <div className="text-xl font-bold">Headline</div>
              <div className="mt-1 text-sm opacity-80">Subhead</div>
            </div>
            <span className="absolute top-4 right-4 rounded-full bg-white/20 px-2 py-0.5 font-mono text-xs text-white">
              merged bitmap
            </span>
          </div>
          <ul className="px-4 py-4">
            {FLAT_POINTS.map((point) => (
              <li key={point} className="mt-1 text-sm text-muted-foreground">
                — {point}
              </li>
            ))}
          </ul>
        </div>

        {/* AFTER: layered document */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border bg-surface-muted px-4 py-2.5">
            <span className="text-sm font-semibold">A layered document</span>
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
              you get: a document
            </span>
          </div>
          {/* same subject, but composed of named, selectable layers */}
          <div className="relative min-h-[220px]" style={{ background: "#F4E7D3" }}>
            <div
              className="absolute inset-x-8 top-8 flex h-[110px] items-center justify-center rounded-sm text-xs text-white"
              style={{ background: "linear-gradient(135deg, #6B5748 0%, #3B2A20 100%)" }}
            >
              Photo — Latte · smart object
            </div>
            <div className="absolute inset-x-8 bottom-12">
              <div className="font-mono text-xl font-bold" style={{ color: "#3B2A20" }}>
                Headline · text layer
              </div>
              <div className="mt-1 font-mono text-sm" style={{ color: "#6B5748" }}>
                Subhead · text layer
              </div>
            </div>
            <div
              className="absolute top-4 right-4 rounded-full px-3 py-1 font-mono text-xs font-semibold text-white"
              style={{ background: "#D96C3B" }}
            >
              Badge · component
            </div>
            <span className="absolute bottom-4 left-8 rounded-sm border px-2 py-0.5 font-mono text-xs" style={{ borderColor: "#6B5748", color: "#6B5748" }}>
              Background · fill
            </span>
          </div>
          <ul className="px-4 py-4">
            {LAYERED_POINTS.map((point) => (
              <li key={point} className="mt-1 text-sm text-muted-foreground">
                — {point}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Diagrams, not screenshots — the point is the structure, and the
        structure is exactly what you can open and edit.
      </p>
    </section>
  );
}
