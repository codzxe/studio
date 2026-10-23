import { z } from "zod";
import type { PlanRisk } from "./edit-plan.js";
/** The eight write-tool ids (BUILD_PLAN §M5.1), in §8.4 table order. */
export declare const WRITE_TOOL_IDS: readonly ["create_composition", "create_text", "set_properties", "add_effect", "set_keyframes", "apply_preset", "undo_run", "save_version"];
export type WriteToolId = (typeof WRITE_TOOL_IDS)[number];
/** The wire id a write tool is registered under in the tool catalog. */
export declare function studioWriteToolId(id: WriteToolId): `studio.${WriteToolId}`;
/** Composition name bound (§M5.1: name ≤ 80). */
export declare const MAX_COMPOSITION_NAME_LENGTH = 80;
/** Composition pixel bounds (§M5.1: width/height 1..8192). */
export declare const MIN_COMPOSITION_DIMENSION = 1;
export declare const MAX_COMPOSITION_DIMENSION = 8192;
/** Frame-rate bounds (§M5.1: fps 1..120; fractional rates like 29.97 allowed). */
export declare const MIN_FRAME_RATE = 1;
export declare const MAX_FRAME_RATE = 120;
/** Duration bounds in seconds (§M5.1: duration 0.01..36000). */
export declare const MIN_DURATION_SECONDS = 0.01;
export declare const MAX_DURATION_SECONDS = 36000;
/** Keyframe time bounds in seconds (§M5.1: timeSeconds 0..36000). */
export declare const MAX_TIME_SECONDS = 36000;
/** create_text text bound (§M5.1: ≤ 2000). */
export declare const MAX_TEXT_LENGTH = 2000;
/** Layer / preset / effect / version-label name bound (§M5.1: ≤ 120). */
export declare const MAX_TOOL_NAME_LENGTH = 120;
/** Font family / style bound (mirrors the M4 read-tool font bound). */
export declare const MAX_FONT_LENGTH = 200;
/** Property-path bound (§M5.1: path ≤ 200). */
export declare const MAX_PROPERTY_PATH_LENGTH = 200;
/** Layer references per call (§M5.1: ≤ 50, always BY NAME). */
export declare const MAX_LAYER_REFS = 50;
/** set_properties updates per call (§M5.1: 1..100). */
export declare const MAX_PROPERTY_UPDATES = 100;
/** set_keyframes keys per call (§M5.1: 1..500). */
export declare const MAX_KEYFRAME_KEYS = 500;
/** Font size bounds (engine clamps size to 0.1..10_000 — text_doc.rs). */
export declare const MIN_TEXT_SIZE = 0.1;
export declare const MAX_TEXT_SIZE = 10000;
/** Comp-space coordinate bound for position/box (engine has none; curated). */
export declare const MAX_COORD = 1000000;
/** Stroke width / tracking / leading bounds (engine ≥0 only; curated). */
export declare const MAX_STROKE_WIDTH = 1000;
export declare const MAX_TRACKING = 10000;
export declare const MAX_LEADING = 10000;
/** Tool-result note bound (the "proposed, never executed" note). */
export declare const MAX_RESULT_NOTE_LENGTH = 1000;
/**
 * Total serialized-args ceiling for tools with free-form values/passthroughs
 * — the §8.5 2 MB batch payload cap applied at the tool-args boundary.
 */
export declare const MAX_WRITE_TOOL_ARGS_BYTES: number;
/** Object keys that are never legitimate names, paths or data keys (F-1). */
export declare const DUNDER_KEYS: readonly ["__proto__", "constructor", "prototype"];
/** `true` when `key` is one of the dangerous prototype-chain names. */
export declare function isDunderKey(key: string): boolean;
/**
 * First dunder-key location inside `value` (e.g. `"a[2].__proto__"`), or
 * `undefined` when the value is clean. Walks own enumerable properties only,
 * so a JSON-parsed `__proto__` own-key IS caught (JSON.parse does not invoke
 * the setter). Shared DUNDER-safe refinement helper (M5-SEAMS; exported for
 * the plan compiler and client executor).
 */
