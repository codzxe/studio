import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AGENT_COMMAND_IDS,
  AGENT_COMMAND_REGISTRY,
  AGENT_COMMAND_UNDOABLE,
  META_COMMAND_IDS,
  isAgentCommand,
} from "../src/command-registry.js";
import { checkBatchCommands } from "../src/engine-batch.js";
import type { CommandParamInfo } from "../src/engine-batch.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(PACKAGE_DIR, "fixtures", "engine-command-ids.json");
const EXTRACT_SCRIPT = path.join(PACKAGE_DIR, "scripts", "extract-engine-registry.mjs");
const UPSTREAM_MD = path.resolve(PACKAGE_DIR, "..", "..", "apps", "editor", "UPSTREAM.md");

/** The verified seed list from docs/phases/M5-SEAMS.md — the minimum curated surface. */
const SEAMS_SEED_IDS: readonly string[] = [
  "comp.new",
  "layer.newText",
  "layer.newSolid",
  "layer.newNull",
  "layer.newAdjustment",
  "layer.rename",
  "layer.arrange",
  "layer.setBlendMode",
  "text.insert",
  "text.addSelector",
  "prop.set",
  "prop.addKey",
  "prop.toggleAnimation",
  "anim.addKeyframe",
  "anim.applyPreset",
  "anim.applyBuiltinPreset",
  "effect.apply",
  "effect.remove",
  "effect.reorder",
  "keys.move",
  "keys.easyEase",
  "edit.undo",
  "edit.redo",
  "comp.open",
  "comp.close",
  "comp.addMarker",
];

interface EngineFixture {
  readonly extractedAt: string;
  readonly enginePin: string;
  readonly ids: readonly string[];
  readonly queries: readonly string[];
}

function readFixture(): EngineFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as EngineFixture;
}

/** The pinned commit from the live apps/editor/UPSTREAM.md — the fixture must track it. */
function liveEnginePin(): string {
  const row = /^\|\s*Pinned commit\s*\|\s*`([0-9a-f]{7,40})`\s*\|/m.exec(
    readFileSync(UPSTREAM_MD, "utf8"),
  );
  expect(row, "apps/editor/UPSTREAM.md must carry a Pinned commit row").not.toBeNull();
  return row?.[1] ?? "";
}

function paramsOf(id: string): readonly CommandParamInfo[] {
  const info = AGENT_COMMAND_REGISTRY[id];
  expect(info, `registry entry ${id}`).toBeDefined();
  return info?.params ?? [];
}

function param(id: string, name: string): CommandParamInfo {
  const found = paramsOf(id).find((p) => p.name === name);
  expect(found, `${id} must declare a "${name}" param`).toBeDefined();
  return found ?? { name, required: false };
}

// ---------------------------------------------------------------------------
// Provenance: every curated id exists in the REAL engine (law #5, SEAMS)
// ---------------------------------------------------------------------------

