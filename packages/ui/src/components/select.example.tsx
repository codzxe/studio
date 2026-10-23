/**
 * Select — §7.2 example gallery (documentation-as-code).
 *
 * The custom popover select (not native on desktop), its label/helper/error
 * wiring and every trigger size. Typecheck-only docs — never run by vitest.
 */
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "./select";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function SelectExample() {
  const [plan, setPlan] = useState("starter");

  return (
    <section
      aria-label="Select examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Controlled — grouped options, helper text</h3>
        <Select value={plan} onValueChange={setPlan}>
          <SelectTrigger id="ex-plan" label="Plan" helperText="Change any time." />
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Plans</SelectLabel>
              <SelectItem value="starter">Starter</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="studio">Studio</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Trigger sizes — sm 32 / md 36 / lg 44</h3>
        <Select defaultValue="starter">
          <SelectTrigger id="ex-size-sm" label="Plan" triggerSize="sm">
            Starter
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="starter">Starter</SelectItem>
            <SelectItem value="pro">Pro</SelectItem>
          </SelectContent>
        </Select>
        <Select defaultValue="pro">
          <SelectTrigger id="ex-size-md" label="Plan" triggerSize="md">
            Pro
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="starter">Starter</SelectItem>
            <SelectItem value="pro">Pro</SelectItem>
          </SelectContent>
        </Select>
        <Select defaultValue="studio">
          <SelectTrigger id="ex-size-lg" label="Plan" triggerSize="lg">
            Studio
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="starter">Starter</SelectItem>
            <SelectItem value="studio">Studio</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Error — aria-invalid + alert (§12)</h3>
        <Select defaultValue="starter">
          <SelectTrigger id="ex-error" label="Plan" error="Payment required to change plan." />
          <SelectContent>
            <SelectItem value="starter">Starter</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Required + disabled</h3>
        <Select defaultValue="starter">
          <SelectTrigger id="ex-required" label="Default plan" required />
          <SelectContent>
            <SelectItem value="starter">Starter</SelectItem>
          </SelectContent>
        </Select>
        <Select defaultValue="studio">
          <SelectTrigger id="ex-disabled" label="Locked plan" disabled>
            Studio
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="studio">Studio</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
