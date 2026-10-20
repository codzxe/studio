// @studio/tools — defineTool and the §6.1 contract-enforcement kit.
//
// Every tool is built with `defineTool` and constructs results with `ok`/`err`.
// The kit enforces the §6.1 rules mechanically so Wave 5 tool authors cannot
// accidentally ship a loose schema or a bloated reply:
//   - strict schemas: additionalProperties:false, string/array/record caps
//   - colour values: #RGB / #RRGGBB / rgb() / hsl()
//   - layer refs: layer_id OR layer_name, never both; ambiguity lists candidates
//   - small replies: summaries and warnings are capped; no engine dumps

import { z } from "zod";
import {
  TOOL_ERROR_CODE_SCHEMA,
  type AnyTool,
  type Tool,
  type ToolContext,
  type ToolErr,
  type ToolErrorCode,
  type ToolOk,
  type ToolResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Contract limits (exported for tests and Wave 5 reference)
// ---------------------------------------------------------------------------

export const MAX_TOOL_NAME_CHARS = 64;
export const MAX_TOOL_DESCRIPTION_CHARS = 500;
/** §6.2 caps text slot values at 2000 chars; every string argument stays at or below this. */
export const MAX_ARG_STRING_CHARS = 2000;
export const MAX_ARG_ARRAY_ITEMS = 200;
/** §6.2: "too many slots" at > 40 entries. */
export const MAX_ARG_RECORD_ENTRIES = 40;
/** Small-reply rule: summaries are the model's next step, never an engine dump (§6.1). */
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_WARNINGS = 20;
export const MAX_WARNING_CHARS = 500;
export const MAX_ERROR_MESSAGE_CHARS = 1000;
export const MAX_HINT_CHARS = 500;
export const MAX_PREVIEW_URL_CHARS = 2048;

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/** Is this a legal tool name? (snake_case, 2–64 chars, mirrors the §6 surface.) */
export function isToolName(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAME_RE.test(value);
}

// ---------------------------------------------------------------------------
// Typed throws (never strings; converted to ToolErr at the defineTool boundary)
// ---------------------------------------------------------------------------

export interface ToolErrorOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

/**
 * The single error type tools should throw for typed failures; `defineTool`'s
 * boundary converts it to a `ToolErr` envelope. Misusing `ok`/`err` also throws
 * this with code `invalid_tool_result` — a developer bug, not a model error.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean | undefined;

  constructor(code: ToolErrorCode, message: string, options?: ToolErrorOptions) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.hint = options?.hint;
    this.retryable = options?.retryable;
  }
}

// ---------------------------------------------------------------------------
// Result constructors (§6.1 envelopes)
// ---------------------------------------------------------------------------

export interface ToolOkInput {
  readonly summary: string;
  readonly documentRevision?: number;
  readonly warnings?: readonly string[];
  readonly previewUrl?: string;
}

export interface ToolErrOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

/**
 * Builds the §6.1 success envelope. Enforces the compact-reply rule: summary
 * 1–2000 chars, ≤ 20 warnings of ≤ 500 chars, previewUrl http(s) or root-relative
 * (never file paths). Violations throw `ToolError` — that is a tool bug.
 */
export function ok(input: ToolOkInput): ToolOk {
  const { summary } = input;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new ToolError("invalid_tool_result", "ok(): summary must be a non-empty string", {
      hint: "Summarize what changed and what the model should do next (§6.1).",
    });
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new ToolError(
      "invalid_tool_result",
      `ok(): summary exceeds ${MAX_SUMMARY_CHARS} chars (${summary.length})`,
      { hint: "Return the next step, not the engine dump — the small-reply rule (§6.1)." },
    );
  }
  const result: {
    ok: true;
    summary: string;
    documentRevision?: number;
    warnings?: readonly string[];
    previewUrl?: string;
  } = { ok: true, summary };
  if (input.documentRevision !== undefined) {
    if (!Number.isInteger(input.documentRevision) || input.documentRevision < 0) {
      throw new ToolError("invalid_tool_result", "ok(): documentRevision must be a non-negative integer");
    }
    result.documentRevision = input.documentRevision;
  }
  if (input.warnings !== undefined) {
    if (!Array.isArray(input.warnings) || input.warnings.length > MAX_WARNINGS) {
      throw new ToolError(
        "invalid_tool_result",
        `ok(): at most ${MAX_WARNINGS} warnings; use the registry error path for failures`,
      );
    }
    for (const warning of input.warnings) {
      if (typeof warning !== "string" || warning.length === 0 || warning.length > MAX_WARNING_CHARS) {
        throw new ToolError(
          "invalid_tool_result",
          `ok(): each warning is a non-empty string of ≤ ${MAX_WARNING_CHARS} chars`,
        );
      }
    }
    result.warnings = [...input.warnings];
  }
  if (input.previewUrl !== undefined) {
    if (typeof input.previewUrl !== "string" || !isSafePreviewUrl(input.previewUrl)) {
      throw new ToolError("invalid_tool_result", "ok(): previewUrl must be http(s)://… or root-relative /…", {
        hint: "Never emit filesystem paths, other tenants' URLs, or non-http schemes (§6.1).",
      });
    }
    result.previewUrl = input.previewUrl;
  }
  return result;
}

