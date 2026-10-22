/**
 * Plan card (M4-F) — EDITOR_CHAT_UX §6.2, but M4-informational ONLY
 * (docs/phases/M4-SEAMS.md scope reminder: the agent is READ-ONLY; apply is
 * M5). Read-only: risk badge, intent chip, numbered steps (titles only),
 * affected layers, credit estimate and the pinned M4 note — NO Apply/Cancel
 * buttons, no preview action.
 *
 * Exported surface (docs/phases/M4-SEAMS.md "Wave-2 UI contract", binding):
 *   PlanCardProps + PlanCard (applied is the literal `false` until M5 widens it).
 *
 * Visual language (UI_DESIGN_SYSTEM §9): plan cards sit on --bg-elevated with
 * a stronger border; high risk upgrades the border to danger and adds the
 * explicit "requires confirmation" line (colour is never the only signal).
 */

import type { EditPlan } from "@studio/contracts";
import { Badge } from "@studio/ui";
import type { ReactElement } from "react";

export interface PlanCardProps {
  plan: EditPlan;
  /** M4: always false — the apply path arrives with M5 (pinned literal). */
  applied: false;
  /** Footer note; defaults to the pinned M4 informational note. */
  note?: string;
}

const M4_NOTE = "Apply arrives with M5 — this plan is a preview.";

const RISK_LABEL: Record<EditPlan["risk"], string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** low = success tone, medium = amber, high = red (EDITOR_CHAT_UX §6.2). */
const RISK_VARIANT: Record<EditPlan["risk"], "success" | "warning" | "danger"> = {
  low: "success",
  medium: "warning",
  high: "danger",
};

export function PlanCard({ plan, applied, note = M4_NOTE }: PlanCardProps): ReactElement {
  const highRisk = plan.risk === "high";
  const intent = plan.intent.charAt(0).toUpperCase() + plan.intent.slice(1);
  return (
    <section
      data-testid="plan-card"
      data-applied={String(applied)}
      data-risk={plan.risk}
      data-intent={plan.intent}
      data-requires-approval={String(plan.requiresApproval)}
      className={`max-w-[72ch] rounded-sm border bg-elevated p-3 ${highRisk ? "border-danger" : "border-strong"}`}
    >
      <header className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-body-s text-primary">
          <span aria-hidden="true" className="mr-1 text-muted">
            ✦
          </span>
          <span className="font-semibold">Plan</span>
          <span aria-hidden="true" className="text-muted">
            {" · "}
          </span>
          <span className="text-secondary">{plan.summary}</span>
        </p>
        <Badge variant={RISK_VARIANT[plan.risk]} data-testid="plan-risk" className="shrink-0">
          {RISK_LABEL[plan.risk]}
        </Badge>
      </header>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant="neutral" data-testid="plan-intent">
          {intent}
        </Badge>
      </div>
      {highRisk ? (
        <p data-testid="plan-requires-confirmation" className="mt-2 text-caption text-danger">
          High risk — requires confirmation before it runs.
        </p>
      ) : null}
      <ol data-testid="plan-steps" className="mt-2 flex flex-col gap-1">
        {plan.steps.map((step, index) => (
          <li key={`${index}-${step.title}`} className="flex gap-2 text-body-s text-primary">
            <span aria-hidden="true" className="shrink-0 text-muted">
              {index + 1}.
            </span>
            <span className="min-w-0">{step.title}</span>
          </li>
        ))}
      </ol>
      {plan.affectedLayers.length > 0 ? (
        <p data-testid="plan-affected" className="mt-2 text-caption text-secondary">
          Affected: {plan.affectedLayers.map((layer) => layer.name).join(", ")}
        </p>
      ) : null}
      <p data-testid="plan-credits" className="mt-1 text-caption text-secondary">
        ≈ {plan.estimatedCredits} credits
      </p>
      <p
        data-testid="plan-note"
        className="mt-2 border-t border-subtle pt-2 text-caption text-muted"
      >
        {note}
      </p>
    </section>
  );
}
