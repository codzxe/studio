"use client";

/**
 * One thread message (M4-F) — EDITOR_CHAT_UX §3.3/§10: max 72ch of text; user
 * messages sit on a subtle raised `--bg-elevated` surface with a "You" label;
 * assistant messages are plain on the panel background with a sparkle mark —
 * NO avatars. System-style notices (credits) are inline lines, not toasts.
 *
 * M5-Q — the REAL Apply path through the thread (BUILD_PLAN §M5.4/§M5.5,
 * D-21/D-22, the M5-G card contract): when the message carries an M5
 * `planRuntime` (a compiledBatch rode the plan event) AND the thread layer
 * passed {@link PlanMessageWiring}, this module maps the runtime's lifecycle to
 * the card's status/callback props and mounts M5-H's PlanPreview in the
 * card's `preview` slot. Without a runtime — or without wiring — the mount is
 * BYTE-IDENTICAL to the M4 read-only card (`<PlanCard plan applied={false} />`),
 * so the M4.6 read-only guarantee holds by structure: no engine, no Apply.
 *
 * Wiring rules shipped here (pinned by apps/web/tests/chat-integration.test.tsx):
 *  * Actions mount only when the plan's run is SETTLED — the message's run is
 *    not the live active run (`runId !== activeRunId`), or the thread phase is
 *    `done`. Mid-stream cards render read-only (the gateway's /apply answers
 *    409 RUN_NOT_ACTIVE while the run is still planning — the gate is honest).
 *  * status ← planRuntime.outcome: idle→proposed, applying→applying,
 *    applied/undoing→applied (+versionLabel), undone→undone (+reapplyDrifted),
 *    undo-failed→applied + a note (the card has no undo-failed status; the
 *    note carries the honest message and Undo stays retryable),
 *    apply-failed→by §7.3 code: LAYER_AMBIGUOUS→ambiguous-resolution (the
 *    outcome's candidates render as pick buttons), VERSION_CONFLICT→conflict,
 *    BASE_VERSION_CHANGED→undone+drifted (the run is still undone; the §M5.5
 *    explanation IS the honest view), everything else→failed.
 *  * F-L3 (M5-L): for save-failed/save-conflict/insufficient-credits/network
 *    failures the card renders the CONTROLLER's honest statusDetail and gets
 *    NO Try-again — the card's retry re-executes engine.batch and M5-L F-L1
 *    proved that DOUBLES non-idempotent plans after a post-execution failure.
 *    Try again exists only for PRE-execution failures (ambiguous, not-found,
 *    resolution/invalid-batch, engine rollback, disconnect) where nothing ever
 *    mutated. (A true "Retry save" affordance needs an apply.ts `retrySave`
 *    seam — report-only, not this layer's file.)
 *  * reapplyDrifted (§M5.5/D-21): the session's current version id ≠ the
 *    plan event's baseVersionId (absent ⇒ conservatively drifted — apply.ts's
 *    gate fails closed without it).
 *  * Preview (M5-H): mounted for low/medium-risk plans ONLY — probing
 *    EXECUTES the batch and undoes it, so a high-risk card must never probe
 *    (the user has not confirmed anything yet); the component self-guards an
 *    unsafe batch. Only in the proposed state (after apply/undo a re-probe is
 *    pointless churn).
 *  * Diff card (W1-d, ECUX §6.3): the semantic per-property old → new rows
 *    are mounted for EVERY proposed plan with a compiled batch — low, medium
 *    AND high risk: unlike the preview probe, the diff is derived from the
 *    batch and reads the live (pre-apply) values with READ-ONLY bridge
 *    queries (one comp.info + prop.get per pair), so a high-risk card gains
 *    review context without anything executing before the user confirms.
 *    Only in the proposed state — after apply the live values ARE the new
 *    values and a "before" column would lie.
 *  * View in timeline (W1-d, §6.3): the APPLIED card's affordance seeks the
 *    playhead to the plan's first affected time and activates the affected
 *    comp — bridge calls only (comp.open + time.set; journaled view-state
 *    commands that never touch the undo stack, verified against the vendored
 *    engine: comp.rs `open`, time.rs `set`). Best-effort and quiet on
 *    failure; the editor UI itself is frozen (law #7).
 *  * Version-history link (W1-07, M5.7b): the APPLIED card also carries a
 *    token-styled link to the project's `/w/:slug/history` timeline page —
 *    the slug parsed from the app-router pathname (the chat panel only
 *    mounts under /w/:slug/*, so the pathname IS the workspace truth; a
 *    non-workspace mount degrades to no link, never a guess).
 *  * D-22 pre-arm: `autoApply.mode === "auto"` (never for high risk) renders
 *    the "Auto-apply is on" hint and focuses the Apply button — Apply is
 *    STILL the user's explicit click; nothing ever executes from the event.
 *
 * Exported surface (docs/phases/M4-SEAMS.md "Wave-2 UI contract", binding):
 *   ChatMessageViewProps + ChatMessageView (+ M5-Q: PlanMessageWiring).
 */

