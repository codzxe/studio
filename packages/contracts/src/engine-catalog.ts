// @studio/contracts — the generated ENGINE command catalog, tier 1 (round-12
// "Tool catalog v3", docs/research/round12-design.md + 12-w2-a5 §6 Option B).
//
// GATEWAY-ONLY module — exposed via the package subpath
// `@studio/contracts/catalog`, deliberately NOT re-exported from the barrel
// (src/index.ts): the browser tier must never bundle the full params docs
// (~100 KB); it consumes the tier-2 ids-only list (./allowed-commands.js)
// instead. The gateway uses this file to validate `studio.engine_commands`
// proposals (unknown/denied id → repairable tool error naming the closest
// catalog id) and to build the system prompt from ENGINE_CATALOG_DIGEST.
//
// Provenance: scripts/extract-engine-registry.mjs generates
// src/generated/engine-catalog.json from the vendored engine's `cmd!`
// registrations (labels + params docs VERBATIM; READ-ONLY `query!` ids are
// never batchable and are excluded), tags every denied class at generation
// time (app-chrome / filesystem / code-exec / render-output / render-queue /
// destructive / path-param) and rescues the curated property-path exceptions
// via its explicit ALLOW_ADDITIONS list. `hasPath: true` + no `deny` ⇒ the
// `path` param names a PROPERTY path (`path|prop`, engine parity), never a
// filesystem location — the seven curated ids are the only such exceptions.
//
// The artifacts are committed build outputs (like apps/web/api/gateway.mjs):
// regenerate with `node scripts/extract-engine-registry.mjs` after an engine
// pin bump; the run is idempotent (byte-stable when nothing changed).

import catalogJson from "./generated/engine-catalog.json" with { type: "json" };
import presetLibraryJson from "./generated/preset-library.json" with { type: "json" };

import { ALLOWED_COMMAND_IDS, isAllowedEngineCommand } from "./allowed-commands.js";

export {
  ALLOWED_COMMAND_IDS,
  ALLOWED_COMMAND_COUNT,
  isAllowedEngineCommand,
} from "./allowed-commands.js";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/** Format version of the generated catalog artifact (bump on shape changes). */
export const ENGINE_CATALOG_VERSION: number = catalogJson.version;

/** Generation stamp of the committed artifact (ISO 8601). */
export const ENGINE_CATALOG_GENERATED_AT: string = catalogJson.generatedAt;

/** One entry of the generated engine command catalog. */
export interface EngineCatalogCommand {
  /** Engine command id, e.g. "layer.newText" (authoritative: command.describe). */
  readonly id: string;
  /** Menu label, verbatim from the Rust registration. */
  readonly title: string;
  /** Id prefix — the catalog's grouping key (e.g. "layer", "renderQueue"). */
  readonly category: string;
  /** The registration's params doc, verbatim (grammar mirror: command-registry.ts). */
  readonly paramsDoc: string;
  /** A params-doc param names a path-like key (property-path exceptions keep this true). */
  readonly hasPath: boolean;
  /** Deny tag; ABSENT = allowed. One of: app-chrome, filesystem, code-exec,
   * render-output, render-queue, destructive, path-param. */
  readonly deny?: string;
}

/**
 * The full generated catalog: one entry per MUTATING (batchable) engine
 * command, sorted by id, frozen. `deny === undefined` ⇔ allowed —
 * the ALLOWED_COMMAND_IDS tier-2 list is exactly that subset.
 */
export const ENGINE_COMMAND_CATALOG: readonly EngineCatalogCommand[] = Object.freeze(
  catalogJson.commands satisfies readonly EngineCatalogCommand[],
);

/** Catalog entry by id, or `undefined` (never a fallback). */
export function findEngineCommand(id: string): EngineCatalogCommand | undefined {
  return ENGINE_COMMAND_CATALOG.find((entry) => entry.id === id);
}

// ---------------------------------------------------------------------------
// ENGINE_CATALOG_DIGEST — the compact prompt string (categories + exemplars)
// ---------------------------------------------------------------------------
//
// docs/research/round12-design.md + 12-w1-a1 §4a-4: the system prompt NEVER carries
// the full catalog (~100 KB of params docs) and never ships 731 tool defs —
// the model gets this ~2-3 KB digest (allowed categories, counts, one-line
// descriptions, the params-doc grammar, ~20 exemplar ids), then discovers
// exact params on demand: studio.list_commands → studio.describe_command →
// studio.engine_commands.

