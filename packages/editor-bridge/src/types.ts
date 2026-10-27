/**
 * Types + runtime (Zod) schemas for the editor bridge (PRODUCT_ARCHITECTURE §6.2).
 *
 * The upstream JS surface (`window.studioEngine`, defined inline in
 * `editor/apps/studio-web/web/index.html` and backed by
 * `editor/apps/studio-web/src/api.rs`) is unknown-shaped from TypeScript's
 * point of view. At the boundary we therefore:
 *
 * - type the raw editor global as `StudioEngineGlobal` with `unknown` results,
 * - validate every result we hand to product code with the Zod schemas below,
 * - expose narrow inferred types for the fields we actually rely on, and
 * - leave everything else as passthrough (`z.looseObject`) / `unknown`.
 *
 * Result shapes are documented from the verified upstream sources:
 * - `ui.inspect` — `editor/crates/ui-egui/src/control.rs` `inspect()`
 * - `engine.commands` / `command.list` — `editor/crates/ui-egui/src/control.rs`,
 *   `editor/crates/engine/src/commands/query.rs` `list()`
 * - `command.describe` — `query.rs` `describe()`
 * - `project.summary`, `comp.info`, `layer.tree`, `prop.get` — `query.rs`
 * - `render.frame` — `control.rs` `render_frame()`
 * - `ui.screenshot` — `control.rs` `save_screenshot()`
 * - `engine.batch` — `editor/crates/engine/src/commands/batch.rs`
 */

import { z } from "zod";
import type { AgentBatchInput } from "./batch";

// ---------------------------------------------------------------------------
// Raw upstream surface (do not grow beyond what the sources verify)
// ---------------------------------------------------------------------------

/** `window.studioEngineLoad` — set to `{}` immediately, `{wasmMs, readyMs}` once running, `{error}` on failure (`web/index.html`). */
export interface StudioEngineLoad {
  readonly wasmMs?: number;
  readonly readyMs?: number;
  readonly error?: string;
}

/** `window.studioEngine` — verified method-for-method from `editor/apps/studio-web/web/index.html` (v0.13.0). */
export interface StudioEngineGlobal {
  /** Any control method: `ui.inspect`, `ui.click`, `ui.key`, `ui.menu.invoke`, `render.frame`… Resolves with the method's `result`, rejects with its `error` message. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** `engine.execute` — an engine command (same ids/params as MCP / studio-cli). */
  execute(command: string, params?: unknown): Promise<unknown>;
  /** `engine.commands` — the command registry. */
  commands(): Promise<unknown>;
  /** `ui.inspect`. */
  inspect(): Promise<unknown>;
  /** `ui.screenshot` — inline PNG (`png`) on the web when no `path` is given. */
  screenshot(params?: unknown): Promise<unknown>;
  /** `render.frame` with `base64: true` — `{comp, time, width, height, png}`. */
  renderFrame(params?: unknown): Promise<unknown>;
  /** The file table: `[{path, size}]` (synchronous). */
  files(): unknown;
  /** A file's bytes (`Uint8Array`), or `undefined` when absent (synchronous). */
  readFile(path: string): Uint8Array | undefined;
  /** Put a `File`/`Blob` (or fetched URL) into the file table; resolves with its path. */
  addFile(fileOrUrl: Blob | File | string, name?: string): Promise<string>;
  /** Backend/build facts, incl. `version`, `load` (synchronous). */
  info(): unknown;
  /** Save the project to browser storage; resolves with `{path, bytes}` (byte count). */
  saveToBrowser(path?: string): Promise<unknown>;
  /** Browser storage contents. */
  listStored(): Promise<unknown>;
  /** Delete a stored file (synchronous; resolves whether it existed). */
  removeStored(path: string): boolean;
  /** Resolves once every change is written to browser storage. */
  flush(): Promise<void>;
  /** Frame-worker vs CPU render comparison. */
  workerFrameCheck(params?: unknown): Promise<unknown>;
}

/** `Window` refined with the (optional) upstream globals; the bridge never assumes they are present. */
export interface StudioEngineWindow extends Window {
  effectcraft?: StudioEngineGlobal;
  studioEngineLoad?: StudioEngineLoad;
  effectcraftModule?: unknown;
}

// ---------------------------------------------------------------------------
// UiInspect — `ui.inspect` (§6.5: active comp, selection, playback, time, focused panel, window size)
// ---------------------------------------------------------------------------

