/**
 * The deterministic fake editor (task W1-d): an in-memory implementation of the
 * `window.effectcraft` surface for unit tests and E2E fixtures. Also the basis
 * for the later Playwright mock mode: install the returned object as
 * `window.effectcraft` in a test page and drive it with `script()`.
 *
 * It mirrors the verified upstream semantics, not just the shape:
 * - `request` rejects with plain strings (editor/apps/effectcraft-web/src/api.rs).
 * - `addFile` keeps only the last path segment of the name
 *   (`editor/apps/effectcraft-web/src/files.rs` `path_for`).
 * - `engine.batch` resolves `$N.key` references, rolls back a failing atomic
 *   batch, and folds the run into ONE undo step whose label is the batch label
 *   (editor/crates/engine/src/commands/batch.rs).
 * - `edit.undo`/`edit.redo` return `{undone}`/`{redone}` labels;
 *   `edit.history.list` returns `{states, current, branches}` — the fake's
 *   history is linear (branches: 0) and ids are positional (`s0`, `s1`, …)
 *   instead of upstream's content-keyed hex ids; labels are the step that made
 *   each state, the oldest state being "Original".
 * - Error strings use the verified upstream formats: "unknown command `x`",
 *   "invalid parameters for `cmd`: …", "no active composition",
 *   "no composition x", "no composition is open", "select a layer first",
 *   "nothing to undo", "nothing to redo".
 * - Command registry ids/labels/menus/shortcuts are copied from the upstream
 *   spec registrations (see comments for sources).
 *
 * Approximations (documented divergences): `renderFrame` returns a constant
 * 1×1 transparent PNG stub; `editor.state.times` is comp seconds (upstream
 * serializes ticks); `project.summary` items are the comps only (the fake has
 * no separate footage/solid items); no UI element registry (`ui.elements`,
 * `ui.click`, `ui.key` are rejected as unknown methods).
 */

import type { PropValue } from "./types";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface FakeComp {
  id: number;
  name: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  background: string;
}

export type FakeLayerKind = "solid" | "text" | "null";

export interface FakeProp {
  uid: number;
  match: string;
  name: string;
  type: string;
  value: PropValue;
  expression: string | null;
}

export interface FakeLayer {
  id: number;
  compId: number;
  name: string;
  kind: FakeLayerKind;
  props: Record<string, FakeProp>;
}

export interface FakeKeyframe {
  layerId: number;
  path: string;
  time: number;
  value: PropValue;
}

export interface FakeProject {
  comps: FakeComp[];
  layers: FakeLayer[];
  keyframes: FakeKeyframe[];
}

interface FakeSnapshot {
  project: FakeProject;
  activeComp: number | null;
  selectedLayers: number[];
  playhead: number;
  projectPath: string | null;
  dirty: boolean;
  nextCompId: number;
  nextLayerId: number;
  nextUid: number;
}

interface FakeHistoryEntry {
  label: string;
  snapshot: FakeSnapshot;
}

export interface FakeEditorOverrides {
  /** `info().version` (default "0.13.0-fake"). */
  readonly version?: string;
  readonly windowSize?: readonly [number, number];
  readonly focusedPanel?: string;
  readonly playhead?: number;
  readonly playing?: boolean;
  /** Comp seeds; ids are assigned deterministically in order. */
  readonly comps?: ReadonlyArray<{
    name: string;
    width?: number;
    height?: number;
    duration?: number;
  }>;
  /** Command id → error message: `execute(id)` rejects with the message (test/Batch-atomicity tool). */
  readonly failOn?: Readonly<Record<string, string>>;
  /** Artificial per-call latency in ms for `request`/`execute` (timeout tests). */
  readonly latencyMs?: number;
}

export interface FakeEditorStateView {
  readonly version: string;
  readonly project: FakeProject;
  readonly windowSize: readonly [number, number];
  readonly activeComp: number | null;
  readonly selectedLayers: readonly number[];
  readonly playhead: number;
  readonly playing: boolean;
  readonly focusedPanel: string;
  readonly windowFocused: boolean;
  readonly projectPath: string | null;
  readonly dirty: boolean;
  readonly history: {
    readonly undo: ReadonlyArray<{ readonly label: string }>;
    readonly redo: ReadonlyArray<{ readonly label: string }>;
  };
  readonly fileTable: ReadonlyArray<{ readonly path: string; readonly size: number }>;
}

export interface FakeEditorScriptStep {
  readonly command: string;
  readonly params?: unknown;
}

export interface FakeEditorScriptOptions {
  /** Stop at the first failure (default) or collect it as a rejected step. */
  readonly continueOnError?: boolean;
}

