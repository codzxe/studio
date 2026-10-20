// registry-defaults.test.ts — W5-R assembly checks: every shipped tool is
// registered under its §6 name (exact list), duplicate detection is active,
// the planner manifest leaks name + description only, echo + ask_user ride
// the same registry path, and the src/index.ts barrel re-exports everything.
//
// The pinned list below covers every tool file in src/tools/ at assembly time
// (13 §6 rows + ask_user) plus the `echo` reference tool. §6 rows whose Wave-5
// files have not landed yet are pinned as PENDING_S6_ROWS: when a sibling tool
// file lands, add it to registry-defaults.ts AND extend EXPECTED_DEFAULT_TOOLS
// here — these tests make the gap explicit instead of silently absent.

import { z } from "zod";
import { describe, expect, it } from "vitest";
import { echoTool } from "../src/example/echo.js";
import * as barrel from "../src/index.js";
import { isToolName, parseToolArgs } from "../src/kit.js";
import {
  DEFAULT_TOOL_MANIFEST,
  DEFAULT_TOOL_NAMES,
  TOOLS_DEFAULT,
  buildDefaultToolRegistry,
} from "../src/registry-defaults.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  ASK_USER_EVENT_TYPE,
  askUserPauseEvent,
  askUserTool,
  parseAskUserSummary,
  summarizeAskUser,
} from "../src/tools/ask-user.js";
import { assetPlaceTool } from "../src/tools/asset-place.js";
import { assetSearchTool } from "../src/tools/asset-search.js";
import { componentSetVarsTool } from "../src/tools/component-set-vars.js";
import { imageGenerateTool } from "../src/tools/image-generate.js";
import { layerOpsTool } from "../src/tools/layer-ops.js";
import { layoutApplyTool } from "../src/tools/layout-apply.js";
import { styleApplyTool } from "../src/tools/style-apply.js";
import { templateApplyTool } from "../src/tools/template-apply.js";
import { templateFillTool } from "../src/tools/template-fill.js";
import { templateInspect } from "../src/tools/template-inspect.js";
import { templateList } from "../src/tools/template-list.js";
import { textSet } from "../src/tools/text-set.js";
import { validateDocument } from "../src/tools/validate-document.js";
import { visionCritiqueTool } from "../src/tools/vision-critique.js";
import { workspaceSnapshot } from "../src/tools/workspace-snapshot.js";
import type { AnyTool } from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

/** §6 table order, then ask_user, then echo — the shipped default registry. */
const EXPECTED_DEFAULT_TOOLS: readonly string[] = [
  "workspace_snapshot",
  "template_list",
  "template_inspect",
  "template_apply",
  "template_fill",
  "asset_search",
  "asset_place",
  "image_generate",
  "text_set",
  "layer_ops",
  "style_apply",
  "layout_apply",
  "component_set_vars",
  "validate_document",
  "vision_critique",
  "ask_user",
  "echo",
];

/** §6 surface rows with NO shipped tool file yet — the explicit W5 gap. */
const PENDING_S6_ROWS: readonly string[] = [
  "brief_to_plan", // model-orchestrated; the planner wave owns its implementation
  "component_list",
  "component_place",
  "render_preview",
  "variant_create",
  "export_document",
];

/** name → exported tool const, proving EVERY tool file found is registered. */
const TOOL_CONSTS: readonly (readonly [string, AnyTool])[] = [
  ["workspace_snapshot", workspaceSnapshot],
  ["template_list", templateList],
  ["template_inspect", templateInspect],
  ["template_apply", templateApplyTool],
  ["template_fill", templateFillTool],
  ["asset_search", assetSearchTool],
  ["asset_place", assetPlaceTool],
  ["image_generate", imageGenerateTool],
  ["text_set", textSet],
  ["layer_ops", layerOpsTool],
  ["style_apply", styleApplyTool],
  ["layout_apply", layoutApplyTool],
  ["component_set_vars", componentSetVarsTool],
  ["validate_document", validateDocument],
  ["vision_critique", visionCritiqueTool],
  ["ask_user", askUserTool],
  ["echo", echoTool],
];

