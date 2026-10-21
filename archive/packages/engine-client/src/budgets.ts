// @studio/engine-client — client-side awareness of engine budgets (W2-B).
//
// Mirrors vendor crates/automation/src/budgets.rs and the transport limits in
// vendor/photocraft/docs/control-protocol.md: 1 MiB encoded request lines,
// 8 MiB encoded JSON replies (newline included), 5 MiB PNG results, a 2048 px
// preview edge and a 64 MiPx (67,108,864 px) render-source ceiling. Studio §2.2
// requires the worker/client to respect these BEFORE dispatch. §14.1 adds
// plan-gated canvas ceilings (32/64/128 MP) — the business plan's 128 MP exceeds
// the engine-side ceiling, so such requests are refused client-side with a
// dedicated error until the engine budget is raised (see the note in
// @studio/config constants/limits.ts). §5.1: agent observe previews request
// ≤1024 px — always send the smallest render that answers the question.
//
// Shared ceilings live in @studio/config (single source of truth, §4) and are
// re-exported here so engine-client consumers need no direct config import.
// Connection cap (16) and socket timeouts (30 s) belong to the transport owner.
import {
  AGENT_OBSERVE_PREVIEW_PX,
  ENGINE_MAX_CANVAS_MEGAPIXELS,
  ENGINE_PNG_MAX_BYTES,
  ENGINE_PREVIEW_MAX_PX,
  ENGINE_REPLY_MAX_BYTES,
  type PlanId,
  planLimits,
} from "@studio/config";

// Re-exported so engine-client consumers need no direct @studio/config import.
// Shared ceilings stay defined in @studio/config (single source of truth, §4).
export {
  /** Maximum encoded JSON reply, including its newline (budgets.rs MAX_RESPONSE_BYTES). */
  ENGINE_REPLY_MAX_BYTES,
  /** Maximum PNG bytes before base64 encoding or writing a rendered file (budgets.rs MAX_PNG_BYTES). */
  ENGINE_PNG_MAX_BYTES,
  /** Maximum requested preview edge; 0 still means full size within this ceiling (budgets.rs MAX_PREVIEW_SIDE). */
  ENGINE_PREVIEW_MAX_PX,
  /** Hard engine-side canvas ceiling in megapixels (§2.2). */
  ENGINE_MAX_CANVAS_MEGAPIXELS,
  /** Agent observe-loop preview edge (§5.1: render a ≤1024 px PNG after each phase). */
  AGENT_OBSERVE_PREVIEW_PX,
};

/** Plan id type for checkCanvasMegapixels (§14.1). */
export type { PlanId };

/** Maximum encoded JSON request line (security.rs MAX_REQUEST_BYTES); oversize closes the TCP connection. */
export const ENGINE_REQUEST_MAX_BYTES = 1 << 20; // 1 MiB

/** Maximum steps in one headless `batch` / MCP `command_batch` request (security.rs MAX_BATCH_STEPS). */
export const ENGINE_MAX_BATCH_STEPS = 256;

/** Maximum source pixels processed by a headless automation preview (budgets.rs MAX_RENDER_SOURCE_PIXELS). */
export const ENGINE_MAX_RENDER_SOURCE_PIXELS = 64 << 20; // 67,108,864 px = 64 MiPx

// ---------------------------------------------------------------------------
// Error surface — fleet envelope shape (docs/AGENTS.md). Self-contained on
// purpose: W2-B owns only src/{auth,capabilities,budgets}.ts, so each module
// keeps its own envelope (structurally compatible with @studio/config's Failure).
// ---------------------------------------------------------------------------

/** Budget-surface error codes. Add-only, stable strings (§13.3 discipline). */
export const BUDGET_ERROR_CODES = [
  "frame_too_large", // Encoded frame exceeds the 8 MiB reply / 1 MiB request ceiling.
  "png_too_large", // PNG exceeds the 5 MiB cap (budgets.rs check_png).
  "invalid_preview_side", // Requested preview edge is not a finite non-negative number.
  "invalid_png_size", // PNG byte count is not a valid non-negative integer.
  "invalid_canvas_dimensions", // Canvas dimensions are not positive integers.
  "canvas_exceeds_plan_limit", // §14.1 plan ceiling (32/64/128 MP) exceeded.
  "canvas_exceeds_engine_limit", // §2.2 hard engine ceiling (64 MiPx) exceeded.
] as const satisfies readonly string[];