export interface FakeEditorScriptResult {
  readonly command: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export interface FakeEditor {
  // -- the `window.effectcraft` surface (verified in web/index.html) ---------
  request(method: string, params?: unknown): Promise<unknown>;
  execute(command: string, params?: unknown): Promise<unknown>;
  commands(): Promise<unknown>;
  inspect(): Promise<unknown>;
  screenshot(params?: unknown): Promise<unknown>;
  renderFrame(params?: unknown): Promise<unknown>;
  files(): Array<{ path: string; size: number }>;
  readFile(path: string): Uint8Array | undefined;
  addFile(fileOrUrl: Blob | File | string, name?: string): Promise<string>;
  info(): unknown;
  saveToBrowser(path?: string): Promise<unknown>;
  listStored(): Promise<unknown>;
  removeStored(path: string): boolean;
  flush(): Promise<void>;
  workerFrameCheck(params?: unknown): Promise<unknown>;

  // -- fake-only affordances -------------------------------------------------
  /** A read-only view of the fake's world, for assertions and fixtures. */
  readonly state: FakeEditorStateView;
  /**
   * Run a list of `[command, params?]` pairs through `execute`, in order
   * (deterministic). Fails on the first error unless `continueOnError`.
   */
  script(
    steps: ReadonlyArray<readonly [command: string, params?: unknown]>,
    opts?: FakeEditorScriptOptions,
  ): Promise<Array<FakeEditorScriptResult>>;
  /** Restore the initial state (same ids as a fresh createFakeEditor). */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Constant 1×1 transparent PNG — the deterministic `render.frame` stub. */
export const FAKE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const ROOT_LABEL = "Original"; // engine/src/history.rs ROOT_LABEL
const NOT_IN_BATCH = ["engine.batch", "file.runScript", "script.run"]; // engine/src/commands/batch.rs NOT_IN_BATCH

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** `editor/apps/effectcraft-web/src/files.rs` `path_for`: keep the last path segment. */
export function fakePathFor(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return `/${base.length > 0 ? base : "effectcraft-output"}`;
}

// ---------------------------------------------------------------------------
// Command registry — ids/labels/menus/shortcuts copied from the upstream
// `cmd!`/`query!` registrations (comp.rs, layer.rs, prop.rs, edit.rs, batch.rs, query.rs).
// ---------------------------------------------------------------------------

interface FakeCommandSpec {
  readonly id: string;
  readonly label: string;
  readonly menu: readonly string[];
  readonly shortcut: string | null;
  readonly params: string;
  readonly undoable: boolean;
  readonly schemaProps: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
}

const REGISTRY: readonly FakeCommandSpec[] = [
  // comp.rs:278 — cmd!("comp.new", "New Composition...", ["Composition"], Some("Cmd+N"), …)
  {
    id: "comp.new",
    label: "New Composition...",
    menu: ["Composition"],
    shortcut: "Cmd+N",
    params:
      "{name?, width?, height?, frameRate?, duration? (s), startTime? (s) | startTimecode?, background? [r,g,b]|#hex, pixelAspect?, renderer?: classic3D|advanced3D, open?}",
    undoable: true,
    schemaProps: {
      name: { type: "string", description: "composition name (default Comp N, unique)" },
      width: { type: "number", description: "pixels (default 1920)" },
      height: { type: "number", description: "pixels (default 1080)" },
      duration: { type: "number", description: "seconds (default 10)" },
      frameRate: { type: "number", description: "fps (default 29.97)" },
      open: { type: "boolean", description: "open it (default true)" },
    },
    required: [],
  },
  // layer.rs:1601 — cmd!("layer.newSolid", "Solid...", ["Layer", "New"], Some("Cmd+Y"), …)
  {
    id: "layer.newSolid",
    label: "Solid...",
    menu: ["Layer", "New"],
    shortcut: "Cmd+Y",
    params: "{name?, color? #hex|[r,g,b], width?, height?, pixelAspect?}",
    undoable: true,
    schemaProps: {
      name: { type: "string", description: "layer name (default Solid N)" },
      color: { type: "string", description: "#hex (default #D93333)" },
      width: { type: "number", description: "solid width (default the comp's)" },
      height: { type: "number", description: "solid height (default the comp's)" },
    },
    required: [],
  },
  // layer.rs:1592 — cmd!("layer.newText", "Text", ["Layer", "New"], Some("Cmd+Alt+Shift+T"), …)
  {
    id: "layer.newText",
    label: "Text",
    menu: ["Layer", "New"],
    shortcut: "Cmd+Alt+Shift+T",
    params:
      "{text?, name? (layer name; default the text), position? [x,y], box? [x,y,w,h] (paragraph text, comp space), …}",
    undoable: true,
    schemaProps: {
      text: { type: "string", description: 'the text (default "Text")' },
      name: { type: "string", description: "layer name (default the text)" },
    },
    required: [],
  },
  // layer.rs:1653 — cmd!("layer.rename", "Rename", [], Some("Enter"), "{layer?, name}", has_layers, rename)
  {
    id: "layer.rename",
    label: "Rename",
    menu: [],
    shortcut: "Enter",
    params: "{layer?, name}",
    undoable: true,
    schemaProps: {
      layer: { type: "number", description: "layer id (default the selected layer)" },
      name: { type: "string", description: "new name" },
    },
    required: ["name"],
  },
  // prop.rs:1303 — cmd!("prop.set", "Set Property Value", [], None, …)
  {
    id: "prop.set",
    label: "Set Property Value",
    menu: [],
    shortcut: null,
    params: "{layer?, path|prop, value, time? (layer s by default), timeBase?: layer|comp, …}",
    undoable: true,
    schemaProps: {
      layer: { type: "number", description: "layer id (default the selected layer)" },
      path: { type: "string", description: "property path, e.g. transform/opacity" },
      value: { type: "unknown", description: "the value to set" },
      time: { type: "number", description: "add/update a keyframe at this time (s)" },
    },
    required: ["path", "value"],
  },
  // prop.rs:1302 — query!("prop.get", "Get Property", "{layer?, path|prop, time? (comp s)}", get)
  {
    id: "prop.get",
    label: "Get Property",
    menu: [],
    shortcut: null,
    params: "{layer?, path|prop, time? (comp s)}",
    undoable: false,
    schemaProps: {
      layer: { type: "number", description: "layer id (default the selected layer)" },
      path: { type: "string", description: "property path, e.g. transform/opacity" },
      time: { type: "number", description: "comp seconds (default the playhead)" },
    },
    required: ["path"],
  },
  // batch.rs:107 — CommandSpec { id: "engine.batch", label: "Run Commands (Batch)", … }
  {
    id: "engine.batch",
    label: "Run Commands (Batch)",
    menu: [],
    shortcut: null,
    params:
      '{steps: [{command, params?}], label? (undo step name, default Batch), atomic?: bool (default true: a failing step rolls the whole batch back)} → {steps, results: [each step\'s result]}; a string param "$N" or "$N.key.0" is step N\'s result (1-based)}',
    undoable: false,
    schemaProps: {
      steps: {
        type: "array",
        description: "[{command, params?}] — later steps can reference earlier results",
      },
      label: { type: "string", description: "undo step name (default Batch)" },
      atomic: { type: "boolean", description: "roll back on a failing step (default true)" },
    },
    required: ["steps"],
  },
  // edit.rs:862-863 — cmd!("edit.undo", "Undo", ["Edit"], Some("Cmd+Z"), "{}", can_undo, undo)
  {
    id: "edit.undo",
    label: "Undo",
    menu: ["Edit"],
    shortcut: "Cmd+Z",
    params: "{}",
    undoable: false,
    schemaProps: {},
    required: [],
  },
  {
    id: "edit.redo",
    label: "Redo",
    menu: ["Edit"],
    shortcut: "Cmd+Shift+Z",
    params: "{}",
    undoable: false,
    schemaProps: {},
    required: [],
  },
  // edit.rs:925 — query!("edit.history.list", "History", …)
  {
    id: "edit.history.list",
    label: "History",
    menu: [],
    shortcut: null,
    params:
      "{} → {states: [{index, id, label, parent, depth, current, line, future}], current, branches}",
    undoable: false,
    schemaProps: {},
    required: [],
  },
  // query.rs:210-216, 181 — the query commands
  {
    id: "command.list",
    label: "List Commands",
    menu: [],
    shortcut: null,
    params: "{filter?, enabledOnly?, schemas? (add each command's params JSON Schema)}",
    undoable: false,
    schemaProps: {
      filter: { type: "string", description: "substring of the id or label" },
      enabledOnly: { type: "boolean", description: "drop disabled commands" },
      schemas: { type: "boolean", description: "add each command's params JSON Schema" },
    },
    required: [],
  },
  {
    id: "command.describe",
    label: "Describe Command",
    menu: [],
    shortcut: null,
    params: "{command} → id, label, menu, shortcut, params doc, JSON `schema`, enabled",
    undoable: false,
    schemaProps: { command: { type: "string", description: "a command id" } },
    required: ["command"],
  },
  {
    id: "app.capabilities",
    label: "App Capabilities",
    menu: [],
    shortcut: null,
    params: "{} → version, command/effect counts, export formats, parity summary",
    undoable: false,
    schemaProps: {},
    required: [],
  },
  {
    id: "project.summary",
    label: "Project Summary",
    menu: [],
    shortcut: null,
    params: "{}",
    undoable: false,
    schemaProps: {},
    required: [],
  },
  {
    id: "comp.info",
    label: "Composition Info",
    menu: [],
    shortcut: null,
    params: "{comp?}",
    undoable: false,
    schemaProps: {
      comp: { type: "unknown", description: "comp id or name (default the active comp)" },
    },
    required: [],
  },
  {
    id: "layer.tree",
    label: "Layer Property Tree",
    menu: [],
    shortcut: null,
    params: "{layer?, comp?, depth?, time? (comp s)} → nodes with `path`",
    undoable: false,
    schemaProps: {
      layer: { type: "number", description: "layer id (default the selected layer)" },
      comp: { type: "unknown", description: "comp id or name (default the active comp)" },
    },
    required: [],
  },
  {
    id: "editor.state",
    label: "Editor State",
    menu: [],
    shortcut: null,
    params: "{}",
    undoable: false,
    schemaProps: {},
    required: [],
  },
];

function schemaOf(spec: FakeCommandSpec): Record<string, unknown> {
  return {
    type: "object",
    properties: clone(spec.schemaProps),
    required: [...spec.required],
    additionalProperties: true,
  };
}

// ---------------------------------------------------------------------------
// The fake editor
// ---------------------------------------------------------------------------

export function createFakeEditor(overrides: FakeEditorOverrides = {}): FakeEditor {
  const version = overrides.version ?? "0.13.0-fake";
  const latencyMs = overrides.latencyMs ?? 0;

  let project: FakeProject = { comps: [], layers: [], keyframes: [] };
  let windowSize: [number, number] = [...(overrides.windowSize ?? [1280, 800])];
  let activeComp: number | null = null;
  let selectedLayers: number[] = [];
  let playhead = overrides.playhead ?? 0;
  let playing = overrides.playing ?? false;
  let focusedPanel = overrides.focusedPanel ?? "Viewer";
  let windowFocused = true;
  let projectPath: string | null = null;
  let dirty = false;
  let nextCompId = 1;
  let nextLayerId = 1;
  let nextUid = 1;

  const files = new Map<string, Uint8Array>();
  const undoStack: FakeHistoryEntry[] = [];
  const redoStack: FakeHistoryEntry[] = [];

  // False while `engine.batch` runs its steps: individual steps must not leave undo
  // entries — the whole batch folds into ONE (batch.rs `fold`).
  let journaling = true;
  let suppressedJournals = 0;

  function init(): void {
    for (const seed of overrides.comps ?? []) {
      const comp = makeComp(seed.name, seed.width, seed.height, seed.duration);
      project.comps.push(comp);
    }
    const first = project.comps[0];
    if (first) activeComp = first.id;
  }

  function makeComp(
    name: string,
    width?: number,
    height?: number,
    duration?: number,
    frameRate?: number,
    background?: string,
  ): FakeComp {
    const comp: FakeComp = {
      id: nextCompId++,
      name: uniqueCompName(name),
      width: num(width, 1920),
      height: num(height, 1080),
      duration: num(duration, 10),
      frameRate: num(frameRate, 29.97),
      background: background ?? "#000000",
    };
    return comp;
  }

  function uniqueCompName(name: string): string {
    if (!project.comps.some((c) => c.name === name)) return name;
    let n = 2;
    while (project.comps.some((c) => c.name === `${name} ${n}`)) n++;
    return `${name} ${n}`;
  }

  function uniqueLayerName(base: string): string {
    if (!project.layers.some((l) => l.name === base)) return base;
    let n = 2;
    while (project.layers.some((l) => l.name === `${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  // -- snapshot / history ---------------------------------------------------

  function snapshot(): FakeSnapshot {
    return clone({
      project,
      activeComp,
      selectedLayers,
      playhead,
      projectPath,
      dirty,
      nextCompId,
      nextLayerId,
      nextUid,
    });
  }

  function restore(snap: FakeSnapshot): void {
    project = clone(snap.project);
    activeComp = snap.activeComp;
    selectedLayers = [...snap.selectedLayers];
    playhead = snap.playhead;
    projectPath = snap.projectPath;
    dirty = snap.dirty;
    nextCompId = snap.nextCompId;
    nextLayerId = snap.nextLayerId;
    nextUid = snap.nextUid;
  }

  /** One journaled edit (upstream `Session::edit`): push the PRE state, clear redo. */
  function journal(label: string): void {
    if (!journaling) {
      suppressedJournals++; // would have journaled — the batch folds it
      return;
    }
    undoStack.push({ label, snapshot: snapshot() });
    redoStack.length = 0;
    dirty = true;
  }

  // -- resolution helpers ---------------------------------------------------

  function activeCompOrNull(): FakeComp | null {
    if (activeComp === null) return null;
    return project.comps.find((c) => c.id === activeComp) ?? null;
  }

  function resolveComp(ref: unknown): FakeComp {
    const active = activeCompOrNull();
    if (ref === undefined || ref === null) {
      if (!active) throw "no active composition";
      return active;
    }
    if (typeof ref === "number") {
      const comp = project.comps.find((c) => c.id === ref);
      if (!comp) throw `no composition ${ref}`;
      return comp;
    }
    if (typeof ref === "string") {
      const comp = project.comps.find((c) => c.name === ref);
      if (!comp) throw `no composition ${ref}`;
      return comp;
    }
    throw `invalid parameters for \`comp\`: ${JSON.stringify(ref)}`;
  }

  function resolveLayer(ref: unknown): FakeLayer {
    // upstream has_layers: a selection or an explicit layer is required
    let id: number | null = null;
    if (typeof ref === "number") id = ref;
    else if (typeof ref === "string" && /^\d+$/.test(ref)) id = Number(ref);
    else if (ref === undefined && selectedLayers.length > 0) id = selectedLayers[0] ?? null;
    const layer = id === null ? undefined : project.layers.find((l) => l.id === id);
    if (!layer) {
      throw activeCompOrNull() ? "select a layer first" : "no composition is open";
    }
    return layer;
  }

  function compLayers(comp: FakeComp): FakeLayer[] {
    return project.layers.filter((l) => l.compId === comp.id);
  }

  function seedProps(
    comp: FakeComp,
    extra: Array<[string, string, string, PropValue]>,
  ): Record<string, FakeProp> {
    const props: Record<string, FakeProp> = {};
    const add = (path: string, name: string, type: string, value: PropValue): void => {
      props[path] = {
        uid: nextUid++,
        match: path.split("/").pop() ?? path,
        name,
        type,
        value,
        expression: null,
      };
    };
    add("transform/anchor", "Anchor Point", "vec3", [0, 0, 0]);
    add("transform/position", "Position", "vec3", [comp.width / 2, comp.height / 2, 0]);
    add("transform/scale", "Scale", "percent", 100);
    add("transform/rotation", "Rotation", "angle", 0);
    add("transform/opacity", "Opacity", "percent", 100);
    for (const [path, name, type, value] of extra) add(path, name, type, value);
    return props;
  }

  // -- $N reference substitution (batch.rs `reference`/`substitute`) ----------

  function reference(ref: string, results: unknown[]): unknown | undefined {
    const rest = ref.slice(1); // strip '$'
    const parts = rest.split(".");
    const n = Number(parts[0]);
    if (!Number.isInteger(n) || n < 1) return undefined; // not a $N reference
    const path = parts.slice(1);
    if (path.some((p) => p.length === 0 || !/^[A-Za-z0-9_]+$/.test(p))) {
      throw `invalid parameters for \`$ref\`: ${ref}`;
    }
    const prior = results[n - 1];
    if (prior === undefined) {
      throw `\`${ref}\` refers to step ${n}, but only ${results.length} step(s) ran before`;
    }
    let v: unknown = prior;
    for (const p of path) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        v = (v as Record<string, unknown>)[p];
      } else if (Array.isArray(v) && /^\d+$/.test(p)) {
        v = v[Number(p)];
      } else {
        throw `\`${ref}\`: step ${n} returned ${JSON.stringify(prior)}, which has no \`${p}\``;
      }
      if (v === undefined) {
        throw `\`${ref}\`: step ${n} returned ${JSON.stringify(prior)}, which has no \`${p}\``;
      }
    }
    return v;
  }

  function substitute(value: unknown, results: unknown[]): unknown {
    if (typeof value === "string") {
      if (value.startsWith("$")) {
        const resolved = reference(value, results);
        if (resolved !== undefined) return resolved;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => substitute(v, results));
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = substitute(v, results);
      return out;
    }
    return value;
  }

  // -- journaled engine commands --------------------------------------------

  function cmdCompNew(p: Record<string, unknown>): unknown {
    journal("New Composition");
    const comp = makeComp(
      str(p.name) ?? `Comp ${project.comps.length + 1}`,
      num(p.width, 1920),
      num(p.height, 1080),
      num(p.duration, 10),
      num(p.frameRate, 29.97),
      str(p.background) ?? "#000000",
    );
    project.comps.push(comp);
    if (p.open !== false) activeComp = comp.id;
    return { comp: comp.id };
  }

  function newLayer(
    p: Record<string, unknown>,
    kind: FakeLayerKind,
    label: string,
    extraProps: Array<[string, string, string, PropValue]>,
    defaultName: () => string,
  ): unknown {
    const comp = resolveComp(p.comp);
    journal(label);
    const name = uniqueLayerName(str(p.name) ?? defaultName());
    const layer: FakeLayer = {
      id: nextLayerId++,
      compId: comp.id,
      name,
      kind,
      props: seedProps(comp, extraProps),
    };
    project.layers.unshift(layer); // index 1 = top (layer.rs insert_layer_at)
    selectedLayers = [layer.id]; // layer.rs:82
    return { layer: layer.id };
  }

  function cmdNewSolid(p: Record<string, unknown>): unknown {
    const color = str(p.color) ?? "#D93333"; // layer.rs default [0.85, 0.2, 0.2]
    return newLayer(
      p,
      "solid",
      "New Solid",
      [["solid/color", "Color", "color", color]],
      () => `Solid ${project.layers.length + 1}`,
    );
  }

  function cmdNewText(p: Record<string, unknown>): unknown {
    const text = str(p.text) ?? "Text"; // layer.rs new_text default
    return newLayer(
      p,
      "text",
      "New Text Layer",
      [["text/sourceText", "Source Text", "text", text]],
      () => text.split("\n")[0]?.slice(0, 40) || "Text",
    );
  }

  function cmdRename(p: Record<string, unknown>): unknown {
    const layer = resolveLayer(p.layer);
    const name = str(p.name);
    if (name === undefined) throw "invalid parameters for `layer.rename`: missing `name`";
    journal("Rename Layer");
    layer.name = name;
    return null;
  }

  function cmdPropSet(p: Record<string, unknown>): unknown {
    const layer = resolveLayer(p.layer);
    const path = str(p.path) ?? str(p.prop);
    if (path === undefined) throw "invalid parameters for `prop.set`: missing `path`";
    const prop = layer.props[path];
    if (!prop)
      throw `invalid parameters for \`prop.set\`: layer ${layer.id} has no property \`${path}\``;
    if (!("value" in p)) throw "invalid parameters for `prop.set`: missing `value`";
    journal("Change Property");
    prop.value = clone(p.value) as PropValue;
    const time = p.time;
    if (typeof time === "number" && Number.isFinite(time)) {
      const existing = project.keyframes.find(
        (k) => k.layerId === layer.id && k.path === path && k.time === time,
      );
      if (existing) existing.value = clone(p.value) as PropValue;
      else
        project.keyframes.push({
          layerId: layer.id,
          path,
          time,
          value: clone(p.value) as PropValue,
        });
    }
    return prop.value;
  }

  function cmdBatch(p: Record<string, unknown>): unknown {
    const steps = p.steps;
    if (!Array.isArray(steps)) {
      throw "invalid parameters for `engine.batch`: missing `steps`: [{command, params?}, …]";
    }
    const label = str(p.label) ?? "Batch";
    const atomic = p.atomic === undefined ? true : p.atomic === true;
    const pre = snapshot();
    const results: unknown[] = [];
    // batch.rs `fold`: applied steps become ONE undo entry named `label` —
    // pushed only when any step actually journaled.
    const fold = (): void => {
      if (suppressedJournals > 0) {
        undoStack.push({ label, snapshot: pre });
        redoStack.length = 0;
        dirty = true;
      }
      suppressedJournals = 0;
    };
    journaling = false;
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const id = isRecord(step) ? (str(step.command) ?? str(step.id)) : undefined;
        if (id === undefined) {
          throw "invalid parameters for `engine.batch`: each step needs `command` (a command id)";
        }
        if ((NOT_IN_BATCH as readonly string[]).includes(id)) {
          throw `invalid parameters for \`engine.batch\`: \`${id}\` can't run inside a batch`;
        }
        let params: Record<string, unknown>;
        try {
          params = (substitute(isRecord(step) ? (step.params ?? {}) : {}, results) ?? {}) as Record<
            string,
            unknown
          >;
        } catch (err) {
          if (atomic) restore(pre);
          else fold();
          const note = atomic
            ? "; the batch was rolled back (nothing changed)"
            : `; steps 1–${i} were applied`;
          throw `step ${i + 1} (${id}): invalid parameters for \`engine.batch\`: ${String(err)}${note}`;
        }
        try {
          results.push(runCommand(id, params));
        } catch (err) {
          if (atomic) restore(pre);
          else fold();
          const note = atomic
            ? "; the batch was rolled back (nothing changed)"
            : `; steps 1–${i} were applied`;
          throw `step ${i + 1} (${id}): ${String(err)}${note}`;
        }
      }
    } finally {
      journaling = true;
    }
    fold();
    return { steps: results.length, results };
  }

