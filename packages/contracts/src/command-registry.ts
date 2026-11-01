// @studio/contracts — the curated agent command registry (M5 seam, SEAMS §"command-registry").
//
// Law #5: the model never sees raw engine commands or filesystem paths. Write tools take
// curated args; plans compile server-side into `engine.batch` steps, and the plan
// compiler validates every step against THIS allowlist. Law #6: one atomic
// `engine.batch` = one undo step = one version.
//
// Provenance (SEAMS: "never invent a command id"):
//   * Every id below is a real `cmd!` macro registration in the vendored EffectCraft
//     engine at pin 9db7f3b2 (apps/apps/editor/UPSTREAM.md), extracted by
//     scripts/extract-engine-registry.mjs into fixtures/engine-command-ids.json
//     (580 mutating `cmd!` ids + 63 read-only `query!` ids across
//     apps/editor/crates/engine/src/commands/*.rs). Tests/command-registry.test.ts enforces
//     curated id ⊆ fixture id for every entry.
//   * `title` and the `params` doc are transcribed VERBATIM from the Rust registration
//     (file:line pinned per entry in AGENT_COMMAND_SOURCES). The `params` docs are then
//     parsed into CommandParamInfo[] by mirroring the engine's own grammar code —
//     accepted_params / doc_pieces / params_schema (commands/mod.rs:275-366):
//       - pieces split at top-level `,`; `|` before the first top-level `:` separates
//         alternative parameter NAMES (`path|prop`, `path | preset`) and each alternative
//         becomes its own OPTIONAL descriptor (engine: "key with alternatives is
//         optional"); `|` after a `:` is a value hint (`mode?: Multiply|Screen`);
//       - `name?` is optional, bare `name` is required; `{}` means no params;
//       - the text after a name (with a leading `:` stripped) up to the first
//         top-level `(` is the type hint — `unknown` when absent; nameless `|`
//         continuations (`color? #hex` + `[r,g,b]`) fold back into the previous hint;
//       - the parenthetical after a piece is the parameter description; prose after the
//         closing `}` (e.g. "} (replaces the selection)") is the command description.
//   * The registry is deliberately NARROW: 37 ids — the binding SEAMS seed list plus a
//     few clearly-safe writes in the style/prop/text/anim domains (layer.setText,
//     layer.style.*, effect.toggle/reset, prop.toggleKey/reset, keys.set, text.delete,
//     layer.applyTextPreset). NO destructive, reveal, import, render, file-system or
//     UI-state commands; queries (`query!`, journal: false) are never batchable and are
//     never listed here. `engine.batch`, `command.list` and `command.describe` are
//     transport/meta ids — see META_COMMAND_IDS.
//
// Do not widen this surface without a DECISIONS.md ruling.

import type { CommandInfo, CommandParamInfo, CommandSchema } from "./engine-batch.js";

// ---------------------------------------------------------------------------
// Params-doc grammar (mirrors the engine: commands/mod.rs:275-366)
// ---------------------------------------------------------------------------

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Split `text` at separator characters that sit outside every (), [], {} pair. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * Split one doc piece at top-level `|`, but only before the first top-level `:` —
 * after it, `|` separates alternatives inside a value hint (`mode?: A|B`). Mirrors the
 * engine's `in_value` flag (mod.rs:300).
 */