/** Builds the §6.1 failure envelope: `{ code, message, hint?, retryable? }`. */
export function err(code: ToolErrorCode, message: string, options: ToolErrOptions = {}): ToolErr {
  if (TOOL_ERROR_CODE_SCHEMA.safeParse(code).success !== true) {
    throw new ToolError("invalid_tool_result", `err(): unknown error code ${String(code)}`, {
      hint: "Codes come from the shared catalog (§13.3) plus the tool surface in types.ts.",
    });
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new ToolError("invalid_tool_result", "err(): message must be a non-empty string");
  }
  if (message.length > MAX_ERROR_MESSAGE_CHARS) {
    throw new ToolError("invalid_tool_result", `err(): message exceeds ${MAX_ERROR_MESSAGE_CHARS} chars`);
  }
  const envelope: {
    ok: false;
    code: ToolErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    if (typeof options.hint !== "string" || options.hint.length === 0 || options.hint.length > MAX_HINT_CHARS) {
      throw new ToolError("invalid_tool_result", `err(): hint is a non-empty string of ≤ ${MAX_HINT_CHARS} chars`, {
        hint: "Actionable hints fix the argument, e.g. shorten to 40 chars or reduce size to 72pt (§6.1).",
      });
    }
    envelope.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    envelope.retryable = options.retryable;
  }
  return envelope;
}

/** http(s) URL or root-relative asset path; never file paths or traversal (§6.1). */
function isSafePreviewUrl(url: string): boolean {
  if (url.length > MAX_PREVIEW_URL_CHARS || url.includes("\\") || url.includes("..")) {
    return false;
  }
  return url.startsWith("/") || url.startsWith("https://") || url.startsWith("http://");
}

// ---------------------------------------------------------------------------
// Runtime result schema — the wire shape of every tool result (§6.1)
// ---------------------------------------------------------------------------

const TOOL_OK_SCHEMA = z.strictObject({
  ok: z.literal(true),
  summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
  documentRevision: z.number().int().min(0).optional(),
  warnings: z.array(z.string().min(1).max(MAX_WARNING_CHARS)).max(MAX_WARNINGS).optional(),
  previewUrl: z.string().max(MAX_PREVIEW_URL_CHARS).refine(isSafePreviewUrl).optional(),
});

const TOOL_ERR_SCHEMA = z.strictObject({
  ok: z.literal(false),
  code: TOOL_ERROR_CODE_SCHEMA,
  message: z.string().min(1).max(MAX_ERROR_MESSAGE_CHARS),
  hint: z.string().min(1).max(MAX_HINT_CHARS).optional(),
  retryable: z.boolean().optional(),
});

export const TOOL_RESULT_SCHEMA = z.union([TOOL_OK_SCHEMA, TOOL_ERR_SCHEMA]);

/** Type guard for values crossing into executor/storage boundaries. */
export function isToolResult(value: unknown): value is ToolResult {
  return TOOL_RESULT_SCHEMA.safeParse(value).success;
}

// ---------------------------------------------------------------------------
defineTool: compile-time generics + a runtime safety boundary
// ---------------------------------------------------------------------------

/** What `defineTool` accepts; `TArgs` is inferred from the schema's output type. */
export interface ToolDefinition<TArgs> {
  readonly name: string;
  readonly description: string;
  readonly args: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  readonly run: (ctx: ToolContext, args: TArgs, signal: AbortSignal) => Promise<ToolResult>;
}

function assertCap(max: number, ceiling: number, what: string): void {
  if (!Number.isInteger(max) || max < 1 || max > ceiling) {
    throw new ToolError("internal_error", `${what} cap must be an integer between 1 and ${ceiling}`, {
      hint: "§6.1: every string/array/record argument is capped — pick a limit.",
    });
  }
}