  function cmdUndo(): unknown {
    const label = undoStack.length > 0 ? (undoStack[undoStack.length - 1]?.label ?? null) : null;
    const entry = undoStack.pop();
    if (entry) {
      redoStack.push({ label: entry.label, snapshot: snapshot() });
      restore(entry.snapshot);
    }
    return { undone: label };
  }

  function cmdRedo(): unknown {
    const label = redoStack.length > 0 ? (redoStack[redoStack.length - 1]?.label ?? null) : null;
    const entry = redoStack.pop();
    if (entry) {
      undoStack.push({ label: entry.label, snapshot: snapshot() });
      restore(entry.snapshot);
      dirty = true;
    }
    return { redone: label };
  }

  // -- queries (not journaled) ----------------------------------------------

  function layerJson(l: FakeLayer, comp: FakeComp, index: number): Record<string, unknown> {
    return {
      id: l.id,
      index,
      name: l.name,
      type: l.kind,
      label: "None",
      in: 0,
      out: comp.duration,
      start: 0,
      stretch: 1,
      blendMode: "Normal",
      parent: null,
      trackMatte: null,
      switches: {
        video: l.kind !== "null",
        audio: false,
        solo: false,
        locked: false,
        shy: false,
        adjustment: false,
        threeD: false,
        motionBlur: false,
        effects: true,
        blendModeIsExpanded: false,
      },
    };
  }