function focusedPanelOf(ui: unknown): string | undefined {
  if (typeof ui === "object" && ui !== null && "focused" in ui) {
    const focused = (ui as { focused?: unknown }).focused;
    if (typeof focused === "string" && focused.length > 0) return focused;
  }
  return undefined;
}

export const UiInspectSchema = z
  .looseObject({
    window: z.tuple([z.number(), z.number()]),
    pixelsPerPoint: z.number().nullish(),
    fps: z.number().nullish(),
    ui: z.unknown().nullish(),
    playing: z.boolean().nullish(),
    time: z.number().nullish(),
    activeComp: z.number().nullable().nullish(),
    selectedLayers: z.array(z.number()).nullish(),
    selectedKeys: z.number().nullish(),
    keyboardFocus: z.unknown().nullish(),
    windowFocused: z.boolean().nullish(),
    dialog: z.string().nullable().nullish(),
    renderMs: z.number().nullish(),
  })
  .transform((v) => ({
    ...v,
    window: v.window as [number, number],
    playing: v.playing ?? false,
    time: v.time ?? 0,
    selectedLayers: v.selectedLayers ?? [],
    focusedPanel: focusedPanelOf(v.ui),
  }));

export type UiInspect = z.infer<typeof UiInspectSchema>;

// ---------------------------------------------------------------------------
// ProjectSummary — `project.summary` (query.rs `summary()`)
// ---------------------------------------------------------------------------

export const ProjectItemSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  label: z.string().nullish(),
  parent: z.number().nullable().nullish(),
  size: z.tuple([z.number(), z.number()]).nullish(),
  duration: z.number().nullish(),
  layers: z.number().nullish(),
  frameRate: z.number().nullish(),
  problem: z.string().nullish(),
});

export type ProjectItemSummary = z.infer<typeof ProjectItemSummarySchema>;

export const ProjectSummarySchema = z.object({
  path: z.string().nullable().nullish(),
  dirty: z.boolean().nullish(),
  bitDepth: z.string().nullish(),
  renderer: z.unknown().nullish(),
  items: z
    .array(ProjectItemSummarySchema)
    .nullish()
    .transform((v) => v ?? []),
  activeComp: z.number().nullable().nullish(),
  time: z.number().nullish(),
  selectedLayers: z
    .array(z.number())
    .nullish()
    .transform((v) => v ?? []),
  undo: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

// ---------------------------------------------------------------------------
// LayerNode / PropNode — `layer.tree` (query.rs `layer_tree()` + `group_json()`)
// ---------------------------------------------------------------------------

export type PropValue = number | string | boolean | null | unknown[] | Record<string, unknown>;

export interface PropKeyframeInfo {
  time: number;
  value: unknown;
  in?: string | null;
  out?: string | null;
}

export interface PropNode {
  path: string;
  name: string;
  uid?: number | null;
  match?: string | null;
  type?: string | null;
  value?: PropValue;
  enabled?: boolean | null;
  keys?: PropKeyframeInfo[] | null;
  expression?: string | null;
  children?: PropNode[] | null;
  truncated?: boolean | null;
  effect?: unknown;
  mask?: unknown;
}

export interface LayerNode {
  id: number;
  name: string;
  index?: number | null;
  type?: string | null;
  label?: string | null;
  time?: number | null;
  properties?: PropNode;
  [key: string]: unknown;
}

export const PropKeyframeInfoSchema = z.object({
  time: z.number(),
  value: z.unknown(),
  in: z.string().nullish(),
  out: z.string().nullish(),
});

export const PropValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const PropNodeSchema: z.ZodType<PropNode> = z.lazy(() =>
  z.looseObject({
    path: z.string(),
    name: z.string(),
    uid: z.number().nullish(),
    match: z.string().nullish(),
    type: z.string().nullish(),
    value: PropValueSchema.optional(),
    enabled: z.boolean().nullish(),
    keys: z.array(PropKeyframeInfoSchema).nullish(),
    expression: z.string().nullish(),
    children: z.array(PropNodeSchema).nullish(),
    truncated: z.boolean().nullish(),
    effect: z.unknown().nullish(),
    mask: z.unknown().nullish(),
  }),
);

export const LayerNodeSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  index: z.number().nullish(),
  type: z.string().nullish(),
  label: z.string().nullish(),
  time: z.number().nullish(),
  properties: PropNodeSchema.nullish(),
});

// ---------------------------------------------------------------------------
// Commands — `engine.commands` (`command.list`) and `command.describe`
// ---------------------------------------------------------------------------

