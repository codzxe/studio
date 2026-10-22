/**
 * Plan preview engine — BUILD_PLAN §M5.3 ("Preview before/after frame at
 * playhead or first affected time"), EDITOR_CHAT_UX §6.2, PRODUCT_ARCHITECTURE
 * §8.5/§8.7/§8.9, DECISIONS.md D-7.
 *
 * DOC RULING (why an apply-probe is the documented approach): PA §8.7 places
 * Preview BEFORE Apply — "user clicks Preview (optional) → render.frame
 * before/after → user clicks Apply → client calls engine.batch". The only way
 * to render the AFTER frame before approval is to apply the compiled batch
 * momentarily, render, and undo. §8.5 makes that safe and exact: an agent
 * `engine.batch` is atomic (a failing step rolls the whole batch back —
 * `editor/crates/engine/src/commands/batch.rs`) and folds into exactly ONE
 * undo step, so a single `edit.undo` (no params — `commands/edit.rs`)
 * restores the pre-probe state. ECUX §6.2 pins the UI contract: "Preview
 * renders a before/after frame at the playhead (or the first affected
 * time)". PA §8.9 pins the failure contract ("Render timeout: preview
 * remains optional") — a failed preview NEVER blocks Apply.
 *
 * Bounds: D-7 caps the preview long edge at 1280 px; the established M4
 * `studio.render_preview` path (tool-executor.ts) caps `max_side` at 1200 —
 * this module reuses that exact cap (1200 ≤ 1280, one precedent for both
 * surfaces). Bridge `renderFrame` takes comp SECONDS in `time`; the M5 plan
 * surface speaks engine TICKS (254 016 000 000/s — `editor/crates/time/src/
 * lib.rs`, mirrored by the comments API's `timeTicks`), so every public time
 * here is ticks and converts once at the render call.
 *
 * Safety invariants (proven by the colocated tests):
 *   1. A successful probe batch is ALWAYS followed by `edit.undo` — even
 *      when the render fails (the critical invariant; leaving the plan
 *      applied would bypass approval, §8.7).
 *   2. A REJECTED batch is never followed by `edit.undo` — `engine.batch`
 *      is atomic upstream ("the batch was rolled back (nothing changed)"),
 *      so an undo would pop the user's OWN previous step instead.
 *   3. Probes serialize (one capture in flight per controller) — a probe
 *      never renders a "before" frame of another probe's applied state.
 *   4. A `previewGeneration` counter discards every stale outcome — an
 *      older preview resolving after a newer one can never apply over it
 *      (the only exception: an UNRESTORED probe failure, which must be
 *      surfaced for state integrity even when stale).
 *   5. Everything the plan carries (args, compiled step params, affected-
 *      layer text) is UNTRUSTED DATA: scanned defensively, bounded, never
 *      executed, rendered as text by the UI.
 */

import type { EditPlan } from "@studio/contracts";
import { type AgentBatchInput, type EditorBridge, messageOf } from "@studio/editor-bridge";

// ---------------------------------------------------------------------------
// Constants (D-7 + the engine clock)
// ---------------------------------------------------------------------------

/** Engine ticks per second (`editor/crates/time/src/lib.rs` TICKS_PER_SECOND). */
export const TICKS_PER_SECOND = 254_016_000_000;

/**
 * Preview render cap on the LONG edge (renderFrame `max_side`). D-7 allows
 * ≤1280; 1200 is the cap the M4 `studio.render_preview` path already uses —
 * one precedent for both surfaces (and §8.3's 1200px playhead budget).
 */
export const PREVIEW_MAX_SIDE = 1200;

/**
 * Upper bound for any time the PLAN may nominate (1 h). Also keeps
 * seconds→ticks inside Number.MAX_SAFE_INTEGER (3600 × 254 016 000 000 ≈
 * 9.1e14 ≪ 2^53) so tick math stays exact.
 */
export const MAX_PREVIEW_SECONDS = 3600;

/** Human-message bound for failure copy (editor strings can carry hostile data). */
const MAX_FAILURE_MESSAGE = 200;

/** Comp seconds → engine ticks (rounded to the nearest tick). */
export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

/** Engine ticks → comp seconds (the unit `renderFrame.time` speaks). */
export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

// ---------------------------------------------------------------------------
// Failures (typed, never a bare throw at this boundary)
// ---------------------------------------------------------------------------

