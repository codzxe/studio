// template-list.test.ts — W5-B: template_list cards (§6 row 2) + template_inspect
// manifest views (§6 row 3). Table-driven per docs/AGENTS.md: deterministic,
// in-memory fakes, no engine, no network.

import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_CHARS, isToolResult, parseToolArgs } from "../src/kit.js";
import {
  MAX_MANIFEST_SLOTS,
  parseTemplatePin,
  templateInspect,
} from "../src/tools/template-inspect.js";
import { MAX_LIST_CARDS, MAX_LIST_TAGS, templateList } from "../src/tools/template-list.js";
import type {
  TemplateCatalogLike,
  TemplateManifest,
  ToolContext,
  ToolResult,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures — §7.2 manifests as the runtime catalog would serve them
// ---------------------------------------------------------------------------

type RawManifest = Record<string, unknown>;

/** The verbatim §7.2 example: every slot kind's fields, rules, layerMap. */
const IG: RawManifest = {
  id: "instagram-post",
  version: 3,
  name: "Instagram Post — Promo",
  description: "A bold product or offer post with a photo, headline, subhead and optional logo.",
  tags: ["social", "promo", "square"],
  canvas: { width: 1080, height: 1080, background: "#F4E7D3" },
  slots: {
    photo: {
      kind: "image",
      layer: "Photo",
      bounds: [0, 0, 1080, 700],
      fit: "cover",
      minPixels: [1080, 700],
      optional: false,
    },
    headline: {
      kind: "text",
      layer: "Headline",
      bounds: [72, 732, 936, 176],
      font: "display",
      weight: "bold",
      size: 96,
      lineHeight: 1.05,
      maxLines: 2,
      maxChars: 42,
      align: "left",
      color: "#3B2A20",
      autoFit: { minSize: 56, maxSize: 110 },
    },
    subhead: {
      kind: "text",
      layer: "Subhead",
      bounds: [72, 924, 936, 56],
      font: "sans",
      size: 36,
      maxLines: 1,
      maxChars: 60,
      color: "#6B5748",
    },
    badge: {
      kind: "component",
      component: "offer-badge@2",
      layer: "Badge",
      bounds: [828, 72, 180, 180],
      optional: true,
      vars: { label: "20% OFF" },
    },
    logo: {
      kind: "image",
      layer: "Logo",
      bounds: [888, 984, 120, 40],
      fit: "contain",
      optional: true,
    },
  },
  rules: {
    safeArea: 48,
    minContrast: 4.5,
    mustLayers: ["Background", "Photo", "Headline"],
    maxTextLayers: 6,
    palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  },
  layerMap: {
    Background: { role: "background", fill: "#F4E7D3" },
    Photo: { role: "image", mask: "rounded", maskRadius: 0 },
    Headline: { role: "headline" },
    Subhead: { role: "supporting-text" },
    Badge: { role: "component", component: "offer-badge@2" },
    Logo: { role: "logo" },
  },
  thumbnail: "thumbnails/instagram-post@3.png",
  license: "public",
  author: "studio",
};

const YT: RawManifest = {
  id: "youtube-thumbnail",
  version: 1,
  name: "YouTube Thumbnail",
  tags: ["video", "thumbnail"],
  canvas: { width: 1280, height: 720 },
  slots: {
    title: { kind: "text", layer: "Title", bounds: [0, 0, 1280, 200], font: "display", size: 120, maxChars: 48 },
    face: { kind: "image", layer: "Face", bounds: [0, 200, 1280, 520], fit: "cover", optional: true },
  },
  rules: { safeArea: 32, palette: ["#111111", "#FFD400"] },
  layerMap: { Title: { role: "headline" }, Face: { role: "image" } },
  thumbnail: "thumbnails/yt.png",
  license: "public",
  author: "studio",
};

/** layerMap values as the minimal seam declares them: plain strings. */
const SLIDE: RawManifest = {
  id: "presentation-slide",
  version: 1,
  name: "Presentation Slide",
  tags: ["deck", "slide"],
  canvas: { width: 1920, height: 1080 },
  slots: {
    heading: { kind: "text", layer: "Heading", bounds: [64, 64, 1792, 200], font: "sans", size: 72, maxChars: 80 },
  },
  layerMap: { Heading: "heading-layer-id" },
  thumbnail: "thumbnails/slide@1.png",
  license: "workspace",
  author: "studio",
};

/** Only the declared seam fields — no §7.2 extras, no canvas, no tags. */
const MINIMAL: RawManifest = {
  id: "minimal-seam",
  version: 7,
  slots: {
    headline: {
      kind: "text",
      label: "Headline",
      required: true,
      constraints: { maxChars: 40, bounds: [0, 0, 100, 50], junk: { deep: true } },
    },
  },
};

/** Invalid §7.2 fields: dropped per-field, never echoed (§6.1). */
const JUNK: RawManifest = {
  id: "junk",
  version: 1,
  name: "Junk",
  slots: {
    head: { kind: "text", layer: "Head", bounds: "not-a-tuple", font: "display", size: Number.NaN, maxChars: 42, color: "nope" },
  },
  rules: { safeArea: 12, palette: ["#FF0000", "not-a-color", "#00FF00"] },
  layerMap: { Head: { role: "headline", evil: { deep: true } } },
  thumbnail: "https://cdn.example.com/t/junk.png?sig=SEKRIT",
  author: "someone",
  license: "workspace",
};

const BASE: readonly RawManifest[] = [IG, YT, SLIDE];

/** A TemplateCatalogLike fake: one list() row + one get() pin per manifest. */
function fakeTemplates(
  raws: readonly RawManifest[],
  ghosts: readonly string[] = [],
): TemplateCatalogLike {
  return {
    get: async (ref) => {
      const found = raws.find((raw) => `${String(raw.id)}@${String(raw.version)}` === ref);
      return found === undefined ? undefined : (found as unknown as TemplateManifest);
    },
    list: async () => [
      ...raws.map((raw) => ({
        id: String(raw.id),
        version: String(raw.version),
        title: String(raw.name ?? raw.id),
        tags: Array.isArray(raw.tags) ? [...(raw.tags as string[])] : [],
        slotCount: Object.keys((raw.slots as Record<string, unknown>) ?? {}).length,
      })),
      ...ghosts.map((ghost) => ({
        id: ghost.split("@")[0] ?? ghost,
        version: ghost.split("@")[1] ?? "1",
        title: ghost,
        tags: [],
        slotCount: 0,
      })),
    ],
  };
}

function makeCtx(templates: TemplateCatalogLike): ToolContext {
  return makeFakeContext({ templates });
}

async function runList(templates: TemplateCatalogLike, args: unknown): Promise<ToolResult> {
  const parsed = parseToolArgs(templateList, args);
  return parsed.ok ? templateList.run(makeCtx(templates), parsed.args, freshSignal()) : parsed;
}

async function runInspect(templates: TemplateCatalogLike, args: unknown): Promise<ToolResult> {
  const parsed = parseToolArgs(templateInspect, args);
  return parsed.ok ? templateInspect.run(makeCtx(templates), parsed.args, freshSignal()) : parsed;
}

interface CardRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly canvas?: { readonly width: number; readonly height: number };
  readonly slots: readonly string[];
}

