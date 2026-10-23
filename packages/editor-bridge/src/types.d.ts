/**
 * Types + runtime (Zod) schemas for the editor bridge (PRODUCT_ARCHITECTURE §6.2).
 *
 * The upstream JS surface (`window.effectcraft`, defined inline in
 * `editor/apps/effectcraft-web/web/index.html` and backed by
 * `editor/apps/effectcraft-web/src/api.rs`) is unknown-shaped from TypeScript's
 * point of view. At the boundary we therefore:
 *
 * - type the raw editor global as `EffectcraftGlobal` with `unknown` results,
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
/** `window.effectcraftLoad` — set to `{}` immediately, `{wasmMs, readyMs}` once running, `{error}` on failure (`web/index.html`). */
export interface EffectcraftLoad {
    readonly wasmMs?: number;
    readonly readyMs?: number;
    readonly error?: string;
}
/** `window.effectcraft` — verified method-for-method from `editor/apps/effectcraft-web/web/index.html` (v0.13.0). */
export interface EffectcraftGlobal {
    /** Any control method: `ui.inspect`, `ui.click`, `ui.key`, `ui.menu.invoke`, `render.frame`… Resolves with the method's `result`, rejects with its `error` message. */
    request(method: string, params?: unknown): Promise<unknown>;
    /** `engine.execute` — an engine command (same ids/params as MCP / effectcraft-cli). */
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
export interface EffectcraftWindow extends Window {
    effectcraft?: EffectcraftGlobal;
    effectcraftLoad?: EffectcraftLoad;
    effectcraftModule?: unknown;
}
export declare const UiInspectSchema: z.ZodPipe<z.ZodObject<{
    window: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
    pixelsPerPoint: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    fps: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    ui: z.ZodOptional<z.ZodNullable<z.ZodUnknown>>;
    playing: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    time: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    activeComp: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodNumber>>>;
    selectedLayers: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodNumber>>>;
    selectedKeys: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    keyboardFocus: z.ZodOptional<z.ZodNullable<z.ZodUnknown>>;
    windowFocused: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    dialog: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodString>>>;
    renderMs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.core.$loose>, z.ZodTransform<{
    window: [number, number];
    playing: boolean;
    time: number;
    selectedLayers: number[];
    focusedPanel: string | undefined;
    pixelsPerPoint?: number | null | undefined;
    fps?: number | null | undefined;
    ui?: unknown;
    activeComp?: number | null | undefined;
    selectedKeys?: number | null | undefined;
    keyboardFocus?: unknown;
    windowFocused?: boolean | null | undefined;
    dialog?: string | null | undefined;
    renderMs?: number | null | undefined;
}, {
    [x: string]: unknown;
    window: [number, number];
    pixelsPerPoint?: number | null | undefined;
    fps?: number | null | undefined;
    ui?: unknown;
    playing?: boolean | null | undefined;
    time?: number | null | undefined;
    activeComp?: number | null | undefined;
    selectedLayers?: number[] | null | undefined;
    selectedKeys?: number | null | undefined;
    keyboardFocus?: unknown;
    windowFocused?: boolean | null | undefined;
    dialog?: string | null | undefined;
    renderMs?: number | null | undefined;
}>>;
export type UiInspect = z.infer<typeof UiInspectSchema>;
export declare const ProjectItemSummarySchema: z.ZodObject<{
    id: z.ZodNumber;
    name: z.ZodString;
    type: z.ZodString;
    label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    parent: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodNumber>>>;
    size: z.ZodOptional<z.ZodNullable<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>>;
    duration: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    layers: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    frameRate: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    problem: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export type ProjectItemSummary = z.infer<typeof ProjectItemSummarySchema>;
export declare const ProjectSummarySchema: z.ZodObject<{
    path: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodString>>>;
    dirty: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    bitDepth: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    renderer: z.ZodOptional<z.ZodNullable<z.ZodUnknown>>;
    items: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        name: z.ZodString;
        type: z.ZodString;
        label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parent: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodNumber>>>;
        size: z.ZodOptional<z.ZodNullable<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>>;
        duration: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        layers: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        frameRate: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        problem: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>>>, z.ZodTransform<{
        id: number;
        name: string;
        type: string;
        label?: string | null | undefined;
        parent?: number | null | undefined;
        size?: [number, number] | null | undefined;
        duration?: number | null | undefined;
        layers?: number | null | undefined;
        frameRate?: number | null | undefined;
        problem?: string | null | undefined;
    }[], {
        id: number;
        name: string;
        type: string;
        label?: string | null | undefined;
        parent?: number | null | undefined;
        size?: [number, number] | null | undefined;
        duration?: number | null | undefined;
        layers?: number | null | undefined;
        frameRate?: number | null | undefined;
        problem?: string | null | undefined;
    }[] | null | undefined>>;
    activeComp: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodNumber>>>;
    time: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    selectedLayers: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodNumber>>>, z.ZodTransform<number[], number[] | null | undefined>>;
    undo: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString>>>, z.ZodTransform<string[], string[] | null | undefined>>;
}, z.core.$strip>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
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
export declare const PropKeyframeInfoSchema: z.ZodObject<{
    time: z.ZodNumber;
    value: z.ZodUnknown;
    in: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    out: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const PropValueSchema: z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodBoolean, z.ZodNull, z.ZodArray<z.ZodUnknown>, z.ZodRecord<z.ZodString, z.ZodUnknown>]>;
export declare const PropNodeSchema: z.ZodType<PropNode>;
export declare const LayerNodeSchema: z.ZodObject<{
    id: z.ZodNumber;
    name: z.ZodString;
    index: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    type: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    time: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    properties: z.ZodOptional<z.ZodNullable<z.ZodType<PropNode, unknown, z.core.$ZodTypeInternals<PropNode, unknown>>>>;
}, z.core.$loose>;
/** One engine command as listed by `engine.commands` / `command.list {filter?, enabledOnly?}`. */
export declare const CommandInfoSchema: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    menu: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString>>>, z.ZodTransform<string[], string[] | null | undefined>>;
    shortcut: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodString>>>;
    params: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    enabled: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodBoolean>>, z.ZodTransform<boolean, boolean | null | undefined>>;
    why: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodString>>>;
}, z.core.$strip>;
export type CommandInfo = z.infer<typeof CommandInfoSchema>;
/** `command.describe {command}` — params doc + JSON Schema, undoability, enablement. */
export declare const CommandSchemaSchema: z.ZodPipe<z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    menu: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString>>>, z.ZodTransform<string[], string[] | null | undefined>>;
    shortcut: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodString>>>;
    params: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    schema: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    undoable: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    enabled: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodBoolean>>, z.ZodTransform<boolean, boolean | null | undefined>>;
    why: z.ZodOptional<z.ZodNullable<z.ZodNullable<z.ZodString>>>;
}, z.core.$strip>, z.ZodTransform<{
    id: string;
    label: string;
    menu: string[];
    enabled: boolean;
    shortcut?: string | null | undefined;
    params?: string | null | undefined;
    schema?: Record<string, unknown> | null | undefined;
    undoable?: boolean | null | undefined;
    why?: string | null | undefined;
    command: string;
}, {
    id: string;
    label: string;
    menu: string[];
    enabled: boolean;
    shortcut?: string | null | undefined;
    params?: string | null | undefined;
    schema?: Record<string, unknown> | null | undefined;
    undoable?: boolean | null | undefined;
    why?: string | null | undefined;
}>>;
export type CommandSchema = z.infer<typeof CommandSchemaSchema>;
export declare const BatchResultSchema: z.ZodObject<{
    steps: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodNumber>>, z.ZodTransform<number, number | null | undefined>>;
    results: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodUnknown>>>, z.ZodTransform<unknown[], unknown[] | null | undefined>>;
}, z.core.$strip>;
export type BatchResult = z.infer<typeof BatchResultSchema>;
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
export declare const RenderFrameResultSchema: z.ZodPipe<z.ZodObject<{
    comp: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    time: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
    png: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    pngBase64: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>, z.ZodTransform<{
    pngBase64: string | undefined;
    comp: string | number;
    time: number;
    width: number;
    height: number;
    png?: string | null | undefined;
}, {
    comp: string | number;
    time: number;
    width: number;
    height: number;
    png?: string | null | undefined;
    pngBase64?: string | null | undefined;
}>>;
export type RenderFrameResult = z.infer<typeof RenderFrameResultSchema>;
export interface ScreenshotParams {
    /** Write the PNG to `path` instead of returning it inline (web default: inline). */
    path?: string;
    /** Crop to a panel, e.g. `Timeline`. */
    panel?: string;
    /** Crop to an element id, e.g. `panel.Timeline`. */
    id?: string;
}
export declare const ScreenshotResultSchema: z.ZodPipe<z.ZodObject<{
    path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    width: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    height: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    png: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    pngBase64: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>, z.ZodTransform<{
    pngBase64: string | undefined;
    path?: string | null | undefined;
    width?: number | null | undefined;
    height?: number | null | undefined;
    png?: string | null | undefined;
}, {
    [x: string]: unknown;
    path?: string | null | undefined;
    width?: number | null | undefined;
    height?: number | null | undefined;
    png?: string | null | undefined;
    pngBase64?: string | null | undefined;
}>>;
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;
export declare const EffectcraftLoadInfoSchema: z.ZodObject<{
    wasmMs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readyMs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export type EffectcraftLoadInfo = z.infer<typeof EffectcraftLoadInfoSchema>;
export declare const EditorInfoSchema: z.ZodObject<{
    version: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    load: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        wasmMs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        readyMs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        error: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$loose>>>;
}, z.core.$loose>;
export type EditorInfo = z.infer<typeof EditorInfoSchema>;
export declare const AppCapabilitiesSchema: z.ZodObject<{
    version: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    commands: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    effects: z.ZodOptional<z.ZodNullable<z.ZodUnknown>>;
    export: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodUnknown>>>;
    import: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    expressions: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    scripting: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    gpu: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    parity: z.ZodOptional<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$loose>;
export type AppCapabilities = z.infer<typeof AppCapabilitiesSchema>;
export interface FileEntry {
    readonly path: string;
    readonly size: number;
}
export declare const SaveResultSchema: z.ZodObject<{
    path: z.ZodString;
    bytes: z.ZodNumber;
}, z.core.$strip>;
export type SaveResult = z.infer<typeof SaveResultSchema>;
/**
 * A cloud asset from the SaaS to place into the editor's file table
 * (§6.3): `addAsset` fetches the signed URL in the parent (the iframe never
 * needs cross-origin rights) and stores the bytes under
 * `/assets/<assetId>/<sanitizedName>`.
 *
 * Upstream note: `addFile` keeps only the last path segment
 * (`editor/apps/effectcraft-web/src/files.rs` `path_for`), so the editor may
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
    /** Resolves once `window.effectcraft` reports ready (again, if the editor reloads). */
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
