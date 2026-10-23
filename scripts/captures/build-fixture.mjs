#!/usr/bin/env node
/**
 * W3-I THROWAWAY capture tooling — builds the REAL marketing fixture project
 * (`.ecproj`) for the seeded demo project, WITHOUT the Rust toolchain (not on
 * this box — e2e/README.md §3's generator needs cargo).
 *
 * Method (honest, engine-verified shapes only): start from the repo's REAL
 * engine-serialized project (`services/worker/tests/fixtures/project.ecproj`,
 * savedBy 0.13.0 schema 2 — round-tripped by the worker integration harness)
 * and transform it with Node:
 *   - a fresh 1920×1080 30fps 10s comp "Main" (comp "Main" keeps the MOCK
 *     chat context card truthful — "Comp: Main");
 *   - three Solid layers (Backdrop / Signal Bar / Title Card) cloned from the
 *     fixture's real Layer serde shape (switches, auto_orient, masks/effects/
 *     transform/materialOptions prop groups), with fresh uids;
 *   - real keyframes (serde `keys` on properties): a position slide with
 *     Bezier eases and a scale pop-in — so the timeline shows keyframe
 *     diamonds and scrubbing shows motion (needed for demo-loop).
 * Every structural shape (Value envelopes {"t","v"}, Tick ints at
 * 254_016_000_000/s, prop `match` ids, group kinds) is cloned verbatim from
 * the fixture bytes — nothing is invented. The result is verified by the
 * LIVE engine (boot → data-editor-phase="open") before any capture is taken.
 *
 * Output: <repo>/services/gateway/.local/storage/workspaces/org_demo/projects/
 *          prj_demo/versions/{ver_demo_1,ver_demo_2,ver_demo_3}/project.ecproj
 * (the seeded object_keys — packages/db seed writes version-ID-keyed keys).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/z/my-project";
const SRC = join(REPO, "services/worker/tests/fixtures/project.ecproj");
const OUT_ROOT = join(
  REPO,
  "services/gateway/.local/storage/workspaces/org_demo/projects/prj_demo/versions",
);
const VERSIONS = ["ver_demo_1", "ver_demo_2", "ver_demo_3"];

const TICKS_PER_SECOND = 254_016_000_000n;
const fps = 30;
const DURATION_SECONDS = 10;
const DURATION = BigInt(DURATION_SECONDS) * TICKS_PER_SECOND;

const src = JSON.parse(readFileSync(SRC, "utf8"));
const SRC_COMP = src.items[1].kind;

// ---------------------------------------------------------------------------
// uid + id allocators (fresh, collision-free)
// ---------------------------------------------------------------------------
let uid = 0;
const nextUid = () => ++uid;
let itemId = 0;
const nextItemId = () => ++itemId;

// ---------------------------------------------------------------------------
// Cloned-from-fixture serde shapes
// ---------------------------------------------------------------------------
const EASE = { speed: 0, influence: 1 / 3 }; // keyframe::Ease::EASY
const EASE_3 = [EASE, EASE, EASE];

const v3 = (x, y, z) => ({ t: "Vec3", v: [x, y, z] });
const scalar = (n) => ({ t: "Scalar", v: n });

/** A keyframe cloned from keyframe::Keyframe serde (defaults filled). */
function key(timeSeconds, value, { bezierIn = false, bezierOut = false } = {}) {
  return {
    time: Number((BigInt(Math.round(timeSeconds * 1000)) * TICKS_PER_SECOND) / 1000n),
    value,
    in_interp: bezierIn ? "Bezier" : "Linear",
    out_interp: bezierOut ? "Bezier" : "Linear",
    in_ease: bezierIn ? EASE_3 : [],
    out_ease: bezierOut ? EASE_3 : [],
    continuous: false,
    auto_bezier: false,
    spatial_in: [0, 0, 0],
    spatial_out: [0, 0, 0],
    spatial_auto: true,
    spatial_continuous: false,
    roving: false,
  };
}

const SWITCHES = src.items[1].kind.layers[0].switches; // verbatim clone
const AUTO_ORIENT = src.items[1].kind.layers[0].auto_orient; // "Off"

