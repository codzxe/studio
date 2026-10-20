// image-generate.test.ts — W5-F. Table-driven, deterministic, no network:
// credit-charge table (§5.2), provider-failure mapping, PNG validation,
// target placement mechanics, prompt cap/sanitisation, schema strictness.

import { ENGINE_PNG_MAX_BYTES } from "@studio/config";
import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import {
  GENERATED_PHOTO_LAYER_NAME,
  IMAGE_CREDIT_COST,
  imageGenerateArgsSchema,
  imageGenerateTool,
  sanitizePrompt,
  validatePng,
  type CreditSpender,
  type GeneratedImageSinkLike,
  type ImageGenerateArgs,
  type ImageGenerateContext,
  type ImageProviderLike,
  type ImageProviderResult,
  type ImageQuality,
  type ImageSize,
} from "../src/tools/image-generate.js";
import type {
  EngineBatchOptions,
  EngineCommand,
  EngineLayerSummary,
  EngineLike,
  EngineOutcome,
  TemplateCatalogLike,
  ToolErr,
  ToolOk,
  ToolResult,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY = "runkey-0001";
const DEFAULT_PROMPT = "a moody latte on a marble table, warm light";

/** Minimal PNG: signature + IHDR length + "IHDR" + BE dimensions (offsets ≤ 24). */
function pngBytes(widthPx: number, heightPx: number, pad = 0): Uint8Array {
  const bytes = new Uint8Array(24 + pad);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, widthPx, false);
  new DataView(bytes.buffer).setUint32(20, heightPx, false);
  return bytes;
}

const LAYER_BG: EngineLayerSummary = {
  layerId: "l-bg",
  name: "Background",
  kind: "background",
  visible: true,
  bounds: { x: 0, y: 0, width: 1080, height: 700 },
};
const LAYER_PHOTO: EngineLayerSummary = {
  layerId: "l-photo",
  name: "Photo",
  kind: "image",
  visible: true,
  bounds: { x: 0, y: 0, width: 1080, height: 700 },
};
const LAYER_PHOTO2: EngineLayerSummary = {
  layerId: "l-photo2",
  name: "Photo",
  kind: "image",
  visible: true,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};
const LAYER_GROUP: EngineLayerSummary = {
  layerId: "l-group",
  name: "Content",
  kind: "group",
  visible: true,
  childCount: 2,
};

interface EngineScript {
  readonly before: readonly EngineLayerSummary[];
  readonly placedLayerId?: string;
  readonly convertFails?: boolean;
  readonly revisionStart?: number;
}

interface RecordedCommand {
  readonly id: string;
  readonly params: Record<string, unknown>;
  readonly mode: "batch" | "execute";
}

function makeEngine(script: EngineScript) {
  const commands: RecordedCommand[] = [];
  const placedId = script.placedLayerId ?? "l-placed";
  let revision = script.revisionStart ?? 7;
  let layers = [...script.before];
  const success = <T>(value: T): EngineOutcome<T> => ({ ok: true, value });

  function apply(cmd: EngineCommand): void {
    if (cmd.id === "doc.place") {
      const path = typeof cmd.params.path === "string" ? cmd.params.path : "placed.png";
      layers = [
        ...layers,
        {
          layerId: placedId,
          name: path,
          kind: "smartObject",
          visible: true,
          bounds: { x: 0, y: 0, width: 1080, height: 700 },
        },
      ];
    }
    if (
      cmd.id === "layer.setProps" &&
      cmd.params.layer === placedId &&
      typeof cmd.params.name === "string"
    ) {
      layers = layers.map((layer) =>
        layer.layerId === placedId ? { ...layer, name: String(cmd.params.name) } : layer,
      );
    }
  }

  const engine: EngineLike = {
    async batch(cmds: readonly EngineCommand[], _options?: EngineBatchOptions) {
      for (const cmd of cmds) {
        commands.push({ id: cmd.id, params: { ...cmd.params }, mode: "batch" });
        apply(cmd);
      }
      revision += 1;
      return success({
        revision,
        outcomes: cmds.map((cmd, index) => ({ index, commandId: cmd.id, ok: true })),
      });
    },
    async execute(cmd: EngineCommand) {
      commands.push({ id: cmd.id, params: { ...cmd.params }, mode: "execute" });
      if (cmd.id === "layer.smartObjects.convertToSmartObject" && script.convertFails === true) {
        return {
          ok: false,
          code: "validation_failed",
          message: "layer is already a smart object",
          retryable: false,
        };
      }
      revision += 1;
      return success({ revision });
    },
    async render() {
      return success({ image: new Uint8Array(), widthPx: 64, heightPx: 64 });
    },
    async inspect() {
      return success({ revision, widthPx: 1080, heightPx: 700, layers: [...layers] });
    },
    async listLayers() {
      return success([...layers]);
    },
  };
  return { engine, commands, placedId };
}

