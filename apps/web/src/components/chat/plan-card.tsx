"use client";

/**
 * Plan card (M5-G) — EDITOR_CHAT_UX §6.2 upgraded from the M4-informational
 * card to the full apply/undo card (BUILD_PLAN §M5 task 3; M5-SEAMS "Client
 * plan card: risk/affected layers/credits/steps + preview + Apply/Cancel
 * (high risk ⇒ explicit confirm checkbox §6.2)").
 *
 * What the card renders:
 *  * risk badge (low/medium/high) — high upgrades the border to danger AND
 *    gates Apply behind an explicit confirm checkbox (§6.2);
 *  * affected-layers list (name + change, defensively capped at the §8.6
 *    bound of 50) and a deterministic credit estimate — ALWAYS the value the
 *    server put on the plan event (`estimatedCredits` prop), never client
 *    credit math;
 *  * numbered steps (title + tool id) behind a disclosure toggle;
 *  * the OPTIONAL `diff` slot (W1-d's PlanDiffCard injects through the thread
 *    layer — never imported here; ownership law #12) — the §6.3 semantic
 *    per-property old → new rows, rendered above the preview slot;
 *  * the OPTIONAL `preview` slot (M5-H's PlanPreview injects through the
 *    thread layer — never imported here; ownership law #12);
 *  * a status-driven action row (see PLAN_CARD_STATUSES).
 *
 * Status contract (thread layer / M5-F wiring — the card is a pure view):
 *  * "proposed"   → Apply / Cancel. Cancel is the explicit plan-cancel event
 *    (`onCancel`) — the run itself stays usable. High-risk Apply goes through
 *    the checkbox + the ChatConfirmDialog before `onApply` fires.
 *  * "applying"   → spinner; no actions.
 *  * "applied"    → "Applied — one undo step" (+ "Version N" when the layer
 *    passes one) and Undo (`onUndo`), plus the ECUX §6.3 "View in timeline"
 *    affordance (`onViewInTimeline`, W1-d): the thread layer's callback
 *    seeks the editor playhead to the plan's first affected time and
 *    activates the affected comp — bridge calls only (the editor UI itself
 *    is frozen, law #7; this card stays a pure view).
 *  * "undone"     → Re-apply (`onReapply`), gated on the base-version state:
 *    `reapplyDrifted` disables it and explains why (BP M5.5).
 *  * "failed"     → "nothing changed" copy + the outcome's message; a quiet
 *    Try again re-fires `onApply`.
 *  * "save-failed"→ F-L1/F-L3 copy for the executed-but-unsaved state: "The
 *    edit is in the editor, but its version could not be saved." + the
 *    outcome's message + Retry save (`onRetrySave` → the apply engine's
 *    re-save-only `retrySave` — engine.batch is never re-executed). For the
 *    save-CONFLICT arm the thread layer passes the same status WITHOUT
 *    `onRetrySave` (a parked conflict is terminal — the reload copy rides
 *    `statusDetail`).
 *  * "conflict"   → 409 VERSION_CONFLICT copy: re-apply is blocked because
 *    the project moved on; no actions.
 *  * "ambiguous-resolution" → the layer-resolution candidates (the plan
 *    compiler's resolutionRequests); a pick fires `onResolveCandidate`.
 *  * "cancelled"  → the user cancelled the plan; nothing was applied.
 *
 * Safety (M4-N posture, unchanged): every plan field is UNTRUSTED model
 * output and is rendered as React-escaped text (never HTML); long summaries
 * and layer names truncate (`truncate` + `min-w-0`) and hostile pinned labels
 * render as inert DATA. Untrusted text carries `dir="auto"` so RTL content
 * cannot flip the card's own layout.
 *
 * M4 backward compatibility (M4-SEAMS wave-2 surface): `plan` + `applied` +
 * `note` keep working — message.tsx's `<PlanCard plan={…} applied={false} />`
 * still typechecks and renders the read-only card (no callbacks ⇒ no
 * buttons). The M4 pinned "Apply arrives with M5" note is GONE: apply is real.
 * The web boundary stays import-type-only (`@studio/contracts` types only —
 * no runtime import, so no Zod in the bundle); the high-risk gate mirrors
 * `needsConfirmCheckbox()` from @studio/contracts edit-plan — keep in sync.
 *
 * Exported surface (docs/phases/M5-SEAMS.md ownership map, M5-G):
 *   PlanCardProps + PlanCard, PlanCardStatus, PLAN_CARD_STATUSES,
 *   PlanResolutionRequest.
 *
 * M5-R additive delta (F-L1/F-L3): status "save-failed" + the onRetrySave
 * callback — the thread layer maps apply outcomes reason "save-failed" (and
 * "save-conflict", without onRetrySave) to it. New testids: plan-save-failed,
 * plan-save-failed-detail, plan-retry-save.
 *
 * W1-d additive delta (ECUX §6.3, AUD-3 gap 1): the `diff` slot (rendered
 * above the preview slot) + `onViewInTimeline` on the applied card. New
 * testids: plan-diff, plan-view-in-timeline.
 *
 * W1-07 additive delta (M5.7b "View in timeline" — the HISTORY half): the
 * applied card ALSO links to the project's version-history page
 * (`/w/:slug/history`, BUILD_PLAN §M7 task 4) via the OPTIONAL `timelineHref`
 * prop — the thread layer derives it from the app-router pathname (the chat
 * panel only mounts under /w/:slug/*). `onViewInTimeline` stays the IN-EDITOR
 * reveal (playhead + comp); the link is the timeline PAGE affordance. Absent
 * prop ⇒ no link (embeds/tests). New testid: plan-history-link.
 */

