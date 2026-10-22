"use client";

/**
 * Plan preview slot (M5-H) — the before/after frame UI for M5-G's plan card,
 * rendered through the card's `preview?: ReactNode` slot (EDITOR_CHAT_UX §6.2:
 * "'Preview' renders a before/after frame at the playhead (or the first
 * affected time)"; BUILD_PLAN §M5.3). The card owns the [Preview][Apply]
 * [Cancel] row; this component owns ONLY the frames.
 *
 * Mounting this component captures automatically: Before = the current state
 * at the resolved time; After = the M5 apply-probe (atomic `engine.batch` →
 * renderFrame → `edit.undo` — see lib/chat/preview.ts for the doc ruling).
 * Time resolution: explicit `timeTicks` → the plan's first affected time →
 * the playhead. The caption always names the affected time and where it came
 * from. A failed preview NEVER disables Apply (PA §8.9 "preview remains
 * optional") — the failure panel says so explicitly.
 *
 * Safety: everything rendered here (frames, failure messages, the plan) is
 * UNTRUSTED data. Images ride a `data:image/png;base64` src (React escapes
 * attributes — a hostile blob can only fail to decode); text renders through
 * React children (never dangerouslySetInnerHTML).
 *
 * Props for the thread mount (the integrator's seam): `{batch, timeTicks,
 * onPreviewFailed}` — plus `plan` (for the first-affected-time default) and
 * exactly one of `controller` (from `createPlanPreviewController({bridge})`)
 * or `bridge` (the component then owns a throwaway controller). Controller/
 * bridge props must be referentially stable across renders.
 */

import { timecodeLabel } from "@/lib/chat/context";
import {
  type PlanPreviewController,
  type PlanPreviewFailure,
  type PlanPreviewState,
  type PlanPreviewTimeSource,
  createPlanPreviewController,
} from "@/lib/chat/preview";
import type { EditPlan } from "@studio/contracts";
import type { AgentBatchInput, EditorBridge } from "@studio/editor-bridge";
import { Button, Spinner } from "@studio/ui";
import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/** Copy for each time source (caption, ECUX §6.2). */
const TIME_SOURCE_LABEL: Readonly<Record<PlanPreviewTimeSource, string>> = {
  explicit: "chosen time",
  plan: "first affected time",
  playhead: "playhead",
};

export interface PlanPreviewProps {
  /** The compiled §8.5 agent batch the plan proposes (probed atomically, then undone). */
  readonly batch: AgentBatchInput;
  /** Capture time in engine ticks; null/undefined → plan first-affected → playhead. */
  readonly timeTicks?: number | null;
  /** The plan (its first affected time wins when `timeTicks` is absent). */
  readonly plan?: EditPlan | null;
  /** Notified once per failed capture (a stale failure of a superseded preview is not surfaced). */
  readonly onPreviewFailed?: (failure: PlanPreviewFailure) => void;
  /** The card's controller (created via `createPlanPreviewController({bridge})`). */
  readonly controller?: PlanPreviewController;
  /** The editor bridge — used to create a throwaway controller when `controller` is omitted. */
  readonly bridge?: EditorBridge;
}

/** JSON-stable identity for the batch prop (batches arrive as fresh object literals per plan event). */
function batchKeyOf(batch: AgentBatchInput): string {
  try {
    return JSON.stringify(batch) ?? "";
  } catch {
    return "";
  }
}

function Frame({
  frame,
  label,
  testId,
  alt,
}: {
  frame: { readonly pngBase64: string };
  label: string;
  testId: string;
  alt: string;
}): ReactElement {
  return (
    <figure className="min-w-0" data-testid={`${testId}-frame`}>
      <figcaption
        data-testid={`${testId}-label`}
        className="mb-1 text-caption font-medium text-secondary"
      >
        {label}
      </figcaption>
      <img
        data-testid={`${testId}-img`}
        src={`data:image/png;base64,${frame.pngBase64}`}
        alt={alt}
        className="h-auto max-h-40 w-auto max-w-full rounded-xs border border-subtle bg-elevated"
      />
    </figure>
  );
}

