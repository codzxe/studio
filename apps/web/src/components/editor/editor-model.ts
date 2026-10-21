// apps/web/src/components/editor/editor-model.ts
//
// Pure (React-free) domain model for the document editor: Zod schemas for
// every §13.1 wire shape the editor consumes + deterministic helpers the
// three panels share. Component files stay thin; this module is unit-tested
// in editor-model.test.ts without a DOM (docs/AGENTS.md test rules).
//
// WIRE CONTRACT (documented once, here — W8-C's page passes these payloads in):
//
//   GET /v1/documents/:id               → `{ ok, document: { …documentPayloadSchema } }`
//                                          (W4-F apps/gateway/src/routes/documents.ts
//                                          toDocumentDto — the editor takes the inner
//                                          `document` object; §13.1 says this reply also
//                                          carries a layer summary + preview URL once the
//                                          contract wave reconciles it, so the schema is
//                                          passthrough-tolerant).
//   layer tree                           → compact `layer.list`-shaped rows (engine reply:
//                                          top-down `id, name, kind, visible, bounds
//                                          [x,y,w,h]|null, selected, active`, groups carry
//                                          `children`; §13.1 GET /v1/documents/:id/layers is
//                                          the planned HTTP surface). `document.inspect`
//                                          rows additionally carry `opacity` (0..1), `locked`,
//                                          `expanded` — accepted, all optional.
//   GET  /v1/documents/:id/preview?w=     → previewReplySchema (W4-L routes/exports.ts;
//                                          404 `preview_not_rendered` until the worker's
//                                          PreviewPipeline writes the cache).
//   POST /v1/documents/:id/commands      → commandReplySchema (W4-K routes/commands.ts).
//   POST /v1/documents/:id/undo | /redo   → commandReplySchema, ONE step per call (§13.1).
//   POST /v1/runs                         → runCreatedReplySchema (W4-G routes/runs.ts;
//                                          camelCase body { documentId, prompt, tier }).
//   GET  /v1/runs/:id                     → runDetailSchema (W4-G runDetailToApi).
//
// Errors never cross these boundaries as raw objects: callers surface
// `ApiError.message` (the gateway's §13.3 user-safe text) via errorText().

import { z } from "zod";

// ---------------------------------------------------------------------------
// §5.2/§14.1 tier facts used by the chat-edit panel (quick edits)
// ---------------------------------------------------------------------------

/** §24.2/§20-#8: chat-editing one element runs on the quick tier. */
export const QUICK_TIER = "quick" as const;

/** §5.2 quick row: 1 credit. Shown in the composer hint, never hardcoded twice. */
export const QUICK_TIER_CREDITS = 1;

/** §5.2 quick wall clock: 2 min — polls stop before the tier can outlive it. */
export const QUICK_TIER_WALL_CLOCK_MS = 120_000;

/** GET /v1/runs/:id poll cadence for the inline mini-run status (§13.1). */
export const RUN_POLL_INTERVAL_MS = 1_200;

/** Poll budget ≥ the quick tier's 2-minute wall clock at the cadence above. */
export const MAX_RUN_POLLS = Math.ceil(QUICK_TIER_WALL_CLOCK_MS / RUN_POLL_INTERVAL_MS) + 5;

/** Gateway prompt cap (W4-G CREATE_RUN_BODY_SCHEMA) mirrored client-side. */
export const PROMPT_MAX_CHARS = 8_000;

/** §5.1 terminal run states (packages/db RUN_STATUSES). */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "succeeded_with_warnings",
  "failed",
  "cancelled",
] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Schemas — Zod at every boundary (docs/AGENTS.md); all passthrough-tolerant
// so additive server fields are not client-breaking, and every optional field
// the UI degrades on carries a default.
// ---------------------------------------------------------------------------

