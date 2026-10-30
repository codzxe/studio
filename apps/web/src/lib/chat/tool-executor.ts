/**
 * apps/web — the CLIENT-side agent tool executor v2 (round-12 client-driven
 * loop, docs/research/round12-design.md "Tool catalog v3"; M4-SEAMS seam 6 for the
 * four curated editor reads).
 *
 * THE CONTRACT FLIP: the old executor POSTed every outcome to
 * `/v1/runs/:id/events` because the model loop lived in the gateway runner.
 * Round 12 moved the loop to the CLIENT — the controller now consumes the
 * tool result DIRECTLY and echoes it into the next turn, so:
 *
 *   - `execute(tool, args)` RESOLVES with the tool result, or
 *   - THROWS `ClientToolError {code, message}` — the typed failure the
 *     controller turns into the tool_result part (the model sees a graceful,
 *     explainable error; the run continues). No POSTing, no retries, no
 *     server-side waitForToolResult — the entire /v1/runs/:id/events back
 *     channel is GONE for tool results.
 *
 * What the executor runs (handles() mirrors the v3 catalog's client-executed
 * tools — read + generative; kind "read" generative tools mutate NO canvas
 * state):
 *   - the 4 curated editor reads against the live bridge (unchanged bodies:
 *     per-block/per-item degradation, never abort) — get_context,
 *     list_layers, get_properties, render_preview;
 *   - studio.list_commands / studio.describe_command — the ALLOWED catalog
 *     discovery pair over the bridge's `command.list` / `command.describe`
 *     query ids (tools/catalog-queries.ts);
 *   - studio.web_search / studio.generate_image — POST to the gateway's
 *     metered tool endpoints `/v1/threads/:id/tools/...` through the same
 *     authenticated transport `runs.postEvent` used to use (same-origin
 *     `/v1`, cookie session + `x-workspace-id` + `Idempotency-Key`; the
 *     api-client's impl keeps its generic POST seam private, so the call is
 *     local — the apps/web session-client direct-fetch precedent), mapping
 *     503 → WEB_SEARCH_UNAVAILABLE and 501 → IMAGE_GENERATION_UNAVAILABLE so
 *     the model gets a graceful typed answer, never a run failure;
 *   - studio.render_audio — Tone.js offline synthesis → WAV → the existing
 *     two-phase asset upload seam (tools/audio-render.ts; the Tone harness
 *     is injectable so tests never load Tone).
 *
 * STILL REFUSED, zero bridge calls (law #5/#6, defense in depth behind the
 * gateway's own validation): the RAW engine surface as a tool name
 * (`engine.batch`, `engine.execute`, `edit.undo`, `edit.redo`) and every
 * write tool — writes resolve SERVER-side as proposals; the client executes
 * them only through the ApplyController (apply.ts), ONE atomic batch = ONE
 * undo = ONE version.
 *
 * Bridge wire facts (unchanged; verified against `packages/editor-bridge` +
 * `editor/crates/engine/src/commands/query.rs` + the fake registry):
 *   - `project.summary` `{}` · `comp.info` `{comp?}` · `edit.history.list` `{}`
 *   - `layer.tree` `{layer?, comp?, depth?, time?}` — PER LAYER
 *   - `prop.get` `{layer?, path|prop, time?}` · `renderFrame` `max_side ≤ 1200`
 *   - `command.list` `{}` · `command.describe` `{command}` — query ids the web
 *     bridge's generic `query` seam reaches on every dist that has them.
 */

import { sha256Hex } from "@/lib/editor-session";
import type { ApiClient, FetchLike } from "@studio/api-client";
import { isWriteTool, validateToolArgs } from "@studio/api-client/chat-tools";
import type { ContextBlockKey, ContextSelection } from "@studio/contracts";
import { type EditorBridge, isBridgeError, messageOf } from "@studio/editor-bridge";

