// tests/drift-check.test.ts — the CI drift alarm (spec §21 Contract row: "detect upstream
// drift in CI").
//
// What is pinned, and where the pins come from:
//   - fixtures/replies/engine-commands.json — a recorded-style excerpt of the
//     `engine.commands` registry reply, hand-verified against
//     vendor/photocraft/crates/engine/src/commands.rs at the pinned engine revision (872748fb…).
//   - REQUIRED_COMMANDS — the §2.2 "verified agent-ready" subset the product relies on.
//     When src/commands.ts (W2-L) lands, this file imports its REQUIRED_COMMANDS instead of
//     the local list (auto-detected); the local list below is the fallback and matches the
//     fixture excerpt one-to-one. TODO(W2-L): land src/commands.ts with REQUIRED_COMMANDS
//     and delete the local copy in the same change.
//   - fixtures/replies/methods.json — the frozen headless METHODS list from
//     vendor/photocraft/crates/automation/src/rpc.rs, order included.
//
// When this test fails: the engine's command registry or RPC surface changed upstream.
// Re-record the fixture(s) against the new pinned revision, update the pins here, and
// reconcile with the owners named above — do not weaken the assertion to get CI green.

import { describe, expect, it } from "vitest";
import {
  METHODS_PIN,
  REQUIRED_METHODS,
  commandListResultSchema,
  type CommandEntry,
} from "./protocol-schemas.js";

/**
 * §2.2 starter-set subset exercised by the fixture excerpt (all twelve ids are verified
 * against the registry: commands.rs for file.new, edit.* and layer.*, select.rect;
 * type_cmds.rs for type.create; filters.rs for filter.blur.gaussianBlur).
 * The full §2.2 list is larger; these are the commands the fixtures pin shape-for-shape.
 */
const LOCAL_REQUIRED_COMMANDS: readonly string[] = [
  "file.new",
  "edit.undo",
  "edit.fill",
  "select.rect",
  "layer.new.layer",
  "layer.new.group",
  "layer.select",
  "layer.setProps",
  "layer.layerMask.revealAll",
  "type.create",
  "paint.stroke",
  "filter.blur.gaussianBlur",
];

/** Load src/commands.ts (W2-L) once it exists; null while it is absent. */
async function tryLoadExternalRequiredCommands(): Promise<readonly string[] | null> {
  try {
    const mod = (await import("../src/commands" + ".js")) as { REQUIRED_COMMANDS?: unknown };
    if (
      Array.isArray(mod.REQUIRED_COMMANDS) &&
      mod.REQUIRED_COMMANDS.every((id): id is string => typeof id === "string")
    ) {
      return mod.REQUIRED_COMMANDS;
    }
    return null;
  } catch {
    // Module not authored yet — the local §2.2 subset is the contract for now.
    return null;
  }
}

const externalRequiredCommands: readonly string[] | null = await tryLoadExternalRequiredCommands();

/** REQUIRED_COMMANDS is W2-L's src/commands.ts list once available; local fallback otherwise. */
const REQUIRED_COMMANDS: readonly string[] = externalRequiredCommands ?? LOCAL_REQUIRED_COMMANDS;

interface CommandsFixture {
  $comment?: string | string[];
  request: Record<string, unknown>;
  reply: Record<string, unknown>;
}

async function loadCommandListFixture(): Promise<CommandEntry[]> {
  const fixtureName = "engine-commands";
  const mod = (await import(`../fixtures/replies/${fixtureName}.json`)) as {
    default: CommandsFixture;
  };
  const result: unknown = mod.default.reply.result;
  // The #3684 pin: a bare array of command objects (never {"commands": [...]}).
  return commandListResultSchema.parse(result);
}

describe("upstream drift alarm (§21)", () => {
  it("every REQUIRED_COMMANDS id exists in the recorded registry fixture", async () => {
    const commands = await loadCommandListFixture();
    const recordedIds = new Set(commands.map((command) => command.id));

    const missing = REQUIRED_COMMANDS.filter((id) => !recordedIds.has(id));
    expect(
      missing,
      missing.length > 0
        ? `upstream drift: the pinned engine registry no longer serves ${missing.join(", ")}. ` +
          "Re-record fixtures/replies/engine-commands.json against the new revision and " +
          "reconcile REQUIRED_COMMANDS with §2.2 (src/commands.ts owner: W2-L)."
        : "",
    ).toEqual([]);
  });

  it("the local §2.2 subset stays covered even when src/commands.ts provides the list", async () => {
    // Guards the W2-L hand-off: their REQUIRED_COMMANDS may grow, but dropping a fixture-pinned
    // command must be a loud reconciliation, not a silent pass.
    const commands = await loadCommandListFixture();
    const recordedIds = new Set(commands.map((command) => command.id));
    const missing = LOCAL_REQUIRED_COMMANDS.filter((id) => !recordedIds.has(id));
    expect(missing).toEqual([]);
    if (externalRequiredCommands !== null) {
      const dropped = LOCAL_REQUIRED_COMMANDS.filter((id) => !externalRequiredCommands.includes(id));
      expect(dropped, "src/commands.ts dropped a §2.2-pinned command").toEqual([]);
    }
  });

  it("registry entries keep the exact pinned key set (rpc.rs #3684 shape test)", async () => {
    const commands = await loadCommandListFixture();
    for (const command of commands) {
      const keys = Object.keys(command).sort();
      const expected = keys.includes("keywords")
        ? ["disabledReason", "enabled", "id", "keywords", "label", "menu", "needsDocument", "params", "shortcut"]
        : ["disabledReason", "enabled", "id", "label", "menu", "needsDocument", "params", "shortcut"];
      expect(keys, command.id).toEqual(expected);
    }
  });

  it("the frozen headless METHODS surface is unchanged (rpc.rs)", async () => {
    const fixtureName = "methods";
    const mod = (await import(`../fixtures/replies/${fixtureName}.json`)) as {
      default: CommandsFixture;
    };
    const methods: unknown = mod.default.reply.result;
    expect(methods).toEqual([...METHODS_PIN]);

    const listed = new Set(methods as string[]);
    const missingMethods = REQUIRED_METHODS.filter((method) => !listed.has(method));
    expect(
      missingMethods,
      missingMethods.length > 0
        ? `upstream drift: the headless server no longer lists ${missingMethods.join(", ")}. ` +
          "Re-record fixtures/replies/methods.json and update METHODS_PIN in tests/protocol-schemas.ts."
        : "",
    ).toEqual([]);
  });
});
