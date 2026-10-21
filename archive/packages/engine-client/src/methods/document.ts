// @studio/engine-client — typed builders for the document/session methods (W2-C).
//
// Sources (vendor pinned 872748fb — params and result keys verified, never invented):
//   - control-protocol.md §Headless server method table + rpc.rs `handle` dispatch.
//   - `file.new` spec + body: crates/engine/src/commands.rs (defaults: 1920×1080, rgb, 8-bit,
//     white, 72 ppi; floats round, sizes clamp to 1..300000).
//   - `doc.open` result: crates/automation/src/headless.rs `open` ({index,name,width,height,
//     layers,warnings}).
//   - `doc.place` → file_cmds.rs `place_bytes` ({layer,scale,bounds,smartObject}; the read
//     root is the scope of the refused ambient `file.placeEmbedded`, #2810).
//   - `session.list` / `document.inspect`: crates/engine/src/inspect.rs.
//
// Result schemas are deliberately shallow (house rule: ok/err first, then flat structure):
// `layers` rows in `doc.inspect` stay opaque so fixtures need no full scene graph.

import { z } from "zod";
import { type BuiltMethodCall, PROTOCOL_METHODS, READ_ROOT_PATH, buildCall } from "./protocol.js";

const nonNegativeInt = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// session.list — open documents and the active index (inspect.rs `session`)
// ---------------------------------------------------------------------------

export const SESSION_DOCUMENT_SCHEMA = z
  .object({
    index: nonNegativeInt,
    name: z.string(),
    path: z.string().nullable(),
    width: z.number().positive(),
    height: z.number().positive(),
    dirty: z.boolean(),
    revision: nonNegativeInt,
  })
  .passthrough();

export type SessionDocument = z.infer<typeof SESSION_DOCUMENT_SCHEMA>;

export const SESSION_LIST_SCHEMA = z
  .object({
    /** Active document index, or null when nothing is open. */
    active: nonNegativeInt.nullable(),
    documents: z.array(SESSION_DOCUMENT_SCHEMA),
    foreground: z.unknown(),
    background: z.unknown(),
  })
  .passthrough();

export type SessionList = z.infer<typeof SESSION_LIST_SCHEMA>;

const EMPTY_PARAMS = z.object({}).strict();

export function sessionList(): BuiltMethodCall<Record<string, never>, SessionList> {
  return buildCall(PROTOCOL_METHODS.sessionList, EMPTY_PARAMS, {}, SESSION_LIST_SCHEMA);
}

// ---------------------------------------------------------------------------
// doc.new — file.new params, passed through (rpc.rs: `doc.new` → `command_run("file.new")`)
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NEW_BACKGROUND = z.union([
  z.enum(["white", "black", "backgroundColor", "transparent"]),
  z.string().regex(HEX_COLOR, "expected white|black|backgroundColor|transparent|#rrggbb"),
]);

export const DOC_NEW_PARAMS = z
  .object({
    /** Canvas pixels; the engine rounds floats and clamps to 1..300000. */
    width: z.number().finite().min(1).optional(),
    height: z.number().finite().min(1).optional(),
    mode: z.enum(["rgb", "gray", "grayscale", "cmyk", "lab"]).optional(),
    depth: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
    background: NEW_BACKGROUND.optional(),
    /** RGB for `background: "backgroundColor"`, components 0..1. */
    backgroundColor: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
      .optional(),
    /** Resolution in ppi; the engine clamps to 1..30000. */
    resolution: z.number().finite().min(1).optional(),
    name: z.string().optional(),
  })
  .strict();

export type DocNewParams = z.infer<typeof DOC_NEW_PARAMS>;
export type DocNewInput = DocNewParams;

/** `file.new` replies `{ document: <index> }` (commands.rs). */
export const DOC_NEW_RESULT = z.object({ document: nonNegativeInt }).passthrough();
export type DocNewResult = z.infer<typeof DOC_NEW_RESULT>;

export function docNew(input: DocNewInput = {}): BuiltMethodCall<DocNewParams, DocNewResult> {
  return buildCall(PROTOCOL_METHODS.docNew, DOC_NEW_PARAMS, input, DOC_NEW_RESULT);
}

// ---------------------------------------------------------------------------
// doc.open — {path}; the read root is the capability scope
// ---------------------------------------------------------------------------

export const DOC_OPEN_PARAMS = z.object({ path: READ_ROOT_PATH }).strict();
export type DocOpenParams = z.infer<typeof DOC_OPEN_PARAMS>;
export type DocOpenInput = DocOpenParams;

export const DOC_OPEN_RESULT = z
  .object({
    index: nonNegativeInt,
    name: z.string(),
    width: z.number().positive(),
    height: z.number().positive(),
    /** Layer count of the opened document. */
    layers: nonNegativeInt,
    warnings: z.array(z.string()),
  })
  .passthrough();