import type { ChatController } from "@/lib/chat/chat-controller";
import { firstAffectedTimeTicks, ticksToSeconds } from "@/lib/chat/preview";
import { applicablePlanFromRuntime } from "@/lib/chat/run-state";
import type { ChatUiMessage, PlanRuntime, RunPhase } from "@/lib/chat/types";
import type { AgentBatch, EditPlan } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { usePathname } from "next/navigation";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { PlanDiffCard } from "./diff-card";
import { Markdown } from "./markdown";
import { MessageActions, MessageEditBox } from "./message-actions";
import {
  PlanCard,
  type PlanCardProps,
  type PlanCardStatus,
  type PlanResolutionRequest,
} from "./plan-card";
import { PlanPreview } from "./plan-preview";
import { ReasoningBlock } from "./reasoning-block";
import { ToolCard } from "./tool-card";

/**
 * The M5-Q wiring the thread layer hands each message (built in thread.tsx
 * from the ChatProvider context). Absent (or `ready: false`) ⇒ the M4
 * read-only card.
 */
export interface PlanMessageWiring {
  /** True when the session's ApplyController is constructed (ports wired). */
  readonly ready: boolean;
  /** The thread controller (null before the lazy thread exists). */
  readonly controller: ChatController | null;
  /** The stable bridge — M5-H's PlanPreview creates its throwaway controller from it. */
  readonly bridge: EditorBridge;
  /** The session's current version id (the §M5.5 reapply-drift gate); null without a port. */
  readonly sessionVersionId: string | null;
  /** The whole-thread phase (the settled gate below). */
  readonly phase: RunPhase;
  /** The run currently streaming (the settled gate below). */
  readonly activeRunId: string | null;
}

export interface ChatMessageViewProps {
  message: ChatUiMessage;
  /** Caret shows only on the ACTIVE assistant message while its run streams. */
  isStreaming: boolean;
  /** M5-Q: the plan-card wiring (absent ⇒ the M4 read-only card). */
  planWiring?: PlanMessageWiring | null;
  /**
   * ROUND 12 (Chat UI v3): re-send from THIS user message (host maps the
   * id to a fresh send). Absent ⇒ the Retry action hides (read-only mounts).
   */
  onRetryFrom?: (messageId: string) => void;
  /** ROUND 12 (Chat UI v3): edit-and-resend (absent ⇒ Edit hides). */
  onEditResend?: (messageId: string, nextText: string) => void;
}

/**
 * Failure codes whose retry is SAFE: the engine never mutated anything during
 * the attempt (apply.ts resolves/binds BEFORE engine.batch, and a rejected
 * batch rolls back atomically upstream) — a fresh gesture can only succeed or
 * fail the same way. Every POST-execution failure (save-failed, save-conflict,
 * insufficient-credits, network, 409) is deliberately absent: M5-L F-L1 pinned
 * the re-execution doubling hazard for non-idempotent plans.
 */
const PRE_EXECUTION_RETRYABLE: ReadonlySet<string> = new Set([
  "LAYER_NOT_FOUND",
  "PLAN_RESOLUTION_FAILED",
  "PLAN_BATCH_INVALID",
  "APPLY_ENGINE_FAILED",
  "EDITOR_DISCONNECTED",
]);

