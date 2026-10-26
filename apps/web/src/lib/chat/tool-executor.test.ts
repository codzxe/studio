/**
 * tool-executor v2 tests (round-12 client-driven loop, "Tool catalog v3") —
 * deterministic, no network, no Tone.js:
 *
 *  - the REAL fake editor (`@studio/editor-bridge/fake`) drives the four
 *    curated editor reads + the catalog queries (its registry implements
 *    `command.list`/`command.describe` and its `engine.batch` carries the
 *    NOT_IN_BATCH semantics);
 *  - the gateway tools (web_search/generate_image) run against a scripted
 *    `fetchImpl` (the authenticated transport seam) with hand-built §7.3
 *    envelopes;
 *  - render_audio runs with an INJECTED fake harness (the real Tone path
 *    only runs in the browser) + a fake assets client.
 *
 * The contract under pinning: `execute` RESOLVES with the result or THROWS
 * `ClientToolError {code, message}` — there is no POST-back channel anymore;
 * `handles` mirrors the nine client-executed tools; the RAW engine surface
 * and write tools are refused with ZERO bridge calls (law #5/#6).
 */

import type { ApiClient } from "@studio/api-client";
import type { ContextSelection } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { BridgeError } from "@studio/editor-bridge";
import {
  FAKE_PNG_BASE64,
  type FakeEditor,
  attachFakeBridge,
  createFakeEditor,
} from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";

import {
  type ClientToolError,
  type ClientToolExecutorDeps,
  createClientToolExecutor,
  isClientToolError,
} from "./tool-executor";
import type { AudioRenderHarness } from "./tools/audio-render";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RecordedBridgeCalls {
  inspect: number;
  queries: Array<{ command: string; params: unknown }>;
  renderFrames: Array<Record<string, unknown>>;
  executes: Array<{ command: string; params: unknown }>;
}

/** Wraps a bridge so every call is recorded (execute counts as a mutation). */
function recordBridge(bridge: EditorBridge): { bridge: EditorBridge; calls: RecordedBridgeCalls } {
  const calls: RecordedBridgeCalls = { inspect: 0, queries: [], renderFrames: [], executes: [] };
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
    execute: <T>(command: string, params?: unknown) => {
      calls.executes.push({ command, params });
      return bridge.execute<T>(command, params);
    },
  };
  return { bridge: wrapped, calls };
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

/** A fake assets client (the two-phase upload seam) recording every call. */
interface AssetsCalls {
  descriptors: Array<Record<string, unknown>>;
  completes: string[];
  urls: string[];
}

function makeAssetsClient(opts: { failDescriptor?: boolean; duplicate?: boolean } = {}) {
  const calls: AssetsCalls = { descriptors: [], completes: [], urls: [] };
  const client = {
    assets: {
      createDescriptor: async (body: Record<string, unknown>) => {
        calls.descriptors.push(body);
        if (opts.failDescriptor) {
          throw new Error("storage quota exceeded");
        }
        if (opts.duplicate) {
          return { asset: { id: "ast_dup" }, upload: null, duplicate: true };
        }
        return {
          asset: { id: `ast_${calls.descriptors.length}` },
          upload: {
            url: "https://storage.example/signed?token=abc",
            method: "PUT" as const,
            headers: { "content-type": "application/octet-stream" },
          },
        };
      },
      complete: async (id: string) => {
        calls.completes.push(id);
        return { asset: { id }, duplicate: false };
      },
      getUrl: async (id: string) => {
        calls.urls.push(id);
        return { url: `https://cdn.example/${id}.wav` };
      },
    },
  } as unknown as ApiClient;
  return { client, calls };
}

