/**
 * tool-executor tests (M4-SEAMS.md seam 6 + M5 write-tool proposals) —
 * deterministic, no network: a fake editor via `@studio/editor-bridge/fake` +
 * a stubbed ApiClient that records every `runs.postEvent` attempt. Covers the
 * 4 client tools' happy paths, the posted RUN_EVENT_REQUEST shape,
 * validation/forbidden/server-tool gates, per-item degradation, flags
 * filtering, the toolCallId guard, post retries, the whole-call timeout guard
 * — and the M5 slice: the 8 write tools PROPOSE (never execute; the only
 * bridge traffic is read-only live-state validation) and the RAW engine
 * surface as a tool name stays TOOL_FORBIDDEN (law #6 backstop).
 */

import { type ApiClient, ApiError } from "@studio/api-client";
import type { ContextSelection } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import {
  FAKE_PNG_BASE64,
  type FakeEditor,
  attachFakeBridge,
  createFakeEditor,
} from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";

import {
  type ClientToolCall,
  type ToolExecutorDeps,
  createToolExecutor,
  executeClientTool,
} from "./tool-executor";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RecordedBridgeCalls {
  inspect: number;
  queries: Array<{ command: string; params: unknown }>;
  renderFrames: Array<Record<string, unknown>>;
}

/** Wraps a bridge so every inspect/query/renderFrame call is recorded. */
function recordBridge(bridge: EditorBridge): { bridge: EditorBridge; calls: RecordedBridgeCalls } {
  const calls: RecordedBridgeCalls = { inspect: 0, queries: [], renderFrames: [] };
  const wrapped: EditorBridge = {
    ...bridge,
    inspect: async () => {
      calls.inspect += 1;
      return bridge.inspect();
    },
    query: <T>(command: string, params?: unknown) => {
      calls.queries.push({ command, params: params ?? {} });
      return bridge.query<T>(command, params);
    },
    renderFrame: (params) => {
      calls.renderFrames.push(params as Record<string, unknown>);
      return bridge.renderFrame(params);
    },
  };
  return { bridge: wrapped, calls };
}

interface StubClientOptions {
  /** Fail the first N postEvent attempts (transient by default). */
  failTimes?: number;
  /** ApiError status for the injected failures (0 = network, 400 = permanent). */
  failureStatus?: number;
}

interface PostedEvent {
  runId: string;
  body: Record<string, unknown>;
  idempotencyKey: string | undefined;
}

function makeStubClient(opts: StubClientOptions = {}) {
  const events: PostedEvent[] = [];
  const attempts: Array<string | undefined> = [];
  let postCalls = 0;
  const client = {
    runs: {
      postEvent: async (runId: string, body: unknown, options?: { idempotencyKey?: string }) => {
        postCalls += 1;
        attempts.push(options?.idempotencyKey);
        if (opts.failTimes !== undefined && postCalls <= opts.failTimes) {
          throw new ApiError({
            code:
              opts.failureStatus === 0 || opts.failureStatus === undefined
                ? "NETWORK_ERROR"
                : "VALIDATION_FAILED",
            message: "injected failure",
            status: opts.failureStatus ?? 0,
            retryable: (opts.failureStatus ?? 0) === 0,
          });
        }
        events.push({
          runId,
          body: body as Record<string, unknown>,
          idempotencyKey: options?.idempotencyKey,
        });
        return null;
      },
    },
  } as unknown as ApiClient;
  return { client, events, attempts, postCalls: () => postCalls };
}

const ALL_TRUE_FLAGS: ContextSelection = {
  projectSummary: true,
  activeComp: true,
  selection: true,
  playhead: true,
  focusedPanel: true,
  selectedProperties: true,
  currentFrame: false,
  recentCommands: true,
  comments: false,
};

interface WorldOptions {
  failOn?: Readonly<Record<string, string>>;
  flags?: Partial<ContextSelection>;
  clientOpts?: StubClientOptions;
  guardTimeoutMs?: number;
  hang?: boolean;
}

interface World {
  fake: FakeEditor;
  deps: ToolExecutorDeps;
  calls: RecordedBridgeCalls;
  events: PostedEvent[];
  attempts: Array<string | undefined>;
  postCalls: () => number;
}