  function propNode(l: FakeLayer, path: string): Record<string, unknown> {
    const prop = l.props[path];
    if (!prop) throw `layer ${l.id} has no property \`${path}\``;
    const keys = project.keyframes
      .filter((k) => k.layerId === l.id && k.path === path)
      .sort((a, b) => a.time - b.time)
      .map((k) => ({ time: k.time, value: k.value, in: "Linear", out: "Linear" }));
    const node: Record<string, unknown> = {
      path,
      uid: prop.uid,
      match: prop.match,
      name: prop.name,
      type: prop.type,
      value: prop.value,
    };
    if (keys.length > 0) node.keys = keys;
    if (prop.expression !== null) node.expression = prop.expression;
    return node;
  }

  function querySummary(): Record<string, unknown> {
    const active = activeCompOrNull();
    return {
      path: projectPath,
      dirty,
      bitDepth: "8 bpc",
      renderer: "fake",
      items: project.comps.map((c) => ({
        id: c.id,
        name: c.name,
        type: "Composition",
        label: "Sandstone",
        parent: null,
        size: [c.width, c.height],
        duration: c.duration,
        layers: compLayers(c).length,
        frameRate: c.frameRate,
      })),
      activeComp: active?.id ?? null,
      time: playhead,
      selectedLayers: [...selectedLayers],
      undo: undoStack.map((e) => e.label),
    };
  }

