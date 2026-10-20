// registry.test.ts — registry bookkeeping: duplicates, unknown lookups, planner listings.

import { describe, expect, it } from "vitest";
import { echoTool } from "../src/example/echo.js";
import { defineTool, isToolName, ok, parseToolArgs, strictObject } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import type { AnyTool } from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

const goodDescription = "A tool used only by unit tests to verify registry bookkeeping.";

/** A second, distinct tool so duplicate/lookup tests are meaningful. */
const probeTool: AnyTool = defineTool({
  name: "probe_tool",
  description: goodDescription,
  args: strictObject({}),
  run: async () => ok({ summary: "probed" }),
});

/** A hand-rolled tool that skips defineTool — the registry must reject it. */
const brokenTool: AnyTool = {
  name: "broken_tool",
  description: "Hand-rolled tool that carries no Zod schema.",
  args: { safeParse: () => null } as unknown as AnyTool["args"],
  run: (async () => ({ ok: true, summary: "unvalidated" })) as unknown as AnyTool["run"],
};

describe("TOOLS — the §6 surface, pinned as a const object", () => {
  it("keys equal values and every name is snake_case", () => {
    for (const [key, value] of Object.entries(TOOLS)) {
      expect(value).toBe(key);
      expect(isToolName(value)).toBe(true);
    }
  });

  it("contains the §6 table plus the model-orchestrated tools", () => {
    for (const name of [
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
      "component_list",
      "component_place",
      "component_set_vars",
      "render_preview",
      "validate_document",
      "vision_critique",
      "variant_create",
      "export_document",
      // §6 intro: model-orchestrated, no engine call.
      "brief_to_plan",
      "ask_user",
    ]) {
      expect(Object.keys(TOOLS)).toContain(name);
    }
    expect(Object.keys(TOOLS)).toHaveLength(22);
  });
});

describe("ToolRegistry.register", () => {
  it("accepts a defineTool-built tool and stores it under its name", () => {
    const registry = new ToolRegistry();
    const outcome = registry.register(echoTool);
    expect(outcome.ok).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.get("echo").ok).toBe(true);
  });

  it("rejects duplicate names, keeping the first registration (§6)", () => {
    const registry = new ToolRegistry();
    expect(registry.register(probeTool).ok).toBe(true);
    const outcome = registry.register(probeTool);
    expect(outcome).toEqual({
      ok: false,
      code: "duplicate_tool",
      message: 'Tool "probe_tool" is already registered',
      hint: "One name maps to exactly one implementation (§6).",
      retryable: false,
    });
    expect(registry.size()).toBe(1);
  });

  it("rejects malformed names with an invalid_tool_name envelope", () => {
    const registry = new ToolRegistry();
    const bad = { ...probeTool, name: "Not Snake Case" } as AnyTool;
    const outcome = registry.register(bad);
    expect(outcome).toMatchObject({ ok: false, code: "invalid_tool_name" });
    expect(registry.size()).toBe(0);
  });

  it("rejects hand-rolled tools without a Zod schema (internal_error envelope)", () => {
    const registry = new ToolRegistry();
    const outcome = registry.register(brokenTool);
    expect(outcome).toMatchObject({ ok: false, code: "internal_error" });
    expect(registry.size()).toBe(0);
  });

  it("pins the surface when allowedNames is set — invented names are refused", () => {
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(echoTool)).toMatchObject({
      ok: false,
      code: "invalid_tool_name",
      message: 'Tool "echo" is not part of the pinned tool surface',
    });
    expect(registry.size()).toBe(0);

    const echoOnly = new ToolRegistry({ allowedNames: ["echo"] });
    expect(echoOnly.register(echoTool).ok).toBe(true);
  });
});

describe("ToolRegistry.get", () => {
  it("returns the exact tool object it registered", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const lookup = registry.get("echo");
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.tool).toBe(echoTool);
    }
  });

  it("returns unknown_tool with the allowed list for missing names", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    registry.register(probeTool);
    const lookup = registry.get("template_fill");
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.code).toBe("unknown_tool");
      expect(lookup.message).toContain("template_fill");
      expect(lookup.hint).toContain("Available tools: echo, probe_tool");
      expect(lookup.allowed).toEqual(["echo", "probe_tool"]);
      expect(Object.isFrozen(lookup.allowed)).toBe(true);
      expect(lookup.retryable).toBe(false);
    }
  });

  it("explains an empty registry without hinting at hidden names", () => {
    const lookup = new ToolRegistry().get("anything");
    expect(lookup).toMatchObject({
      ok: false,
      code: "unknown_tool",
      hint: "No tools are registered yet.",
      allowed: [],
    });
  });
});

describe("ToolRegistry.list / names / promptBlock — planner context (§6.1)", () => {
  it("lists name + description only — never schemas or run functions", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    registry.register(probeTool);
    const listings = registry.list();
    expect(listings.length).toBe(2);
    for (const listing of listings) {
      expect(Object.keys(listing).sort()).toEqual(["description", "name"]);
      expect(typeof listing.description).toBe("string");
      expect(Object.isFrozen(listing)).toBe(true);
    }
    expect(Object.isFrozen(listings)).toBe(true);
    expect(registry.names()).toEqual(["echo", "probe_tool"]);
  });

  it("formats a compact planner block: name — description", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const block = registry.promptBlock();
    expect(block.startsWith("echo — ")).toBe(true);
    expect(block).toContain(echoTool.description);
    expect(block).not.toContain("strictObject"); // no schema text in prompts
  });
});

describe("registry → executor round trip (§6 contract, end to end)", () => {
  it("get → parseToolArgs → run with the injected ctx", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const lookup = registry.get("echo");
    if (!lookup.ok) {
      throw new Error("echo should be registered");
    }
    const parsed = parseToolArgs(lookup.tool, { message: "hi" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const result = await lookup.tool.run(makeFakeContext(), parsed.args, freshSignal());
    expect(result).toEqual({ ok: true, summary: "hi" });
  });
});
