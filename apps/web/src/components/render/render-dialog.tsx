"use client";

/**
 * `RenderDialog` — the "Render…" queue surface (BUILD_PLAN §M8 task 2;
 * DECISIONS D-2/D-7/D-11/D-12; UI_DESIGN_SYSTEM §7.5).
 *
 * Composition (prefilled from the live session — `comp.info` via the region):
 * - COMP chip: the active composition's name (or the honest "open a
 *   composition" note; queueing stays disabled without one).
 * - FORMAT: ONLY v1-enabled formats (D-2: mp4 + png-seq, labels from
 *   `@studio/config` RENDER_FORMATS; reserved formats are absent, never
 *   shown-disabled).
 * - RANGE: timeFrom/timeTo in seconds, defaulted to the comp's work-area
 *   in/out (else 0..duration); an inverted range is an inline error and
 *   disables queueing (the wire's own refine).
 * - FRAME RATE + RESOLUTION (Full/Half/Quarter of the comp's native size,
 *   explicit px readout) + QUALITY (draft/good/best).
 * - LIVE ESTIMATE: debounced `client.renders.estimate` (400 ms) showing
 *   credits (2-dp display number, D-12), output seconds, the server-clamped
 *   long-edge px (the client never guesses the plan cap — D-7's 1280 px is
 *   previews only) and the minApplied hint. Failures surface honestly and
 *   NON-BLOCKING: the server prices the truth at queue time and credits are
 *   only charged on completion.
 * - QUEUE: `client.renders.create({projectId, compId, format, settings,
 *   idempotencyKey: crypto.randomUUID()})` — typed server errors map to
 *   friendly copy (415/429/402; INSUFFICIENT_CREDITS links to billing).
 *
 * Overlay law (D-18): the dialog is a DOCUMENT-level Radix portal (focus
 * trap + Esc + focus restoration come from the primitive); the editor iframe
 * is never restyled or blocked (BP §M8 task 3) — a render never disables the
 * editor, and the editor never waits on the dialog.
 */

