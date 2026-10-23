/**
 * Button — §7.1 example gallery (documentation-as-code).
 *
 * Storybook-style single-file showcase: one default export rendering the
 * canonical usage of every variant / size / state, styled only with design
 * tokens. Example files are typecheck-only docs — the vitest include pattern
 * only matches *.test.{ts,tsx} files, so these never run as tests.
 */
import { Ellipsis, Plus } from "lucide-react";
import { Button } from "./button";

const groupClass = "flex flex-wrap items-center gap-3";
const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function ButtonExample() {
  return (
    <section
      aria-label="Button examples"
      className="flex flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      {/* One primary (signal) action per view (§3.1) — the rest support it. */}
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Variants</h3>
        <div className={groupClass}>
          <Button variant="primary">Create project</Button>
          <Button variant="secondary">Import .ecproj</Button>
          <Button variant="ghost">Dismiss</Button>
          <Button variant="danger">Delete project</Button>
          <Button variant="link">View licences</Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Sizes — sm 28 / md 36 / lg 44</h3>
        <div className={groupClass}>
          <Button size="sm">Small action</Button>
          <Button size="md">Save version</Button>
          <Button size="lg">Open editor</Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Icon-only — 32 / 36px, always aria-label (§7.1)</h3>
        <div className={groupClass}>
          <Button size="iconSm" variant="ghost" aria-label="New project">
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button size="icon" variant="secondary" aria-label="More actions">
            <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>States — loading keeps width, disabled dims to .45</h3>
        <div className={groupClass}>
          <Button loading>Rendering</Button>
          <Button disabled>Buy credits</Button>
          <Button variant="danger" disabled loading={false}>
            Delete project
          </Button>
        </div>
      </div>
    </section>
  );
}