function splitAlternatives(piece: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inValue = false;
  let current = "";
  for (const ch of piece) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth -= 1;
    if (depth === 0) {
      if (ch === ":") inValue = true;
      if (ch === "|" && !inValue) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

interface ParsedSegment {
  readonly name: string;
  readonly question: boolean;
  readonly hint: string;
  readonly description?: string;
}

/** `name?` + optional type hint + optional parenthetical description → one segment. */
function parseSegment(segment: string): ParsedSegment | undefined {
  const [head = "", name = "", questionMark = ""] = /^([A-Za-z0-9_]+)(\??)/.exec(segment) ?? [];
  if (name === "") return undefined; // nameless continuation (e.g. "[r,g,b]") — merged by the caller
  const rest = segment.slice(head.length);
  // Type hint: up to the first top-level "(" (the description), brackets tracked.
  let depth = 0;
  let hint = "";
  let index = 0;
  while (index < rest.length) {
    const ch = rest.charAt(index);
    if (ch === "(" && depth === 0) break;
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth -= 1;
    hint += ch;
    index += 1;
  }
  // Description: the balanced paren run that follows, if any.
  let description: string | undefined;
  if (index < rest.length && rest.charAt(index) === "(") {
    index += 1;
    let parens = 1;
    let body = "";
    while (index < rest.length) {
      const ch = rest.charAt(index);
      if (OPEN.has(ch)) parens += 1;
      else if (CLOSE.has(ch)) {
        parens -= 1;
        if (parens === 0) {
          index += 1;
          break;
        }
      }
      body += ch;
      index += 1;
    }
    if (body.trim() !== "") description = body.trim();
    hint += rest.slice(index); // rare leftovers are folded into the hint, never dropped
  }
  const type = hint.trim().replace(/^:/, "").trim();
  return { name, question: questionMark === "?", hint: type, description };
}

/**
 * One doc piece (top-level `,` slice) → its CommandParamInfo descriptors: one per
 * alternative name. Engine parity: a piece with alternatives (`path|prop`) marks ALL of
 * them optional; a single bare name is required.
 */
function parsePiece(piece: string): CommandParamInfo[] {
  const named: ParsedSegment[] = [];
  for (const segment of splitAlternatives(piece)) {
    const parsed = parseSegment(segment);
    if (parsed === undefined) {
      const previous = named[named.length - 1];
      if (previous !== undefined) {
        named[named.length - 1] = { ...previous, hint: `${previous.hint}|${segment}` };
      }
      continue;
    }
    named.push(parsed);
  }
  return named.map((segment) => ({
    name: segment.name,
    required: named.length === 1 && !segment.question,
    type: segment.hint === "" ? "unknown" : segment.hint,
    ...(segment.description !== undefined ? { description: segment.description } : {}),
  }));
}

/** The end index of the `{…}` key list that starts a params doc, or -1 when there is none. */
function keyListEnd(doc: string): number {
  if (!doc.startsWith("{")) return -1;
  let depth = 0;
  let index = 0;
  for (const ch of doc) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) {
      depth -= 1;
      if (depth === 0 && ch === "}") return index;
    }
    index += 1;
  }
  return -1;
}

/** `{layer?, name}` → [{layer, optional}, {name, required}]; `{} — prose` → []. */
function parseParamsDoc(doc: string): CommandParamInfo[] {
  const end = keyListEnd(doc);
  if (end === -1) return [];
  return splitTopLevel(doc.slice(1, end), ",").flatMap((piece) => parsePiece(piece));
}

/** Prose after the key list — "} (replaces the selection)", "} — keys …", "} → removes …". */
function commandDescription(doc: string): string | undefined {
  const end = keyListEnd(doc);
  if (end === -1) return undefined;
  const tail = doc
    .slice(end + 1)
    .trim()
    .replace(/^[—→]\s*/, "")
    .trim();
  if (tail === "") return undefined;
  // A tail that is exactly one parenthetical loses the wrapping parentheses.
  if (tail.startsWith("(") && tail.endsWith(")")) {
    let depth = 0;
    let closed = -1;
    let index = 0;
    for (const ch of tail) {
      if (OPEN.has(ch)) depth += 1;
      else if (CLOSE.has(ch)) {
        depth -= 1;
        if (depth === 0) {
          closed = index;
          break;
        }
      }
      index += 1;
    }
    if (closed === tail.length - 1) return tail.slice(1, -1).trim();
  }
  return tail;
}

// ---------------------------------------------------------------------------
// The curated registry — transcribed from the Rust registrations at pin 9db7f3b2
// ---------------------------------------------------------------------------

interface CommandSource {
  /** Rust registration site, e.g. "apps/editor/crates/engine/src/commands/comp.rs:277". */
  readonly source: string;
  /** The command's menu label, verbatim. */
  readonly title: string;
  /** The `params` doc string, verbatim. */
  readonly params: string;
}

