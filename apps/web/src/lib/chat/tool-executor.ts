/**
 * apps/web — the CLIENT-side agent tool executor (M4-SEAMS.md seam 6,
 * PRODUCT_ARCHITECTURE.md §7.4/§8.4; M5 write-tool proposals per §8.4 rules 1–5
 * + docs/phases/M5-SEAMS.md).
 *
 * When the gateway's runner emits a §7.4 `tool.started` event for one of the
 * curated tools, M4-J's wiring hands the call to this executor, which:
 *
 *   1. refuses the RAW engine surface as a tool (`engine.batch`,
 *      `engine.execute`, `edit.undo`, `edit.redo`) with TOOL_FORBIDDEN and
 *      ZERO bridge calls — executing a batch outside the ApplyController
 *      (M5-F) would break law #6 (ONE batch = ONE undo = ONE version),
 *   2. ignores server-side tools (`studio.plan_edit` is the runner's own
 *      structured-output call — posting for a toolCallId it did not register
 *      would 400: the runs route only accepts expected ids),
 *   3. validates args at RUNTIME through `@studio/api-client/chat-tools` —
 *      the one place web may touch contracts' Zod schemas indirectly
 *      (docs/AGENTS.md hard rule 5),
 *   4. executes the 4 editor-read tools against the live bridge (per-item
 *      bridge failures degrade to per-item nulls / NOT_FOUND entries — never
 *      abort),
 *   5. PROPOSES for the 8 write tools (M5, §8.4 rule 1): each gathers just
 *      enough live state to validate (e.g. `set_properties` reads current
 *      values to warn on no-ops) and returns a proposal envelope — a batch
 *      the MODEL may echo into its plan; NOTHING is executed. Executing an
 *      agent batch is the ApplyController's job alone (apply.ts),
 *   6. POSTs `{ type: "tool.result", toolCallId, result }` to
 *      `/v1/runs/:id/events` (RUN_EVENT_REQUEST_SCHEMA — exact shape) with 2
 *      retries on transient failures, then gives up silently: the runner's
 *      `waitForToolResult` times out server-side (EDITOR_DISCONNECTED).
 *
 * NOTHING in this module ever throws — every outcome becomes a posted result.
 * The whole execution races a 20 s guard that posts TOOL_TIMEOUT (each bridge
 * call already carries the bridge's own 15 s timeout).
 *
 * Bridge wire facts (verified against `packages/editor-bridge` +
 * `editor/crates/engine/src/commands/query.rs` + the fake registry):
 *   - `project.summary` `{}` · `comp.info` `{comp?}` · `edit.history.list` `{}`
 *   - `layer.tree` `{layer?, comp?, depth?, time?}` — PER LAYER (layer defaults
 *     to the first selected layer, and the call FAILS without a selection);
 *     `comp` is a comp id or name; `depth` caps the property-tree expansion.
 *   - `prop.get` `{layer?, path|prop, time?}` — layer id/name/`#n`, no comp.
 *   - `renderFrame` `{comp?, time?, max_side?, …}` — `max_side` caps the LONG
 *     side; the result normalizes `png` → `pngBase64`.
 *
 * Proposal-batch command facts (grep-verified in `editor/crates/engine/src`;
 * the plan-compiler (M5-B) stays authoritative — these steps are data for the
 * model, never executed here):
 *   - `comp.new {name,width,height,frameRate,duration}` (comp.rs `new_comp`)
 *   - `layer.newText {comp?,text,name?,position?,<text attrs>}` (layer.rs)
 *   - `prop.set {layer,path,value}` (prop.rs)
 *   - `prop.addKey {layer,path,time,value}` (path_nulls.rs:271)
 *   - `effect.apply {layers:[…],effect}` (path_nulls.rs:265)
 *   - `anim.applyBuiltinPreset {preset,layers?}` (anim_presets.rs:199)
 */

import type { ApiClient } from "@studio/api-client";
import { isApiError } from "@studio/api-client";
import { isClientTool, isWriteTool, validateToolArgs } from "@studio/api-client/chat-tools";
import type { BatchStep, ContextBlockKey, ContextSelection } from "@studio/contracts";
import { type EditorBridge, isBridgeError, messageOf } from "@studio/editor-bridge";

// ---------------------------------------------------------------------------
// Public surface (pinned by M4-SEAMS.md seam 6)
// ---------------------------------------------------------------------------