async function makeWorld(opts: WorldOptions = {}): Promise<World> {
  const fake = createFakeEditor({ comps: [{ name: "Main" }], failOn: opts.failOn });
  // Layer 1 "Hello" (text) in comp 1 "Main"; journaled → selected, dirty.
  await fake.execute("layer.newText", { text: "Hello" });
  const base = attachFakeBridge(fake);
  const recorded = recordBridge(base);
  const stub = makeStubClient(opts.clientOpts);
  const deps: ToolExecutorDeps = {
    bridge: opts.hang ? hangBridge(base) : recorded.bridge,
    client: stub.client,
    workspaceId: "ws_test",
    flags: { ...ALL_TRUE_FLAGS, ...opts.flags },
    guardTimeoutMs: opts.guardTimeoutMs,
    retrySleepMs: 0,
  };
  return {
    fake,
    deps,
    calls: recorded.calls,
    events: stub.events,
    attempts: stub.attempts,
    postCalls: stub.postCalls,
  };
}

/** A bridge whose read methods never settle (timeout-guard tests). */
function hangBridge(bridge: EditorBridge): EditorBridge {
  const never = (): Promise<never> => new Promise(() => {});
  return { ...bridge, inspect: never, query: never, renderFrame: never };
}

function toolCall(
  name: string,
  args: unknown,
  toolCallId = "call_test_1",
  runId = "run_test",
): ClientToolCall {
  return { runId, toolCallId, name, args };
}

