"use client";

// apps/web — plan card (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §5.5   the rendered plan fields — intent, template, checks, notes_for_user
//          (+ slots/palette/typography/steps context), and the "agent
//          deviated from plan" badge: executor deviations are "a normal,
//          inspectable event", never hidden.
//   §13.2  run.plan events fill this card live while the run is planning.
//
// Optimistic states: a skeleton while the run is active and no plan has
// arrived yet; an explicit empty state when the run ended unplanned (e.g.
// cancelled while queued, or the planner failed validation).

import { TriangleAlert } from "lucide-react";
import type { PlanIntentName, PlanView, RunTimeline } from "./timeline-state";

const INTENT_LABELS: Readonly<Record<PlanIntentName, string>> = {
  create_post: "Create a post",
  edit_layers: "Edit layers",
  resize: "Resize",
  variant: "Create a variant",
  export: "Export",
};

/** §6.1-style hex guard before any palette colour reaches an inline style. */
function safeHex(value: string): string | null {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : null;
}

export interface PlanCardProps {
  readonly timeline: RunTimeline;
}

function PlanSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Waiting for the plan"
      className="rounded-lg border border-border bg-surface p-5"
    >
      <div className="mb-3 h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="mb-2 h-3 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      <p className="mt-3 text-xs text-muted-foreground">The agent is drafting a plan…</p>
    </section>
  );
}

function PlanBody({ plan }: { readonly plan: PlanView }) {
  const slotNames = Object.keys(plan.slots);
  const swatches = plan.palette
    .map((color) => safeHex(color))
    .filter((color): color is string => color !== null)
    .slice(0, 8);

  return (
    <div className="mt-3 space-y-3 text-sm">
      <dl className="grid grid-cols-[max-content,1fr] items-baseline gap-x-3 gap-y-1.5">
        <dt className="text-xs font-medium text-muted-foreground">Intent</dt>
        <dd>{INTENT_LABELS[plan.intent]}</dd>
        <dt className="text-xs font-medium text-muted-foreground">Template</dt>
        <dd className="font-mono text-xs">
          {plan.template ?? <span className="text-muted-foreground">Freeform — no template</span>}
        </dd>
        {plan.modelTier === null ? null : (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Model tier</dt>
            <dd className="font-mono text-xs">{plan.modelTier}</dd>
          </>
        )}
      </dl>

      {swatches.length === 0 ? null : (
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Palette</span>
          {swatches.map((color) => (
            <span
              key={color}
              title={color}
              className="size-4 rounded-full border border-border"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      )}

      {plan.checks.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Checks</span>
          {plan.checks.map((check) => (
            <span
              key={check}
              className="rounded-full border border-border bg-surface-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {check}
            </span>
          ))}
        </div>
      )}

      {plan.notesForUser === "" ? null : (
        <blockquote className="rounded-md border-l-2 border-accent bg-surface-muted px-3 py-2 text-sm">
          {plan.notesForUser}
        </blockquote>
      )}

      <p className="text-xs text-muted-foreground">
        {plan.steps.length} planned step{plan.steps.length === 1 ? "" : "s"} ·{" "}
        {slotNames.length} slot{slotNames.length === 1 ? "" : "s"} ·{" "}
        {plan.assets.length} asset{plan.assets.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}

export function PlanCard({ timeline }: PlanCardProps) {
  const { plan, terminal, deviated } = timeline;

  if (plan === null && !terminal) {
    return <PlanSkeleton />;
  }

  return (
    <section
      aria-label="Agent plan"
      className="rounded-lg border border-border bg-surface px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Plan</h2>
        {deviated ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
            <TriangleAlert aria-hidden="true" className="size-3" />
            Agent deviated from plan
          </span>
        ) : null}
      </div>

      {plan === null ? (
        <p className="mt-2 text-sm text-muted-foreground">
          The run ended before a plan was produced.
        </p>
      ) : (
        <PlanBody plan={plan} />
      )}

      {deviated ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          The agent adjusted the plan while fixing errors. Every deviation is marked on the step
          it belongs to in the timeline below — nothing changed silently.
        </p>
      ) : null}
    </section>
  );
}
