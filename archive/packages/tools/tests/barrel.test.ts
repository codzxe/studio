// barrel.test.ts — W10-O TS1205 sweep gate for the @studio/tools public barrel.
// src/index.ts splits every tool module's surface into value exports + `export
// type` blocks (verbatimModuleSyntax + isolatedModules forbid a plain
// `export { Type } from` — the 158 TS1205s this sweep removed); CI typecheck is
// the type-side gate. This suite pins the RUNTIME side of the contract:
//   1. every VALUE export still resolves from "../src/index.js" — a value
//      accidentally moved into an `export type` block vanishes at runtime;
//   2. every exported §6 tool const routes to the right Tool (name + run fn);
//   3. type-only names stay usable in type positions and stay erased at
//      runtime (`import type` + a runtime call through a typed helper).
// Deterministic by construction: importing the barrel evaluates only module
// top-levels (zod schemas, registry assembly) — no network, no clock, no engine.

import { describe, expect, expectTypeOf, it } from "vitest";
import * as tools from "../src/index.js";
import type { TemplateFillArgs, ToolMap } from "../src/index.js";

/** Every key of the barrel namespace must be a defined runtime value. */
function expectNamespaceIsClean(): void {
  const keys = Object.keys(tools);
  // Uniqueness tripwire: Object.keys cannot repeat, but this pins the
  // invariant the barrel exists to provide (no silently dropped names).
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) {
    expect(tools[key as keyof typeof tools], `undefined export: ${key}`).toBeDefined();
  }
  // Floor: 315 value exports after the W10-O split (21 tool modules + kit +
  // registry + registry-defaults + types). An `export type` mishap or a
  // star-export collision shrinks the namespace and trips this.
  expect(keys.length).toBeGreaterThanOrEqual(315);
}

describe("W10-O barrel: value exports resolve from src/index.js", () => {
  it("imports cleanly with a fully-defined, duplicate-free namespace", () => {
    expectNamespaceIsClean();
  });

  it("every exported §6 tool const is the right Tool object", () => {
    const anyTool = (value: unknown): import("../src/types.js").AnyTool =>
      value as import("../src/types.js").AnyTool;
    // [barrel const, §6 registry name] — one row per tool module (§6 rows).
    const registry: ReadonlyArray<[name: string, tool: unknown]> = [
      ["workspace_snapshot", tools.workspaceSnapshot],
      ["template_list", tools.templateList],
      ["template_inspect", tools.templateInspect],
      ["template_apply", tools.templateApplyTool],
      ["template_fill", tools.templateFillTool],
      ["asset_search", tools.assetSearchTool],
      ["asset_place", tools.assetPlaceTool],
      ["image_generate", tools.imageGenerateTool],
      ["text_set", tools.textSet],
      ["layer_ops", tools.layerOpsTool],
      ["style_apply", tools.styleApplyTool],
      ["layout_apply", tools.layoutApplyTool],
      ["component_list", tools.componentListTool],
      ["component_place", tools.componentPlaceTool],
      ["component_set_vars", tools.componentSetVarsTool],
      ["render_preview", tools.renderPreviewTool],
      ["validate_document", tools.validateDocument],
      ["vision_critique", tools.visionCritiqueTool],
      ["variant_create", tools.variantCreateTool],
      ["export_document", tools.exportDocumentTool],
      ["ask_user", tools.askUserTool],
    ];
    for (const [name, tool] of registry) {
      const t = anyTool(tool);
      expect(t.name, name).toBe(name);
      expect(typeof t.run, name).toBe("function");
      expect(t.args, name).toBeInstanceOf(Object);
    }
    // The dispatch map's every value self-declares the map key (echo rides
    // the default registry too, alongside the §6 surface; TOOLS is the §6
    // catalog). registry-defaults.ts throws at import time if assembly is
    // short a tool, so the size floor also proves the barrel still re-exports
    // the whole registry-defaults surface.
    expect(Object.keys(tools.TOOLS_DEFAULT).length).toBeGreaterThanOrEqual(21);
    for (const name of Object.keys(tools.TOOLS_DEFAULT)) {
      expect(tools.TOOLS_DEFAULT[name]?.name, name).toBe(name);
      expect(typeof tools.TOOLS_DEFAULT[name]?.run, name).toBe("function");
    }
  });

  it("representative value exports keep their runtime kinds", () => {
    expect(tools.ASK_USER_EVENT_TYPE).toBe("ask_user");
    expect(tools.IMAGE_CREDIT_COST).toEqual({ draft: 1, final: 2 });
    expect(tools.TOOLS.template_fill).toBe("template_fill");
    expect(typeof tools.askUserArgsSchema).toBe("object");
    expect(typeof tools.zBounds).toBe("object");
    expect(typeof tools.buildDefaultToolRegistry).toBe("function");
    expect(typeof tools.computeFit).toBe("function");
  });
});

describe("W10-O barrel: type-only re-exports stay types (erased at runtime)", () => {
  it("import type names resolve and match their source modules", () => {
    // ToolMap is declared in the barrel itself; the other two ride the
    // `export type` blocks W10-O split out of the former mixed statements.
    expectTypeOf<ToolMap>().toEqualTypeOf<tools.ToolMap>();
    expectTypeOf<TemplateFillArgs>().toEqualTypeOf<
      import("../src/tools/template-fill.js").TemplateFillArgs
    >();
    expectTypeOf<tools.ResolvedTarget>().toEqualTypeOf<
      import("../src/tools/asset-place.js").ResolvedTarget
    >();
  });

  it("type-only imports are usable at runtime-safe positions", () => {
    // The parameter is a compile-time-only position: importing ToolMap as a
    // type must never surface a runtime binding of a type-only name (if it
    // did, CI typecheck fails — TS1205's regression surface).
    const pin = (_map: ToolMap | null): "null" | "map" => (_map === null ? "null" : "map");
    expect(pin(null)).toBe("null");
  });
});