/** A scripted fetch for the tools endpoints (records path/init, replays bodies). */
interface FetchCall {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

type ScriptedResponse =
  | { readonly status: number; readonly body: unknown }
  | { readonly throw: true };

function makeFetch(script: readonly ScriptedResponse[]) {
  const calls: FetchCall[] = [];
  let next = 0;
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path, init });
    const step = script[next] ?? script[script.length - 1];
    next += 1;
    if (step !== undefined && "throw" in step) {
      throw new TypeError("network down");
    }
    const body = JSON.stringify(step?.body ?? {});
    return {
      ok: (step?.status ?? 200) >= 200 && (step?.status ?? 200) < 300,
      status: step?.status ?? 200,
      statusText: "",
      text: async () => body,
    } as Response;
  };
  return { fetchImpl, calls };
}

/** Reads the fetch call's JSON body. */
function postedBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

interface WorldOptions {
  failOn?: Readonly<Record<string, string>>;
  guardTimeoutMs?: number;
  hang?: boolean;
  failQuery?: { readonly command: string; readonly error: unknown };
  queryOverrides?: Readonly<Record<string, () => unknown>>;
  audioHarness?: AudioRenderHarness;
  audioRenderTimeoutMs?: number;
}

interface World {
  fake: FakeEditor;
  deps: ClientToolExecutorDeps;
  calls: RecordedBridgeCalls;
  assets: ReturnType<typeof makeAssetsClient>;
}

async function makeWorld(opts: WorldOptions = {}): Promise<World> {
  const fake = createFakeEditor({ comps: [{ name: "Main" }], failOn: opts.failOn });
  // Layer 1 "Hello" (text) in comp 1 "Main"; journaled → selected, dirty.
  await fake.execute("layer.newText", { text: "Hello" });
  let base: EditorBridge = attachFakeBridge(fake);
  if (opts.failQuery !== undefined || opts.queryOverrides !== undefined) {
    const inner = base;
    const failQuery = opts.failQuery;
    const overrides = opts.queryOverrides ?? {};
    base = {
      ...inner,
      query: <T>(command: string, params?: unknown) => {
        const override = overrides[command];
        if (override !== undefined) return Promise.resolve(override() as T);
        if (failQuery !== undefined && failQuery.command === command) {
          return Promise.reject(failQuery.error);
        }
        return inner.query<T>(command, params);
      },
    };
  }
  const recorded = recordBridge(opts.hang ? hangBridge(base) : base);
  const assets = makeAssetsClient();
  const deps: ClientToolExecutorDeps = {
    bridge: recorded.bridge,
    client: assets.client,
    workspaceId: "ws_test",
    threadId: "th_test",
    runId: "run_test",
    flags: { ...ALL_TRUE_FLAGS },
    ...(opts.guardTimeoutMs === undefined ? {} : { guardTimeoutMs: opts.guardTimeoutMs }),
    ...(opts.audioHarness === undefined ? {} : { audioHarness: opts.audioHarness }),
    ...(opts.audioRenderTimeoutMs === undefined
      ? {}
      : { audioRenderTimeoutMs: opts.audioRenderTimeoutMs }),
  };
  return { fake, deps, calls: recorded.calls, assets };
}

/** A world with a scripted tools-endpoint transport. */
async function makeTransportWorld(
  script: readonly ScriptedResponse[],
  opts: WorldOptions = {},
): Promise<{ world: World; calls: FetchCall[] }> {
  const world = await makeWorld(opts);
  const transport = makeFetch(script);
  return {
    world: {
      ...world,
      deps: { ...world.deps, fetchImpl: transport.fetchImpl },
    },
    calls: transport.calls,
  };
}

/** A bridge whose read methods never settle (timeout-guard tests). */
function hangBridge(bridge: EditorBridge): EditorBridge {
  const never = (): Promise<never> => new Promise(() => {});
  return { ...bridge, inspect: never, query: never, renderFrame: never };
}

