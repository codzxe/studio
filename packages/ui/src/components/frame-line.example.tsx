/**
 * FrameLine — §2.3 example gallery (documentation-as-code).
 *
 * The signature element: a thin rule with a small tabular timecode label,
 * used as a section divider. `draw` plays the 240ms scaleX draw once when
 * the divider scrolls into view (§6.3). Typecheck-only docs.
 */
import { FrameLine } from "./frame-line";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function FrameLineExample() {
  return (
    <section
      aria-label="Frame line examples"
      className="flex max-w-2xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-4">
        <h3 className={labelClass}>Section dividers — timecode + section</h3>
        <FrameLine label="00:00:00 — WORKFLOW" draw />
        <p className="text-body-s text-secondary">The agent turns a brief into an editable plan.</p>
        <FrameLine label="00:00:12 — PRECISION" draw />
        <p className="text-body-s text-secondary">Every edit is one version, one undo step.</p>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className={labelClass}>Static — no draw animation</h3>
        <FrameLine label="00:00:24 — SHARE" />
        <p className="text-body-s text-secondary">Review links, comments and render history.</p>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className={labelClass}>Quiet usage — metadata rule only</h3>
        <FrameLine label="COMPS · 3 · RENDERED 2H AGO" />
      </div>
    </section>
  );
}