function cards(result: ToolResult): readonly CardRow[] {
  if (!result.ok) throw new Error("expected an ok result");
  return (JSON.parse(result.summary) as { templates: readonly CardRow[] }).templates;
}

function view(result: ToolResult): Record<string, unknown> {
  if (!result.ok) throw new Error("expected an ok result");
  return JSON.parse(result.summary) as Record<string, unknown>;
}

function warningText(result: ToolResult): string {
  if (!result.ok) throw new Error("expected an ok result");
  return (result.warnings ?? []).join("\n");
}

// ---------------------------------------------------------------------------
// template_list — schema strictness (§6.1)
// ---------------------------------------------------------------------------

describe("template_list schema (§6.1 strict)", () => {
  it("rejects unknown properties, wrong types and over-cap values", async () => {
    const bad: readonly unknown[] = [
      { tags: ["social"], extra: 1 },
      { tags: [] },
      { tags: "social" },
      { tags: [""] },
      { tags: Array<string>(MAX_LIST_TAGS + 1).fill("x") },
      { tags: ["x".repeat(65)] },
      { query: "x".repeat(121) },
      { query: "" },
      { query: 7 },
      null,
    ];
    for (const args of bad) {
      const result = await runList(fakeTemplates(BASE), args);
      expect(result, JSON.stringify(args)).toMatchObject({ ok: false, code: "invalid_args" });
    }
  });

  it("accepts empty args, tag filters and a query", async () => {
    for (const args of [{}, { tags: ["social", "promo"] }, { query: "post" }]) {
      const result = await runList(fakeTemplates(BASE), args);
      expect(result.ok, JSON.stringify(args)).toBe(true);
    }
  });

  it("is registered on the §6 surface with a snake_case name", () => {
    expect(templateList.name).toBe("template_list");
    expect(templateInspect.name).toBe("template_inspect");
  });
});