export type PlanPreviewFailureCode =
  /** The BEFORE frame could not be rendered (inspect/render failed; nothing was applied). */
  | "PREVIEW_BEFORE_FAILED"
  /** `engine.batch` rejected — atomic upstream rollback; nothing was applied. */
  | "PREVIEW_BATCH_FAILED"
  /** The AFTER render failed AFTER the probe batch — the probe undid itself (state restored). */
  | "PREVIEW_RENDER_FAILED"
  /** `edit.undo` failed — the probe could NOT restore the editor (state may be left applied). */
  | "PREVIEW_UNDO_FAILED";

export interface PlanPreviewFailure {
  readonly code: PlanPreviewFailureCode;
  /** Human-safe, length-bounded message (hostile strings arrive as data). */
  readonly message: string;
  /** Whether the editor state is known-restored (drives the UI explanation). */
  readonly restored: boolean;
}

/** Internal carrier — the public captures throw it, the controller maps it. */
export class PreviewCaptureError extends Error {
  readonly failure: PlanPreviewFailure;

  constructor(failure: PlanPreviewFailure) {
    super(failure.message);
    this.name = "PreviewCaptureError";
    this.failure = failure;
  }
}

/** Bounded human message from any rejection (editor strings are untrusted data). */
function humanMessage(error: unknown): string {
  const raw = messageOf(error);
  const text = raw.length === 0 ? "The preview could not be rendered." : raw;
  return text.length > MAX_FAILURE_MESSAGE ? `${text.slice(0, MAX_FAILURE_MESSAGE)}…` : text;
}

