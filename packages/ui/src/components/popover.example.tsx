/**
 * Popover — §7.6 example gallery (documentation-as-code).
 *
 * Elevated surface, 1px border, radius-md, 8px padding, elevation 1 (§7.6).
 * Typecheck-only docs — never run by vitest.
 */
import { useState } from "react";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function PopoverExample() {
  const [open, setOpen] = useState(false);

  return (
    <section
      aria-label="Popover examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Trigger-anchored popover — export settings</h3>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="secondary">Export settings</Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Export settings" className="w-64">
            <p className="text-body-s text-primary">Choose a format</p>
            <p className="mt-1 text-caption text-secondary">
              Formats follow the plan ladder: MP4 for members, PNG sequences on Studio.
            </p>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Info hint — Esc closes, focus trapped (§12)</h3>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost">What counts as a render?</Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Render definition" align="start" className="w-72">
            <p className="text-body-s text-primary">
              A render is one export of a pinned version — not a chat preview.
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-caption text-muted">
              Close with <Kbd>esc</Kbd>
            </p>
          </PopoverContent>
        </Popover>
      </div>
    </section>
  );
}