/** GET /v1/documents/:id inner `document` object (W4-F toDocumentDto). */
export const documentPayloadSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    width_px: z.number().int().positive(),
    height_px: z.number().int().positive(),
    current_revision: z.number().int().nonnegative(),
    template_id: z.string().nullable().optional(),
    created_by: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    archived_at: z.string().nullable().optional(),
    latest_version: z
      .object({
        id: z.string(),
        revision: z.number().int().nonnegative(),
        label: z.string(),
        created_by: z.string(),
        created_at: z.string(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

/** Parsed GET /v1/documents/:id `document` object (extras kept, untyped). */
export interface DocumentPayload extends z.infer<typeof documentPayloadSchema> {}

/**
 * Compact layer-tree node — the shape §10.1 describes and `layer.list` /
 * filtered `document.inspect` produce. Groups carry `children`; the engine
 * lists layers TOP-DOWN (§10.1 z-order = intent order), so array order is
 * render order and the tree renders it verbatim.
 */
export interface LayerNode {
  readonly id: string;
  readonly name: string;
  /** Engine kind string (`pixel`, `type`/`text`, `group`, `smart object`, …). */
  readonly kind: string;
  readonly visible: boolean;
  /** `document.inspect` rows: opacity 0..1. Absent in bare `layer.list` rows. */
  readonly opacity?: number | null;
  readonly locked?: boolean | null;
  readonly selected?: boolean;
  readonly active?: boolean;
  /** Groups only (§13.1 layer.setExpanded). */
  readonly expanded?: boolean;
  /** `[x, y, w, h]` in document px, or null while the layer has no bounds. */
  readonly bounds?: readonly [number, number, number, number] | null;
  /** Present on group nodes. */
  readonly children?: readonly LayerNode[];
}

const layerNodeSchema: z.ZodType<LayerNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      name: z.string().default("(unnamed)"),
      kind: z.string().default("pixel"),
      visible: z.boolean().default(true),
      opacity: z.number().min(0).max(1).nullable().optional(),
      locked: z.boolean().nullable().optional(),
      selected: z.boolean().optional(),
      active: z.boolean().optional(),
      expanded: z.boolean().optional(),
      bounds: z
        .tuple([z.number(), z.number(), z.number(), z.number()])
        .nullable()
        .optional(),
      children: z.array(layerNodeSchema).optional(),
    })
    .passthrough(),
);

/** Parses a compact layer-tree payload (top-level array, groups first). */
export const layerTreeSchema = z.array(layerNodeSchema);

/** GET /v1/documents/:id/preview?w=… reply (W4-L routes/exports.ts). */
export const previewReplySchema = z
  .object({
    url: z.string().min(1),
    revision: z.number().int().nonnegative(),
    expires_at: z.string(),
  })
  .passthrough();

export interface PreviewReply extends z.infer<typeof previewReplySchema> {}

/**
 * POST /v1/documents/:id/{commands,undo,redo} reply (W4-K routes/commands.ts
 * toCommandReply). The editor only consumes the revision pair + replayed flag.
 */
export const commandReplySchema = z
  .object({
    ok: z.literal(true),
    command: z.string(),
    seq: z.number().int().nonnegative(),
    summary: z.unknown().nullable().optional(),
    warnings: z.unknown().nullable().optional(),
    document_revision: z.number().int().nonnegative(),
    revision_before: z.number().int().nonnegative(),
    revision_after: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .passthrough();

export interface CommandReply extends z.infer<typeof commandReplySchema> {}

/** POST /v1/runs reply (W4-G routes/runs.ts, 201). */
export const runCreatedReplySchema = z
  .object({
    run_id: z.string().min(1),
    status: z.string(),
    credits_reserved: z.number().int().nonnegative(),
  })
  .passthrough();

export interface RunCreatedReply extends z.infer<typeof runCreatedReplySchema> {}

/** GET /v1/runs/:id view (W4-G runDetailToApi) — only the fields we render. */
export const runDetailSchema = z
  .object({
    run_id: z.string().min(1),
    status: z.string(),
    tier: z.string().optional(),
    revision_before: z.number().int().nullable().optional(),
    revision_after: z.number().int().nullable().optional(),
    error: z.unknown().nullable().optional(),
  })
  .passthrough();

export interface RunDetail extends z.infer<typeof runDetailSchema> {}

// ---------------------------------------------------------------------------
// Error text — §13.3 messages are user-safe by construction; anything else
// collapses so internals never leak (docs/AGENTS.md error rules).
// ---------------------------------------------------------------------------

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== "" && error.name === "ApiError") {
    return error.message;
  }
  return fallback;
}