function previewFailure(
  code: PlanPreviewFailureCode,
  error: unknown,
  restored: boolean,
): PreviewCaptureError {
  return new PreviewCaptureError({ code, message: humanMessage(error), restored });
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** One rendered frame (bridge `renderFrame` result + the required image). */
export interface PlanPreviewFrame {
  readonly comp: number | string;
  /** Comp seconds the frame was rendered at. */
  readonly time: number;
  readonly width: number;
  readonly height: number;
  readonly pngBase64: string;
}

/** Where the preview time came from (caption copy, ECUX §6.2). */
export type PlanPreviewTimeSource = "explicit" | "plan" | "playhead";

/** A resolved capture time. */
export interface PlanPreviewTime {
  readonly ticks: number;
  readonly source: PlanPreviewTimeSource;
}

/** A finite, in-bounds tick value (0 ≤ t ≤ MAX_PREVIEW_SECONDS worth of ticks). */
function validTicks(ticks: number): number | null {
  if (!Number.isFinite(ticks) || ticks < 0) return null;
  if (ticks > secondsToTicks(MAX_PREVIEW_SECONDS)) return null;
  return ticks;
}

/**
 * Resolve one frame's comp seconds: explicit ticks win, otherwise the
 * playhead (one `ui.inspect` — raw comp seconds per the verified control
 * surface). Never re-reads the playhead mid-probe.
 */
async function resolveSeconds(
  bridge: EditorBridge,
  timeTicks: number | null | undefined,
  code: PlanPreviewFailureCode,
): Promise<number> {
  if (timeTicks !== undefined && timeTicks !== null) {
    const ticks = validTicks(timeTicks);
    if (ticks === null) {
      throw previewFailure(code, "The preview time is not valid.", true);
    }
    return ticksToSeconds(ticks);
  }
  let inspect;
  try {
    inspect = await bridge.inspect();
  } catch (error) {
    throw previewFailure(code, error, true);
  }
  return inspect.time;
}

/** renderFrame at the resolved time, D-7/M4-bounded, with a required image. */
async function renderFrameAt(
  bridge: EditorBridge,
  seconds: number,
  code: PlanPreviewFailureCode,
): Promise<PlanPreviewFrame> {
  let frame;
  try {
    frame = await bridge.renderFrame({ time: seconds, max_side: PREVIEW_MAX_SIDE });
  } catch (error) {
    throw previewFailure(code, error, true);
  }
  if (typeof frame.pngBase64 !== "string" || frame.pngBase64.length === 0) {
    throw previewFailure(code, "The editor returned no image for this frame.", true);
  }
  return {
    comp: frame.comp,
    time: frame.time,
    width: frame.width,
    height: frame.height,
    pngBase64: frame.pngBase64,
  };
}

// ---------------------------------------------------------------------------
// captureBeforeFrame / captureAfterPreview (the two documented captures)
// ---------------------------------------------------------------------------

export interface CaptureTimeOptions {
  /** Engine ticks to render at; null/undefined → the playhead. */
  readonly timeTicks?: number | null;
}

/**
 * Render the CURRENT project state at the playhead (or the given ticks).
 * Read-only: no engine command ever runs. Throws `PreviewCaptureError`
 * (PREVIEW_BEFORE_FAILED) on any failure — nothing was applied.
 */
export async function captureBeforeFrame(
  bridge: EditorBridge,
  opts: CaptureTimeOptions = {},
): Promise<PlanPreviewFrame> {
  const seconds = await resolveSeconds(bridge, opts.timeTicks, "PREVIEW_BEFORE_FAILED");
  return await renderFrameAt(bridge, seconds, "PREVIEW_BEFORE_FAILED");
}

/**
 * The M5 apply-probe: atomically run the compiled batch (ONE `engine.batch`
 * = ONE undo step, §8.5), render the same time, then `edit.undo` — ALWAYS
 * restoring the state, even when the render fails.
 *
 * Order of operations (proven in the colocated tests):
 *   1. `bridge.batch(batch)` — §8.5-validated, atomic. A REJECTION means
 *      the engine rolled back and nothing changed: NO undo follows (an
 *      undo would pop the user's own previous step instead).
 *   2. `bridge.renderFrame` at the same comp seconds — failure is
 *      EXPECTED and does not skip step 3.
 *   3. `bridge.execute("edit.undo")` — unconditional once the batch
 *      succeeded. Its failure is the most serious outcome (the plan may be
 *      left applied without approval) and wins the failure code.
 *
 * Throws `PreviewCaptureError` (never a bare error) on any failure.
 */
export async function captureAfterPreview(
  bridge: EditorBridge,
  batch: AgentBatchInput,
  opts: CaptureTimeOptions = {},
): Promise<PlanPreviewFrame> {
  // 1. Apply — atomic upstream; a rejection leaves the project untouched.
  try {
    await bridge.batch(batch);
  } catch (error) {
    throw previewFailure("PREVIEW_BATCH_FAILED", error, true);
  }

  // 2. Render the after-frame (its failure is remembered, not thrown past 3).
  let rendered: PlanPreviewFrame | null = null;
  let renderFailure: PlanPreviewFailure | null = null;
  try {
    const seconds = await resolveSeconds(bridge, opts.timeTicks, "PREVIEW_RENDER_FAILED");
    rendered = await renderFrameAt(bridge, seconds, "PREVIEW_RENDER_FAILED");
  } catch (error) {
    renderFailure =
      error instanceof PreviewCaptureError
        ? error.failure
        : { code: "PREVIEW_RENDER_FAILED", message: humanMessage(error), restored: true };
  }

  // 3. ALWAYS restore — the critical invariant. `engine.batch` folded into
  //    exactly one undo step, so one `edit.undo` reverts the whole probe.
  try {
    await bridge.execute("edit.undo");
  } catch (error) {
    throw previewFailure("PREVIEW_UNDO_FAILED", error, false);
  }

  if (rendered !== null) return rendered;
  throw new PreviewCaptureError(
    renderFailure ?? {
      code: "PREVIEW_RENDER_FAILED",
      message: "The after-frame could not be rendered.",
      restored: true,
    },
  );
}

// ---------------------------------------------------------------------------
// First affected time (ECUX §6.2 "or the first affected time")
// ---------------------------------------------------------------------------

/** Step-arg / compiled-param keys carrying comp SECONDS. */
const TIME_KEYS_SECONDS: ReadonlySet<string> = new Set([
  "time",
  "timeseconds",
  "starttime",
  "startseconds",
]);

/** Step-arg / compiled-param keys carrying engine TICKS. */
const TIME_KEYS_TICKS: ReadonlySet<string> = new Set(["timeticks", "startticks"]);

/** Bounded scan (hostile args can be deep/large; this walk is data-only). */
const MAX_WALK_NODES = 256;
const MAX_WALK_DEPTH = 6;

/** "0.45s", "2 s", "1.5 seconds" inside affected-layer change text (data, not commands). */
const TEXT_TIME = /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i;

/** A plan-carried seconds value, or null (non-numbers and out-of-bounds values are data, not times). */
function planSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_PREVIEW_SECONDS) return null;
  return value;
}

/**
 * Collect every time the value tree carries under the curated keys.
 * Own-enumerable entries only (`Object.entries`) — a JSON `__proto__` key is
 * read as inert data, never written through to the prototype. Bounded to
 * MAX_WALK_NODES nodes and MAX_WALK_DEPTH levels.
 */
