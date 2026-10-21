// render_preview — §6 row 14: "Render PNG (≤1024 px) for the model/critic/user".
// Owner: W5-M.
//
// Engine command (verified, never invented): `doc.render {index?, maxSide?, path?}`
// (vendor crates/automation/src/rpc.rs) — `maxSide` is the long-edge cap
// (default 1024, 0 = full size); the reply is inline base64 PNG or a write-root
// file. Tools never expose raw command ids (§6): this tool calls the
// `ctx.engine.render` seam (types.ts EngineLike), whose adapter resolves the
// engine reply into `EngineRenderReport.image` raw PNG bytes.
//
// §5.1 "observe after act": after each execution phase the loop renders a
// ≤1024 px PNG and feeds ONLY that downscaled render (+ the layer summary) to
// the models — this tool is the MODEL-FACING wrapper around that render. The
// worker-side pipeline is W2-N's apps/worker/src/preview.ts (PreviewPipeline);
// this tool reuses its conventions (clamp ≤1024 agent / 2048 hard, PNG magic
// validation, §13.1 (document, width, revision) cache identity) but stays
// ENGINE-ONLY: no BullMQ, no storage SDK — persisting + signing are the
// injected `ctx.previews` sink seam declared below (W5-R assembly note).
//
// §3.4 budgets: renders get 30 s (5 s is the typical default) — the executor
// owns the clock and hands `run` a signal carrying that deadline
// (PREVIEW_RENDER_TIMEOUT_MS documents the policy); the tool passes the signal
// to every seam call and the defineTool boundary converts AbortError →
// engine_timeout. The call counts against the §5.2 tool-call cap but is
// READ-ONLY: no idempotency key, nothing charged against the mutating-command
// meter, safe to retry (§3.4). §2.2 engine budgets (PNG ≤ 5 MiB, preview edge
// ≤ 2048) are enforced engine-side and re-checked locally (validatePng + the
// clamp below).
//
// §6.1: the previewUrl is NEVER a filesystem path — http(s):// or an
// object-storage key only. The sink contract is validated HERE because §6.1
// must hold even if the wiring is wrong; storage keys never reach the model
// reply (only the previewUrl does).

import {
  AGENT_OBSERVE_PREVIEW_PX,
  ENGINE_PREVIEW_MAX_PX,
  PREVIEW_DEFAULT_WIDTH_PX,
} from "@studio/config";
import { z } from "zod";
import {
  MAX_PREVIEW_URL_CHARS,
  MAX_SUMMARY_CHARS,
  type ToolErr,
  ToolError,
  defineTool,
  err,
  ok,
  strictObject,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import type { EngineOutcome, EngineRenderReport, Tool, ToolContext } from "../types.js";
import { type PngCheck, validatePng } from "./image-generate.js";

// ---------------------------------------------------------------------------
// Policy constants (§3.4, §5.1, §2.2)
// ---------------------------------------------------------------------------

/** §3.4: renders get 30 s; the executor builds the run signal with this deadline. */
export const PREVIEW_RENDER_TIMEOUT_MS = 30_000;

/** §5.1: the agent observe loop feeds only ≤1024 px renders; the tool's ceiling. */
export const AGENT_PREVIEW_CEILING_PX = AGENT_OBSERVE_PREVIEW_PX;

/**
 * §2.2 hard engine-side ceiling (budgets.rs MAX_PREVIEW_SIDE). The agent clamp
 * keeps requests at ≤1024, so the hard cap can never bind — exported for the
 * assembler and tests to pin the relationship.
 */
export const ENGINE_HARD_PREVIEW_CEILING_PX = ENGINE_PREVIEW_MAX_PX;

/** Longest engine write-root path the tool will hand to the sink (path arm). */
const MAX_ENGINE_PATH_CHARS = 512;

// ---------------------------------------------------------------------------
// Argument schema (§6.1: strict; width ∈ {256, 512, 1024}, default 1024)
// ---------------------------------------------------------------------------

/** Allowed preview widths (§5.1 observe scale; ≤1024 by design). */
export const PREVIEW_WIDTHS = [256, 512, 1024] as const;
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number];

const zPreviewWidth = z.union([z.literal(256), z.literal(512), z.literal(1024)]);

export const renderPreviewArgsSchema = strictObject({
  /** Requested long-edge cap in px; 2048+ is rejected here (agent ceiling 1024). */
  width: zPreviewWidth.default(PREVIEW_DEFAULT_WIDTH_PX),
});

export type RenderPreviewArgs = z.output<typeof renderPreviewArgsSchema>;

// ---------------------------------------------------------------------------
// Width clamping (budgets seam mirror — engine-client budgets.ts W2-B)
// ---------------------------------------------------------------------------