/** Transform group cloned from the fixture's real Transform (build::transform). */
function transformGroup(anchor, position, scale, opacity, { positionKeys = null, scaleKeys = null } = {}) {
  const prop = (match, name, value, ui, extra = {}) => ({
    node: "Prop",
    uid: nextUid(),
    match,
    name,
    value,
    ui,
    ...extra,
  });
  return {
    node: "Group",
    uid: nextUid(),
    match: "transform",
    name: "Transform",
    kind: { kind: "Plain" },
    enabled: true,
    children: [
      prop("anchor", "Anchor Point", v3(...anchor), { kind: "Point" }, { spatial: true }),
      prop("position", "Position", v3(...position), { kind: "Point" }, {
        spatial: true,
        ...(positionKeys ? { keys: positionKeys } : {}),
      }),
      prop("scale", "Scale", v3(...scale), { kind: "Percent" }, scaleKeys ? { keys: scaleKeys } : {}),
      prop("orientation", "Orientation", v3(0, 0, 0), { kind: "Angle" }, { three_d_only: true }),
      prop("rotationX", "X Rotation", scalar(0), { kind: "Angle" }, { three_d_only: true }),
      prop("rotationY", "Y Rotation", scalar(0), { kind: "Angle" }, { three_d_only: true }),
      prop("rotation", "Z Rotation", scalar(0), { kind: "Angle" }),
      prop("opacity", "Opacity", scalar(opacity), {
        kind: "Slider",
        min: 0,
        max: 100,
        slider_min: 0,
        slider_max: 100,
        decimals: 0,
      }),
    ],
  };
}

/** A Solid layer cloned from the fixture's real Layer serde shape. */
function solidLayer(name, label, solidItemId, { w, h }, transform) {
  const layerUid = nextUid();
  return {
    id: nextUid(),
    name,
    source: { type: "Solid", item: solidItemId },
    label,
    comment: "",
    start_time: 0,
    in_point: 0,
    out_point: Number(DURATION),
    stretch: 100,
    switches: { ...SWITCHES, audio: false },
    blend_mode: "Normal",
    preserve_transparency: false,
    track_matte: null,
    parent: null,
    markers: [],
    auto_orient: AUTO_ORIENT,
    props: {
      uid: layerUid,
      match: "layer",
      name,
      kind: { kind: "Plain" },
      enabled: true,
      children: [
        { node: "Group", uid: nextUid(), match: "masks", name: "Masks", kind: { kind: "Plain" }, enabled: true, children: [] },
        { node: "Group", uid: nextUid(), match: "effects", name: "Effects", kind: { kind: "Plain" }, enabled: true, children: [] },
        transform,
        // Material Options (cloned shape from the fixture's av layer; 2D
        // layers keep it serialized — the editor hides it until 3D).
        {
          node: "Group",
          uid: nextUid(),
          match: "materialOptions",
          name: "Material Options",
          kind: { kind: "Plain" },
          enabled: true,
          children: [
            { node: "Prop", uid: nextUid(), match: "castsShadows", name: "Casts Shadows", value: { t: "Bool", v: false }, ui: { kind: "Checkbox" } },
            { node: "Prop", uid: nextUid(), match: "lightTransmission", name: "Light Transmission", value: scalar(0), ui: { kind: "Percent" } },
            { node: "Prop", uid: nextUid(), match: "acceptsShadows", name: "Accepts Shadows", value: { t: "Enum", v: 0 }, ui: { kind: "Popup", options: ["Off", "On", "Only"] } },
            { node: "Prop", uid: nextUid(), match: "acceptsLights", name: "Accepts Lights", value: { t: "Bool", v: true }, ui: { kind: "Checkbox" } },
            { node: "Prop", uid: nextUid(), match: "ambient", name: "Ambient", value: scalar(100), ui: { kind: "Percent" } },
            { node: "Prop", uid: nextUid(), match: "diffuse", name: "Diffuse", value: scalar(100), ui: { kind: "Percent" } },
            { node: "Prop", uid: nextUid(), match: "specularIntensity", name: "Specular Intensity", value: scalar(100), ui: { kind: "Percent" } },
            { node: "Prop", uid: nextUid(), match: "specularShininess", name: "Specular Shininess", value: scalar(20), ui: { kind: "Slider", min: 1, max: 500, slider_min: 1, slider_max: 100, decimals: 0 } },
            { node: "Prop", uid: nextUid(), match: "metal", name: "Metal", value: scalar(100), ui: { kind: "Percent" } },
          ],
        },
      ],
    },
  };
}

function solidItem(name, label, parent, color, width, height) {
  return {
    id: nextItemId(),
    name,
    label,
    comment: "",
    parent,
    kind: { type: "Solid", color, width, height, pixel_aspect: 1.0 },
  };
}

// ---------------------------------------------------------------------------
// Build the project
// ---------------------------------------------------------------------------
// Items: 1 = "Solids" folder, 2..4 = solids, 5 = comp "Main".
const FOLDER = nextItemId(); // 1
const backdropItem = nextItemId(); // 2
const barItem = nextItemId(); // 3
const cardItem = nextItemId(); // 4
const compItem = nextItemId(); // 5

const W = 1920;
const H = 1080;

// Comp colors are demo CONTENT (original, §11) — a quiet editorial slate.
const BACKDROP = [0.043, 0.047, 0.058];
const BAR = [0.976, 0.522, 0.255];
const CARD = [0.086, 0.094, 0.118];

