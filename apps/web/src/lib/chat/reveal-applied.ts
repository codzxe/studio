/**
 * POST-APPLY CANVAS REVEAL — the "make it visible" seam.
 *
 * The apply pipeline mutates the engine through ONE `engine.batch`; the
 * engine then repaints exactly ONE still frame at whatever playhead the
 * session was left at — for a freshly created composition that is t=0,
 * where an animation plan frequently shows nothing. The engine state
 * changed; the pixels did not: the run looks dead even though it worked.
 *
 * `revealAppliedPlan` closes that gap with three VIEW-STATE commands
 * (never undo steps — comp open/times/playback are session view state,
 * the same class as the plan card's manual "View in timeline" button,
 * message.tsx's revealPlanInTimeline, whose comp.open arm this mirrors):
 *
 *   1. `comp.open`   — the batch's new composition by name, else the
 *                      session's active comp (the viewer shows the work);
 *   2. `time.set`    — the batch's first named time (preview.ts's curated
 *                      scanner, batch arm). No time named → keep playhead;
 *   3. `ui.playback` — `{action:"play"}` via the RAW control channel:
 *                      PLAY the result on the canvas.
 *
 * TRANSPORT PIN (verified live on the SwiftShader engine): `comp.open` and
 * `time.set` ride the `engine.execute` envelope (`bridge.execute`), but
 * `ui.playback` is a UI CONTROL method — through `engine.execute` it
 * silently no-ops; only the raw `bridge.request("ui.playback", …)` starts
 * playback.
 * Best-effort by contract: every arm fails quiet — the reveal is a
 * convenience, never a gate, and it never mutates project data (no undo
 * step, no version, no save).
 */

import type { AgentBatch } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";

import { firstAffectedTimeTicksOfBatch, ticksToSeconds } from "./preview";

export async function revealAppliedPlan(
  bridge: EditorBridge,
  batch: AgentBatch,
): Promise<void> {
  // 1+2. Reveal: the affected comp at the plan's first named time (the
  // exact moves of the plan card's manual reveal, driven by the apply flow).
  try {
    const newCompName = batch.steps.find(
      (step) =>
        step.command === "comp.new" &&
        typeof step.params?.name === "string" &&
        (step.params.name as string).length > 0,
    )?.params?.name as string | undefined;
    if (newCompName !== undefined) {
      await bridge.execute("comp.open", { comp: newCompName });
    } else {
      const inspect = await bridge.inspect();
      if (typeof inspect.activeComp === "number") {
        await bridge.execute("comp.open", { comp: inspect.activeComp });
      }
    }
    const ticks = firstAffectedTimeTicksOfBatch(batch);
    if (ticks !== null) {
      await bridge.execute("time.set", { time: ticksToSeconds(ticks) });
    }
  } catch {
    // Quiet best-effort: a failed reveal never disturbs the applied state.
  }
  // 3. Playback: a seek only matters if time MOVES — press play so the
  // applied animation runs on the canvas without a second user click.
  // RAW control channel (bridge.request): through the engine.execute
  // envelope ui.playback silently no-ops (live-verified w9).
  try {
    await bridge.request("ui.playback", { action: "play" });
  } catch {
    // Quiet best-effort (older engines without ui.playback stay silent).
  }
}