function resultOf(event: PostedEvent): Record<string, unknown> {
  return event.body.result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The 4 client tools — happy paths (bridge calls + posted body)
// ---------------------------------------------------------------------------

describe("executeClientTool happy paths", () => {
  it("studio.get_context: builds the flags-enabled blocks and posts a valid tool.result", async () => {
    const world = await makeWorld();
    await executeClientTool(toolCall("studio.get_context", {}), world.deps);

    expect(world.events).toHaveLength(1);
    expect(world.postCalls()).toBe(1);
    const event = world.events[0];
    if (event === undefined) throw new Error("no event posted");
    expect(event.runId).toBe("run_test");
    // Exact RUN_EVENT_REQUEST_SCHEMA arm — strictObject, no extra keys.
    expect(Object.keys(event.body).sort()).toEqual(["result", "toolCallId", "type"]);
    expect(event.body.type).toBe("tool.result");
    expect(event.body.toolCallId).toBe("call_test_1");
    expect(event.idempotencyKey).toBe("toolresult:run_test:call_test_1");

    const result = resultOf(event);
    expect(Object.keys(result)).toEqual([
      "projectSummary",
      "activeComp",
      "selection",
      "playhead",
      "focusedPanel",
      "selectedProperties",
      "recentCommands",
    ]);

    const summary = result.projectSummary as Record<string, unknown>;
    expect(summary.activeComp).toBe(1);
    expect(summary.selectedLayers).toEqual([1]);
    expect((summary.items as Array<Record<string, unknown>>)[0]?.name).toBe("Main");

    const comp = result.activeComp as Record<string, unknown>;
    expect(comp.id).toBe(1);
    expect(comp.name).toBe("Main");
    expect(comp.width).toBe(1920);

    const selection = result.selection as Record<string, unknown>;
    expect(selection.layerIds).toEqual([1]);
    const tree = selection.tree as Record<string, unknown>;
    expect(tree.name).toBe("Hello");
    expect(tree.type).toBe("text");

    expect(result.playhead).toEqual({ timeSeconds: 0, playing: false });
    expect(result.focusedPanel).toBe("Viewer");

    const selectedProps = result.selectedProperties as Record<string, unknown>;
    expect(selectedProps.layerId).toBe(1);
    const props = selectedProps.properties as Record<string, Record<string, unknown>>;
    expect(props["transform/opacity"]?.value).toBe(100);
    expect(props["transform/position"]?.value).toEqual([960, 540, 0]);
    expect(props["text/sourceText"]?.value).toBe("Hello");
    expect(props["solid/color"]).toBeUndefined();

    const history = result.recentCommands as Record<string, unknown>;
    expect(history.current).toBe(1);
    const recent = history.recent as Array<Record<string, unknown>>;
    expect(recent[0]?.label).toBe("Original");
    expect(recent[1]?.label).toBe("New Text Layer");

    // Anchored on ONE ui.inspect + the verified query param names.
    expect(world.calls.inspect).toBe(1);
    expect(world.calls.queries[0]).toEqual({ command: "project.summary", params: {} });
    expect(world.calls.queries).toContainEqual({ command: "comp.info", params: { comp: 1 } });
    expect(world.calls.queries).toContainEqual({
      command: "layer.tree",
      params: { comp: 1, layer: 1, depth: 2 },
    });
    expect(world.calls.queries).toContainEqual({
      command: "prop.get",
      params: { layer: 1, path: "transform/opacity" },
    });
    expect(world.calls.queries).toContainEqual({ command: "edit.history.list", params: {} });
  });

  it("studio.list_layers: comp.info listing + per-layer trees at the asked depth", async () => {
    const world = await makeWorld();
    await executeClientTool(toolCall("studio.list_layers", { depth: 3 }), world.deps);
    await executeClientTool(
      toolCall("studio.list_layers", { compId: "Main" }, "call_test_2"),
      world.deps,
    );
    await executeClientTool(
      toolCall("studio.list_layers", { compId: "Nope" }, "call_test_3"),
      world.deps,
    );

    expect(world.events).toHaveLength(3);

    const first = resultOf(world.events[0] as PostedEvent);
    expect(first.comp).toEqual({
      id: 1,
      name: "Main",
      width: 1920,
      height: 1080,
      frameRate: 29.97,
      duration: 10,
    });
    expect(first.layers).toHaveLength(1);
    const layer = (first.layers as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(layer.id).toBe(1);
    expect(layer.name).toBe("Hello");
    expect(layer.type).toBe("text");
    const tree = layer.tree as Record<string, unknown>;
    const children = (tree.properties as Record<string, unknown>).children as Array<
      Record<string, unknown>
    >;
    expect(children.some((child) => child.path === "transform/opacity")).toBe(true);

    // Verified wire params: comp.info {comp?} (empty = active), layer.tree {comp, layer, depth}.
    expect(world.calls.queries[0]).toEqual({ command: "comp.info", params: {} });
    expect(world.calls.queries[1]).toEqual({
      command: "layer.tree",
      params: { comp: 1, layer: 1, depth: 3 },
    });
    expect(world.calls.queries[2]).toEqual({ command: "comp.info", params: { comp: "Main" } });
    expect(world.calls.queries[3]).toEqual({
      command: "layer.tree",
      params: { comp: 1, layer: 1, depth: 2 },
    });

    // Unknown comp → whole-tool failure result (the primary query), still posted.
    const third = resultOf(world.events[2] as PostedEvent);
    expect(third.error).toBe("TOOL_FAILED");
    expect(String(third.message)).toContain("no composition Nope");
  });

  it("studio.get_properties: per {layer, path} reads with per-item NOT_FOUND", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("studio.get_properties", {
        layerIds: ["1", "99"],
        paths: ["transform/opacity", "text/sourceText"],
      }),
      world.deps,
    );

    expect(world.events).toHaveLength(1);
    const result = resultOf(world.events[0] as PostedEvent);
    const layers = result.layers as Record<string, Record<string, unknown>>;
    expect(layers["1"]?.["transform/opacity"]).toMatchObject({ layer: 1, value: 100 });
    expect(layers["1"]?.["text/sourceText"]).toMatchObject({ value: "Hello" });
    // Missing layer/path → per-item NOT_FOUND entries, never an abort.
    expect(layers["99"]?.["transform/opacity"]).toEqual({ error: "NOT_FOUND" });
    expect(world.calls.queries).toContainEqual({
      command: "prop.get",
      params: { layer: "99", path: "transform/opacity" },
    });
  });

  it("studio.get_properties: curated default paths when none are given", async () => {
    const world = await makeWorld();
    await executeClientTool(toolCall("studio.get_properties", { layerIds: ["1"] }), world.deps);
    const layers = (
      resultOf(world.events[0] as PostedEvent).layers as Record<string, Record<string, unknown>>
    )["1"];
    if (layers === undefined) throw new Error("layer entry missing");
    expect(Object.keys(layers).sort()).toEqual([
      "text/sourceText",
      "transform/anchor",
      "transform/opacity",
      "transform/position",
      "transform/rotation",
      "transform/scale",
    ]);
  });

  it("studio.render_preview: maps maxWidth → max_side (cap 1200) and posts the frame", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("studio.render_preview", { compId: "Main", timeSeconds: 1.5, maxWidth: 800 }),
      world.deps,
    );
    await executeClientTool(toolCall("studio.render_preview", {}, "call_test_2"), world.deps);

    expect(world.calls.renderFrames[0]).toEqual({ comp: "Main", time: 1.5, max_side: 800 });
    expect(world.calls.renderFrames[1]).toEqual({ max_side: 1200 });

    const first = resultOf(world.events[0] as PostedEvent);
    expect(first).toMatchObject({ comp: 1, time: 1.5, width: 800, height: 450 });
    expect(first.pngBase64).toBe(FAKE_PNG_BASE64);

    const second = resultOf(world.events[1] as PostedEvent);
    expect(second).toMatchObject({ width: 1200, height: 675 });
  });
});