// Layers render top-first (layer #1 at the top of the stack).
const titleCard = solidLayer(
  "Title Card", "Blue", cardItem, { w: 840, h: 260 },
  transformGroup(
    [420, 130, 0],
    [960, 506, 0],
    [100, 100, 100],
    100,
    {
      scaleKeys: [
        key(0.4, v3(4, 4, 100), { bezierOut: true }),
        key(1.6, v3(100, 100, 100), { bezierIn: true }),
      ],
    },
  ),
);
const signalBar = solidLayer(
  "Signal Bar", "Orange", barItem, { w: 520, h: 12 },
  transformGroup(
    [260, 6, 0],
    [560, 700, 0],
    [100, 100, 100],
    100,
    {
      positionKeys: [
        key(0.2, v3(430, 700, 0), { bezierOut: true }),
        key(3.2, v3(1490, 700, 0), { bezierIn: true }),
      ],
    },
  ),
);
const backdrop = solidLayer(
  "Backdrop", "Sandstone", backdropItem, { w: W, h: H },
  transformGroup([W / 2, H / 2, 0], [W / 2, H / 2, 0], [100, 100, 100], 100),
);

const comp = {
  type: "Comp",
  width: W,
  height: H,
  pixel_aspect: 1.0,
  frame_rate: { num: fps, den: 1 },
  duration: Number(DURATION),
  display_start: 0,
  background: [0.0, 0.0, 0.0],
  work_area: [0, Number(DURATION)],
  layers: [titleCard, signalBar, backdrop],
  markers: [],
  shutter_angle: SRC_COMP.shutter_angle,
  shutter_phase: SRC_COMP.shutter_phase,
  motion_blur_samples: SRC_COMP.motion_blur_samples,
  motion_blur_adaptive_limit: SRC_COMP.motion_blur_adaptive_limit,
  renderer: SRC_COMP.renderer, // "Classic3D" — verbatim clone
  hide_shy: SRC_COMP.hide_shy,
  enable_motion_blur: SRC_COMP.enable_motion_blur,
  enable_frame_blending: SRC_COMP.enable_frame_blending,
  draft_3d: SRC_COMP.draft_3d,
  preserve_frame_rate: SRC_COMP.preserve_frame_rate,
  preserve_resolution: SRC_COMP.preserve_resolution,
  poster_time: 0,
  global_light: SRC_COMP.global_light,
};

const project = {
  savedBy: "0.13.0",
  activeComp: compItem,
  openComps: [compItem],
  schema: 2,
  settings: src.settings, // verbatim clone of the real serialization
  items: {
    [FOLDER]: { id: FOLDER, name: "Solids", label: "None", comment: "", parent: null, kind: { type: "Folder" } },
    [backdropItem]: solidItem("Backdrop", "Sandstone", FOLDER, BACKDROP, W, H),
    [barItem]: solidItem("Signal Bar", "Orange", FOLDER, BAR, 520, 12),
    [cardItem]: solidItem("Title Card", "Blue", FOLDER, CARD, 840, 260),
    [compItem]: { id: compItem, name: "Main", label: "Yellow", comment: "", parent: null, kind: comp },
  },
  next_id: Math.max(FOLDER, backdropItem, barItem, cardItem, compItem, titleCard.id, signalBar.id, backdrop.id) + 1,
};

// Sanity: strict-shape self-check on the fields we fabricated. (uids are
// scoped per layer, not globally unique — the source fixture itself repeats
// them across layers — so uniqueness is checked per layer props tree.)
{
  const json = JSON.stringify(project);
  const parsed = JSON.parse(json);
  for (const layer of parsed.items[parsed.activeComp].kind.layers) {
    const uids = [...JSON.stringify(layer.props).matchAll(/"uid":(\d+)/g)].map((m) => Number(m[1]));
    if (new Set(uids).size !== uids.length) throw new Error(`duplicate uid inside layer ${layer.name}`);
    if (layer.source.type !== "Solid") throw new Error("non-solid layer");
  }
  if (parsed.items[parsed.activeComp].kind.type !== "Comp") throw new Error("activeComp is not a comp");
  console.log(
    `[fixture] comp "Main" ${W}x${H}@${fps} ${DURATION_SECONDS}s · layers:`,
    parsed.items[parsed.activeComp].kind.layers.map((l) => l.name).join(" / "),
  );
}

const bytes = Buffer.from(`${JSON.stringify(project)}\n`, "utf8");
for (const version of VERSIONS) {
  const dir = join(OUT_ROOT, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.ecproj"), bytes);
}
console.log(`[fixture] staged ${bytes.length} bytes at ${VERSIONS.length} seeded object keys`);
console.log(`[fixture] sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
