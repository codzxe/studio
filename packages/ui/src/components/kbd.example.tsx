/**
 * Kbd — §4.2 example gallery (documentation-as-code).
 *
 * Keyboard key chips at the 11px hint scale — the only 11px text in the app
 * (§4.2). Typecheck-only docs — never run by vitest.
 */
import { Kbd } from "./kbd";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";
const rowClass = "flex flex-wrap items-center gap-2 text-caption text-muted";

export default function KbdExample() {
  return (
    <section
      aria-label="Kbd examples"
      className="flex flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Modifier combos</h3>
        <div className={rowClass}>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <span>open the command palette</span>
        </div>
        <div className={rowClass}>
          <Kbd>⇧</Kbd>
          <Kbd>1</Kbd>
          <span>switch to the first workspace</span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Single keys</h3>
        <div className={rowClass}>
          <Kbd>esc</Kbd>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <Kbd>↵</Kbd>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Composed hint row — palette footer</h3>
        <div className="flex flex-wrap items-center gap-4 text-hint text-muted">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            run
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd>
            close
          </span>
        </div>
      </div>
    </section>
  );
}