const AGENT_COMMAND_SOURCES: Readonly<Record<string, CommandSource>> = {
  // -- compositions ----------------------------------------------------------
  "comp.new": {
    source: "apps/editor/crates/engine/src/commands/comp.rs:277",
    title: "New Composition...",
    params:
      "{name?, width?, height?, frameRate?, duration? (s), startTime? (s) | startTimecode?, background? [r,g,b]|#hex, pixelAspect?, shutterAngle?, shutterPhase?, motionBlurSamples?, adaptiveSampleLimit? (16–256), preserveFrameRate?: bool, preserveResolution?: bool, renderer?: classic3D|advanced3D, anchor?, open?}",
  },
  "comp.open": {
    source: "apps/editor/crates/engine/src/commands/comp.rs:297",
    title: "Open Composition",
    params: "{comp: id|name}",
  },
  "comp.close": {
    source: "apps/editor/crates/engine/src/commands/comp.rs:298",
    title: "Close Composition",
    params: "{comp?}",
  },
  "comp.addMarker": {
    source: "apps/editor/crates/engine/src/commands/comp.rs:301",
    title: "Add Marker",
    params: "{time?, comment?}",
  },

  // -- layers ----------------------------------------------------------------
  "layer.newText": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1592",
    title: "Text",
    params:
      "{text?, name? (layer name; default the text), position? [x,y], box? [x,y,w,h] (paragraph text, comp space), vertical?, edit? (start editing), font?, style?, size?, fill?, stroke?, applyFill?, applyStroke?, strokeWidth?, tracking?, leading?, baselineShift?, hScale?, vScale?, tsume?, fauxBold?, fauxItalic?, allCaps?, smallCaps?, baseline?, superscript?, subscript?, kerning?, ligatures?, justify?, indentLeft?, indentRight?, indentFirst?, spaceBefore?, spaceAfter?, direction?, composer?, hangingPunctuation?, strokeOverFill?} (attributes as layer.setText)",
  },
  "layer.newSolid": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1601",
    title: "Solid...",
    params: "{name?, color? #hex|[r,g,b], width?, height?, pixelAspect?}",
  },
  "layer.newNull": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1602",
    title: "Null Object",
    params: "{name?}",
  },
  "layer.newAdjustment": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1612",
    title: "Adjustment Layer",
    params: "{name?}",
  },
  "layer.rename": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1653",
    title: "Rename",
    params: "{layer?, name}",
  },
  "layer.arrange": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1698",
    title: "Arrange",
    params: "{layers?, to: front|forward|backward|back, index?, above?: layer}",
  },
  "layer.setBlendMode": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1655",
    title: "Blending Mode",
    params: "{layers?, mode?: Normal|Multiply|Screen|…, step?: ±1}",
  },
  "layer.setText": {
    source: "apps/editor/crates/engine/src/commands/layer.rs:1727",
    title: "Edit Text",
    params:
      '{layer?, range?: [start, end] (characters; default all), text?, font?, style?, size?, fill?, stroke?, applyFill?, applyStroke?, strokeWidth?, tracking?, leading?: px|"auto", baselineShift? px, hScale? %, vScale? %, tsume? %, fauxBold?, fauxItalic?, allCaps?, smallCaps?, baseline?: normal|superscript|subscript, superscript?, subscript?, kerning?: metrics|optical|number, ligatures?, discretionaryLigatures? (OpenType), contextualAlternates?, stylisticAlternates?, stylisticSets?: [1–20], ss01?, ss02?, ss03?, ss04?, ss05?, ss06?, ss07?, ss08?, ss09?, ss10?, ss11?, ss12?, ss13?, ss14?, ss15?, ss16?, ss17?, ss18?, ss19?, ss20?, swash?, titling?, ordinals?, fractions?, allSmallCaps?, figureStyle?: default|lining|oldStyle, figureWidth?: default|proportional|tabular, figures?, variations?: {tag: value} (variable font axes; null resets), justify?: left|center|right|justifyLeft|justifyCenter|justifyRight|justifyAll, indentLeft?, indentRight?, indentFirst?, spaceBefore?, spaceAfter?, direction?: ltr|rtl, composer?: everyLine|singleLine, hangingPunctuation?, strokeOverFill?, box?: [x,y,w,h]|null (layer space), vertical?}',
  },

  // -- text ------------------------------------------------------------------
  "text.insert": {
    source: "apps/editor/crates/engine/src/commands/text_edit.rs:587",
    title: "Type Text",
    params: "{layer?, text, range?: [start, end], merge?} (replaces the selection)",
  },
  "text.delete": {
    source: "apps/editor/crates/engine/src/commands/text_edit.rs:588",
    title: "Delete Text",
    params: "{layer?, direction?: backward|forward, word?, range?: [start, end], merge?}",
  },
  "text.addSelector": {
    source: "apps/editor/crates/engine/src/commands/animation.rs:494",
    title: "Add Text Selector",
    params: "{layer?, animator?: uid|index, kind: range|wiggly|expression}",
  },
  "layer.applyTextPreset": {
    source: "apps/editor/crates/engine/src/commands/text_anim.rs:467",
    title: "Apply Text Animation Preset",
    params:
      "{layer?, preset: typewriter|fadeUpCharacters|bounceInWords|trackingIn|scramble|blurIn|jitter|dropInLines}",
  },

  // -- properties ------------------------------------------------------------
  "prop.set": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1303",
    title: "Set Property Value",
    params:
      "{layer?, path|prop, value, time? (layer s by default), timeBase?: layer|comp, merge?, selected? (also the other selected layers), offset? (them by the same change), proportional? (with offset: Proportional Scrubbing, each layer by its share in selection order, the first none, the last all), dims? (with selected, a typed value: the components edited, e.g. [2] for Z; the other layers keep the rest of their own value)}",
  },
  "prop.addKey": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1313",
    title: "Add Keyframe",
    params: "{layer?, path|prop, time? (layer s by default), timeBase?: layer|comp, value?}",
  },
  "prop.toggleAnimation": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1312",
    title: "Toggle Stopwatch",
    params: "{layer?, path|prop, value?, merge?, selected?}",
  },
  "prop.toggleKey": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1314",
    title: "Add or Remove Keyframe at Current Time",
    params: "{layer?, path|prop, selected?}",
  },
  "prop.reset": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1333",
    title: "Reset Property",
    params:
      "{layer?, path|prop, default?} → removes the expression; the value becomes `default`, else the property's own (an effect parameter's, a Transform property's), as a keyframe at the current time when the property is animated",
  },

  // -- keyframes / animation -------------------------------------------------
  "anim.addKeyframe": {
    source: "apps/editor/crates/engine/src/commands/animation.rs:484",
    title: "Add Keyframe",
    params: "{} — keys the selected properties at the CTI",
  },
  "anim.applyPreset": {
    source: "apps/editor/crates/engine/src/commands/animation.rs:483",
    title: "Apply Animation Preset...",
    params: "{path | preset, layers?}",
  },
  "anim.applyBuiltinPreset": {
    source: "apps/editor/crates/engine/src/commands/anim_presets.rs:199",
    title: "Apply Built-in Animation Preset",
    params: "{preset: id|name (see anim.builtinPresets), layers?}",
  },
  "keys.set": {
    source: "apps/editor/crates/engine/src/commands/anim.rs:543",
    title: "Edit Keyframe",
    params:
      "{layer?, path|prop, time (layer s by default), newTime? (same base), timeBase?: layer|comp, value?, merge?}",
  },
  "keys.move": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1362",
    title: "Move Keyframes",
    params: "{delta (s), merge?}",
  },
  "keys.easyEase": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1364",
    title: "Easy Ease",
    params: "{which?: both|in|out}",
  },
  // The keyframe-interpolation workflow (2026-11-01 Google-launch fix): the
  // set_keyframes write tool compiles eased keys to these commands, and the
  // model can compose them directly via studio.engine_commands —
  // keys.select targets exact keys, then keys.interpolation / keys.easyEase
  // (which: both|in|out — the engine's easyEaseIn/Out are the same command)
  // applies to the selection. Two ids keep the digest inside its band.
  "keys.select": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1354",
    title: "Select Keyframes",
    params:
      "{keys: [{layer, prop: uid | path (or `path`), time (layer s by default)}], timeBase?: layer|comp, add?, toggle?: bool, selectProperties?: bool}",
  },
  "keys.interpolation": {
    source: "apps/editor/crates/engine/src/commands/prop.rs:1372",
    title: "Keyframe Interpolation...",
    params:
      "{interpolation?: linear|bezier|continuousBezier|autoBezier|hold, in?|out?: linear|bezier|hold, autoBezier?, continuous?, spatial?: linear|bezier|continuousBezier|autoBezier, roving?}",
  },

  // -- effects ---------------------------------------------------------------
  "effect.apply": {
    source: "apps/editor/crates/engine/src/commands/effect.rs:619",
    title: "Apply Effect",
    params: "{effect: id|name (e.g. Gaussian Blur), layers?}",
  },
  "effect.remove": {
    source: "apps/editor/crates/engine/src/commands/effect.rs:637",
    title: "Remove Effect",
    params: "{layer?, effect: index|uid|name}",
  },
  "effect.reorder": {
    source: "apps/editor/crates/engine/src/commands/effect.rs:640",
    title: "Reorder Effect",
    params: "{layer?, effect, index}",
  },
  "effect.toggle": {
    source: "apps/editor/crates/engine/src/commands/effect.rs:638",
    title: "Toggle Effect",
    params: "{layer?, effect, value?}",
  },
  "effect.reset": {
    source: "apps/editor/crates/engine/src/commands/effect.rs:644",
    title: "Reset Effect",
    params: "{layer?, effect}",
  },

  // -- layer styles ----------------------------------------------------------
  "layer.style.add": {
    source: "apps/editor/crates/engine/src/commands/styles.rs:222",
    title: "Add Layer Style",
    params:
      "{style: dropShadow|innerShadow|outerGlow|innerGlow|bevelEmboss|satin|colorOverlay|gradientOverlay|stroke (or display name), layers?}",
  },
  "layer.style.remove": {
    source: "apps/editor/crates/engine/src/commands/styles.rs:231",
    title: "Remove Layer Style",
    params: "{layer?, style: id|name|uid|layerStyles}",
  },
  "layer.style.toggle": {
    source: "apps/editor/crates/engine/src/commands/styles.rs:232",
    title: "Toggle Layer Style",
    params: "{layer?, style: id|name|uid|layerStyles, value?}",
  },

  // -- history ---------------------------------------------------------------
  "edit.undo": {
    source: "apps/editor/crates/engine/src/commands/edit.rs:862",
    title: "Undo",
    params: "{}",
  },
  "edit.redo": {
    source: "apps/editor/crates/engine/src/commands/edit.rs:863",
    title: "Redo",
    params: "{}",
  },
};

