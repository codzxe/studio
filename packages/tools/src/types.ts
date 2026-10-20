// @studio/tools — the tool contract: result envelopes and context seams (spec §6, §6.1).
//
// Tools wrap engine commands; they never expose raw command ids to the model (§6).
// Every tool has a strict Zod schema, a 5-second default timeout (enforced by the
// executor, §3.4), and a result that follows the compact-reply rule (§6.1).
//
// The context interfaces below are MINIMAL structural seams on purpose: Wave 2's
// engine-client and Wave 3's repositories conform to them structurally, tools never
// import those packages directly, and this package stays pure and unit-testable.

import { ERROR_CODES, type ErrorCode } from "@studio/config";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error-code catalog (§13.3, add-only; §6.1 actionable errors)
// ---------------------------------------------------------------------------

/**
 * Tool-surface additions to the shared error catalog. Add-only like §13.3:
 * never rename or reuse an existing code.
 */
export const TOOL_ONLY_ERROR_CODES = [
  // Kit / registry boundaries.
  "invalid_args", // Raw arguments failed the tool's schema at the tool boundary.
  "invalid_tool_name", // Registry name malformed or outside the pinned §6 surface.
  "invalid_tool_result", // A tool misused ok()/err() — developer error, thrown not returned.
  "duplicate_tool", // Registry: a tool with this name is already registered.
  "unknown_tool", // Registry: no tool with this name (allowed list attached).
  // §6.1 layer references.
  "ambiguous_layer", // A layer_name matched multiple layers; candidates listed.
  "layer_not_found", // A layer reference (id or name) resolved to nothing.
] as const satisfies readonly string[];

/** The full catalog tools may emit: shared codes (§13.3) plus the tool surface above. */
export const TOOL_ERROR_CODES = [...ERROR_CODES, ...TOOL_ONLY_ERROR_CODES] as const;

export type ToolErrorCode = ErrorCode | (typeof TOOL_ONLY_ERROR_CODES)[number];

export const TOOL_ERROR_CODE_SCHEMA = z.enum(TOOL_ERROR_CODES);

// ---------------------------------------------------------------------------
// Tool result envelopes (§6.1)
// ---------------------------------------------------------------------------

/**
 * Failure envelope — actionable, never leaking tokens, internal paths, absolute
 * filesystem paths, or other tenants' ids (§6.1).
 */