  function queryCompInfo(p: Record<string, unknown>): Record<string, unknown> {
    const comp = resolveComp(p.comp);
    return {
      id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      frameRate: comp.frameRate,
      duration: comp.duration,
      workArea: [0, comp.duration],
      background: comp.background,
      preserveFrameRate: false,
      preserveResolution: false,
      resolution: "Full",
      resolutionFactor: 1,
      layers: compLayers(comp).map((l, i) => layerJson(l, comp, i + 1)), // index 1 = top
    };
  }

  function queryLayerTree(p: Record<string, unknown>): Record<string, unknown> {
    const comp = resolveComp(p.comp);
    const layer = resolveLayer(p.layer);
    if (layer.compId !== comp.id) throw `no layer ${layer.id} in composition ${comp.id}`;
    const order = [...compLayers(comp)];
    const index = order.findIndex((l) => l.id === layer.id) + 1;
    const time = num(p.time, playhead);
    const children = Object.keys(layer.props).map((path) => propNode(layer, path));
    return {
      ...layerJson(layer, comp, index),
      time,
      properties: {
        path: "",
        uid: 0,
        match: "",
        name: "Layer",
        enabled: true,
        children,
      },
    };
  }

  function queryPropGet(p: Record<string, unknown>): Record<string, unknown> {
    const layer = resolveLayer(p.layer);
    const path = str(p.path) ?? str(p.prop);
    if (path === undefined) throw "invalid parameters for `prop.get`: missing `path`";
    const prop = layer.props[path];
    if (!prop)
      throw `invalid parameters for \`prop.get\`: layer ${layer.id} has no property \`${path}\``;
    const keys = project.keyframes
      .filter((k) => k.layerId === layer.id && k.path === path)
      .sort((a, b) => a.time - b.time)
      .map((k) => ({ time: k.time, value: k.value, in: "Linear", out: "Linear" }));
    return {
      layer: layer.id,
      uid: prop.uid,
      match: prop.match,
      name: prop.name,
      type: prop.type,
      time: num(p.time, playhead),
      value: prop.value,
      animated: keys.length > 0,
      keys,
      expression: prop.expression,
    };
  }

