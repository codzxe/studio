import { DEMO_FILM } from "@/lib/demo";

/**
 * The editor section frame (§8.1 §4): a full-bleed 16:9 dark frame with an
 * annotated viewport placeholder — construction-grid + safe-margin lines and
 * three labelled callouts. Deliberately NOT a fake screenshot (§16: honest
 * surfaces — no stylised fake editor UI); it reads as a diagram of the real
 * editor's regions. The real capture lands with the beta, same as
 * DEMO_FILM.
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
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <div className="absolute inset-[5%] border border-dashed border-subtle" />
      <div className="absolute inset-[10%] border border-dashed border-subtle/60" />
      <span className="absolute top-[5.5%] left-[5.5%] font-mono text-hint text-muted">
        ACTION SAFE
      </span>
      <span className="absolute top-[10.5%] right-[10.5%] font-mono text-hint text-muted">
        TITLE SAFE
      </span>
    </div>
  );
}

export function EditorFrame() {
  return (
    <div className="flex flex-col gap-4">
      <div
        data-testid="editor-frame"
        className="relative aspect-video overflow-hidden rounded-lg border border-border bg-page"
        role="img"
        aria-label="Diagram of the editor viewport: compositions on the left, keyframe timeline at the bottom, render queue on the right. A real capture lands here at launch."
      >
        <div className="editor-grid absolute inset-0" aria-hidden="true" />
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
          Timeless timeline. 306 effects. Runs in the browser.
          {DEMO_FILM.captureOwed ? " Real captures land here at launch." : ""}
        </p>
      </div>
    </div>
  );
}