export interface ClampedRenderWidth {
  /** The `maxEdgePx` actually sent to the engine (≥ 1, ≤ the 1024 agent ceiling). */
  readonly width: number;
  /** True whenever the emitted width differs from the request. */
  readonly clamped: boolean;
}

/**
 * Clamp a requested preview edge to the §5.1 agent ceiling (1024 px; the §2.2
 * hard engine ceiling of 2048 is therefore moot). Mirrors engine-client
 * `clampPreviewSide` 1:1 (tools import nothing from engine-client — README
 * "Layout": the seams are structural), with tool-surface error codes: anything
 * below 1 px means "no explicit size" and clamps to the ceiling instead of
 * ever sending 0 (`maxSide: 0` asks the engine for FULL size).
 */
export function clampRenderWidth(requestedPx: number): EngineOutcome<ClampedRenderWidth> {
  if (!Number.isFinite(requestedPx) || requestedPx < 0) {
    return err("invalid_args", "requested preview width must be a finite non-negative number", {
      hint: "width is 256, 512 or 1024 (§5.1 observe previews)",
      retryable: false,
    });
  }
  if (requestedPx < 1) {
    return { ok: true, value: { width: AGENT_PREVIEW_CEILING_PX, clamped: true } };
  }
  const width = Math.min(Math.floor(requestedPx), AGENT_PREVIEW_CEILING_PX);
  return { ok: true, value: { width, clamped: width !== requestedPx } };
}

// ---------------------------------------------------------------------------
// Worker-injected sink seam (declared here; types.ts keeps ctx minimal)
// ---------------------------------------------------------------------------

/** What the sink needs to store one preview: the §13.1 cache identity parts. */
export interface PreviewPutMeta {
  /** The clamped width actually rendered (the `w` of the storage key, §13.1). */
  readonly width: number;
  /** Document revision the render is of; the key's second identity component. */
  readonly revision?: number;
  /** Payload size in bytes (bytes arm only; sink-side size logging). */
  readonly byteLength?: number;
}

/** The sink's reply: the public URL and the internal object-storage key. */
export interface PreviewSinkPut {
  readonly previewUrl: string;
  readonly storageKey: string;
}

/**
 * Preview persistence + signing seam (§6 row 14, §13.1). The worker wires this
 * — W2-N's PreviewPipeline composes naturally: `put` = storage.put(key, bytes)
 * + storage.sign(key). The previewUrl contract is validated by the tool:
 * http(s):// or an object-storage key, never a filesystem path (§6.1).
 */
export interface PreviewSinkLike {
  /** Inline-bytes arm: persist the decoded PNG and return its public URL/key. */
  put(previewBytes: Uint8Array, meta: PreviewPutMeta): Promise<EngineOutcome<PreviewSinkPut>>;
  /**
   * File arm (optional): the engine wrote the PNG at this write-root path
   * (§3.2 capability roots); the sink ingests it by path and stores it
   * identically. Absent → the engine adapter must resolve replies to bytes.
   */
  putEnginePath?(path: string, meta: PreviewPutMeta): Promise<EngineOutcome<PreviewSinkPut>>;
}

/** The context the worker assembles for `render_preview`: ToolContext + sink. */
export interface RenderPreviewContext extends ToolContext {
  readonly previews: PreviewSinkLike;
}

function isRenderPreviewContext(value: ToolContext): value is RenderPreviewContext {
  return (value as Partial<RenderPreviewContext>).previews !== undefined;
}

function requireRenderPreviewContext(ctx: ToolContext): RenderPreviewContext {
  if (!isRenderPreviewContext(ctx)) {
    throw new ToolError("internal_error", "render_preview requires the preview-sink seam on ctx", {
      hint: "The agent runtime wires ctx.previews (§6 row 14); see the W5-R assembly note.",
      retryable: false,
    });
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Reply-safety predicates (§6.1 — the sink contract is enforced here)
// ---------------------------------------------------------------------------

/** Object-storage key form: relative, segmented, no schemes/drives/traversal. */
const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]*(?:\/[A-Za-z0-9][A-Za-z0-9._\-]*)*$/;

/**
 * Is this a legal previewUrl value from the sink? http(s):// only (the kit's
 * envelope rule is case-sensitive, so no uppercase schemes) or a relative
 * object-storage key. Filesystem paths — `file://`, leading `/`, drive letters,
 * backslashes, traversal — are contract violations (§6.1 never expose internal
 * paths). Root-relative gateway routes must be returned as absolute URLs.
 */
export function isSafePreviewUrlValue(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_PREVIEW_URL_CHARS) {
    return false;
  }
  if (url.includes("\\") || url.includes("..") || url.includes("\0")) {
    return false;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return true;
  }
  // Storage-key form (§13.1): relative, so a leading "/" or any scheme-like
  // colon ("file:", "C:") marks a filesystem path and is rejected.
  if (url.startsWith("/") || url.includes(":")) {
    return false;
  }
  return STORAGE_KEY_RE.test(url);
}

