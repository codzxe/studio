import { StatusDot } from "./badge";
/**
 * Slate — §2.3 example gallery (documentation-as-code).
 *
 * The compact project header shaped like a film slate: name, duration, comp
 * count and a right-aligned status slot. Typecheck-only docs — never run by
 * vitest.
 */
import { Slate } from "./slate";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function SlateExample() {
  return (
    <section
      aria-label="Slate examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Canonical — name + duration · comps</h3>
        <Slate name="Launch film" duration="00:12:04" comps={3} />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>With a relative timestamp (§14)</h3>
        <Slate name="Launch film" duration="00:12:04" comps={3} updated="Updated 2h ago" />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>With a live status slot (§2.3/§7.8)</h3>
        <Slate name="Titles v4" duration="00:12:04" comps={3} updated="Updated 2h ago">
          <StatusDot tone="success">Render completed</StatusDot>
        </Slate>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Singular comp (§14 domain language)</h3>
        <Slate name="Teaser" duration="00:04" comps={1} />
      </div>
    </section>
  );
}
