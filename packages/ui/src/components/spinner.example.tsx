/**
 * Spinner — §7.13 example gallery (documentation-as-code).
 *
 * Loading indicator only — the label is announced through the implicit
 * `status` role of `<output>`. Rotation is removed under reduced motion
 * (§6.2). Typecheck-only docs — never run by vitest.
 */
import { Spinner } from "./spinner";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function SpinnerExample() {
  return (
    <section
      aria-label="Spinner examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Icon scale — 16 / 20 / 24 (§10)</h3>
        <div className="flex flex-wrap items-center gap-4">
          <Spinner size={16} />
          <Spinner size={20} />
          <Spinner size={24} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Context labels — announce what is loading (§12)</h3>
        <div className="flex flex-wrap items-center gap-4">
          <Spinner label="Saving version" />
          <Spinner label="Rendering frame 12" />
          <Spinner size={20} label="Uploading footage" />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Inline — “Working…” row (§7.1 loading copy)</h3>
        <div className="flex items-center gap-2 text-body-s text-secondary">
          <Spinner label="Applying plan" />
          <span>Working…</span>
        </div>
      </div>
    </section>
  );
}