import type { EditPlan, PlanRisk } from "@studio/contracts";
import { Badge, Button, Spinner } from "@studio/ui";
import { ChevronDown, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { ChatConfirmDialog } from "./confirm-dialog";

/** M5 apply lifecycle of THIS plan (the thread layer owns the transitions). */
export type PlanCardStatus =
  | "proposed"
  | "applying"
  | "applied"
  | "undone"
  | "failed"
  | "save-failed"
  | "conflict"
  | "ambiguous-resolution"
  | "cancelled";

/** Every status the card accepts (exhaustive for the thread layer's wiring). */
export const PLAN_CARD_STATUSES: readonly PlanCardStatus[] = [
  "proposed",
  "applying",
  "applied",
  "undone",
  "failed",
  "save-failed",
  "conflict",
  "ambiguous-resolution",
  "cancelled",
];

/**
 * One ambiguous-layer resolution (structurally identical to the gateway plan
 * compiler's LayerResolutionRequest — M5-SEAMS pinned interface). The
 * disambiguation entries are candidate layer names the user picks from.
 */
export interface PlanResolutionRequest {
  readonly requestId: string;
  readonly layerName: string;
  readonly disambiguation: readonly string[];
}

export interface PlanCardProps {
  plan: EditPlan;
  /**
   * M4 back-compat: the wave-2 surface pinned `applied: false`. Still
   * accepted; `true` (or `status="applied"`) marks the card applied. The
   * `data-applied` attribute reflects the resolved status.
   */
  applied?: boolean;
  /** M5 status; defaults to "applied" when `applied` is true, else "proposed". */
  status?: PlanCardStatus;
  /**
   * Human detail for failed/conflict — the apply outcome's message, rendered
   * as inert data. Never a stack trace (§6.4).
   */
  statusDetail?: string;
  /**
   * The server-recomputed credit estimate from the plan event
   * (plan-compiler output). Displayed VERBATIM — the card never recomputes
   * or re-derives credits. Falls back to plan.estimatedCredits (M4 shape).
   */
  estimatedCredits?: number;
  /**
   * The server-recomputed risk from the plan event (plan-compiler output),
   * when it differs from the model's own plan.risk. Falls back to plan.risk.
   */
  risk?: PlanRisk;
  /** Ambiguous-layer candidates for the "ambiguous-resolution" status. */
  resolutionRequests?: readonly PlanResolutionRequest[];
  /**
   * Undo→re-apply gate (BP M5.5): the project has moved past this run's base
   * version, so re-apply is blocked — the card disables Re-apply and
   * explains. Defaults false (not drifted ⇒ re-apply allowed).
   */
  reapplyDrifted?: boolean;
  /** Applied-state version label (§7.4) — renders as "Version <label>". */
  versionLabel?: string;
  /**
   *   Preview slot (M5-H PlanPreview via the thread layer — never imported
   *   here). Rendered above the action row when present.
   */
  preview?: ReactNode;
  /**
   *   Diff slot (W1-d PlanDiffCard via the thread layer — never imported
   *   here): the §6.3 semantic per-property old → new rows. Rendered above
   *   the preview slot when present (rows first, then the thumbnail strip).
   */
  diff?: ReactNode;
  /**
   * Fired when the user confirms an apply: directly for low/medium risk;
   * for high risk only after the confirm checkbox AND the confirm dialog.
   */
  onApply?: () => void;
  /** Explicit plan cancel while proposed — the run stays otherwise usable. */
  onCancel?: () => void;
  /** "Undo this run" (§7.2 — one edit.undo reverts the whole batch). */
  onUndo?: () => void;
  /**
   * "View in timeline" (§6.3, applied card): the thread layer's callback —
   * seeks the playhead to the plan's first affected time + activates the
   * affected comp via bridge calls. Absent ⇒ the affordance does not render.
   */
  onViewInTimeline?: () => void;
  /**
   * W1-07 (M5.7b): the project's version-history page (`/w/:slug/history`),
   * token-styled as a link on the APPLIED card. The thread layer derives it
   * from the pathname; absent (embeds, tests, non-workspace mounts) ⇒ no
   * link. The applied version lands in this timeline (§9.3).
   */
  timelineHref?: string;
  /** Re-apply after undone (or try-again intent wired by the thread layer). */
  onReapply?: () => void;
  /**
   * F-L1 — the save-failed state's "Retry save" action: the thread layer
   * wires it to the apply engine's re-save-only `retrySave(runId)` (the
   * version upload + gateway report retry; the batch is NEVER re-executed).
   * Absent for the save-conflict arm (a parked conflict needs the reload).
   */
  onRetrySave?: () => void;
  /** The user picked a candidate for an ambiguous layer name. */
  onResolveCandidate?: (requestId: string, candidate: string) => void;
  /** Optional footer note (M4 prop, kept; no default anymore). */
  note?: string;
}

/** §8.6 bound mirrored defensively — the card never trusts its inputs. */
const MAX_AFFECTED_LAYERS = 50;

const RISK_LABEL: Record<PlanRisk, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** low = success tone, medium = amber, high = red (EDITOR_CHAT_UX §6.2). */
const RISK_VARIANT: Record<PlanRisk, "success" | "warning" | "danger"> = {
  low: "success",
  medium: "warning",
  high: "danger",
};

/**
 * Mirrors `needsConfirmCheckbox()` from @studio/contracts edit-plan (§6.2):
 * high risk renders the stronger border + the explicit confirm checkbox.
 * The web boundary is import-type-only, so the predicate is duplicated here —
 * keep in sync with the contracts helper.
 */
function needsConfirmCheckbox(risk: PlanRisk): boolean {
  return risk === "high";
}

export function PlanCard({
  plan,
  applied,
  status: statusProp,
  statusDetail,
  estimatedCredits,
  risk: riskProp,
  resolutionRequests,
  reapplyDrifted = false,
  versionLabel,
  preview,
  diff,
  onApply,
  onCancel,
  onUndo,
  onViewInTimeline,
  timelineHref,
  onReapply,
  onRetrySave,
  onResolveCandidate,
  note,
}: PlanCardProps): ReactElement {
  const status: PlanCardStatus = statusProp ?? (applied === true ? "applied" : "proposed");
  const risk: PlanRisk = riskProp ?? plan.risk;
  const highRisk = risk === "high";
  const confirmGated = needsConfirmCheckbox(risk);

  const [confirmed, setConfirmed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(true);
  const stepsId = useId();

  // A status change away from "proposed" ends the apply attempt: the
  // high-risk confirm checkbox + dialog must never leak into a new attempt.
  useEffect(() => {
    if (status !== "proposed") {
      setConfirmed(false);
      setDialogOpen(false);
    }
  }, [status]);

  const layers = plan.affectedLayers.slice(0, MAX_AFFECTED_LAYERS);
  const hiddenLayerCount = plan.affectedLayers.length - layers.length;
  const credits = estimatedCredits ?? plan.estimatedCredits;
  const intent = plan.intent.charAt(0).toUpperCase() + plan.intent.slice(1);

  const fireApply = () => {
    if (confirmGated) {
      setDialogOpen(true);
      return;
    }
    onApply?.();
  };

  const onConfirmDialogConfirm = () => {
    setDialogOpen(false);
    onApply?.();
  };

  // The proposed action row renders only when the thread wired at least one
  // action — a callback-less mount (M4 message.tsx) stays read-only.
  const showProposedRow =
    status === "proposed" && (onApply !== undefined || onCancel !== undefined);

  return (
    <section
      data-testid="plan-card"
      data-status={status}
      data-applied={String(status === "applied")}
      data-risk={risk}
      data-intent={plan.intent}
      data-requires-approval={String(plan.requiresApproval)}
      className={`max-w-[72ch] rounded-sm border bg-elevated p-3 ${highRisk ? "border-danger" : "border-strong"}`}
    >
      <header className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 self-center text-body-s text-primary">
          <span aria-hidden="true" className="mr-1 text-muted">
            ✦
          </span>
          <span className="font-semibold">Plan</span>
          <span aria-hidden="true" className="text-muted">
            {" · "}
          </span>
          {/* Untrusted summary — data, RTL-iso, single-line truncate. */}
          <span dir="auto" className="text-secondary" title={plan.summary}>
            {plan.summary}
          </span>
        </p>
        <Badge variant={RISK_VARIANT[risk]} data-testid="plan-risk" className="shrink-0">
          {RISK_LABEL[risk]}
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
      {plan.steps.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            data-testid="plan-steps-toggle"
            aria-expanded={stepsOpen}
            aria-controls={stepsId}
            onClick={() => setStepsOpen((value) => !value)}
            className="flex items-center gap-1 rounded-sm text-caption text-secondary transition-colors duration-120 hover:text-primary"
          >
            <span>
              {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
            </span>
            <ChevronDown
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className={`shrink-0 text-muted transition-transform duration-120 ${stepsOpen ? "rotate-180" : ""}`}
            />
          </button>
          {stepsOpen ? (
            <ol data-testid="plan-steps" id={stepsId} className="mt-1 flex flex-col gap-1">
              {plan.steps.map((step, index) => (
                <li
                  key={`${index}-${step.title}`}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0 text-body-s"
                >
                  <span aria-hidden="true" className="shrink-0 text-muted">
                    {index + 1}.
                  </span>
                  {/* Untrusted title — data, RTL-iso, truncates safely. */}
                  <span
                    dir="auto"
                    title={step.title}
                    className="min-w-0 flex-1 truncate text-primary"
                  >
                    {step.title}
                  </span>
                  <code className="shrink-0 font-mono text-caption text-muted">{step.tool}</code>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      {layers.length > 0 ? (
        <div data-testid="plan-affected" className="mt-2">
          <p className="text-caption text-muted">Affected layers</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {layers.map((layer, index) => (
              <li
                key={`${index}-${layer.name}`}
                className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-caption"
              >
                {/* Untrusted names/changes — data, RTL-iso, truncate safely. */}
                <span
                  dir="auto"
                  title={layer.name}
                  className="min-w-0 max-w-full truncate font-medium text-secondary"
                >
                  {layer.name}
                </span>
                <span aria-hidden="true" className="shrink-0 text-muted">
                  ·
                </span>
                <span
                  dir="auto"
                  title={layer.change}
                  className="min-w-0 flex-1 truncate text-muted"
                >
                  {layer.change}
                </span>
              </li>
            ))}
          </ul>
          {hiddenLayerCount > 0 ? (
            <p className="mt-1 text-caption text-muted">
              + {hiddenLayerCount} more layer{hiddenLayerCount === 1 ? "" : "s"} not shown
            </p>
          ) : null}
        </div>
      ) : null}
      <p data-testid="plan-credits" className="mt-2 text-caption text-secondary">
        ≈ {credits} credits
      </p>
      {diff !== undefined && diff !== null ? (
        <div data-testid="plan-diff" className="mt-3 border-t border-subtle pt-2">
          {diff}
        </div>
      ) : null}
      {preview !== undefined && preview !== null ? (
        <div data-testid="plan-preview" className="mt-3 border-t border-subtle pt-2">
          {preview}
        </div>
      ) : null}
      {/* No role="status" live regions here: the thread scroller IS the
          aria-live region (thread.tsx §9.2), so nested live regions would
          double-announce every transition (and biome's <output> suggestion
          would duplicate the Spinner's own <output>). */}
      <div
        data-testid="plan-actions"
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-subtle pt-2"
      >
        {status === "proposed" && confirmGated && onApply !== undefined ? (
          <label
            data-testid="plan-confirm"
            className="flex w-full min-w-0 items-start gap-2 text-caption text-secondary"
          >
            <input
              type="checkbox"
              data-testid="plan-confirm-checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-signal"
            />
            <span className="min-w-0">I reviewed the risks — apply this edit.</span>
          </label>
        ) : null}
        {status === "proposed" && showProposedRow ? (
          <>
            {onApply !== undefined ? (
              <Button
                variant="primary"
                size="sm"
                data-testid="plan-apply"
                disabled={confirmGated && !confirmed}
                onClick={fireApply}
              >
                Apply
              </Button>
            ) : null}
            {onCancel !== undefined ? (
              <Button variant="ghost" size="sm" data-testid="plan-cancel" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </>
        ) : null}
        {status === "applying" ? (
          <p
            data-testid="plan-applying"
            className="flex items-center gap-2 text-body-s text-secondary"
          >
            <Spinner size={16} label="Applying the edit" />
            <span>Applying…</span>
          </p>
        ) : null}
        {status === "applied" ? (
          <>
            <p
              data-testid="plan-applied"
              className="flex items-center gap-2 text-body-s text-success"
            >
              <span aria-hidden="true" className="font-bold">
                ✓
              </span>
              <span>
                Applied{versionLabel !== undefined ? ` — Version ${versionLabel}` : ""} · one undo
                step.
              </span>
            </p>
            {onUndo !== undefined ? (
              <Button variant="secondary" size="sm" data-testid="plan-undo" onClick={onUndo}>
                Undo
              </Button>
            ) : null}
            {onViewInTimeline !== undefined ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="plan-view-in-timeline"
                onClick={onViewInTimeline}
              >
                View in timeline
              </Button>
            ) : null}
            {timelineHref !== undefined ? (
              <Link
                href={timelineHref}
                data-testid="plan-history-link"
                className="text-body-s text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
              >
                Version history
              </Link>
            ) : null}
          </>
        ) : null}
        {status === "undone" ? (
          <>
            <p
              data-testid="plan-undone"
              className="flex items-center gap-2 text-body-s text-secondary"
            >
              <span aria-hidden="true" className="text-muted">
                ↺
              </span>
              <span>Undone — the batch reverted; the version stays in history.</span>
            </p>
            {onReapply !== undefined ? (
              <Button
                variant="primary"
                size="sm"
                data-testid="plan-reapply"
                disabled={reapplyDrifted}
                onClick={onReapply}
              >
                Re-apply
              </Button>
            ) : null}
            {reapplyDrifted ? (
              <p data-testid="plan-reapply-blocked" className="w-full text-caption text-warning">
                Re-apply is blocked — the project moved on since this run was undone. Ask the agent
                to plan the edit again.
              </p>
            ) : null}
          </>
        ) : null}
        {status === "failed" ? (
          <>
            <p
              data-testid="plan-failed"
              className="flex items-center gap-2 text-body-s text-danger"
            >
              <span aria-hidden="true" className="font-bold">
                !
              </span>
              <span>The edit didn’t apply — nothing changed.</span>
            </p>
            {statusDetail !== undefined ? (
              <p
                data-testid="plan-failed-detail"
                dir="auto"
                className="w-full text-caption text-secondary"
              >
                {statusDetail}
              </p>
            ) : null}
            {onApply !== undefined ? (
              <Button variant="secondary" size="sm" data-testid="plan-retry" onClick={onApply}>
                Try again
              </Button>
            ) : null}
          </>
        ) : null}
        {status === "save-failed" ? (
          <>
            <p
              data-testid="plan-save-failed"
              className="flex w-full items-start gap-2 text-body-s text-warning"
            >
              <TriangleAlert
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0">
                The edit is in the editor, but its version could not be saved.
              </span>
            </p>
            {statusDetail !== undefined ? (
              <p
                data-testid="plan-save-failed-detail"
                dir="auto"
                className="w-full text-caption text-secondary"
              >
                {statusDetail}
              </p>
            ) : null}
            {onRetrySave !== undefined ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="plan-retry-save"
                onClick={onRetrySave}
              >
                Retry save
              </Button>
            ) : null}
          </>
        ) : null}
        {status === "conflict" ? (
          <>
            <p
              data-testid="plan-conflict"
              className="flex w-full items-start gap-2 text-body-s text-warning"
            >
              <TriangleAlert
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0">
                Apply was rejected — the project moved on while this plan was waiting.
              </span>
            </p>
            <p className="w-full text-caption text-secondary">
              Re-apply is blocked for this plan. Ask the agent to plan the edit again against the
              current project.
            </p>
            {statusDetail !== undefined ? (
              <p
                data-testid="plan-conflict-detail"
                dir="auto"
                className="w-full text-caption text-muted"
              >
                {statusDetail}
              </p>
            ) : null}
          </>
        ) : null}
        {status === "ambiguous-resolution" ? (
          <>
            <p data-testid="plan-ambiguous" className="w-full text-body-s text-secondary">
              This plan needs a decision — a layer name matches more than one layer.
            </p>
            {(resolutionRequests ?? []).map((request) => (
              <div key={request.requestId} data-testid="plan-resolution" className="w-full min-w-0">
                <p dir="auto" className="text-caption text-primary">
                  “{request.layerName}” matches:
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {request.disambiguation.map((candidate) =>
                    onResolveCandidate !== undefined ? (
                      <Button
                        key={`${request.requestId}-${candidate}`}
                        variant="secondary"
                        size="sm"
                        data-testid="plan-candidate"
                        onClick={() => onResolveCandidate(request.requestId, candidate)}
                      >
                        {candidate}
                      </Button>
                    ) : (
                      <span
                        key={`${request.requestId}-${candidate}`}
                        data-testid="plan-candidate"
                        className="rounded-xs border border-border bg-input px-1.5 py-0.5 text-caption text-secondary"
                      >
                        {candidate}
                      </span>
                    ),
                  )}
                </div>
              </div>
            ))}
          </>
        ) : null}
        {status === "cancelled" ? (
          <p data-testid="plan-cancelled" className="w-full text-body-s text-muted">
            Plan cancelled — nothing was applied. The chat stays ready.
          </p>
        ) : null}
      </div>
      {note !== undefined ? (
        <p
          data-testid="plan-note"
          className="mt-2 border-t border-subtle pt-2 text-caption text-muted"
        >
          {note}
        </p>
      ) : null}
      {status === "proposed" && confirmGated && onApply !== undefined ? (
        <ChatConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Apply this high-risk plan?"
          description={
            <>
              <span dir="auto">{plan.summary}</span>
              {
                " — this plan is marked high risk. Apply only if you mean it. Undo reverts the whole batch in one step."
              }
            </>
          }
          confirmLabel="Apply"
          danger
          onConfirm={onConfirmDialogConfirm}
        />
      ) : null}
    </section>
  );
}