interface CreditFailure {
  readonly code: ToolErr["code"];
  readonly message: string;
  readonly retryable?: boolean;
}

function makeCredits(failWith?: CreditFailure) {
  const calls: Array<{ amount: number; reason: string }> = [];
  const credits: CreditSpender = {
    async spendCredits(amount, reason) {
      calls.push({ amount, reason });
      if (failWith !== undefined) {
        return { ok: false, ...failWith };
      }
      return { ok: true, value: { charged: amount } };
    },
  };
  return { credits, calls };
}

interface ProviderCall {
  readonly prompt: string;
  readonly size: ImageSize;
  readonly quality: ImageQuality;
  readonly aborted: boolean;
}

function makeProvider(script: { result?: ImageProviderResult; throw?: () => Error } = {}) {
  const calls: ProviderCall[] = [];
  const imageProvider: ImageProviderLike = {
    async generate(prompt, size, quality, signal) {
      calls.push({ prompt, size, quality, aborted: signal.aborted });
      if (script.throw !== undefined) {
        throw script.throw();
      }
      return script.result ?? { bytes: pngBytes(1024, 1024), mime: "image/png" };
    },
  };
  return { imageProvider, calls };
}

function makeSink() {
  const calls: Array<{ bytes: Uint8Array; fileName: string }> = [];
  const generatedImages: GeneratedImageSinkLike = {
    async put(bytes, fileName) {
      calls.push({ bytes, fileName });
      return { ok: true, value: { path: `generated/${fileName}` } };
    },
  };
  return { generatedImages, calls };
}

function makeBudgets(allow: () => boolean = () => true) {
  const charges: Array<{ commands?: number; renderPx?: number }> = [];
  const budgets = {
    remaining: () => ({ msRemaining: 60_000, commandsRemaining: 256 }),
    charge(usage: { commands?: number; renderPx?: number }) {
      charges.push(usage);
      return allow();
    },
  };
  return { budgets, charges };
}

const SLOT_MANIFEST = {
  id: "menu-a4",
  version: "1.0.0",
  slots: { photo: { kind: "image" }, headline: { kind: "text" } },
  layerMap: { photo: "Photo", headline: "Headline" },
};

function slotTemplates(ref: string): TemplateCatalogLike {
  return {
    async get(templateRef) {
      return templateRef === ref ? SLOT_MANIFEST : undefined;
    },
    async list() {
      return [];
    },
  };
}

interface Parts {
  readonly engine: ReturnType<typeof makeEngine>;
  readonly credits: ReturnType<typeof makeCredits>;
  readonly provider: ReturnType<typeof makeProvider>;
  readonly sink: ReturnType<typeof makeSink>;
  readonly budgets: ReturnType<typeof makeBudgets>;
  readonly appliedTemplateRef?: string;
  readonly templates?: TemplateCatalogLike;
}

