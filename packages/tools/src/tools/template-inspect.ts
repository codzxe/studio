// @studio/tools — template_inspect (§6 row 3; engine `template.inspect`, §7.4).
//
// The FULL manifest for one pinned `id@version` — slot specs with bounds and
// per-slot rules, the layerMap, the palette — as the model's fill-planning
// view (§6: "Full manifest (slots, rules, layer map)"). §6.1 noise never
// reaches the model: author/license stay in ctx (the cached manifest keeps
// them; they are simply never copied into the view), and the thumbnail is
// TRUNCATED to its basename so signed query strings, bucket prefixes and
// absolute paths can never leak (§6.1).
//
// The view rides the §6.1 envelope as compact JSON in the `summary` string;
// when a pathological manifest (§7.5 keeps templates ~12 slots) exceeds the
// 2000-char compact-reply cap it degrades down a deterministic ladder and says
// so in a warning — it never throws and never returns a malformed envelope.
//
// Two seam notes (types.ts is the contract; both flagged in the worklog):
//   - TemplateManifest declares only {id, version, slots, layerMap?}; the
//     other §7.2 fields (name, tags, canvas, rules, layerMap objects,
//     thumbnail) are read defensively per-field via probeFields — present
//     when the runtime catalog serves real §7.2 manifests (the gateway
//     catalog does), absent otherwise; invalid values are dropped, never
//     echoed (§6.1).
//   - `unknown_template` is not in the §13.3 catalog yet (W4-J flagged the
//     adoption for the config wave), so a miss uses the shared unknown-id
//     code `not_found` with the candidate pins in the hint (§6.1) — swap the
//     UNKNOWN_TEMPLATE_CODE constant once the catalog adopts it.

import { z } from "zod";
import {
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNING_CHARS,
  cappedArray,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
  zColor,
  zTemplateRef,
} from "../kit.js";
import type {
  TemplateManifest,
  TemplateSlotSpec,
  Tool,
  ToolContext,
  ToolErr,
  ToolErrorCode,
} from "../types.js";
import {
  MAX_SHOWN_PINS,
  MAX_TAG_CHARS,
  byIdThenVersion,
  capText,
  fieldOf,
  pinOf,
  probeFields,
} from "./template-list.js";

// ---------------------------------------------------------------------------
// Contract limits (gateway catalog caps; §7.5 keeps templates ~12 slots)
// ---------------------------------------------------------------------------

/** A §7.2 manifest declares at most 64 slots (gateway catalog cap). */
export const MAX_MANIFEST_SLOTS = 64;
/** Truncated thumbnail basenames stay this small. */
const MAX_THUMBNAIL_CHARS = 80;
/** layerMap lists at most 128 layers (gateway catalog cap). */
const MAX_LAYERMAP_ENTRIES = 128;
/** Deepest degrade-ladder level: `{template}` alone always fits. */
const MAX_LADDER_LEVEL = 4;

/** Slots are trimmed to these fill-critical keys at trim level 2. */
const SLOT_CORE_KEYS = [
  "kind",
  "label",
  "required",
  "optional",
  "layer",
  "bounds",
  "component",
  "fit",
  "minPixels",
  "maxChars",
  "maxLines",
  "constraints",
] as const;

const TRIM_STEPS: Readonly<Record<number, string>> = {
  1: "dropped the description and per-slot vars/autoFit",
  2: "reduced slots to core fill fields and layerMap entries to roles",
  3: "reduced slots to name:kind pairs (no layerMap/rules)",
  4: "kept only the id@version pin",
};

// ---------------------------------------------------------------------------
// Pin parsing (§7.2 id@version)
// ---------------------------------------------------------------------------

export interface TemplatePin {
  readonly id: string;
  readonly version: string;
}