function buildRegistry(): CommandSchema {
  const registry: Record<string, CommandInfo> = {};
  for (const [id, source] of Object.entries(AGENT_COMMAND_SOURCES)) {
    registry[id] = {
      id,
      title: source.title,
      description: commandDescription(source.params),
      params: parseParamsDoc(source.params),
    };
  }
  return registry;
}

/** Curated allowlist of agent-batchable engine commands (id → descriptor). */
export const AGENT_COMMAND_REGISTRY: CommandSchema = Object.freeze(buildRegistry());

/** Sorted ids of {@link AGENT_COMMAND_REGISTRY} (frozen snapshot). */
export const AGENT_COMMAND_IDS: readonly string[] = Object.freeze(
  Object.keys(AGENT_COMMAND_REGISTRY).sort(),
);

/** `true` when `id` is in the curated agent allowlist. */
export function isAgentCommand(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_COMMAND_REGISTRY, id);
}

/**
 * Undoability heuristic — source-verified at the BATCH level, deliberately not
 * per command:
 *   * `edit.undo` / `edit.redo` are real engine registrations (edit.rs:862-863), so the
 *     engine Session has an undo history;
 *   * an atomic `engine.batch` folds every undo step its steps recorded into ONE step
 *     labeled with the batch label (batch.rs `fold`), which is law #6;
 *   * every curated id is a `cmd!` registration (journal: true, mod.rs:134).
 * Membership therefore means: "run inside an applied atomic agent batch, its effects
 * are covered by that batch's single undo step" — NOT "pushes its own undo step"
 * (that is a per-handler property and is not claimed here).
 */
export const AGENT_COMMAND_UNDOABLE: ReadonlySet<string> = new Set(AGENT_COMMAND_IDS);

/**
 * Transport/meta ids the registry never lists as batchable commands: the batch
 * envelope itself (raw `CommandSpec` in batch.rs, explicitly rejected inside batches
 * by the engine's NOT_IN_BATCH list) and the live-registry introspection queries
 * (query.rs:210-211, `journal: false`). They exist in the engine but never in
 * AGENT_COMMAND_IDS.
 */
export const META_COMMAND_IDS: readonly string[] = Object.freeze([
  "command.describe",
  "command.list",
  "engine.batch",
]);