/** Storage keys are bookkeeping for the executor's preview journal — never echoed. */
function isSafeStorageKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_PREVIEW_URL_CHARS &&
    !key.includes("\\") &&
    !key.includes("..") &&
    !key.startsWith("/")
  );
}

/**
 * Is this a relative path beneath the engine's automation write root (§3.2
 * capability roots, e.g. `renders/preview-1024-r7.png`)? Absolute paths,
 * schemes (`file://`), drive letters, traversal and NUL are refused.
 */
export function isEngineWriteRootPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_ENGINE_PATH_CHARS) {
    return false;
  }
  if (path.includes(":") || path.includes("\\") || path.includes("..") || path.includes("\0")) {
    return false;
  }
  if (path.startsWith("/") || path.endsWith("/")) {
    return false;
  }
  return STORAGE_KEY_RE.test(path);
}

// ---------------------------------------------------------------------------
// PNG validation (shared with image_generate — single source, W5-F)
// ---------------------------------------------------------------------------

export type PngFailureReason = Extract<PngCheck, { ok: false }>["reason"];

const PNG_CHECK_HINTS: Record<PngFailureReason, string> = {
  empty: "the engine replied with an empty payload; re-render once (§5.7)",
  truncated: "the engine replied with a truncated PNG; re-render once (§5.7)",
  bad_magic: "the engine replied with a non-PNG payload; re-render once (§5.7)",
  bad_ihdr: "the engine replied with an undecodable PNG header; re-render once (§5.7)",
  degenerate: "the engine replied with a zero-sized PNG; re-render once (§5.7)",
  too_large: "the render exceeded the 5 MiB PNG budget the engine normally enforces (§2.2)",
};

/**
 * Map a validatePng failure to a ToolErr. Single swap point if the shared
 * catalog (§13.3, add-only) ever gains `invalid_png`/`png_too_large` codes —
 * flagged for the types.ts owner; internal_error never leaks the payload.
 */
