/**
 * Tooltip — §7.6 example gallery (documentation-as-code).
 *
 * Wrap the region once in <TooltipProvider> with the 250ms default delay. A
 * tooltip is a hint, NEVER the only source of an accessible name — label the
 * trigger itself (aria-label / visible text). Typecheck-only docs.
 */
import { Ellipsis, Info, Trash } from "lucide-react";
import { Button } from "./button";
import {
  TOOLTIP_DELAY_MS,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function TooltipExample() {
  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <section
        aria-label="Tooltip examples"
        className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
      >
        <div className="flex flex-col gap-3">
          <h3 className={labelClass}>Icon-only button — aria-label + tooltip hint (§7.1/§7.6)</h3>
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="iconSm" variant="ghost" aria-label="More project actions">
                  <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>More project actions</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="secondary" aria-label="Delete version 4">
                  <Trash size={16} strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Deletes version 4 — a later version stays</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className={labelClass}>Text trigger with a clarifying hint</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="link">Usage limits</Button>
            </TooltipTrigger>
            <TooltipContent>Minutes reset on the 1st of each month</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className={labelClass}>Side + collision avoidance defaults</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" aria-label="Plan details">
                <Info size={16} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Starter includes 30 render minutes</TooltipContent>
          </Tooltip>
        </div>
      </section>
    </TooltipProvider>
  );
}