export interface ToolErr {
  readonly ok: false;
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/**
 * Success envelope — the compact-reply rule (§6.1): the summary mirrors what the
 * model needs next, never a raw engine dump.
 */
export interface ToolOk {
  readonly ok: true;
  readonly summary: string;
  readonly documentRevision?: number;
  readonly warnings?: readonly string[];
  readonly previewUrl?: string;
}

export type ToolResult = ToolOk | ToolErr;

// ---------------------------------------------------------------------------
// Engine seam (§6.2 `ctx.engine`, §2.2 command surface; Wave 2 conforms)
// ---------------------------------------------------------------------------

/** One engine command invocation: a §2.2 registry id plus params. The model never sees ids. */
export interface EngineCommand {
  readonly id: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** `ctx.engine.batch` options, as sketched in §6.2: transactional replay + deadline. */
export interface EngineBatchOptions {
  /** All-or-nothing: a failed command rolls the document back to the batch's start revision. */
  readonly transaction?: boolean;
  /** The executor's wall-clock deadline for this tool call (§3.4: 5 s default). */
  readonly signal?: AbortSignal;
}

export interface EngineCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * A failure reported by the engine seam. `code` must come from the shared catalog —
 * Wave 2's engine-client maps vendor/protocol codes into it and logs the unmapped
 * originals server-side (§6.1: actionable, sanitized, never raw vendor strings).
 */
export interface EngineFailure {
  readonly ok: false;
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** Result union for every engine-seam call: expected failures are values, not throws. */
export type EngineOutcome<T> = { readonly ok: true; readonly value: T } | EngineFailure;

export interface EngineCommandOutcome {
  /** Position of the command inside the batch (missing for single execute). */
  readonly index?: number;
  readonly commandId: string;
  readonly ok: boolean;
  readonly message?: string;
}

export interface EngineBatchReport {
  /** Document revision after the batch; feeds `document_revision` in the tool result. */
  readonly revision: number;
  readonly outcomes: readonly EngineCommandOutcome[];
}

export interface EngineCommandReport {
  readonly revision: number;
  readonly message?: string;
}

export interface EngineBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Compact layer-tree node, purpose-built for small replies (§6 row 1, layer.list). */
export interface EngineLayerSummary {
  readonly layerId: string;
  readonly name: string;
  readonly kind: string;
  readonly visible: boolean;
  readonly locked?: boolean;
  readonly bounds?: EngineBounds;
  readonly childCount?: number;
}

export interface EngineDocumentSnapshot {
  readonly revision: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly layers: readonly EngineLayerSummary[];
  readonly palette?: readonly string[];
  readonly fonts?: readonly string[];
}

export interface EngineRenderOptions {
  /** Longest-edge cap: previews ≤ 1024 px (§6 row 14) inside the 2048 px budget (§2.2). */
  readonly maxEdgePx?: number;
  readonly layerCompId?: string;
  readonly signal?: AbortSignal;
}

export interface EngineRenderReport {
  /** Raw PNG bytes; the caller persists it and hands the model only the preview_url. */
  readonly image: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly revision?: number;
}

/**
 * The "compiler" half of the §6.3 analogy. Expected failures come back as
 * `EngineFailure` values; only transport surprises may throw, and the defineTool
 * boundary converts those to `internal_error` tool results.
 */
export interface EngineLike {
  batch(
    cmds: readonly EngineCommand[],
    options?: EngineBatchOptions,
  ): Promise<EngineOutcome<EngineBatchReport>>;
  execute(
    cmd: EngineCommand,
    options?: EngineCallOptions,
  ): Promise<EngineOutcome<EngineCommandReport>>;
  render(options: EngineRenderOptions): Promise<EngineOutcome<EngineRenderReport>>;
  /** `document.inspect` — the agent's "read the file", cached per revision (§6.3). */
  inspect(): Promise<EngineOutcome<EngineDocumentSnapshot>>;
  /** `layer.list` — compact tree, the agent's `ls` (§6.3). */
  listLayers(): Promise<EngineOutcome<readonly EngineLayerSummary[]>>;
}

// ---------------------------------------------------------------------------
// Persistence seam (Wave 3 repositories conform structurally)
// ---------------------------------------------------------------------------

export interface DbDocumentRef {
  readonly documentId: string;
  readonly organizationId: string;
  readonly currentRevision: number;
}

/** One command-log WAL entry (§5.6 crash-recovery replay, forward-only). */
export interface DbCommandLogEntry {
  readonly documentId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Minimal persistence seam. Tools rarely touch this directly — the agent runtime
 * journals command batches for replay (§5.6) and reads are tenant-scoped by the
 * repositories that implement it (§15.1).
 */
export interface DbLike {
  getDocument(documentId: string): Promise<DbDocumentRef | undefined>;
  appendCommandLog(entry: DbCommandLogEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Template catalog seam (§7, §6.2 `ctx.templates.get`)
// ---------------------------------------------------------------------------

export type TemplateSlotKind = "text" | "image" | "color" | "visibility";

export interface TemplateSlotSpec {
  readonly kind: TemplateSlotKind;
  readonly label?: string;
  readonly required?: boolean;
  /** Per-slot rules from the manifest (§7.2): box size, max chars, allowed assets… */
  readonly constraints?: Readonly<Record<string, unknown>>;
}

export interface TemplateManifest {
  readonly id: string;
  readonly version: string;
  readonly slots: Readonly<Record<string, TemplateSlotSpec>>;
  /** Slot name → layer id/name inside the applied document (§6.2 layer map). */
  readonly layerMap?: Readonly<Record<string, string>>;
}

export interface TemplateSummary {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly slotCount: number;
}

export interface TemplateCatalogLike {
  /** Cached manifest lookup by `id@version` (§6.2). */
  get(templateRef: string): Promise<TemplateManifest | undefined>;
  /** Paged/tagged listing for `template_list` (§6 row 2). */
  list(options?: { readonly tag?: string; readonly limit?: number }): Promise<
    readonly TemplateSummary[]
  >;
}

// ---------------------------------------------------------------------------
// Asset store seam (§6 row 6, §20 uploads)
// ---------------------------------------------------------------------------

export interface AssetRecord {
  readonly assetId: string;
  readonly organizationId: string;
  readonly filename: string;
  /** §20: uploads are png/jpeg only. */
  readonly mimeType: "image/png" | "image/jpeg";
  readonly widthPx?: number;
  readonly heightPx?: number;
  /** Engine-visible location inside the workspace's capability root (§3.2, §15.1). */
  readonly storageUrl: string;
}

export interface AssetStoreLike {
  /** Search THIS workspace's asset library only (§15.1 tenancy, §25 rule 4). */
  search(query: string, options?: { readonly limit?: number }): Promise<readonly AssetRecord[]>;
  get(assetId: string): Promise<AssetRecord | undefined>;
}

// ---------------------------------------------------------------------------
// Budget seam (§5.2 tier budgets, §2.2 engine limits)
// ---------------------------------------------------------------------------

export interface BudgetState {
  /** Wall-clock budget left on this tool call / run slice. */
  readonly msRemaining: number;
  /** Headroom before the per-run mutating-command cap. */
  readonly commandsRemaining: number;
}

/**
 * Live budget meter for the run. Tools charge what they spend and must stop
 * cleanly when a boundary is crossed (§5.2: clean stop, partial charge).
 */
export interface BudgetTracker {
  remaining(): BudgetState;
  /** Returns false once a budget boundary is crossed; the caller must stop. */
  charge(usage: { readonly commands?: number; readonly renderPx?: number }): boolean;
}

// ---------------------------------------------------------------------------
// Workspace + logger seams
// ---------------------------------------------------------------------------

/** Brand kit tokens for the workspace; colours use the §6.1 formats. */
export interface BrandTokens {
  readonly palette: Readonly<Record<string, string>>;
  readonly fonts: readonly string[];
}

export interface WorkspaceContext {
  readonly organizationId: string;
  readonly brandTokens: BrandTokens;
}

/** Minimal structured logger; never log tokens or absolute paths (§6.1, §22). */
export interface ToolLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Everything a tool run may touch. Assembled by the agent runtime, frozen per call. */
export interface ToolContext {
  readonly engine: EngineLike;
  readonly db: DbLike;
  readonly templates: TemplateCatalogLike;
  readonly assets: AssetStoreLike;
  readonly budgets: BudgetTracker;
  readonly workspace: WorkspaceContext;
  readonly logger: ToolLogger;
  now(): Date;
}

// ---------------------------------------------------------------------------
// Tool shape (§6.2)
// ---------------------------------------------------------------------------

/**
 * A semantic tool. `run` is declared as a method so concrete `Tool<TArgs>` are
 * assignable to `Tool<unknown>` for heterogeneous registry storage.
 */
export interface Tool<TArgs> {
  /** snake_case, matching the §6 surface (e.g. `template_fill`). */
  readonly name: string;
  /** One useful sentence for the planner; feeds prompts verbatim (§6). */
  readonly description: string;
  /**
   * Strict argument schema (§6.1: additionalProperties: false, length caps).
   * `Input` is `unknown` because schemas may use `.default()` (§6.2 `fit`), which
   * makes the parsed input type differ from `TArgs`.
   */
  readonly args: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  run(ctx: ToolContext, args: TArgs, signal: AbortSignal): Promise<ToolResult>;
}

/** Type-erased tool for homogeneous collections (registries, maps, fakes). */
export type AnyTool = Tool<unknown>;
