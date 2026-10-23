/**
 * Badge / StatusDot / RiskBadge — §7.8 example gallery (documentation-as-code).
 *
 * Status is never colour-only (§3.1): every surface pairs a label with its
 * colour. Typecheck-only docs — never run by vitest.
 */
import { Badge, RiskBadge, StatusDot } from "./badge";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function BadgeExample() {
  return (
    <section
      aria-label="Badge examples"
      className="flex flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Badge variants (§7.8)</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral">Draft</Badge>
          <Badge variant="signal">Applied</Badge>
          <Badge variant="success">Completed</Badge>
          <Badge variant="warning">Low credits</Badge>
          <Badge variant="danger">Failed</Badge>
          <Badge variant="ice">Streaming</Badge>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>StatusDot — live states with a required label</h3>
        <div className="flex flex-col gap-2">
          <StatusDot tone="success">Agent applied 3 edits</StatusDot>
          <StatusDot tone="warning">Version expiring in 2 days</StatusDot>
          <StatusDot tone="danger">Render failed — missing asset</StatusDot>
          <StatusDot tone="ice" pulse>
            Agent is streaming
          </StatusDot>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>RiskBadge — chat plan risk (§7.8)</h3>
        <div className="flex flex-wrap items-center gap-2">
          <RiskBadge level="low" />
          <RiskBadge level="medium" />
          <RiskBadge level="high" />
          <RiskBadge level="high" label="Deletes 4 layers" />
        </div>
      </div>
    </section>
  );
}