export declare function firstDunderKeyLocation(value: unknown): string | undefined;
/** `true` when no object key anywhere inside `value` is a dunder key (F-1). */
export declare function hasNoDunderKeys(value: unknown): boolean;
/**
 * `true` when no path SEGMENT of `path` is a dunder key. Segments are the
 * identifier runs between separators (e.g. `"transform/opacity"` →
 * `["transform", "opacity"]`), so `__proto__`, `a.__proto__.b` and
 * `effects[0].constructor` are rejected while `my__proto__field` is not.
 */
export declare function hasNoDunderSegments(path: string): boolean;
/**
 * Deep JSON-serializability (for free-form values): null/boolean/string/
 * finite-number, arrays, and plain objects only — no `undefined`, functions,
 * symbols, bigints, class instances (Date/Map/…) or cycles. Tool args cross
 * the wire as JSON, so non-JSON values are rejected at the boundary.
 */
export declare function isJsonSerializableValue(value: unknown): boolean;
export declare const CREATE_COMPOSITION_ARGS_SCHEMA: z.ZodObject<{
    name: z.ZodString;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    frameRate: z.ZodOptional<z.ZodNumber>;
    durationSeconds: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
/**
 * Curated subset of the REAL `layer.newText` params (layer.rs ~1592-1601):
 * `{text?, name?, position? [x,y], box? [x,y,w,h], font?, style?, size?,
 * fill?, stroke?, strokeWidth?, tracking?, leading?, …}`. The engine clamps
 * size to 0.1..10_000 and treats stroke as applyStroke=true; bounds here
 * mirror or tighten those. `leading` is a number (omit it for Auto).
 */
export declare const CREATE_TEXT_ARGS_SCHEMA: z.ZodObject<{
    text: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>;
    box: z.ZodOptional<z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber, z.ZodNumber], null>>;
    font: z.ZodOptional<z.ZodString>;
    style: z.ZodOptional<z.ZodString>;
    size: z.ZodOptional<z.ZodNumber>;
    fill: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null>, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber, z.ZodNumber], null>]>>;
    stroke: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null>, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber, z.ZodNumber], null>]>>;
    strokeWidth: z.ZodOptional<z.ZodNumber>;
    tracking: z.ZodOptional<z.ZodNumber>;
    leading: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const SET_PROPERTIES_ARGS_SCHEMA: z.ZodObject<{
    layers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>>;
    properties: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        value: z.ZodUnknown;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const ADD_EFFECT_ARGS_SCHEMA: z.ZodObject<{
    layers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>>;
    effect: z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>;
    params: z.ZodOptional<z.ZodPreprocess<z.ZodRecord<z.ZodString, z.ZodUnknown>, unknown>>;
}, z.core.$strict>;
/** Keyframe interpolation (the engine's core trio — prop.rs Interp). */
export declare const KEYFRAME_INTERPOLATION_SCHEMA: z.ZodEnum<{
    linear: "linear";
    bezier: "bezier";
    hold: "hold";
}>;
export declare const SET_KEYFRAMES_ARGS_SCHEMA: z.ZodObject<{
    layers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>>;
    propertyPath: z.ZodString;
    keys: z.ZodArray<z.ZodObject<{
        timeSeconds: z.ZodNumber;
        value: z.ZodUnknown;
        interpolation: z.ZodOptional<z.ZodEnum<{
            linear: "linear";
            bezier: "bezier";
            hold: "hold";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const APPLY_PRESET_ARGS_SCHEMA: z.ZodObject<{
    preset: z.ZodUnion<readonly [z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        builtinId: z.ZodString;
    }, z.core.$strict>]>;
    layers: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>>>;
    args: z.ZodOptional<z.ZodPreprocess<z.ZodRecord<z.ZodString, z.ZodUnknown>, unknown>>;
}, z.core.$strict>;
/** undo_run takes NO args: it proposes ONE undo for the whole applied run
 * (law #6 — the run applied as one atomic batch, so it undoes as one). */
export declare const UNDO_RUN_ARGS_SCHEMA: z.ZodObject<{}, z.core.$strict>;
export declare const SAVE_VERSION_ARGS_SCHEMA: z.ZodObject<{
    label: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type CreateCompositionArgs = z.infer<typeof CREATE_COMPOSITION_ARGS_SCHEMA>;
export type CreateTextArgs = z.infer<typeof CREATE_TEXT_ARGS_SCHEMA>;
export type SetPropertiesArgs = z.infer<typeof SET_PROPERTIES_ARGS_SCHEMA>;
export type AddEffectArgs = z.infer<typeof ADD_EFFECT_ARGS_SCHEMA>;
export type SetKeyframesArgs = z.infer<typeof SET_KEYFRAMES_ARGS_SCHEMA>;
export type ApplyPresetArgs = z.infer<typeof APPLY_PRESET_ARGS_SCHEMA>;
export type SaveVersionArgs = z.infer<typeof SAVE_VERSION_ARGS_SCHEMA>;
export declare const WRITE_TOOL_ARGS_SCHEMAS: {
    readonly create_composition: z.ZodObject<{
        name: z.ZodString;
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
        frameRate: z.ZodOptional<z.ZodNumber>;
        durationSeconds: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly create_text: z.ZodObject<{
        text: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        position: z.ZodOptional<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>;
        box: z.ZodOptional<z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber, z.ZodNumber], null>>;
        font: z.ZodOptional<z.ZodString>;
        style: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
        fill: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null>, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber, z.ZodNumber], null>]>>;
        stroke: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null>, z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber, z.ZodNumber], null>]>>;
        strokeWidth: z.ZodOptional<z.ZodNumber>;
        tracking: z.ZodOptional<z.ZodNumber>;
        leading: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly set_properties: z.ZodObject<{
        layers: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>>;
        properties: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            value: z.ZodUnknown;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly add_effect: z.ZodObject<{
        layers: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>>;
        effect: z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>;
        params: z.ZodOptional<z.ZodPreprocess<z.ZodRecord<z.ZodString, z.ZodUnknown>, unknown>>;
    }, z.core.$strict>;
    readonly set_keyframes: z.ZodObject<{
        layers: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>>;
        propertyPath: z.ZodString;
        keys: z.ZodArray<z.ZodObject<{
            timeSeconds: z.ZodNumber;
            value: z.ZodUnknown;
            interpolation: z.ZodOptional<z.ZodEnum<{
                linear: "linear";
                bezier: "bezier";
                hold: "hold";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly apply_preset: z.ZodObject<{
        preset: z.ZodUnion<readonly [z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            builtinId: z.ZodString;
        }, z.core.$strict>]>;
        layers: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>>>;
        args: z.ZodOptional<z.ZodPreprocess<z.ZodRecord<z.ZodString, z.ZodUnknown>, unknown>>;
    }, z.core.$strict>;
    readonly undo_run: z.ZodObject<{}, z.core.$strict>;
    readonly save_version: z.ZodObject<{
        label: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
};
export interface WriteToolDefinition {
    readonly id: WriteToolId;
    readonly kind: "write";
    /** Risk badge for the plan card (EDITOR_CHAT_UX §6.2). */
    readonly risk: PlanRisk;
    /** Model-facing description. No command ids, no engine internals, and it
     * always states the result is a PROPOSED batch, never an execution. */
    readonly description: string;
    /** STRICT ZodObject the gateway validates before the tool runs (law #2). */
    readonly inputSchema: z.ZodObject;
    readonly returns: "proposed-batch";
}
/** The eight write tools, in §8.4 table order. */
export declare const WRITE_TOOLS: readonly WriteToolDefinition[];
/**
 * The proposed-batch tool result envelope. `proposedBatch` mirrors the §8.5
 * batch steps (the same shape §8.6 plans carry as data); `note` always tells
 * the model the batch is proposed, never executed. The dunder/JSON guards
 * run in `z.preprocess` on the RAW payload — step params are records, and
 * Zod's record rebuild silently drops own `__proto__` keys before output
 * refinements run (see PASSTHROUGH_RECORD_SCHEMA) — and the whole envelope
 * is bounded to the §8.5 2 MB payload.
 */
export declare const WRITE_TOOL_RESULT_SCHEMA: z.ZodPreprocess<z.ZodObject<{
    proposedBatch: z.ZodObject<{
        label: z.ZodString;
        steps: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strip>>;
    }, z.core.$strict>;
    note: z.ZodString;
}, z.core.$strict>, unknown>;
export type WriteToolResult = z.infer<typeof WRITE_TOOL_RESULT_SCHEMA>;
/** Canonical note for write-tool results (always ≤ MAX_RESULT_NOTE_LENGTH). */
export declare const PROPOSED_BATCH_NOTE = "Proposed batch only \u2014 nothing is executed until the user applies the plan.";