export type BudgetErrorCode = (typeof BUDGET_ERROR_CODES)[number];

export interface BudgetFailure {
  readonly ok: false;
  readonly code: BudgetErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type BudgetResult<T> = { readonly ok: true; readonly value: T } | BudgetFailure;

interface FailOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

function fail(code: BudgetErrorCode, message: string, options: FailOptions = {}): BudgetFailure {
  const failure: {
    ok: false;
    code: BudgetErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
  } = {
    ok: false,
    code,
    message,
  };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Frame size checks (reply / request)
// ---------------------------------------------------------------------------

/** One encoded JSON-lines frame, as a string or raw bytes. */
export type EngineFrame = string | Uint8Array;

const encoder = new TextEncoder();

export function frameByteLength(frame: EngineFrame): number {
  return typeof frame === "string" ? encoder.encode(frame).byteLength : frame.byteLength;
}

/**
 * Reject a reply frame that exceeds the 8 MiB reply budget (newline included).
 * The engine enforces the same ceiling server-side (budgets.rs write_reply) and
 * replaces an oversized reply with a small error whose text says the operation
 * may have completed — this mirrors that semantics so callers retry correctly.
 */
export function validateReplySize(frame: EngineFrame): BudgetResult<{ bytes: number }> {
  const bytes = frameByteLength(frame);
  if (bytes > ENGINE_REPLY_MAX_BYTES) {
    return fail(
      "frame_too_large",
      `engine reply frame of ${bytes} bytes exceeds the ${ENGINE_REPLY_MAX_BYTES} byte reply budget`,
      {
        hint: "the engine replaces an oversized reply with an error — the operation may already have completed; inspect state (doc.inspect) before retrying, request smaller previews, or write to a path beneath the write root",
        retryable: false,
      },
    );
  }
  return { ok: true, value: { bytes } };
}

/**
 * Reject a request frame that exceeds the 1 MiB request-line ceiling. An
 * oversized line is rejected by the engine BEFORE dispatch and the TCP
 * connection is closed (control-protocol.md, Transport limits), so catching it
 * client-side saves a doomed round trip and a reconnect.
 */
export function validateRequestSize(frame: EngineFrame): BudgetResult<{ bytes: number }> {
  const bytes = frameByteLength(frame);
  if (bytes > ENGINE_REQUEST_MAX_BYTES) {
    return fail(
      "frame_too_large",
      `engine request frame of ${bytes} bytes exceeds the ${ENGINE_REQUEST_MAX_BYTES} byte request-line budget`,
      {
        hint: "the engine closes a TCP connection after an oversized request line; split large batches (≤256 steps) or trim parameters",
        retryable: false,
      },
    );
  }
  return { ok: true, value: { bytes } };
}

/**
 * Reject a PNG payload above the 5 MiB cap the engine applies before base64
 * encoding a preview or writing a rendered file (budgets.rs check_png).
 */
export function validatePngSize(pngBytes: number): BudgetResult<{ bytes: number }> {
  if (!Number.isSafeInteger(pngBytes) || pngBytes < 0) {
    return fail("invalid_png_size", "PNG byte count must be a non-negative integer");
  }
  if (pngBytes > ENGINE_PNG_MAX_BYTES) {
    return fail(
      "png_too_large",
      `PNG of ${pngBytes} bytes exceeds the ${ENGINE_PNG_MAX_BYTES} byte engine cap`,
      {
        hint: "render a smaller preview side (clampPreviewSide) or write the render to a path beneath the write root",
        retryable: false,
      },
    );
  }
  return { ok: true, value: { bytes: pngBytes } };
}

// ---------------------------------------------------------------------------
// Preview side clamping (§5.1 observe loop; budgets.rs MAX_PREVIEW_SIDE)
// ---------------------------------------------------------------------------

/** Who the preview is for: the agent observe loop (≤1024 px, §5.1) or interactive use (hard 2048 px cap). */
export type PreviewPurpose = "agent" | "interactive";

/** Requested-edge ceiling per purpose. */
export function previewCeiling(purpose: PreviewPurpose): number {
  return purpose === "agent" ? AGENT_OBSERVE_PREVIEW_PX : ENGINE_PREVIEW_MAX_PX;
}

export interface ClampedPreview {
  /** The `maxSide` value to send to the engine (≥ 1, ≤ the purpose ceiling). */
  readonly maxSide: number;
  /** True whenever the emitted side differs from the request (flooring or ceiling). */
  readonly clamped: boolean;
}

/**
 * Clamp a requested preview edge to the purpose ceiling. `maxSide: 0` means
 * FULL SIZE to the engine and fails when the document's longest edge exceeds
 * 2048, so anything below 1 px is treated as "no explicit size" and clamped
 * to the ceiling instead of ever sending 0.
 */
export function clampPreviewSide(
  requestedPx: number,
  purpose: PreviewPurpose = "agent",
): BudgetResult<ClampedPreview> {
  if (!Number.isFinite(requestedPx) || requestedPx < 0) {
    return fail(
      "invalid_preview_side",
      "requested preview side must be a finite non-negative number",
    );
  }
  const ceiling = previewCeiling(purpose);
  if (requestedPx < 1) {
    return { ok: true, value: { maxSide: ceiling, clamped: true } };
  }
  const maxSide = Math.min(Math.floor(requestedPx), ceiling);
  return { ok: true, value: { maxSide, clamped: maxSide !== requestedPx } };
}

// ---------------------------------------------------------------------------
// Canvas megapixel ceiling (§14.1 plan gates + §2.2 engine hard ceiling)
// ---------------------------------------------------------------------------

export interface CanvasCheck {
  /** Total pixels (width × height). */
  readonly pixels: number;
  /** The same value in megapixels (decimal, §14.1 units). */
  readonly megapixels: number;
}

/**
 * Gate canvas/document creation against the workspace plan ceiling (§14.1:
 * 32/64/128 MP from @studio/config PLAN_LIMITS) and then the engine's hard
 * automation ceiling (§2.2, budgets.rs MAX_RENDER_SOURCE_PIXELS = 64 MiPx).
 * The plan gate fires first; a canvas that passes its plan but exceeds the
 * engine ceiling (any business-plan canvas above 64 MiPx) is refused with
 * canvas_exceeds_engine_limit until the engine budget is raised.
 *
 * The plan check compares each dimension against the ceiling too, which keeps
 * `width * height` exact: dimensions that pass are ≤ 128,000,000, so the
 * product never leaves the exactly-representable range of a double.
 */
export function checkCanvasMegapixels(
  width: number,
  height: number,
  plan: PlanId,
): BudgetResult<CanvasCheck> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return fail("invalid_canvas_dimensions", "canvas dimensions must be positive integers");
  }
  const planCeilingPixels = planLimits(plan).maxCanvasMegapixels * 1_000_000; // §14.1 decimal MP
  const pixels = width * height;
  if (width > planCeilingPixels || height > planCeilingPixels || pixels > planCeilingPixels) {
    return fail(
      "canvas_exceeds_plan_limit",
      `canvas of ${width}×${height} px exceeds the ${planLimits(plan).maxCanvasMegapixels} MP ceiling of the ${plan} plan`,
      { hint: "create a smaller canvas or upgrade the workspace plan (§14.1)", retryable: false },
    );
  }
  if (pixels > ENGINE_MAX_RENDER_SOURCE_PIXELS) {
    return fail(
      "canvas_exceeds_engine_limit",
      `canvas of ${width}×${height} px exceeds the engine automation ceiling of ${ENGINE_MAX_RENDER_SOURCE_PIXELS} pixels (§2.2)`,
      {
        hint: "the plan allows this size (§14.1), but the engine budget must be raised before it can run",
        retryable: false,
      },
    );
  }
  return { ok: true, value: { pixels, megapixels: pixels / 1_000_000 } };
}
