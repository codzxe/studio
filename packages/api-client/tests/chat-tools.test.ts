import { describe, expect, it } from "vitest";

import {
  CLIENT_TOOL_IDS,
  isClientTool,
  isKnownTool,
  isWriteTool,
  toolDefinition,
  validateToolArgs,
} from "../src/chat-tools";

const ALL_TOOL_IDS = [
  "studio.get_context",
  "studio.list_layers",
  "studio.get_properties",
  "studio.plan_edit",
  "studio.render_preview",
  "studio.create_composition",
  "studio.create_text",
  "studio.set_properties",
  "studio.add_effect",
  "studio.set_keyframes",
  "studio.apply_preset",
  "studio.undo_run",
  "studio.save_version",
] as const;

const WRITE_TOOL_IDS = [
  "studio.create_composition",
  "studio.create_text",
  "studio.set_properties",
  "studio.add_effect",
  "studio.set_keyframes",
  "studio.apply_preset",
  "studio.undo_run",
  "studio.save_version",
] as const;

describe("chat-tools catalog lookups", () => {
  it("knows all 13 curated §8.4 tools", () => {
    for (const id of ALL_TOOL_IDS) {
      expect(isKnownTool(id)).toBe(true);
    }
    expect(isKnownTool("studio.nope")).toBe(false);
    expect(isKnownTool("engine.execute")).toBe(false);
    expect(isKnownTool("")).toBe(false);
  });

  it("exposes the tool definition or null (never a fallback)", () => {
    const def = toolDefinition("studio.list_layers");
    expect(def).not.toBeNull();
    expect(def?.kind).toBe("read");
    expect(def?.id).toBe("studio.list_layers");
    expect(toolDefinition("studio.plan_edit")?.returns).toBe("data");
    expect(toolDefinition("studio.set_properties")?.returns).toBe("proposed-batch");
    expect(toolDefinition("studio.nope")).toBeNull();
  });

  it("detects the 4 client tools exactly", () => {
    expect([...CLIENT_TOOL_IDS]).toEqual([
      "studio.get_context",
      "studio.list_layers",
      "studio.get_properties",
      "studio.render_preview",
    ]);
    for (const id of CLIENT_TOOL_IDS) expect(isClientTool(id)).toBe(true);
    // plan_edit is SERVER-side; write tools are not client tools.
    expect(isClientTool("studio.plan_edit")).toBe(false);
    expect(isClientTool("studio.create_text")).toBe(false);
    expect(isClientTool("studio.nope")).toBe(false);
  });

  it("detects write tools (proposal-only, §8.4 rule 1)", () => {
    for (const id of WRITE_TOOL_IDS) expect(isWriteTool(id)).toBe(true);
    for (const id of ALL_TOOL_IDS) {
      if (!(WRITE_TOOL_IDS as readonly string[]).includes(id)) {
        expect(isWriteTool(id)).toBe(false);
      }
    }
    // Unknown tools are not write tools — the defensive TOOL_FORBIDDEN path
    // only triggers for registered write tools.
    expect(isWriteTool("studio.nope")).toBe(false);
  });
});

describe("chat-tools validateToolArgs — client tools (valid)", () => {
  it("studio.get_context: {} and include lists pass; unknown keys are stripped", () => {
    const empty = validateToolArgs("studio.get_context", {});
    expect(empty).toEqual({ ok: true, value: {} });

    const withInclude = validateToolArgs("studio.get_context", {
      include: ["projectSummary", "selection"],
    });
    expect(withInclude).toEqual({ ok: true, value: { include: ["projectSummary", "selection"] } });

    // MockRunner emits a legacy `blocks` key — the non-strict schema strips it.
    const legacy = validateToolArgs("studio.get_context", { blocks: ["selection"] });
    expect(legacy).toEqual({ ok: true, value: {} });
  });

  it("studio.list_layers: applies the depth default and keeps compId", () => {
    expect(validateToolArgs("studio.list_layers", {})).toEqual({ ok: true, value: { depth: 2 } });
    expect(validateToolArgs("studio.list_layers", { compId: "Main", depth: 8 })).toEqual({
      ok: true,
      value: { compId: "Main", depth: 8 },
    });
    expect(validateToolArgs("studio.list_layers", { compId: "3" })).toEqual({
      ok: true,
      value: { compId: "3", depth: 2 },
    });
  });

  it("studio.get_properties: accepts 1..12 layerIds and optional paths", () => {
    const many = validateToolArgs("studio.get_properties", {
      layerIds: Array.from({ length: 12 }, (_, i) => `layer-${i + 1}`),
      paths: ["transform/opacity"],
    });
    expect(many.ok).toBe(true);
    if (many.ok) {
      expect((many.value as { layerIds: string[] }).layerIds).toHaveLength(12);
    }

    expect(validateToolArgs("studio.get_properties", { layerIds: ["1"] })).toEqual({
      ok: true,
      value: { layerIds: ["1"] },
    });
  });

  it("studio.render_preview: applies the maxWidth default and caps", () => {
    expect(validateToolArgs("studio.render_preview", {})).toEqual({
      ok: true,
      value: { maxWidth: 1200 },
    });
    expect(
      validateToolArgs("studio.render_preview", { compId: "Main", timeSeconds: 1.5, maxWidth: 800 }),
    ).toEqual({ ok: true, value: { compId: "Main", timeSeconds: 1.5, maxWidth: 800 } });
    expect(validateToolArgs("studio.render_preview", { maxWidth: 1200 }).ok).toBe(true);
  });
});

