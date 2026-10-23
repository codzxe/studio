/**
 * Field — §7.2/§12 example gallery (documentation-as-code).
 *
 * Field is the label / helper / error wiring used by Input, Textarea and
 * Select — and exported for custom controls via its render-prop contract.
 * Typecheck-only docs — never run by vitest.
 */
import { Field } from "./field";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function FieldExample() {
  return (
    <section
      aria-label="Field examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Label + helper on a custom control</h3>
        <Field id="ex-frame-rate" label="Frame rate" helperText="fps for the final render.">
          {(control) => (
            <select
              {...control}
              className="h-9 w-full rounded-sm border border-border bg-input px-2 text-body text-primary"
            >
              <option value="24">24 fps</option>
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
            </select>
          )}
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Required custom control — checkbox as an example</h3>
        <Field id="ex-terms" label="I accept the licence terms" required>
          {(control) => <input {...control} type="checkbox" className="h-4 w-4 accent-signal" />}
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Error replaces the helper and announces (§12)</h3>
        <Field id="ex-custom-error" label="Frame rate" error="Frame rate must be a number.">
          {(control) => (
            <input
              {...control}
              type="text"
              defaultValue="twenty four"
              className="h-9 w-full rounded-sm border border-danger bg-input px-2 text-body text-primary"
            />
          )}
        </Field>
      </div>
    </section>
  );
}
