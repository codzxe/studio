"use client";

/**
 * QueueRenderCard — the project-hub queue entry (BUILD_PLAN §M8 task 2:
 * "Queue from … project hub; format, resolution, fps, range, quality; credit
 * estimate"). A compact "Render" card that expands into the inline queue
 * form — the same field set as the editor dialog concept (the editor's
 * dialog is M8-I's surface; this one queues from OUTSIDE the editor).
 *
 * Wire truth (contracts routes/renders.ts v2 + api-client `client.renders`):
 * - `POST /v1/renders/estimate` — the live quote (a PURE READ: no
 *   idempotency key anywhere). Debounced — rapid field changes coalesce to
 *   one call; stale answers are dropped (a per-tick cancellation flag).
 * - `POST /v1/renders` — queue. The idempotencyKey rides the BODY (§7.2,
 *   as first shipped) and is FRESH per submit (`crypto.randomUUID()`, the
 *   house beat-nonce recipe) — a retry gesture re-queues, a double-POST
 *   replays. The server pins the version snapshot; this card never sends one.
 * - D-2: the format picker offers ONLY the enabled two — MP4 and PNG
 *   sequence. ProRes/GIF/WAV stay declared on the wire but are refused at
 *   queue time; they are not offered here.
 *
 * The composition source (the wire has no comps-list endpoint outside the
 * editor): the host passes known comps (id + name) and the panel adds every
 * comp this project has already rendered (the M7-F `Comp <id>` house
 * fallback). With zero options the card stays honest — the editor is the
 * queue entry for a comp that has never been rendered.
 *
 * Typed failures surface with honest copy (§7.3/§14): insufficient credits
 * links to billing; concurrency/quota limits explain the plan boundary; any
 * other code renders message + hint + request id.
 */

