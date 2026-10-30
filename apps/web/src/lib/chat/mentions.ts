/**
 * @-mention parsing for the chat composer (ROUND 12 "Chat UI v3",
 * docs/research/round12-design.md "@-mentions: @layer @comp resolved client-side").
 *
 * PURE module — no React, no DOM, never throws. The composer detects the
 * mention segment at the caret (`detectMentionAtCaret`), filters the
 * candidate list (`filterMentionItems`) and inserts the picked item as
 * PLAIN TEXT (`insertMention`) — an inserted mention is just `@Name ` in
 * the draft; no special token ever reaches the wire.
 *
 * Segment rules (mainstream chat semantics):
 * - the trigger "@" must sit at the start of the draft or right after
 *   whitespace (an email address mid-word never opens a mention);
 * - the query runs from the trigger to the caret and terminates at the
 *   first whitespace or another "@" — typing past a space closes the
 *   popup (labels WITH spaces still insert; users pick them by click);
 * - a newline always closes the segment.
 */

export interface MentionItem {
  /** Stable id (engine layer id / comp name) — display only after insert. */
  readonly id: string;
  /** The inserted label (`@label `), e.g. a layer or comp name. */
  readonly label: string;
  readonly kind: "layer" | "comp";
}

export interface MentionQuery {
  /** The typed query after "@" (may be ""). */
  readonly query: string;
  /** Index of the "@" trigger inside the draft. */
  readonly startIndex: number;
}

/** Upper bound of rendered suggestions (bounded UI, cheap filter). */
export const MENTION_SUGGESTION_LIMIT = 8;

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * The active mention segment at the caret, or null when the caret is not
 * inside one. Scans back from `caret` to the nearest "@": the scan fails
 * (null) on whitespace (the segment was closed) or on crossing a second
 * "@". The "@" itself must be preceded by start-of-draft or whitespace —
 * `see @text` never opens a popup mid-word... precisely: `word@query` has
 * no trigger because the "@" is glued to a word.
 */
export function detectMentionAtCaret(value: string, caret: number): MentionQuery | null {
  const clamped = Math.min(Math.max(caret, 0), value.length);
  let index = clamped;
  while (index > 0) {
    const prev = value[index - 1];
    if (prev === "@") {
      const at = index - 1;
      const before = at > 0 ? value[at - 1] : undefined;
      if (before !== undefined && !isWhitespace(before)) return null; // glued: word@x
      return { query: value.slice(at + 1, clamped), startIndex: at };
    }
    if (prev === undefined || isWhitespace(prev)) return null; // segment closed
    index -= 1;
  }
  return null;
}

/** Case-insensitive substring match, bounded to the suggestion limit. */
export function filterMentionItems(
  items: readonly MentionItem[],
  query: string,
  limit: number = MENTION_SUGGESTION_LIMIT,
): readonly MentionItem[] {
  const needle = query.trim().toLowerCase();
  const out: MentionItem[] = [];
  for (const item of items) {
    if (needle !== "" && !item.label.toLowerCase().includes(needle)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Insert one picked mention at the caret: the segment
 * `[startIndex, caret)` becomes `@label ` and the caret lands after the
 * trailing space, ready for the next word. Pure — returns the next draft.
 */
export function insertMention(
  value: string,
  caret: number,
  item: MentionItem,
): { value: string; caret: number } {
  const clamped = Math.min(Math.max(caret, 0), value.length);
  const segment = value.slice(0, clamped);
  const at = segment.lastIndexOf("@");
  const startIndex = at >= 0 ? at : clamped;
  const label = item.label.trim();
  const inserted = label === "" ? "@" : `@${label}`;
  const next = `${value.slice(0, startIndex)}${inserted} ${value.slice(clamped)}`;
  return { value: next, caret: startIndex + inserted.length + 1 };
}