/** Registry-facing name check with a typed throw (used by tests and READMEs). */
export function assertValidToolName(name: string): void {
  if (!isToolName(name)) {
    throw new ToolError(
      "invalid_tool_name",
      `tool name must be snake_case (a–z, 0–9, _), got "${truncate(String(name), 64)}"`,
      { hint: "Names mirror the §6 surface, e.g. template_fill." },
    );
  }
}

function assertValidDescription(description: string): void {
  if (
    typeof description !== "string" ||
    description.trim().length < 10 ||
    description.length > MAX_TOOL_DESCRIPTION_CHARS
  ) {
    throw new ToolError("internal_error", "tool description must be 10–500 chars", {
      hint: "Descriptions feed planner prompts verbatim (§6): one useful sentence.",
    });
  }
}

/**
 * Converts anything thrown inside `run` into a safe ToolErr. ToolError passes
 * through with its code; AbortError means the §3.4 deadline hit; everything else
 * is a bug and never leaks its message, stack, or paths (§6.1).
 */
export function toToolErr(error: unknown): ToolErr {
  if (error instanceof ToolError) {
    return err(error.code, truncate(error.message, MAX_ERROR_MESSAGE_CHARS), {
      hint: error.hint === undefined ? undefined : truncate(error.hint, MAX_HINT_CHARS),
      retryable: error.retryable,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return err("engine_timeout", "The tool call ran out of time", {
      hint: "Check the document for partial effects with workspace_snapshot, then retry smaller.",
      retryable: true,
    });
  }
  return err("internal_error", "The tool failed unexpectedly", {
    hint: "Retry once; if it repeats, the run should stop cleanly with a partial refund (§14.2).",
    retryable: false,
  });
}

/**
 * Defines a semantic tool (§6.2). Compile-time: `run`'s args are typed by the
 * schema. Runtime: the definition itself is validated and `run` is wrapped in a
 * boundary that (1) rejects pre-aborted signals, (2) converts thrown values via
 * `toToolErr`, and (3) schema-checks the returned envelope so no engine dump or
 * malformed result ever reaches the model.
 */
export function defineTool<TArgs>(definition: ToolDefinition<TArgs>): Tool<TArgs> {
  if (definition == null || typeof definition !== "object") {
    throw new ToolError("internal_error", "defineTool: definition must be a ToolDefinition object");
  }
  assertValidToolName(definition.name);
  assertValidDescription(definition.description);
  if (definition.args == null || !(definition.args instanceof z.ZodType)) {
    throw new ToolError("internal_error", `defineTool("${definition.name}"): args must be a Zod schema`, {
      hint: "Build it with strictObject + the kit's capped helpers (§6.1).",
    });
  }
  if (typeof definition.run !== "function") {
    throw new ToolError("internal_error", `defineTool("${definition.name}"): run must be a function`);
  }
  const inner = definition.run;
  const wrapped = async (
    ctx: ToolContext,
    args: TArgs,
    signal: AbortSignal,
  ): Promise<ToolResult> => {
    if (signal.aborted) {
      return err("engine_timeout", "The tool call was cancelled before it started", {
        hint: "The run's deadline has already passed (§3.4).",
        retryable: false,
      });
    }
    try {
      const result = await inner(ctx, args, signal);
      if (!isToolResult(result)) {
        return err("internal_error", "The tool returned a malformed result", {
          hint: "This is a tool bug, not a model error; construct results with ok()/err().",
          retryable: false,
        });
      }
      return result;
    } catch (error) {
      return toToolErr(error);
    }
  };
  return {
    name: definition.name,
    description: definition.description,
    args: definition.args,
    run: wrapped,
  };
}

// ---------------------------------------------------------------------------
// Argument-boundary parsing (executor entry point)
// ---------------------------------------------------------------------------

export type ParsedToolArgs<TArgs> = { readonly ok: true; readonly args: TArgs } | ToolErr;

/**
 * Parses raw model output against a tool's schema at the boundary. Failures are
 * `invalid_args` ToolErr values with the issue paths in the hint — never a throw,
 * never echoing argument values (§6.1, §13.3).
 */
export function parseToolArgs<TArgs>(tool: Tool<TArgs>, raw: unknown): ParsedToolArgs<TArgs> {
  const parsed = tool.args.safeParse(raw);
  if (parsed.success) {
    return { ok: true, args: parsed.data };
  }
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  return err("invalid_args", "Arguments failed schema validation", {
    hint: truncate(issues, MAX_HINT_CHARS),
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// §6.1 argument-schema helpers
// ---------------------------------------------------------------------------

/** `z.strictObject` — additionalProperties:false, the §6.1 default for every arg schema. */
export const strictObject = z.strictObject;

/** A capped string argument (§6.1); max ≤ 2000 so text stays model-scale. */
export function cappedString(max: number, min = 0): z.ZodString {
  assertCap(max, MAX_ARG_STRING_CHARS, "cappedString");
  return z.string().min(min).max(max);
}

/** A capped array argument (§6.1). */
export function cappedArray<T extends z.ZodTypeAny>(max: number, element: T): z.ZodArray<T> {
  assertCap(max, MAX_ARG_ARRAY_ITEMS, "cappedArray");
  return z.array(element).max(max);
}

/** A record argument with an entry cap, e.g. ≤ 40 template slots (§6.2). */
export function cappedRecord<V extends z.ZodTypeAny>(
  max: number,
  valueSchema: V,
): z.ZodType<Record<string, z.output<V>>, z.ZodTypeDef, Record<string, z.input<V>>> {
  assertCap(max, MAX_ARG_RECORD_ENTRIES, "cappedRecord");
  return z
    .record(z.string(), valueSchema)
    .refine((entries) => Object.keys(entries).length <= max, {
      message: `too many entries (max ${max})`,
    });
}

// Colour values (§6.1): #RGB, #RRGGBB, rgb(), rgba(), hsl(), hsla().

const HEX_SHORT_RE = /^#[0-9a-f]{3}$/i;
const HEX_LONG_RE = /^#[0-9a-f]{6}$/i;
const RGB_RE =
  /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*(?:,\s*(?:1|0|0?\.[0-9]+)\s*)?\)$/i;
const HSL_RE =
  /^hsla?\(\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*(?:deg)?\s*,\s*([0-9]{1,3})%\s*,\s*([0-9]{1,3})%\s*(?:,\s*(?:1|0|0?\.[0-9]+)\s*)?\)$/i;

function channel(value: string | undefined, max: number): boolean {
  if (value === undefined) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max;
}

/** Is this a §6.1 colour value? (Channels range-checked, no css-var indirection.) */
export function isValidColor(value: string): boolean {
  if (HEX_SHORT_RE.test(value) || HEX_LONG_RE.test(value)) {
    return true;
  }
  const rgb = RGB_RE.exec(value);
  if (rgb) {
    return channel(rgb[1], 255) && channel(rgb[2], 255) && channel(rgb[3], 255);
  }
  const hsl = HSL_RE.exec(value);
  if (hsl) {
    return channel(hsl[1], 360) && channel(hsl[2], 100) && channel(hsl[3], 100);
  }
  return false;
}

export const zColor: z.ZodType<string, z.ZodTypeDef, string> = z
  .string()
  .max(32)
  .refine(isValidColor, { message: "colour must be #RGB, #RRGGBB, rgb(...) or hsl(...)" });

// Layer references (§6.1): layer_id OR layer_name, never both; the engine resolves
// names and ambiguity is the caller's error with candidates listed.

export const zLayerRef = z.union([
  strictObject({ layerId: cappedString(200, 1) }),
  strictObject({ layerName: cappedString(200, 1) }),
]);

export type LayerRef = z.infer<typeof zLayerRef>;

/** §6.1: a layer_name matched several layers — make the model address one by id. */
export function ambiguousLayerErr(layerName: string, candidates: readonly string[]): ToolErr {
  const shown = candidates.slice(0, 10).join(", ");
  const extra = candidates.length > 10 ? ` (+${candidates.length - 10} more)` : "";
  return err("ambiguous_layer", `Layer name "${truncate(layerName, 200)}" matches ${candidates.length} layers`, {
    hint: `Address one by layer_id instead. Candidates: ${shown}${extra}`,
    retryable: false,
  });
}

/** §6.1: the reference resolved to nothing. */
export function layerNotFoundErr(layerIdOrName: string): ToolErr {
  return err("layer_not_found", "No layer matched this reference", {
    hint: `Check the layer tree with workspace_snapshot; got "${truncate(layerIdOrName, 80)}"`,
    retryable: false,
  });
}

// Small shared argument atoms.

export const zTemplateRef: z.ZodType<string, z.ZodTypeDef, string> = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9.\-]*$/i, {
    message: 'must be template@version, e.g. "menu-a4@1.0.0" (§7)',
  });

/** Opaque idempotency key for mutating tools (§14.2: money paths need them everywhere). */
export const zIdempotencyKey: z.ZodType<string, z.ZodTypeDef, string> = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, { message: "idempotency keys are opaque url-safe tokens" });

// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