/** A failing fake audio harness (renders bytes; failure mode scripted). */
function fakeAudioHarness(
  behavior:
    | { readonly wav: readonly number[]; readonly durationSeconds: number }
    | { readonly reject: string }
    | { readonly hang: true } = { wav: [82, 73, 70, 70], durationSeconds: 3.5 },
): AudioRenderHarness {
  return {
    render: (input, signal) => {
      if ("reject" in behavior) {
        return Promise.reject(new Error(behavior.reject));
      }
      if ("hang" in behavior) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      expect(input.code.length).toBeGreaterThan(0);
      return Promise.resolve({
        wav: new Uint8Array(behavior.wav),
        durationSeconds: behavior.durationSeconds,
        sampleRate: 44_100,
        channels: 2,
      });
    },
  };
}

/** The typed failure an execute() rejection must carry. */
async function failureOf(promise: Promise<unknown>): Promise<ClientToolError> {
  try {
    await promise;
  } catch (error) {
    if (!isClientToolError(error)) throw new Error(`not a ClientToolError: ${String(error)}`);
    return error;
  }
  throw new Error("execute() resolved instead of failing");
}

// ---------------------------------------------------------------------------
// handles() — the v3 client-executed surface
// ---------------------------------------------------------------------------

describe("createClientToolExecutor.handles", () => {
  it("mirrors the catalog: the nine client-executed tools, nothing else", async () => {
    const { deps } = await makeWorld();
    const executor = createClientToolExecutor(deps);
    for (const tool of [
      "studio.get_context",
      "studio.list_layers",
      "studio.get_properties",
      "studio.render_preview",
      "studio.list_commands",
      "studio.describe_command",
      "studio.web_search",
      "studio.render_audio",
      "studio.generate_image",
    ]) {
      expect(executor.handles(tool)).toBe(true);
    }
    // Write tools, the server-side planner, the RAW engine surface, unknowns.
    for (const tool of [
      "studio.plan_edit",
      "studio.create_text",
      "studio.set_properties",
      "studio.add_effect",
      "studio.set_keyframes",
      "studio.apply_preset",
      "studio.create_composition",
      "studio.undo_run",
      "studio.save_version",
      "studio.engine_commands",
      "studio.run_script",
      "studio.add_asset",
      "engine.batch",
      "engine.execute",
      "edit.undo",
      "edit.redo",
      "studio.nope",
      "",
    ]) {
      expect(executor.handles(tool)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals (zero bridge calls) + arg validation
// ---------------------------------------------------------------------------

describe("createClientToolExecutor.execute refusals", () => {
  it("RAW engine ids are TOOL_FORBIDDEN with ZERO bridge calls (law #6)", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    for (const tool of ["engine.batch", "engine.execute", "edit.undo", "edit.redo"]) {
      const error = await failureOf(executor.execute(tool, {}));
      expect(error.code).toBe("TOOL_FORBIDDEN");
    }
    expect(world.calls.queries).toHaveLength(0);
    expect(world.calls.executes).toHaveLength(0);
    expect(world.calls.renderFrames).toHaveLength(0);
    expect(world.calls.inspect).toBe(0);
  });

  it("write tools and unknown tools are TOOL_FORBIDDEN with zero bridge calls", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    for (const tool of ["studio.create_text", "studio.add_asset", "studio.plan_edit"]) {
      const error = await failureOf(executor.execute(tool, {}));
      expect(error.code).toBe("TOOL_FORBIDDEN");
    }
    const unknown = await failureOf(executor.execute("studio.nope", {}));
    expect(unknown.code).toBe("TOOL_FORBIDDEN");
    expect(world.calls.executes).toHaveLength(0);
  });

  it("invalid args are RUN_INVALID_TOOL before any bridge traffic", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const error = await failureOf(executor.execute("studio.get_properties", { layerIds: [] }));
    expect(error.code).toBe("RUN_INVALID_TOOL");
    const search = await failureOf(executor.execute("studio.web_search", { query: "" }));
    expect(search.code).toBe("RUN_INVALID_TOOL");
    expect(world.calls.queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The four curated editor reads (result shapes kept; failures now typed)
// ---------------------------------------------------------------------------

describe("editor reads", () => {
  it("studio.get_context builds the flags-enabled blocks", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.get_context", {})) as Record<string, unknown>;

    expect(Object.keys(result)).toEqual([
      "projectSummary",
      "activeComp",
      "selection",
      "playhead",
      "focusedPanel",
      "selectedProperties",
      "recentCommands",
    ]);
    const comp = result.activeComp as Record<string, unknown>;
    expect(comp.id).toBe(1);
    expect(comp.name).toBe("Main");
    const selectedProps = result.selectedProperties as Record<string, unknown>;
    const props = selectedProps.properties as Record<string, Record<string, unknown>>;
    expect(props["text/sourceText"]?.value).toBe("Hello");
    expect(result.playhead).toEqual({ timeSeconds: 0, playing: false });
  });

  it("studio.get_context reports user-removed blocks instead of fetching them", async () => {
    const world = await makeWorld();
    const deps: ClientToolExecutorDeps = {
      ...world.deps,
      flags: { ...ALL_TRUE_FLAGS, projectSummary: false, focusedPanel: false },
    };
    const executor = createClientToolExecutor(deps);
    const result = (await executor.execute("studio.get_context", {})) as Record<string, unknown>;
    expect(result.projectSummary).toBe("removed by user");
    expect(result.focusedPanel).toBe("removed by user");
  });

  it("studio.list_layers assembles comp.info + per-layer trees at the asked depth", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.list_layers", { depth: 3 })) as Record<
      string,
      unknown
    >;
    expect(result.comp).toMatchObject({ id: 1, name: "Main", width: 1920 });
    const layers = result.layers as Array<Record<string, unknown>>;
    expect(layers).toHaveLength(1);
    const tree = layers[0]?.tree as Record<string, unknown>;
    expect(tree.name).toBe("Hello");
  });

  it("studio.get_properties degrades per-item NOT_FOUND; dunder ids are refused at the boundary", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.get_properties", {
      layerIds: ["1", "Nope"],
    })) as Record<string, unknown>;
    const layers = result.layers as Record<string, Record<string, unknown>>;
    expect(layers["1"]?.["transform/opacity"]).toMatchObject({ value: 100 });
    // A missing layer is a per-item NOT_FOUND entry, never an abort.
    expect(layers.Nope?.["transform/opacity"]).toEqual({ error: "NOT_FOUND" });

    // F-1: dunder keys are refused by the args schema at the boundary — the
    // null-prototype accumulators behind it stay the second line of defense.
    const dunder = await failureOf(
      executor.execute("studio.get_properties", { layerIds: ["__proto__"] }),
    );
    expect(dunder.code).toBe("RUN_INVALID_TOOL");
    expect(dunder.message).toContain("dunder");
  });

  it("studio.render_preview passes the capped long side and returns the frame", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.render_preview", {
      compId: "Main",
    })) as Record<string, unknown>;
    expect(result.pngBase64).toBe(FAKE_PNG_BASE64);
    expect(world.calls.renderFrames[0]?.max_side).toBe(1200);

    const small = (await executor.execute("studio.render_preview", {
      compId: "Main",
      maxWidth: 800,
    })) as Record<string, unknown>;
    expect(small.pngBase64).toBe(FAKE_PNG_BASE64);
    expect(world.calls.renderFrames[1]?.max_side).toBe(800);
  });

  it("bridge disconnects surface as EDITOR_DISCONNECTED; other failures as TOOL_FAILED", async () => {
    const disconnected = await makeWorld({
      failQuery: {
        command: "comp.info",
        error: new BridgeError("EDITOR_DISCONNECTED", "the iframe window is gone"),
      },
    });
    const executor = createClientToolExecutor(disconnected.deps);
    const error = await failureOf(executor.execute("studio.list_layers", {}));
    expect(error.code).toBe("EDITOR_DISCONNECTED");

    const broken = await makeWorld({
      failQuery: { command: "comp.info", error: new Error("bad shape") },
    });
    const executor2 = createClientToolExecutor(broken.deps);
    const error2 = await failureOf(executor2.execute("studio.list_layers", {}));
    expect(error2.code).toBe("TOOL_FAILED");
    expect(error2.message).toContain("bad shape");
  });

  it("a hanging editor fails the whole-call guard with TOOL_TIMEOUT", async () => {
    const world = await makeWorld({ hang: true, guardTimeoutMs: 20 });
    const executor = createClientToolExecutor(world.deps);
    const error = await failureOf(executor.execute("studio.get_context", {}));
    expect(error.code).toBe("TOOL_TIMEOUT");
  });
});

