/**
 * Comment anchor seam (M7-F) — the bridge `ui.inspect` slice that prefills
 * the create box and names the rows (BUILD_PLAN §M7 task 1 "Anchor to
 * project/comp/layer/time"; PRODUCT_ARCHITECTURE §6.2/§8.3).
 *
 * It REUSES the chat context collector's exact recipe (lib/chat/context.ts):
 * one `bridge.inspect()` for activeComp/selection/time, then `comp.info` /
 * `layer.tree` for names — same read-only queries, same degradation doctrine
 * (a failed bridge call never throws and never breaks the panel; anchors just
 * lose their friendly names). Time rides the comments wire as ENGINE TICKS
 * (254 016 000 000/s — editor/crates/time/src/lib.rs, the same clock
 * lib/chat/preview.ts converts with), so `secondsToTicks` is reused verbatim.
 *
 * ANCHOR ID CONVENTION (pinned for every M7 comments surface): the wire's
 * `compId`/`layerId` are opaque non-empty strings (contracts ID_SCHEMA; the
 * repo never validates them against a table). The EDITOR surface defines
 * them as the engine's numeric comp/layer id in canonical string form
 * (`String(comp.info().id)`), which is what a future share player reading the
 * same `.ecproj` derives too — both surfaces stay comparable server-side.
 *
 * Everything the bridge returns is UNTRUSTED DATA: comp/layer names render
 * as text (React-escaped), never interpolate into anything executable, and
 * never become UI copy (PRODUCT_ARCHITECTURE §8.3; the M4-N corpus proves it).
 */

import { TICKS_PER_SECOND, secondsToTicks } from "@/lib/chat/preview";
import type { EditorBridge } from "@studio/editor-bridge";
import type { AnchorNames, CompOption } from "./types";

/** The prefilled anchor the create box ships with (current editor context). */
export interface CommentAnchorPrefill {
  /** Engine comp id, canonical string form (the wire's `compId`). */
  readonly compId: string;
  /** Comp display name (null when the bridge could not read it). */
  readonly compName: string | null;
  /** First selected layer id, canonical string form; null with no selection. */
  readonly layerId: string | null;
  /** Layer display name (null when unreadable / nothing selected). */
  readonly layerName: string | null;
  /** Playhead in engine ticks (null when the bridge read failed). */
  readonly timeTicks: number | null;
}

// ---------------------------------------------------------------------------
// Time formatting (ticks → mm:ss)
// ---------------------------------------------------------------------------

/**
 * Engine ticks → `mm:ss` (whole seconds, floor). The rows show review
 * timecodes, not frame precision; null/negative/unsafe input degrades to
 * null (no chip — a chip never shows a fake value).
 */
export function formatTimeTicks(ticks: number | null | undefined): string | null {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return null;
  const seconds = Math.floor(ticks / TICKS_PER_SECOND);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Bridge helpers (the context-collector doctrine: never throw)
// ---------------------------------------------------------------------------

async function safeInspect(
  bridge: EditorBridge,
): Promise<Awaited<ReturnType<EditorBridge["inspect"]>> | null> {
  try {
    return await bridge.inspect();
  } catch {
    return null;
  }
}

async function safeQuery<T>(
  bridge: EditorBridge,
  command: string,
  params?: unknown,
): Promise<T | null> {
  try {
    return await bridge.query<T>(command, params ?? {});
  } catch {
    return null;
  }
}

function nameOf(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { name: string }).name.length > 0
  ) {
    return (value as { name: string }).name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anchor collection (create-box prefill)
// ---------------------------------------------------------------------------

/**
 * The current editor context as one comment anchor: active comp, first
 * selected layer, playhead. Degrades to `null` when no comp is open (the
 * create box explains instead of guessing); partial failures keep the parts
 * that did read (comp known, name unknown → the wire still anchors).
 */
export async function collectCommentAnchor(
  bridge: EditorBridge,
): Promise<CommentAnchorPrefill | null> {
  const inspect = await safeInspect(bridge);
  if (inspect === null) return null;
  const activeComp = typeof inspect.activeComp === "number" ? inspect.activeComp : null;
  if (activeComp === null) return null;

  const compInfo = await safeQuery<unknown>(bridge, "comp.info", { comp: activeComp });
  const compId = String(activeComp);
  const compName = compInfo === null ? null : nameOf(compInfo);

  const firstSelected = inspect.selectedLayers.find((id) => typeof id === "number");
  const layerInfo =
    firstSelected === undefined
      ? null
      : await safeQuery<unknown>(bridge, "layer.tree", {
          layer: firstSelected,
          comp: activeComp,
        });
  const layerId = firstSelected === undefined ? null : String(firstSelected);
  const layerName = layerInfo === null ? null : nameOf(layerInfo);

  return {
    compId,
    compName,
    layerId,
    layerName,
    timeTicks: secondsToTicks(inspect.time),
  };
}

// ---------------------------------------------------------------------------
// Names + comp options (filter + row chips)
// ---------------------------------------------------------------------------

/** Walk bound: comps read per names pass (keeps a panel open fast, §11). */
const MAX_NAMED_COMPS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Comp/layer display names from the live project: `project.summary` for the
 * comps, `comp.info` per comp for its layers. Any failure shrinks the map —
 * rows fall back to the raw anchor id chip, never break.
 */
export async function collectAnchorNames(bridge: EditorBridge): Promise<AnchorNames> {
  const comps = new Map<string, string>();
  const layers = new Map<string, string>();
  const summary = await safeQuery<unknown>(bridge, "project.summary");
  const items = isRecord(summary) && Array.isArray(summary.items) ? summary.items : [];
  for (const item of items.slice(0, MAX_NAMED_COMPS)) {
    const id = isRecord(item) ? item.id : undefined;
    const name = nameOf(item);
    if (typeof id === "number" && name !== null) comps.set(String(id), name);
    const info = await safeQuery<unknown>(bridge, "comp.info", { comp: id });
    const compLayers = isRecord(info) && Array.isArray(info.layers) ? info.layers : [];
    for (const layer of compLayers) {
      const layerId = isRecord(layer) ? layer.id : undefined;
      const layerName = nameOf(layer);
      if (typeof layerId === "number" && layerName !== null) {
        layers.set(String(layerId), layerName);
      }
    }
  }
  return { comps, layers };
}

/** The comp-filter options: every comp the live project reports, wire order. */
export async function listCompOptions(bridge: EditorBridge): Promise<CompOption[]> {
  const summary = await safeQuery<unknown>(bridge, "project.summary");
  const items = isRecord(summary) && Array.isArray(summary.items) ? summary.items : [];
  const options: CompOption[] = [];
  for (const item of items) {
    const id = isRecord(item) ? item.id : undefined;
    const name = nameOf(item);
    if (typeof id === "number") {
      options.push({ id: String(id), name: name ?? `Comp ${id}` });
    }
  }
  return options;
}