/** Splits an `id@version` pin at its first "@" (zTemplateRef guarantees the shape). */
export function parseTemplatePin(ref: string): TemplatePin | undefined {
  const at = ref.indexOf("@");
  if (at <= 0 || at + 1 >= ref.length) return undefined;
  return { id: ref.slice(0, at), version: ref.slice(at + 1) };
}

function sameVersion(a: string, b: string): boolean {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  return a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

// ---------------------------------------------------------------------------
// §7.2 slot probes (validated; garbage dropped, never echoed — §6.1)
// ---------------------------------------------------------------------------

const FINITE = z.number().refine((n) => Number.isFinite(n), { message: "must be finite" });

/** `[x, y, w, h]` within ±1e7 with non-negative size (engine check_bounds). */
const BOUNDS = z.tuple([FINITE, FINITE, FINITE, FINITE]).refine(
  ([x, y, w, h]) =>
    Math.abs(x) <= 1e7 && Math.abs(y) <= 1e7 && w >= 0 && w <= 1e7 && h >= 0 && h <= 1e7,
  { message: "bounds must be [x, y, w, h] within ±1e7 with non-negative size" },
);

/** The engine's five slot kinds (§7.3) — the seam type has no "component". */
const SLOT_KIND = z.enum(["text", "image", "color", "visibility", "component"]);

const SLOT_FIELDS = {
  layer: z.string().min(1).max(256),
  bounds: BOUNDS,
  component: z.string().min(1).max(129),
  font: z.string().min(1).max(256),
  weight: z.string().min(1).max(64),
  size: FINITE,
  lineHeight: FINITE,
  maxLines: z.number().int().min(1),
  maxChars: z.number().int().min(1),
  align: z.enum(["left", "center", "right", "justify"]),
  color: zColor,
  fit: z.enum(["cover", "contain", "fill"]),
  minPixels: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  focal: z.tuple([FINITE, FINITE]).refine(
    ([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1,
    { message: "focal points are within 0..1" },
  ),
  autoFit: z.object({ minSize: FINITE, maxSize: FINITE }),
  vars: z.record(
    z.string().min(1).max(64),
    z.union([z.string().max(2000), FINITE, z.boolean(), z.null()]),
  ),
  optional: z.boolean(),
} as const satisfies Readonly<Record<string, z.ZodTypeAny>>;

/** Declared per-slot `constraints` keep primitives and number tuples only. */
const CONSTRAINT_VALUE = z.union([
  z.string().max(256),
  FINITE,
  z.boolean(),
  z.null(),
  z.array(FINITE).max(8),
]);

function sanitizeConstraints(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.length === 0 || key.length > 64) continue;
    const parsed = CONSTRAINT_VALUE.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** Full slot view: declared seam fields + probed §7.2 fields, fixed key order. */
function slotView(spec: TemplateSlotSpec, runtime: unknown): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  const kind = SLOT_KIND.safeParse(fieldOf(runtime, "kind"));
  view.kind = kind.success ? kind.data : spec.kind;
  if (spec.label !== undefined) view.label = spec.label;
  if (spec.required !== undefined) view.required = spec.required;
  Object.assign(view, probeFields(runtime, SLOT_FIELDS));
  if (spec.constraints !== undefined) {
    const clean = sanitizeConstraints(spec.constraints);
    if (Object.keys(clean).length > 0) view.constraints = clean;
  }
  return view;
}

/** The degrade-ladder's per-level slot view (level 0 is the full view). */
function slotViewAt(full: Record<string, unknown>, level: number): Record<string, unknown> {
  if (level <= 0) return full;
  if (level === 1) {
    const trimmed = { ...full };
    delete trimmed.vars;
    delete trimmed.autoFit;
    return trimmed;
  }
  if (level === 2) {
    const core: Record<string, unknown> = {};
    for (const key of SLOT_CORE_KEYS) {
      if (key in full) core[key] = full[key];
    }
    return core;
  }
  return { kind: full.kind };
}

// ---------------------------------------------------------------------------
// §7.2 top-level probes
// ---------------------------------------------------------------------------

function layerMapEntry(value: unknown, level: number): unknown {
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value !== "object" || value === null) return undefined;
  const probed = probeFields(value, {
    role: z.string().min(1).max(64),
    fill: zColor,
    mask: z.string().min(1).max(64),
    maskRadius: FINITE,
    component: z.string().min(1).max(129),
  });
  if (level >= 2) return typeof probed.role === "string" ? probed.role : undefined;
  return Object.keys(probed).length > 0 ? probed : undefined;
}

/** Thumbnail → basename: no signed queries, buckets, dirs or absolute paths. */
function probeThumbnail(raw: unknown): string | undefined {
  const value = fieldOf(raw, "thumbnail");
  if (typeof value !== "string" || value.length === 0) return undefined;
  const path = value.split("?")[0] ?? value;
  const base = path.split("/").pop() ?? path;
  return capText(base.replace(/[\u0000-\u001f]/g, ""), MAX_THUMBNAIL_CHARS);
}

/**
 * The model's manifest view at `level` (0 = full). Key order is fixed:
 * template, name, description, tags, canvas, slots, rules, layerMap,
 * thumbnail — author/license are never probed, so never emitted.
 */
function buildView(
  pin: string,
  manifest: TemplateManifest,
  level: number,
): Record<string, unknown> {
  const raw: unknown = manifest;
  const view: Record<string, unknown> = { template: pin };
  if (level >= MAX_LADDER_LEVEL) return view;
  const top = probeFields(raw, {
    name: z.string().min(1).max(128),
    description: z.string().max(4096),
    tags: cappedArray(32, cappedString(MAX_TAG_CHARS, 1)),
  });
  if (typeof top.name === "string") view.name = top.name;
  if (level < 1 && typeof top.description === "string") view.description = top.description;
  if (Array.isArray(top.tags)) view.tags = top.tags;
  const canvas = probeFields(fieldOf(raw, "canvas"), {
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000),
    background: zColor,
  });
  if (typeof canvas.width === "number" && typeof canvas.height === "number") {
    const canvasView: Record<string, unknown> = { width: canvas.width, height: canvas.height };
    if (typeof canvas.background === "string") canvasView.background = canvas.background;
    view.canvas = canvasView;
  }
  const slotEntries = Object.entries(manifest.slots).slice(0, MAX_MANIFEST_SLOTS);
  if (slotEntries.length > 0) {
    const slots: Record<string, unknown> = {};
    for (const [name, spec] of slotEntries) {
      if (name.length === 0 || name.length > 64) continue;
      slots[name] = slotViewAt(slotView(spec, spec), level);
    }
    view.slots = slots;
  }
  if (level < 3) {
    const rulesRaw = fieldOf(raw, "rules");
    const rules = probeFields(rulesRaw, {
      safeArea: FINITE,
      minContrast: FINITE,
      mustLayers: cappedArray(32, cappedString(256, 1)),
      maxTextLayers: z.number().int().min(1),
    });
    const paletteRaw = fieldOf(rulesRaw, "palette");
    if (Array.isArray(paletteRaw)) {
      const palette: string[] = [];
      for (const entry of paletteRaw.slice(0, 32)) {
        const parsed = zColor.safeParse(entry);
        if (parsed.success) palette.push(parsed.data);
      }
      if (palette.length > 0) rules.palette = palette;
    }
    if (Object.keys(rules).length > 0) view.rules = rules;
    const mapRaw = fieldOf(raw, "layerMap");
    if (typeof mapRaw === "object" && mapRaw !== null) {
      const layerMap: Record<string, unknown> = {};
      for (const [layer, value] of Object.entries(mapRaw).slice(0, MAX_LAYERMAP_ENTRIES)) {
        if (layer.length === 0 || layer.length > 256) continue;
        const entry = layerMapEntry(value, level);
        if (entry !== undefined) layerMap[layer] = entry;
      }
      if (Object.keys(layerMap).length > 0) view.layerMap = layerMap;
    }
  }
  const thumbnail = probeThumbnail(raw);
  if (thumbnail !== undefined) view.thumbnail = thumbnail;
  return view;
}

