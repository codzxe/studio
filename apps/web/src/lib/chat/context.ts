/**
 * Chat context collector — Seam 5 of docs/phases/M4-SEAMS.md
 * (EDITOR_CHAT_UX §5 "Context model", PRODUCT_ARCHITECTURE §8.3 "Context assembly").
 *
 * Bridges live editor state into a deterministic `ContextSnapshot`: one
 * `ContextBlock` per enabled `ContextSelection` flag, each with a token
 * estimate, plus the user's pinned chips. This module decides WHAT is in the
 * context (and what the Context popover renders); the tool executor
 * (M4-C2) and the model request handle SENDING it — `block.data` is never
 * transmitted by this module.
 *
 * Bridge calls (read-only queries; param names verified against BOTH
 * editor/crates/engine/src/commands/query.rs AND the fake registry in
 * packages/editor-bridge/src/fake.ts):
 *   project.summary     {}                              — no params
 *   comp.info           { comp? }                        — comp id or name; default the active comp
 *   layer.tree          { layer?, comp?, depth?, time? } — layer id; default the first selected
 *   prop.get            { layer?, path }                 — `path` required (alias `prop`); layer default selected
 *   edit.history.list   {}                              — { states, current, branches }
 *
 * Degradation doctrine (mirrors M3's missingAssets rule): a failed bridge call
 * never throws and never breaks chat — the block gets `data: undefined` and an
 * " (unavailable)" label suffix; a missing layer/property inside a
 * selection-derived block is a per-item `null`. `block.data` is verbatim
 * project state and UNTRUSTED: display + transport only, never executed,
 * never interpolated into anything executable (prompt assembly is server-side).
 */

import type { EditorBridge } from "@studio/editor-bridge";
import type { ContextSelection, PinnedContextItem } from "@studio/contracts";
import { estimateTokens } from "./tokens";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One auto-context block (§5.1/§5.3). Chips render `label` + `tokenEstimate`
 * only; `data` is the verbatim structured snapshot the executor/request sends.
 */
export interface ContextBlock {
  /** Which `ContextSelection` flag produced this block. */
  kind: keyof ContextSelection;
  /** Chip label, e.g. "Comp: Main" or "Project summary (unavailable)". */
  label: string;
  /** `estimateTokens(data)`; blocks without data estimate 0. */
  tokenEstimate: number;
  /** Verbatim editor state for the block; `undefined` when unavailable. */
  data?: unknown;
}

/** `layer.tree` results for the selected layers (null where a layer could not be read). */
export interface SelectionBlockData {
  readonly layers: readonly (unknown | null)[];
  /** True when more layers were selected than were read (cost cap). */
  readonly truncated?: boolean;
}

/** `prop.get` results for the first selected layer (null where a property is missing). */
export interface SelectedPropertiesBlockData {
  /** The layer id the properties were read from. */
  readonly layer: number;
  /** One entry per candidate path, in query order. */
  readonly properties: ReadonlyArray<{ readonly path: string; readonly value: unknown | null }>;
}