/** The §9 streaming caret: 6×14px signal block, 1s step blink (tokens.css). */
function StreamingCaret() {
  return (
    <span
      data-testid="chat-caret"
      aria-hidden="true"
      className="mt-1 inline-block h-[var(--chat-caret-h)] w-[var(--chat-caret-w)] animate-caret-blink bg-signal"
    />
  );
}

/**
 * The failing request(s) of an ambiguous outcome → the card's pick surface.
 * apply.ts resolves requests in order and aborts on the FIRST ambiguous name,
 * so the failing request is the one whose layerName prefixes EVERY candidate
 * (its pinned format is `"${layerName} (layer ${id})"`); the candidates
 * replace the request's display-only disambiguation hints. Defensive fallback:
 * the plan's own requests (a malformed outcome can never grow new buttons).
 */
function deriveAmbiguousRequests(runtime: PlanRuntime): readonly PlanResolutionRequest[] {
  const candidates = runtime.candidates ?? [];
  const requests = runtime.resolutionRequests ?? [];
  if (candidates.length === 0) return requests;
  const failing = requests.filter((request) =>
    candidates.every((candidate) => candidate.startsWith(`${request.layerName} (layer `)),
  );
  if (failing.length === 0) return requests;
  return failing.map((request) => ({
    requestId: request.requestId,
    layerName: request.layerName,
    disambiguation: candidates,
  }));
}

/**
 * "View in timeline" (§6.3, W1-d) — reveal an APPLIED plan in the timeline:
 * activate the affected comp, then seek the playhead to the plan's first
 * affected time. Bridge calls ONLY (`bridge.execute` through the real editor
 * surface — the editor UI is frozen, law #7; comp activation + transport are
 * allowed engine commands, not a UI change):
 *
 *  * comp target — a `comp.new` step names the comp it will have created
 *    (comp.open accepts `id|name`, comp.rs `open`); otherwise agent batches
 *    execute in the ACTIVE comp (apply.ts resolves names there), so the
 *    current active comp is the affected one — re-opened (idempotent when
 *    already active; a no-op that restores the tab if the user switched).
 *  * seek — the plan's first affected time (preview.ts's scanner, ECUX
 *    §6.2/§6.3); a plan that names no time keeps the playhead where it is.
 *
 * `time.set`/`comp.open` are view-state commands (session `times`/`open_comps`)
 * — they never push an undo step, so the card's own Undo (F-L4 label
 * verification) is undisturbed. Best-effort: a failure is quiet (the
 * affordance is a convenience, never a gate) and never mutates project data.
 */
async function revealPlanInTimeline(
  bridge: EditorBridge,
  plan: EditPlan,
  batch: AgentBatch,
): Promise<void> {
  try {
    const newCompName = batch.steps.find(
      (step) =>
        step.command === "comp.new" &&
        typeof step.params?.name === "string" &&
        (step.params.name as string).length > 0,
    )?.params?.name as string | undefined;
    if (newCompName !== undefined) {
      await bridge.execute("comp.open", { comp: newCompName });
    } else {
      const inspect = await bridge.inspect();
      if (typeof inspect.activeComp === "number") {
        await bridge.execute("comp.open", { comp: inspect.activeComp });
      }
    }
    const ticks = firstAffectedTimeTicks(plan);
    if (ticks !== null) {
      await bridge.execute("time.set", { time: ticksToSeconds(ticks) });
    }
  } catch {
    // Quiet best-effort (see the doc block): a failed reveal never disturbs
    // the card, the editor state or the run.
  }
}

/**
 * W1-07 (M5.7b): `/w/:slug/history` for the workspace whose page this thread
 * renders on, parsed from the app-router pathname. The chat panel only
 * mounts under `/w/:slug/*` (editor-host), so a matching pathname is the
 * honest slug source; anything else (embeds, tests) yields NO link rather
 * than a guessed href. The slug is URI-encoded defensively (repo slugs are
 * URL-safe by construction; law #1/#2 posture anyway).
 */
export function historyHrefFromPathname(pathname: string | null): string | undefined {
  if (pathname === null) return undefined;
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(pathname);
  const slug = match?.[1];
  if (slug === undefined || slug === "") return undefined;
  return `/w/${encodeURIComponent(slug)}/history`;
}