export type DocOpenResult = z.infer<typeof DOC_OPEN_RESULT>;

export function docOpen(input: DocOpenInput): BuiltMethodCall<DocOpenParams, DocOpenResult> {
  return buildCall(PROTOCOL_METHODS.docOpen, DOC_OPEN_PARAMS, input, DOC_OPEN_RESULT);
}

// ---------------------------------------------------------------------------
// doc.place — Smart Object place, read-root scoped (#2810)
// ---------------------------------------------------------------------------

export const DOC_PLACE_PARAMS = z
  .object({
    /** Resolves beneath the automation read root; the engine reads the bytes itself
     *  (headless.rs `place` → `file_cmds::place_bytes`). Stage asset bytes under the read
     *  root first — the wire protocol has no inline-bytes variant. */
    path: READ_ROOT_PATH,
    index: nonNegativeInt.optional(),
    /** Scale in percent (the engine divides by 100); defaults to fitting oversized files. */
    scale: z.number().finite().optional(),
    fit: z.boolean().optional(),
    /** Layer centre in document pixels; default is the canvas centre. */
    center: z.tuple([z.number(), z.number()]).optional(),
    /** Off by request only overrides the Always-Create-Smart-Objects preference. */
    smartObject: z.boolean().optional(),
  })
  .strict();

export type DocPlaceParams = z.infer<typeof DOC_PLACE_PARAMS>;
export type DocPlaceInput = DocPlaceParams;

export const DOC_PLACE_RESULT = z
  .object({
    layer: nonNegativeInt,
    /** Percent actually applied. */
    scale: z.number(),
    /** [x0, y0, x1, y1] in document pixels. */
    bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    smartObject: z.boolean(),
  })
  .passthrough();

export type DocPlaceResult = z.infer<typeof DOC_PLACE_RESULT>;

export function docPlace(input: DocPlaceInput): BuiltMethodCall<DocPlaceParams, DocPlaceResult> {
  return buildCall(PROTOCOL_METHODS.docPlace, DOC_PLACE_PARAMS, input, DOC_PLACE_RESULT);
}

// ---------------------------------------------------------------------------
// doc.select / doc.close — index-targeted session operations
// ---------------------------------------------------------------------------

/** Missing or null `index` selects the ACTIVE document for `doc.close`/`doc.inspect`;
 *  `doc.select` REQUIRES a non-negative integer (rpc.rs `index_of`). */
const DOC_INDEX_PARAMS = z.object({ index: nonNegativeInt.optional() }).strict();
export type DocIndexParams = z.infer<typeof DOC_INDEX_PARAMS>;
export type DocIndexInput = DocIndexParams;

const DOC_SELECT_PARAMS = z.object({ index: nonNegativeInt }).strict();
export type DocSelectParams = z.infer<typeof DOC_SELECT_PARAMS>;
export type DocSelectInput = DocSelectParams;

export function docSelect(input: DocSelectInput): BuiltMethodCall<DocSelectParams, SessionList> {
  return buildCall(PROTOCOL_METHODS.docSelect, DOC_SELECT_PARAMS, input, SESSION_LIST_SCHEMA);
}

export function docClose(input: DocIndexInput = {}): BuiltMethodCall<DocIndexParams, SessionList> {
  return buildCall(PROTOCOL_METHODS.docClose, DOC_INDEX_PARAMS, input, SESSION_LIST_SCHEMA);
}

// ---------------------------------------------------------------------------
// doc.inspect — same JSON as the `document.inspect` command (rpc.rs)
// ---------------------------------------------------------------------------

export const DOCUMENT_INSPECT_SCHEMA = z
  .object({
    name: z.string(),
    path: z.string().nullable(),
    width: z.number().positive(),
    height: z.number().positive(),
    mode: z.string(),
    depth: z.number(),
    resolution: z.number(),
    activeLayer: nonNegativeInt.nullable(),
    selectedLayers: z.array(nonNegativeInt),
    hasSelection: z.boolean(),
    /** [x, y, w, h] or null. */
    selectionBounds: z.array(z.number()).nullable(),
    /** Layer tree, top-down — kept opaque: the studio consumes selected rows (§6 tools). */
    layers: z.array(z.unknown()),
    /** History entry labels, newest last (rpc.rs: last entry "Gaussian Blur"). */
    history: z.array(z.string()),
    snapshots: z.array(z.object({ id: z.number(), name: z.string() }).passthrough()),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    revision: nonNegativeInt,
  })
  .passthrough();

export type DocumentInspect = z.infer<typeof DOCUMENT_INSPECT_SCHEMA>;

export function docInspect(
  input: DocIndexInput = {},
): BuiltMethodCall<DocIndexParams, DocumentInspect> {
  return buildCall(PROTOCOL_METHODS.docInspect, DOC_INDEX_PARAMS, input, DOCUMENT_INSPECT_SCHEMA);
}
