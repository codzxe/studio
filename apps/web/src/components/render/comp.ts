// @studio/web — the live-comp collector for the render dialog (BUILD_PLAN
// §M8 task 2). ONE read-only bridge query: `comp.info` (engine query.rs —
// `{id, name, width, height, frameRate, duration, workArea: [from, to]}`),
// which resolves the ACTIVE composition when `{}` is passed. Reads pass the
// M7-G read-only gate (D-23), so the render dialog prefills even while
// another member holds the edit lease — queueing captures the pinned version
// server-side; it is not an engine mutation.
//
// Failure semantics: NEVER throws. A bridge-less mount (no chat layer, tests)
// or a project with no comp open resolves `null` and the dialog explains.

import type { RenderBridgeSource, RenderComp } from "./types";

/** The narrow `comp.info` wire shape this collector reads (bridge types stay loose). */
interface CompInfoWire {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly frameRate?: unknown;
  readonly duration?: unknown;
  readonly workArea?: unknown;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalName(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Collects the ACTIVE composition for the render dialog. `null` when no
 * bridge is mounted, the handshake is down, or no comp is open. The wire
 * `compId` is the comp NAME (falling back to the raw numeric id) — the
 * presence-beat precedent; the worker resolves comps by name.
 */
export async function collectRenderComp(
  bridge: RenderBridgeSource | null,
): Promise<RenderComp | null> {
  if (bridge === null) return null;
  try {
    const info = await bridge.query<CompInfoWire>("comp.info", {});
    const compName = optionalName(info.name);
    if (compName === null) return null;
    let workFrom: number | null = null;
    let workTo: number | null = null;
    if (Array.isArray(info.workArea) && info.workArea.length >= 2) {
      workFrom = optionalNumber(info.workArea[0]);
      workTo = optionalNumber(info.workArea[1]);
    }
    return {
      compId: compName,
      compName,
      width: optionalNumber(info.width),
      height: optionalNumber(info.height),
      frameRate: optionalNumber(info.frameRate),
      durationSeconds: optionalNumber(info.duration),
      workFrom,
      workTo,
    };
  } catch {
    // No comp open / bridge down: the dialog explains, nothing throws.
    return null;
  }
}