/** One `tool.started`-shaped call the executor may run (§7.4). */
export interface ClientToolCall {
  readonly runId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolExecutorDeps {
  readonly bridge: EditorBridge;
  readonly client: ApiClient;
  /** Present for the M5 apply path + audit scoping; /v1/runs/:id/events derives the workspace from the session. */
  readonly workspaceId: string;
  /** Per-run context toggles (§5.1) — user-removed blocks are reported, not fetched. */
  readonly flags: ContextSelection;
  /** Whole-call guard in ms (default 20 000; 0 disables — tests inject small values). */
  readonly guardTimeoutMs?: number;
  /** Pause between postEvent retries in ms (default 250; tests inject 0). */
  readonly retrySleepMs?: number;
}

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

/** Bridge error codes that mean "the editor is not answering" (→ EDITOR_DISCONNECTED). */
const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  "EDITOR_DISCONNECTED",
  "EDITOR_NOT_READY",
  "EDITOR_LOAD_FAILED",
  "EDITOR_TIMEOUT",
]);

const DEFAULT_GUARD_MS = 20_000;
const POST_ATTEMPTS = 3; // 1 try + 2 retries on transient failures

/**
 * The RAW engine surface is never a model tool (law #5/#6): a batch or an
 * undo dispatched here would bypass the ApplyController — ONE atomic batch =
 * ONE undo step = ONE version — so the executor refuses them by name with
 * ZERO bridge calls, even though the gateway's own tool validation would
 * already have rejected an unknown tool id (defense in depth).
 */
const RAW_ENGINE_TOOL_IDS: ReadonlySet<string> = new Set([
  "engine.batch",
  "engine.execute",
  "edit.undo",
  "edit.redo",
]);

const RAW_ENGINE_FORBIDDEN_MESSAGE =
  "Raw engine commands are not tools. Use the curated Studio tools; apply a plan to make changes.";

/**
 * The M5 write-tool proposal envelope (§8.4 rule 1: every write tool returns a
 * PROPOSED batch, never an execution). Coded against contracts'
 * WRITE_TOOL_RESULT_SCHEMA (M5-A owns the file; not landed at wave-1 start) —
 * the integrator reconciles the two shapes; every field here is JSON data the
 * model may copy into its plan (the plan-compiler re-validates server-side).
 */
export interface WriteToolProposal {
  /** Always true: NOTHING was executed (the marker the model checks first). */
  readonly proposed: true;
  /** The `studio.*` tool id this proposal answers. */
  readonly tool: string;
  /** Curated, model-readable description of the proposed change. */
  readonly summary: string;
  /** Advisory findings from live state (e.g. a set_properties no-op). */
  readonly warnings?: readonly string[];
  /** The proposed `engine.batch` payload for content tools (§8.4 rule 1). */
  readonly batch?: { readonly label: string; readonly steps: readonly BatchStep[] };
  /** Run-level proposals that are NOT agent batches (undo_run/save_version). */
  readonly action?: "undo_run" | "save_version";
  /** Echo of the args' runId (undo_run only). */
  readonly runId?: string;
  /** Echo of the args' label (save_version only). */
  readonly label?: string;
}

/** Batch labels are capped (`MAX_BATCH_LABEL_LENGTH`); proposals stay under it. */
const PROPOSAL_LABEL_MAX = 280;

function proposalLabel(summary: string): string {
  const label = `Agent: ${summary}`;
  return label.length <= PROPOSAL_LABEL_MAX ? label : `${label.slice(0, PROPOSAL_LABEL_MAX - 1)}…`;
}

/**
 * Dunder keys are never legitimate identifiers (M4-N F-1 + contracts'
 * DUNDER_ID_SCHEMA): identifier-ish write args are rejected BEFORE any
 * bridge call or proposal step is built — model-chosen strings stay data.
 */