/** Everything the Context popover shows and the chat request carries. */
export interface ContextSnapshot {
  /** The flags the snapshot was collected with (echoed verbatim). */
  flags: ContextSelection;
  /** Present blocks in `ContextSelection` key order; off flags are absent. */
  blocks: ContextBlock[];
  /** The user's pinned chips (§5.2), echoed verbatim. */
  pinned: PinnedContextItem[];
  /** Sum of block estimates + pinned chip estimates. */
  totalTokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * §5.1 defaults: the "Always" blocks (project summary, active composition,
 * playhead, focused panel) are on; everything else is off until a selection
 * exists or the user opts in.
 */
export const DEFAULT_FLAGS: ContextSelection = {
  projectSummary: true, // §5.1 Always
  activeComp: true, // §5.1 Always
  selection: false, // §5.1 When selection exists
  playhead: true, // §5.1 Always
  focusedPanel: true, // §5.1 Always
  selectedProperties: false, // §5.1 When selection exists (≤ 12 props)
  currentFrame: false, // §5.1 When the prompt is visual (rendered on demand)
  recentCommands: false, // §5.1 When relevant (last 10)
  comments: false, // §5.1 When the prompt mentions feedback (gateway API)
};

/**
 * Auto flags per §5.1 "When selection exists": `selection` and
 * `selectedProperties` switch on when a selection is present; the defaults
 * stay untouched otherwise. Accepts the structural `selectedLayers` field of
 * `bridge.inspect()` (a null/failed inspect simply means "no selection").
 */
export function autoFlags(
  inspect: { readonly selectedLayers?: readonly number[] | null } | null,
): ContextSelection {
  const hasSelection = (inspect?.selectedLayers?.length ?? 0) > 0;
  return { ...DEFAULT_FLAGS, selection: hasSelection, selectedProperties: hasSelection };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * mm:ss.d timecode label for a comp-seconds value (e.g. 65.06 → "01:05.1").
 * `ui.inspect` carries raw seconds (`control.rs` inspect: `"time": seconds`),
 * so the collector formats its own label; null/undefined/negative/non-finite
 * degrade to "00:00.0" (a chip always shows a value, and never throws).
 */
export function timecodeLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "00:00.0";
  }
  const deciseconds = Math.round(seconds * 10);
  const minutes = Math.floor(deciseconds / 600);
  const rest = deciseconds % 600;
  const whole = Math.floor(rest / 10);
  const frac = rest % 10;
  return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${frac}`;
}

/**
 * Comments come from the gateway API (§5.1 "GET /comments"), not the bridge —
 * this module only reserves the block; M4-J wires the real fetch. `data` stays
 * undefined so the chip renders and the flag is accounted for.
 */
export function commentsBlockPlaceholder(): ContextBlock {
  return { kind: "comments", label: "Comments", tokenEstimate: 0 };
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/** Budgets (§5.1/§8.3): depth-2 trees, ≤ 12 property reads, last 10 history entries. */
const SELECTION_TREE_DEPTH = 2;
const MAX_SELECTION_LAYERS = 8;
const MAX_PROPERTY_CALLS = 12;
const MAX_RECENT_COMMANDS = 10;
/** Bridge calls per selection-derived batch run in waves of at most 4. */
const QUERY_CONCURRENCY = 4;

/** Candidate property paths for the selected layer (transform/opacity/text essentials). */
const SELECTED_PROPERTY_PATHS = [
  "transform/anchor",
  "transform/position",
  "transform/scale",
  "transform/rotation",
  "transform/opacity",
  "text/sourceText",
] as const;

const UNAVAILABLE = " (unavailable)";

type BlockKind = keyof ContextSelection;

/**
 * Collect the editor snapshot for one chat request (Seam 5). Every enabled
 * flag contributes at most one block, in `ContextSelection` key order; every
 * bridge failure degrades to an " (unavailable)" block (or per-item nulls
 * inside selection-derived blocks) and the snapshot always resolves.
 */
export async function collectContextSnapshot(
  bridge: EditorBridge,
  opts: { flags: ContextSelection; pinned?: PinnedContextItem[] },
): Promise<ContextSnapshot> {
  // Runtime-tolerant normalization: partial/garbage inputs still behave.
  const flags: ContextSelection = { ...DEFAULT_FLAGS, ...opts.flags };
  const pinned: PinnedContextItem[] = Array.isArray(opts.pinned) ? opts.pinned : [];
  try {
    return await collect(bridge, flags, pinned);
  } catch {
    // Last-resort guard for the "missing context never breaks chat" contract
    // (unreachable through the safe helpers below; keeps a buggy bridge shape
    // from ever rejecting a chat send).
    const blocks: ContextBlock[] = [];
    const pinnedTotal = pinned.reduce((sum, item) => sum + estimateTokens(item), 0);
    return { flags, blocks, pinned, totalTokenEstimate: pinnedTotal };
  }
}

async function collect(
  bridge: EditorBridge,
  flags: ContextSelection,
  pinned: PinnedContextItem[],
): Promise<ContextSnapshot> {
  const blocks: ContextBlock[] = [];

  // One shared inspect feeds the ui-derived blocks (§5.1: "ui.inspect").
  const inspect = await safeInspect(bridge);
  const selected = inspect?.selectedLayers ?? [];
  const firstSelected = selected[0];

  if (flags.projectSummary) {
    const summary = await safeQuery(bridge, "project.summary");
    blocks.push(
      summary === null
        ? unavailable("projectSummary", "Project summary")
        : block("projectSummary", "Project summary", summary),
    );
  }

  if (flags.activeComp) {
    const comp = typeof inspect?.activeComp === "number" ? inspect.activeComp : undefined;
    const info = await safeQuery(bridge, "comp.info", comp === undefined ? {} : { comp });
    const name = nameOf(info);
    blocks.push(
      info === null
        ? unavailable("activeComp", "Comp")
        : block("activeComp", name ? `Comp: ${name}` : "Comp", info),
    );
  }

  if (flags.selection) {
    if (inspect === null) {
      blocks.push(unavailable("selection", "Selection"));
    } else if (selected.length > 0) {
      const ids = selected.slice(0, MAX_SELECTION_LAYERS);
      const layers = await mapLimit(ids, QUERY_CONCURRENCY, (layer) =>
        safeQuery(bridge, "layer.tree", layerTreeParams(layer, inspect.activeComp)),
      );
      if (layers.every((node) => node === null)) {
        blocks.push(unavailable("selection", "Selection"));
      } else {
        const names = layers
          .map((node) => nameOf(node))
          .filter((name): name is string => name !== undefined);
        const data: SelectionBlockData =
          selected.length > ids.length ? { layers, truncated: true } : { layers };
        blocks.push(block("selection", `Selection: ${names.join(", ")}`, data));
      }
    }
    // No selection → no block (§5.1 "when a selection exists").
  }

  if (flags.selectedProperties) {
    if (inspect === null) {
      blocks.push(unavailable("selectedProperties", "Selected properties"));
    } else if (firstSelected !== undefined) {
      const paths = SELECTED_PROPERTY_PATHS.slice(0, MAX_PROPERTY_CALLS);
      const values = await mapLimit(paths, QUERY_CONCURRENCY, (path) =>
        safeQuery(bridge, "prop.get", { layer: firstSelected, path }),
      );
      if (values.every((value) => value === null)) {
        blocks.push(unavailable("selectedProperties", "Selected properties"));
      } else {
        const data: SelectedPropertiesBlockData = {
          layer: firstSelected,
          properties: paths.map((path, i) => ({ path, value: values[i] })),
        };
        blocks.push(block("selectedProperties", "Selected properties", data));
      }
    }
    // No selection → no block (reads the FIRST selected layer only, §5.1).
  }

  if (flags.playhead) {
    blocks.push(
      inspect === null
        ? unavailable("playhead", "Playhead")
        : block("playhead", `Playhead ${timecodeLabel(inspect.time)}`, {
            time: inspect.time,
            playing: inspect.playing,
          }),
    );
  }

  if (flags.focusedPanel) {
    blocks.push(
      inspect === null
        ? unavailable("focusedPanel", "Panel")
        : block("focusedPanel", `Panel: ${inspect.focusedPanel ?? "unknown"}`, {
            panel: inspect.focusedPanel ?? null,
          }),
    );
  }

  if (flags.currentFrame) {
    // The frame is rendered on demand by the tool executor (render.frame 1200
    // px, §8.3) — here the flag only controls whether the chip exists.
    blocks.push({ kind: "currentFrame", label: "Frame preview", tokenEstimate: 0 });
  }

  if (flags.recentCommands) {
    const history = await safeQuery(bridge, "edit.history.list");
    blocks.push(
      history === null
        ? unavailable("recentCommands", "Recent commands")
        : block("recentCommands", "Recent commands", lastEntries(history, MAX_RECENT_COMMANDS)),
    );
  }

  if (flags.comments) {
    blocks.push(commentsBlockPlaceholder());
  }

  const blockTotal = blocks.reduce((sum, b) => sum + b.tokenEstimate, 0);
  const pinnedTotal = pinned.reduce((sum, item) => sum + estimateTokens(item), 0);
  return { flags, blocks, pinned, totalTokenEstimate: blockTotal + pinnedTotal };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function block(kind: BlockKind, label: string, data: unknown): ContextBlock {
  return { kind, label, tokenEstimate: estimateTokens(data), data };
}

function unavailable(kind: BlockKind, base: string): ContextBlock {
  return { kind, label: `${base}${UNAVAILABLE}`, tokenEstimate: 0 };
}

/** layer.tree params per the query.rs/fake.ts registry; comp is omitted when unknown so the engine defaults to its active comp. */
function layerTreeParams(layer: number, activeComp: number | null | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = { layer, depth: SELECTION_TREE_DEPTH };
  if (typeof activeComp === "number") params.comp = activeComp;
  return params;
}

/** Last `max` `edit.history.list` states, keeping the rest of the result verbatim. */
function lastEntries(history: unknown, max: number): unknown {
  if (isRecord(history) && Array.isArray(history.states)) {
    return { ...history, states: history.states.slice(-max) };
  }
  return history; // unexpected shape: pass through verbatim rather than guess
}

async function safeInspect(bridge: EditorBridge): Promise<Awaited<ReturnType<EditorBridge["inspect"]>> | null> {
  try {
    return await bridge.inspect();
  } catch {
    return null;
  }
}

async function safeQuery<T>(bridge: EditorBridge, command: string, params?: unknown): Promise<T | null> {
  try {
    return await bridge.query<T>(command, params ?? {});
  } catch {
    return null;
  }
}

function nameOf(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.name === "string" && value.name.length > 0) return value.name;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `map` with bounded concurrency, order-preserving. `fn` is expected never to
 * reject (callers wrap their bridge calls); `limit` is clamped to `[1, n]`.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item !== undefined) results[i] = await fn(item, i);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker);
  await Promise.all(workers);
  return results;
}
