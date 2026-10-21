// validate-document.test.ts — the §11.1 rule table with crafted inspect fixtures.
//
// Deterministic, pure: the engine/db/catalog seams are fakes (tests/fakes.ts),
// fixtures mirror the pinned engine's row shapes (vendor layer_list_cmds.rs /
// inspect.rs: TOP-DOWN listings, `text: {font, sizePt}` probes, bounds as
// `[x, y, w, h]` or `{x, y, width, height}`) plus the richer adapter probes the
// tool reads defensively (colour/fill/smart-object/baked-text/zIndex). WCAG
// expectations are the published values (black/white 21:1, #767676 on white
// 4.54:1 passes, #777777 4.48:1 fails); the 3.2:1 fixture is white on #909090.

import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  BODY_CONTRAST,
  DEFAULT_MAX_TEXT_LAYERS,
  DEFAULT_SAFE_AREA_PX,
  type GENERIC_RULES,
  MAX_ISSUES,
  TEMPLATE_ARM_SUPPLEMENT_RULES,
  TEMPLATE_VALIDATE_COMMAND,
  buildReport,
  capIssues,
  collectIssues,
  contrastRatio,
  contrastThresholdFor,
  effectiveBackground,
  fitsIn,
  flattenRows,
  hexToRgb,
  intersectsCanvas,
  isMachineName,
  readValidateReport,
  relativeLuminance,
  renderSummary,
  sortIssues,
  validateDocument,
  withinSafeArea,
} from "../src/tools/validate-document.js";
import type { ValidationIssue } from "../src/tools/validate-document.js";
import type {
  AnyTool,
  BudgetTracker,
  EngineCommand,
  EngineCommandReport,
  EngineDocumentSnapshot,
  EngineFailure,
  EngineLayerSummary,
  EngineLike,
  TemplateCatalogLike,
  TemplateManifest,
  ToolContext,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

const DOC_ID = "d0a1b2c3-1111-4222-8333-444455556666";
const CANVAS = 1080;
const BRAND_FONTS = ["Inter", "Display Bold"];

// ---------------------------------------------------------------------------
// Fixture helpers — crafted inspect rows (§11.1 inputs)
// ---------------------------------------------------------------------------

let seq = 0;

/** One layer row: the seam's shape + the vendor/adapter probes the tool reads. */
function row(name: string, kind: string, extra: Record<string, unknown> = {}): EngineLayerSummary {
  seq += 1;
  return {
    layerId: (extra.layerId as string | undefined) ?? `l${seq}`,
    name,
    kind,
    visible: true,
    ...extra,
  } as EngineLayerSummary;
}

/** A visible text layer with the vendor's `text` probe (font/sizePt/colour/box). */
function textRow(name: string, extra: Record<string, unknown> = {}): EngineLayerSummary {
  const text: Record<string, unknown> = {};
  if (extra.font !== undefined) text.font = extra.font;
  if (extra.sizePt !== undefined) text.sizePt = extra.sizePt;
  if (extra.color !== undefined) text.color = extra.color;
  if (extra.box !== undefined) text.box = extra.box;
  return row(name, "Type", {
    ...extra,
    bounds: extra.bounds ?? [72, 100, 400, 60],
    ...(Object.keys(text).length > 0 ? { text } : {}),
  });
}

/** The pure local pass over crafted rows (canvas 1080×1080, brand fonts). */
function lint(
  rows: readonly EngineLayerSummary[],
  overrides: {
    canvasW?: number;
    canvasH?: number;
    brandFonts?: readonly string[];
    safeAreaPx?: number;
    maxTextLayers?: number;
    rules?: readonly (typeof GENERIC_RULES)[number][];
  } = {},
) {
  return collectIssues({
    canvasW: overrides.canvasW ?? CANVAS,
    canvasH: overrides.canvasH ?? CANVAS,
    rows,
    brandFonts: overrides.brandFonts ?? BRAND_FONTS,
    safeAreaPx: overrides.safeAreaPx,
    maxTextLayers: overrides.maxTextLayers,
    rules: overrides.rules,
  });
}

function codes(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function one(issues: readonly ValidationIssue[], code: string): ValidationIssue {
  const found = issues.filter((issue) => issue.code === code);
  expect(found.length, `expected exactly one ${code} issue`).toBe(1);
  return found[0] as ValidationIssue;
}

// ---------------------------------------------------------------------------
// Fake engine + context (the template arm records engine.execute calls)
// ---------------------------------------------------------------------------

interface EngineSpy extends EngineLike {
  readonly executed: readonly { id: string; params: Record<string, unknown> }[];
  batchCount(): number;
}

function makeEngine(
  options: {
    snapshot?: Partial<EngineDocumentSnapshot>;
    rows?: readonly EngineLayerSummary[];
    listFailure?: EngineFailure;
    inspectFailure?: EngineFailure;
    executeReport?: EngineCommandReport;
    executeFailure?: EngineFailure;
  } = {},
): EngineSpy {
  const executed: { id: string; params: Record<string, unknown> }[] = [];
  let batches = 0;
  const snapshot: EngineDocumentSnapshot = {
    revision: 7,
    widthPx: options.snapshot?.widthPx ?? CANVAS,
    heightPx: options.snapshot?.heightPx ?? CANVAS,
    layers: options.snapshot?.layers ?? options.rows ?? [],
  };
  const spy: EngineSpy = {
    executed,
    batchCount: () => batches,
    async batch() {
      batches += 1;
      return { ok: true, value: { revision: 7, outcomes: [] } };
    },
    async execute(cmd: EngineCommand) {
      executed.push({ id: cmd.id, params: { ...cmd.params } });
      if (options.executeFailure !== undefined) return options.executeFailure;
      return { ok: true, value: options.executeReport ?? { revision: 9 } };
    },
    async render() {
      return {
        ok: true,
        value: { image: new Uint8Array(), widthPx: 64, heightPx: 64 },
      };
    },
    async inspect() {
      if (options.inspectFailure !== undefined) return options.inspectFailure;
      return { ok: true, value: snapshot };
    },
    async listLayers() {
      if (options.listFailure !== undefined) return options.listFailure;
      return { ok: true, value: options.rows ?? snapshot.layers };
    },
  };
  return spy;
}

/** An EngineCommandReport carrying the engine's JSON reply (adapter convention). */
function reportWith(payload: unknown, message?: string): EngineCommandReport {
  const report: Record<string, unknown> = { revision: 9, result: payload };
  if (message !== undefined) report.message = message;
  return report as unknown as EngineCommandReport;
}

function catalogWith(...manifests: TemplateManifest[]): TemplateCatalogLike {
  return {
    get: async (ref) => manifests.find((m) => `${m.id}@${m.version}` === ref),
    list: async () =>
      manifests.map((m) => ({
        id: m.id,
        version: m.version,
        title: m.id,
        tags: [],
        slotCount: Object.keys(m.slots).length,
      })),
  };
}

const IG_MANIFEST: TemplateManifest = {
  id: "instagram-post",
  version: "3",
  slots: {
    headline: { kind: "text", required: true },
    photo: { kind: "image", required: true },
  },
};

function makeContext(over: {
  engine: EngineSpy;
  templates?: TemplateCatalogLike;
  brandFonts?: readonly string[];
}): { ctx: ToolContext; charges: () => number } {
  let charges = 0;
  const budgets: BudgetTracker = {
    remaining: () => ({ msRemaining: 5000, commandsRemaining: 99 }),
    charge: () => {
      charges += 1;
      return true;
    },
  };
  const ctx = makeFakeContext({
    engine: over.engine,
    templates: over.templates ?? catalogWith(IG_MANIFEST),
    budgets,
    workspace: {
      organizationId: "org_00000000-0000-0000-0000-000000000000",
      brandTokens: {
        palette: { primary: "#F4E7D3" },
        fonts: over.brandFonts ?? BRAND_FONTS,
      },
    },
  });
  return { ctx, charges: () => charges };
}

// ---------------------------------------------------------------------------
// §6.1 argument schema
// ---------------------------------------------------------------------------

describe("validate_document: argument schema (§6.1)", () => {
  it("accepts a document id and an optional template pin", () => {
    expect(parseToolArgs(validateDocument, { documentId: DOC_ID }).ok).toBe(true);
    expect(
      parseToolArgs(validateDocument, {
        documentId: DOC_ID,
        template: "instagram-post@3",
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["extra property", { documentId: DOC_ID, template: "instagram-post@3", deep: true }],
    ["bad uuid", { documentId: "not-a-uuid" }],
    ["unpinned template", { documentId: DOC_ID, template: "instagram-post" }],
    ["empty template", { documentId: DOC_ID, template: "" }],
    ["missing documentId", {}],
  ])("rejects %s", (_label, raw) => {
    const parsed = parseToolArgs(validateDocument, raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure math — WCAG relative luminance (table-tested, published values)
// ---------------------------------------------------------------------------

describe("validate_document: WCAG math", () => {
  it("hex parsing: #RGB expands, #RRGGBB and #RRGGBBAA drop alpha", () => {
    expect(hexToRgb("#abc")).toEqual([170, 187, 204]);
    expect(hexToRgb("#AABBCC")).toEqual([170, 187, 204]);
    expect(hexToRgb("#AABBCCDD")).toEqual([170, 187, 204]);
    expect(hexToRgb("red")).toBeUndefined();
    expect(hexToRgb("#12345")).toBeUndefined();
  });

  it("relative luminance: 0 for black, 1 for white, NaN for garbage", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(Number.isNaN(relativeLuminance("#nope"))).toBe(true);
  });

  it.each([
    ["black on white", "#000000", "#FFFFFF", 21.0],
    ["#767676 on white (passes 4.5)", "#767676", "#FFFFFF", 4.5422],
    ["#777777 on white (fails 4.5)", "#777777", "#FFFFFF", 4.4781],
    ["white on #909090 (the 3.2:1 fixture)", "#FFFFFF", "#909090", 3.1925],
    ["#3B2A20 on #F4E7D3 (the clean doc)", "#3B2A20", "#F4E7D3", 11.1948],
  ])("contrastRatio %s", (_label, a, b, expected) => {
    expect(contrastRatio(a, b)).toBeCloseTo(expected, 3);
  });

  it("contrastRatio is order-agnostic and NaN-propagating", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(contrastRatio("#000000", "#FFFFFF"));
    expect(Number.isNaN(contrastRatio("#nope", "#FFF"))).toBe(true);
  });

  it("thresholds: 4.5:1 body, 3:1 large display text (§11.1)", () => {
    expect(BODY_CONTRAST).toBe(4.5);
    expect(contrastThresholdFor(12)).toBe(4.5);
    expect(contrastThresholdFor(undefined)).toBe(4.5);
    expect(contrastThresholdFor(18)).toBe(3.0);
    expect(contrastThresholdFor(96)).toBe(3.0);
    expect(contrastThresholdFor(Number.NaN)).toBe(4.5);
  });
});

// ---------------------------------------------------------------------------
// Pure geometry + naming (§11.1 / §10.2)
// ---------------------------------------------------------------------------

describe("validate_document: geometry helpers", () => {
  it("the §11.1 defaults are pinned: 48 px safe area, 12 text layers", () => {
    expect(DEFAULT_SAFE_AREA_PX).toBe(48);
    expect(DEFAULT_MAX_TEXT_LAYERS).toBe(12);
  });

  type Box4 = readonly [number, number, number, number];

  const intersectCases: readonly (readonly [string, Box4, boolean])[] = [
    ["fully on", [0, 0, 100, 100], true],
    ["fully right of canvas", [1200, 0, 100, 100], false],
    ["fully above canvas", [0, -200, 100, 100], false],
    ["partial bleed", [-20, 0, 1100, 700], true],
    ["touching the right edge (zero overlap)", [1080, 0, 100, 100], false],
  ];

  it.each(intersectCases)("intersectsCanvas %s", (_label, b, expected) => {
    expect(intersectsCanvas({ x: b[0], y: b[1], width: b[2], height: b[3] }, CANVAS, CANVAS)).toBe(
      expected,
    );
  });

  it("intersectsCanvas refuses NaN geometry (a violation, never a crash)", () => {
    expect(intersectsCanvas({ x: Number.NaN, y: 0, width: 10, height: 10 }, CANVAS, CANVAS)).toBe(
      false,
    );
  });

  const safeCases: readonly (readonly [string, Box4, boolean])[] = [
    ["inside the margin", [48, 48, 984, 984], true],
    ["half a px past the margin", [48, 48, 984, 984.5], false],
    ["left edge intrudes", [10, 100, 200, 50], false],
    ["bottom intrudes", [100, 100, 200, 980], false],
  ];

  it.each(safeCases)("withinSafeArea %s", (_label, b, expected) => {
    expect(
      withinSafeArea(
        { x: b[0], y: b[1], width: b[2], height: b[3] },
        CANVAS,
        CANVAS,
        DEFAULT_SAFE_AREA_PX,
      ),
    ).toBe(expected);
  });

  const fitsCases: readonly (readonly [string, Box4, Box4, boolean])[] = [
    ["inside (render rounding tolerance)", [72, 732, 936, 176], [72, 732, 936, 176.3], true],
    ["overflowing the bottom", [72, 732, 936, 200], [72, 732, 936, 176], false],
    ["outside the left", [70, 732, 936, 176], [72, 732, 936, 176], false],
  ];

  it.each(fitsCases)("fitsIn %s", (_label, inner, outer, expected) => {
    expect(
      fitsIn(
        { x: inner[0], y: inner[1], width: inner[2], height: inner[3] },
        { x: outer[0], y: outer[1], width: outer[2], height: outer[3] },
      ),
    ).toBe(expected);
  });

  it.each([
    ["Layer 27", true],
    ["Group 3", true],
    ["Shape 12", true],
    ["Layer 0", true],
    ["Layer", false],
    ["Layer 27x", false],
    ["Layer -1", false],
    ["layer 27", false],
    ["Background", false],
    ["Photo — Latte", false],
    ["", false],
  ])("isMachineName(%j) → %s", (name, expected) => {
    expect(isMachineName(name)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// The rule table (§11.1) — crafted fixtures, one rule at a time
// ---------------------------------------------------------------------------

describe("validate_document: rule table", () => {
  it("in_bounds: a layer fully outside the canvas is a blocker; partial bleed is not", () => {
    const issues = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#F4E7D3",
      }),
      row("Stray", "Pixel", {
        bounds: [1200, -50, 100, 100],
        smartObject: true,
      }),
      row("Photo", "Pixel", { bounds: [-20, 0, 1100, 700], smartObject: true }),
    ]).issues;
    const issue = one(issues, "in_bounds");
    expect(issue.level).toBe("blocker");
    expect(issue.layer).toBe("Stray");
    expect(issue.message).toContain("fully outside the 1080×1080 canvas");
    expect(issue.fix).toContain("edit.transform");
  });

  it("in_bounds: hidden layers and rows without bounds are skipped", () => {
    const issues = lint([
      row("Hidden Stray", "Pixel", {
        bounds: [2000, 0, 50, 50],
        visible: false,
        smartObject: true,
      }),
      textRow("Unmeasured"),
    ]).issues;
    expect(codes(issues)).not.toContain("in_bounds");
  });

  it("safe_area: essential text inside the 48 px margin is a major; full-bleed photos are exempt", () => {
    const issues = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#F4E7D3",
      }),
      row("Photo", "Pixel", { bounds: [0, 0, 1080, 700], smartObject: true }),
      textRow("CTA", { bounds: [10, 100, 200, 50] }),
      row("Logo", "Pixel", { bounds: [0, 1040, 120, 40], smartObject: true }),
    ]).issues;
    const flagged = issues.filter((issue) => issue.code === "safe_area");
    expect(flagged.length).toBe(2);
    expect(flagged.every((issue) => issue.level === "major")).toBe(true);
    expect(flagged.map((issue) => issue.layer)).toEqual(["CTA", "Logo"]);
    expect(flagged[0]?.message).toContain("48 px safe-area margin");
  });

  it("safe_area: variant names like `Headline — es` still count as essential", () => {
    const issues = lint([textRow("Headline — es", { bounds: [20, 20, 300, 60] })]).issues;
    expect(one(issues, "safe_area").layer).toBe("Headline — es");
  });

  it("contrast: white text on #909090 is a 3.2:1 blocker", () => {
    const issues = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#909090",
      }),
      textRow("Body", { color: "#FFFFFF", sizePt: 12 }),
    ]).issues;
    const issue = one(issues, "contrast");
    expect(issue.level).toBe("blocker");
    expect(issue.layer).toBe("Body");
    expect(issue.message).toContain("3.2:1");
    expect(issue.message).toContain("4.5:1");
    expect(issue.fix).toContain("type.setStyle color");
  });

  it("contrast: 4.54:1 (#767676 on white) passes; 4.48:1 (#777777) is a blocker", () => {
    const pass = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#FFFFFF",
      }),
      textRow("Body", { color: "#767676", sizePt: 12 }),
    ]).issues;
    expect(codes(pass)).not.toContain("contrast");

    const fail = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#FFFFFF",
      }),
      textRow("Body", { color: "#777777", sizePt: 12 }),
    ]).issues;
    expect(one(fail, "contrast").level).toBe("blocker");
  });

  it("contrast: large display text only needs 3:1 (§11.1)", () => {
    const issues = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#909090",
      }),
      textRow("Headline", { color: "#FFFFFF", sizePt: 96 }),
      textRow("Body", {
        color: "#FFFFFF",
        sizePt: 12,
        bounds: [72, 900, 400, 60],
      }),
    ]).issues;
    const flagged = issues.filter((issue) => issue.code === "contrast");
    expect(flagged.length).toBe(1);
    expect(flagged[0]?.layer).toBe("Body");
    expect(flagged[0]?.message).toContain("4.5:1");
  });

  it("contrast: hidden text is skipped", () => {
    const issues = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#909090",
      }),
      textRow("Draft", { color: "#FFFFFF", sizePt: 12, visible: false }),
    ]).issues;
    expect(codes(issues)).not.toContain("contrast");
  });

  it("contrast: no readable background degrades to a note, never a guess", () => {
    const pass = lint([
      row("Photo", "Pixel", { bounds: [0, 0, 1080, 700], smartObject: true }),
      textRow("Body", {
        color: "#FFFFFF",
        sizePt: 12,
        bounds: [72, 900, 400, 60],
      }),
    ]);
    expect(codes(pass.issues)).not.toContain("contrast");
    expect(pass.notes).toContainEqual(expect.stringContaining("no readable background colour"));
  });

  it("contrast: text rows without a colour probe degrade to a note", () => {
    const pass = lint([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#F4E7D3",
      }),
      textRow("Body", { font: "Inter" }),
    ]);
    expect(codes(pass.issues)).not.toContain("contrast");
    expect(pass.notes).toContainEqual(expect.stringContaining("without a readable colour"));
  });

  it("effectiveBackground prefers the visible layer named Background; hidden fills never win", () => {
    const { flat } = flattenRows([
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#F4E7D3",
      }),
      row("Panel", "Fill", {
        bounds: [0, 700, 1080, 380],
        fillColor: "#909090",
      }),
      row("Hidden Fill", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#123456",
        visible: false,
      }),
    ]);
    expect(effectiveBackground(flat)).toBe("#F4E7D3");
  });

  it("text_overflow: bounds beyond the declared box are a blocker with exact px", () => {
    const issues = lint([
      textRow("Headline", {
        bounds: [72, 732, 936, 200],
        box: [72, 732, 936, 176],
      }),
    ]).issues;
    const issue = one(issues, "text_overflow");
    expect(issue.level).toBe("blocker");
    expect(issue.message).toContain("overflows its box by 24 px");
    expect(issue.fix).toContain("layout.fitText");
  });

  it("text_overflow: within the 0.5 px render tolerance passes", () => {
    const issues = lint([
      textRow("Headline", {
        bounds: [72, 732, 936, 176.3],
        box: [72, 732, 936, 176],
      }),
    ]).issues;
    expect(codes(issues)).not.toContain("text_overflow");
  });

  it("missing_font: a font outside the workspace set is a blocker with an install hint (§10.2)", () => {
    const issues = lint([textRow("Headline", { font: "Comic Sans", sizePt: 96 })]).issues;
    const issue = one(issues, "missing_font");
    expect(issue.level).toBe("blocker");
    expect(issue.layer).toBe("Headline");
    expect(issue.fix).toContain('install "Comic Sans"');
    expect(issue.fix).toContain("Inter");
  });

  it("missing_font: matching is case/whitespace-insensitive; unreadable fonts degrade", () => {
    const pass = lint([
      textRow("Headline", { font: "  inter ", sizePt: 96 }),
      textRow("Subhead", {
        font: "Display Bold",
        sizePt: 36,
        bounds: [72, 900, 400, 60],
      }),
    ]);
    expect(codes(pass.issues)).not.toContain("missing_font");

    const degraded = lint([textRow("Old Copy", { bounds: [72, 900, 400, 60] })]);
    expect(codes(degraded.issues)).not.toContain("missing_font");
    expect(degraded.notes).toContainEqual(expect.stringContaining("without a readable font"));
  });

  it("missing_font: an empty workspace font set skips the check with a note", () => {
    const pass = lint([textRow("Headline", { font: "Comic Sans", sizePt: 96 })], {
      brandFonts: [],
    });
    expect(codes(pass.issues)).not.toContain("missing_font");
    expect(pass.notes).toContainEqual(expect.stringContaining("the workspace declares no fonts"));
  });

  it("editability: a plain raster image is a blocker; smart objects pass", () => {
    const issues = lint([
      row("Photo — Latte", "Pixel", { bounds: [0, 0, 1080, 700] }),
      row("Logo", "Smart Object", { bounds: [888, 984, 120, 40] }),
      row("Badge", "Pixel", { bounds: [828, 72, 180, 180], smartObject: true }),
    ]).issues;
    const issue = one(issues, "editability");
    expect(issue.level).toBe("blocker");
    expect(issue.layer).toBe("Photo — Latte");
    expect(issue.message).toContain("plain raster");
    expect(issue.fix).toContain("convertToSmartObject");
  });

  it("editability: a baked-text flag on an image is a blocker (§10.1 text stays text)", () => {
    const issues = lint([
      row("Photo", "Smart Object", {
        bounds: [0, 0, 1080, 700],
        bakedText: true,
      }),
    ]).issues;
    const issue = one(issues, "editability");
    expect(issue.level).toBe("blocker");
    expect(issue.layer).toBe("Photo");
    expect(issue.message).toContain("baked-in text");
    expect(issue.fix).toContain("type.create");
  });

  it("z_order: text behind an opaque photo is a blocker", () => {
    // Top-down listing: the photo row comes FIRST ⇒ it sits ABOVE the caption.
    const issues = lint([
      row("Photo", "Pixel", { bounds: [0, 0, 1080, 700], smartObject: true }),
      textRow("Caption", { bounds: [100, 600, 300, 40], sizePt: 14 }),
    ]).issues;
    const issue = one(issues, "z_order");
    expect(issue.level).toBe("blocker");
    expect(issue.layer).toBe("Caption");
    expect(issue.message).toContain('hidden behind the opaque image "Photo"');
    expect(issue.fix).toContain("layer.arrange.bringToFront");
  });

  it.each([
    [
      "text sits above the photo",
      [
        textRow("Caption", { bounds: [100, 600, 300, 40] }),
        row("Photo", "Pixel", { bounds: [0, 0, 1080, 700], smartObject: true }),
      ],
    ],
    [
      "photo is half transparent",
      [
        row("Photo", "Pixel", {
          bounds: [0, 0, 1080, 700],
          opacity: 0.5,
          smartObject: true,
        }),
        textRow("Caption", { bounds: [100, 600, 300, 40] }),
      ],
    ],
    [
      "photo only partially covers the text",
      [
        row("Photo", "Pixel", { bounds: [0, 0, 500, 700], smartObject: true }),
        textRow("Caption", { bounds: [600, 100, 300, 40] }),
      ],
    ],
    [
      "covering layer is hidden",
      [
        row("Photo", "Pixel", {
          bounds: [0, 0, 1080, 700],
          visible: false,
          smartObject: true,
        }),
        textRow("Caption", { bounds: [100, 600, 300, 40] }),
      ],
    ],
  ])("z_order passes when %s", (_label, rows) => {
    expect(codes(lint(rows).issues)).not.toContain("z_order");
  });

  it("z_order: an explicit zIndex probe overrides listing order", () => {
    const issues = lint([
      textRow("Caption", { bounds: [100, 600, 300, 40], zIndex: 0 }),
      row("Photo", "Pixel", {
        bounds: [0, 0, 1080, 700],
        smartObject: true,
        zIndex: 5,
      }),
    ]).issues;
    expect(one(issues, "z_order").layer).toBe("Caption");
  });

  it("max_text_layers: over the cap is a major; hidden placeholders count", () => {
    const rows: EngineLayerSummary[] = [];
    for (let i = 0; i < DEFAULT_MAX_TEXT_LAYERS + 1; i += 1) {
      rows.push(
        textRow(`Copy ${i}`, {
          visible: i % 2 === 0,
          bounds: [100, 100 + i * 40, 200, 30],
        }),
      );
    }
    const issues = lint(rows).issues;
    const issue = one(issues, "max_text_layers");
    expect(issue.level).toBe("major");
    expect(issue.message).toContain(`carries ${DEFAULT_MAX_TEXT_LAYERS + 1} text layers`);
    expect(issue.layer).toBeUndefined();

    const pass = lint(rows.slice(0, DEFAULT_MAX_TEXT_LAYERS)).issues;
    expect(codes(pass)).not.toContain("max_text_layers");
  });

  it("empty_layers: 0-size bounds, zero opacity and single-unnamed-child groups are minors", () => {
    const issues = lint([
      row("Dust", "Pixel", { bounds: [10, 10, 0, 0], smartObject: true }),
      row("Ghost", "Pixel", {
        bounds: [0, 0, 100, 100],
        opacity: 0,
        smartObject: true,
      }),
      row("Brand", "Group", { childCount: 1 }),
    ]).issues;
    const flagged = issues.filter((issue) => issue.code === "empty_layers");
    expect(flagged.length).toBe(3);
    expect(flagged.every((issue) => issue.level === "minor")).toBe(true);
    expect(flagged.map((issue) => issue.layer)).toEqual(["Dust", "Ghost", "Brand"]);
    expect(flagged[0]?.message).toContain("0×0 px");
    expect(flagged[2]?.message).toContain("single unnamed child");
  });

  it("empty_layers: a named single child and 2-child groups are fine", () => {
    const issues = lint([
      row("Brand", "Group", { children: [row("Logo", "Smart Object", {})] }),
      row("Content", "Group", { childCount: 2 }),
    ]).issues;
    expect(codes(issues)).not.toContain("empty_layers");
  });

  it("naming: machine names and empty names are minors with §10.2 fixes", () => {
    const issues = lint([
      row("Layer 27", "Pixel", { bounds: [0, 0, 50, 50], smartObject: true }),
      row("", "Group", { childCount: 2 }),
    ]).issues;
    const flagged = issues.filter((issue) => issue.code === "naming");
    expect(flagged.length).toBe(2);
    expect(flagged.every((issue) => issue.level === "minor")).toBe(true);
    expect(flagged[0]?.layer).toBe("Layer 27");
    expect(flagged[0]?.message).toContain("machine-generated name");
    expect(flagged[1]?.layer).toBeUndefined();
    expect(flagged[1]?.message).toContain("has no name");
    expect(flagged.every((issue) => issue.fix.includes("§10.2"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Row projection (flatten/probe behavior)
// ---------------------------------------------------------------------------

describe("validate_document: row projection", () => {
  it("flattens nested children depth-first, preserving the top-down order", () => {
    const { flat, skipped } = flattenRows([
      row("Group", "Group", {
        children: [row("Inner A", "Type", {}), row("Inner B", "Type", {})],
      }),
      row("Background", "Fill", {}),
      row("Loose Pixel", "Pixel", {}),
    ]);
    expect(flat.map((r) => r.name)).toEqual([
      "Group",
      "Inner A",
      "Inner B",
      "Background",
      "Loose Pixel",
    ]);
    expect(skipped).toBe(0);
  });

  it("skips rows without a usable id (counted, never guessed)", () => {
    const junk = {
      name: "Nope",
      kind: "Pixel",
      visible: true,
    } as EngineLayerSummary;
    const { flat, skipped } = flattenRows([junk, row("Fine", "Pixel", {})]);
    expect(flat.map((r) => r.name)).toEqual(["Fine"]);
    expect(skipped).toBe(1);
  });

  it("dedupes repeated ids (inspect + children double-reporting)", () => {
    const { flat } = flattenRows([
      row("Photo", "Pixel", { layerId: "9", smartObject: true }),
      row("Photo again", "Pixel", { layerId: "9", smartObject: true }),
    ]);
    expect(flat.length).toBe(1);
  });

  it("accepts both bounds shapes and normalizes percent opacity", () => {
    const { flat } = flattenRows([
      row("A", "Pixel", {
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        opacity: 50,
      }),
      row("B", "Pixel", { bounds: [5, 6, 7, 8], opacity: 0.5 }),
    ]);
    expect(flat[0]?.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(flat[0]?.opacity).toBe(0.5);
    expect(flat[1]?.opacity).toBe(0.5);
  });

  it("toRow-style probes: the row object's `text` carries font/sizePt/colour", () => {
    const { flat } = flattenRows([
      textRow("Headline", {
        font: "Inter",
        sizePt: 96,
        color: "#3B2A20",
        box: [72, 732, 936, 176],
      }),
    ]);
    expect(flat[0]?.font).toBe("Inter");
    expect(flat[0]?.sizePt).toBe(96);
    expect(flat[0]?.color).toBe("#3B2A20");
    expect(flat[0]?.box).toEqual({ x: 72, y: 732, width: 936, height: 176 });
  });
});

// ---------------------------------------------------------------------------
// Reply shaping: severity order, the 25 cap, the 2000-char budget
// ---------------------------------------------------------------------------

describe("validate_document: report shaping", () => {
  const blocker: ValidationIssue = {
    level: "blocker",
    code: "contrast",
    message: "m",
    fix: "f",
  };
  const major: ValidationIssue = {
    level: "major",
    code: "safe_area",
    message: "m",
    fix: "f",
  };
  const minor: ValidationIssue = {
    level: "minor",
    code: "naming",
    message: "m",
    fix: "f",
  };

  function many(n: number, level: "blocker" | "major" | "minor" = "minor"): ValidationIssue[] {
    return Array.from({ length: n }, (_, i) => ({
      level,
      code: `code_${i}`,
      message: `message ${i}`,
      fix: `fix ${i}`,
    }));
  }

  it("sortIssues puts blockers first and is stable within a level", () => {
    const sorted = sortIssues([minor, major, blocker, { ...minor, code: "naming2" }]);
    expect(sorted.map((issue) => issue.level)).toEqual(["blocker", "major", "minor", "minor"]);
    expect(sorted[2]?.code).toBe("naming");
    expect(sorted[3]?.code).toBe("naming2");
  });

  it("capIssues keeps at most MAX_ISSUES (25) and reports the pre-cap total", () => {
    expect(MAX_ISSUES).toBe(25);
    const capped = capIssues(many(30));
    expect(capped.kept.length).toBe(25);
    expect(capped.total).toBe(30);
    expect(capped.truncated).toBe(true);
    const uncapped = capIssues(many(25));
    expect(uncapped.kept.length).toBe(25);
    expect(uncapped.truncated).toBe(false);
  });

  it("ok is true without blockers even when majors exist (§5.1: blockers gate)", () => {
    const report = buildReport([major, minor]);
    expect(report.ok).toBe(true);
    expect(report.issueCounts).toEqual({ blocker: 0, major: 1, minor: 1 });
    expect(report.truncated).toBe(false);
    expect(report.warnings).toEqual([]);
  });

  it("ok is false as soon as one blocker exists", () => {
    expect(buildReport([blocker]).ok).toBe(false);
  });

  it("the 25-issue cap adds a truncation warning; counts stay exact", () => {
    const report = buildReport(many(30));
    expect(report.issueCounts.minor).toBe(30);
    expect(report.issues.length).toBeLessThanOrEqual(25);
    expect(report.truncated).toBe(true);
    expect(report.warnings.join(" ")).toContain("capped at 25");
    expect(renderSummary(report).length).toBeLessThanOrEqual(2000);
  });

  it("the §6.1 2000-char budget sheds from the tail and says so", () => {
    const long = many(10, "major").map((issue) => ({
      ...issue,
      message: "x".repeat(160),
      fix: "y".repeat(140),
    }));
    const report = buildReport(long);
    const summary = renderSummary(report);
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(report.issues.length).toBeLessThan(10);
    expect(report.warnings.join(" ")).toContain("summary budget reached");
  });

  it("renderSummary emits compact JSON with the §11.1 row shape", () => {
    const summary = renderSummary(buildReport([blocker], { template: "instagram-post@3" }));
    const parsed = JSON.parse(summary) as {
      ok: boolean;
      template: string;
      issueCounts: { blocker: number };
      issues: {
        level: string;
        code: string;
        layer?: string;
        message: string;
        fix: string;
      }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.template).toBe("instagram-post@3");
    expect(parsed.issueCounts.blocker).toBe(1);
    expect(parsed.issues[0]?.code).toBe("contrast");
    expect(parsed.issues[0]?.fix).toBe("f");
  });
});

// ---------------------------------------------------------------------------
// Engine template.validate reply reader (§7.4)
// ---------------------------------------------------------------------------

describe("validate_document: readValidateReport (engine reply)", () => {
  it("reads issues off the adapter's `result` payload", () => {
    const reply = readValidateReport(
      reportWith({
        ok: false,
        issues: [
          {
            level: "blocker",
            code: "contrast",
            layer: "Headline",
            message: "too low",
            fix: "darken",
          },
          {
            level: "minor",
            code: "naming",
            message: "machine name",
            fix: "rename",
          },
        ],
        truncated: true,
      }),
    );
    expect(reply?.issues.length).toBe(2);
    expect(reply?.issues[0]?.layer).toBe("Headline");
    expect(reply?.truncated).toBe(true);
    expect(reply?.dropped).toBe(0);
  });

  it("falls back to JSON serialized in `message`", () => {
    const reply = readValidateReport(
      reportWith(
        undefined,
        JSON.stringify({
          issues: [{ level: "major", code: "safe_area", message: "m", fix: "f" }],
        }),
      ),
    );
    expect(reply?.issues[0]?.level).toBe("major");
  });

  it("drops malformed rows instead of guessing", () => {
    const reply = readValidateReport(
      reportWith({
        issues: [
          { level: "fatal", code: "x", message: "m", fix: "f" },
          { level: "major", code: "ok", message: "m" },
          { level: "minor", code: "fine", message: "m", fix: "f" },
        ],
      }),
    );
    expect(reply?.issues.length).toBe(1);
    expect(reply?.dropped).toBe(2);
  });

  it("returns undefined when the adapter attached nothing readable", () => {
    expect(readValidateReport({ revision: 9 })).toBeUndefined();
    expect(readValidateReport({ revision: 9, message: "no json here" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The tool — generic arm (§6 row 15, §11.1)
// ---------------------------------------------------------------------------

describe("validate_document: tool (generic arm)", () => {
  it("a clean §10.1 document passes with zero issues and no warnings", async () => {
    // Engine listings are TOP-DOWN (frontmost first): text over photo over fill.
    const rows = [
      textRow("Subhead", {
        bounds: [72, 924, 936, 56],
        color: "#3B2A20",
        sizePt: 36,
        font: "Display Bold",
      }),
      textRow("Headline", {
        bounds: [72, 732, 936, 176],
        color: "#3B2A20",
        sizePt: 96,
        font: "Inter",
      }),
      row("Photo", "Smart Object", { bounds: [0, 0, 1080, 700] }),
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#F4E7D3",
      }),
    ];
    const engine = makeEngine({ rows });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    expect(isToolResult(result)).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.documentRevision).toBe(7);
    expect(result.warnings).toBeUndefined();
    const parsed = JSON.parse(result.summary) as {
      ok: boolean;
      issueCounts: { blocker: number; major: number; minor: number };
      issues: unknown[];
      truncated: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.issueCounts).toEqual({ blocker: 0, major: 0, minor: 0 });
    expect(parsed.issues).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it("a broken document reports every violated rule with severity-ordered issues", async () => {
    const rows = [
      row("Photo", "Pixel", { bounds: [0, 0, 1080, 700] }),
      textRow("Caption", {
        bounds: [100, 600, 300, 40],
        font: "Comic Sans",
        color: "#FFFFFF",
        sizePt: 12,
      }),
      row("Layer 9", "Group", { childCount: 1 }),
    ];
    const engine = makeEngine({ rows });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    if (!result.ok) throw new Error("expected ok");
    const parsed = JSON.parse(result.summary) as {
      ok: boolean;
      issueCounts: { blocker: number; major: number; minor: number };
      issues: { level: string; code: string }[];
    };
    expect(parsed.ok).toBe(false);
    // Photo: raster (editability) + covers the Caption (z_order) + Comic Sans
    // (missing_font) — and Layer 9 is both a single-child group and machine-named.
    expect(parsed.issueCounts).toEqual({ blocker: 3, major: 0, minor: 2 });
    const codesSeen = parsed.issues.map((issue) => issue.code);
    expect(codesSeen).toContain("editability");
    expect(codesSeen).toContain("missing_font");
    expect(codesSeen).toContain("z_order");
    expect(codesSeen).toContain("empty_layers");
    expect(codesSeen).toContain("naming");
    // Blockers first (§5.1: they drive the repair loop).
    const levels = parsed.issues.map((issue) => issue.level);
    expect([...levels].sort()).toEqual(["blocker", "blocker", "blocker", "minor", "minor"]);
  });

  it("30 machine names hit the 25-issue cap: counts exact, list capped, summary bounded", async () => {
    const rows: EngineLayerSummary[] = [];
    for (let i = 1; i <= 30; i += 1) {
      rows.push(row(`Layer ${i}`, "Group", { childCount: 2 }));
    }
    const engine = makeEngine({ rows });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    if (!result.ok) throw new Error("expected ok");
    expect(result.summary.length).toBeLessThanOrEqual(2000);
    expect(result.warnings?.join(" ")).toContain("capped at 25");
    const parsed = JSON.parse(result.summary) as {
      issueCounts: { minor: number };
      issues: unknown[];
      truncated: boolean;
    };
    expect(parsed.issueCounts.minor).toBe(30);
    expect(parsed.issues.length).toBeLessThanOrEqual(25);
    expect(parsed.truncated).toBe(true);
  });

  it("listLayers failure falls back to document.inspect rows with a warning", async () => {
    const rows = [
      row("Background", "Fill", {
        bounds: [0, 0, 1080, 1080],
        fillColor: "#F4E7D3",
      }),
    ];
    const engine = makeEngine({
      rows,
      listFailure: { ok: false, code: "engine_crashed", message: "boom" },
    });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings?.join(" ")).toContain("layer.list unavailable (engine_crashed)");
    expect(JSON.parse(result.summary)).toBeTruthy();
  });

  it("an inspect failure maps to the typed envelope with the retry table", async () => {
    const engine = makeEngine({
      inspectFailure: {
        ok: false,
        code: "engine_unavailable",
        message: "no session",
      },
    });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_unavailable");
      expect(result.message).toContain("The document could not be read");
      expect(result.retryable).toBe(true);
    }
  });

  it("a document with no layers is refused (validate.rs parity)", async () => {
    const engine = makeEngine({ rows: [] });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain("no layers to validate");
    }
  });

  it("layer rows with no usable ids are refused, not passed as clean", async () => {
    const engine = makeEngine({
      rows: [{ name: "Ghost", kind: "Pixel", visible: true } as EngineLayerSummary],
    });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain("could not be read");
    }
  });

  it("is read-only: no engine.batch, no engine.execute, no budget charge", async () => {
    const rows = [row("Layer 5", "Pixel", { bounds: [0, 0, 10, 10], smartObject: true })];
    const engine = makeEngine({ rows });
    const { ctx, charges } = makeContext({ engine });
    await validateDocument.run(ctx, { documentId: DOC_ID }, freshSignal());
    expect(engine.batchCount()).toBe(0);
    expect(engine.executed.length).toBe(0);
    expect(charges()).toBe(0);
  });

  it("rejects a pre-aborted signal through the kit boundary", async () => {
    const engine = makeEngine({ rows: [row("Photo", "Pixel", {})] });
    const { ctx } = makeContext({ engine });
    const controller = new AbortController();
    controller.abort();
    const result = await validateDocument.run(ctx, { documentId: DOC_ID }, controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("engine_timeout");
  });
});

// ---------------------------------------------------------------------------
// The tool — template arm (delegation to engine template.validate, §7.4)
// ---------------------------------------------------------------------------

describe("validate_document: tool (template-bound delegation)", () => {
  const LOCAL_ROWS = [
    row("Layer 9", "Group", { childCount: 2 }), // machine name: the ENGINE owns naming
    textRow("Headline", {
      bounds: [72, 732, 936, 176],
      font: "Comic Sans",
      sizePt: 96,
    }),
    row("Photo", "Pixel", { bounds: [0, 0, 1080, 700] }), // local editability applies
  ];

  const ENGINE_REPLY = {
    ok: false,
    issues: [
      {
        level: "major",
        code: "safe_area",
        layer: "CTA",
        message: "CTA reaches inside the 48 px safe-area margin",
        fix: "keep it 48 px inside (edit.transform)",
      },
    ],
    template: "instagram-post@3",
    truncated: false,
  };

  it("delegates to engine template.validate and adds only the local supplement", async () => {
    const engine = makeEngine({
      rows: LOCAL_ROWS,
      executeReport: reportWith(ENGINE_REPLY),
    });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(
      ctx,
      { documentId: DOC_ID, template: "instagram-post@3" },
      freshSignal(),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(engine.executed.length).toBe(1);
    expect(engine.executed[0]?.id).toBe(TEMPLATE_VALIDATE_COMMAND);
    expect(engine.executed[0]?.params).toEqual({
      template: "instagram-post@3",
    });
    const parsed = JSON.parse(result.summary) as {
      ok: boolean;
      template: string;
      issueCounts: { blocker: number; major: number; minor: number };
      issues: { level: string; code: string }[];
    };
    expect(parsed.template).toBe("instagram-post@3");
    expect(parsed.ok).toBe(false);
    // Engine's major + the local supplement's blockers (font + raster image).
    expect(parsed.issueCounts).toEqual({ blocker: 2, major: 1, minor: 0 });
    const seen = parsed.issues.map((issue) => issue.code);
    expect(seen).toContain("safe_area"); // engine-owned rule
    expect(seen).toContain("missing_font"); // local rule the engine cannot own
    expect(seen).toContain("editability"); // local rule the engine cannot own
    // The engine's naming pass owns machine names — the local arm must not duplicate.
    expect(seen).not.toContain("naming");
    expect(parsed.issues.find((issue) => issue.level === "major")?.code).toBe("safe_area");
  });

  it("an unknown template pin is not_found with the catalog's pins in the hint", async () => {
    const engine = makeEngine({ rows: LOCAL_ROWS });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(
      ctx,
      { documentId: DOC_ID, template: "youtube-thumb@1" },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.message).toContain("youtube-thumb@1");
      expect(result.hint).toContain("instagram-post@3");
    }
  });

  it("an engine failure on template.validate passes code/message/retryable through", async () => {
    const engine = makeEngine({
      rows: LOCAL_ROWS,
      executeFailure: {
        ok: false,
        code: "engine_crashed",
        message: "engine died mid-pass",
        retryable: true,
      },
    });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(
      ctx,
      { documentId: DOC_ID, template: "instagram-post@3" },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_crashed");
      expect(result.message).toContain("engine died mid-pass");
      expect(result.retryable).toBe(true);
    }
  });

  it("a payload-less reply is an internal_error, never a fabricated pass", async () => {
    const engine = makeEngine({
      rows: LOCAL_ROWS,
      executeReport: { revision: 9 },
    });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(
      ctx,
      { documentId: DOC_ID, template: "instagram-post@3" },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal_error");
      expect(result.message).toContain("could not be read");
    }
  });

  it("malformed engine rows are dropped with a warning; the engine's truncation surfaces too", async () => {
    const engine = makeEngine({
      rows: LOCAL_ROWS,
      executeReport: reportWith({
        ok: true,
        issues: [
          { level: "fatal", code: "mystery", message: "m", fix: "f" },
          {
            level: "minor",
            code: "naming",
            layer: "Layer 9",
            message: "machine name",
            fix: "rename",
          },
        ],
        truncated: true,
      }),
    });
    const { ctx } = makeContext({ engine });
    const result = await validateDocument.run(
      ctx,
      { documentId: DOC_ID, template: "instagram-post@3" },
      freshSignal(),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings?.join(" ")).toContain("1 engine issue row(s) dropped");
    expect(result.warnings?.join(" ")).toContain("capped its own issue list");
    const parsed = JSON.parse(result.summary) as { issues: { code: string }[] };
    expect(parsed.issues.map((issue) => issue.code)).toContain("naming");
  });

  it("the supplement's rule set is exactly the non-engine-owned rules", () => {
    expect([...TEMPLATE_ARM_SUPPLEMENT_RULES]).toEqual([
      "in_bounds",
      "text_overflow",
      "missing_font",
      "editability",
      "z_order",
      "empty_layers",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Registry pinning (§6 surface)
// ---------------------------------------------------------------------------

describe("validate_document: registry", () => {
  it("registers on the pinned §6 surface under TOOLS.validate_document", () => {
    expect(validateDocument.name).toBe(TOOLS.validate_document);
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(validateDocument as AnyTool)).toStrictEqual({
      ok: true,
    });
    const lookup = registry.get(TOOLS.validate_document);
    expect(lookup.ok).toBe(true);
    expect(registry.list().map((listing) => listing.name)).toContain("validate_document");
  });
});