import type { EstimateResult, RenderFormat, RenderJob, RenderQuality } from "@studio/contracts";
import {
  Button,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from "@studio/ui";
import { AlertTriangle, Clapperboard } from "lucide-react";
import Link from "next/link";
import { type ReactElement, useEffect, useRef, useState } from "react";
import {
  DEFAULT_FRAME_RATE,
  RENDER_FORMAT_OPTIONS,
  RENDER_QUALITY_OPTIONS,
  RENDER_RESOLUTION_OPTIONS,
  type RenderResolutionTier,
  buildRenderSettings,
  defaultRange,
  formatCreditsDisplay,
  tierSize,
} from "./render-options";
import { ESTIMATE_ERROR_COPY, queueErrorCopy } from "./render-status";
import type { RenderClient, RenderComp } from "./types";

/** Debounce for the live estimate (ms) — tests tighten it. */
export const ESTIMATE_DEBOUNCE_MS = 400;

/** Billing route for the INSUFFICIENT_CREDITS affordance. */
const BILLING_HREF = "/w/billing";

export interface RenderDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The workspace-scoped renders client (the region's resolved scope); null while resolving. */
  readonly client: RenderClient | null;
  /** The project id; null while the scope resolves. */
  readonly projectId: string | null;
  /** True while the region is resolving the workspace+project scope. */
  readonly scopeResolving?: boolean;
  /** Honest scope-resolution failure copy; null when resolved/resolving. */
  readonly scopeError?: string | null;
  /** Retry the scope resolution. */
  readonly onRetryScope?: () => void;
  /** The live comp (comp.info via the region); null → resolving or none open. */
  readonly comp: RenderComp | null;
  /** True while the region is still reading the comp from the session. */
  readonly compResolving?: boolean;
  /** Fired on a successful queue: the region toasts + opens the history drawer. */
  readonly onQueued: (job: RenderJob) => void;
  /** Estimate debounce override (tests). */
  readonly estimateDebounceMs?: number;
}

/** One segmented-control segment (§7.1 ghost/sm; active = secondary + primary text). */
function Segment(props: {
  readonly testId: string;
  readonly label: string;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <Button
      variant={props.active ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={props.active}
      data-testid={props.testId}
      data-active={props.active || undefined}
      disabled={props.disabled}
      className={
        props.active ? "h-7 px-2.5 text-primary" : "h-7 px-2.5 text-secondary hover:text-primary"
      }
      onClick={props.onSelect}
    >
      {props.label}
    </Button>
  );
}

/** Parses a numeric input; null when empty/invalid/negative. */
function parseSeconds(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Shortest sensible input text for a seconds value ("10", "10.02"). */
function secondsInput(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function RenderDialog({
  open,
  onOpenChange,
  client,
  projectId,
  scopeResolving = false,
  scopeError = null,
  onRetryScope,
  comp,
  compResolving = false,
  onQueued,
  estimateDebounceMs = ESTIMATE_DEBOUNCE_MS,
}: RenderDialogProps): ReactElement {
  // -- picker state ---------------------------------------------------------
  const [format, setFormat] = useState<RenderFormat>(RENDER_FORMAT_OPTIONS[0]?.id ?? "mp4");
  const [quality, setQuality] = useState<RenderQuality>("good");
  const [tier, setTier] = useState<RenderResolutionTier>("full");

  // -- range/fps inputs (strings — controlled inputs stay honest) -----------
  const [fromInput, setFromInput] = useState("0");
  const [toInput, setToInput] = useState("0");
  const [fpsInput, setFpsInput] = useState(secondsInput(DEFAULT_FRAME_RATE));
  const seededRef = useRef(false);

  // -- estimate state ---------------------------------------------------------
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const estimateGenerationRef = useRef(0);

  // -- queue state ------------------------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [queueError, setQueueError] = useState<{ code: string | null; message: string } | null>(
    null,
  );
  const queueButtonRef = useRef<HTMLButtonElement | null>(null);

  // -- comp prefill seeding (once per open, when the comp lands) --------------
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || comp === null || seededRef.current) return;
    seededRef.current = true;
    const range = defaultRange(comp);
    setFromInput(secondsInput(range.from));
    setToInput(secondsInput(range.to));
    setFpsInput(secondsInput(comp.frameRate ?? DEFAULT_FRAME_RATE));
  }, [open, comp]);

  // -- derived + validated inputs ---------------------------------------------
  const fromSeconds = parseSeconds(fromInput);
  const toSeconds = parseSeconds(toInput);
  const frameRate = parseSeconds(fpsInput);
  const rangeError =
    fromSeconds === null || toSeconds === null
      ? "Enter the range in seconds (0 or more)."
      : toSeconds < fromSeconds
        ? "The range end must not be before its start."
        : null;
  const fpsError = frameRate === null ? "Enter a frame rate above 0." : null;
  const inputsValid = rangeError === null && fpsError === null;
  const scopeReady = client !== null && projectId !== null && scopeError === null;
  const queueable = scopeReady && comp !== null && inputsValid && !submitting;

  const size = comp === null ? null : tierSize(comp, tier);

  // -- live estimate (debounced; generation-guarded; never blocks queueing) ----
  const estimateKey =
    comp === null || projectId === null
      ? ""
      : `${comp.compId}|${projectId}|${format}|${tier}|${fromInput}|${toInput}|${fpsInput}|${quality}`;

  useEffect(() => {
    if (
      !open ||
      estimateKey === "" ||
      comp === null ||
      client === null ||
      projectId === null ||
      !inputsValid
    ) {
      if (estimateGenerationRef.current !== 0) {
        estimateGenerationRef.current += 1; // supersede in-flight responses
      }
      return;
    }
    const generation = ++estimateGenerationRef.current;
    setEstimateLoading(true);
    const timer = setTimeout(() => {
      if (estimateGenerationRef.current !== generation) return;
      void client.renders
        .estimate({
          projectId,
          compId: comp.compId,
          format,
          settings: buildRenderSettings({
            comp,
            tier,
            timeFrom: fromSeconds ?? 0,
            timeTo: toSeconds ?? 0,
            frameRate: frameRate ?? DEFAULT_FRAME_RATE,
            quality,
          }),
        })
        .then(
          (result) => {
            if (estimateGenerationRef.current !== generation) return;
            setEstimate(result);
            setEstimateError(null);
            setEstimateLoading(false);
          },
          () => {
            if (estimateGenerationRef.current !== generation) return;
            setEstimate(null);
            setEstimateError(ESTIMATE_ERROR_COPY);
            setEstimateLoading(false);
          },
        );
    }, estimateDebounceMs);
    return () => clearTimeout(timer);
  }, [
    open,
    inputsValid,
    estimateKey,
    estimateDebounceMs,
    client,
    projectId,
    comp,
    format,
    tier,
    quality,
    fromSeconds,
    toSeconds,
    frameRate,
  ]);

  // Clear the transient copy when the dialog closes.
  useEffect(() => {
    if (!open) {
      setQueueError(null);
      setEstimate(null);
      setEstimateError(null);
      setEstimateLoading(false);
    }
  }, [open]);

  // -- queue ------------------------------------------------------------------
  const queue = (): void => {
    if (
      comp === null ||
      client === null ||
      projectId === null ||
      fromSeconds === null ||
      toSeconds === null ||
      frameRate === null
    ) {
      return;
    }
    setQueueError(null);
    setSubmitting(true);
    void client.renders
      .create({
        projectId,
        compId: comp.compId,
        format,
        settings: buildRenderSettings({
          comp,
          tier,
          timeFrom: fromSeconds,
          timeTo: toSeconds,
          frameRate,
          quality,
        }),
        // §7.2 idempotent mutation: one fresh key per attempt; the gateway
        // replays instead of double-charging on a retry of the SAME attempt.
        idempotencyKey: crypto.randomUUID(),
      })
      .then(
        (job) => {
          setSubmitting(false);
          onQueued(job);
        },
        (error: unknown) => {
          setSubmitting(false);
          setQueueError(queueErrorCopy(error));
        },
      );
  };

  // The queue button is the primary action: focus lands on it when the dialog
  // opens (keyboard: Enter queues with the visible, prefilled settings).
  const onOpenAutoFocus = (event: Event): void => {
    const button = queueButtonRef.current;
    if (button === null || button.disabled) return; // Radix keeps its default
    event.preventDefault();
    button.focus();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="render-dialog" onOpenAutoFocus={onOpenAutoFocus}>
        <DialogTitle>Render</DialogTitle>
        <DialogDescription>
          Queue a cloud render of the current composition. The editor keeps working while it runs.
        </DialogDescription>

        {/* Comp display — the live active comp from the session. */}
        <div
          data-testid="render-comp"
          className="mt-4 flex items-center gap-2 rounded-sm border border-border bg-input px-2.5 py-1.5"
        >
          <Clapperboard
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-secondary"
          />
          {comp !== null ? (
            <span className="min-w-0 flex-1 truncate text-body-s text-primary">
              {comp.compName}
            </span>
          ) : compResolving ? (
            <span className="min-w-0 flex-1 truncate text-body-s text-secondary">
              Reading the active composition…
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-body-s text-secondary">
              Open a composition in the editor to render.
            </span>
          )}
        </div>

        {/* Scope state — the region's workspace+project resolution (honest, retryable). */}
        {scopeResolving && scopeError === null ? (
          <p data-testid="render-scope-resolving" className="mt-2 text-caption text-secondary">
            Resolving the project to render…
          </p>
        ) : null}
        {scopeError !== null ? (
          <div
            data-testid="render-scope-error"
            className="mt-2 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-2"
          >
            <AlertTriangle
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-danger"
            />
            <p className="min-w-0 flex-1 text-caption text-primary">{scopeError}</p>
            {onRetryScope !== undefined ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="render-scope-retry"
                className="h-6 shrink-0 px-2 text-caption"
                onClick={onRetryScope}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Format — enabled-only (D-2), labels from @studio/config. */}
        <div className="mt-4">
          <p className="mb-1.5 text-hint text-secondary">Format</p>
          <fieldset className="flex flex-wrap items-center gap-1" aria-label="Output format">
            {RENDER_FORMAT_OPTIONS.map((option) => (
              <Segment
                key={option.id}
                testId={`render-format-${option.id}`}
                label={option.label}
                active={option.id === format}
                onSelect={() => setFormat(option.id)}
              />
            ))}
          </fieldset>
        </div>

        {/* Range + frame rate. */}
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Input
            id="render-range-from"
            data-testid="render-range-from"
            label="From (s)"
            inputSize="sm"
            inputMode="decimal"
            autoComplete="off"
            value={fromInput}
            disabled={comp === null}
            onChange={(event) => setFromInput(event.target.value)}
          />
          <Input
            id="render-range-to"
            data-testid="render-range-to"
            label="To (s)"
            inputSize="sm"
            inputMode="decimal"
            autoComplete="off"
            value={toInput}
            disabled={comp === null}
            onChange={(event) => setToInput(event.target.value)}
          />
          <Input
            id="render-framerate"
            data-testid="render-framerate"
            label="Frame rate"
            inputSize="sm"
            inputMode="decimal"
            autoComplete="off"
            value={fpsInput}
            disabled={comp === null}
            onChange={(event) => setFpsInput(event.target.value)}
          />
        </div>
        {rangeError !== null && comp !== null ? (
          <p data-testid="render-range-error" className="mt-1.5 text-hint text-danger">
            {rangeError}
          </p>
        ) : null}
        {fpsError !== null && comp !== null && rangeError === null ? (
          <p data-testid="render-framerate-error" className="mt-1.5 text-hint text-danger">
            {fpsError}
          </p>
        ) : null}

        {/* Resolution — tier of the comp's native size + explicit px readout. */}
        <div className="mt-4">
          <p className="mb-1.5 text-hint text-secondary">Resolution</p>
          <fieldset className="flex flex-wrap items-center gap-1" aria-label="Resolution">
            {RENDER_RESOLUTION_OPTIONS.map((option) => (
              <Segment
                key={option.id}
                testId={`render-resolution-${option.id}`}
                label={option.label}
                active={option.id === tier}
                disabled={comp === null}
                onSelect={() => setTier(option.id)}
              />
            ))}
          </fieldset>
          <p data-testid="render-size-readout" className="mt-1.5 text-caption text-muted">
            {size === null
              ? "The comp's native size (the server pins the exact output)."
              : `${size.width} × ${size.height} px requested`}
          </p>
        </div>

        {/* Quality. */}
        <div className="mt-4">
          <p className="mb-1.5 text-hint text-secondary">Quality</p>
          <fieldset className="flex flex-wrap items-center gap-1" aria-label="Quality">
            {RENDER_QUALITY_OPTIONS.map((option) => (
              <Segment
                key={option.id}
                testId={`render-quality-${option.id}`}
                label={option.label}
                active={option.id === quality}
                onSelect={() => setQuality(option.id)}
              />
            ))}
          </fieldset>
        </div>

        {/* Live estimate (debounced, server-priced, non-blocking). */}
        <div
          data-testid="render-estimate"
          data-loading={estimateLoading || undefined}
          data-error={estimateError !== null || undefined}
          className="mt-4 rounded-sm border border-border bg-input px-3 py-2.5"
        >
          {comp === null ? (
            <p className="text-caption text-muted">
              The estimate appears once a composition is open.
            </p>
          ) : estimateLoading ? (
            <p data-testid="render-estimate-loading" className="text-caption text-secondary">
              Estimating…
            </p>
          ) : estimate !== null ? (
            <div className="flex flex-col gap-0.5">
              <p className="text-body-s text-primary">
                ≈ {formatCreditsDisplay(estimate.credits)} · {estimate.outputSeconds} s output ·{" "}
                {estimate.longEdgePx} px long edge
              </p>
              {estimate.minApplied ? (
                <p data-testid="render-estimate-min" className="text-caption text-muted">
                  Includes the platform minimum charge.
                </p>
              ) : null}
              <p className="text-caption text-muted">
                Credits are charged only when the render completes.
              </p>
            </div>
          ) : estimateError !== null ? (
            <p data-testid="render-estimate-error" className="text-caption text-secondary">
              {estimateError}
            </p>
          ) : (
            <p className="text-caption text-muted">
              The estimate follows your settings — it updates as you change them.
            </p>
          )}
        </div>

        {/* Queue failure — inline (§7.7: never a toast), typed codes honest. */}
        {queueError !== null ? (
          <div
            data-testid="render-queue-error"
            data-code={queueError.code}
            className="mt-3 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-2"
          >
            <AlertTriangle
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-danger"
            />
            <p className="min-w-0 flex-1 text-caption text-primary">
              {queueError.message}
              {queueError.code === "INSUFFICIENT_CREDITS" ? (
                <>
                  {" "}
                  <Link
                    href={BILLING_HREF}
                    data-testid="render-billing-link"
                    className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
                  >
                    Top up credits
                  </Link>
                </>
              ) : null}
            </p>
          </div>
        ) : null}

        <DialogActions>
          <DialogClose asChild>
            <Button variant="secondary" data-testid="render-cancel-button">
              Cancel
            </Button>
          </DialogClose>
          <Button
            ref={queueButtonRef}
            variant="primary"
            data-testid="render-queue-button"
            loading={submitting}
            disabled={!queueable}
            onClick={queue}
          >
            Queue render
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