function isDunderId(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

/** Structural JSON-ish equality (no key-order, no prototype lookups). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keys = Object.keys(recordA);
  if (keys.length !== Object.keys(recordB).length) return false;
  return keys.every((key) => Object.hasOwn(recordB, key) && jsonEqual(recordA[key], recordB[key]));
}

/**
 * Runs one client tool call end-to-end and reports the outcome as a posted
 * §7.4 tool result. NEVER throws; NEVER posts twice for one call.
 */
export async function executeClientTool(
  call: ClientToolCall,
  deps: ToolExecutorDeps,
): Promise<void> {
  let settled = false;
  const post = async (result: unknown): Promise<void> => {
    if (settled) return; // the guard may win while the work promise still lands
    settled = true;
    await postToolResult(call, deps, result);
  };

  try {
    // 1. The RAW engine surface is never a tool: a batch dispatched here would
    //    bypass the ApplyController (law #6) — refuse by name, zero bridge calls.
    if (RAW_ENGINE_TOOL_IDS.has(call.name)) {
      await post({ error: "TOOL_FORBIDDEN", message: RAW_ENGINE_FORBIDDEN_MESSAGE });
      return;
    }
    // 2. Server-side tools (studio.plan_edit) are the runner's job. The runs
    //    route 400s on a toolCallId it did not register (expected-ids rule), so
    //    posting here would only add noise — return without posting.
    if (!isClientTool(call.name) && !isWriteTool(call.name)) return;

    // 3. Runtime arg validation; the model gets one repair turn server-side.
    const parsed = validateToolArgs(call.name, call.args);
    if (!parsed.ok) {
      await post({ error: "RUN_INVALID_TOOL", message: parsed.error });
      return;
    }

    // 4.+5. Execute (read) or propose (write) under the whole-call guard, then post.
    await runGuarded(call, parsed.value, deps, post);
  } catch {
    // Defensive: an internal bug still reports an honest error result.
    await post({ error: "TOOL_FAILED", message: "The tool could not complete." });
  }
}

/**
 * Executor-factory sugar for M4-J: binds the deps AND guards the toolCallId —
 * the same call (SSE replay after a reconnect, duplicate dispatch) never
 * double-executes or double-posts. Ids are retained for the executor's
 * lifetime (they are unique per run; replays must be no-ops, not re-runs).
 */
export function createToolExecutor(
  deps: ToolExecutorDeps,
): (call: ClientToolCall) => Promise<void> {
  const executed = new Set<string>();
  return (call: ClientToolCall): Promise<void> => {
    if (executed.has(call.toolCallId)) return Promise.resolve();
    executed.add(call.toolCallId);
    return executeClientTool(call, deps);
  };
}

// ---------------------------------------------------------------------------
// Guard + dispatch
// ---------------------------------------------------------------------------

async function runGuarded(
  call: ClientToolCall,
  args: unknown,
  deps: ToolExecutorDeps,
  post: (result: unknown) => Promise<void>,
): Promise<void> {
  const guardMs = deps.guardTimeoutMs ?? DEFAULT_GUARD_MS;
  if (guardMs <= 0) {
    await post(await runTool(call.name, args, deps));
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), guardMs);
  });
  try {
    // Normalized so a late loss of the race can never reject unhandled.
    const work = runTool(call.name, args, deps).then(
      (result) => ({ result }) as const,
      (error: unknown) => ({ error }) as const,
    );
    const first = await Promise.race([work, guard]);
    if (typeof first === "string") {
      await post({
        error: "TOOL_TIMEOUT",
        message: "The editor did not finish the tool call in time.",
      });
      return;
    }
    await post("error" in first ? toolError(first.error) : first.result);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Dispatches a validated tool call (read → execute; write → propose). */
async function runTool(name: string, args: unknown, deps: ToolExecutorDeps): Promise<unknown> {
  if (isWriteTool(name)) return runWriteTool(name, args, deps);
  return runReadTool(name, args, deps);
}

/** Dispatches a validated editor-read call; the returned value is the tool result. */
async function runReadTool(name: string, args: unknown, deps: ToolExecutorDeps): Promise<unknown> {
  try {
    switch (name) {
      case "studio.get_context":
        return await runGetContext(args as { include?: readonly string[] }, deps);
      case "studio.list_layers":
        return await runListLayers(args as { compId?: string; depth?: number }, deps);
      case "studio.get_properties":
        return await runGetProperties(
          args as { layerIds?: readonly string[]; paths?: readonly string[] },
          deps,
        );
      case "studio.render_preview":
        return await runRenderPreview(
          args as { compId?: string; timeSeconds?: number; maxWidth?: number },
          deps,
        );
      default:
        // Unreachable (isClientTool filtered first) — stay honest anyway.
        return { error: "TOOL_FAILED", message: `Not a client tool: ${name}` };
    }
  } catch (error) {
    return toolError(error);
  }
}

// ---------------------------------------------------------------------------
// The 8 write tools — PROPOSE only (§8.4 rule 1; M5). NOTHING executes: the
// only bridge traffic is read queries for live-state validation, and every
// model-chosen string rides the envelope as DATA (values, never keys).
// ---------------------------------------------------------------------------

/** The failure shape the §7.4 wire maps to a failed card + repair turn. */
function invalidTool(message: string): { error: string; message: string } {
  return { error: "RUN_INVALID_TOOL", message };
}

/**
 * Dunder check for identifier-ish args (layer/path/propertyPath/targets and
 * set_properties updates): rejected BEFORE any bridge call or proposal step
 * — the F-1 lesson at the write boundary (contracts' DUNDER_ID_SCHEMA twin).
 */
function rejectDunderIds(ids: readonly string[], what: string): { error: string; message: string } | null {
  if (ids.some(isDunderId)) {
    return invalidTool(`${what}: dunder keys are not valid identifiers`);
  }
  return null;
}

async function runWriteTool(name: string, args: unknown, deps: ToolExecutorDeps): Promise<unknown> {
  try {
    switch (name) {
      case "studio.create_composition":
        return proposeCreateComposition(args as {
          name: string;
          width: number;
          height: number;
          frameRate: number;
          durationSeconds: number;
        });
      case "studio.create_text":
        return proposeCreateText(args as {
          compId?: string;
          text: string;
          name?: string;
          fontSize?: number;
          fontFamily?: string;
          color?: string;
          position?: [number, number];
        });
      case "studio.set_properties":
        return await proposeSetProperties(
          args as {
            updates: ReadonlyArray<{ layer: string; path: string; value: unknown }>;
          },
          deps,
        );
      case "studio.add_effect":
        return proposeAddEffect(args as { layer: string; effect: string; params?: unknown });
      case "studio.set_keyframes":
        return proposeSetKeyframes(
          args as {
            layer: string;
            propertyPath: string;
            keyframes: ReadonlyArray<{ time: number; value: unknown; easing?: string }>;
          },
        );
      case "studio.apply_preset":
        return proposeApplyPreset(args as { preset: string; targets: readonly string[] });
      case "studio.undo_run":
        return proposeUndoRun(args as { runId?: string });
      case "studio.save_version":
        return proposeSaveVersion(args as { label?: string });
      default:
        // Unreachable (isWriteTool filtered first) — stay honest anyway.
        return { error: "TOOL_FAILED", message: `Not a write tool: ${name}` };
    }
  } catch (error) {
    return toolError(error);
  }
}

/** studio.create_composition → `comp.new` (one step; defaults come from Zod). */
function proposeCreateComposition(args: {
  name: string;
  width: number;
  height: number;
  frameRate: number;
  durationSeconds: number;
}): WriteToolProposal {
  const summary = `create composition "${args.name}" (${args.width}×${args.height} @ ${args.frameRate}fps, ${args.durationSeconds}s)`;
  return {
    proposed: true,
    tool: "studio.create_composition",
    summary,
    batch: {
      label: proposalLabel(summary),
      steps: [
        {
          command: "comp.new",
          params: {
            name: args.name,
            width: args.width,
            height: args.height,
            frameRate: args.frameRate,
            duration: args.durationSeconds,
          },
        },
      ],
    },
  };
}

/** studio.create_text → `layer.newText` (curated attrs ride the params as data). */
function proposeCreateText(args: {
  compId?: string;
  text: string;
  name?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  position?: [number, number];
}): WriteToolProposal {
  const summary = `add a text layer${args.name === undefined ? "" : ` "${args.name}"`} with "${args.text}"${
    args.compId === undefined ? "" : ` in composition ${args.compId}`
  }`;
  const params: Record<string, unknown> = { text: args.text };
  if (args.compId !== undefined) params.comp = args.compId;
  if (args.name !== undefined) params.name = args.name;
  if (args.position !== undefined) params.position = args.position;
  if (args.fontSize !== undefined) params.fontSize = args.fontSize;
  if (args.fontFamily !== undefined) params.fontFamily = args.fontFamily;
  if (args.color !== undefined) params.color = args.color;
  return {
    proposed: true,
    tool: "studio.create_text",
    summary,
    batch: {
      label: proposalLabel(summary),
      steps: [{ command: "layer.newText", params }],
    },
  };
}

/**
 * studio.set_properties → one `prop.set` per update. Gathers live state first
 * (prop.get per update — read-only) to warn when an update would be a no-op:
 * the model learns the current value instead of proposing a redundant change.
 */
async function proposeSetProperties(
  args: { updates: ReadonlyArray<{ layer: string; path: string; value: unknown }> },
  deps: ToolExecutorDeps,
): Promise<WriteToolProposal | { error: string; message: string }> {
  const dunder = rejectDunderIds(
    [...args.updates.map((update) => update.layer), ...args.updates.map((update) => update.path)],
    "updates",
  );
  if (dunder !== null) return dunder;

  const current = await mapLimit(args.updates, 4, async (update) =>
    quiet(() => deps.bridge.query<{ value?: unknown }>("prop.get", { layer: update.layer, path: update.path })),
  );
  const warnings: string[] = [];
  args.updates.forEach((update, index) => {
    const now = current[index];
    if (now !== null && now !== undefined && jsonEqual(update.value, now.value)) {
      warnings.push(
        `layer "${update.layer}" property "${update.path}" is already ${JSON.stringify(update.value)} — this update would change nothing`,
      );
    }
  });

  const summary = `set ${args.updates.length} propert${args.updates.length === 1 ? "y" : "ies"} on ${args.updates.length === 1 ? `layer "${args.updates[0]?.layer}"` : `${args.updates.length} layers`}`;
  return {
    proposed: true,
    tool: "studio.set_properties",
    summary,
    ...(warnings.length > 0 ? { warnings } : {}),
    batch: {
      label: proposalLabel(summary),
      steps: args.updates.map((update) => ({
        command: "prop.set",
        params: { layer: update.layer, path: update.path, value: update.value },
      })),
    },
  };
}

/** studio.add_effect → `effect.apply` (the registry effect id rides as data). */
function proposeAddEffect(args: {
  layer: string;
  effect: string;
  params?: unknown;
}): WriteToolProposal | { error: string; message: string } {
  const dunder = rejectDunderIds([args.layer], "layer");
  if (dunder !== null) return dunder;
  const summary = `add effect "${args.effect}" to layer "${args.layer}"`;
  const effectParams: Record<string, unknown> =
    typeof args.params === "object" && args.params !== null && !Array.isArray(args.params)
      ? (args.params as Record<string, unknown>)
      : {};
  return {
    proposed: true,
    tool: "studio.add_effect",
    summary,
    batch: {
      label: proposalLabel(summary),
      steps: [
        {
          command: "effect.apply",
          params: { layers: [args.layer], effect: args.effect, ...effectParams },
        },
      ],
    },
  };
}

/** studio.set_keyframes → one `prop.addKey` per keyframe (easing stays in the summary). */
function proposeSetKeyframes(args: {
  layer: string;
  propertyPath: string;
  keyframes: ReadonlyArray<{ time: number; value: unknown; easing?: string }>;
}): WriteToolProposal | { error: string; message: string } {
  const dunder = rejectDunderIds([args.layer, args.propertyPath], "layer/propertyPath");
  if (dunder !== null) return dunder;
  const easings = [
    ...new Set(args.keyframes.map((keyframe) => keyframe.easing).filter((easing): easing is string => easing !== undefined)),
  ];
  const summary = `set ${args.keyframes.length} keyframe${args.keyframes.length === 1 ? "" : "s"} on layer "${args.layer}" property "${args.propertyPath}"${
    easings.length > 0 ? ` (${easings.join("/")} easing)` : ""
  }`;
  return {
    proposed: true,
    tool: "studio.set_keyframes",
    summary,
    batch: {
      label: proposalLabel(summary),
      steps: args.keyframes.map((keyframe) => ({
        command: "prop.addKey",
        params: { layer: args.layer, path: args.propertyPath, time: keyframe.time, value: keyframe.value },
      })),
    },
  };
}

/** studio.apply_preset → `anim.applyBuiltinPreset` per target layer. */
function proposeApplyPreset(args: {
  preset: string;
  targets: readonly string[];
}): WriteToolProposal | { error: string; message: string } {
  const dunder = rejectDunderIds(args.targets, "targets");
  if (dunder !== null) return dunder;
  const summary = `apply preset "${args.preset}" to ${args.targets.length} layer${args.targets.length === 1 ? "" : "s"}`;
  return {
    proposed: true,
    tool: "studio.apply_preset",
    summary,
    batch: {
      label: proposalLabel(summary),
      steps: args.targets.map((target) => ({
        command: "anim.applyBuiltinPreset",
        params: { layers: [target], preset: args.preset },
      })),
    },
  };
}

/**
 * studio.undo_run — a RUN-level proposal, not an agent batch: undoing is the
 * ApplyController's `edit.undo` (one step for the whole run) and the run's
 * version remains in project history (§9.3). No batch steps are proposed.
 */
function proposeUndoRun(args: { runId?: string }): WriteToolProposal {
  return {
    proposed: true,
    tool: "studio.undo_run",
    summary: `revert the ${args.runId === undefined ? "most recent applied" : "applied"} agent run as a single undo step — its version stays in project history`,
    action: "undo_run",
    ...(args.runId !== undefined ? { runId: args.runId } : {}),
  };
}

/**
 * studio.save_version — a RUN-level proposal, not an agent batch: a snapshot
 * is a cloud-side immutable version (§9.2), never an engine command.
 */
function proposeSaveVersion(args: { label?: string }): WriteToolProposal {
  return {
    proposed: true,
    tool: "studio.save_version",
    summary: `save an immutable snapshot of the project${args.label === undefined ? "" : ` labeled "${args.label}"`} — no project content changes`,
    action: "save_version",
    ...(args.label !== undefined ? { label: args.label } : {}),
  };
}

/** Bridge/editor failure → the §7.4 failure result the model sees (seam 6). */
function toolError(error: unknown): { error: string; message: string } {
  const code =
    isBridgeError(error) && DISCONNECT_CODES.has(error.code)
      ? "EDITOR_DISCONNECTED"
      : "TOOL_FAILED";
  return { error: code, message: messageOf(error) };
}

// ---------------------------------------------------------------------------
// studio.get_context — flags-gated + args-include-gated project snapshot
// ---------------------------------------------------------------------------

async function runGetContext(
  args: { include?: readonly string[] },
  deps: ToolExecutorDeps,
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

// ---------------------------------------------------------------------------
// studio.list_layers — a composition's layers (+ per-layer trees at depth)
// ---------------------------------------------------------------------------

/**
 * `layer.tree` is a PER-LAYER query (layer defaults to the first selected
 * layer and fails without a selection), so the composition-wide listing the
 * tool promises (§8.4: "layer ids, names and types") is assembled from:
 *   1. `comp.info {comp}` — the authoritative layer list,
 *   2. `layer.tree {comp, layer, depth}` per layer — the depth-capped trees.
 * Per-layer tree failures degrade to `tree: null`; the listing still posts.
 */
async function runListLayers(
  args: { compId?: string; depth?: number },
  deps: ToolExecutorDeps,
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

// ---------------------------------------------------------------------------
// studio.get_properties — prop.get per {layer, path} (bounded concurrency)
// ---------------------------------------------------------------------------

async function runGetProperties(
  args: { layerIds?: readonly string[]; paths?: readonly string[] },
  deps: ToolExecutorDeps,
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

// ---------------------------------------------------------------------------
// studio.render_preview — one frame, capped at 1200 px on the long side
// ---------------------------------------------------------------------------

async function runRenderPreview(
  args: { compId?: string; timeSeconds?: number; maxWidth?: number },
  deps: ToolExecutorDeps,
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
// Result POST (RUN_EVENT_REQUEST_SCHEMA, exact) + transient retries
// ---------------------------------------------------------------------------

async function postToolResult(
  call: ClientToolCall,
  deps: ToolExecutorDeps,
  result: unknown,
): Promise<void> {
  // Exact RUN_EVENT_REQUEST_SCHEMA "tool.result" arm — strictObject, no extras.
  const body = { type: "tool.result" as const, toolCallId: call.toolCallId, result };
  // Same logical mutation across retries (law #4): one key per run+toolCall.
  const idempotencyKey = `toolresult:${call.runId}:${call.toolCallId}`.slice(0, 128);
  const sleepMs = deps.retrySleepMs ?? 250;

  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
    try {
      await deps.client.runs.postEvent(call.runId, body, { idempotencyKey });
      return;
    } catch (error) {
      // Give up silently: the runner's waitForToolResult (30 s) eventually
      // fails the run EDITOR_DISCONNECTED server-side — nothing left to do.
      if (attempt === POST_ATTEMPTS || !isTransientPostFailure(error)) return;
      if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
}

/** Network-ish (status 0), 408/429 and 5xx responses are transient; 4xx are answers, not flukes. */
function isTransientPostFailure(error: unknown): boolean {
  if (isApiError(error)) {
    return (
      error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500
    );
  }
  return true; // unknown shape (e.g. a stubbed fetch in tests) — retry defensively
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