/** One engine command as listed by `engine.commands` / `command.list {filter?, enabledOnly?}`. */
export const CommandInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  menu: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  shortcut: z.string().nullable().nullish(),
  params: z.string().nullish(),
  enabled: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true),
  why: z.string().nullable().nullish(),
});

export type CommandInfo = z.infer<typeof CommandInfoSchema>;

/** `command.describe {command}` — params doc + JSON Schema, undoability, enablement. */
export const CommandSchemaSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    menu: z
      .array(z.string())
      .nullish()
      .transform((v) => v ?? []),
    shortcut: z.string().nullable().nullish(),
    params: z.string().nullish(),
    schema: z.record(z.string(), z.unknown()).nullish(),
    undoable: z.boolean().nullish(),
    enabled: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
    why: z.string().nullable().nullish(),
  })
  .transform((v) => ({ command: v.id, ...v }));

export type CommandSchema = z.infer<typeof CommandSchemaSchema>;

// ---------------------------------------------------------------------------
// Batch — `engine.batch` result (batch.rs: `{"steps": n, "results": [...]}`)
// ---------------------------------------------------------------------------

export const BatchResultSchema = z.object({
  steps: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),
  results: z
    .array(z.unknown())
    .nullish()
    .transform((v) => v ?? []),
});

export type BatchResult = z.infer<typeof BatchResultSchema>;

// ---------------------------------------------------------------------------
// render.frame / ui.screenshot
// ---------------------------------------------------------------------------

export interface RenderFrameParams {
  /** Comp id or name (default: the active comp). */
  comp?: number | string;
  /** Comp seconds (default: the CTI). */
  time?: number;
  /** Cap the longest side (0 = full size). */
  max_side?: number;
  /** Write the PNG to `path` instead of returning it inline. */
  path?: string;
  /** Render without the comp background. */
  transparent?: boolean;
}

export const RenderFrameResultSchema = z
  .object({
    comp: z.union([z.number(), z.string()]),
    time: z.number(),
    width: z.number(),
    height: z.number(),
    /** Upstream key for the inline base64 PNG (`renderFrame` sets `base64: true`). */
    png: z.string().nullish(),
    /** Our normalized name; kept when already present. */
    pngBase64: z.string().nullish(),
  })
  .transform((v) => ({ ...v, pngBase64: v.pngBase64 ?? v.png ?? undefined }));

export type RenderFrameResult = z.infer<typeof RenderFrameResultSchema>;

export interface ScreenshotParams {
  /** Write the PNG to `path` instead of returning it inline (web default: inline). */
  path?: string;
  /** Crop to a panel, e.g. `Timeline`. */
  panel?: string;
  /** Crop to an element id, e.g. `panel.Timeline`. */
  id?: string;
}

export const ScreenshotResultSchema = z
  .looseObject({
    path: z.string().nullish(),
    width: z.number().nullish(),
    height: z.number().nullish(),
    png: z.string().nullish(),
    pngBase64: z.string().nullish(),
  })
  .transform((v) => ({ ...v, pngBase64: v.pngBase64 ?? v.png ?? undefined }));

export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

// ---------------------------------------------------------------------------
// EditorInfo — `effectcraft.info()` (sync upstream) + `app.capabilities`
// ---------------------------------------------------------------------------

export const StudioEngineLoadInfoSchema = z.looseObject({
  wasmMs: z.number().nullish(),
  readyMs: z.number().nullish(),
  error: z.string().nullish(),
});

export type StudioEngineLoadInfo = z.infer<typeof StudioEngineLoadInfoSchema>;

export const EditorInfoSchema = z.looseObject({
  version: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  load: StudioEngineLoadInfoSchema.nullish(),
});

export type EditorInfo = z.infer<typeof EditorInfoSchema>;

export const AppCapabilitiesSchema = z.looseObject({
  version: z.string().nullish(),
  commands: z.number().nullish(),
  effects: z.unknown().nullish(),
  export: z.array(z.unknown()).nullish(),
  import: z.boolean().nullish(),
  expressions: z.boolean().nullish(),
  scripting: z.boolean().nullish(),
  gpu: z.boolean().nullish(),
  parity: z.unknown().nullish(),
});

export type AppCapabilities = z.infer<typeof AppCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Files — `effectcraft.files()` table entries, `saveToBrowser`, assets
// ---------------------------------------------------------------------------

export interface FileEntry {
  readonly path: string;
  readonly size: number;
}

export const SaveResultSchema = z.object({
  path: z.string(),
  bytes: z.number(),
});

export type SaveResult = z.infer<typeof SaveResultSchema>;