function collectTimeTicks(value: unknown, out: number[]): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) return;
    nodes += 1;
    if (nodes > MAX_WALK_NODES) return;
    if (item.depth >= MAX_WALK_DEPTH) continue;
    const current = item.value;
    if (Array.isArray(current)) {
      for (const entry of current) stack.push({ value: entry, depth: item.depth + 1 });
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    for (const [key, entry] of Object.entries(current)) {
      const normalized = key.toLowerCase();
      if (TIME_KEYS_SECONDS.has(normalized)) {
        const asSeconds = planSeconds(entry);
        if (asSeconds !== null) {
          out.push(secondsToTicks(asSeconds));
          continue;
        }
      } else if (TIME_KEYS_TICKS.has(normalized)) {
        // Tick keys validate in the TICK domain (1e12 ticks ≈ 3.9 s is valid).
        const asTicks = typeof entry === "number" ? validTicks(entry) : null;
        if (asTicks !== null) {
          out.push(asTicks);
          continue;
        }
      }
      stack.push({ value: entry, depth: item.depth + 1 });
    }
  }
}

/** Seconds named in affected-layer change text ("overshoot at 0.45s") — data extraction only. */
function textSeconds(text: string): number | null {
  const match = TEXT_TIME.exec(text);
  if (match === null) return null;
  return planSeconds(Number(match[1]));
}

/**
 * The FIRST AFFECTED TIME of a plan, in engine ticks — the earliest time the
 * plan itself names (ECUX §6.2's playhead alternative). Scanned, in order:
 * step `args`, each step's compiled `batch.steps[].params`, then
 * `affectedLayers[].change` text; the earliest in-bounds value wins (ties →
 * first mentioned). Null when the plan carries no usable time (→ playhead).
 * Deterministic and total: hostile plans are scanned as bounded data.
 */
