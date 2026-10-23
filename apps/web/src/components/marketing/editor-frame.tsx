/**
 * The editor section frame (§8.1 §4): a full-bleed 16:9 dark frame holding
 * the REAL editor capture (`/marketing/editor-frame.png`, 1600×900 from the
 * live build — W5-02) with three labelled DOM/CSS callouts pinned to the
 * real regions: compositions left, keyframe timeline bottom, render queue
 * right (§16: no stylised fake editor UI — this is the actual viewport).
 */

const CALLOUTS = [
  { label: "Compositions", className: "top-[22%] left-[7%]" },
  { label: "Keyframe timeline", className: "bottom-[16%] left-[30%]" },
  { label: "Render queue", className: "top-[38%] right-[7%]" },
] as const;

/** One annotated region: dot + 1px connector line + label chip. */
function Callout({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-0">
      <span aria-hidden="true" className="h-1 w-1 rounded-pill bg-signal" />
      <span aria-hidden="true" className="callout-line h-px w-6" />
      <span className="rounded-xs border border-border bg-app px-2 py-1 text-caption text-secondary">
        {label}
      </span>
    </span>
  );
}

/** Safe-margin construction lines — title safe (10%) and action safe (5%). */
function SafeMargins() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-[5%] border border-dashed border-subtle/40"
    >
      <div className="absolute inset-[10%] border border-dashed border-subtle/25" />
    </div>
  );
}

export function EditorFrame() {
  return (
    <div className="flex flex-col gap-4">
      <div
        data-testid="editor-frame"
        className="relative aspect-video overflow-hidden rounded-lg border border-border bg-page"
      >
        {/* The real editor — 1600×900 capture from the live build (W5-02). */}
        {/* eslint-disable-next-line @next/next/no-img-element — static public asset, no optimization needed */}
        <img
          src="/marketing/editor-frame.png"
          alt="The EffectCraft editor viewport: compositions panel on the left, keyframe timeline at the bottom, render queue on the right."
          width={1600}
          height={900}
          className="h-full w-full object-cover"
          loading="lazy"
        />
        <SafeMargins />

        {/* Slate corner — same honest reel marker as the hero film slot. */}
        <div className="absolute top-4 left-4 flex items-center gap-2 font-mono text-hint text-muted">
          <span className="tabular">VIEWPORT 01</span>
          <span aria-hidden="true">—</span>
          <span>1920 × 1080</span>
        </div>

        {/* Desktop: callouts pinned to the annotated regions. */}
        {CALLOUTS.map((callout) => (
          <div key={callout.label} className={`absolute hidden md:block ${callout.className}`}>
            <Callout label={callout.label} />
          </div>
        ))}

        {/* Mobile: the same callouts as a static row under the slate. */}
        <div className="absolute inset-x-4 bottom-4 flex flex-wrap gap-2 md:hidden">
          {CALLOUTS.map((callout) => (
            <Callout key={callout.label} label={callout.label} />
          ))}
        </div>
      </div>

      {/* Caption — the section's honest claim. */}
      <div className="flex flex-col gap-1">
        <p className="text-body-l text-primary">A full compositing editor, unmodified.</p>
        <p className="text-caption text-muted">
          Timeless timeline. 306 effects. Runs in the browser. Captured from the real build.
        </p>
      </div>
    </div>
  );
}