function FailurePanel({
  failure,
  onRetry,
}: {
  failure: PlanPreviewFailure | null;
  onRetry: () => void;
}): ReactElement {
  const message = failure?.message ?? "The preview could not be rendered.";
  const restored = failure?.restored ?? true;
  return (
    <div
      data-testid="plan-preview-failure"
      data-restored={String(restored)}
      className="flex flex-col gap-1.5 rounded-xs border border-subtle p-2"
    >
      <p data-testid="plan-preview-failure-title" className="text-caption text-danger">
        Preview unavailable
      </p>
      <p
        data-testid="plan-preview-failure-message"
        className="break-all text-caption text-secondary"
      >
        {message}
      </p>
      <p data-testid="plan-preview-failure-explain" className="text-caption text-muted">
        {restored
          ? "You can still apply or cancel the plan."
          : "The preview could not undo its probe — the editor may already show this plan applied. Check the timeline before applying."}
      </p>
      <Button
        variant="secondary"
        size="sm"
        data-testid="plan-preview-retry"
        className="self-start"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

// -- useSyncExternalStore plumbing for the no-controller render (declared before use) --

const NEVER_STATE: PlanPreviewState = {
  status: "idle",
  pair: null,
  failure: null,
};
const neverSubscribe = (): (() => void) => () => undefined;
const idleSnapshot = (): PlanPreviewState => NEVER_STATE;

export function PlanPreview({
  batch,
  timeTicks,
  plan,
  onPreviewFailed,
  controller,
  bridge,
}: PlanPreviewProps): ReactElement {
  const ownsController = controller === undefined;
  const effectiveController = useMemo<PlanPreviewController | null>(() => {
    if (controller !== undefined) return controller;
    if (bridge !== undefined) return createPlanPreviewController({ bridge });
    return null;
  }, [controller, bridge]);

  const [retryCount, setRetryCount] = useState(0);
  const onFailedRef = useRef<typeof onPreviewFailed>(onPreviewFailed);
  useEffect(() => {
    onFailedRef.current = onPreviewFailed;
  }, [onPreviewFailed]);

  const batchKey = useMemo(() => batchKeyOf(batch), [batch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: batchKey is the stable content identity of batch (plan events arrive as fresh literals — identical content must not re-probe the engine); retryCount is the deliberate Try-again trigger
  useEffect(() => {
    if (effectiveController === null) return;
    let cancelled = false;
    void effectiveController
      .capture(batch, { timeTicks, plan })
      .then((outcome): void => {
        if (cancelled) return;
        if (outcome.status === "failed") onFailedRef.current?.(outcome.failure);
      })
      .catch(() => undefined); // capture never rejects; belt and braces
    return () => {
      cancelled = true;
    };
  }, [effectiveController, batchKey, timeTicks, plan, retryCount]);

  // Dispose only what this component created (the integrator owns an injected controller).
  useEffect(() => {
    return () => {
      if (ownsController && effectiveController !== null) effectiveController.dispose();
    };
  }, [ownsController, effectiveController]);

  const state: PlanPreviewState = useSyncExternalStore(
    effectiveController === null ? neverSubscribe : effectiveController.subscribe,
    effectiveController === null ? idleSnapshot : effectiveController.getSnapshot,
  );

  const onRetry = (): void => {
    setRetryCount((count) => count + 1);
  };

  if (effectiveController === null) {
    return (
      <div data-testid="plan-preview" data-status="failed">
        <FailurePanel
          failure={{
            code: "PREVIEW_BEFORE_FAILED",
            message: "No editor connection for previews.",
            restored: true,
          }}
          onRetry={onRetry}
        />
      </div>
    );
  }

  const loading = state.status === "idle" || state.status === "loading";
  return (
    <div
      data-testid="plan-preview"
      data-status={state.status}
      className="flex flex-col gap-2 rounded-xs border border-subtle p-2"
    >
      {loading ? (
        <p
          data-testid="plan-preview-loading"
          className="flex items-center gap-2 text-caption text-secondary"
        >
          <Spinner size={16} label="Rendering preview" />
          Rendering preview…
        </p>
      ) : null}
      {state.status === "failed" ? (
        <FailurePanel failure={state.failure} onRetry={onRetry} />
      ) : null}
      {state.status === "ready" && state.pair !== null ? (
        <div data-testid="plan-preview-frames">
          <p
            data-testid="plan-preview-caption"
            data-time-source={state.pair.timeSource}
            className="text-caption text-muted"
          >
            Preview ·{" "}
            <span data-testid="plan-preview-time">{timecodeLabel(state.pair.timeSeconds)}</span>
            {" · "}
            <span data-testid="plan-preview-source">
              {TIME_SOURCE_LABEL[state.pair.timeSource]}
            </span>
          </p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <Frame
              frame={state.pair.before}
              label="Before"
              testId="plan-preview-before"
              alt="Frame before the plan"
            />
            <Frame
              frame={state.pair.after}
              label="After"
              testId="plan-preview-after"
              alt="Frame after the plan — a preview, nothing is applied yet"
            />
          </div>
          <p data-testid="plan-preview-note" className="mt-1 text-caption text-muted">
            The after frame is a temporary preview — nothing is applied until you choose Apply.
          </p>
        </div>
      ) : null}
    </div>
  );
}