export function firstAffectedTimeTicks(plan: EditPlan): number | null {
  const candidates: number[] = [];
  for (const step of plan.steps) {
    collectTimeTicks(step.args, candidates);
    for (const batchStep of step.batch.steps) {
      collectTimeTicks(batchStep.params, candidates);
    }
  }
  for (const layer of plan.affectedLayers) {
    const seconds = textSeconds(layer.change);
    if (seconds !== null) candidates.push(secondsToTicks(seconds));
  }
  let best: number | null = null;
  for (const ticks of candidates) {
    if (ticks >= 0 && (best === null || ticks < best)) best = ticks;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Controller (the seam M5-G's plan card consumes through its preview slot)
// ---------------------------------------------------------------------------

/** One before/after capture, ready to render. */
export interface PlanPreviewPair {
  readonly before: PlanPreviewFrame;
  readonly after: PlanPreviewFrame;
  /** Comp seconds both frames rendered at (identical by construction). */
  readonly timeSeconds: number;
  /** The same time in engine ticks. */
  readonly timeTicks: number;
  /** Where the time came from (caption copy). */
  readonly timeSource: PlanPreviewTimeSource;
}

export type PlanPreviewStatus = "idle" | "loading" | "ready" | "failed";

export interface PlanPreviewState {
  readonly status: PlanPreviewStatus;
  readonly pair: PlanPreviewPair | null;
  readonly failure: PlanPreviewFailure | null;
}

export const INITIAL_PLAN_PREVIEW_STATE: PlanPreviewState = {
  status: "idle",
  pair: null,
  failure: null,
};

/** What `capture()` resolves to — stale outcomes carry no payload. */
export type PlanPreviewCapture =
  | { readonly status: "ready"; readonly pair: PlanPreviewPair }
  | { readonly status: "failed"; readonly failure: PlanPreviewFailure }
  | { readonly status: "stale" };

export interface PlanPreviewCaptureOptions extends CaptureTimeOptions {
  /** The plan whose first affected time wins when `timeTicks` is absent. */
  readonly plan?: EditPlan | null;
}

export interface PlanPreviewController {
  /** Referentially stable between changes (useSyncExternalStore contract). */
  getSnapshot(): PlanPreviewState;
  subscribe(listener: () => void): () => void;
  /**
   * Capture before/after for `batch`. Never rejects; resolves `stale` when a
   * newer capture superseded this one (an unrestored failure still resolves
   * `failed` — state integrity outranks freshness).
   */
  capture(batch: AgentBatchInput, opts?: PlanPreviewCaptureOptions): Promise<PlanPreviewCapture>;
  /** Drop listeners; later captures fail fast with a typed failure. */
  dispose(): void;
}

export interface PlanPreviewControllerDeps {
  readonly bridge: EditorBridge;
}

const STALE: PlanPreviewCapture = { status: "stale" };

const DISPOSED_FAILURE: PlanPreviewFailure = {
  code: "PREVIEW_BEFORE_FAILED",
  message: "The preview is no longer available.",
  restored: true,
};

/**
 * Create the preview controller for one plan card (or one thread — the
 * integrator owns its lifetime). Time resolution per capture: explicit
 * `timeTicks` → the plan's first affected time → the playhead. Probes
 * SERIALIZE on the shared editor (invariant 3) and every outcome passes the
 * generation guard (invariant 4).
 */
export function createPlanPreviewController(
  deps: PlanPreviewControllerDeps,
): PlanPreviewController {
  const { bridge } = deps;
  let snapshot: PlanPreviewState = INITIAL_PLAN_PREVIEW_STATE;
  const listeners = new Set<() => void>();
  /** Bumped per capture; only the newest generation may surface. */
  let generation = 0;
  let disposed = false;
  /** Serialized probe queue tail — never rejects (invariant 3). */
  let tail: Promise<unknown> = Promise.resolve();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const commit = (next: PlanPreviewState): void => {
    if (next === snapshot) return;
    snapshot = next;
    notify();
  };

  /** explicit ticks → plan first-affected → playhead (one inspect). */
  async function resolveTime(
    opts: PlanPreviewCaptureOptions | undefined,
  ): Promise<PlanPreviewTime> {
    if (opts?.timeTicks !== undefined && opts?.timeTicks !== null) {
      const ticks = validTicks(opts.timeTicks);
      if (ticks === null) {
        throw previewFailure("PREVIEW_BEFORE_FAILED", "The preview time is not valid.", true);
      }
      return { ticks, source: "explicit" };
    }
    if (opts?.plan) {
      const ticks = firstAffectedTimeTicks(opts.plan);
      if (ticks !== null) return { ticks, source: "plan" };
    }
    let inspect;
    try {
      inspect = await bridge.inspect();
    } catch (error) {
      throw previewFailure("PREVIEW_BEFORE_FAILED", error, true);
    }
    return { ticks: secondsToTicks(inspect.time), source: "playhead" };
  }

  async function run(
    gen: number,
    batch: AgentBatchInput,
    opts: PlanPreviewCaptureOptions | undefined,
  ): Promise<PlanPreviewCapture> {
    try {
      const time = await resolveTime(opts);
      const before = await captureBeforeFrame(bridge, { timeTicks: time.ticks });
      // Nothing is applied yet — a superseded capture bails BEFORE probing.
      if (gen !== generation) return STALE;
      const after = await captureAfterPreview(bridge, batch, { timeTicks: time.ticks });
      const pair: PlanPreviewPair = {
        before,
        after,
        timeSeconds: before.time,
        timeTicks: time.ticks,
        timeSource: time.source,
      };
      if (gen !== generation) return STALE;
      commit({ status: "ready", pair, failure: null });
      return { status: "ready", pair };
    } catch (error) {
      const failure =
        error instanceof PreviewCaptureError
          ? error.failure
          : { code: "PREVIEW_BEFORE_FAILED", message: humanMessage(error), restored: true };
      // An unrestored probe must be surfaced even when stale (invariant 4):
      // the editor may be left showing this plan applied.
      if (gen !== generation && failure.restored) return STALE;
      commit({ status: "failed", pair: snapshot.pair, failure });
      return { status: "failed", failure };
    }
  }

  return {
    getSnapshot(): PlanPreviewState {
      return snapshot;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capture(
      batch: AgentBatchInput,
      opts?: PlanPreviewCaptureOptions,
    ): Promise<PlanPreviewCapture> {
      if (disposed) {
        return Promise.resolve({ status: "failed", failure: DISPOSED_FAILURE });
      }
      const gen = ++generation;
      if (snapshot.status !== "loading") {
        commit({
          status: "loading",
          pair: snapshot.status === "ready" ? snapshot.pair : null,
          failure: null,
        });
      }
      // Serialized: this capture's probe starts only after the previous
      // capture settled (including its undo). `run` never rejects.
      const started = tail.then(() => run(gen, batch, opts));
      tail = started.then(
        () => undefined,
        () => undefined,
      );
      return started;
    },
    dispose(): void {
      disposed = true;
      generation += 1; // any in-flight capture is now stale
      listeners.clear();
    },
  };
}
