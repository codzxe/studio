/**
 * reveal-applied tests — the post-apply canvas reveal (comp.open +
 * time.set + ui.playback, best-effort quiet). Pins:
 *
 *   1. a comp.new batch reveals the NEW comp by name, seeks to the batch's
 *      first named time, and presses play;
 *   2. a batch without comp.new falls back to the session's active comp;
 *   3. a batch that names no time keeps the playhead (no time.set);
 *   4. every arm fails QUIET — a comp.open failure still plays; a playback
 *      failure never throws;
 *   5. order: reveal BEFORE playback (the viewer must show the comp when
 *      play lands).
 */
import { describe, expect, it } from "vitest";

import type { AgentBatch } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";

import { revealAppliedPlan } from "./reveal-applied";

interface RecordedCall {
  readonly kind: "execute" | "request";
  readonly command: string;
  readonly params: unknown;
}

/** Scripted bridge fake: records execute + request calls; inspect() returns activeComp. */
function fakeBridge(options?: { readonly activeComp?: number; readonly failOn?: string }) {
  const calls: RecordedCall[] = [];
  const bridge = {
    execute: async (command: string, params?: unknown): Promise<unknown> => {
      if (options?.failOn === command) throw new Error("bridge boom");
      calls.push({ kind: "execute", command, params });
      return { ok: true };
    },
    request: async (method: string, params?: unknown): Promise<unknown> => {
      if (options?.failOn === method) throw new Error("bridge boom");
      calls.push({ kind: "request", command: method, params });
      return { playing: true, time: 0 };
    },
    inspect: async (): Promise<unknown> => ({ activeComp: options?.activeComp ?? 7 }),
  };
  return { calls, bridge: bridge as unknown as EditorBridge };
}

const COMPOSE_BATCH: AgentBatch = {
  label: "Agent: neon intro",
  atomic: true,
  steps: [
    {
      command: "comp.new",
      params: { name: "Neon Typography", width: 1920, height: 1080, frameRate: 30 },
    },
    {
      command: "keyframe.add",
      params: { layer: "Neon Text", path: "transform/opacity", timeSeconds: 2.5, value: 1 },
    },
  ],
};

describe("revealAppliedPlan", () => {
  it("reveals the new comp by name, seeks to the first named time, and plays", async () => {
    const { bridge, calls } = fakeBridge();
    await revealAppliedPlan(bridge, COMPOSE_BATCH);
    // TRANSPORT PIN: comp.open + time.set ride engine.execute; ui.playback
    // rides the RAW control channel (through engine.execute it no-ops).
    expect(calls).toEqual([
      { kind: "execute", command: "comp.open", params: { comp: "Neon Typography" } },
      { kind: "execute", command: "time.set", params: { time: 2.5 } },
      { kind: "request", command: "ui.playback", params: { action: "play" } },
    ]);
  });

  it("falls back to the session's active comp when the batch creates none", async () => {
    const { bridge, calls } = fakeBridge({ activeComp: 7 });
    await revealAppliedPlan(bridge, {
      label: "Agent: retitle",
      atomic: true,
      steps: [{ command: "layer.set_text", params: { layer: "Headline", text: "New" } }],
    });
    expect(calls[0]).toEqual({ kind: "execute", command: "comp.open", params: { comp: 7 } });
    expect(calls[calls.length - 1]).toEqual({
      kind: "request",
      command: "ui.playback",
      params: { action: "play" },
    });
  });

  it("keeps the playhead when the batch names no time (no time.set)", async () => {
    const { bridge, calls } = fakeBridge({ activeComp: 2 });
    await revealAppliedPlan(bridge, {
      label: "Agent: retitle",
      atomic: true,
      steps: [{ command: "layer.set_text", params: { layer: "Headline", text: "New" } }],
    });
    expect(calls.some((call) => call.command === "time.set")).toBe(false);
    expect(calls.some((call) => call.command === "ui.playback")).toBe(true);
  });

  it("fails quiet: a comp.open failure still presses play, never throws", async () => {
    const { bridge, calls } = fakeBridge({ activeComp: 5, failOn: "comp.open" });
    await expect(revealAppliedPlan(bridge, COMPOSE_BATCH)).resolves.toBeUndefined();
    expect(calls).toEqual([{ kind: "request", command: "ui.playback", params: { action: "play" } }]);
  });

  it("fails quiet: a ui.playback failure resolves without throwing", async () => {
    const { bridge, calls } = fakeBridge({ failOn: "ui.playback" });
    await expect(revealAppliedPlan(bridge, COMPOSE_BATCH)).resolves.toBeUndefined();
    expect(calls.map((call) => call.command)).toEqual(["comp.open", "time.set"]);
  });
});