// ---------------------------------------------------------------------------
// studio.list_commands / studio.describe_command (catalog discovery)
// ---------------------------------------------------------------------------

describe("studio.list_commands", () => {
  it("live: filters the engine registry to ALLOWED ids, grouped by category", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.list_commands", {})) as {
      source: string;
      categories: Array<{ category: string; count: number; commands: Array<{ id: string }> }>;
    };

    expect(result.source).toBe("live");
    const ids = result.categories.flatMap((group) => group.commands.map((row) => row.id));
    // Mutating ALLOWED registry ids survive…
    for (const id of [
      "comp.new",
      "layer.newText",
      "layer.newSolid",
      "layer.rename",
      "prop.set",
      "edit.undo",
      "edit.redo",
    ]) {
      expect(ids).toContain(id);
    }
    // …the RAW batch id, meta ids, query ids (never batchable — the catalog
    // is mutating-only) and unlisted ids never reach the model.
    for (const denied of [
      "engine.batch",
      "command.list",
      "project.summary",
      "editor.state",
      "prop.get",
    ]) {
      expect(ids).not.toContain(denied);
    }
    const layerGroup = result.categories.find((group) => group.category === "layer");
    // Fake-registry order preserved inside the group.
    expect(layerGroup?.commands.map((row) => row.id)).toEqual([
      "layer.newSolid",
      "layer.newText",
      "layer.rename",
    ]);
    expect(world.calls.queries).toContainEqual({ command: "command.list", params: {} });
  });

  it("live + category: narrows to the asked prefix", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.list_commands", {
      category: "prop",
    })) as {
      categories: Array<{ category: string }>;
    };
    expect(result.categories.map((group) => group.category)).toEqual(["prop"]);
  });

  it("degrades to the local ALLOWED ids when the engine lacks command.list", async () => {
    const world = await makeWorld({
      failQuery: { command: "command.list", error: new Error("unknown command") },
    });
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.list_commands", {
      category: "camera",
    })) as {
      source: string;
      categories: Array<{ category: string; count: number; commands: Array<{ id: string }> }>;
    };
    expect(result.source).toBe("local");
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]?.category).toBe("camera");
    expect(result.categories[0]?.commands.length).toBeGreaterThan(3);
    expect(result.categories[0]?.commands.every((row) => row.id.startsWith("camera."))).toBe(true);
  });
});