function makeImageContext(parts: Parts): ImageGenerateContext {
  return {
    ...makeFakeContext({ budgets: parts.budgets.budgets }),
    engine: parts.engine.engine,
    credits: parts.credits.credits,
    imageProvider: parts.provider.imageProvider,
    generatedImages: parts.sink.generatedImages,
    ...(parts.appliedTemplateRef !== undefined
      ? { appliedTemplateRef: parts.appliedTemplateRef }
      : {}),
    ...(parts.templates !== undefined ? { templates: parts.templates } : {}),
  };
}

function assemble(overrides: Partial<Parts> = {}) {
  const engine = overrides.engine ?? makeEngine({ before: [LAYER_BG, LAYER_PHOTO, LAYER_GROUP] });
  const parts: Parts = {
    engine,
    credits: overrides.credits ?? makeCredits(),
    provider: overrides.provider ?? makeProvider(),
    sink: overrides.sink ?? makeSink(),
    budgets: overrides.budgets ?? makeBudgets(),
    appliedTemplateRef: overrides.appliedTemplateRef,
    templates: overrides.templates,
  };
  return { parts, ctx: makeImageContext(parts) };
}

function baseArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { prompt: DEFAULT_PROMPT, idempotencyKey: KEY, target: {}, ...overrides };
}

function parsedArgs(raw: Record<string, unknown> = {}): ImageGenerateArgs {
  const parsed = parseToolArgs(imageGenerateTool, raw);
  if (!parsed.ok) {
    throw new Error(`fixture args failed schema: ${parsed.hint}`);
  }
  return parsed.args;
}

async function run(
  ctx: ImageGenerateContext,
  raw: Record<string, unknown> = {},
): Promise<ToolResult> {
  return imageGenerateTool.run(ctx, parsedArgs(baseArgs(raw)), freshSignal());
}

function expectOk(result: ToolResult): ToolOk {
  if (result.ok !== true) {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  }
  return result;
}

