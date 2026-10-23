/**
 * CreditMeter — §7.11 example gallery (documentation-as-code).
 *
 * Compact horizontal meter; the numeric balance is ALWAYS next to it; state
 * is never colour-only (icon + label for low and exhausted); top-up CTA is
 * optional. In the chat footer show the run estimate, not the whole balance.
 * Typecheck-only docs — never run by vitest.
 */
import { CreditMeter } from "./credit-meter";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function CreditMeterExample() {
  return (
    <section
      aria-label="Credit meter examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>States — healthy / low / exhausted (§7.11)</h3>
        <CreditMeter used={200} included={3200} state="healthy" />
        <CreditMeter used={950} included={1000} state="low" />
        <CreditMeter used={1000} included={1000} state="exhausted" />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Derived state — exhausted at 0, low below 10% remaining</h3>
        <CreditMeter used={500} included={1000} />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>With the top-up CTA (§7.11)</h3>
        <CreditMeter used={990} included={1000} onTopUp={() => {}} topUpLabel="Buy credits" />
      </div>
    </section>
  );
}
