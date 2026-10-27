import { describe, expect, it } from "vitest";

import {
  SLASH_COMMANDS,
  SLASH_COMMAND_HELP,
  type SlashCommandName,
  isSlashDraft,
  parseSlashInput,
  unknownSlashHint,
} from "./slash-commands";

describe("parseSlashInput — known commands", () => {
  it.each(SLASH_COMMANDS)("parses bare /%s", (command: SlashCommandName) => {
    expect(parseSlashInput(`/${command}`)).toEqual({
      kind: "command",
      command,
      rest: "",
    });
  });

  it("keeps args after the command token as rest", () => {
    expect(parseSlashInput("/undo the last one")).toEqual({
      kind: "command",
      command: "undo",
      rest: "the last one",
    });
  });

  it("trims multi-word rest", () => {
    expect(parseSlashInput("/clear   now  ")).toEqual({
      kind: "command",
      command: "clear",
      rest: "now",
    });
  });
});

describe("parseSlashInput — unknown + text arms", () => {
  it("reports an unknown token", () => {
    expect(parseSlashInput("/foo")).toEqual({ kind: "unknown", token: "foo" });
  });

  it("reports a bare slash as unknown with an empty token (the command-menu case)", () => {
    expect(parseSlashInput("/")).toEqual({ kind: "unknown", token: "" });
  });

  it("treats mid-message slashes as plain text", () => {
    expect(parseSlashInput("save the /etc/hosts file")).toEqual({ kind: "text" });
    expect(parseSlashInput("hello /undo")).toEqual({ kind: "text" });
    expect(parseSlashInput("")).toEqual({ kind: "text" });
    expect(parseSlashInput("normal message")).toEqual({ kind: "text" });
  });

  it("does not treat a second-line slash as a command", () => {
    expect(parseSlashInput("note:\n/undo")).toEqual({ kind: "text" });
  });
});

describe("isSlashDraft", () => {
  it("is true while the first line starts with a slash", () => {
    expect(isSlashDraft("/")).toBe(true);
    expect(isSlashDraft("/un")).toBe(true);
    expect(isSlashDraft("/undo now")).toBe(true);
  });

  it("is false for ordinary drafts", () => {
    expect(isSlashDraft("")).toBe(false);
    expect(isSlashDraft("make it pop /undo")).toBe(false);
    expect(isSlashDraft("line one\n/undo")).toBe(false);
  });
});

describe("help + hint copy", () => {
  it("documents every command", () => {
    for (const command of SLASH_COMMANDS) {
      expect(SLASH_COMMAND_HELP[command].length).toBeGreaterThan(0);
    }
  });

  it("the unknown hint names the attempted token and lists the set", () => {
    expect(unknownSlashHint("foo")).toContain("/foo");
    expect(unknownSlashHint("foo")).toContain("/undo");
    expect(unknownSlashHint("")).toContain("Unknown command /");
  });
});