// ---------------------------------------------------------------------------
// template_list — card view (§6 row 2 / §7.4: slots as names, no manifests)
// ---------------------------------------------------------------------------

describe("template_list card view (§7.4)", () => {
  it("lists compact cards — id, name, version, tags, canvas, slot names", async () => {
    const result = await runList(fakeTemplates(BASE), {});
    const rows = cards(result);
    expect(rows.map((card) => card.id)).toEqual([
      "instagram-post",
      "presentation-slide",
      "youtube-thumbnail",
    ]);
    expect(rows[0]).toEqual({
      id: "instagram-post",
      name: "Instagram Post — Promo",
      version: "3",
      tags: ["social", "promo", "square"],
      canvas: { width: 1080, height: 1080 },
      slots: ["photo", "headline", "subhead", "badge", "logo"],
    });
    expect(Object.keys(rows[0])).toEqual(["id", "name", "version", "tags", "canvas", "slots"]);
  });

  it("is a CARD view: no bounds, rules, layerMap, thumbnail, author or license", async () => {
    const result = await runList(fakeTemplates(BASE), {});
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(result.summary).toContain('"slots"');
    for (const dumped of ['"bounds"', '"rules"', '"layerMap"', '"thumbnail"', '"author"', '"license"']) {
      expect(result.summary, dumped).not.toContain(dumped);
    }
  });

  it("omits canvas when the runtime manifest does not carry one (minimal seam)", async () => {
    const rows = cards(await runList(fakeTemplates([MINIMAL]), {}));
    expect(rows).toEqual([
      { id: "minimal-seam", name: "minimal-seam", version: "7", tags: [], slots: ["headline"] },
    ]);
    expect(Object.keys(rows[0])).toEqual(["id", "name", "version", "tags", "slots"]);
  });

  it("tags+query filter table (engine list_from semantics)", async () => {
    const table: readonly {
      args: Record<string, unknown>;
      ids: readonly string[];
      warning?: RegExp;
    }[] = [
      { args: {}, ids: ["instagram-post", "presentation-slide", "youtube-thumbnail"] },
      { args: { tags: ["social"] }, ids: ["instagram-post"] },
      { args: { tags: ["Social"] }, ids: ["instagram-post"] },
      { args: { tags: [" social "] }, ids: ["instagram-post"] },
      { args: { tags: ["social", "promo"] }, ids: ["instagram-post"] },
      { args: { tags: ["social", "video"] }, ids: [], warning: /no template carries all wanted/ },
      { args: { tags: ["bogus"] }, ids: [], warning: /unknown tag\(s\): bogus/ },
      { args: { query: "promo" }, ids: ["instagram-post"] },
      { args: { query: "SLIDE" }, ids: ["presentation-slide"] },
      { args: { query: "square" }, ids: [], warning: /no template matches the query/ },
      { args: { tags: ["social"], query: "youtube" }, ids: [], warning: /no template carries all/ },
    ];
    for (const row of table) {
      const result = await runList(fakeTemplates(BASE), row.args);
      expect(cards(result).map((card) => card.id), JSON.stringify(row.args)).toEqual([...row.ids]);
      expect(warningText(result), JSON.stringify(row.args)).toMatch(row.warning ?? /^$/);
    }
  });

  it("unknown tags warn with the tags that DO exist", async () => {
    const result = await runList(fakeTemplates(BASE), { tags: ["bogus", "social"] });
    expect(cards(result)).toEqual([]);
    expect(warningText(result)).toMatch(/unknown tag\(s\): bogus/);
    expect(warningText(result)).toMatch(/available tags: deck, promo, slide, social, square, thumbnail, video/);
  });

  it("keeps versions sorted per id (id, then numeric version)", async () => {
    const legacy = { ...IG, version: 2, name: "Instagram Post — Legacy" };
    const rows = cards(await runList(fakeTemplates([IG, legacy]), {}));
    expect(rows.map((card) => `${card.id}@${card.version}`)).toEqual([
      "instagram-post@2",
      "instagram-post@3",
    ]);
  });
});