  function queryEditorState(): Record<string, unknown> {
    const active = activeCompOrNull();
    const times: Record<string, number> = {};
    if (active) times[String(active.id)] = playhead;
    return {
      active_comp: active?.id ?? null,
      open_comps: active ? [active.id] : [],
      recent_comps: [],
      times,
      selected_layers: [...selectedLayers],
      comp_selections: {},
      selected_props: [],
      selected_keys: [],
      project_selection: active ? [active.id] : [],
    };
  }

  /** The run/list-time guards of JOURNALED commands (queries are `always`, query! macro). */
  function enabledCheck(spec: FakeCommandSpec): { ok: boolean; why: string | null } {
    const active = activeCompOrNull();
    switch (spec.id) {
      case "layer.newSolid":
      case "layer.newText":
        // has_comp — commands/mod.rs:393 "no composition is open"
        return active ? { ok: true, why: null } : { ok: false, why: "no composition is open" };
      case "layer.rename":
      case "prop.set":
        // has_layers — commands/mod.rs:397 "select a layer first"
        if (!active) return { ok: false, why: "no composition is open" };
        return selectedLayers.length > 0
          ? { ok: true, why: null }
          : { ok: false, why: "select a layer first" };
      case "edit.undo":
        // can_undo — edit.rs:12 "nothing to undo"
        return undoStack.length > 0
          ? { ok: true, why: null }
          : { ok: false, why: "nothing to undo" };
      case "edit.redo":
        // can_redo — edit.rs:15 "nothing to redo"
        return redoStack.length > 0
          ? { ok: true, why: null }
          : { ok: false, why: "nothing to redo" };
      default:
        // `always` (comp.new, engine.batch, every query!)
        return { ok: true, why: null };
    }
  }

  function queryCommandList(p: Record<string, unknown>): Array<Record<string, unknown>> {
    const filter = str(p.filter)?.toLowerCase();
    const only = p.enabledOnly === true;
    const schemas = p.schemas === true;
    return REGISTRY.filter((spec) => {
      if (
        filter !== undefined &&
        !spec.id.toLowerCase().includes(filter) &&
        !spec.label.toLowerCase().includes(filter)
      ) {
        return false;
      }
      return !only || enabledCheck(spec).ok;
    }).map((spec) => {
      const en = enabledCheck(spec);
      const out: Record<string, unknown> = {
        id: spec.id,
        label: spec.label,
        menu: [...spec.menu],
        shortcut: spec.shortcut,
        params: spec.params,
        enabled: en.ok,
        why: en.why,
      };
      if (schemas) out.schema = schemaOf(spec);
      return out;
    });
  }

  function queryCommandDescribe(p: Record<string, unknown>): Record<string, unknown> {
    const id = str(p.command) ?? str(p.id);
    if (id === undefined) throw "invalid parameters for `command.describe`: missing `command`";
    const spec = REGISTRY.find((s) => s.id === id);
    if (!spec) throw `unknown command \`${id}\``;
    const en = enabledCheck(spec);
    return {
      id: spec.id,
      label: spec.label,
      menu: [...spec.menu],
      shortcut: spec.shortcut,
      params: spec.params,
      schema: schemaOf(spec),
      undoable: spec.undoable,
      enabled: en.ok,
      why: en.why,
    };
  }

  function queryCapabilities(): Record<string, unknown> {
    return {
      version,
      commands: REGISTRY.length,
      effects: { total: 0, gpu: 0, float: 0 },
      export: [],
      import: true,
      expressions: false,
      scripting: false,
      gpu: false,
      parity: {
        target: "Adobe After Effects 2026",
        summary: "fake editor",
        doc: "docs/target-app-parity.md",
      },
    };
  }

  function queryHistoryList(): Record<string, unknown> {
    // Linear approximation of the upstream history tree (engine/src/history.rs):
    // every state's label is the step that MADE it (the oldest is `ROOT_LABEL`
    // "Original"), `parent` is the state index it was made from, ids are
    // positional (`s0`, `s1`, …) instead of upstream's content-keyed hex ids,
    // and there are no branches (`branches: 0`).
    const states: Array<Record<string, unknown>> = [];
    const n = undoStack.length;
    for (let i = 0; i <= n; i++) {
      const label = i === 0 ? ROOT_LABEL : (undoStack[i - 1]?.label ?? ROOT_LABEL);
      states.push({
        index: i,
        id: `s${i}`,
        label,
        parent: i === 0 ? null : i - 1,
        depth: 0,
        current: i === n,
        line: true,
        future: false,
      });
    }
    for (let j = 0; j < redoStack.length; j++) {
      const idx = n + 1 + j;
      states.push({
        index: idx,
        id: `s${idx}`,
        label: redoStack[j]?.label ?? ROOT_LABEL,
        parent: idx - 1,
        depth: 0,
        current: false,
        line: true,
        future: true,
      });
    }
    return { states, current: n, branches: 0 };
  }

  // -- the ui / render methods ------------------------------------------------

  function inspectResult(): Record<string, unknown> {
    const active = activeCompOrNull();
    return {
      window: [windowSize[0], windowSize[1]],
      pixelsPerPoint: 1,
      fps: 60,
      ui: {
        tool: "Selection",
        workspace: "Default",
        focused: focusedPanel,
        viewer: { zoom: null, res: "Full", pan: [0, 0], grid: false },
        timeline: { pps: null, start: 0, graphEditor: false },
      },
      playing,
      time: playhead,
      activeComp: active?.id ?? null,
      selectedLayers: [...selectedLayers],
      selectedKeys: 0,
      elements: 0,
      keyboardFocus: null,
      windowFocused,
      workspaceStorageError: null,
      dialog: null,
      renderMs: 8,
    };
  }