import { type AudioRenderHarness, renderAudioAsset } from "./tools/audio-render";
import { runDescribeCommand, runListCommands } from "./tools/catalog-queries";
import { ClientToolError, isClientToolError } from "./tools/client-tool-error";

// The pinned typed failure — re-exported so the chat controller (i4) imports
// it from the seam it already knows (tool-executor): `new ClientToolError(code,
// message)` is what `execute` THROWS and `isClientToolError` narrows.
export { ClientToolError, isClientToolError } from "./tools/client-tool-error";
export type { AudioRenderHarness } from "./tools/audio-render";

// ---------------------------------------------------------------------------
// Public surface (pinned by the round-12 chat controller)
// ---------------------------------------------------------------------------

/**
 * Everything the executor needs for one run: the live bridge, the api-client
 * (render_audio's asset upload), the thread/run the tool calls belong to, the
 * per-run context toggles (§5.1) and the optional test seams.
 */
export interface ClientToolExecutorDeps {
  /** The live editor bridge (editor reads + catalog queries). */
  readonly bridge: EditorBridge;
  /** The api-client (asset upload for render_audio). */
  readonly client: ApiClient;
  /** Audit scoping + the `x-workspace-id` header the tools routes require. */
  readonly workspaceId: string;
  /** The chat thread the run belongs to (web_search/generate_image paths). */
  readonly threadId: string;
  /** The client-generated run id (idempotency keys, asset provenance). */
  readonly runId: string;
  /** Per-run context toggles (§5.1) — user-removed blocks are reported, not fetched. */
  readonly flags: ContextSelection;
  /** Whole-call guard for the bridge tools in ms (default 20 000; 0 disables — tests inject small values). */
  readonly guardTimeoutMs?: number;
  /** Authenticated transport for the tools endpoints (tests); defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
  /** render_audio renderer seam (tests); defaults to the real Tone.js harness. */
  readonly audioHarness?: AudioRenderHarness;
  /** render_audio render-timeout override (tests); default 20 000. */
  readonly audioRenderTimeoutMs?: number;
}

/** The client-executed tools (the v3 catalog's read + generative surface). */
const HANDLED_TOOLS: ReadonlySet<string> = new Set([
  "studio.get_context",
  "studio.list_layers",
  "studio.get_properties",
  "studio.render_preview",
  "studio.list_commands",
  "studio.describe_command",
  "studio.web_search",
  "studio.render_audio",
  "studio.generate_image",
]);

/** The executor (pinned interface — the chat controller codes against this). */
export interface ClientToolExecutor {
  /** Runs one tool call; RESOLVES with the result or THROWS ClientToolError. */
  execute(tool: string, args: unknown): Promise<unknown>;
  /** `true` for the nine client-executed tools (never write tools). */
  handles(tool: string): boolean;
}