describe("studio.describe_command", () => {
  it("returns the live params doc for an allowed id", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.describe_command", {
      command: "layer.newText",
    })) as Record<string, unknown>;
    expect(result.command).toBe("layer.newText");
    expect(typeof result.paramsDoc).toBe("string");
    expect((result.paramsDoc as string).length).toBeGreaterThan(0);
    expect(world.calls.queries).toContainEqual({
      command: "command.describe",
      params: { command: "layer.newText" },
    });
  });

  it("unknown or denied ids are typed UNKNOWN_COMMAND with closest allowed hints", async () => {
    const world = await makeWorld();
    const executor = createClientToolExecutor(world.deps);
    const unknown = await failureOf(
      executor.execute("studio.describe_command", { command: "layer.newTxt" }),
    );
    expect(unknown.code).toBe("UNKNOWN_COMMAND");
    expect(unknown.message).toContain("layer.newText");
    expect(unknown.message).toContain("studio.list_commands");

    const denied = await failureOf(
      executor.execute("studio.describe_command", { command: "script.run" }),
    );
    expect(denied.code).toBe("UNKNOWN_COMMAND");
    // Zero describe traffic for non-members (never fabricated docs).
    expect(world.calls.queries.filter((call) => call.command === "command.describe")).toHaveLength(
      0,
    );
  });

  it("a dead editor is an honest typed failure, never a fabricated doc", async () => {
    const dead = await makeWorld({
      failQuery: {
        command: "command.describe",
        error: new BridgeError("EDITOR_TIMEOUT", "timed out"),
      },
    });
    const executor = createClientToolExecutor(dead.deps);
    const error = await failureOf(
      executor.execute("studio.describe_command", { command: "layer.newText" }),
    );
    expect(error.code).toBe("EDITOR_DISCONNECTED");

    const broken = await makeWorld({
      failQuery: { command: "command.describe", error: new Error("bad shape") },
    });
    const executor2 = createClientToolExecutor(broken.deps);
    const error2 = await failureOf(
      executor2.execute("studio.describe_command", { command: "layer.newText" }),
    );
    expect(error2.code).toBe("TOOL_FAILED");
  });
});