// ---------------------------------------------------------------------------
// Gates: invalid args, write tools, server tools
// ---------------------------------------------------------------------------

describe("executeClientTool gating", () => {
  it("invalid args → RUN_INVALID_TOOL posted, no bridge call", async () => {
    const world = await makeWorld();
    await executeClientTool(toolCall("studio.get_properties", { layerIds: [] }), world.deps);
    await executeClientTool(
      toolCall("studio.list_layers", { depth: 99 }, "call_test_2"),
      world.deps,
    );

    expect(world.events).toHaveLength(2);
    expect(resultOf(world.events[0] as PostedEvent)).toMatchObject({ error: "RUN_INVALID_TOOL" });
    expect(String(resultOf(world.events[0] as PostedEvent).message)).toContain("layerIds");
    expect(resultOf(world.events[1] as PostedEvent).error).toBe("RUN_INVALID_TOOL");
    expect(world.calls.inspect).toBe(0);
    expect(world.calls.queries).toHaveLength(0);
    expect(world.calls.renderFrames).toHaveLength(0);
  });

  it("raw engine command ids as tool names → TOOL_FORBIDDEN, zero bridge calls (law #6 backstop)", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("engine.batch", { steps: [{ command: "comp.new", params: {} }] }),
      world.deps,
    );
    await executeClientTool(toolCall("engine.execute", {}), world.deps);
    await executeClientTool(toolCall("edit.undo", {}), world.deps);
    await executeClientTool(toolCall("edit.redo", {}), world.deps);

    expect(world.events).toHaveLength(4);
    for (const event of world.events) {
      expect(resultOf(event)).toEqual({
        error: "TOOL_FORBIDDEN",
        message:
          "Raw engine commands are not tools. Use the curated Studio tools; apply a plan to make changes.",
      });
    }
    expect(world.calls.inspect).toBe(0);
    expect(world.calls.queries).toHaveLength(0);
    expect(world.calls.renderFrames).toHaveLength(0);
  });

  it("server-side tools and unknown names → nothing posted (no 400 on unregistered ids)", async () => {
    const world = await makeWorld();
    await executeClientTool(toolCall("studio.plan_edit", { goal: "make it blue" }), world.deps);
    await executeClientTool(toolCall("studio.nope", {}), world.deps);

    expect(world.events).toHaveLength(0);
    expect(world.postCalls()).toBe(0);
    expect(world.calls.inspect).toBe(0);
    expect(world.calls.queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The 8 write tools — PROPOSE only (M5, §8.4 rule 1): nothing executes, the
// only bridge traffic is read queries for live-state validation
// ---------------------------------------------------------------------------

describe("executeClientTool write tools propose (never execute)", () => {
  it("studio.create_composition → a comp.new proposal with the Zod defaults; ZERO bridge calls", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("studio.create_composition", { name: "Intro", width: 1920, height: 1080 }),
      world.deps,
    );

    expect(world.events).toHaveLength(1);
    const result = resultOf(world.events[0] as PostedEvent);
    expect(result).toEqual({
      proposed: true,
      tool: "studio.create_composition",
      summary: 'create composition "Intro" (1920×1080 @ 30fps, 10s)',
      batch: {
        label: "Agent: create composition \"Intro\" (1920×1080 @ 30fps, 10s)",
        steps: [
          {
            command: "comp.new",
            params: { name: "Intro", width: 1920, height: 1080, frameRate: 30, duration: 10 },
          },
        ],
      },
    });
    // NOTHING executed: zero bridge traffic of any kind.
    expect(world.calls.inspect).toBe(0);
    expect(world.calls.queries).toHaveLength(0);
    expect(world.calls.renderFrames).toHaveLength(0);
    // The editor is untouched (the setup newText is the only journaled command).
    expect(world.fake.state.history.undo).toHaveLength(1);
  });

  it("studio.set_properties → prop.set steps + prop.get no-op warnings from live state", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("studio.set_properties", {
        updates: [
          // transform/opacity is 100 in the fake — proposing 100 is a no-op.
          { layer: "1", path: "transform/opacity", value: 100 },
          { layer: "1", path: "transform/position", value: [960, 540, 0] },
          { layer: "1", path: "text/sourceText", value: "New words" },
        ],
      }),
      world.deps,
    );

    expect(world.events).toHaveLength(1);
    const result = resultOf(world.events[0] as PostedEvent) as {
      proposed: boolean;
      warnings: string[];
      batch: { steps: Array<{ command: string; params: Record<string, unknown> }> };
    };
    expect(result.proposed).toBe(true);
    // Live-state reads: one prop.get per update, read-only.
    expect(world.calls.queries).toEqual([
      { command: "prop.get", params: { layer: "1", path: "transform/opacity" } },
      { command: "prop.get", params: { layer: "1", path: "transform/position" } },
      { command: "prop.get", params: { layer: "1", path: "text/sourceText" } },
    ]);
    // The first two updates are already the current values → no-op warnings.
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("already 100");
    expect(result.warnings[1]).toContain("already [960,540,0]");
    // The proposed steps echo the model's values verbatim (data, not code).
    expect(result.batch.steps).toEqual([
      { command: "prop.set", params: { layer: "1", path: "transform/opacity", value: 100 } },
      { command: "prop.set", params: { layer: "1", path: "transform/position", value: [960, 540, 0] } },
      { command: "prop.set", params: { layer: "1", path: "text/sourceText", value: "New words" } },
    ]);
  });

  it("each content tool proposes its grep-verified registry command", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("studio.create_text", { text: "Hello plan", position: [100, 200], color: "#112233" }),
      world.deps,
    );
    await executeClientTool(
      toolCall("studio.add_effect", { layer: "1", effect: "ec.control.slider", params: { slider: 10 } }),
      world.deps,
      "call_text_2",
    );
    await executeClientTool(
      toolCall("studio.set_keyframes", {
        layer: "1",
        propertyPath: "transform/scale",
        keyframes: [
          { time: 0, value: 100, easing: "linear" },
          { time: 1, value: 200 },
        ],
      }),
      world.deps,
      "call_keys",
    );
    await executeClientTool(
      toolCall("studio.apply_preset", { preset: "fade-in", targets: ["1", "2"] }),
      world.deps,
      "call_preset",
    );

    const [text, effect, keys, preset] = world.events.map((event) =>
      resultOf(event),
    ) as Array<{ batch?: { steps: Array<{ command: string; params: unknown }> }; action?: string }>;
    expect(text.batch?.steps).toEqual([
      { command: "layer.newText", params: { text: "Hello plan", position: [100, 200], color: "#112233" } },
    ]);
    expect(effect.batch?.steps).toEqual([
      {
        command: "effect.apply",
        params: { layers: ["1"], effect: "ec.control.slider", slider: 10 },
      },
    ]);
    expect(keys.batch?.steps).toEqual([
      { command: "prop.addKey", params: { layer: "1", path: "transform/scale", time: 0, value: 100 } },
      { command: "prop.addKey", params: { layer: "1", path: "transform/scale", time: 1, value: 200 } },
    ]);
    expect(preset.batch?.steps).toEqual([
      { command: "anim.applyBuiltinPreset", params: { layers: ["1"], preset: "fade-in" } },
      { command: "anim.applyBuiltinPreset", params: { layers: ["2"], preset: "fade-in" } },
    ]);
    expect(world.calls.queries).toHaveLength(0); // these tools need no live state
  });

  it("studio.undo_run / studio.save_version → run-level actions, no batch steps", async () => {
    const world = await makeWorld();
    await executeClientTool(toolCall("studio.undo_run", {}), world.deps);
    await executeClientTool(
      toolCall("studio.save_version", { label: "Before the big edit" }),
      world.deps,
      "call_save",
    );

    const [undo, save] = world.events.map((event) => resultOf(event)) as Array<
      Record<string, unknown>
    >;
    expect(undo).toMatchObject({ proposed: true, tool: "studio.undo_run", action: "undo_run" });
    expect("batch" in undo).toBe(false);
    expect(save).toMatchObject({
      proposed: true,
      tool: "studio.save_version",
      action: "save_version",
      label: "Before the big edit",
    });
    expect("batch" in save).toBe(false);
    expect(world.calls.queries).toHaveLength(0);
  });

  it("dunder identifier args → RUN_INVALID_TOOL before any bridge call (F-1 posture)", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("studio.set_properties", {
        updates: [{ layer: "__proto__", path: "transform/opacity", value: 1 }],
      }),
      world.deps,
    );
    await executeClientTool(
      toolCall("studio.add_effect", { layer: "constructor", effect: "x" }),
      world.deps,
      "call_fx",
    );
    await executeClientTool(
      toolCall("studio.apply_preset", { preset: "p", targets: ["1", "prototype"] }),
      world.deps,
      "call_preset",
    );

    for (const event of world.events) {
      expect(resultOf(event)).toMatchObject({ error: "RUN_INVALID_TOOL" });
      expect(String(resultOf(event).message)).toContain("dunder");
    }
    expect(world.calls.queries).toHaveLength(0);
    expect(Object.hasOwn(Object.prototype, "transform/opacity")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
  });

  it("invalid write-tool args → RUN_INVALID_TOOL (the model gets its repair turn)", async () => {
    const world = await makeWorld();
    await executeClientTool(
      toolCall("studio.create_composition", { name: "", width: 10, height: 10 }),
      world.deps,
    );
    expect(resultOf(world.events[0] as PostedEvent)).toMatchObject({ error: "RUN_INVALID_TOOL" });
    expect(world.calls.queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Degradation: per-item bridge failures, flags filtering, timeout guard
// ---------------------------------------------------------------------------

describe("executeClientTool degradation", () => {
  it("bridge failures mid-batch → per-item nulls/NOT_FOUND, the result still posts", async () => {
    const world = await makeWorld({ failOn: { "layer.tree": "boom" } });
    await executeClientTool(toolCall("studio.list_layers", {}), world.deps);

    expect(world.events).toHaveLength(1);
    const layers = resultOf(world.events[0] as PostedEvent).layers as Array<
      Record<string, unknown>
    >;
    expect(layers[0]?.name).toBe("Hello");
    expect(layers[0]?.tree).toBeNull();
    expect(resultOf(world.events[0] as PostedEvent).error).toBeUndefined();

    const world2 = await makeWorld({ failOn: { "prop.get": "boom" } });
    await executeClientTool(toolCall("studio.get_context", {}), world2.deps);
    const props = (
      resultOf(world2.events[0] as PostedEvent).selectedProperties as Record<string, unknown>
    ).properties as Record<string, unknown>;
    expect(Object.keys(props)).toHaveLength(6);
    for (const value of Object.values(props)) expect(value).toBeNull();
  });

  it("user-removed flags are reported as removed, include-limiting drops blocks entirely", async () => {
    const world = await makeWorld({ flags: { playhead: false, recentCommands: false } });
    await executeClientTool(toolCall("studio.get_context", {}), world.deps);
    const result = resultOf(world.events[0] as PostedEvent);
    expect(result.playhead).toBe("removed by user");
    expect(result.recentCommands).toBe("removed by user");
    expect(typeof result.projectSummary).toBe("object");
    // No bridge call was spent on removed blocks.
    expect(world.calls.queries).not.toContainEqual({ command: "edit.history.list", params: {} });

    const world2 = await makeWorld();
    await executeClientTool(
      toolCall("studio.get_context", { include: ["selection", "playhead"] }, "call_test_2"),
      world2.deps,
    );
    const limited = resultOf(world2.events[0] as PostedEvent);
    expect(Object.keys(limited).sort()).toEqual(["playhead", "selection"]);
    expect(world2.calls.queries[0]?.command).toBe("layer.tree");
  });

  it("a hanging editor trips the 20s-style guard and posts TOOL_TIMEOUT", async () => {
    const world = await makeWorld({ hang: true, guardTimeoutMs: 20 });
    await executeClientTool(toolCall("studio.get_context", {}), world.deps);
    expect(world.events).toHaveLength(1);
    expect(resultOf(world.events[0] as PostedEvent)).toEqual({
      error: "TOOL_TIMEOUT",
      message: "The editor did not finish the tool call in time.",
    });

    const world2 = await makeWorld({ hang: true, guardTimeoutMs: 20 });
    await executeClientTool(toolCall("studio.render_preview", {}), world2.deps);
    expect(resultOf(world2.events[0] as PostedEvent).error).toBe("TOOL_TIMEOUT");
  });

  it("a late result after the guard never double-posts (single result per call)", async () => {
    let release: (() => void) | undefined;
    const world = await makeWorld();
    const slow: EditorBridge = {
      ...world.deps.bridge,
      query: <T>(command: string, params?: unknown) =>
        new Promise<T>((resolve) => {
          release = () => {
            void world.deps.bridge.query<T>(command, params).then(resolve);
          };
        }),
    };
    const settled = executeClientTool(toolCall("studio.get_context", {}), {
      ...world.deps,
      bridge: slow,
      guardTimeoutMs: 10,
    });
    await settled;
    expect(resultOf(world.events[0] as PostedEvent).error).toBe("TOOL_TIMEOUT");

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createToolExecutor: idempotent toolCallId guard + post retries
// ---------------------------------------------------------------------------

describe("createToolExecutor", () => {
  it("guards the same toolCallId across concurrent and replayed dispatches", async () => {
    const world = await makeWorld();
    const execute = createToolExecutor(world.deps);
    const call = toolCall("studio.get_context", {});

    const first = execute(call);
    const duplicate = execute(call); // replay / double dispatch
    await Promise.all([first, duplicate]);
    expect(world.postCalls()).toBe(1);

    await execute(call); // SSE-replayed tool.started after completion
    expect(world.postCalls()).toBe(1);
    expect(world.events).toHaveLength(1);

    await execute(toolCall("studio.get_context", {}, "call_other"));
    expect(world.postCalls()).toBe(2);
  });

  it("retries a transient postEvent failure exactly twice, then succeeds", async () => {
    const world = await makeWorld({ clientOpts: { failTimes: 2 } });
    await executeClientTool(toolCall("studio.get_context", {}), world.deps);

    expect(world.postCalls()).toBe(3);
    expect(world.events).toHaveLength(1);
    // Same logical mutation on every attempt (law #4 idempotency).
    const keys = new Set(world.attempts);
    expect(keys.size).toBe(1);
    expect(world.attempts[0]).toBe("toolresult:run_test:call_test_1");
  });

  it("gives up silently after the retries are exhausted — never throws", async () => {
    const world = await makeWorld({ clientOpts: { failTimes: 5 } });
    await expect(
      executeClientTool(toolCall("studio.list_layers", {}), world.deps),
    ).resolves.toBeUndefined();
    expect(world.postCalls()).toBe(3);
    expect(world.events).toHaveLength(0);
  });

  it("does not retry a permanent (4xx) postEvent failure", async () => {
    const world = await makeWorld({ clientOpts: { failTimes: 1, failureStatus: 400 } });
    await executeClientTool(toolCall("studio.list_layers", {}), world.deps);
    expect(world.postCalls()).toBe(1);
    expect(world.events).toHaveLength(0);
  });
});