/**
 * The full M5-G card contract derived from one message's runtime + the wiring.
 * Pure: every branch is pinned by the chat-integration M5 scenarios. `null`
 * when the message carries no plan (the caller renders no card).
 */
function derivePlanCardProps(
  message: ChatUiMessage,
  wiring: PlanMessageWiring | null | undefined,
  timelineHref: string | undefined,
): PlanCardProps | null {
  const plan = message.plan;
  const runtime = message.planRuntime;
  if (plan === undefined) return null;
  if (runtime === undefined) {
    // The M4 shape (no compiled batch on the wire): read-only card.
    return { plan, applied: false };
  }

  // Server-recomputed card values (D-21/§8.8) — VERBATIM, never client math;
  // undefined ⇒ the card falls back to the plan's own model-declared values.
  const base: Pick<PlanCardProps, "plan" | "risk" | "estimatedCredits"> = {
    plan,
    ...(runtime.risk !== undefined ? { risk: runtime.risk } : {}),
    ...(runtime.estimatedCredits !== undefined
      ? { estimatedCredits: runtime.estimatedCredits }
      : {}),
  };

  // The settled gate: the wiring exists AND this plan's run is not live.
  const controller = wiring?.controller ?? null;
  const settled =
    wiring?.ready === true &&
    controller !== null &&
    message.runId !== undefined &&
    (message.runId !== wiring.activeRunId || wiring.phase === "done");
  const runId = message.runId ?? null;

  if (!settled || runId === null) {
    return { ...base, applied: false };
  }
  // ---- reapply drift (§M5.5/D-21) ------------------------------------------
  const drifted =
    runtime.baseVersionId === undefined ||
    wiring.sessionVersionId === null ||
    wiring.sessionVersionId !== runtime.baseVersionId;

  // ---- callbacks (all close over the folded runtime, never stale props) ----
  const gesturePlan = () => applicablePlanFromRuntime(runId, runtime);
  const onApply = () => {
    const next = gesturePlan();
    controller.apply(next);
  };
  const onRetrySave = () => controller.retrySave(runId);
  const onReapply = () => {
    const next = gesturePlan();
    controller.reapply(next);
  };
  const onUndo = () => controller.undo(runId);
  const onViewInTimeline = () => {
    void revealPlanInTimeline(wiring.bridge, plan, runtime.compiledBatch);
  };
  const onCancel = () => controller.dismissPlan(runId);
  const onResolveCandidate = (requestId: string, candidate: string) =>
    controller.resolveCandidate(runId, requestId, candidate);

  // ---- status (M5-G's machine, from planRuntime.outcome) --------------------
  let status: PlanCardStatus = "proposed";
  let statusDetail: string | undefined;
  let versionLabel: string | undefined;
  let note: string | undefined;
  let reapplyDrifted = false;
  let resolutionRequests: readonly PlanResolutionRequest[] | undefined;
  let onApplyCallback: (() => void) | undefined;
  let onReapplyCallback: (() => void) | undefined;

  const error = runtime.error;
  const errorCode = error?.code;

  if (runtime.dismissed === true) {
    status = "cancelled";
  } else {
    switch (runtime.outcome) {
      case "idle": {
        status = "proposed";
        onApplyCallback = onApply;
        break;
      }
      case "applying": {
        status = "applying";
        break;
      }
      case "applied":
      case "undoing": {
        // `undoing` renders as applied WITHOUT the Undo button — the click is
        // in flight and a second edit.undo would pop a foreign undo step.
        status = "applied";
        versionLabel = runtime.versionId;
        break;
      }
      case "undo-failed": {
        // The card has no undo-failed status; the applied view is the true
        // state and the note carries the honest failure (Undo stays retryable).
        status = "applied";
        versionLabel = runtime.versionId;
        note =
          error !== undefined
            ? `Undo didn't finish — ${error.message}`
            : "Undo didn't finish — try again.";
        break;
      }
      case "undone": {
        status = "undone";
        reapplyDrifted = drifted;
        onReapplyCallback = onReapply;
        break;
      }
      case "apply-failed": {
        if (errorCode === "LAYER_AMBIGUOUS") {
          status = "ambiguous-resolution";
          resolutionRequests = deriveAmbiguousRequests(runtime);
        } else if (errorCode === "VERSION_CONFLICT") {
          status = "conflict";
          statusDetail = error?.message;
        } else if (errorCode === "BASE_VERSION_CHANGED") {
          // A re-drive hit the §M5.5 gate: the run is still UNDONE and the
          // blocked explanation is the honest view — not a failed card.
          status = "undone";
          reapplyDrifted = true;
        } else {
          status = "failed";
          statusDetail = error?.message;
          // F-L1/F-L3: Try again ONLY when re-executing is safe. For
          // POST-execution failures the card's Try-never wires a full
          // re-apply (M5-L F-L1 pinned the doubling hazard) — save failures
          // offer the engine's re-save-only `retrySave` instead (the batch is
          // never re-executed; save-conflict stays actionless: the copy says
          // reload). PRE-execution failures re-drive the full apply.
          if (errorCode === "APPLY_SAVE_FAILED" || errorCode === "INSUFFICIENT_CREDITS") {
            onApplyCallback = onRetrySave;
          } else if (errorCode !== undefined && PRE_EXECUTION_RETRYABLE.has(errorCode)) {
            onApplyCallback = onApply;
          }
        }
        break;
      }
    }
  }

  // ---- preview slot (M5-H) + diff slot (W1-d) + D-22 pre-arm -----------------
  const resolvedRisk = runtime.risk ?? plan.risk;
  const proposed = status === "proposed";
  const highRisk = resolvedRisk === "high";
  let preview: ReactNode | undefined;
  if (proposed && !highRisk) {
    // Low/medium risk only: the probe EXECUTES the batch + edit.undo, so a
    // high-risk card must never probe (§6.2 — nothing runs before the user
    // confirms). PlanPreview self-guards when the batch is unsafe.
    preview = <PlanPreview batch={runtime.compiledBatch} plan={plan} bridge={wiring.bridge} />;
  }
  let diff: ReactNode | undefined;
  if (proposed) {
    // Every risk (see the module header): pure derivation + READ-ONLY
    // before-value reads — nothing executes, so even a high-risk card may
    // show the semantic diff while its batch stays unprobed.
    diff = (
      <PlanDiffCard
        batch={runtime.compiledBatch}
        bridge={wiring.bridge}
        resolutionRequests={runtime.resolutionRequests}
      />
    );
  }
  const preArmed = proposed && !highRisk && runtime.autoApply?.mode === "auto";

  return {
    ...base,
    status,
    ...(statusDetail !== undefined ? { statusDetail } : {}),
    ...(versionLabel !== undefined ? { versionLabel } : {}),
    ...(note !== undefined ? { note } : {}),
    reapplyDrifted,
    ...(resolutionRequests !== undefined ? { resolutionRequests } : {}),
    preview,
    ...(diff !== undefined ? { diff } : {}),
    ...(onApplyCallback !== undefined ? { onApply: onApplyCallback } : {}),
    ...(proposed ? { onCancel } : {}),
    ...(status === "applied" && (runtime.outcome === "applied" || runtime.outcome === "undo-failed")
      ? { onUndo, onViewInTimeline }
      : {}),
    ...(status === "applied" && timelineHref !== undefined ? { timelineHref } : {}),
    ...(onReapplyCallback !== undefined ? { onReapply: onReapplyCallback } : {}),
    ...(status === "ambiguous-resolution" ? { onResolveCandidate } : {}),
  };
}