// ---------------------------------------------------------------------------
// studio.web_search / studio.generate_image (the gateway tool endpoints)
// ---------------------------------------------------------------------------

describe("studio.web_search", () => {
  it("POSTs the pinned path + headers and resolves the results", async () => {
    const { world, calls } = await makeTransportWorld([
      {
        status: 200,
        body: { data: { results: [{ title: "T", url: "https://x", content: "c" }] } },
      },
    ]);
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.web_search", {
      query: "tone.js offline",
      maxResults: 3,
    })) as { results: Array<Record<string, unknown>> };

    expect(result.results).toEqual([{ title: "T", url: "https://x", content: "c" }]);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("no fetch call");
    expect(call.path).toBe("/v1/threads/th_test/tools/web_search");
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["x-workspace-id"]).toBe("ws_test");
    expect(String(headers["Idempotency-Key"])).toMatch(/^tool:run_test:web_search:[0-9a-f]+$/);
    expect(postedBody(call)).toEqual({ query: "tone.js offline", maxResults: 3 });
  });

  it("the same logical call mints the SAME idempotency key (replay, not double charge)", async () => {
    const { world, calls } = await makeTransportWorld([
      { status: 200, body: { data: { results: [] } } },
      { status: 200, body: { data: { results: [] } } },
    ]);
    const executor = createClientToolExecutor(world.deps);
    await executor.execute("studio.web_search", { query: "same", maxResults: 1 });
    await executor.execute("studio.web_search", { query: "same", maxResults: 1 });
    const first = calls[0]?.init?.headers as Record<string, string>;
    const second = calls[1]?.init?.headers as Record<string, string>;
    expect(first["Idempotency-Key"]).toBe(second["Idempotency-Key"]);
  });

  it("503 / network / 5xx map to the graceful WEB_SEARCH_UNAVAILABLE", async () => {
    for (const script of [
      [
        {
          status: 503,
          body: {
            error: {
              code: "WEB_SEARCH_UNAVAILABLE",
              message: "no",
              retryable: true,
              requestId: "r",
            },
          },
        },
      ],
      [{ throw: true }],
      [
        {
          status: 500,
          body: {
            error: { code: "INTERNAL_ERROR", message: "boom", retryable: true, requestId: "r" },
          },
        },
      ],
    ] as const) {
      const { world } = await makeTransportWorld(script);
      const executor = createClientToolExecutor(world.deps);
      const error = await failureOf(executor.execute("studio.web_search", { query: "q" }));
      expect(error.code).toBe("WEB_SEARCH_UNAVAILABLE");
    }
  });

  it("402 and 429 keep their honest wire codes", async () => {
    const low = await makeTransportWorld([
      {
        status: 402,
        body: {
          error: {
            code: "INSUFFICIENT_CREDITS",
            message: "out of credits",
            retryable: false,
            requestId: "r",
          },
        },
      },
    ]);
    const executorLow = createClientToolExecutor(low.world.deps);
    expect((await failureOf(executorLow.execute("studio.web_search", { query: "q" }))).code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const throttled = await makeTransportWorld([
      {
        status: 429,
        body: {
          error: { code: "RATE_LIMITED", message: "slow down", retryable: true, requestId: "r" },
        },
      },
    ]);
    const executorThrottled = createClientToolExecutor(throttled.world.deps);
    expect(
      (await failureOf(executorThrottled.execute("studio.web_search", { query: "q" }))).code,
    ).toBe("RATE_LIMITED");
  });

  it("a malformed success body is TOOL_FAILED, never a silent pass-through", async () => {
    const { world } = await makeTransportWorld([{ status: 200, body: { data: { nope: 1 } } }]);
    const executor = createClientToolExecutor(world.deps);
    const error = await failureOf(executor.execute("studio.web_search", { query: "q" }));
    expect(error.code).toBe("TOOL_FAILED");
  });
});

