/**
 * Slash-command parsing for the chat composer (ROUND 12 "Chat UI v3",
 * docs/research/round12-design.md "Slash commands: /undo /redo /save /checkpoint
 * /clear /reset-panel").
 *
 * PURE module — no React, no DOM, never throws. The composer consumes the
 * parser at send time; the slot maps the parsed command onto the EXISTING
 * gestures (undo/reapply via the controller, geometry reset via the layout
 * store, fresh chat via newThread). An unknown leading slash NEVER reaches
 * the model: the composer surfaces a hint chip and keeps the draft.
 *
 * Command semantics (all client-local, none hit the wire):
 * - undo        — undo the newest APPLIED agent run (the ⌘⇧U gesture).
 * - redo        — re-apply the newest UNDONE run (the plan card's Reapply).
 * - save        — honest notice: autosave (D-6) already covers the project.
 * - checkpoint — honest notice: applies checkpoint (one batch = one version).
 * - clear       — start a fresh chat (drops the visible transcript).
 * - reset-panel — reset the panel geometry (the header's Reset position).
 */

/** The pinned round-12 command set, in menu order. */
export const SLASH_COMMANDS = [
  "undo",
  "redo",
  "save",
  "checkpoint",
  "clear",
  "reset-panel",
] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(SLASH_COMMANDS);

/**
 * One parsed composer draft. `text` = a normal message (send it);
 * `command` = a known slash command (execute it, `rest` = args after the
 * command token); `unknown` = a leading slash that matches nothing (surface
 * the hint chip, never send).
 */
export type SlashParse =
  | { readonly kind: "command"; readonly command: SlashCommandName; readonly rest: string }
  | { readonly kind: "unknown"; readonly token: string }
  | { readonly kind: "text" };

/** One-line help for the hint chip / command menu. */
export const SLASH_COMMAND_HELP: Readonly<Record<SlashCommandName, string>> = {
  undo: "Undo the newest applied edit",
  redo: "Re-apply the newest undone edit",
  save: "Save now (autosave has you covered)",
  checkpoint: "Checkpoint — every applied plan makes one",
  clear: "Clear the conversation — start a fresh chat",
  "reset-panel": "Reset the panel position and size",
};

/** The hint chip copy for an unknown leading slash. */
export function unknownSlashHint(token: string): string {
  const shown = token === "" ? "/" : `/${token}`;
  return `Unknown command ${shown} — try /undo /redo /save /checkpoint /clear /reset-panel`;
}

/**
 * Parse a composer draft. A command must start with "/" at character 0
 * (a "/" mid-message is plain text, matching every mainstream chat); the
 * token runs to the first whitespace. `/undo extra words` parses as the
 * `undo` command with `rest = "extra words"` (today no command consumes
 * args, but the shape is honest).
 */
export function parseSlashInput(text: string): SlashParse {
  if (!text.startsWith("/")) return { kind: "text" };
  const match = /^\/([^\s]*)([\s\S]*)$/.exec(text);
  if (match === null) return { kind: "text" };
  const token = match[1] ?? "";
  const rest = (match[2] ?? "").trim();
  if (COMMAND_SET.has(token)) {
    return { kind: "command", command: token as SlashCommandName, rest };
  }
  return { kind: "unknown", token };
}

/**
 * True when the draft's FIRST LINE starts a slash (known or not) — the
 * composer shows the command-hint affordance while the user types, before
 * send. A "/" anywhere else is ordinary text.
 */
export function isSlashDraft(text: string): boolean {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.startsWith("/");
}