describe("chat-tools validateToolArgs — invalid args (zod-style first issue)", () => {
  it("studio.get_context: rejects bad block names and >9 includes", () => {
    const badBlock = validateToolArgs("studio.get_context", { include: ["selection", "nonsense"] });
    expect(badBlock.ok).toBe(false);
    if (!badBlock.ok) {
      expect(badBlock.error).toContain("include");
      expect(badBlock.error.length).toBeGreaterThan(0);
    }

    const tooMany = validateToolArgs("studio.get_context", {
      include: [
        "projectSummary",
        "activeComp",
        "selection",
        "playhead",
        "focusedPanel",
        "selectedProperties",
        "currentFrame",
        "recentCommands",
        "comments",
        "projectSummary",
      ],
    });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.ok ? "" : tooMany.error).toContain("include");
  });

  it("studio.list_layers: rejects depth out of range and non-numbers", () => {
    expect(validateToolArgs("studio.list_layers", { depth: 9 }).ok).toBe(false);
    expect(validateToolArgs("studio.list_layers", { depth: 0 }).ok).toBe(false);
    expect(validateToolArgs("studio.list_layers", { depth: "3" }).ok).toBe(false);
    const depthError = validateToolArgs("studio.list_layers", { depth: 9 });
    expect(depthError.ok ? "" : depthError.error).toContain("depth");
  });

  it("studio.get_properties: rejects empty and >12 layerIds", () => {
    expect(validateToolArgs("studio.get_properties", { layerIds: [] }).ok).toBe(false);
    expect(
      validateToolArgs("studio.get_properties", { layerIds: Array.from({ length: 13 }, (_, i) => String(i)) }).ok,
    ).toBe(false);
    expect(validateToolArgs("studio.get_properties", {}).ok).toBe(false);
    expect(validateToolArgs("studio.get_properties", { layerIds: ["1"], paths: ["a", ""] }).ok).toBe(
      false,
    );
  });

  it("studio.render_preview: rejects maxWidth out of range and negative times", () => {
    expect(validateToolArgs("studio.render_preview", { maxWidth: 1201 }).ok).toBe(false);
    expect(validateToolArgs("studio.render_preview", { maxWidth: 8 }).ok).toBe(false);
    expect(validateToolArgs("studio.render_preview", { maxWidth: 800.5 }).ok).toBe(false);
    expect(validateToolArgs("studio.render_preview", { timeSeconds: -1 }).ok).toBe(false);
  });
});

describe("chat-tools validateToolArgs — unknown + server tools", () => {
  it("unknown tools never validate", () => {
    for (const name of ["studio.nope", "engine.execute", ""]) {
      const result = validateToolArgs(name, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Unknown tool");
    }
  });

  it("server-side tools still validate their args (runner parity)", () => {
    const plan = validateToolArgs("studio.plan_edit", { goal: "Rename the title layer" });
    expect(plan.ok).toBe(true);
    expect(validateToolArgs("studio.plan_edit", {}).ok).toBe(false);
    expect(validateToolArgs("studio.plan_edit", { goal: "" }).ok).toBe(false);
  });

  it("non-object args fail with a zod-style error, not a throw", () => {
    const cases: readonly unknown[] = [null, undefined, 42, "args", []];
    for (const args of cases) {
      const result = validateToolArgs("studio.get_context", args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.error).toBe("string");
    }
  });
});