// ---------------------------------------------------------------------------
// template_list — compact-reply caps and catalog drift
// ---------------------------------------------------------------------------

describe("template_list compact reply (§6.1)", () => {
  it("pages at MAX_LIST_CARDS and says how many matches it hid", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `t-${String(i).padStart(2, "0")}`,
      version: 1,
      name: `Template ${i}`,
      tags: ["bulk"],
      canvas: { width: 100, height: 100 },
      slots: { s: { kind: "text" } },
    }));
    const result = await runList(fakeTemplates(many), {});
    expect(cards(result)).toHaveLength(MAX_LIST_CARDS);
    expect(warningText(result)).toMatch(/showing 16 of 20 matches/);
  });

  it("drops whole cards when even the page cannot fit the 2000-char summary", async () => {
    const fat = Array.from({ length: 6 }, (_, i) => ({
      id: `long-template-${String(i).padStart(2, "0")}`,
      version: 1,
      name: `Long Template Name Number ${i}`,
      tags: ["bulk"],
      canvas: { width: 100, height: 100 },
      slots: Object.fromEntries(
        Array.from({ length: 12 }, (_, j) => [`slot-with-a-very-long-name-${String(j).padStart(2, "0")}`, { kind: "text" }]),
      ),
    }));
    const result = await runList(fakeTemplates(fat), {});
    const shown = cards(result).length;
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThan(6);
    expect(warningText(result)).toMatch(/showing \d+ of 6 matches/);
  });

  it("skips a listed pin whose manifest is missing instead of guessing slots", async () => {
    const result = await runList(fakeTemplates([IG, YT], ["ghost@1"]), {});
    expect(cards(result).map((card) => card.id)).toEqual(["instagram-post", "youtube-thumbnail"]);
    expect(warningText(result)).toMatch(/ghost@1 is listed but its manifest is missing/);
  });

  it("returns an empty card list + warning for an empty catalog", async () => {
    const result = await runList(fakeTemplates([]), {});
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.summary).toBe('{"templates":[]}');
    expect(warningText(result)).toMatch(/the template catalog is empty/);
  });
});

// ---------------------------------------------------------------------------
// template_inspect — schema and pin parsing (§7.2 id@version)
// ---------------------------------------------------------------------------