function expectErr(result: ToolResult): ToolErr {
  if (result.ok !== false) {
    throw new Error(`expected an error envelope, got ${JSON.stringify(result)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Schema strictness (§6.1)
// ---------------------------------------------------------------------------

describe("image_generate argument schema", () => {
  it("applies the documented defaults", () => {
    const args = parsedArgs({ prompt: "p", idempotencyKey: KEY, target: {} });
    expect(args.size).toBe("1024x1024");
    expect(args.quality).toBe("draft");
    expect(args.target).toEqual({});
  });

  it("rejects unknown properties at every level", () => {
    expect(parseToolArgs(imageGenerateTool, baseArgs({ nope: 1 })).ok).toBe(false);
    expect(parseToolArgs(imageGenerateTool, baseArgs({ target: { who: 1 } })).ok).toBe(false);
  });

  it("caps the prompt at 1500 characters", () => {
    expect(parseToolArgs(imageGenerateTool, baseArgs({ prompt: "a".repeat(1500) })).ok).toBe(true);
    const tooLong = parseToolArgs(imageGenerateTool, baseArgs({ prompt: "a".repeat(1501) }));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.code).toBe("invalid_args");
      expect(tooLong.hint).toContain("prompt");
    }
    expect(parseToolArgs(imageGenerateTool, baseArgs({ prompt: "" })).ok).toBe(false);
  });

  it("validates size, quality and the idempotency key", () => {
    expect(parseToolArgs(imageGenerateTool, baseArgs({ size: "1792x1024" })).ok).toBe(true);
    expect(parseToolArgs(imageGenerateTool, baseArgs({ size: "1024x1792" })).ok).toBe(true);
    expect(parseToolArgs(imageGenerateTool, baseArgs({ size: "512x512" })).ok).toBe(false);
    expect(parseToolArgs(imageGenerateTool, baseArgs({ quality: "final" })).ok).toBe(true);
    expect(parseToolArgs(imageGenerateTool, baseArgs({ quality: "hd" })).ok).toBe(false);
    expect(parseToolArgs(imageGenerateTool, baseArgs({ idempotencyKey: "short" })).ok).toBe(false);
  });

  it("requires prompt, idempotencyKey and target", () => {
    const accepts = (raw: Record<string, unknown>): boolean =>
      parseToolArgs(imageGenerateTool, raw).ok === true;
    expect(accepts({ idempotencyKey: KEY, target: {} })).toBe(false);
    expect(accepts({ prompt: "p", target: {} })).toBe(false);
    expect(accepts({ prompt: "p", idempotencyKey: KEY })).toBe(false);
  });

  it("allows at most one target anchor", () => {
    const accepts = (raw: Record<string, unknown>): boolean =>
      parseToolArgs(imageGenerateTool, baseArgs(raw)).ok === true;
    expect(accepts({ target: { slot: "photo" } })).toBe(true);
    expect(accepts({ target: { layer: { layerName: "Photo" } } })).toBe(true);
    expect(accepts({ target: { bounds: { x: 0, y: 0, width: 10, height: 10 } } })).toBe(true);
    expect(accepts({ target: { slot: "photo", layer: { layerName: "Photo" } } })).toBe(false);
  });

  it("enforces layer-ref XOR and bounds sanity", () => {
    const accepts = (raw: Record<string, unknown>): boolean =>
      parseToolArgs(imageGenerateTool, baseArgs(raw)).ok === true;
    expect(accepts({ target: { layer: { layerId: "a", layerName: "b" } } })).toBe(false);
    expect(accepts({ target: { bounds: { x: 0, y: 0, width: 0, height: 10 } } })).toBe(false);
    expect(accepts({ target: { bounds: { x: "0", y: 0, width: 10, height: 10 } } })).toBe(false);
    expect(accepts({ target: { bounds: { x: -5, y: 0, width: 10, height: 10 } } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credit charging (§5.2 draft=1, final=2; charge before generation)
// ---------------------------------------------------------------------------

describe("image_generate credit charging", () => {
  it("charges 1 credit for a draft", async () => {
    const { ctx, parts } = assemble();
    const result = await run(ctx, { quality: "draft" });
    expectOk(result);
    expect(parts.credits.calls).toEqual([
      { amount: IMAGE_CREDIT_COST.draft, reason: `image_generate:draft:${KEY}` },
    ]);
    expect(IMAGE_CREDIT_COST.draft).toBe(1);
  });

  it("charges 2 credits for a final", async () => {
    const { ctx, parts } = assemble();
    const result = await run(ctx, { quality: "final" });
    expectOk(result);
    expect(parts.credits.calls).toEqual([
      { amount: IMAGE_CREDIT_COST.final, reason: `image_generate:final:${KEY}` },
    ]);
    expect(IMAGE_CREDIT_COST.final).toBe(2);
  });

  it("charges before calling the provider (failures still owe the refund to policy)", async () => {
    const { ctx, parts } = assemble({ provider: makeProvider({ throw: () => new Error("boom") }) });
    const result = await run(ctx);
    expectErr(result);
    expect(parts.credits.calls.length).toBe(1);
    expect(parts.provider.calls.length).toBe(1);
  });

  it("does not generate when credits are insufficient", async () => {
    const credits = makeCredits({
      code: "insufficient_credits",
      message: "Balance below the reservation",
      retryable: false,
    });
    const { ctx, parts } = assemble({ credits });
    const result = await run(ctx);
    const failure = expectErr(result);
    expect(failure.code).toBe("insufficient_credits");
    expect(failure.retryable).toBe(false);
    expect(parts.provider.calls.length).toBe(0);
    expect(parts.sink.calls.length).toBe(0);
    expect(parts.engine.commands.length).toBe(0);
  });

  it("rejects an empty-after-sanitisation prompt without charging", async () => {
    const { ctx, parts } = assemble();
    const result = await run(ctx, { prompt: "\u0000\u007F \u200B" });
    const failure = expectErr(result);
    expect(failure.code).toBe("invalid_args");
    expect(parts.credits.calls.length).toBe(0);
    expect(parts.provider.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider failure mapping (§24.4 image_provider_error; §14.2 refund hint)
// ---------------------------------------------------------------------------

describe("image_generate provider failures", () => {
  it("maps provider throws to a retryable image_provider_error with a refund hint", async () => {
    const provider = makeProvider({ throw: () => new Error("upstream 500 /root/secret") });
    const { ctx } = assemble({ provider });
    const failure = expectErr(await run(ctx));
    expect(failure.code).toBe("image_provider_error");
    expect(failure.retryable).toBe(true);
    expect(failure.hint).toMatch(/refund/);
    expect(failure.message).not.toContain("500");
    expect(failure.message).not.toContain("/root/");
  });

  it("maps a non-PNG mime to image_provider_error", async () => {
    const provider = makeProvider({ result: { bytes: pngBytes(4, 4), mime: "image/jpeg" } });
    const { ctx } = assemble({ provider });
    const failure = expectErr(await run(ctx));
    expect(failure.code).toBe("image_provider_error");
    expect(failure.retryable).toBe(true);
  });

  it("maps PNG magic violations", async () => {
    const bytes = new TextEncoder().encode("GIF89a definitely not a png");
    const { ctx } = assemble({ provider: makeProvider({ result: { bytes, mime: "image/png" } }) });
    const failure = expectErr(await run(ctx));
    expect(failure.code).toBe("image_provider_error");
    expect(failure.message).toContain("bad_magic");
  });

  it("maps truncated PNG payloads", async () => {
    const bytes = pngBytes(4, 4).slice(0, 10);
    const { ctx } = assemble({ provider: makeProvider({ result: { bytes, mime: "image/png" } }) });
    const failure = expectErr(await run(ctx));
    expect(failure.message).toContain("truncated");
  });

  it("lets AbortError reach the deadline boundary as engine_timeout", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const { ctx } = assemble({ provider: makeProvider({ throw: () => abortError }) });
    const failure = expectErr(await run(ctx));
    expect(failure.code).toBe("engine_timeout");
  });
});

// ---------------------------------------------------------------------------
// PNG validation + prompt sanitisation (pure logic)
// ---------------------------------------------------------------------------

describe("validatePng", () => {
  it("accepts a well-formed PNG and reads its dimensions", () => {
    expect(validatePng(pngBytes(1024, 1024))).toEqual({ ok: true, widthPx: 1024, heightPx: 1024 });
    expect(validatePng(pngBytes(1792, 1024))).toEqual({ ok: true, widthPx: 1792, heightPx: 1024 });
  });

  it("rejects the failure table", () => {
    expect(validatePng(new Uint8Array())).toEqual({ ok: false, reason: "empty" });
    expect(validatePng(new Uint8Array(7))).toEqual({ ok: false, reason: "truncated" });
    const badMagic = pngBytes(4, 4);
    badMagic[0] = 0x88;
    expect(validatePng(badMagic)).toEqual({ ok: false, reason: "bad_magic" });
    expect(validatePng(pngBytes(4, 4).slice(0, 20))).toEqual({ ok: false, reason: "truncated" });
    const badChunk = pngBytes(4, 4);
    badChunk[12] = 0x58;
    expect(validatePng(badChunk)).toEqual({ ok: false, reason: "bad_ihdr" });
    expect(validatePng(pngBytes(0, 4))).toEqual({ ok: false, reason: "degenerate" });
    expect(validatePng(pngBytes(4, 4, ENGINE_PNG_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("sanitizePrompt", () => {
  it("strips control characters but keeps line structure", () => {
    expect(sanitizePrompt("a\u0000b\u0007c")).toBe("abc");
    expect(sanitizePrompt("line one\r\nline two")).toBe("line one\nline two");
    expect(sanitizePrompt("keep\ttabs")).toBe("keep\ttabs");
    expect(sanitizePrompt("\u200Bzero\u007Fwidth\u202E")).toBe("zerowidth");
    expect(sanitizePrompt("  padded  ")).toBe("padded");
    expect(sanitizePrompt("\u0001\u0002")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Target placement (§6 row 7: doc.place → smart object; §10.2 naming)
// ---------------------------------------------------------------------------

describe("image_generate target placement", () => {
  it("places above a named target layer with cover fit and renames per §10.2", async () => {
    const { ctx, parts } = assemble();
    const result = expectOk(await run(ctx, { target: { layer: { layerName: "Photo" } } }));
    const [select, place, rename, convert] = parts.engine.commands;
    expect(select).toMatchObject({ id: "layer.select", mode: "batch" });
    expect(select.params).toEqual({ layer: "l-photo", mode: "replace" });
    expect(place.id).toBe("doc.place");
    expect(place.params).toEqual({
      path: `generated/${KEY}.png`,
      scale: 105.47,
      center: [540, 350],
    });
    expect(rename).toMatchObject({
      id: "layer.setProps",
      params: { layer: parts.engine.placedId, name: GENERATED_PHOTO_LAYER_NAME },
    });
    expect(convert.id).toBe("layer.smartObjects.convertToSmartObject");
    expect(convert.mode).toBe("execute");
    expect(result.documentRevision).toBe(10);
    expect(result.summary).toContain(GENERATED_PHOTO_LAYER_NAME);
    expect(result.summary).toContain('over layer "Photo"');
    expect(isToolResult(result)).toBe(true);
  });

  it("resolves the target by layer id identically", async () => {
    const { ctx, parts } = assemble();
    expectOk(await run(ctx, { target: { layer: { layerId: "l-photo" } } }));
    expect(parts.engine.commands[0].params).toEqual({ layer: "l-photo", mode: "replace" });
  });

  it("lists candidates when a layer name is ambiguous", async () => {
    const engine = makeEngine({ before: [LAYER_BG, LAYER_PHOTO, LAYER_PHOTO2] });
    const { ctx } = assemble({ engine });
    const failure = expectErr(await run(ctx, { target: { layer: { layerName: "Photo" } } }));
    expect(failure.code).toBe("ambiguous_layer");
    expect(failure.hint).toContain("l-photo");
    expect(failure.hint).toContain("l-photo2");
  });

  it("reports unknown layers", async () => {
    const { ctx } = assemble();
    const failure = expectErr(await run(ctx, { target: { layer: { layerId: "l-nope" } } }));
    expect(failure.code).toBe("layer_not_found");
  });

  it("rejects targets without pixel bounds (groups)", async () => {
    const { ctx } = assemble();
    const failure = expectErr(await run(ctx, { target: { layer: { layerName: "Content" } } }));
    expect(failure.code).toBe("validation_failed");
  });

  it("places into a template slot through the applied manifest", async () => {
    const ref = "menu-a4@1.0.0";
    const { ctx, parts } = assemble({ appliedTemplateRef: ref, templates: slotTemplates(ref) });
    const result = expectOk(await run(ctx, { target: { slot: "photo" } }));
    expect(parts.engine.commands[0].params).toEqual({ layer: "l-photo", mode: "replace" });
    expect(result.summary).toContain('into slot "photo"');
  });

  it("rejects unknown slots and lists the mapped ones", async () => {
    const ref = "menu-a4@1.0.0";
    const { ctx } = assemble({ appliedTemplateRef: ref, templates: slotTemplates(ref) });
    const failure = expectErr(await run(ctx, { target: { slot: "logo" } }));
    expect(failure.code).toBe("unknown_slots");
    expect(failure.hint).toContain("photo");
  });

  it("rejects slot targets when no template is applied", async () => {
    const { ctx } = assemble();
    const failure = expectErr(await run(ctx, { target: { slot: "photo" } }));
    expect(failure.code).toBe("unknown_slots");
  });

  it("reports an unavailable applied manifest as not_found", async () => {
    const ref = "menu-a4@1.0.0";
    const { ctx } = assemble({
      appliedTemplateRef: "menu-a4@2.0.0",
      templates: slotTemplates(ref),
    });
    const failure = expectErr(await run(ctx, { target: { slot: "photo" } }));
    expect(failure.code).toBe("not_found");
  });

  it("places at explicit bounds without selecting a layer", async () => {
    const { ctx, parts } = assemble();
    expectOk(await run(ctx, { target: { bounds: { x: 10, y: 20, width: 500, height: 400 } } }));
    const [place] = parts.engine.commands;
    expect(place.id).toBe("doc.place");
    expect(place.params).toEqual({
      path: `generated/${KEY}.png`,
      scale: 48.83,
      center: [260, 220],
    });
  });

  it("places at natural size above the active layer when no anchor is given", async () => {
    const { ctx, parts } = assemble();
    expectOk(await run(ctx, { target: {} }));
    const [place] = parts.engine.commands;
    expect(place.id).toBe("doc.place");
    expect(place.params).toEqual({ path: `generated/${KEY}.png` });
  });

  it("warns instead of failing when the explicit smart-object conversion is refused", async () => {
    const engine = makeEngine({ before: [LAYER_BG, LAYER_PHOTO], convertFails: true });
    const { ctx, parts } = assemble({ engine });
    const result = expectOk(await run(ctx, { target: { layer: { layerId: "l-photo" } } }));
    expect(result.warnings?.some((warning) => /smart object/.test(warning))).toBe(true);
    expect(result.documentRevision).toBe(9);
  });

  it("warns when the provider returns unexpected dimensions", async () => {
    const provider = makeProvider({ result: { bytes: pngBytes(512, 512), mime: "image/png" } });
    const { ctx } = assemble({ provider });
    const result = expectOk(await run(ctx));
    expect(result.warnings?.some((warning) => warning.includes("512×512"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budgets (§5.2 stop cleanly) and seam wiring
// ---------------------------------------------------------------------------

describe("image_generate budgets and seams", () => {
  it("stops cleanly when the command budget is exhausted before placement", async () => {
    const { ctx, parts } = assemble({ budgets: makeBudgets(() => false) });
    const failure = expectErr(await run(ctx));
    expect(failure.code).toBe("budget_exceeded");
    expect(parts.budgets.charges.length).toBe(1);
    expect(parts.engine.commands.length).toBe(0);
  });

  it("skips the explicit conversion with a warning when the budget ends mid-run", async () => {
    const allowances = [true, true, false];
    const { ctx, parts } = assemble({ budgets: makeBudgets(() => allowances.shift() ?? true) });
    const result = expectOk(await run(ctx, { target: { layer: { layerName: "Photo" } } }));
    expect(parts.budgets.charges).toEqual([{ commands: 2 }, { commands: 1 }, { commands: 1 }]);
    expect(
      parts.engine.commands.some((cmd) => cmd.id === "layer.smartObjects.convertToSmartObject"),
    ).toBe(false);
    expect(result.warnings?.some((warning) => /budget/.test(warning))).toBe(true);
  });

  it("fails typed when the worker did not wire the image seams", async () => {
    const result = await imageGenerateTool.run(makeFakeContext(), parsedArgs(), freshSignal());
    const failure = expectErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.hint).toContain("ctx.credits");
  });

  it("charges the command meter only for what it batches", async () => {
    const { parts } = assemble();
    await run(makeImageContext(parts), { target: { layer: { layerName: "Photo" } } });
    expect(parts.budgets.charges).toEqual([{ commands: 2 }, { commands: 1 }, { commands: 1 }]);
  });
});

// Schema export sanity: the schema object is the tool's schema.
describe("image_generate schema export", () => {
  it("is the strict schema the tool parses with", () => {
    expect(imageGenerateTool.name).toBe("image_generate");
    expect(imageGenerateArgsSchema.safeParse(baseArgs()).success).toBe(true);
  });
});