  function renderFrameResult(p: Record<string, unknown>): Record<string, unknown> {
    const comp = resolveComp(p.comp);
    const time = num(p.time, playhead);
    const maxSide = num(p.max_side, 0);
    let width = comp.width;
    let height = comp.height;
    if (maxSide > 0 && Math.max(width, height) > maxSide) {
      const scale = maxSide / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    const out: Record<string, unknown> = { comp: comp.id, time, width, height };
    const inline = typeof p.base64 === "boolean" ? p.base64 : p.path === undefined;
    if (inline) {
      out.png = FAKE_PNG_BASE64; // the 1×1 stub
    } else {
      const path = str(p.path) ?? "/effectcraft-frame.png";
      files.set(path, pngBytes());
      out.path = path;
    }
    return out;
  }

  function screenshotResult(p: Record<string, unknown>): Record<string, unknown> {
    const width = windowSize[0];
    const height = windowSize[1];
    const path = str(p.path);
    if (path === undefined) {
      return { png: FAKE_PNG_BASE64, width, height };
    }
    files.set(path, pngBytes());
    return { path, width, height };
  }

  function pngBytes(): Uint8Array {
    const bin = globalThis.atob(FAKE_PNG_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** Blob/File → bytes; falls back to FileReader (jsdom's Blob lacks arrayBuffer). */
  async function blobBytes(blob: Blob | File): Promise<Uint8Array> {
    if (typeof blob.arrayBuffer === "function") {
      return new Uint8Array(await blob.arrayBuffer());
    }
    return await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new globalThis.FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error ?? new Error("could not read the Blob"));
      reader.readAsArrayBuffer(blob);
    });
  }

  function infoResult(): Record<string, unknown> {
    return {
      version,
      threads: false,
      workers: { running: 0, idle: 0, gpu: null, jobs: [] },
      audio: {
        state: "suspended",
        sampleRate: 48000,
        backend: "none",
        posted: 0,
        played: 0,
        underruns: 0,
      },
      storage: { backend: "memory-fake" },
      gpu: { compositor: "cpu", viewerOnGpu: false },
      diskCache: { usage: 0, quota: 0 },
      frameWorkers: { workers: 0, alive: 0, busy: 0, rendered: 0 },
      restored: false,
      crossOriginIsolated: true,
      webgpu: false,
      serviceWorker: false,
      load: { wasmMs: 42, readyMs: 64 },
    };
  }

  // -- command dispatch ------------------------------------------------------

  const QUERIES: Record<string, (p: Record<string, unknown>) => unknown> = {
    "project.summary": () => querySummary(),
    "comp.info": queryCompInfo,
    "layer.tree": queryLayerTree,
    "prop.get": queryPropGet,
    "editor.state": () => queryEditorState(),
    "command.list": queryCommandList,
    "command.describe": queryCommandDescribe,
    "app.capabilities": () => queryCapabilities(),
    "edit.history.list": () => queryHistoryList(),
  };

  const COMMANDS: Record<string, (p: Record<string, unknown>) => unknown> = {
    "comp.new": cmdCompNew,
    "layer.newSolid": cmdNewSolid,
    "layer.newText": cmdNewText,
    "layer.rename": cmdRename,
    "prop.set": cmdPropSet,
    "engine.batch": cmdBatch,
    "edit.undo": () => cmdUndo(),
    "edit.redo": () => cmdRedo(),
  };

  function runCommand(command: string, params: Record<string, unknown>): unknown {
    const spec = REGISTRY.find((s) => s.id === command);
    if (!spec) throw `unknown command \`${command}\``;
    const failWith = overrides.failOn?.[command];
    if (failWith !== undefined) throw failWith;
    const run = COMMANDS[command] ?? QUERIES[command];
    if (run === undefined) throw `unknown command \`${command}\``;
    // `execute_checked`: edit commands run their enabled guard (queries use `always`).
    if (COMMANDS[command] !== undefined) {
      const en = enabledCheck(spec);
      if (!en.ok) throw `command \`${command}\` is not available right now: ${en.why}`;
    }
    return run(params);
  }

  async function asyncCall<T>(value: () => T | Promise<T>): Promise<T> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return value();
  }

  function rejectMessage(err: unknown): Promise<never> {
    return Promise.reject(typeof err === "string" ? err : String(err));
  }

  // -- the public object -----------------------------------------------------

