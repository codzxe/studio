// Template gallery (W8-M) — spec §16.2 section 3: "template gallery with
// real outputs downloadable as .pcraft".
//
// HONESTY NOTE (§16.2 truthfulness): the featured entries below are the
// REAL template manifests that ship in the repo (id@version, canvas, slot
// names — sourced from the template authors' worklog entries, not invented).
// No fake thumbnails and no dead download links: sample .pcraft binaries and
// rendered previews publish with the asset pipeline — TODO(W8-M): wire the
// download route when real sample outputs exist. Until then the download
// affordance is a disabled label, never a fake link.

type FeaturedTemplate = {
  readonly pin: string;
  readonly name: string;
  readonly set: string;
  readonly canvas: string;
  readonly slots: readonly string[];
};

const FEATURED: readonly FeaturedTemplate[] = [
  {
    pin: "youtube-thumbnail@1",
    name: "YouTube thumbnail",
    set: "web",
    canvas: "1280 × 720",
    slots: ["photo", "headline", "badge (optional)"],
  },
  {
    pin: "presentation-slide@1",
    name: "Presentation slide",
    set: "presentation",
    canvas: "1920 × 1080",
    slots: ["title", "subtitle", "visual", "logo"],
  },
  {
    pin: "event-flyer@1",
    name: "Event flyer",
    set: "print",
    canvas: "A5 · 1748 × 2480 @ 300 dpi",
    slots: ["photo", "headline", "date", "venue", "QR badge"],
  },
  {
    pin: "product-poster@1",
    name: "Product poster",
    set: "print",
    canvas: "A4 · 2480 × 3508 @ 300 dpi",
    slots: ["headline", "subhead", "photo", "price tag"],
  },
  {
    pin: "business-card@1",
    name: "Business card",
    set: "print",
    canvas: "1063 × 652 · 3.5 × 2 in @ 300 dpi",
    slots: ["name", "title", "contact", "logo", "accent colour"],
  },
  {
    pin: "blog-cover@1",
    name: "Blog cover",
    set: "web",
    canvas: "1200 × 630",
    slots: ["headline", "category badge", "byline", "avatar"],
  },
] as const;

export function TemplateGallery() {
  return (
    <section
      id="templates"
      className="mx-auto w-full max-w-6xl scroll-mt-16 px-6 py-14"
      data-testid="marketing-template-gallery"
    >
      <h2 className="text-2xl font-semibold tracking-tight">Start from a template</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        The agent fills real template manifests — every slot lands on a named,
        editable layer. 15+ templates ship today across social, print, web and
        presentation sets, and your workspace can register its own.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURED.map((template) => (
          <article key={template.pin} className="flex flex-col rounded-lg border border-border bg-surface p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold">{template.name}</h3>
              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
                {template.set}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{template.pin}</p>
            <p className="mt-3 text-sm text-muted-foreground">{template.canvas}</p>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {template.slots.map((slot) => (
                <li
                  key={slot}
                  className="rounded bg-surface-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
                >
                  {slot}
                </li>
              ))}
            </ul>
            {/* TODO(W8-M): real rendered previews + .pcraft sample downloads
                ship with the asset pipeline; a dead href would be dishonest. */}
            <p className="mt-4 border-t border-border pt-3 font-mono text-xs text-muted-foreground">
              sample .pcraft download — ships with the beta
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