export function ChatMessageView({
  message,
  isStreaming,
  planWiring,
  onRetryFrom,
  onEditResend,
}: ChatMessageViewProps): ReactElement {
  const isUser = message.role === "user";
  const showCaret = isStreaming && !isUser;
  const plan = message.plan;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const armedOnceRef = useRef(false);
  // ROUND 12: the inline edit-and-resend state (user messages only).
  const [editing, setEditing] = useState(false);

  // W1-07 (M5.7b): the applied card's version-history link — derived from the
  // app-router pathname (see historyHrefFromPathname). usePathname is mocked
  // in the vitest setup ("/" ⇒ undefined ⇒ no link), so unit renders of this
  // view stay deterministic.
  const timelineHref = historyHrefFromPathname(usePathname());
  const derived = derivePlanCardProps(message, planWiring, timelineHref);
  const preArmed =
    derived !== null &&
    planWiring !== null &&
    planWiring !== undefined &&
    planWiring.ready &&
    derived.status === "proposed" &&
    (derived.risk ?? plan?.risk) !== "high" &&
    message.planRuntime?.autoApply?.mode === "auto";

  // D-22 pre-arm: focus emphasis on Apply ONCE per message (never re-steal the
  // focus on re-renders). Apply remains a click — nothing executes here.
  useEffect(() => {
    if (!preArmed || armedOnceRef.current) return;
    const button = cardRef.current?.querySelector<HTMLElement>('[data-testid="plan-apply"]');
    if (button === null || button === undefined) return;
    armedOnceRef.current = true;
    button.focus();
  }, [preArmed]);

  return (
    <article
      data-testid="chat-message"
      data-role={message.role}
      className={`flex min-w-0 flex-col items-start gap-1.5 ${isUser ? "group" : ""}`}
    >
      {isUser ? (
        <p data-testid="chat-message-label" className="text-label text-muted uppercase">
          You
        </p>
      ) : (
        <p data-testid="chat-message-label" className="text-label text-muted uppercase">
          <span aria-hidden="true" className="mr-1">
            ✦
          </span>
          {" Agent"}
        </p>
      )}
      {isUser ? (
        editing ? (
          <MessageEditBox
            initialText={message.text}
            onSave={(next) => {
              setEditing(false);
              onEditResend?.(message.id, next);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          // §9 letter-spec: surface + radius only — no border hairline. The
          // ROUND-12 hover action row sits beside the bubble (opacity-0 →
          // group-hover/focus-within 100 — keyboard users reach it too).
          <div className="flex min-w-0 max-w-full items-center gap-1.5">
            <div className="max-w-[72ch] rounded-[var(--chat-message-radius)] bg-elevated px-3 py-2">
              <Markdown text={message.text} />
            </div>
            <MessageActions
              text={message.text}
              onRetry={onRetryFrom !== undefined ? () => onRetryFrom(message.id) : undefined}
              onEdit={onEditResend !== undefined ? () => setEditing(true) : undefined}
            />
          </div>
        )
      ) : (
        <div className="flex max-w-[72ch] min-w-0 flex-col items-start">
          {/* ROUND 13 (live thinking): the collapsible reasoning bar — streams
           * thinking tokens live (when the model emits them), or shows the
           * animated elapsed-time indicator while the turn is still thinking.
           * Auto-collapses to "Thought for Ns" once the answer text starts. */}
          <ReasoningBlock
            reasoning={message.reasoning ?? ""}
            active={showCaret && message.text.length === 0}
            startedAt={message.reasoningStartedAt}
            endedAt={message.reasoningEndedAt}
          />
          {message.text.length > 0 ? <Markdown text={message.text} /> : null}
          {showCaret ? <StreamingCaret /> : null}
        </div>
      )}
      {message.toolCards.length > 0 ? (
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          {message.toolCards.map((card) => (
            <ToolCard key={card.toolCallId} card={card} />
          ))}
        </div>
      ) : null}
      {plan !== undefined && derived !== null ? (
        <div ref={cardRef} className="flex w-full min-w-0 flex-col items-start">
          {preArmed ? (
            <p
              data-testid="plan-auto-armed"
              className="mb-1.5 text-caption font-medium text-signal"
            >
              Auto-apply is on — review the plan, then press Apply.
            </p>
          ) : null}
          <PlanCard {...derived} />
        </div>
      ) : null}
      {message.credits ? (
        <p data-testid="chat-credits" className="text-caption text-muted">
          {/*
           * UNITS PIN (w3-b01): committed/balance are whole-credit DISPLAY
           * units (the §7.4 emitters' documented units). `committed` is the
           * one number turn.completed actually carries (accumulated by the
           * fold); `balance` is UNKNOWN (NaN) in the round-12 turn wire — no
           * terminal §7.4 credits event ever set it — so it renders ONLY
           * when actually known, never as the fabricated "balance 0" the
           * old fold printed under every reply.
           */}
          {`${message.credits.committed} credits used`}
          {Number.isFinite(message.credits.balance) ? ` · balance ${message.credits.balance}` : ""}
        </p>
      ) : null}
    </article>
  );
}
