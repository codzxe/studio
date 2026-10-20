// tests/protocol-schemas.ts — Zod pins of the recorded reply shapes (spec §21 Contract row:
// "Recorded RPC fixtures + schema tests … detect upstream drift in CI").
//
// Every schema below is hand-transcribed from the pinned engine revision (872748fb…):
//   - envelope + error strings: vendor/photocraft/crates/automation/src/rpc.rs (respond, batch)
//   - auth: crates/automation/src/security.rs (authentication_reply)
//   - budgets: crates/automation/src/budgets.rs + security.rs (MAX_REQUEST_BYTES etc.)
//   - doc.* results: crates/automation/src/headless.rs + crates/engine/src/inspect.rs
//   - command list: crates/engine/src/commands.rs + docs/control-protocol.md › Command list replies
//
// If a fixture stops parsing against these schemas, the engine's wire contract drifted.

import { z } from "zod";

/** A JSON value as the engine sends it (serde_json::Value). */
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

/** Request/reply correlation id: the engine echoes whatever JSON value the client sent. */
export const correlationIdSchema = z.union([z.string(), z.number(), z.null()]);

/**
 * One JSON-lines reply: `{"id", "ok", "result"}` or `{"id", "ok", "error"}`.
 * `ok: false` never carries `result`, `ok: true` never carries `error` (rpc.rs :: respond);
 * transport-level failures reply with `id: null` (bad JSON, oversized line).
 */
export const envelopeSchema = z
  .object({
    id: correlationIdSchema,
    ok: z.boolean(),
    result: jsonValueSchema.optional(),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((reply, ctx) => {
    if (reply.ok && !("result" in reply)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ok reply must carry `result`" });
    }
    if (reply.ok && "error" in reply) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ok reply must not carry `error`" });
    }
    if (!reply.ok && !("error" in reply)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "error reply must carry `error`" });
    }
    if (!reply.ok && "result" in reply) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "error reply must not carry `result`" });
    }
  });

export type Envelope = z.infer<typeof envelopeSchema>;

/** `auth` success: security.rs always replies exactly `{"authenticated": true}`. */
export const authOkSchema = envelopeSchema.and(
  // Non-strict outer: the envelope already strictly validates id/ok; this arm only pins `result`.
  z.object({ result: z.object({ authenticated: z.literal(true) }).strict() }),
);

/** `doc.new` result: file.new replies `{"document": index}` — a session index, not an id. */
export const docNewResultSchema = z.object({ document: z.number().int().min(0) }).strict();

/** Tool colours (photocraft_color::Color): `{mode, c[4], alpha}` as normalized floats. */
const colorSchema = z
  .object({ mode: z.string(), c: z.tuple([z.number(), z.number(), z.number(), z.number()]), alpha: z.number() })
  .strict();

/** `session.list` result — inspect.rs :: session(): documents are addressed by `index`. */
export const sessionListResultSchema = z
  .object({
    active: z.number().int().min(0).nullable(),
    documents: z
      .array(
        z
          .object({
            index: z.number().int().min(0),
            name: z.string(),
            path: z.string().nullable(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            dirty: z.boolean(),
            revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(0),
    foreground: colorSchema,
    background: colorSchema,
  })
  .strict();

/** `[x, y, w, h]` or null when a surface has no content (inspect.rs :: layer_sel bounds). */
const boundsSchema = z.union([z.tuple([z.number(), z.number(), z.number(), z.number()]), z.null()]);

const layerKindSchema = z.enum(["Pixel", "Group", "Adjustment", "Fill", "Type", "Shape", "Smart Object"]);

/** One layer node of `doc.inspect`'s `layers` tree (base keys + kind-specific extras). */
export interface LayerNode {
  id: number;
  name: string;
  kind: z.infer<typeof layerKindSchema>;
  visible: boolean;
  labelColor: string;
  opacity: number;
  fill: number;
  blend: string;
  clipped: boolean;
  hasMask: boolean;
  hasVectorMask: boolean;
  vectorMaskEnabled: boolean | null;
  bounds: [number, number, number, number] | null;
  selected: boolean;
  linkGroup: number | null;
  children?: LayerNode[];
  expanded?: boolean;
  text?: { text: string; font: string; sizePt: number };
  // `params` mirrors serde_json::Value; zod types an unknown-typed payload as an optional
  // key (runtime parse still accepts the recorded object shape).
  adjustment?: { kind: string; params?: unknown };
}

/**
 * One layer node — base keys on every node (inspect.rs :: layer_sel), plus kind-specific
 * extras (children/expanded on groups, text on type layers, adjustment on adjustment
 * layers, smart* on smart objects). Recursive: groups list their `children`.
 */
// The Input side is an index signature: zod's Input type marks lazy/unknown payloads
// optional (`params?: unknown`), so pinning Input = LayerNode would not typecheck; parse
// outputs are what the suite consumes and those are pinned exactly by LayerNode above.
export const layerNodeSchema: z.ZodType<LayerNode, z.ZodTypeDef, Record<string, unknown>> = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    kind: layerKindSchema,
    visible: z.boolean(),
    labelColor: z.string(),
    opacity: z.number().min(0).max(1),
    fill: z.number().min(0).max(1),
    blend: z.string(),
    clipped: z.boolean(),
    hasMask: z.boolean(),
    hasVectorMask: z.boolean(),
    vectorMaskEnabled: z.boolean().nullable(),
    bounds: boundsSchema,
    selected: z.boolean(),
    linkGroup: z.number().nullable(),
    children: z.array(z.lazy(() => layerNodeSchema)).optional(),
    expanded: z.boolean().optional(),
    text: z.object({ text: z.string(), font: z.string(), sizePt: z.number() }).strict().optional(),
    adjustment: z
      .object({ kind: z.string(), params: jsonValueSchema })
      .strict()
      .optional(),
  })
  .strict();

/** `doc.inspect` result — inspect.rs :: document() (top-level keys, in emission order). */
export const docInspectResultSchema = z
  .object({
    name: z.string(),
    path: z.string().nullable(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mode: z.string(),
    depth: z.number().int().positive(),
    resolution: z.number(),
    activeLayer: z.number().int().nullable(),
    selectedLayers: z.array(z.number().int()),
    isolatedLayers: z.array(z.number().int()),
    hasSelection: z.boolean(),
    selectionBounds: boundsSchema,
    layers: z.array(layerNodeSchema),
    history: z.array(z.string()),
    snapshots: z.array(z.object({ id: z.number().int(), name: z.string() }).strict()),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    revision: z.number().int().nonnegative(),
    channels: jsonValueSchema,
    quickMask: z.boolean(),
    symmetry: jsonValueSchema.nullable(),
    layerMaskView: jsonValueSchema.nullable(),
    layerComps: z.array(z.object({ id: z.number().int(), name: z.string() }).strict()),
    lastAppliedComp: z.number().int().nullable(),
    measurement: jsonValueSchema,
    notes: z.array(jsonValueSchema),
    timeline: jsonValueSchema.nullable(),
  })
  .strict();

/**
 * One `engine.commands` entry — rpc.rs :: command_list_replies_are_documented_array_of_objects
 * pins the exact key set (`keywords` optional, #5060). `disabledReason` is null exactly when
 * enabled; `needsDocument` true only when off because no document is open (#3664).
 */
export const commandEntrySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    menu: z.array(z.string()),
    shortcut: z.string().nullable(),
    params: z.string(),
    enabled: z.boolean(),
    disabledReason: z.string().nullable(),
    needsDocument: z.boolean(),
    keywords: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.enabled !== (entry.disabledReason === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "disabledReason must be null exactly when enabled is true",
      });
    }
    if (entry.enabled && entry.needsDocument) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an enabled command never needsDocument" });
    }
  });