describe("studio.generate_image", () => {
  it("returns the base64 image plus the import hint", async () => {
    const { world, calls } = await makeTransportWorld([
      { status: 200, body: { data: { imageBase64: "AAAA" } } },
    ]);
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.generate_image", {
      prompt: "a red cube",
      size: "1024x1024",
    })) as Record<string, unknown>;
    expect(result.imageBase64).toBe("AAAA");
    expect(String(result.hint)).toContain("imported as an asset");
    expect(postedBody(calls[0] as FetchCall)).toEqual({
      prompt: "a red cube",
      size: "1024x1024",
    });
  });

  it("returns the url variant", async () => {
    const { world } = await makeTransportWorld([
      { status: 200, body: { data: { imageUrl: "https://img.example/1.png" } } },
    ]);
    const executor = createClientToolExecutor(world.deps);
    const result = (await executor.execute("studio.generate_image", { prompt: "x" })) as Record<
      string,
      unknown
    >;
    expect(result.imageUrl).toBe("https://img.example/1.png");
  });

  it("501 (not configured) maps to the graceful IMAGE_GENERATION_UNAVAILABLE", async () => {
    const { world } = await makeTransportWorld([
      {
        status: 501,
        body: {
          error: {
            code: "IMAGE_GENERATION_UNAVAILABLE",
            message: "Image generation is not configured for this workspace's deployment.",
            retryable: false,
            requestId: "r",
          },
        },
      },
    ]);
    const executor = createClientToolExecutor(world.deps);
    const error = await failureOf(executor.execute("studio.generate_image", { prompt: "x" }));
    expect(error.code).toBe("IMAGE_GENERATION_UNAVAILABLE");
    expect(error.message).toContain("not configured");
  });

  it("an empty image body is TOOL_FAILED", async () => {
    const { world } = await makeTransportWorld([{ status: 200, body: { data: {} } }]);
    const executor = createClientToolExecutor(world.deps);
    const error = await failureOf(executor.execute("studio.generate_image", { prompt: "x" }));
    expect(error.code).toBe("TOOL_FAILED");
  });
});

// ---------------------------------------------------------------------------
// studio.render_audio (injected harness — Tone.js never loads here)
// ---------------------------------------------------------------------------