function pngCheckErr(reason: PngFailureReason): ToolErr {
  return err("internal_error", "The rendered preview is not a valid PNG payload", {
    hint: PNG_CHECK_HINTS[reason],
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// Pure reply builders
// ---------------------------------------------------------------------------

/** §6.1 summary: compact JSON `{ previewUrl, width, revision? }` — the model's
 * next step, never an engine dump (fleet precedent: JSON rides the string). */
export function buildPreviewSummary(
  previewUrl: string,
  width: number,
  revision: number | undefined,
): string {
  return revision === undefined
    ? JSON.stringify({ previewUrl, width })
    : JSON.stringify({ previewUrl, width, revision });
}

/** The kit's envelope previewUrl accepts http(s):// or root-relative /…; the
 * sink contract already rejects /…, so only http(s) values ride the envelope
 * field. Storage keys stay in the summary (they are not fetchable URLs). */
function envelopePreviewUrl(previewUrl: string): string | undefined {
  return previewUrl.startsWith("http://") || previewUrl.startsWith("https://")
    ? previewUrl
    : undefined;
}

/** Defensively read the render report's revision (ok() requires ≥ 0 integers). */
function readRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Defensive structural probe for the engine's file arm: a write-root path the
 * adapter chose not to read back into bytes (types.ts types the bytes arm). */
function readEnginePath(report: EngineRenderReport): string | undefined {
  const path = (report as { readonly path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

// ---------------------------------------------------------------------------
// Persistence — both engine arms end at the SAME sink (bytes or write path)
// ---------------------------------------------------------------------------

async function callSink(
  call: () => Promise<EngineOutcome<PreviewSinkPut>>,
): Promise<EngineOutcome<string>> {
  let outcome: EngineOutcome<PreviewSinkPut>;
  try {
    outcome = await call();
  } catch {
    return err("storage_error", "The rendered preview could not be stored", {
      hint: "Retry once; if it repeats, the run should stop cleanly with a partial refund (§14.2).",
      retryable: true,
    });
  }
  if (!outcome.ok) {
    return err(outcome.code, outcome.message, {
      hint: outcome.hint,
      retryable: outcome.retryable,
    });
  }
  const { previewUrl, storageKey } = outcome.value;
  if (!isSafePreviewUrlValue(previewUrl)) {
    return err("internal_error", "The preview sink returned an unsafe preview URL", {
      hint: "Sinks return an http(s) URL or a storage key — never filesystem paths (§6.1).",
      retryable: false,
    });
  }
  if (!isSafeStorageKey(storageKey)) {
    return err("internal_error", "The preview sink returned an invalid storage key", {
      hint: "Storage keys are relative object-storage keys (§13.1); this is a wiring bug.",
      retryable: false,
    });
  }
  return { ok: true, value: previewUrl };
}

async function persistPreview(
  previews: PreviewSinkLike,
  report: EngineRenderReport,
  meta: PreviewPutMeta,
): Promise<EngineOutcome<string>> {
  const image = report.image;
  if (image instanceof Uint8Array && image.byteLength > 0) {
    // Inline-bytes arm (typed seam contract): magic + IHDR + §2.2 size cap.
    const check = validatePng(image);
    if (!check.ok) {
      return pngCheckErr(check.reason);
    }
    return callSink(() => previews.put(image, { ...meta, byteLength: image.byteLength }));
  }
  const path = readEnginePath(report);
  if (path !== undefined) {
    // Engine file arm (defensive probe): the PNG lives beneath the write root.
    if (!isEngineWriteRootPath(path)) {
      return err("internal_error", "The engine wrote the preview outside its write root", {
        hint: "Engine renders write beneath the session write root only (§3.2); re-render once.",
        retryable: false,
      });
    }
    const putEnginePath = previews.putEnginePath;
    if (putEnginePath === undefined) {
      return err("internal_error", "The preview sink cannot ingest engine write-root paths", {
        hint: "Wire ctx.previews.putEnginePath, or resolve doc.render replies to bytes in the engine adapter (§3.2).",
        retryable: false,
      });
    }
    return callSink(() => putEnginePath.call(previews, path, meta));
  }
  return err("internal_error", "The render reply carried neither PNG bytes nor a write-root path", {
    hint: "Engine adapters resolve doc.render replies into EngineRenderReport.image bytes (types.ts).",
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// The tool (§6 row 14)
// ---------------------------------------------------------------------------

export const renderPreviewTool: Tool<RenderPreviewArgs> = defineTool({
  name: TOOLS.render_preview,
  description:
    "Render a downscaled PNG preview (256/512/1024 px, default 1024) of the current document and return its preview URL.",
  args: renderPreviewArgsSchema,
  async run(ctx, args, signal) {
    const pctx = requireRenderPreviewContext(ctx);

    // Budgets seam (§5.1 ≤1024 agent cap; defense-in-depth after the schema).
    const clamped = clampRenderWidth(args.width);
    if (!clamped.ok) {
      return clamped;
    }
    const width = clamped.value.width;

    // `doc.render` underneath (§3.4: the executor's signal carries the 30 s
    // render deadline; read-only, so nothing is charged §3.4/§5.2).
    const rendered = await pctx.engine.render({ maxEdgePx: width, signal });
    if (!rendered.ok) {
      return err(rendered.code, rendered.message, {
        hint: rendered.hint,
        retryable: rendered.retryable,
      });
    }
    if (signal.aborted) {
      return err("engine_timeout", "The render finished after the tool deadline", {
        hint: "The run's deadline has passed (§3.4); persisting the preview would be wasted work.",
        retryable: true,
      });
    }

    const report = rendered.value;
    const revision = readRevision(report.revision);
    const warnings: string[] = [];
    if (revision === undefined) {
      warnings.push("the render reply did not carry a document revision");
    }
    const widthPx = report.widthPx;
    if (typeof widthPx === "number" && Number.isFinite(widthPx) && widthPx > width) {
      warnings.push(`rendered preview is ${widthPx} px wide, above the requested ${width} px cap`);
    }

    // Inline bytes or engine write-root path → the SAME sink (§6.1: the URL).
    const persisted = await persistPreview(
      pctx.previews,
      report,
      revision === undefined ? { width } : { width, revision },
    );
    if (!persisted.ok) {
      return persisted;
    }
    const previewUrl = persisted.value;

    const summary = buildPreviewSummary(previewUrl, width, revision);
    if (summary.length > MAX_SUMMARY_CHARS) {
      // ok() would throw invalid_tool_result; fail cleanly instead (§6.1).
      return err("internal_error", "The preview URL is too long to fit the compact reply", {
        hint: "Signed preview URLs stay well under the reply budget (§13.1); check the sink's signer.",
        retryable: false,
      });
    }

    return ok({
      summary,
      documentRevision: revision,
      warnings: warnings.length > 0 ? warnings : undefined,
      previewUrl: envelopePreviewUrl(previewUrl),
    });
  },
});
