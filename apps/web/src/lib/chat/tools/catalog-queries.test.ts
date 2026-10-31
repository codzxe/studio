/**
 * catalog-queries tests (w8 harness fix) — the read-only engine query tier.
 *
 * The pins that closed the user's recurring loop:
 *   * `"anim.builtinPresets" is not an allowed command id. Discover ids with
 *     studio.list_commands.` fired FOREVER: list_commands filtered to the
 *     ALLOWED (batchable) list, so it could never surface the read-only
 *     `query!` ids the params docs kept pointing at — a dead end by design.
 *   * describe_command now ANSWERS for those ids (readOnly: true) instead of
 *     the typed refusal; genuinely UNKNOWN ids keep the fail-closed refusal.
 *
 * Deterministic: a stubbed bridge (local fallback path) + a wrapped fake
 * bridge whose command.describe answers for anim.builtinPresets. No network.
 */

import type { EditorBridge } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";

import { runDescribeCommand, runListCommands } from "./catalog-queries";

/** A bridge whose `command.list` query ALWAYS fails (an old engine dist). */
function deadRegistryBridge(): EditorBridge {
  const inner = attachFakeBridge(createFakeEditor({ comps: [{ name: "Main" }] }));
  return {
    ...inner,
    query: <T>(id: string) => {
      if (id === "command.list") return Promise.reject(new Error("no such query id"));
      return inner.query<T>(id, {});
    },
  };
}

/**
 * The fake bridge, wrapped so `command.describe` answers for
 * anim.builtinPresets (the fake engine does not register it — the wrap proves
 * the tool passes KNOWN read queries straight through to the live engine).
 */
function presetsBridge(answerFor: readonly string[] = ["anim.builtinPresets"]): EditorBridge {
  const inner = attachFakeBridge(createFakeEditor({ comps: [{ name: "Main" }] }));
  return {
    ...inner,
    query: <T>(id: string, params?: unknown) => {
      if (id === "command.describe") {
        const command =
          typeof params === "object" && params !== null
            ? (params as { command?: unknown }).command
            : undefined;
        if (typeof command === "string" && answerFor.includes(command)) {
          return Promise.resolve({
            id: command,
            label: "Built-in Animation Presets",
            params: "{category? (Backgrounds, Text Animators, Transitions)}",
            undoable: false,
            enabled: true,
            why: null,
          } as unknown as T);
        }
      }
      return inner.query<T>(id, params);
    },
  };
}

describe("studio.list_commands (w8 read-query tier)", () => {
  it("includes a readQueries group in the LOCAL fallback (old dists surface them too)", async () => {
    const result = await runListCommands({}, deadRegistryBridge());
    expect(result.source).toBe("local");
    const flat = (result.readQueries ?? []).flatMap((group) =>
      group.commands.map((row) => row.id),
    );
    // The ids the params docs reference are all there now.
    expect(flat).toContain("anim.builtinPresets");
    expect(flat).toContain("text.presets");
    expect(flat).toContain("comp.presets");
    expect(flat).toContain("comp.info");
    // They never leak into the batchable categories.
    const batchable = result.categories.flatMap((group) => group.commands.map((row) => row.id));
    expect(batchable).not.toContain("anim.builtinPresets");
  });

  it("a category filter narrows the readQueries list consistently", async () => {
    const anim = await runListCommands({ category: "anim" }, deadRegistryBridge());
    expect((anim.readQueries ?? []).flatMap((g) => g.commands.map((r) => r.id))).toEqual([
      "anim.builtinPresets",
    ]);
    const none = await runListCommands({ category: "no-such" }, deadRegistryBridge());
    expect(none.categories).toHaveLength(0);
    expect(none.readQueries).toBeUndefined();
  });
});

describe("studio.describe_command (w8 read-query tier)", () => {
  it("ANSWERS for anim.builtinPresets with readOnly: true — never the dead-end refusal", async () => {
    const described = await runDescribeCommand(
      { command: "anim.builtinPresets" },
      presetsBridge(),
    );
    expect(described.command).toBe("anim.builtinPresets");
    expect(described.readOnly).toBe(true);
    expect(described.title).toBe("Built-in Animation Presets");
    expect(described.paramsDoc).toContain("Backgrounds");
    expect(described.undoable).toBe(false);
  });

  it("an UNKNOWN id keeps the typed UNKNOWN_COMMAND refusal — the gate fires FIRST", async () => {
    // The bridge would happily answer for the id (answerFor includes it);
    // the ALLOWED/read-query gate must reject it before any bridge call.
    const bridge = presetsBridge(["anim.builtinNonsense"]);
    await expect(
      runDescribeCommand({ command: "anim.builtinNonsense" }, bridge),
    ).rejects.toMatchObject({
      code: "UNKNOWN_COMMAND",
      message: expect.stringContaining("Discover ids with studio.list_commands"),
    });
  });

  it("a near-miss casing is refused by the GATE, not passed through to the bridge", async () => {
    // "anim.builtinpreset" (lowercase p) is neither allowed nor a known read
    // query. If the gate ever passed it through, the inner bridge would throw
    // unknown-command → TOOL_FAILED; the GATE must answer first with
    // UNKNOWN_COMMAND (exact ids only, fail-closed).
    const bridge = presetsBridge();
    await expect(runDescribeCommand({ command: "anim.builtinpreset" }, bridge)).rejects.toMatchObject({
      code: "UNKNOWN_COMMAND",
    });
  });
});