describe("command-registry: provenance against the real engine", () => {
  it("every curated id is an extracted engine cmd! id", () => {
    const fixture = readFixture();
    const missing = AGENT_COMMAND_IDS.filter((id) => !fixture.ids.includes(id));
    expect(missing, "curated ids missing from the engine extraction").toEqual([]);
  });

  it("the fixture exists, is fresh and matches the vendored engine pin", () => {
    const fixture = readFixture();
    expect(fixture.ids.length).toBeGreaterThan(0);
    expect(fixture.queries.length).toBeGreaterThan(0);
    expect(fixture.enginePin).toBe(liveEnginePin());
    expect(fixture.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("the extraction is in the documented band " +
    "(SEAMS quotes 558 cmd!/52 query! from a single-line grep; the multiline-aware " +
    "scanner finds more — 580/63 at pin 9db7f3b2)", () => {
    const fixture = readFixture();
    expect(fixture.ids.length).toBeGreaterThanOrEqual(500);
    expect(fixture.ids.length).toBeLessThanOrEqual(700);
    expect(fixture.queries.length).toBeGreaterThanOrEqual(40);
    expect(fixture.queries.length).toBeLessThanOrEqual(120);
    expect(new Set(fixture.ids).size).toBe(fixture.ids.length);
    expect(new Set(fixture.queries).size).toBe(fixture.queries.length);
    expect(fixture.ids.filter((id) => fixture.queries.includes(id))).toEqual([]);
  });

  it("engine.batch is not a mutating registration; command.list/describe are queries", () => {
    const fixture = readFixture();
    expect(fixture.ids).not.toContain("engine.batch"); // raw CommandSpec in batch.rs
    expect(fixture.queries).toContain("command.list"); // query.rs:210
    expect(fixture.queries).toContain("command.describe"); // query.rs:211
  });
});

// ---------------------------------------------------------------------------
// The curated surface
// ---------------------------------------------------------------------------

describe("command-registry: curated allowlist", () => {
  it("covers the binding SEAMS seed list", () => {
    const missing = SEAMS_SEED_IDS.filter((id) => !isAgentCommand(id));
    expect(missing).toEqual([]);
  });

  it("stays within the 25–40 band the seam asks for", () => {
    expect(AGENT_COMMAND_IDS.length).toBeGreaterThanOrEqual(25);
    expect(AGENT_COMMAND_IDS.length).toBeLessThanOrEqual(40);
  });

  it("ids match [a-z][a-zA-Z0-9.]* — no __proto__-style keys can ever be registered", () => {
    const pattern = /^[a-z][a-zA-Z0-9.]*$/;
    for (const id of Object.keys(AGENT_COMMAND_REGISTRY)) {
      expect(id, `registry key ${id}`).toMatch(pattern);
    }
    expect(AGENT_COMMAND_IDS.every((id) => pattern.test(id))).toBe(true);
    // prototype-pollution names are not members, whatever the prototype chain says
    expect(isAgentCommand("__proto__")).toBe(false);
    expect(isAgentCommand("constructor")).toBe(false);
    expect(isAgentCommand("toString")).toBe(false);
    expect(isAgentCommand("hasOwnProperty")).toBe(false);
    expect(Object.keys(AGENT_COMMAND_REGISTRY)).not.toContain("__proto__");
  });

  it("every entry is well-formed: id === key, title set, params unique and typed", () => {
    for (const [id, info] of Object.entries(AGENT_COMMAND_REGISTRY)) {
      expect(info.id).toBe(id);
      expect(info.title, `${id} title`).toBeTruthy();
      const names = (info.params ?? []).map((p) => p.name);
      expect(new Set(names).size, `${id} param names must be unique`).toBe(names.length);
      for (const p of info.params ?? []) {
        expect(p.name).toMatch(/^[A-Za-z0-9_]+$/);
        expect(typeof p.required).toBe("boolean");
        expect(p.type ?? "unknown").toBeTruthy();
      }
    }
  });

  it("AGENT_COMMAND_IDS is a sorted, frozen mirror of the registry", () => {
    expect(AGENT_COMMAND_IDS).toEqual([...Object.keys(AGENT_COMMAND_REGISTRY)].sort());
    expect(Object.isFrozen(AGENT_COMMAND_IDS)).toBe(true);
  });

  it("isAgentCommand handles the boundaries", () => {
    expect(isAgentCommand("layer.newText")).toBe(true);
    expect(isAgentCommand("prop.set")).toBe(true);
    expect(isAgentCommand("")).toBe(false);
    expect(isAgentCommand("comp.newx")).toBe(false); // near miss
    expect(isAgentCommand("comp.new ")).toBe(false); // trailing whitespace
    expect(isAgentCommand("COMP.NEW")).toBe(false); // case
    expect(isAgentCommand("comp")).toBe(false); // prefix of a real id is not an id
    expect(isAgentCommand("engine.batch")).toBe(false); // transport, not a command
    expect(isAgentCommand("command.list")).toBe(false); // meta, not a command
  });

  it("META_COMMAND_IDS are transport/meta and never batchable", () => {
    expect(META_COMMAND_IDS).toEqual(["command.describe", "command.list", "engine.batch"]);
    expect(META_COMMAND_IDS.filter((id) => isAgentCommand(id))).toEqual([]);
    expect(META_COMMAND_IDS.filter((id) => AGENT_COMMAND_IDS.includes(id))).toEqual([]);
  });

  it("AGENT_COMMAND_UNDOABLE mirrors the allowlist (undo is proven at batch level)", () => {
    expect(AGENT_COMMAND_UNDOABLE.size).toBe(AGENT_COMMAND_IDS.length);
    expect(AGENT_COMMAND_UNDOABLE.has("edit.undo")).toBe(true);
    expect(AGENT_COMMAND_UNDOABLE.has("edit.redo")).toBe(true);
    expect([...AGENT_COMMAND_UNDOABLE].every((id) => isAgentCommand(id))).toBe(true);
  });

  it("checkBatchCommands validates real steps against the curated registry", () => {
    const ok = checkBatchCommands(
      {
        steps: [
          { command: "comp.new", params: { name: "Main", width: 1920, height: 1080 } },
          { command: "layer.newSolid", params: { name: "BG", color: "#0B0D10" } },
          { command: "layer.rename", params: { layer: "$2.layer", name: "BG" } },
        ],
      },
      AGENT_COMMAND_REGISTRY,
    );
    expect(ok).toEqual([]);
    const issues = checkBatchCommands(
      {
        steps: [
          { command: "comp.open", params: {} }, // missing required `comp`
          { command: "layer.newShape", params: {} }, // real engine id, NOT curated
        ],
      },
      AGENT_COMMAND_REGISTRY,
    );
    expect(issues).toEqual([
      { step: 1, command: "comp.open", reason: "missing_required_param", param: "comp" },
      { step: 2, command: "layer.newShape", reason: "unknown_command" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Params parse correctness — hand-verified against the Rust registrations
// ---------------------------------------------------------------------------

describe("command-registry: params parsed from the Rust docs (hand-verified)", () => {
  it("comp.open (comp.rs:297): one required param with an id|name hint", () => {
    expect(paramsOf("comp.open")).toEqual([{ name: "comp", required: true, type: "id|name" }]);
  });

  it("layer.newSolid (layer.rs:1601): five optional params, #hex|[r,g,b] folds into the hint", () => {
    expect(paramsOf("layer.newSolid")).toEqual([
      { name: "name", required: false, type: "unknown" },
      { name: "color", required: false, type: "#hex|[r,g,b]" },
      { name: "width", required: false, type: "unknown" },
      { name: "height", required: false, type: "unknown" },
      { name: "pixelAspect", required: false, type: "unknown" },
    ]);
  });

  it("keys.move (prop.rs:1362): delta is required, merge optional, (s) is the description", () => {
    expect(paramsOf("keys.move")).toEqual([
      { name: "delta", required: true, type: "unknown", description: "s" },
      { name: "merge", required: false, type: "unknown" },
    ]);
  });

  it("text.addSelector (animation.rs:494): kind required; animator optional with uid|index hint", () => {
    expect(paramsOf("text.addSelector")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "animator", required: false, type: "uid|index" },
      { name: "kind", required: true, type: "range|wiggly|expression" },
    ]);
  });

  it("prop.addKey (prop.rs:1313): path|prop alternatives are both optional (engine parity)", () => {
    expect(paramsOf("prop.addKey")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "path", required: false, type: "unknown" },
      { name: "prop", required: false, type: "unknown" },
      { name: "time", required: false, type: "unknown", description: "layer s by default" },
      { name: "timeBase", required: false, type: "layer|comp" },
      { name: "value", required: false, type: "unknown" },
    ]);
  });

  it("keys.set (anim.rs:543): time is required, newTime carries (same base)", () => {
    expect(paramsOf("keys.set")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "path", required: false, type: "unknown" },
      { name: "prop", required: false, type: "unknown" },
      { name: "time", required: true, type: "unknown", description: "layer s by default" },
      { name: "newTime", required: false, type: "unknown", description: "same base" },
      { name: "timeBase", required: false, type: "layer|comp" },
      { name: "value", required: false, type: "unknown" },
      { name: "merge", required: false, type: "unknown" },
    ]);
  });

  it("layer.arrange (layer.rs:1698): to is required; above keeps its layer hint", () => {
    expect(paramsOf("layer.arrange")).toEqual([
      { name: "layers", required: false, type: "unknown" },
      { name: "to", required: true, type: "front|forward|backward|back" },
      { name: "index", required: false, type: "unknown" },
      { name: "above", required: false, type: "layer" },
    ]);
  });

  it("edit.undo (edit.rs:862) and anim.addKeyframe (animation.rs:484): no params, tail prose is the description", () => {
    expect(paramsOf("edit.undo")).toEqual([]);
    expect(paramsOf("edit.redo")).toEqual([]);
    expect(paramsOf("anim.addKeyframe")).toEqual([]);
    expect(AGENT_COMMAND_REGISTRY["anim.addKeyframe"]?.description).toBe(
      "keys the selected properties at the CTI",
    );
  });

  it("text.insert (text_edit.rs:587): text required; the tail is the command description", () => {
    expect(paramsOf("text.insert")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "text", required: true, type: "unknown" },
      { name: "range", required: false, type: "[start, end]" },
      { name: "merge", required: false, type: "unknown" },
    ]);
    expect(AGENT_COMMAND_REGISTRY["text.insert"]?.description).toBe("replaces the selection");
  });

  it("layer.newText (layer.rs:1592): everything optional; bracket hints and paren descriptions", () => {
    expect(paramsOf("layer.newText").every((p) => !p.required)).toBe(true);
    expect(param("layer.newText", "name")).toEqual({
      name: "name",
      required: false,
      type: "unknown",
      description: "layer name; default the text",
    });
    expect(param("layer.newText", "box")).toEqual({
      name: "box",
      required: false,
      type: "[x,y,w,h]",
      description: "paragraph text, comp space",
    });
    expect(param("layer.newText", "position")).toEqual({
      name: "position",
      required: false,
      type: "[x,y]",
    });
    expect(AGENT_COMMAND_REGISTRY["layer.newText"]?.description).toBe(
      "attributes as layer.setText",
    );
  });

  it("layer.setText (layer.rs:1727): nested hints ({tag: value}, [x,y,w,h]|null) and quoted alternatives", () => {
    expect(param("layer.setText", "leading")).toEqual({
      name: "leading",
      required: false,
      type: 'px|"auto"',
    });
    expect(param("layer.setText", "variations")).toEqual({
      name: "variations",
      required: false,
      type: "{tag: value}",
      description: "variable font axes; null resets",
    });
    expect(param("layer.setText", "box")).toEqual({
      name: "box",
      required: false,
      type: "[x,y,w,h]|null",
      description: "layer space",
    });
    expect(param("layer.setText", "range").type).toBe("[start, end]");
  });

  it("comp.new (comp.rs:277): startTime|startTimecode alternatives and mixed hints", () => {
    expect(paramsOf("comp.new").every((p) => !p.required)).toBe(true);
    expect(param("comp.new", "background")).toEqual({
      name: "background",
      required: false,
      type: "[r,g,b]|#hex",
    });
    expect(param("comp.new", "preserveFrameRate")).toEqual({
      name: "preserveFrameRate",
      required: false,
      type: "bool",
    });
    expect(param("comp.new", "renderer")).toEqual({
      name: "renderer",
      required: false,
      type: "classic3D|advanced3D",
    });
    expect(param("comp.new", "duration").description).toBe("s");
    expect(param("comp.new", "adaptiveSampleLimit").description).toBe("16–256");
    const start = paramsOf("comp.new").filter(
      (p) => p.name === "startTime" || p.name === "startTimecode",
    );
    expect(start.map((p) => p.name)).toEqual(["startTime", "startTimecode"]);
    expect(start.every((p) => !p.required)).toBe(true);
  });

  it("prop.set (prop.rs:1303): value required; multi-clause paren descriptions survive", () => {
    expect(paramsOf("prop.set").filter((p) => p.required)).toEqual([
      { name: "value", required: true, type: "unknown" },
    ]);
    expect(param("prop.set", "selected").description).toBe("also the other selected layers");
    expect(param("prop.set", "offset").description).toBe("them by the same change");
    expect(param("prop.set", "proportional").description).toBe(
      "with offset: Proportional Scrubbing, each layer by its share in selection order, the first none, the last all",
    );
    expect(param("prop.set", "dims").description).toBe(
      "with selected, a typed value: the components edited, e.g. [2] for Z; the other layers keep the rest of their own value",
    );
  });

  it("prop.reset (prop.rs:1333): path|prop optional; the → tail is the command description", () => {
    expect(paramsOf("prop.reset").every((p) => !p.required)).toBe(true);
    expect(AGENT_COMMAND_REGISTRY["prop.reset"]?.description).toContain("removes the expression");
  });

  it("layer.setBlendMode (layer.rs:1655): colon hints keep their | alternatives intact", () => {
    expect(paramsOf("layer.setBlendMode")).toEqual([
      { name: "layers", required: false, type: "unknown" },
      { name: "mode", required: false, type: "Normal|Multiply|Screen|…" },
      { name: "step", required: false, type: "±1" },
    ]);
  });

  it("anim.applyPreset (animation.rs:483): path | preset alternatives are both optional", () => {
    expect(paramsOf("anim.applyPreset")).toEqual([
      { name: "path", required: false, type: "unknown" },
      { name: "preset", required: false, type: "unknown" },
      { name: "layers", required: false, type: "unknown" },
    ]);
  });

  it("anim.applyBuiltinPreset (anim_presets.rs:199): preset required with doc pointer", () => {
    expect(param("anim.applyBuiltinPreset", "preset")).toEqual({
      name: "preset",
      required: true,
      type: "id|name",
      description: "see anim.builtinPresets",
    });
  });

  it("effect.apply / effect.remove / effect.reorder / effect.toggle / effect.reset (effect.rs)", () => {
    expect(param("effect.apply", "effect")).toEqual({
      name: "effect",
      required: true,
      type: "id|name",
      description: "e.g. Gaussian Blur",
    });
    expect(param("effect.remove", "effect")).toEqual({
      name: "effect",
      required: true,
      type: "index|uid|name",
    });
    expect(paramsOf("effect.reorder")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "effect", required: true, type: "unknown" },
      { name: "index", required: true, type: "unknown" },
    ]);
    expect(paramsOf("effect.toggle")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "effect", required: true, type: "unknown" },
      { name: "value", required: false, type: "unknown" },
    ]);
    expect(paramsOf("effect.reset")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "effect", required: true, type: "unknown" },
    ]);
  });

  it("layer.style.* (styles.rs:222/231/232): style required, display-name note kept", () => {
    expect(param("layer.style.add", "style").type).toBe(
      "dropShadow|innerShadow|outerGlow|innerGlow|bevelEmboss|satin|colorOverlay|gradientOverlay|stroke",
    );
    expect(param("layer.style.add", "style").description).toBe("or display name");
    expect(param("layer.style.remove", "style")).toEqual({
      name: "style",
      required: true,
      type: "id|name|uid|layerStyles",
    });
    expect(paramsOf("layer.style.toggle")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "style", required: true, type: "id|name|uid|layerStyles" },
      { name: "value", required: false, type: "unknown" },
    ]);
  });

  it("layer.applyTextPreset (text_anim.rs:467) and text.delete (text_edit.rs:588)", () => {
    expect(param("layer.applyTextPreset", "preset")).toEqual({
      name: "preset",
      required: true,
      type: "typewriter|fadeUpCharacters|bounceInWords|trackingIn|scramble|blurIn|jitter|dropInLines",
    });
    expect(paramsOf("text.delete")).toEqual([
      { name: "layer", required: false, type: "unknown" },
      { name: "direction", required: false, type: "backward|forward" },
      { name: "word", required: false, type: "unknown" },
      { name: "range", required: false, type: "[start, end]" },
      { name: "merge", required: false, type: "unknown" },
    ]);
  });

  it("prop.toggleKey / prop.toggleAnimation / comp.open / comp.addMarker / keys.easyEase", () => {
    expect(paramsOf("prop.toggleKey").map((p) => p.name)).toEqual([
      "layer",
      "path",
      "prop",
      "selected",
    ]);
    expect(paramsOf("prop.toggleAnimation").map((p) => p.name)).toEqual([
      "layer",
      "path",
      "prop",
      "value",
      "merge",
      "selected",
    ]);
    expect(paramsOf("comp.addMarker")).toEqual([
      { name: "time", required: false, type: "unknown" },
      { name: "comment", required: false, type: "unknown" },
    ]);
    expect(paramsOf("keys.easyEase")).toEqual([
      { name: "which", required: false, type: "both|in|out" },
    ]);
  });

  it("titles are the verbatim Rust labels", () => {
    expect(AGENT_COMMAND_REGISTRY["comp.new"]?.title).toBe("New Composition...");
    expect(AGENT_COMMAND_REGISTRY["keys.easyEase"]?.title).toBe("Easy Ease");
    expect(AGENT_COMMAND_REGISTRY["layer.newSolid"]?.title).toBe("Solid...");
    expect(AGENT_COMMAND_REGISTRY["anim.applyPreset"]?.title).toBe("Apply Animation Preset...");
    expect(AGENT_COMMAND_REGISTRY["edit.undo"]?.title).toBe("Undo");
  });
});

// ---------------------------------------------------------------------------
// The extraction script
// ---------------------------------------------------------------------------

describe("command-registry: extraction script", () => {
  it("runs from the package dir and is idempotent (byte-stable fixture)", () => {
    const fixture = readFixture();
    const run = (): { status: string; mutating: number; queries: number } => {
      const result = spawnSync(process.execPath, [EXTRACT_SCRIPT], {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse((result.stdout ?? "").trim()) as {
        status: string;
        mutating: number;
        queries: number;
      };
      expect(summary.mutating).toBe(fixture.ids.length);
      expect(summary.queries).toBe(fixture.queries.length);
      return summary;
    };

    const hashBefore = createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex");
    const first = run();
    const hashAfterFirst = createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex");
    const second = run();
    const hashAfterSecond = createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex");

    expect(first.status).toBe("unchanged"); // committed fixture is up to date
    expect(second.status).toBe("unchanged");
    expect(hashAfterFirst).toBe(hashBefore);
    expect(hashAfterSecond).toBe(hashBefore);
  });
});