describe("studio.render_audio", () => {
  it("renders → descriptor + signed PUT + verify + url → {assetId, url, durationSeconds}", async () => {
    const world = await makeWorld({
      audioHarness: fakeAudioHarness({ wav: [1, 2, 3, 4], durationSeconds: 4.25 }),
    });
    const putCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const deps: ClientToolExecutorDeps = {
      ...world.deps,
      fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
        putCalls.push({ url, init });
        return { ok: true, status: 200, statusText: "", text: async () => "" } as Response;
      },
    };
    const executor = createClientToolExecutor(deps);
    const result = (await executor.execute("studio.render_audio", {
      name: "riser",
      code: "const s = new Tone.PolySynth().toDestination(); s.triggerAttackRelease('C4','8n',0);",
      duration: 4.25,
    })) as Record<string, unknown>;

    expect(result.assetId).toBe("ast_1");
    expect(result.url).toBe("https://cdn.example/ast_1.wav");
    expect(result.durationSeconds).toBe(4.25);
    expect(result.sampleRate).toBe(44_100);

    // The two-phase seam, exactly: descriptor (sha256 + ns duration) → PUT
    // the bytes to the signed URL → complete (verify) → short-lived url.
    const descriptor = world.assets.calls.descriptors[0] as Record<string, unknown>;
    expect(descriptor.name).toBe("riser.wav");
    expect(descriptor.mime).toBe("audio/wav");
    expect(descriptor.sizeBytes).toBe(4);
    expect(descriptor.durationTicks).toBe(4_250_000_000);
    expect(String(descriptor.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.url).toBe("https://storage.example/signed?token=abc");
    expect(putCalls[0]?.init?.method).toBe("PUT");
    expect(new Uint8Array(putCalls[0]?.init?.body as unknown as ArrayBufferLike)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(world.assets.calls.completes).toEqual(["ast_1"]);
    expect(world.assets.calls.urls).toEqual(["ast_1"]);
  });

  it("harness failures map to RENDER_AUDIO_FAILED with the honest message", async () => {
    const world = await makeWorld({
      audioHarness: fakeAudioHarness({ reject: "Tone.PolySynth is not a constructor" }),
    });
    const executor = createClientToolExecutor(world.deps);
    const error = await failureOf(
      executor.execute("studio.render_audio", { name: "x", code: "new Tone.Nope()" }),
    );
    expect(error.code).toBe("RENDER_AUDIO_FAILED");
    expect(error.message).toContain("Tone.PolySynth is not a constructor");
  });

  it("a render that exceeds the (injectable) timeout is RENDER_AUDIO_FAILED", async () => {
    const world = await makeWorld({
      audioHarness: fakeAudioHarness({ hang: true }),
      audioRenderTimeoutMs: 25,
    });
    const executor = createClientToolExecutor(world.deps);
    const error = await failureOf(
      executor.execute("studio.render_audio", { name: "x", code: "while(true){}" }),
    );
    expect(error.code).toBe("RENDER_AUDIO_FAILED");
  });

  it("an upload failure is RENDER_AUDIO_FAILED; nothing was half-applied", async () => {
    const world = await makeWorld({ audioHarness: fakeAudioHarness() });
    const assets = makeAssetsClient({ failDescriptor: true });
    const executor = createClientToolExecutor({ ...world.deps, client: assets.client });
    const error = await failureOf(
      executor.execute("studio.render_audio", { name: "x", code: "Tone.start()" }),
    );
    expect(error.code).toBe("RENDER_AUDIO_FAILED");
    expect(error.message).toContain("storage quota exceeded");
  });

  it("a duplicate descriptor skips the PUT and verifies nothing", async () => {
    const world = await makeWorld({ audioHarness: fakeAudioHarness() });
    const assets = makeAssetsClient({ duplicate: true });
    const putCalls: string[] = [];
    const deps: ClientToolExecutorDeps = {
      ...world.deps,
      client: assets.client,
      fetchImpl: async (url: string): Promise<Response> => {
        putCalls.push(url);
        return { ok: true, status: 200, statusText: "", text: async () => "" } as Response;
      },
    };
    const executor = createClientToolExecutor(deps);
    const result = (await executor.execute("studio.render_audio", {
      name: "x",
      code: "Tone.start()",
    })) as Record<string, unknown>;
    expect(result.assetId).toBe("ast_dup");
    expect(putCalls).toHaveLength(0);
    expect(assets.calls.completes).toHaveLength(0);
  });
});