  const fake: FakeEditor = {
    request(method: string, params?: unknown): Promise<unknown> {
      return asyncCall((): unknown => {
        const p = (params ?? {}) as Record<string, unknown>;
        try {
          switch (method) {
            case "ui.inspect":
              return inspectResult();
            case "ui.screenshot":
              return screenshotResult(p);
            case "render.frame":
              return renderFrameResult(p);
            case "engine.commands":
              return queryCommandList(p);
            case "engine.execute": {
              const command = str(p.command);
              if (command === undefined) {
                throw "invalid parameters for `engine.execute`: missing `command`";
              }
              return runCommand(command, isRecord(p.params) ? p.params : {});
            }
            case "ui.playback": {
              const action = str(p.action);
              if (action === "play") playing = true;
              else if (action === "stop") playing = false;
              else if (action === "toggle") playing = !playing;
              return {
                playing,
                time: playhead,
                audio: false,
                levelsDb: [-96, -96],
                peaksDb: [-96, -96],
              };
            }
            default:
              throw `unknown method \`${method}\``;
          }
        } catch (err) {
          throw typeof err === "string" ? err : String(err);
        }
      }).catch((err) => rejectMessage(err));
    },

    execute(command: string, params?: unknown): Promise<unknown> {
      return asyncCall(() => {
        try {
          return runCommand(command, isRecord(params) ? params : {});
        } catch (err) {
          throw typeof err === "string" ? err : String(err);
        }
      }).catch((err) => rejectMessage(err));
    },

    commands(): Promise<unknown> {
      return fake.request("engine.commands", {});
    },

    inspect(): Promise<unknown> {
      return fake.request("ui.inspect", {});
    },

    screenshot(params?: unknown): Promise<unknown> {
      return fake.request("ui.screenshot", params ?? {});
    },

    renderFrame(params?: unknown): Promise<unknown> {
      return fake.request("render.frame", { base64: true, ...(params as Record<string, unknown>) });
    },

    files(): Array<{ path: string; size: number }> {
      return [...files.entries()]
        .map(([path, bytes]) => ({ path, size: bytes.byteLength }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    },

    readFile(path: string): Uint8Array | undefined {
      const bytes = files.get(path);
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },

    addFile(fileOrUrl: Blob | File | string, name?: string): Promise<string> {
      return (async (): Promise<string> => {
        let bytes: Uint8Array;
        let resolvedName: string | undefined = name;
        if (typeof fileOrUrl === "string") {
          if (fileOrUrl.startsWith("data:")) {
            const comma = fileOrUrl.indexOf(",");
            const payload = comma >= 0 ? fileOrUrl.slice(comma + 1) : "";
            const bin = fileOrUrl.slice(5).includes("base64")
              ? globalThis.atob(payload)
              : decodeURIComponent(payload);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            resolvedName = resolvedName ?? "data";
          } else {
            const existing = files.get(fileOrUrl);
            if (existing === undefined) {
              throw `addFile: cannot fetch ${JSON.stringify(fileOrUrl)} in the fake editor`;
            }
            bytes = new Uint8Array(existing);
            resolvedName = resolvedName ?? fileOrUrl;
          }
        } else {
          bytes = await blobBytes(fileOrUrl);
          resolvedName = resolvedName ?? (fileOrUrl as File).name;
        }
        const path = fakePathFor(resolvedName ?? "file");
        files.set(path, bytes);
        if (path.endsWith(".ecproj")) {
          const parsed = tryParseProject(bytes);
          if (parsed) loadProject(path, parsed);
        }
        return path;
      })();
    },

    info(): unknown {
      return infoResult();
    },

    saveToBrowser(path?: string): Promise<unknown> {
      return (async (): Promise<unknown> => {
        const target = path ?? projectPath ?? "/Untitled Project.ecproj";
        const p = target.startsWith("/") ? target : `/${target}`;
        const json = JSON.stringify({
          schema: "studio-fake-ecproj",
          version,
          project,
          state: { activeComp, selectedLayers, playhead },
        });
        const bytes = new TextEncoder().encode(json);
        files.set(p, bytes);
        projectPath = p;
        dirty = false;
        return { path: p, bytes: bytes.byteLength };
      })();
    },

    listStored(): Promise<unknown> {
      return Promise.resolve({
        backend: "memory-fake",
        usage: [...files.values()].reduce((n, b) => n + b.byteLength, 0),
        quota: 0,
        persisted: true,
        pending: false,
        files: fake.files().map((f) => ({ ...f, modified: 0 })),
        config: [],
      });
    },

    removeStored(path: string): boolean {
      return files.delete(path);
    },

    flush(): Promise<void> {
      return Promise.resolve();
    },

    workerFrameCheck(): Promise<unknown> {
      return Promise.resolve({
        width: 1,
        height: 1,
        maxDiff: 0,
        meanDiff: 0,
        over4: 0,
        workerMs: 1,
      });
    },

    get state(): FakeEditorStateView {
      return {
        get version() {
          return version;
        },
        get project() {
          return clone(project);
        },
        get windowSize() {
          return [...windowSize] as [number, number];
        },
        get activeComp() {
          return activeComp;
        },
        get selectedLayers() {
          return [...selectedLayers];
        },
        get playhead() {
          return playhead;
        },
        get playing() {
          return playing;
        },
        get focusedPanel() {
          return focusedPanel;
        },
        get windowFocused() {
          return windowFocused;
        },
        get projectPath() {
          return projectPath;
        },
        get dirty() {
          return dirty;
        },
        get history() {
          return {
            undo: undoStack.map((e) => ({ label: e.label })),
            redo: redoStack.map((e) => ({ label: e.label })),
          };
        },
        get fileTable() {
          return fake.files();
        },
      };
    },

    async script(
      steps: ReadonlyArray<readonly [command: string, params?: unknown]>,
      opts: FakeEditorScriptOptions = {},
    ): Promise<Array<FakeEditorScriptResult>> {
      const out: FakeEditorScriptResult[] = [];
      for (const [command, params] of steps) {
        try {
          const value = await fake.execute(command, params);
          out.push({ command, ok: true, value });
        } catch (err) {
          out.push({ command, ok: false, error: typeof err === "string" ? err : String(err) });
          if (!opts.continueOnError) return out;
        }
      }
      return out;
    },

    reset(): void {
      project = { comps: [], layers: [], keyframes: [] };
      windowSize = [...(overrides.windowSize ?? [1280, 800])];
      activeComp = null;
      selectedLayers = [];
      playhead = overrides.playhead ?? 0;
      playing = overrides.playing ?? false;
      focusedPanel = overrides.focusedPanel ?? "Viewer";
      windowFocused = true;
      projectPath = null;
      dirty = false;
      nextCompId = 1;
      nextLayerId = 1;
      nextUid = 1;
      files.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      init();
    },
  };

  function tryParseProject(bytes: Uint8Array): {
    project: FakeProject;
    state: { activeComp: number | null; selectedLayers: number[]; playhead: number };
  } | null {
    try {
      const text = new TextDecoder().decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (
        isRecord(parsed) &&
        parsed.schema === "studio-fake-ecproj" &&
        isRecord(parsed.project) &&
        Array.isArray(parsed.project.comps)
      ) {
        return parsed as {
          project: FakeProject;
          state: { activeComp: number | null; selectedLayers: number[]; playhead: number };
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  function loadProject(
    path: string,
    parsed: {
      project: FakeProject;
      state: { activeComp: number | null; selectedLayers: number[]; playhead: number };
    },
  ): void {
    project = clone(parsed.project);
    activeComp = parsed.state.activeComp ?? project.comps[0]?.id ?? null;
    selectedLayers = [...(parsed.state.selectedLayers ?? [])];
    playhead = num(parsed.state.playhead, 0);
    projectPath = path;
    dirty = false;
    nextCompId = Math.max(0, ...project.comps.map((c) => c.id)) + 1;
    nextLayerId = Math.max(0, ...project.layers.map((l) => l.id)) + 1;
    const uids = project.layers.flatMap((l) => Object.values(l.props).map((p) => p.uid));
    nextUid = Math.max(0, ...uids) + 1;
    undoStack.length = 0;
    redoStack.length = 0;
  }

  init();
  return fake;
}

// Test-only adapter (subpath "@studio/editor-bridge/fake").
export { attachFakeBridge, type FakeBridgeOptions } from "./attachFake";