describe("template_inspect schema + pin parsing", () => {
  it("requires a strict id@version pin (zTemplateRef)", async () => {
    for (const args of [{}, { template: "instagram-post" }, { template: "@3" }, { template: "" }, { template: "instagram-post@3", extra: 1 }]) {
      const result = await runInspect(fakeTemplates(BASE), args);
      expect(result, JSON.stringify(args)).toMatchObject({ ok: false, code: "invalid_args" });
    }
    for (const args of [{ template: "instagram-post@3" }, { template: "Offer-Badge@2.1.0" }]) {
      expect(parseToolArgs(templateInspect, args).ok, JSON.stringify(args)).toBe(true);
    }
  });

  it("parses pins at the first @ (parseTemplatePin)", () => {
    const table: readonly (readonly [string, { id: string; version: string } | undefined])[] = [
      ["instagram-post@3", { id: "instagram-post", version: "3" }],
      ["offer-badge@2", { id: "offer-badge", version: "2" }],
      ["a@1.0.0", { id: "a", version: "1.0.0" }],
      ["a@b@c", { id: "a", version: "b@c" }],
      ["noproject", undefined],
      ["x@", undefined],
      ["@3", undefined],
      ["", undefined],
    ];
    for (const [ref, expected] of table) {
      expect(parseTemplatePin(ref), ref).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// template_inspect — the full manifest view (§7.2 fidelity, §6.1 hygiene)
// ---------------------------------------------------------------------------

describe("template_inspect manifest view (§6 row 3)", () => {
  it("shows slot bounds/rules, layerMap and palette for a real §7.2 manifest", async () => {
    const result = await runInspect(fakeTemplates(BASE), { template: "instagram-post@3" });
    const v = view(result);
    expect(v.template).toBe("instagram-post@3");
    expect(v.name).toBe("Instagram Post — Promo");
    expect(v.canvas).toEqual({ width: 1080, height: 1080, background: "#F4E7D3" });
    const slots = v.slots as Record<string, Record<string, unknown>>;
    expect(slots.headline).toMatchObject({
      kind: "text",
      layer: "Headline",
      bounds: [72, 732, 936, 176],
      maxChars: 42,
      align: "left",
      autoFit: { minSize: 56, maxSize: 110 },
    });
    expect(slots.badge).toMatchObject({ kind: "component", component: "offer-badge@2", optional: true });
    expect(slots.photo).toMatchObject({ kind: "image", fit: "cover", optional: false });
    expect(v.rules).toMatchObject({
      safeArea: 48,
      minContrast: 4.5,
      maxTextLayers: 6,
      palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
    });
    expect((v.rules as Record<string, unknown>).mustLayers).toEqual(["Background", "Photo", "Headline"]);
    expect((v.layerMap as Record<string, Record<string, unknown>>).Photo).toMatchObject({
      role: "image",
      mask: "rounded",
    });
    expect((v.layerMap as Record<string, Record<string, unknown>>).Badge).toEqual({
      role: "component",
      component: "offer-badge@2",
    });
    expect(v.thumbnail).toBe("instagram-post@3.png");
  });

  it("strips author/license noise from the model view (kept in ctx only)", async () => {
    const result = await runInspect(fakeTemplates(BASE), { template: "instagram-post@3" });
    const v = view(result);
    expect(Object.hasOwn(v, "author")).toBe(false);
    expect(Object.hasOwn(v, "license")).toBe(false);
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.summary).not.toContain("license");
    expect(result.summary).not.toContain("studio");
  });

  it("truncates thumbnail URLs to a basename — no signed queries or paths", async () => {
    const result = await runInspect(fakeTemplates([JUNK]), { template: "junk@1" });
    const v = view(result);
    expect(v.thumbnail).toBe("junk.png");
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.summary).not.toContain("SEKRIT");
    expect(result.summary).not.toContain("cdn.example.com");
  });

  it("serves the minimal seam too: declared kind/label/required/constraints", async () => {
    const result = await runInspect(fakeTemplates([MINIMAL]), { template: "minimal-seam@7" });
    const v = view(result);
    expect(v.template).toBe("minimal-seam@7");
    expect(Object.hasOwn(v, "canvas")).toBe(false);
    const slots = v.slots as Record<string, Record<string, unknown>>;
    expect(slots.headline).toEqual({
      kind: "text",
      label: "Headline",
      required: true,
      constraints: { maxChars: 40, bounds: [0, 0, 100, 50] },
    });
  });

  it("drops invalid §7.2 fields instead of echoing them (§6.1)", async () => {
    const result = await runInspect(fakeTemplates([JUNK]), { template: "junk@1" });
    const slots = view(result).slots as Record<string, Record<string, unknown>>;
    expect(slots.head).toEqual({ kind: "text", layer: "Head", maxChars: 42 });
    const rules = view(result).rules as Record<string, unknown>;
    expect(rules.palette).toEqual(["#FF0000", "#00FF00"]);
    const layerMap = view(result).layerMap as Record<string, Record<string, unknown>>;
    expect(layerMap.Head).toEqual({ role: "headline" });
  });

  it("keeps string layerMap values from the declared seam as-is", async () => {
    const result = await runInspect(fakeTemplates([SLIDE]), { template: "presentation-slide@1" });
    const layerMap = view(result).layerMap as Record<string, unknown>;
    expect(layerMap.Heading).toBe("heading-layer-id");
  });
});

// ---------------------------------------------------------------------------
// template_inspect — unknown id (§6.1 candidates in the hint)
// ---------------------------------------------------------------------------

describe("template_inspect unknown id (§6.1 hint)", () => {
  it("errs not_found (the unknown_template stand-in) with candidate pins", async () => {
    const result = await runInspect(fakeTemplates(BASE), { template: "nope@9" });
    expect(result).toMatchObject({ ok: false, code: "not_found", retryable: false });
    expect(isToolResult(result)).toBe(true);
    if (!result.ok) {
      expect(result.hint).toContain("instagram-post@3");
      expect(result.hint).toContain("presentation-slide@1");
      expect(result.hint).toContain("youtube-thumbnail@1");
      expect(result.hint).not.toContain("nope@9");
    }
  });

  it("names the known versions when the id exists but the pin does not", async () => {
    const result = await runInspect(fakeTemplates(BASE), { template: "instagram-post@99" });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    if (!result.ok) {
      expect(result.message).toContain('no version 99');
      expect(result.message).toContain("instagram-post");
      expect(result.hint).toContain("versions of instagram-post: 3");
    }
    const legacy = { ...IG, version: 2, name: "Instagram Post — Legacy" };
    const both = await runInspect(fakeTemplates([IG, legacy]), { template: "instagram-post@9" });
    if (!both.ok) expect(both.hint).toContain("versions of instagram-post: 2, 3");
  });

  it("inspects the pinned version, not the newest", async () => {
    const legacy = { ...IG, version: 2, name: "Instagram Post — Legacy" };
    const result = await runInspect(fakeTemplates([IG, legacy]), { template: "instagram-post@2" });
    expect(view(result).template).toBe("instagram-post@2");
    expect(view(result).name).toBe("Instagram Post — Legacy");
  });

  it("hints at an empty catalog", async () => {
    const result = await runInspect(fakeTemplates([]), { template: "anything@1" });
    if (!result.ok) expect(result.hint).toContain("the template catalog is empty");
  });
});

// ---------------------------------------------------------------------------
// template_inspect — the compact-reply degrade ladder (§6.1)
// ---------------------------------------------------------------------------

describe("template_inspect compact-reply ladder", () => {
  it("drops the description and per-slot vars/autoFit at level 1", async () => {
    const fat: RawManifest = {
      id: "fat",
      version: 1,
      name: "Fat Template",
      description: "x".repeat(1500),
      tags: ["many"],
      slots: Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [
          `slot-${String(i).padStart(2, "0")}`,
          { kind: "text", layer: `L${i}`, bounds: [0, i, 100, 50], font: "sans", size: 40, maxChars: 60 },
        ]),
      ),
      rules: { palette: ["#123456"] },
    };
    const result = await runInspect(fakeTemplates([fat]), { template: "fat@1" });
    const v = view(result);
    expect(Object.hasOwn(v, "description")).toBe(false);
    const slots = v.slots as Record<string, Record<string, unknown>>;
    expect(slots["slot-00"]).toMatchObject({ kind: "text", bounds: [0, 0, 100, 50] });
    expect(warningText(result)).toMatch(/dropped the description and per-slot vars\/autoFit/);
  });

  it("degrades to name:kind slots before giving up entirely (level 3)", async () => {
    const ultra: RawManifest = {
      id: "ultra",
      version: 1,
      name: "Ultra",
      description: "u".repeat(900),
      slots: Object.fromEntries(
        Array.from({ length: 48 }, (_, i) => [
          `slot-${String(i).padStart(2, "0")}`,
          {
            kind: "text",
            layer: `Layer ${i}`,
            bounds: [i, i, 100, 50],
            font: "sans",
            weight: "bold",
            size: 40,
            lineHeight: 1.1,
            maxLines: 3,
            maxChars: 80,
            align: "center",
            color: "#3B2A20",
            autoFit: { minSize: 12, maxSize: 40 },
            vars: { k: "v" },
          },
        ]),
      ),
      rules: { safeArea: 10, palette: ["#111111"] },
      layerMap: Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`L${i}`, { role: "text" }])),
    };
    const result = await runInspect(fakeTemplates([ultra]), { template: "ultra@1" });
    const v = view(result);
    expect(v.template).toBe("ultra@1");
    expect(Object.hasOwn(v, "layerMap")).toBe(false);
    expect(Object.hasOwn(v, "rules")).toBe(false);
    const slots = v.slots as Record<string, Record<string, unknown>>;
    expect(slots["slot-00"]).toEqual({ kind: "text" });
    expect(warningText(result)).toMatch(/reduced slots to name:kind pairs/);
  });

  it("shows at most MAX_MANIFEST_SLOTS slots and warns about the rest", async () => {
    const wide: RawManifest = {
      id: "wide",
      version: 1,
      name: "Wide",
      slots: Object.fromEntries(
        Array.from({ length: 70 }, (_, i) => [`s-${String(i).padStart(2, "0")}`, { kind: "text" }]),
      ),
    };
    const result = await runInspect(fakeTemplates([wide]), { template: "wide@1" });
    const slots = view(result).slots as Record<string, unknown>;
    expect(Object.keys(slots)).toHaveLength(MAX_MANIFEST_SLOTS);
    expect(warningText(result)).toMatch(/manifest has 70 slots; showing the first 64/);
  });
});
