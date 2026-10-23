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
// ---------------------------------------------------------------------------
// UiInspect — `ui.inspect` (§6.5: active comp, selection, playback, time, focused panel, window size)
// ---------------------------------------------------------------------------
function focusedPanelOf(ui) {
    if (typeof ui === "object" && ui !== null && "focused" in ui) {
        const focused = ui.focused;
        if (typeof focused === "string" && focused.length > 0)
            return focused;
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
    window: v.window,
    playing: v.playing ?? false,
    time: v.time ?? 0,
    selectedLayers: v.selectedLayers ?? [],
    focusedPanel: focusedPanelOf(v.ui),
}));
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
export const PropNodeSchema = z.lazy(() => z.looseObject({
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
}));
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
export const ScreenshotResultSchema = z
    .looseObject({
    path: z.string().nullish(),
    width: z.number().nullish(),
    height: z.number().nullish(),
    png: z.string().nullish(),
    pngBase64: z.string().nullish(),
})
    .transform((v) => ({ ...v, pngBase64: v.pngBase64 ?? v.png ?? undefined }));
// ---------------------------------------------------------------------------
// EditorInfo — `effectcraft.info()` (sync upstream) + `app.capabilities`
// ---------------------------------------------------------------------------
export const EffectcraftLoadInfoSchema = z.looseObject({
    wasmMs: z.number().nullish(),
    readyMs: z.number().nullish(),
    error: z.string().nullish(),
});
export const EditorInfoSchema = z.looseObject({
    version: z
        .string()
        .nullish()
        .transform((v) => v ?? ""),
    load: EffectcraftLoadInfoSchema.nullish(),
});
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
export const SaveResultSchema = z.object({
    path: z.string(),
    bytes: z.number(),
});
//# sourceMappingURL=types.js.map