import { isApiError } from "@studio/api-client";
import type {
  EstimateResult,
  QueueRenderRequest,
  RenderEstimateRequest,
  RenderFormat,
  RenderJob,
  RenderQuality,
  RenderSettings,
} from "@studio/contracts";
import { Button, Field, Input, buttonVariants } from "@studio/ui";
import { CircleAlert, Clapperboard, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { HubCompOption, RendersHubPort } from "./renders-panel";

// ---------------------------------------------------------------------------
// Options + formatters
// ---------------------------------------------------------------------------

/** D-2: the queue surface offers ONLY the enabled formats. */
export const QUEUE_FORMAT_OPTIONS: readonly {
  readonly id: RenderFormat;
  readonly label: string;
}[] = [
  { id: "mp4", label: "MP4 — video" },
  { id: "png-seq", label: "PNG sequence — frames" },
];

/** §7.2 quality ladder (contracts RENDER_QUALITY_SCHEMA). */
export const QUEUE_QUALITY_OPTIONS: readonly {
  readonly id: RenderQuality;
  readonly label: string;
}[] = [
  { id: "draft", label: "Draft" },
  { id: "good", label: "Good" },
  { id: "best", label: "Best" },
];

/**
 * Resolution presets (long-edge priced per @studio/config RENDER_RESOLUTION_
 * TIERS; per-plan caps are enforced server-side — the estimate reflects
 * them). v1 hub presets: 720p, 1080p, vertical 1080p.
 */
export const QUEUE_RESOLUTION_PRESETS = [
  { id: "1280x720", width: 1280, height: 720, label: "1280 × 720 — 720p" },
  { id: "1920x1080", width: 1920, height: 1080, label: "1920 × 1080 — 1080p" },
  { id: "1080x1920", width: 1080, height: 1920, label: "1080 × 1920 — vertical" },
] as const;

/** Common cinematic frame rates (RENDER_SETTINGS_SCHEMA: positive number). */
export const QUEUE_FPS_PRESETS = [24, 30, 60] as const;

/**
 * Whole-credit DISPLAY number (D-12): 14 → "14", 0.25 → "0.25",
 * 1234.5 → "1,234.5"; null/poison degrades to "—" (never a fake value).
 */
export function formatRenderCredits(credits: number | null): string {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return "—";
  return credits.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Output seconds for the estimate line: "30s" / "10.5s" / "—" on poison. */
export function formatOutputSeconds(seconds: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.round(seconds * 10) / 10;
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 1 })}s`;
}

/** Default estimate debounce (ms) — rapid field changes coalesce to one call. */
export const ESTIMATE_DEBOUNCE_MS = 350;

/** The composer's top-up destination (chat/footer precedent). */
const DEFAULT_TOP_UP_HREF = "/w/billing";

// ---------------------------------------------------------------------------
// Form state → wire settings
// ---------------------------------------------------------------------------

interface QueueFormState {
  readonly compId: string;
  readonly format: RenderFormat;
  readonly quality: RenderQuality;
  readonly resolutionId: string;
  readonly fps: number;
  readonly rangeFrom: string;
  readonly rangeTo: string;
}

const DEFAULT_FORM: QueueFormState = {
  compId: "",
  format: "mp4",
  quality: "good",
  resolutionId: QUEUE_RESOLUTION_PRESETS[1].id,
  fps: 24,
  rangeFrom: "",
  rangeTo: "",
};

/** Parse an optional seconds field: "" → undefined; garbage → null. */
function parseSeconds(value: string): number | null | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export type BuiltSettings = { readonly settings: RenderSettings } | { readonly error: string };

/**
 * Form state → `settings` for estimate + queue. Client-side honesty first:
 * a bad range explains itself and blocks BOTH calls (the gateway would only
 * answer VALIDATION_FAILED — this way the user learns before spending a
 * round-trip).
 */
export function buildQueueSettings(form: QueueFormState): BuiltSettings {
  const timeFrom = parseSeconds(form.rangeFrom);
  const timeTo = parseSeconds(form.rangeTo);
  if (timeFrom === null || timeTo === null) {
    return { error: "Use whole seconds, zero or more, for the range." };
  }
  if (timeFrom !== undefined && timeTo !== undefined && timeTo < timeFrom) {
    return { error: "The range end must come after its start." };
  }
  const preset =
    QUEUE_RESOLUTION_PRESETS.find((option) => option.id === form.resolutionId) ??
    QUEUE_RESOLUTION_PRESETS[1];
  const settings: RenderSettings = {
    width: preset.width,
    height: preset.height,
    frameRate: form.fps,
    quality: form.quality,
  };
  if (timeFrom !== undefined) settings.timeFrom = timeFrom;
  if (timeTo !== undefined) settings.timeTo = timeTo;
  return { settings };
}

// ---------------------------------------------------------------------------
// Typed failure copy (§7.3 codes → honest explanations)
// ---------------------------------------------------------------------------

export interface QueueErrorCopy {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
  /** Render a billing/top-up link next to the message. */
  readonly billingLink: boolean;
}

const GENERIC_QUEUE_ERROR: QueueErrorCopy = {
  message: "Something went wrong on our side.",
  hint: "Try again in a moment.",
  billingLink: false,
};

/** Bounded §14 line for the queue error banner. */
function bounded(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function queueErrorCopy(cause: unknown): QueueErrorCopy {
  if (isApiError(cause)) {
    switch (cause.code) {
      case "INSUFFICIENT_CREDITS":
        return {
          message: bounded(cause.message, 200),
          hint:
            cause.hint === undefined
              ? "Top up, then queue again — the estimate stays the same."
              : cause.hint,
          requestId: cause.requestId,
          billingLink: true,
        };
      case "RENDER_CONCURRENCY_LIMIT":
        return {
          message: "You're already running the maximum number of renders for your plan.",
          hint: "Wait for one to finish, then queue this one again.",
          requestId: cause.requestId,
          billingLink: false,
        };
      case "RENDER_QUOTA_EXCEEDED":
        return {
          message: "This render would go past your plan's monthly render minutes.",
          hint: "The limit resets with your billing cycle — or upgrade for more.",
          requestId: cause.requestId,
          billingLink: true,
        };
      case "RENDER_UNSUPPORTED_FORMAT":
        return {
          message: "That format isn't enabled yet.",
          hint: "MP4 and PNG sequence are the formats available today.",
          requestId: cause.requestId,
          billingLink: false,
        };
      case "VALIDATION_FAILED":
        return {
          message: "These render settings weren't accepted.",
          hint: "Check the range — the end must come after the start.",
          requestId: cause.requestId,
          billingLink: false,
        };
      default:
        return {
          message: bounded(cause.message, 200),
          hint: cause.hint,
          requestId: cause.requestId,
          billingLink: false,
        };
    }
  }
  return GENERIC_QUEUE_ERROR;
}

/** Estimate failures: the quote is a read — copy only, no retry surface. */
function estimateErrorCopy(cause: unknown): string {
  if (isApiError(cause)) {
    if (cause.code === "VALIDATION_FAILED") {
      return "These settings can't be estimated — check the range and resolution.";
    }
    if (cause.code === "RENDER_UNSUPPORTED_FORMAT") {
      return "That format isn't enabled yet — pick MP4 or PNG sequence.";
    }
    return bounded(cause.message, 200);
  }
  return "The estimate could not be loaded.";
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

type EstimateState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly result: EstimateResult | null }
  | { readonly status: "ready"; readonly result: EstimateResult }
  | { readonly status: "error"; readonly message: string };

/** The estimate line, narrowed per state (ready → the quote, loading keeps the last quote with a note). */
function estimateText(estimate: EstimateState): string {
  switch (estimate.status) {
    case "ready":
      return `Estimated ${formatRenderCredits(estimate.result.credits)} credits · ${formatOutputSeconds(estimate.result.outputSeconds)} · ${estimate.result.longEdgePx}px long edge${estimate.result.minApplied ? " · platform minimum applied" : ""}`;
    case "error":
      return estimate.message;
    case "loading":
      return estimate.result === null
        ? "Estimating…"
        : `Estimated ${formatRenderCredits(estimate.result.credits)} credits · ${formatOutputSeconds(estimate.result.outputSeconds)} · updating…`;
    case "idle":
      return "Adjust the settings to see the estimate.";
  }
}

export interface QueueRenderCardProps {
  readonly projectId: string;
  /** Renderable compositions (host-known ∪ already-rendered). */
  readonly comps: readonly HubCompOption[];
  /** Editor deep link — the honest fallback when no comp is known yet. */
  readonly editorHref: string;
  /** The api-client seam (estimate + queue); tests fake it. */
  readonly api: Pick<RendersHubPort, "estimateRender" | "queueRender">;
  /** Fires after a successful queue; the panel refreshes the list. */
  readonly onQueued: (job: RenderJob) => void;
  /** Estimate debounce in ms (tests shrink it). */
  readonly debounceMs?: number;
  /** Top-up destination for the insufficient-credits link. */
  readonly topUpHref?: string;
}

export function QueueRenderCard({
  projectId,
  comps,
  editorHref,
  api,
  onQueued,
  debounceMs,
  topUpHref,
}: QueueRenderCardProps): ReactElement {
  const debounce = debounceMs ?? ESTIMATE_DEBOUNCE_MS;
  const topUp = topUpHref ?? DEFAULT_TOP_UP_HREF;

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<QueueFormState>({ ...DEFAULT_FORM, compId: comps[0]?.id ?? "" });
  const [estimate, setEstimate] = useState<EstimateState>({ status: "idle" });
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueError, setQueueError] = useState<QueueErrorCopy | null>(null);
  const [queueNote, setQueueNote] = useState<string | null>(null);

  // Host comps can arrive after mount (the list loads async) — adopt the
  // first option once, only while the user hasn't chosen.
  const firstComp = comps[0];
  useEffect(() => {
    if (form.compId === "" && firstComp !== undefined) {
      setForm((current) => ({ ...current, compId: firstComp.id }));
    }
  }, [firstComp, form.compId]);

  const built = useMemo(() => buildQueueSettings(form), [form]);
  const canQueue = form.compId !== "" && "settings" in built && !queueBusy;

  // Live estimate — debounced; a settings error explains itself with no call.
  useEffect(() => {
    if (!open || form.compId === "") {
      setEstimate({ status: "idle" });
      return;
    }
    if (!("settings" in built)) {
      setEstimate({ status: "error", message: built.error });
      return;
    }
    let cancelled = false;
    setEstimate((current) =>
      current.status === "ready"
        ? { status: "loading", result: current.result }
        : { status: "loading", result: null },
    );
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.estimateRender({
            projectId,
            compId: form.compId,
            format: form.format,
            settings: built.settings,
          } satisfies RenderEstimateRequest);
          if (!cancelled) setEstimate({ status: "ready", result });
        } catch (cause) {
          if (!cancelled) setEstimate({ status: "error", message: estimateErrorCopy(cause) });
        }
      })();
    }, debounce);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, built, debounce, form.compId, form.format, open, projectId]);

  const submit = (): void => {
    if (!canQueue || !("settings" in built)) return;
    setQueueBusy(true);
    setQueueError(null);
    setQueueNote(null);
    void (async () => {
      try {
        const job = await api.queueRender({
          projectId,
          compId: form.compId,
          format: form.format,
          settings: built.settings,
          idempotencyKey: crypto.randomUUID(),
        } satisfies QueueRenderRequest);
        setQueueBusy(false);
        setQueueNote("Render queued — watch its progress below.");
        onQueued(job);
      } catch (cause) {
        setQueueBusy(false);
        setQueueError(queueErrorCopy(cause));
      }
    })();
  };

  const selectClass =
    "h-9 w-full rounded-sm border border-border bg-input px-2 text-body text-primary transition-colors duration-120 outline-offset-2 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-signal";

  return (
    <div
      data-testid="renders-hub-queue"
      className="rounded-sm border border-border bg-elevated/40 p-4"
    >
      {comps.length === 0 ? (
        <div className="flex flex-col gap-2" data-testid="renders-hub-queue-empty">
          <p className="text-body-s text-secondary">
            No composition to queue here yet. Open the editor to queue a render from inside it.
          </p>
          <a
            href={editorHref}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            data-testid="renders-hub-queue-editor-link"
          >
            Open the editor
          </a>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-body-s text-secondary">
              Queue a final export — MP4 or PNG sequence.
            </p>
            {open ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                aria-label="Close the render form"
                data-testid="renders-hub-queue-close"
              >
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
                Close
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  setOpen(true);
                  setQueueNote(null);
                }}
                data-testid="renders-hub-queue-button"
              >
                <Clapperboard size={14} strokeWidth={1.75} aria-hidden="true" />
                Render
              </Button>
            )}
          </div>

          {open ? (
            <div className="mt-4 flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field id="renders-hub-comp" label="Composition">
                  {(control) => (
                    <select
                      id={control.id}
                      aria-describedby={control["aria-describedby"]}
                      aria-invalid={control["aria-invalid"]}
                      className={selectClass}
                      value={form.compId}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, compId: event.target.value }))
                      }
                      data-testid="renders-hub-comp"
                    >
                      {comps.map((comp) => (
                        <option key={comp.id} value={comp.id}>
                          {comp.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field id="renders-hub-format" label="Format">
                  {(control) => (
                    <select
                      id={control.id}
                      aria-describedby={control["aria-describedby"]}
                      aria-invalid={control["aria-invalid"]}
                      className={selectClass}
                      value={form.format}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          format: event.target.value as RenderFormat,
                        }))
                      }
                      data-testid="renders-hub-format"
                    >
                      {QUEUE_FORMAT_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field id="renders-hub-quality" label="Quality">
                  {(control) => (
                    <select
                      id={control.id}
                      aria-describedby={control["aria-describedby"]}
                      aria-invalid={control["aria-invalid"]}
                      className={selectClass}
                      value={form.quality}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          quality: event.target.value as RenderQuality,
                        }))
                      }
                      data-testid="renders-hub-quality"
                    >
                      {QUEUE_QUALITY_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field id="renders-hub-resolution" label="Resolution">
                  {(control) => (
                    <select
                      id={control.id}
                      aria-describedby={control["aria-describedby"]}
                      aria-invalid={control["aria-invalid"]}
                      className={selectClass}
                      value={form.resolutionId}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, resolutionId: event.target.value }))
                      }
                      data-testid="renders-hub-resolution"
                    >
                      {QUEUE_RESOLUTION_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field id="renders-hub-fps" label="Frame rate">
                  {(control) => (
                    <select
                      id={control.id}
                      aria-describedby={control["aria-describedby"]}
                      aria-invalid={control["aria-invalid"]}
                      className={selectClass}
                      value={String(form.fps)}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, fps: Number(event.target.value) }))
                      }
                      data-testid="renders-hub-fps"
                    >
                      {QUEUE_FPS_PRESETS.map((fps) => (
                        <option key={fps} value={String(fps)}>
                          {fps} fps
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <div className="grid grid-cols-2 gap-2">
                  <Input
                    id="renders-hub-range-from"
                    label="Range from (s)"
                    type="number"
                    min={0}
                    step={0.1}
                    inputMode="decimal"
                    placeholder="0"
                    value={form.rangeFrom}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, rangeFrom: event.target.value }))
                    }
                    data-testid="renders-hub-range-from"
                  />
                  <Input
                    id="renders-hub-range-to"
                    label="Range to (s)"
                    type="number"
                    min={0}
                    step={0.1}
                    inputMode="decimal"
                    placeholder="end"
                    value={form.rangeTo}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, rangeTo: event.target.value }))
                    }
                    data-testid="renders-hub-range-to"
                  />
                </div>
              </div>

              <p
                data-testid="renders-hub-estimate"
                data-state={estimate.status}
                className="text-caption text-secondary"
              >
                {estimateText(estimate)}
              </p>

              {queueError !== null ? (
                <div
                  role="alert"
                  data-testid="renders-hub-queue-error"
                  className="flex flex-wrap items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
                >
                  <CircleAlert
                    size={16}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-danger"
                  />
                  <span className="min-w-0 flex-1">
                    {queueError.message}
                    {queueError.requestId === undefined ? null : (
                      <span className="block text-muted">({queueError.requestId})</span>
                    )}
                    {queueError.hint === undefined ? null : (
                      <span className="block text-muted">{queueError.hint}</span>
                    )}
                  </span>
                  {queueError.billingLink ? (
                    <a
                      href={topUp}
                      className={buttonVariants({ variant: "secondary", size: "sm" })}
                      data-testid="renders-hub-queue-topup"
                    >
                      Top up credits
                    </a>
                  ) : null}
                </div>
              ) : null}

              {queueNote !== null ? (
                <p
                  data-testid="renders-hub-queue-note"
                  className="rounded-sm border border-border bg-app px-3 py-2 text-caption text-secondary"
                >
                  {queueNote}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  loading={queueBusy}
                  disabled={!canQueue}
                  onClick={submit}
                  data-testid="renders-hub-queue-submit"
                >
                  Queue render
                </Button>
                <span className="text-caption text-muted">
                  {canQueue
                    ? "Credits are charged when the render completes."
                    : "Pick a composition and a valid range first."}
                </span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
