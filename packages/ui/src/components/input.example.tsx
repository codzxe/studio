/**
 * Input / SearchInput — §7.2 example gallery (documentation-as-code).
 *
 * Every size, the helper + error wiring, and the ⌘K search hint in one
 * token-styled file. Typecheck-only docs — never run by vitest.
 */
import { Input, SearchInput } from "./input";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function InputExample() {
  return (
    <section
      aria-label="Input examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Sizes — sm 32 / md 36 / lg 44</h3>
        <Input id="ex-input-sm" label="Project name" inputSize="sm" />
        <Input id="ex-input-md" label="Project name" inputSize="md" />
        <Input id="ex-input-lg" label="Project name" inputSize="lg" />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Label + helper (§7.2: labels above, never placeholder-only)</h3>
        <Input
          id="ex-slug"
          label="Workspace slug"
          helperText="Lowercase, no spaces"
          placeholder="studio"
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Required + error (§12: announced, danger colour)</h3>
        <Input
          id="ex-email"
          label="Email"
          required
          error="Enter a valid email"
          helperText="We never share it"
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Disabled</h3>
        <Input id="ex-disabled" label="Plan" disabled defaultValue="Studio" />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Search — leading icon + ⌘K hint</h3>
        <SearchInput id="ex-search" label="Search projects" placeholder="Search projects…" />
        <SearchInput
          id="ex-search-palette"
          label="Search in palette"
          placeholder="Search…"
          hideShortcut
        />
      </div>
    </section>
  );
}
