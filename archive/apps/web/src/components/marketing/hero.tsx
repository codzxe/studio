// Marketing hero (W8-M) — spec §16.2 section 1: hero with a 20–40 s looping
// screen capture of prompt → layered result, SHOWING THE LAYERS PANEL, not
// just pixels. No real capture asset exists yet, so this renders an honest
// PLACEHOLDER <div> whose caption says exactly what the capture will show,
// plus a CSS mock of the layers panel (layer tree per §10.1 / §0).
//
// Truthfulness rules (§16.2): the mock is labeled as a mock; it never
// claims to be a real render; no competitor names; no "unlimited" claims.

import Link from "next/link";

// Layer tree the agent is required to produce (§10.1 "layer architecture
// the agent must produce" — Background / Photo / Content group / Brand
// group / Effects). Rendered top-to-bottom like a real layers panel
// (front-most layer first). This is the product promise, not decoration.
type MockLayer = {
  readonly name: string;
  readonly kind: "group" | "group-open" | "text" | "photo" | "component" | "fill" | "effects";
  readonly depth: number;
  readonly detail?: string;
};

const LAYER_TREE: readonly MockLayer[] = [
  { name: "Effects", kind: "effects", depth: 0, detail: "non-destructive" },
  { name: "Brand", kind: "group-open", depth: 0, detail: "group" },
  { name: "Logo", kind: "photo", depth: 1, detail: "smart object" },
  { name: "Badge", kind: "component", depth: 1, detail: "component" },
  { name: "Content", kind: "group-open", depth: 0, detail: "group" },
  { name: "Subhead", kind: "text", depth: 1, detail: "text" },
  { name: "Headline", kind: "text", depth: 1, detail: "text" },
  { name: "Photo — Latte", kind: "photo", depth: 0, detail: "smart object" },
  { name: "Background", kind: "fill", depth: 0, detail: "fill" },
] as const;

function glyph(kind: MockLayer["kind"]): string {
  switch (kind) {
    case "group-open":
      return "▾";
    case "group":
      return "▸";
    default:
      return "◦";
  }
}

export function Hero() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pt-16 pb-10 text-center" data-testid="marketing-hero">
      <p className="mb-4 inline-block rounded-full border border-border bg-surface-muted px-3 py-1 font-mono text-xs text-muted-foreground">
        prompt → layered document
      </p>

      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Prompt to layered design</h1>

      <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
        Describe the outcome. AI agents compose a real, layered document — named
        text, photos, shapes and masks you can open and keep editing. Never a
        flat AI image.
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/sign-up"
          className="rounded-md bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
        >
          Start with 30 trial credits
        </Link>
        <Link
          href="#pricing"
          className="rounded-md border border-border bg-surface px-5 py-3 text-sm font-semibold transition hover:bg-surface-muted"
        >
          See pricing
        </Link>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        One-time trial grant — no card required. Every action&apos;s credit cost is
        shown before you sign up.
      </p>

      {/*
        §16.2: 20–40 s looping screen capture of prompt → layers panel
        building. TODO(W8-M): record the real capture from the beta build
        and swap this placeholder for the <video>. Until then the placeholder
        shows the layer-tree mock below — it is clearly labeled, never
        presented as pixels we did not produce.
      */}
      <div
        className="mx-auto mt-12 max-w-4xl overflow-hidden rounded-lg border border-border bg-surface text-left"
        data-testid="marketing-hero-video-placeholder"
      >
        {/* prompt bar */}
        <div className="flex items-center gap-2 border-b border-border bg-surface-muted px-4 py-2.5">
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            prompt
          </span>
          <span className="font-mono text-sm">“a bold promo post for our coffee special”</span>
        </div>

        <div className="grid gap-0 sm:grid-cols-[1fr_260px]">
          {/* canvas mock — composed labeled boxes, not an image */}
          <div className="relative min-h-[260px] overflow-hidden border-b border-border sm:border-r sm:border-b-0" style={{ background: "#F4E7D3" }}>
            <div
              className="absolute inset-x-6 top-6 flex h-[120px] items-center justify-center rounded-sm text-xs text-white"
              style={{ background: "linear-gradient(135deg, #6B5748 0%, #3B2A20 100%)" }}
            >
              Photo — Latte
            </div>
            <div className="absolute inset-x-6 bottom-16">
              <div className="font-mono text-2xl font-bold" style={{ color: "#3B2A20" }}>
                Headline
              </div>
              <div className="mt-1 font-mono text-sm" style={{ color: "#6B5748" }}>
                Subhead
              </div>
            </div>
            <div
              className="absolute top-4 right-4 rounded-full px-3 py-1 font-mono text-xs font-semibold text-white"
              style={{ background: "#D96C3B" }}
            >
              Badge · 20% OFF
            </div>
            <div
              className="absolute bottom-4 left-6 h-6 w-16 rounded-sm border"
              style={{ borderColor: "#6B5748" }}
            >
              <span className="block px-1 font-mono text-xs leading-5" style={{ color: "#6B5748" }}>
                Logo
              </span>
            </div>
          </div>

          {/* layers panel mock — the point of the product (§10.1 tree) */}
          <div className="bg-surface">
            <div className="border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground">
              Layers
            </div>
            <ul className="py-1 font-mono text-xs">
              {LAYER_TREE.map((layer) => (
                <li
                  key={`${layer.name}-${layer.depth}`}
                  className="flex items-baseline justify-between gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0"
                  style={{ paddingLeft: `${12 + layer.depth * 14}px` }}
                >
                  <span className="truncate">
                    <span className="mr-1.5 text-muted-foreground">{glyph(layer.kind)}</span>
                    {layer.name}
                  </span>
                  {layer.detail ? (
                    <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-muted-foreground">
                      {layer.detail}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* required caption (§16.2) */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-muted px-4 py-2.5">
          <span className="font-mono text-xs">
            screen capture: prompt → layers panel building
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            placeholder — 20–40 s loop ships with the beta capture
          </span>
        </div>
      </div>
    </section>
  );
}