/** Pulls a user-safe line out of `agent_runs.error`-shaped payloads. */
export function extractRunError(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }
  if (typeof error === "string") {
    return error === "" ? null : error;
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = record["message"];
    const code = record["code"];
    if (typeof message === "string" && message !== "") {
      return message;
    }
    if (typeof code === "string" && code !== "") {
      return code.replaceAll("_", " ");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer-tree helpers (pure, immutable)
// ---------------------------------------------------------------------------

/** One visible row of the flattened tree (groups keep their children nested). */
export interface FlatLayerRow {
  readonly node: LayerNode;
  /** 0 = top level. */
  readonly depth: number;
  readonly hasChildren: boolean;
}

/**
 * Depth-first flatten in array order (the engine's top-down order, §10.1).
 * Callers prune collapsed groups via `isExpanded`; the helper never hides.
 */
export function flattenLayerTree(
  layers: readonly LayerNode[],
  isExpanded: (id: string) => boolean = () => true,
): FlatLayerRow[] {
  const rows: FlatLayerRow[] = [];
  const walk = (nodes: readonly LayerNode[], depth: number): void => {
    for (const node of nodes) {
      const children = node.children ?? [];
      rows.push({ node, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && isExpanded(node.id)) {
        walk(children, depth + 1);
      }
    }
  };
  walk(layers, 0);
  return rows;
}

/** Finds a node by id anywhere in the tree. */
export function findLayer(
  layers: readonly LayerNode[],
  id: string,
): LayerNode | undefined {
  for (const node of layers) {
    if (node.id === id) {
      return node;
    }
    const hit = findLayer(node.children ?? [], id);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** Total node count (groups included). */
export function countLayers(layers: readonly LayerNode[]): number {
  return layers.reduce((total, node) => total + 1 + countLayers(node.children ?? []), 0);
}

/**
 * Immutably sets `visible` on the node with `id`. Untouched subtrees keep
 * their referential identity (React can skip re-rendering them); a miss
 * returns the input reference unchanged.
 */
export function setLayerVisible(
  layers: readonly LayerNode[],
  id: string,
  visible: boolean,
): readonly LayerNode[] {
  const visit = (nodes: readonly LayerNode[]): readonly LayerNode[] => {
    let changed = false;
    const next = nodes.map((node) => {
      if (node.id === id) {
        changed = true;
        return { ...node, visible };
      }
      if (node.children !== undefined) {
        const children = visit(node.children);
        if (children !== node.children) {
          changed = true;
          return { ...node, children };
        }
      }
      return node;
    });
    return changed ? next : nodes;
  };
  return visit(layers);
}

/**
 * The §13.1 manual command the visibility eye sends — `layer.setProps` with
 * the engine's `layer`/`visible` params (vendor control-protocol:
 * `layer.setProps {"layer":id?,"name":…,"visible":…,"opacity":0..1,"blend":…}`).
 * One surgical operation (§25-11 compact-command budget).
 */
export function visibilityCommand(
  layerId: string,
  visible: boolean,
): { command: "layer.setProps"; params: { layer: string; visible: boolean } } {
  return { command: "layer.setProps", params: { layer: layerId, visible } };
}

/** `GET /v1/documents/:id/preview?w=…` path builder (§13.1 default width 1024). */
export function previewPath(documentId: string, width = 1_024): string {
  return `/documents/${encodeURIComponent(documentId)}/preview?w=${width}`;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Icon bucket for a layer kind string; unknown kinds degrade to `pixel`. */
export type LayerKindKey =
  | "group"
  | "text"
  | "photo"
  | "vector"
  | "adjustment"
  | "component"
  | "fill"
  | "pixel";

export function normalizeLayerKind(kind: string): LayerKindKey {
  const value = kind.toLowerCase();
  if (value.includes("group")) return "group";
  if (value.includes("text") || value.includes("type")) return "text";
  if (value.includes("smart") || value.includes("photo") || value.includes("image")) {
    return "photo";
  }
  if (value.includes("adjust")) return "adjustment";
  if (value.includes("component") || value.includes("instance")) return "component";
  if (value.includes("vector") || value.includes("shape")) return "vector";
  if (value.includes("fill") || value.includes("gradient") || value.includes("solid")) {
    return "fill";
  }
  return "pixel";
}

/** `12, 0 · 1080×1350` for a bounds tuple; null when the engine has no bounds. */
export function formatBounds(
  bounds: readonly [number, number, number, number] | null | undefined,
): string | null {
  if (bounds === null || bounds === undefined) {
    return null;
  }
  const [x, y, w, h] = bounds;
  const rounded = [x, y, w, h].map((value) => Math.round(value * 100) / 100);
  return `${rounded[0]}, ${rounded[1]} · ${rounded[2]}×${rounded[3]}`;
}

/** Percent for opacity 0..1; absent (bare `layer.list` rows) reads as 100%. */
export function formatOpacity(opacity: number | null | undefined): string {
  if (opacity === null || opacity === undefined) {
    return "100%";
  }
  return `${Math.round(opacity * 100)}%`;
}

/**
 * Scale that fits a `docW × docH` document inside a `viewportW × viewportH`
 * stage, capped at 1 (never above 100% — previews exist to judge, not blow up).
 * Degenerate dimensions answer 0 so callers can hide the label.
 */
export function fitScale(
  viewportW: number,
  viewportH: number,
  docW: number,
  docH: number,
): number {
  if (viewportW <= 0 || viewportH <= 0 || docW <= 0 || docH <= 0) {
    return 0;
  }
  const raw = Math.min(viewportW / docW, viewportH / docH);
  return Math.min(raw, 1);
}

// ---------------------------------------------------------------------------
// Chat-edit message model (§23.5/§24.2) — plain immutable builders so the
// panel holds zero logic beyond wiring them to state.
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant";

export type ChatMessageKind = "text" | "run" | "notice";

/** Inline mini-run status the assistant bubble renders (§13.1 GET /v1/runs/:id). */
export interface MiniRunState {
  readonly runId: string | null;
  readonly prompt: string;
  readonly status: string;
  readonly creditsReserved: number;
  readonly revisionAfter: number | null;
  readonly error: string | null;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly kind: ChatMessageKind;
  readonly text: string;
  readonly run?: MiniRunState;
}

export function makeTextMessage(id: string, role: ChatRole, text: string): ChatMessage {
  return { id, role, kind: "text", text };
}

export function makeNoticeMessage(id: string, text: string): ChatMessage {
  return { id, role: "assistant", kind: "notice", text };
}

/** The assistant "run card" bubble created the moment a quick run is posted. */
export function makeRunMessage(id: string, prompt: string, credits: number): ChatMessage {
  return {
    id,
    role: "assistant",
    kind: "run",
    text: "",
    run: {
      runId: null,
      prompt,
      status: "queued",
      creditsReserved: credits,
      revisionAfter: null,
      error: null,
    },
  };
}

/**
 * Immutably patches ONE run message, searching newest-first:
 * - `patch.runId === undefined` → the newest run card, whatever its run id;
 * - `patch.runId` set → the newest card already assigned to that run, or —
 *   because the panel keeps at most one in-flight (unassigned) card and it is
 *   always the newest (the composer disables while a run is active) — the
 *   newest unassigned card, which the patch claims (§24.2 poll loop).
 * A patch naming runs nobody holds changes nothing (input reference returned).
 */
export function updateRunMessage(
  messages: readonly ChatMessage[],
  patch: Partial<MiniRunState>,
): readonly ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind !== "run" || message.run === undefined) {
      continue;
    }
    if (
      patch.runId !== undefined &&
      message.run.runId !== null &&
      message.run.runId !== patch.runId
    ) {
      continue; // a named card belonging to another run
    }
    const nextMessages = [...messages];
    nextMessages[index] = {
      ...message,
      run: { ...message.run, ...patch, runId: message.run.runId ?? patch.runId ?? null },
    };
    return nextMessages;
  }
  return messages;
}
