// template-fill.test.ts — the §6.2 worked-example table for template_fill.
//
// Deterministic, pure: the engine/db/catalog seams are fakes (tests/fakes.ts), the
// manifest is derived from the REAL eval fixture (evals/templates/instagram-post@3)
// so the tool is validated against the actual §7.2 slot set, and the engine reply
// shapes mirror engine-patches/template_cmds/fill.rs (§7.4).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  TEMPLATE_FILL_COMMAND,
  compileSlotValues,
  imageUpscaleLimitErr,
  readFillReport,
  summarizeFill,
  templateFillTool,
  unknownSlotsErr,
} from "../src/tools/template-fill.js";
import type {
  AssetRecord,
  AssetStoreLike,
  BudgetTracker,
  EngineCommand,
  EngineCommandReport,
  EngineLike,
  EngineOutcome,
  TemplateCatalogLike,
  TemplateManifest,
  TemplateSlotKind,
  TemplateSlotSpec,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures — the real §7.2 manifest, adapted to the TemplateManifest seam
// ---------------------------------------------------------------------------

interface RawSlot {
  readonly kind: string;
  readonly optional?: boolean;
}

interface RawManifest {
  readonly id: string;
  readonly version: number;
  readonly slots: Record<string, RawSlot>;
}

// Real manifests carry §7.2 `component` slots too; the seam's kind union is the
// four fillable kinds, so the fixture widens it with a targeted cast.
// (Three segments up: tests/ → tools/ → packages/ → studio root.)
const REAL_MANIFEST_URL = new URL(
  "../../../evals/templates/instagram-post@3/manifest.json",
  import.meta.url,
);

const rawManifest = JSON.parse(readFileSync(REAL_MANIFEST_URL, "utf8")) as RawManifest;
const REAL_REF = `${rawManifest.id}@${rawManifest.version}`;

const realManifest: TemplateManifest = {
  id: rawManifest.id,
  version: String(rawManifest.version),
  slots: Object.fromEntries(
    Object.entries(rawManifest.slots).map(
      ([name, slot]): [string, TemplateSlotSpec] => [
        name,
        { kind: slot.kind as TemplateSlotKind, required: slot.optional !== true },
      ],
    ),
  ),
};

const ASSET_ID = "9b2f3a10-1234-4c5d-9e8f-a1b2c3d4e5f6";
const ASSET: AssetRecord = {
  assetId: ASSET_ID,
  organizationId: "org_00000000-0000-0000-0000-000000000000",
  filename: "logo.png",
  mimeType: "image/png",
  storageUrl: "workspace-assets/logo.png",
  widthPx: 120,
  heightPx: 40,
};

/** A manifest with every fillable kind plus a component slot (mirrors fill.rs fixtures). */
const fillableManifest: TemplateManifest = {
  id: "fillable",
  version: "1",
  slots: {
    photo: { kind: "image", required: true },
    headline: { kind: "text", required: true },
    bg: { kind: "color", required: true },
    showLogo: { kind: "visibility", required: false },
    badge: { kind: "component" as TemplateSlotKind, required: false },
  },
};

// ---------------------------------------------------------------------------
// Fakes — recording engine, budget meter, catalog, asset store
// ---------------------------------------------------------------------------

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

function assetStore(known: readonly AssetRecord[] = [ASSET]): AssetStoreLike {
  return {
    get: async (id) => known.find((a) => a.assetId === id),
    search: async () => known,
  };
}

/** Records every dispatched command; replies come from `execute`. */
function stubEngine(
  execute: (cmd: EngineCommand) => Promise<EngineOutcome<EngineCommandReport>>,
): { engine: EngineLike; commands: EngineCommand[] } {
  const commands: EngineCommand[] = [];
  const engine: EngineLike = {
    batch: async (cmds) => {
      commands.push(...cmds);
      return { ok: true, value: { revision: 1, outcomes: [] } };
    },
    execute: async (cmd) => {
      commands.push(cmd);
      return execute(cmd);
    },
    render: async () => ({ ok: true, value: { image: new Uint8Array(), widthPx: 8, heightPx: 8 } }),
    inspect: async () => ({
      ok: true,
      value: { revision: 1, widthPx: 8, heightPx: 8, layers: [] },
    }),
    listLayers: async () => ({ ok: true, value: [] }),
  };
  return { engine, commands };
}

/** A §7.4 fill reply riding on the minimal EngineCommandReport seam. */
type ReportWithFields = EngineCommandReport & {
  applied?: unknown;
  warnings?: unknown;
  errors?: unknown;
};

function fillReport(
  fields: { applied?: unknown; warnings?: unknown; errors?: unknown } = {},
  revision = 7,
): EngineCommandReport {
  const report: ReportWithFields = { revision, ...fields };
  return report;
}

function budgets(allow: boolean): { budgets: BudgetTracker; charges: unknown[] } {
  const charges: { commands?: number; renderPx?: number }[] = [];
  const tracker: BudgetTracker = {
    remaining: () => ({ msRemaining: 5000, commandsRemaining: 64 }),
    charge: (usage) => {
      charges.push(usage);
      return allow;
    },
  };
  return { budgets: tracker, charges };
}

/** The default happy-path context: real manifest, one asset, always-ok engine. */
function happyContext(
  execute: (cmd: EngineCommand) => Promise<EngineOutcome<EngineCommandReport>>,
): { ctx: ReturnType<typeof makeFakeContext>; commands: EngineCommand[]; charges: unknown[] } {
  const stub = stubEngine(execute);
  const meter = budgets(true);
  const ctx = makeFakeContext({
    templates: catalogWith(realManifest),
    assets: assetStore(),
    engine: stub.engine,
    budgets: meter.budgets,
  });
  return { ctx, commands: stub.commands, charges: meter.charges };
}

// ---------------------------------------------------------------------------
// Schema (§6.1/§6.2: strict, capped, defaulted)
// ---------------------------------------------------------------------------

describe("template_fill: argument schema", () => {
  it("accepts all four slot kinds and defaults image fit to cover (§6.2)", () => {
    const parsed = parseToolArgs(templateFillTool, {
      template: "instagram-post@3",
      slots: {
        headline: { kind: "text", value: "Big Sale", font: "display", size: 96, align: "left" },
        logo: { kind: "image", asset_id: ASSET_ID, focal: { x: 0.62, y: 0.4 } },
        badgeColor: { kind: "color", value: "#3B2A20" },
        showLogo: { kind: "visibility", visible: true },
      },
      idempotencyKey: "run-2026-key-1",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const logo = parsed.args.slots.logo;
    expect(logo?.kind).toBe("image");
    if (logo?.kind === "image") {
      expect(logo.fit).toBe("cover");
      expect(logo.focal).toStrictEqual({ x: 0.62, y: 0.4 });
    }
  });

  it("rejects more than 40 slot entries (§6.2 'too many slots')", () => {
    const fortyOne: Record<string, unknown> = {};
    for (let i = 0; i < 41; i += 1) fortyOne[`headline${i}`] = { kind: "text", value: "x" };
    const rejected = parseToolArgs(templateFillTool, {
      template: "instagram-post@3",
      slots: fortyOne,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("invalid_args");
      expect(rejected.hint).toContain("too many entries (max 40)");
    }
    const forty: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) forty[`headline${i}`] = { kind: "text", value: "x" };
    const parsed = parseToolArgs(templateFillTool, {
      template: "instagram-post@3",
      slots: forty,
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects extra properties at every level (additionalProperties: false)", () => {
    const cases: unknown[] = [
      { template: "instagram-post@3", slots: {}, bogus: true },
      { template: "instagram-post@3", slots: { headline: { kind: "text", value: "x", bogus: 1 } } },
      {
        template: "instagram-post@3",
        slots: { logo: { kind: "image", asset_id: ASSET_ID, focal: { x: 0, y: 0 } } },
        extra: 1,
      },
      {
        template: "instagram-post@3",
        slots: { logo: { kind: "image", asset_id: ASSET_ID, fit: "stretch" } },
      },
      { template: "not a ref", slots: {} },
    ];
    for (const [index, value] of cases.entries()) {
      expect(parseToolArgs(templateFillTool, value).ok, `case ${index}`).toBe(false);
    }
  });

  it("rejects wrong kinds and out-of-range values (§6.2 table)", () => {
    const cases: unknown[] = [
      { kind: "textarea", value: "x" },
      { kind: "text", value: "x", size: 3 },
      { kind: "text", value: "x", size: 1201 },
      { kind: "text", value: "x", align: "middle" },
      { kind: "text", value: "x".repeat(2001) },
      { kind: "text" },
      { kind: "image", asset_id: "not-a-uuid" },
      { kind: "image", asset_id: ASSET_ID, focal: { x: 1.5, y: 0.5 } },
      { kind: "image", asset_id: ASSET_ID, focal: { x: Number.NaN, y: 0.5 } },
      { kind: "color", value: "notacolor" },
      { kind: "visibility" },
    ];
    for (const [index, value] of cases.entries()) {
      const parsed = parseToolArgs(templateFillTool, {
        template: "instagram-post@3",
        slots: { headline: value },
      });
      expect(parsed.ok, `case ${index}`).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("invalid_args");
    }
  });
});

// ---------------------------------------------------------------------------
// Manifest validation + unknown slots (§6.2, against the real manifest)
// ---------------------------------------------------------------------------

describe("template_fill: manifest and slot validation", () => {
  it("is validated against the real instagram-post@3 fixture (§7.2)", () => {
    expect(REAL_REF).toBe("instagram-post@3");
    expect(Object.keys(realManifest.slots)).toStrictEqual([
      "photo",
      "headline",
      "subhead",
      "badge",
      "logo",
    ]);
  });

  it("returns not_found with catalog candidates for an unknown template", async () => {
    const stub = stubEngine(async () => ({ ok: true, value: fillReport() }));
    const ctx = makeFakeContext({
      templates: catalogWith(realManifest),
      assets: assetStore(),
      engine: stub.engine,
    });
    const result = await templateFillTool.run(
      ctx,
      { template: "youtube-thumb@1", slots: {} },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.message).toContain("youtube-thumb@1");
      expect(result.hint).toContain("instagram-post@3");
    }
    expect(stub.commands.length).toBe(0);
  });

  it("rejects unknown slots with the exact §6.2 message, known slots in the hint", async () => {
    const stub = stubEngine(async () => ({ ok: true, value: fillReport() }));
    const ctx = makeFakeContext({
      templates: catalogWith(realManifest),
      assets: assetStore(),
      engine: stub.engine,
    });
    const result = await templateFillTool.run(
      ctx,
      {
        template: REAL_REF,
        slots: {
          headline: { kind: "text", value: "Hi" },
          bogus: { kind: "text", value: "x" },
          extra: { kind: "text", value: "y" },
        },
      },
      freshSignal(),
    );
    expect(result).toStrictEqual({
      ok: false,
      code: "unknown_slots",
      message: "unknown slots: bogus, extra",
      hint: "this template's slots: photo, headline, subhead, badge, logo",
      retryable: false,
    });
    expect(stub.commands.length).toBe(0);
  });

  it("rejects a value whose kind does not match the manifest slot's kind", async () => {
    const { ctx, commands } = happyContext(async () => ({ ok: true, value: fillReport() }));
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { photo: { kind: "text", value: "not a photo" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_slots");
      expect(result.message).toBe('Slot "photo" expects kind "image", got "text"');
    }
    expect(commands.length).toBe(0);
  });

  it("refuses the real manifest's component slot with a component-tools hint", async () => {
    const { ctx, commands } = happyContext(async () => ({ ok: true, value: fillReport() }));
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { badge: { kind: "text", value: "20% OFF" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_slots");
      expect(result.message).toContain("which template_fill does not fill");
      expect(result.hint).toContain("component_place");
    }
    expect(commands.length).toBe(0);
  });

  it("missing required slots are the engine's §7.3 check, not this tool's", async () => {
    const { ctx, commands } = happyContext(async () => ({ ok: true, value: fillReport() }));
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { logo: { kind: "image", asset_id: ASSET_ID, fit: "cover" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    expect(commands.length).toBe(1);
  });

  it("returns not_found for an image slot whose asset is not in this workspace", async () => {
    const stub = stubEngine(async () => ({ ok: true, value: fillReport() }));
    const ctx = makeFakeContext({
      templates: catalogWith(realManifest),
      assets: assetStore([]),
      engine: stub.engine,
    });
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { logo: { kind: "image", asset_id: ASSET_ID, fit: "cover" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.message).toContain('slot "logo"');
    }
    expect(stub.commands.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The fill flow: compile → charge → template.fill → §6.1 compact reply
// ---------------------------------------------------------------------------

describe("template_fill: engine flow", () => {
  it("fills text and image slots through one template.fill command (§6.2)", async () => {
    const { ctx, commands, charges } = happyContext(
      async () => ({ ok: true, value: fillReport({ applied: ["headline", "logo"] }) }),
    );
    const result = await templateFillTool.run(
      ctx,
      {
        template: REAL_REF,
        slots: {
          headline: {
            kind: "text",
            value: "Big Sale",
            font: "display",
            size: 96,
            color: "#3B2A20",
            align: "left",
          },
          logo: { kind: "image", asset_id: ASSET_ID, fit: "contain", focal: { x: 0.62, y: 0.4 } },
        },
      },
      freshSignal(),
    );
    expect(isToolResult(result)).toBe(true);
    expect(result).toStrictEqual({
      ok: true,
      summary: "Filled 2 of 2 slots (headline, logo); 0 warnings.",
      documentRevision: 7,
    });
    expect(commands.length).toBe(1);
    expect(commands[0]?.id).toBe(TEMPLATE_FILL_COMMAND);
    expect(commands[0]?.params).toStrictEqual({
      slots: {
        headline: { text: "Big Sale", font: "display", size: 96, color: "#3B2A20", align: "left" },
        logo: { path: "workspace-assets/logo.png", fit: "contain", focalPoint: [0.62, 0.4] },
      },
    });
    expect(charges).toStrictEqual([{ commands: 1 }]);
  });

  it("stops cleanly at the budget boundary without dispatching (§5.2)", async () => {
    const stub = stubEngine(async () => ({ ok: true, value: fillReport() }));
    const meter = budgets(false);
    const ctx = makeFakeContext({
      templates: catalogWith(realManifest),
      assets: assetStore(),
      engine: stub.engine,
      budgets: meter.budgets,
    });
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { headline: { kind: "text", value: "Hi" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("budget_exceeded");
    expect(stub.commands.length).toBe(0);
    expect(meter.charges).toStrictEqual([{ commands: 1 }]);
  });

  it("passes engine soft warnings through as compact warning strings (§7.3)", async () => {
    const { ctx } = happyContext(
      async () => ({
        ok: true,
        value: fillReport({
          applied: ["subhead"],
          warnings: [
            {
              code: "text_trimmed",
              slot: "subhead",
              message:
                "slot `subhead`: trimmed from 60 to 12 characters at a user-visible boundary (maxChars 12)",
            },
          ],
        }),
      }),
    );
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { subhead: { kind: "text", value: "A much longer subhead" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.documentRevision).toBe(7);
      expect(result.warnings).toStrictEqual([
        "[text_trimmed] slot `subhead`: trimmed from 60 to 12 characters at a user-visible boundary (maxChars 12)",
      ]);
      expect(result.summary).toBe("Filled 1 of 1 slots (subhead); 1 warning.");
    }
  });

  it("surfaces soft errors from an otherwise-ok reply in summary and warnings", async () => {
    const { ctx } = happyContext(
      async () => ({
        ok: true,
        value: fillReport({
          applied: ["logo"],
          errors: [{ code: "slot_deferred", slot: "badge", message: "slot `badge` was deferred" }],
        }),
      }),
    );
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { logo: { kind: "image", asset_id: ASSET_ID, fit: "cover" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe("Filled 1 of 1 slots (logo); 0 warnings, 1 soft error.");
      expect(result.warnings).toStrictEqual(["[slot_deferred] slot `badge` was deferred"]);
    }
  });

  it("caps warnings at the §6.1 reply limit and notes the omissions in the summary", async () => {
    const warnings = Array.from({ length: 25 }, (_, i) => `soft issue ${i}`);
    const { ctx } = happyContext(
      async () => ({ ok: true, value: fillReport({ applied: ["headline"], warnings }) }),
    );
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { headline: { kind: "text", value: "Hi" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings?.length).toBe(20);
      expect(result.summary).toContain("5 warnings omitted by the reply cap");
    }
  });

  it("falls back to the requested slots when the reply carries no report", async () => {
    const { ctx } = happyContext(async () => ({ ok: true, value: { revision: 4 } }));
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { headline: { kind: "text", value: "Hi" } } },
      freshSignal(),
    );
    expect(result).toStrictEqual({
      ok: true,
      summary: "Filled 1 of 1 slots (headline); 0 warnings.",
      documentRevision: 4,
    });
  });

  it("reads a JSON-encoded report from the seam's message field", async () => {
    const message = JSON.stringify({
      applied: ["headline"],
      warnings: [
        { code: "image_upscaled", slot: "logo", message: "slot `logo`: upscaled to 150%" },
      ],
      errors: [],
    });
    const { ctx } = happyContext(async () => ({ ok: true, value: { revision: 9, message } }));
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { headline: { kind: "text", value: "Hi" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe("Filled 1 of 1 slots (headline); 1 warning.");
      expect(result.warnings).toStrictEqual(["[image_upscaled] slot `logo`: upscaled to 150%"]);
      expect(result.documentRevision).toBe(9);
    }
  });

  it("passes engine hard failures through with code, hint and retryability", async () => {
    const { ctx } = happyContext(async () => ({
      ok: false,
      code: "engine_timeout",
      message: "The engine ran out of time mid-fill",
      hint: "The transaction rolled back to the pre-fill revision",
      retryable: true,
    }));
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { headline: { kind: "text", value: "Hi" } } },
      freshSignal(),
    );
    expect(result).toStrictEqual({
      ok: false,
      code: "engine_timeout",
      message: "The engine ran out of time mid-fill",
      hint: "The transaction rolled back to the pre-fill revision",
      retryable: true,
    });
  });

  it("maps the engine's §7.3 upscale refusal to the precise image_upscale_limit error", async () => {
    const { ctx } = happyContext(async () => ({
      ok: false,
      code: "validation_failed",
      message:
        "slot `logo`: upscaling the image to 1500% of its pixels exceeds the 200% limit; " +
        "use an image at least around 60×20 px",
      retryable: false,
    }));
    const result = await templateFillTool.run(
      ctx,
      { template: REAL_REF, slots: { logo: { kind: "image", asset_id: ASSET_ID, fit: "cover" } } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("image_upscale_limit"); // W7-M catalog adoption pin
      expect(result.message).toContain("exceeds the 200% limit");
      expect(result.hint).toContain("125%");
      expect(result.retryable).toBe(false);
    }
  });

  it("registers on the pinned §6 surface under TOOLS.template_fill", () => {
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(templateFillTool)).toStrictEqual({ ok: true });
    const lookup = registry.get(TOOLS.template_fill);
    expect(lookup.ok).toBe(true);
    expect(registry.list()[0]?.name).toBe("template_fill");
  });
});

// ---------------------------------------------------------------------------
// Pure units: compile, focal clamp, report reading, summary
// ---------------------------------------------------------------------------

describe("template_fill: compileSlotValues (pure, §6.2)", () => {
  it("compiles every fillable kind to its engine slot-arg form", () => {
    const compiled = compileSlotValues(
      fillableManifest,
      {
        photo: { kind: "image", asset_id: ASSET_ID, fit: "cover" },
        headline: { kind: "text", value: "Hello", size: 96 },
        bg: { kind: "color", value: "#D96C3B" },
        showLogo: { kind: "visibility", visible: true },
      },
      { photo: "wa/photo.png" },
    );
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.slots.photo).toStrictEqual({ path: "wa/photo.png", fit: "cover" });
      expect(compiled.slots.headline).toStrictEqual({ text: "Hello", size: 96 });
      expect(compiled.slots.bg).toBe("#D96C3B");
      expect(compiled.slots.showLogo).toBe(true);
    }
  });

  it("clamps focal points into 0..1 (§7.2) before they reach the engine", () => {
    const compiled = compileSlotValues(
      fillableManifest,
      { photo: { kind: "image", asset_id: ASSET_ID, fit: "cover", focal: { x: 1.5, y: -0.3 } } },
      { photo: "wa/photo.png" },
    );
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.slots.photo).toStrictEqual({
        path: "wa/photo.png",
        fit: "cover",
        focalPoint: [1, 0],
      });
    }
  });

  it("narrows colour values to the engine's hex contract with an actionable error", () => {
    const rgb = compileSlotValues(
      fillableManifest,
      { bg: { kind: "color", value: "rgb(59, 42, 32)" } },
      {},
    );
    expect(rgb.ok).toBe(false);
    if (!rgb.ok) {
      expect(rgb.code).toBe("invalid_slots");
      expect(rgb.message).toContain("#RRGGBB");
    }
    const shortHex = compileSlotValues(
      fillableManifest,
      { headline: { kind: "text", value: "Hi", color: "#3B2" } },
      {},
    );
    expect(shortHex.ok).toBe(false);
    if (!shortHex.ok) expect(shortHex.code).toBe("invalid_slots");
  });

  it("reports the first bad slot in manifest order (deterministic)", () => {
    const compiled = compileSlotValues(
      fillableManifest,
      {
        bg: { kind: "color", value: "rgb(59, 42, 32)" },
        photo: { kind: "text", value: "not a photo" },
      },
      {},
    );
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.message).toContain("photo");
  });

  it("refuses an image slot whose asset path was never resolved", () => {
    const compiled = compileSlotValues(
      fillableManifest,
      { photo: { kind: "image", asset_id: ASSET_ID, fit: "cover" } },
      {},
    );
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.code).toBe("internal_error");
  });
});

describe("template_fill: pure report + summary helpers", () => {
  it("unknownSlotsErr emits the exact §6.2 message", () => {
    expect(unknownSlotsErr(["bogus", "extra"], ["photo", "headline"])).toStrictEqual({
      ok: false,
      code: "unknown_slots",
      message: "unknown slots: bogus, extra",
      hint: "this template's slots: photo, headline",
      retryable: false,
    });
  });

  it("imageUpscaleLimitErr keeps the engine's fix and adds the §7.3 hint", () => {
    const failure = imageUpscaleLimitErr(
      "slot `logo`: upscaling the image to 1500% of its pixels exceeds the 200% limit",
    );
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe("image_upscale_limit"); // W7-M catalog adoption pin
    expect(failure.message).toContain("200% limit");
    expect(failure.hint).toContain("asset_search");
  });

  it("readFillReport prefers structural fields, then message JSON, then the request", () => {
    const requested = ["headline"];
    const structural = readFillReport(
      fillReport({ applied: ["headline"], warnings: [{ code: "x", slot: "s", message: "m" }] }),
      requested,
    );
    expect(structural.applied).toStrictEqual(["headline"]);
    expect(structural.warnings).toStrictEqual(["[x] slot s: m"]);

    const jsonish = readFillReport(
      {
        revision: 4,
        message: JSON.stringify({ applied: ["headline"], warnings: ["late"], errors: [] }),
      },
      requested,
    );
    expect(jsonish.applied).toStrictEqual(["headline"]);
    expect(jsonish.warnings).toStrictEqual(["late"]);

    const bare = readFillReport({ revision: 5 }, requested);
    expect(bare.applied).toStrictEqual(["headline"]);
    expect(bare.warnings).toStrictEqual([]);
    expect(bare.softErrors).toStrictEqual([]);
  });

  it("summarizeFill renders counts and names within the compact-reply rule (§6.1)", () => {
    expect(
      summarizeFill({
        applied: ["a", "b"],
        requested: ["a", "b"],
        warnings: 1,
        softErrors: 0,
        omitted: 0,
      }),
    ).toBe("Filled 2 of 2 slots (a, b); 1 warning.");
    expect(
      summarizeFill({
        applied: [],
        requested: ["a"],
        warnings: 0,
        softErrors: 2,
        omitted: 3,
      }),
    ).toBe("Filled 0 of 1 slots; 0 warnings, 2 soft errors, 3 warnings omitted by the reply cap.");
  });
});