// ---------------------------------------------------------------------------
// Unknown-id miss (§6.1: candidates in the hint)
// ---------------------------------------------------------------------------

/**
 * The §13.3 catalog's unknown-id code. The tighter `unknown_template` string
 * (gateway catalog) is pending adoption into ERROR_CODES — swap this one
 * constant when that lands; the message/hints already speak templates.
 */
const UNKNOWN_TEMPLATE_CODE: ToolErrorCode = "not_found";

async function unknownTemplateErr(ctx: ToolContext, ref: string): Promise<ToolErr> {
  const pin = parseTemplatePin(ref);
  const summaries = [...(await ctx.templates.list())].sort(byIdThenVersion);
  const pins = summaries.map(pinOf);
  const shown = pins.slice(0, MAX_SHOWN_PINS).join(", ");
  const hint =
    pins.length === 0
      ? "the template catalog is empty"
      : `known templates: ${shown}${pins.length > MAX_SHOWN_PINS ? ", ..." : ""}`;
  if (pin !== undefined) {
    const versions = summaries
      .filter((summary) => summary.id === pin.id)
      .map((summary) => summary.version);
    if (versions.length > 0 && !versions.some((version) => sameVersion(version, pin.version))) {
      return err(UNKNOWN_TEMPLATE_CODE, `Template "${pin.id}" has no version ${pin.version}`, {
        hint: capText(`versions of ${pin.id}: ${versions.join(", ")}; ${hint}`, MAX_HINT_CHARS),
        retryable: false,
      });
    }
  }
  return err(UNKNOWN_TEMPLATE_CODE, `No template "${ref}" in the catalog`, {
    hint: capText(hint, MAX_HINT_CHARS),
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// template_inspect (§6 row 3)
// ---------------------------------------------------------------------------

export interface TemplateInspectArgs {
  readonly template: string;
}

const templateInspectArgs = strictObject({
  template: zTemplateRef, // id@version, regex-validated (§6.1)
});

export const templateInspect: Tool<TemplateInspectArgs> = defineTool({
  name: "template_inspect",
  description:
    "Show one template's full manifest for a pinned id@version — slot bounds and rules, layerMap, palette — the view template_apply and template_fill plan against.",
  args: templateInspectArgs,
  async run(ctx, args) {
    const manifest = await ctx.templates.get(args.template);
    if (manifest === undefined) {
      return unknownTemplateErr(ctx, args.template);
    }
    const pin = pinOf(manifest);
    const warnings: string[] = [];
    const slotCount = Object.keys(manifest.slots).length;
    if (slotCount > MAX_MANIFEST_SLOTS) {
      const shown = `manifest has ${slotCount} slots; showing the first ${MAX_MANIFEST_SLOTS}`;
      warnings.push(capText(`${shown} (§7.5 keeps templates ≈12)`, MAX_WARNING_CHARS));
    }
    let level = 0;
    let json = JSON.stringify(buildView(pin, manifest, level));
    while (json.length > MAX_SUMMARY_CHARS && level < MAX_LADDER_LEVEL) {
      level += 1;
      json = JSON.stringify(buildView(pin, manifest, level));
    }
    if (level > 0) {
      warnings.push(
        capText(
          `manifest trimmed to fit the §6.1 compact reply: ${TRIM_STEPS[level] ?? "trimmed"}`,
          MAX_WARNING_CHARS,
        ),
      );
    }
    ctx.logger.debug("template_inspect resolved", { pin, trimLevel: level });
    return ok({
      summary: json,
      warnings: warnings.length === 0 ? undefined : warnings,
    });
  },
});