describe("buildDefaultToolRegistry — the shipped default registry", () => {
  it("registers exactly the shipped tool list, in §6 order, echo last", () => {
    const registry = buildDefaultToolRegistry();
    expect([...registry.names()]).toEqual(EXPECTED_DEFAULT_TOOLS);
    expect(registry.size()).toBe(EXPECTED_DEFAULT_TOOLS.length);
    expect([...DEFAULT_TOOL_NAMES]).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it("registers every exported tool const under its §6 name (no file skipped)", () => {
    expect(TOOL_CONSTS.length).toBe(EXPECTED_DEFAULT_TOOLS.length);
    for (const [name, tool] of TOOL_CONSTS) {
      const lookup = buildDefaultToolRegistry().get(name);
      expect(lookup.ok).toBe(true);
      if (lookup.ok) {
        expect(lookup.tool).toBe(tool);
        expect(TOOLS_DEFAULT[name]).toBe(tool);
      }
    }
  });

  it("has no duplicate names — duplicate detection stays active", () => {
    expect(new Set(DEFAULT_TOOL_NAMES).size).toBe(DEFAULT_TOOL_NAMES.length);
    const registry = buildDefaultToolRegistry();
    for (const name of DEFAULT_TOOL_NAMES) {
      const existing = TOOLS_DEFAULT[name];
      expect(existing).toBeDefined();
      if (existing === undefined) {
        continue;
      }
      const outcome = registry.register(existing);
      expect(outcome).toMatchObject({ ok: false, code: "duplicate_tool" });
    }
    expect(registry.size()).toBe(DEFAULT_TOOL_NAMES.length);
  });

  it("every registered tool satisfies the registry contract (§6/§6.1)", () => {
    for (const name of DEFAULT_TOOL_NAMES) {
      const lookup = buildDefaultToolRegistry().get(name);
      expect(lookup.ok).toBe(true);
      if (!lookup.ok) {
        continue;
      }
      const tool = lookup.tool;
      expect(isToolName(name)).toBe(true);
      expect(tool.args).toBeInstanceOf(z.ZodType);
      expect(typeof tool.run).toBe("function");
      expect(tool.description.trim().length).toBeGreaterThanOrEqual(10);
      expect(tool.description.length).toBeLessThanOrEqual(500);
      expect(name === "echo" || name in TOOLS).toBe(true);
    }
  });

  it("TOOLS_DEFAULT is a frozen dispatch map keyed by tool name", () => {
    expect(Object.isFrozen(TOOLS_DEFAULT)).toBe(true);
    expect(Object.keys(TOOLS_DEFAULT).sort()).toEqual(
      [...DEFAULT_TOOL_NAMES].sort(),
    );
  });

  it("includeEcho:false pins production registries to exactly the §6 surface", () => {
    const registry = buildDefaultToolRegistry({ includeEcho: false });
    const names = [...registry.names()];
    expect(names).toEqual(EXPECTED_DEFAULT_TOOLS.filter((name) => name !== "echo"));
    expect(names).toContain("ask_user");
    expect(registry.register(echoTool)).toMatchObject({
      ok: false,
      code: "invalid_tool_name",
      message: 'Tool "echo" is not part of the pinned tool surface',
    });
  });

  it("§6 rows without shipped tool files stay explicitly absent (W5 gap)", () => {
    for (const name of PENDING_S6_ROWS) {
      expect(name in TOOLS).toBe(true); // on the §6 surface, allowed by the pin…
      expect(DEFAULT_TOOL_NAMES).not.toContain(name); // …but no implementation yet
    }
  });
});

describe("DEFAULT_TOOL_MANIFEST — planner context (§6.1)", () => {
  it("carries name + description ONLY — never schemas or run functions", () => {
    expect(Object.isFrozen(DEFAULT_TOOL_MANIFEST)).toBe(true);
    expect(DEFAULT_TOOL_MANIFEST.map((entry) => entry.name)).toEqual([
      ...DEFAULT_TOOL_NAMES,
    ]);
    for (const entry of DEFAULT_TOOL_MANIFEST) {
      expect(Object.keys(entry).sort()).toEqual(["description", "name"]);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

describe("ask_user — registered and runnable as a client-side affordance", () => {
  it("is registered alongside echo in the default registry", () => {
    expect(TOOLS_DEFAULT[TOOLS.ask_user]).toBe(askUserTool);
    expect(TOOLS_DEFAULT.echo).toBe(echoTool);
  });

  it("returns the awaiting-user pause marker; the run manager emits the SSE", async () => {
    const lookup = buildDefaultToolRegistry().get(TOOLS.ask_user);
    if (!lookup.ok) {
      throw new Error("ask_user must be registered");
    }
    const parsed = parseToolArgs(lookup.tool, {
      question: "Which product should the hero feature?",
      options: ["Solar panel", "Battery pack"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const result = await lookup.tool.run(makeFakeContext(), parsed.args, freshSignal());
    expect(result.ok).toBe(true);
    const summary = parseAskUserSummary(result.ok ? result.summary : "");
    expect(summary).toEqual({
      awaitingUser: true,
      question: "Which product should the hero feature?",
      options: ["Solar panel", "Battery pack"],
    });
    if (summary === undefined) {
      throw new Error("ask_user summary must parse as a pause marker");
    }
    expect(askUserPauseEvent(summary)).toEqual({
      type: ASK_USER_EVENT_TYPE,
      question: "Which product should the hero feature?",
      options: ["Solar panel", "Battery pack"],
    });
  });

  it("rejects off-pin arguments (question ≤ 300, 1-4 options ≤ 120 each)", () => {
    const question300 = "q".repeat(300);
    const option120 = "o".repeat(120);
    for (const bad of [
      {},
      { question: "Missing options?" },
      { question: "Missing options?", options: [] },
      {
        question: "Too many?",
        options: ["a", "b", "c", "d", "e"],
      },
      { question: "q".repeat(301), options: ["a"] },
      { question: "Long option?", options: [option120, "x".repeat(121)] },
      { question: "Blank?", options: ["   "] },
      { question: "Extra key?", options: ["a"], note: "unknown property" },
    ]) {
      const parsed = parseToolArgs(askUserTool, bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.code).toBe("invalid_args");
      }
    }
    const good = parseToolArgs(askUserTool, {
      question: question300,
      options: [option120],
    });
    expect(good.ok).toBe(true);
  });

  it("parseAskUserSummary refuses foreign or malformed summaries", () => {
    expect(parseAskUserSummary(summarizeAskUser("Q?", ["a"]))).toEqual({
      awaitingUser: true,
      question: "Q?",
      options: ["a"],
    });
    expect(parseAskUserSummary("Filled 3 slots")).toBeUndefined();
    expect(parseAskUserSummary("not json at all")).toBeUndefined();
    expect(
      parseAskUserSummary('{"awaitingUser":false,"question":"Q?","options":["a"]}'),
    ).toBeUndefined();
    expect(
      parseAskUserSummary(
        '{"awaitingUser":true,"question":"Q?","options":["a","b","c","d","e"]}',
      ),
    ).toBeUndefined();
  });
});

describe("src/index.ts barrel — re-exports the full assembly", () => {
  it("re-exports the registry defaults and tool consts by identity", () => {
    expect(barrel.TOOLS_DEFAULT).toBe(TOOLS_DEFAULT);
    expect(barrel.DEFAULT_TOOL_MANIFEST).toBe(DEFAULT_TOOL_MANIFEST);
    expect(barrel.askUserTool).toBe(askUserTool);
    expect(barrel.echoTool).toBe(echoTool);
    expect(barrel.templateFillTool).toBe(templateFillTool);
    expect(barrel.layerOpsTool).toBe(layerOpsTool);
  });

  it("disambiguates the three cross-file name collisions under aliases", () => {
    const exportedNames = Object.keys(barrel);
    // ENGINE_PATCH_HINT (template-apply + layout-apply)
    expect(exportedNames).toContain("TEMPLATE_APPLY_ENGINE_PATCH_HINT");
    expect(exportedNames).toContain("LAYOUT_APPLY_ENGINE_PATCH_HINT");
    expect(exportedNames).not.toContain("ENGINE_PATCH_HINT");
    // MAX_QUERY_CHARS (asset-search + template-list)
    expect(exportedNames).toContain("ASSET_SEARCH_MAX_QUERY_CHARS");
    expect(exportedNames).toContain("TEMPLATE_LIST_MAX_QUERY_CHARS");
    expect(exportedNames).not.toContain("MAX_QUERY_CHARS");
    // ResolvedTarget (asset-place keeps the name; image-generate is aliased)
    expect(exportedNames).toContain("ResolvedTarget");
    expect(exportedNames).toContain("ImageGenerateResolvedTarget");
    expect(typeof barrel.LAYOUT_APPLY_ENGINE_PATCH_HINT).toBe("string");
  });
});

describe("registry composition sanity — default tools register on a fresh pin", () => {
  it("every TOOLS_DEFAULT value passes a strict §6-pinned registry", () => {
    const strict = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    for (const name of DEFAULT_TOOL_NAMES) {
      const tool = TOOLS_DEFAULT[name];
      expect(tool).toBeDefined();
      if (tool === undefined) {
        continue;
      }
      const outcome = strict.register(tool);
      if (name === "echo") {
        expect(outcome).toMatchObject({ ok: false, code: "invalid_tool_name" });
      } else {
        expect(outcome).toEqual({ ok: true });
      }
    }
  });
});