export type CommandEntry = z.infer<typeof commandEntrySchema>;

/** `engine.commands` / `command.list` reply: a BARE array — no `{"commands": …}` wrapper. */
export const commandListResultSchema = z.array(commandEntrySchema).min(1);

/** One batch step outcome (rpc.rs :: batch_with_budget: json!({"ok":true,"result":…}) | {…error}). */
const batchStepSchema = z.union([
  z.object({ ok: z.literal(true), result: jsonValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

/** `batch` reply. Invariant from rpc.rs: `completed` counts ok steps, `failed` counts errors, */
/** and every retained step is one of the two — so completed + failed === results.length. */
export const batchResultSchema = z
  .object({
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    results: z.array(batchStepSchema),
  })
  .strict()
  .superRefine((reply, ctx) => {
    if (reply.completed + reply.failed !== reply.results.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed + failed must equal results.length (rpc.rs batch_with_budget)",
      });
    }
  });

/** `doc.render` without `path` (rpc.rs base64 arm). */
export const renderBase64ResultSchema = z
  .object({ mime: z.literal("image/png"), base64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) })
  .strict();

/** `doc.render` with `path` (rpc.rs file arm): `bytes` is the written PNG's length. */
export const renderPathResultSchema = z
  .object({ path: z.string(), bytes: z.number().int().positive() })
  .strict();

/**
 * The headless `methods` reply — the frozen METHODS const of
 * vendor/photocraft/crates/automation/src/rpc.rs at the pinned revision, in order.
 * drift-check.test.ts compares a recorded fixture against this pin.
 */
export const METHODS_PIN = [
  "engine.execute",
  "jobs.list",
  "jobs.cancel",
  "engine.commands",
  "session.list",
  "doc.open",
  "doc.place",
  "doc.new",
  "doc.save",
  "doc.exportLayers",
  "doc.exportDataSets",
  "doc.importDataSets",
  "doc.inspect",
  "doc.render",
  "doc.select",
  "doc.close",
  "batch",
  "methods",
] as const;

/** Methods the studio client depends on directly (BUILD_PROMPT §1501 spike + §2.2 rules). */
export const REQUIRED_METHODS = [
  "engine.execute",
  "engine.commands",
  "batch",
  "doc.new",
  "doc.inspect",
  "doc.render",
  "doc.save",
  "session.list",
  "methods",
] as const;

// --- engine transport budgets (crates/automation/src/security.rs + budgets.rs) ---

/** Maximum encoded request line the server accepts before rejecting/closing (1 MiB). */
export const MAX_REQUEST_BYTES = 1 << 20;

/** Maximum encoded reply, including the newline (8 MiB). @studio/config mirrors this. */
export const MAX_REPLY_BYTES = 8 << 20;

/** Maximum steps in one headless `batch` request (security.rs MAX_BATCH_STEPS). */
export const MAX_BATCH_STEPS = 256;

/** Reply text the server sends for an oversized request line (rpc.rs :: serve_lines). */
export const OVERSIZED_REQUEST_ERROR = `request exceeds ${MAX_REQUEST_BYTES} bytes`;