/** One-line, model-facing description per allowed category (hand-curated). */
const CATEGORY_BLURBS: Readonly<Record<string, string>> = Object.freeze({
  anim: "animation — keyframe at the CTI, built-in presets",
  camera: "3D camera solves, orbit/dolly/pan, stereo rigs",
  comp: "compositions — create/open/close, settings, markers",
  contentFill: "content-aware fill settings",
  edit: "clipboard + history — undo/redo, cut/copy/paste, split, duplicate",
  effect: "effects — apply/remove/reorder/toggle/reset",
  essential: "essential-graphics controls — add, link, push to comp",
  footage: "footage items — trims, edit into comps",
  jobs: "cancel background analysis jobs",
  keys: "keyframes — set/move/nudge/ease/select",
  layer: "layers — create text/solid/camera/light, parent, rename, arrange, switches",
  light: "3D lights",
  liquify: "liquify strokes",
  markers: "layer and composition markers",
  mask: "masks — create, vertices, feather, modes",
  material: "3D materials",
  motion: "motion sketch",
  objectMatte: "object mattes",
  paint: "paint and clone strokes",
  path: "shape-path editing — bezier ops, grouping",
  project: "project items — folders, labels, comments",
  prop: "property values by property path (transform/position, effects/#1/…)",
  puppet: "puppet pins",
  render: "render backend selection",
  renderQueue: "render queue — settings, render, stop",
  roto: "rotoscoping — strokes, spans, freeze",
  shape: "shape items — fills, strokes, dashes",
  text: "text editing — insert/delete, selectors",
  time: "playhead and work area",
  track: "tracking — camera, mask, planar, face",
  warp: "warp stabilization",
});

/**
 * Exemplar ids shown in the digest (filtered against the ALLOWED list when the
 * digest is built, so a deny-rule change can never advertise a dead id).
 */
const EXEMPLAR_IDS: readonly string[] = Object.freeze([
  "layer.newText",
  "layer.newSolid",
  "layer.newCamera",
  "layer.rename",
  "comp.new",
  "prop.set",
  "prop.addKey",
  "keys.set",
  "anim.applyBuiltinPreset",
  "effect.apply",
  "mask.new",
  "text.insert",
  "layer.style.add",
  "layer.applyTextPreset",
  "markers.set",
  "puppet.addPin",
  "roto.stroke",
  "track.camera",
  "camera.createFromSolve",
  "edit.pasteSvg",
]);

function buildCatalogDigest(): string {
  const counts = new Map<string, number>();
  for (const id of ALLOWED_COMMAND_IDS) {
    const category = id.split(".")[0] ?? "";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const lines = [...counts.keys()]
    .sort()
    .map(
      (category) =>
        `- ${category} (${counts.get(category) ?? 0}): ${CATEGORY_BLURBS[category] ?? "commands"}`,
    );
  const exemplars = EXEMPLAR_IDS.filter(isAllowedEngineCommand).join(", ");
  // w8 harness fix — the built-in preset names ride the digest: the model
  // needs actual NAMES for anim.applyBuiltinPreset {preset}, and the engine's
  // own params doc points at anim.builtinPresets — a read-only query the
  // tool surface can never execute (query! ids are not batchable). Shipping
  // the names kills both the dead-end lookup AND the recurring
  // "anim.builtinPresets is not an allowed command id" loop.
  const presetLines = (
    presetLibraryJson as ReadonlyArray<{
      readonly category: string;
      readonly presets: readonly string[];
    }>
  ).map((group) => `- ${group.category}: ${group.presets.join(", ")}`);
  return [
    "ENGINE COMMAND CATALOG — allowed ids only. The full library is INLINE below; " +
      "call studio.describe_command only when a params doc below is not enough, then propose " +
      "ids+params as steps of studio.engine_commands. " +
      "Anything not listed here is denied; never invent an id. Read-only engine queries " +
      "(anim.builtinPresets, text.presets, comp.presets, comp.info, layer.tree, …) are NOT " +
      "proposable steps — their data is already covered here or by the read tools.",
    "Params-doc grammar: {name? hint (description)} — a bare name is required, `name?` optional; " +
      "`|` before `:` lists alternative names (pass any one), after `:` lists value alternatives; " +
      "layers are referenced by id|name|#n; keyframe times are LAYER seconds by default " +
      '(pass timeBase: "comp" for comp seconds); in one batch `$N.key` reads an earlier step\'s result.',
    ...lines,
    `Exemplars: ${exemplars}.`,
    "Built-in preset library (pass the name as `preset`; apply with anim.applyBuiltinPreset, " +
      "layer.applyTextPreset, comp.applyPreset):",
    ...presetLines,
  ].join("\n");
}

/**
 * The precomputed compact catalog digest for the gateway system prompt
 * (categories + counts + one-liners + grammar + exemplars; ≤ 4 KB, test-pinned).
 */
export const ENGINE_CATALOG_DIGEST: string = buildCatalogDigest();