/**
 * A cloud asset from the SaaS to place into the editor's file table
 * (§6.3): `addAsset` fetches the signed URL in the parent (the iframe never
 * needs cross-origin rights) and stores the bytes under
 * `/assets/<assetId>/<sanitizedName>`.
 *
 * Upstream note: `addFile` keeps only the last path segment
 * (`editor/apps/studio-web/src/files.rs` `path_for`), so the editor may
 * report a shorter path than requested. `addAsset` returns the path the
 * editor actually assigned — treat the return value, not the request, as
 * authoritative.
 */
export interface CloudAsset {
  readonly assetId: string;
  readonly name: string;
  /** Signed URL; fetched in the parent frame. */
  readonly url?: string;
  /** Already-fetched bytes (skips the fetch). */
  readonly bytes?: Blob | Uint8Array;
}

// ---------------------------------------------------------------------------
// The bridge interface — PRODUCT_ARCHITECTURE §6.2 (+ task-mandated additions)
// ---------------------------------------------------------------------------

export type EditorEventName = "ready" | "focus" | "resize" | "error";

export type EditorEventHandler = (payload: unknown) => void;

/**
 * The only way product code talks to the editor (§6.2).
 *
 * §6.2 members: `ready`, `inspect`, `commands`, `describe`, `query`, `batch`,
 * `renderFrame`, `addFile`, `addAsset`, `saveToBrowser`, `readFile`,
 * `screenshot`, `on`.
 *
 * Additions required by W1-d: `execute`, `request` (low-level passthrough),
 * `info` / `version` / `capabilities`, `dispose`.
 */
export interface EditorBridge {
  /** Resolves once `window.studioEngine` reports ready (again, if the editor reloads). */
  ready(): Promise<void>;
  inspect(): Promise<UiInspect>;
  /** The command registry (`engine.commands`), optionally filtered by id/label substring. */
  commands(filter?: string): Promise<CommandInfo[]>;
  /** One command in full: params doc + JSON Schema (`command.describe`). */
  describe(command: string): Promise<CommandSchema>;
  /** Read-only engine queries: `project.summary`, `comp.info`, `layer.tree`, `prop.get`, `editor.state`, `edit.history.list`… */
  query<T = unknown>(command: string, params?: unknown): Promise<T>;
  /** Journaled engine commands (undoable edits): `edit.undo`, `edit.redo`, `layer.newSolid`… */
  execute<T = unknown>(command: string, params?: unknown): Promise<T>;
  /**
   * Per-call overrides for heavy first commands: `file.open` on a cold,
   * software-rendered engine (parse + replace project + restore view) can
   * exceed the default 15 s budget while the engine is perfectly healthy.
   * `timeoutMs` widens ONLY this call's budget (the promise still resolves
   * as soon as the engine answers).
   */
  execute<T = unknown>(
    command: string,
    params: unknown | undefined,
    opts: { readonly timeoutMs?: number },
  ): Promise<T>;
  /**
   * Low-level passthrough for any control method (`ui.click`, `ui.key`,
   * `ui.playback`, `ui.menu.invoke`, `render.frame`, `engine.execute`, …).
   * Results are not validated; prefer the typed methods.
   */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Run an agent batch: validated (≤100 steps, atomic) and sent as ONE undo step (`engine.batch`). */
  batch(batch: AgentBatchInput): Promise<BatchResult>;
  renderFrame(params: RenderFrameParams): Promise<RenderFrameResult>;
  /** Bytes into the editor's file table (`effectcraft.addFile`); resolves with the table path. */
  addFile(file: Blob | File | string, name?: string): Promise<string>;
  /** A cloud asset under its stable virtual path (§6.3); resolves with the path the editor assigned. */
  addAsset(asset: CloudAsset): Promise<string>;
  saveToBrowser(path: string): Promise<SaveResult>;
  readFile(path: string): Promise<Uint8Array>;
  screenshot(params?: ScreenshotParams): Promise<ScreenshotResult>;
  on(event: EditorEventName, cb: EditorEventHandler): () => void;
  /** The editor's version string, read synchronously from `effectcraft.info()`. */
  version(): string;
  /** Backend/build facts from `effectcraft.info()` (sync upstream), incl. `load` timings. */
  info(): EditorInfo;
  /** `app.capabilities`: version, command/effect counts, export formats, parity summary. */
  capabilities(): Promise<AppCapabilities>;
  /** Remove all listeners; later calls fail with `EDITOR_DISCONNECTED`. */
  dispose(): void;
}