export function createClientToolExecutor(deps: ClientToolExecutorDeps): ClientToolExecutor {
  return {
    handles: (tool) => HANDLED_TOOLS.has(tool),

    async execute(tool, args) {
      // 1. The RAW engine surface is never a tool (law #5/#6): a batch or an
      //    undo dispatched here would bypass the ApplyController — refuse by
      //    name, ZERO bridge calls.
      if (RAW_ENGINE_TOOL_IDS.has(tool)) {
        throw new ClientToolError("TOOL_FORBIDDEN", RAW_ENGINE_FORBIDDEN_MESSAGE);
      }
      // 2. Write tools never execute client-side — the gateway resolves them
      //    SERVER-side as proposals; the client executes them only at Apply.
      if (isWriteTool(tool)) {
        throw new ClientToolError(
          "TOOL_FORBIDDEN",
          "Write tools are proposal-only; the plan card applies them.",
        );
      }
      // 3. Unknown/server-side tools (studio.plan_edit among them) are not
      //    this executor's — fail closed instead of guessing.
      if (!HANDLED_TOOLS.has(tool)) {
        throw new ClientToolError("TOOL_FORBIDDEN", `"${tool}" is not a client-executed tool.`);
      }

      // 4. Runtime arg validation through the api-client chat-tools seam (the
      //    one place web may touch contracts' Zod schemas — the model gets
      //    one repair turn).
      const parsed = validateToolArgs(tool, args);
      if (!parsed.ok) {
        throw new ClientToolError("RUN_INVALID_TOOL", parsed.error);
      }

      // 5. Dispatch. Bridge tools race the whole-call guard; the gateway
      //    tools carry their own signal timeouts; render_audio has its own
      //    20 s render race.
      switch (tool) {
        case "studio.get_context":
          return await runGuarded(deps, (d) =>
            runGetContext(parsed.value as { include?: readonly string[] }, d),
          );
        case "studio.list_layers":
          return await runGuarded(deps, (d) =>
            runListLayers(parsed.value as { compId?: string; depth?: number }, d),
          );
        case "studio.get_properties":
          return await runGuarded(deps, (d) =>
            runGetProperties(
              parsed.value as { layerIds?: readonly string[]; paths?: readonly string[] },
              d,
            ),
          );
        case "studio.render_preview":
          return await runGuarded(deps, (d) =>
            runRenderPreview(
              parsed.value as { compId?: string; timeSeconds?: number; maxWidth?: number },
              d,
            ),
          );
        case "studio.list_commands":
          return await runGuarded(deps, (d) =>
            runListCommands(parsed.value as { category?: string }, d.bridge),
          );
        case "studio.describe_command":
          return await runGuarded(deps, (d) =>
            runDescribeCommand(parsed.value as { command: string }, d.bridge),
          );
        case "studio.web_search":
          return await runWebSearch(parsed.value as { query: string; maxResults?: number }, deps);
        case "studio.generate_image":
          return await runGenerateImage(parsed.value as { prompt: string; size?: string }, deps);
        case "studio.render_audio":
          return await renderAudioAsset(
            parsed.value as { name: string; code: string; duration?: number },
            {
              client: deps.client,
              ...(deps.audioHarness === undefined ? {} : { harness: deps.audioHarness }),
              ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
              ...(deps.audioRenderTimeoutMs === undefined
                ? {}
                : { renderTimeoutMs: deps.audioRenderTimeoutMs }),
            },
          );
        default:
          // Unreachable (HANDLED_TOOLS filtered) — stay honest anyway.
          throw new ClientToolError("TOOL_FAILED", `Not a client tool: ${tool}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Guard + error mapping
// ---------------------------------------------------------------------------

const DEFAULT_GUARD_MS = 20_000;

/** Bridge error codes that mean "the editor is not answering". */
const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  "EDITOR_DISCONNECTED",
  "EDITOR_NOT_READY",
  "EDITOR_LOAD_FAILED",
  "EDITOR_TIMEOUT",
]);

/**
 * The RAW engine surface is never a model tool (law #5/#6) — refused by name
 * with ZERO bridge calls even though the gateway would already have rejected
 * an unknown id (defense in depth).
 */
const RAW_ENGINE_TOOL_IDS: ReadonlySet<string> = new Set([
  "engine.batch",
  "engine.execute",
  "edit.undo",
  "edit.redo",
]);

const RAW_ENGINE_FORBIDDEN_MESSAGE =
  "Raw engine commands are not tools. Use the curated Studio tools; apply a plan to make changes.";

/** Bridge/editor failure → the typed ClientToolError (disconnect codes named). */
function toolError(error: unknown): ClientToolError {
  const code =
    isBridgeError(error) && DISCONNECT_CODES.has(error.code)
      ? "EDITOR_DISCONNECTED"
      : "TOOL_FAILED";
  return new ClientToolError(code, messageOf(error));
}

/** Races a bridge tool against the whole-call guard (default 20 s). */
async function runGuarded(
  deps: ClientToolExecutorDeps,
  run: (deps: ClientToolExecutorDeps) => Promise<unknown>,
): Promise<unknown> {
  const guardMs = deps.guardTimeoutMs ?? DEFAULT_GUARD_MS;
  if (guardMs <= 0) {
    try {
      return await run(deps);
    } catch (error) {
      if (isClientToolError(error)) throw error;
      throw toolError(error);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), guardMs);
  });
  try {
    // Normalized so a late loss of the race can never reject unhandled.
    const work = run(deps).then(
      (result) => ({ result }) as const,
      (error: unknown) => ({ error }) as const,
    );
    const first = await Promise.race([work, guard]);
    if (typeof first === "string") {
      throw new ClientToolError("TOOL_TIMEOUT", "The editor did not finish the tool call in time.");
    }
    if ("error" in first) {
      // Typed tool failures (UNKNOWN_COMMAND, …) pass through untouched —
      // only raw bridge failures go through the disconnect mapping.
      if (isClientToolError(first.error)) throw first.error;
      throw toolError(first.error);
    }
    return first.result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The 4 curated editor reads (bodies unchanged from the M4 executor — only
// the result plumbing flipped from "post" to "resolve")
// ---------------------------------------------------------------------------

/** Marker for a block the user removed in the Context popover (§5.3). */
const REMOVED_BY_USER = "removed by user";

/** Curated default property paths (§8.3 budget: ≤12) when a call names none. */
const DEFAULT_PROP_PATHS: readonly string[] = [
  "transform/anchor",
  "transform/position",
  "transform/scale",
  "transform/rotation",
  "transform/opacity",
  "text/sourceText",
];

async function runGetContext(
  args: { include?: readonly string[] },
  deps: ClientToolExecutorDeps,
): Promise<unknown> {
  const include = args.include;
  const wants = (block: ContextBlockKey): boolean =>
    include === undefined || include.includes(block);

  // One ui.inspect anchors the ui-derived blocks; a failure nulls just those.
  const inspect = await quiet(() => deps.bridge.inspect());
  const activeCompId = inspect?.activeComp ?? null;
  const selected = inspect?.selectedLayers ?? [];

  const result: Record<string, unknown> = {};
  // Key order matches the §8.3 context table.

  if (wants("projectSummary")) {
    result.projectSummary = await flagOrRemoved(deps.flags.projectSummary, () =>
      quiet(() => deps.bridge.query("project.summary")),
    );
  }

  if (wants("activeComp")) {
    result.activeComp = await flagOrRemoved(deps.flags.activeComp, async () => {
      if (activeCompId === null) return null;
      return quiet(() => deps.bridge.query("comp.info", { comp: activeCompId }));
    });
  }

  if (wants("selection")) {
    result.selection = await flagOrRemoved(deps.flags.selection, async () => {
      const first = selected[0];
      if (selected.length === 0 || activeCompId === null || first === undefined) {
        return { layerIds: selected, tree: null };
      }
      const tree = await quiet(() =>
        deps.bridge.query("layer.tree", { comp: activeCompId, layer: first, depth: 2 }),
      );
      return { layerIds: selected, tree };
    });
  }

  if (wants("playhead")) {
    result.playhead = await flagOrRemoved(deps.flags.playhead, async () =>
      inspect === null ? null : { timeSeconds: inspect.time, playing: inspect.playing },
    );
  }

  if (wants("focusedPanel")) {
    result.focusedPanel = await flagOrRemoved(
      deps.flags.focusedPanel,
      async () => inspect?.focusedPanel ?? null,
    );
  }

  if (wants("selectedProperties")) {
    result.selectedProperties = await flagOrRemoved(deps.flags.selectedProperties, async () => {
      const first = selected[0];
      if (selected.length === 0 || activeCompId === null || first === undefined) return null;
      return quiet(() => readSelectedProperties(deps.bridge, first));
    });
  }

  if (wants("recentCommands")) {
    result.recentCommands = await flagOrRemoved(deps.flags.recentCommands, () =>
      quiet(async () => {
        const history = await deps.bridge.query<{ states?: unknown; current?: unknown }>(
          "edit.history.list",
        );
        if (history === null || typeof history !== "object" || !Array.isArray(history.states))
          return null;
        return { current: history.current ?? null, recent: history.states.slice(-10) };
      }),
    );
  }

  return result;
}

/** Enabled blocks get data (null on bridge failure); user-removed blocks get the marker. */
async function flagOrRemoved(enabled: boolean, build: () => Promise<unknown>): Promise<unknown> {
  if (!enabled) return REMOVED_BY_USER;
  return await build();
}

/** prop.get for the first selected layer over the curated paths (§8.3 ≤12). */
async function readSelectedProperties(bridge: EditorBridge, layerId: number): Promise<unknown> {
  const properties: Record<string, unknown> = {};
  await mapLimit(DEFAULT_PROP_PATHS, 4, async (path) => {
    properties[path] = await quiet(() => bridge.query("prop.get", { layer: layerId, path }));
  });
  return { layerId, properties };
}

/**
 * `layer.tree` is a PER-LAYER query (layer defaults to the first selected
 * layer and fails without a selection), so the composition-wide listing the
 * tool promises (§8.4) is assembled from `comp.info {comp}` + per-layer trees.
 */
async function runListLayers(
  args: { compId?: string; depth?: number },
  deps: ClientToolExecutorDeps,
): Promise<unknown> {
  const compParam = args.compId;
  const depth = args.depth ?? 2;
  const info = await deps.bridge.query<Record<string, unknown>>(
    "comp.info",
    compParam === undefined ? {} : { comp: compParam },
  );
  const layersIn = Array.isArray(info?.layers) ? info.layers : [];
  const compRef = typeof info?.id === "number" ? info.id : compParam;

  const layers = await mapLimit(layersIn, 4, async (entry) => {
    const layer = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const id = typeof layer.id === "number" ? layer.id : null;
    const tree =
      id === null || compRef === undefined
        ? null
        : await quiet(() => deps.bridge.query("layer.tree", { comp: compRef, layer: id, depth }));
    return { ...layer, tree };
  });

  return {
    comp: compactComp(info),
    layers,
  };
}

/** The comp header worth showing the model (the full info rides in get_context). */
function compactComp(info: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    id: typeof info?.id === "number" ? info.id : null,
    name: typeof info?.name === "string" ? info.name : null,
    width: typeof info?.width === "number" ? info.width : null,
    height: typeof info?.height === "number" ? info.height : null,
    frameRate: typeof info?.frameRate === "number" ? info.frameRate : null,
    duration: typeof info?.duration === "number" ? info.duration : null,
  };
}

async function runGetProperties(
  args: { layerIds?: readonly string[]; paths?: readonly string[] },
  deps: ClientToolExecutorDeps,
): Promise<unknown> {
  const layerIds = args.layerIds ?? [];
  const paths =
    args.paths === undefined || args.paths.length === 0 ? DEFAULT_PROP_PATHS : args.paths;

  // Flat pairs → bounded concurrency 4; a missing layer/path degrades to a
  // per-item {error:"NOT_FOUND"} entry (never abort, never drop the batch).
  const pairs: Array<{ layer: string; path: string }> = [];
  for (const layer of layerIds) {
    for (const path of paths) pairs.push({ layer, path });
  }

  // Null-prototype accumulators (M4-N F-1 fix): layer ids and property paths
  // are MODEL-CHOSEN strings — on a plain `{}` a `__proto__` key would hit the
  // accessor and write through to Object.prototype. On null-prototype objects
  // every key is inert data; hostile ids survive as data, the prototype is
  // untouchable.
  const layers: Record<string, Record<string, unknown>> = Object.create(null);
  await mapLimit(pairs, 4, async (pair) => {
    let entry: Record<string, unknown> | undefined = layers[pair.layer];
    if (entry === undefined) {
      entry = Object.create(null) as Record<string, unknown>;
      layers[pair.layer] = entry;
    }
    entry[pair.path] = await propOrNotFound(deps.bridge, pair.layer, pair.path);
  });

  return { layers };
}

/** prop.get for one {layer, path}; a missing layer/path is a NOT_FOUND entry, never an abort. */
async function propOrNotFound(
  bridge: EditorBridge,
  layer: string,
  path: string,
): Promise<{ error: "NOT_FOUND" } | unknown> {
  try {
    return await bridge.query("prop.get", { layer, path });
  } catch {
    return { error: "NOT_FOUND" };
  }
}

async function runRenderPreview(
  args: { compId?: string; timeSeconds?: number; maxWidth?: number },
  deps: ClientToolExecutorDeps,
): Promise<unknown> {
  const frame = await deps.bridge.renderFrame({
    comp: args.compId,
    time: args.timeSeconds,
    max_side: Math.min(args.maxWidth ?? 1200, 1200),
  });
  return {
    comp: frame.comp,
    time: frame.time,
    width: frame.width,
    height: frame.height,
    pngBase64: frame.pngBase64 ?? null,
  };
}

// ---------------------------------------------------------------------------
// Gateway tool endpoints (web_search / generate_image)
// ---------------------------------------------------------------------------

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** Per-endpoint transport bounds (the provider calls are 30 s server-side). */
const WEB_SEARCH_TIMEOUT_MS = 20_000;
const GENERATE_IMAGE_TIMEOUT_MS = 45_000;

/** The §7.3 envelope, restated (apps/web imports contracts as types only). */
interface WireEnvelope {
  readonly data?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

/**
 * POST `/v1/threads/:threadId/tools/:tool` on the same authenticated
 * transport `runs.postEvent` used to ride (same-origin cookies +
 * `x-workspace-id` — requireWorkspace reads it — + a deterministic
 * `Idempotency-Key` per logical call, so a retried call replays instead of
 * double-charging). The api-client's impl keeps its generic POST seam
 * private, so the envelope unwrap is local (the gateway.ts precedent).
 */
async function postThreadTool(
  deps: ClientToolExecutorDeps,
  tool: "web_search" | "generate_image",
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const path = `${API_BASE_URL}/threads/${encodeURIComponent(deps.threadId)}/tools/${tool}`;

  // One stable key per logical call: same run + same tool + same args →
  // replays the stored outcome server-side (§7.2; the tools route namespaces
  // its charge key by this header).
  const argsHash = await sha256OfJson(body);
  const idempotencyKey = `tool:${deps.runId}:${tool}:${argsHash}`.slice(0, 128);

  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-workspace-id": deps.workspaceId,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network/timeout/abort — for these metered tools that is "unavailable",
    // never a run failure (the model explains and moves on).
    throw unavailableError(
      tool,
      tool === "web_search"
        ? "Web search is not available right now."
        : "Image generation is not available right now.",
    );
  }

  const json = await parseEnvelope(response);
  if (json.error !== undefined) {
    throw envelopeError(tool, response.status, json.error);
  }
  if (!response.ok || json.data === undefined) {
    throw envelopeError(tool, response.status, {
      message: `The tool endpoint answered HTTP ${response.status}.`,
    });
  }
  return json.data;
}

/** sha256 hex of the canonical JSON of `value`, truncated for a wire key. */
async function sha256OfJson(value: unknown): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(JSON.stringify(value ?? {})))).slice(0, 16);
}

/** Reads the §7.3 envelope (or an empty stand-in for non-JSON bodies). */
async function parseEnvelope(response: Response): Promise<WireEnvelope> {
  const text = await response.text().catch(() => "");
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) return parsed as WireEnvelope;
    return {};
  } catch {
    return {};
  }
}

/** The graceful typed failure for a tool that is not configured/reachable. */
function unavailableError(tool: "web_search" | "generate_image", message: string): ClientToolError {
  return new ClientToolError(
    tool === "web_search" ? "WEB_SEARCH_UNAVAILABLE" : "IMAGE_GENERATION_UNAVAILABLE",
    message,
  );
}

/** Maps an Err envelope / non-2xx to the honest typed failure for this tool. */
function envelopeError(
  tool: "web_search" | "generate_image",
  status: number,
  error: { readonly code?: unknown; readonly message?: unknown },
): ClientToolError {
  const code = typeof error.code === "string" && error.code.length > 0 ? error.code : undefined;
  const message =
    typeof error.message === "string" && error.message.length > 0
      ? error.message
      : `The tool endpoint failed (HTTP ${status}).`;

  // The pinned graceful mappings (round-12 design): the model sees a typed
  // "unavailable" result and the run continues.
  if (tool === "web_search" && (status >= 500 || code === "WEB_SEARCH_UNAVAILABLE")) {
    return unavailableError("web_search", message);
  }
  if (
    tool === "generate_image" &&
    (status === 501 || status >= 500 || code === "IMAGE_GENERATION_UNAVAILABLE")
  ) {
    return unavailableError("generate_image", message);
  }
  // Honest typed passthrough for the statuses the model can act on.
  if (status === 402 || code === "INSUFFICIENT_CREDITS") {
    return new ClientToolError("INSUFFICIENT_CREDITS", message);
  }
  if (status === 429 || code === "RATE_LIMITED") {
    return new ClientToolError("RATE_LIMITED", message);
  }
  return new ClientToolError("TOOL_FAILED", message);
}

/** studio.web_search → `{ results: [{title, url, content}] }` (metered 1 credit). */
async function runWebSearch(
  args: { query: string; maxResults?: number },
  deps: ClientToolExecutorDeps,
): Promise<unknown> {
  const data = (await postThreadTool(
    deps,
    "web_search",
    { query: args.query, maxResults: args.maxResults },
    WEB_SEARCH_TIMEOUT_MS,
  )) as Record<string, unknown> | null;
  if (data === null || typeof data !== "object" || !Array.isArray(data.results)) {
    throw new ClientToolError("TOOL_FAILED", "The search response was malformed.");
  }
  return { results: data.results };
}

/**
 * studio.generate_image → `{ imageBase64? | imageUrl? }` + the honest import
 * hint: the image is NOT in the project yet.
 */
async function runGenerateImage(
  args: { prompt: string; size?: string },
  deps: ClientToolExecutorDeps,
): Promise<unknown> {
  const data = (await postThreadTool(
    deps,
    "generate_image",
    { prompt: args.prompt, ...(args.size === undefined ? {} : { size: args.size }) },
    GENERATE_IMAGE_TIMEOUT_MS,
  )) as Record<string, unknown> | null;
  if (data === null || typeof data !== "object") {
    throw new ClientToolError("TOOL_FAILED", "The image response was malformed.");
  }
  const imageBase64 = typeof data.imageBase64 === "string" ? data.imageBase64 : undefined;
  const imageUrl = typeof data.imageUrl === "string" ? data.imageUrl : undefined;
  if (imageBase64 === undefined && imageUrl === undefined) {
    throw new ClientToolError("TOOL_FAILED", "The image response carried no image.");
  }
  return {
    ...(imageBase64 === undefined ? {} : { imageBase64 }),
    ...(imageUrl === undefined ? {} : { imageUrl }),
    hint: "This image is not in the project yet. It must be imported as an asset (via a later add_asset/engine import step) before it can be placed on a layer.",
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** `null` on any failure — per-item/per-block degradation, never abort. */
async function quiet<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/** `map` with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
