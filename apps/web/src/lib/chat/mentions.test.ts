import { describe, expect, it } from "vitest";

import {
  type MentionItem,
  detectMentionAtCaret,
  filterMentionItems,
  insertMention,
} from "./mentions";

const HEADLINE: MentionItem = { id: "1", label: "Headline", kind: "layer" };
const HEADLINE_SHADOW: MentionItem = { id: "2", label: "Headline Shadow", kind: "layer" };
const BACKGROUND: MentionItem = { id: "3", label: "Background Solid", kind: "layer" };
const CAMERA: MentionItem = { id: "4", label: "Camera", kind: "layer" };
const MAIN_COMP: MentionItem = { id: "comp:Main", label: "Main", kind: "comp" };

const LAYERS: readonly MentionItem[] = [HEADLINE, HEADLINE_SHADOW, BACKGROUND, CAMERA, MAIN_COMP];

describe("detectMentionAtCaret", () => {
  it("detects a query after the trigger", () => {
    expect(detectMentionAtCaret("restyle @Head", 13)).toEqual({
      query: "Head",
      startIndex: 8,
    });
  });

  it("detects a bare trigger (empty query opens the full list)", () => {
    expect(detectMentionAtCaret("hello @", 7)).toEqual({ query: "", startIndex: 6 });
  });

  it("detects at the very start of the draft", () => {
    expect(detectMentionAtCaret("@Ca", 3)).toEqual({ query: "Ca", startIndex: 0 });
  });

  it("closes the segment at whitespace", () => {
    expect(detectMentionAtCaret("@Head line two", 14)).toBeNull();
    expect(detectMentionAtCaret("@Head\trest", 10)).toBeNull();
  });

  it("closes the segment at a newline", () => {
    expect(detectMentionAtCaret("@Head\nmore", 10)).toBeNull();
  });

  it("never fires for an @ glued to a word (emails)", () => {
    expect(detectMentionAtCaret("mail me a@b", 12)).toBeNull();
  });

  it("never fires without any @ before the caret", () => {
    expect(detectMentionAtCaret("plain text", 10)).toBeNull();
    expect(detectMentionAtCaret("", 0)).toBeNull();
  });

  it("clamps an out-of-range caret instead of throwing", () => {
    expect(detectMentionAtCaret("@Head", 99)).toEqual({ query: "Head", startIndex: 0 });
    // A caret before the trigger sees no segment — null, never a crash.
    expect(detectMentionAtCaret("@Head", -5)).toBeNull();
  });
});

describe("filterMentionItems", () => {
  it("returns the first items for an empty query, bounded to the limit", () => {
    const many: MentionItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      label: `Layer ${i}`,
      kind: "layer" as const,
    }));
    expect(filterMentionItems(many, "")).toHaveLength(8);
  });

  it("matches case-insensitively as a substring", () => {
    const matched = filterMentionItems(LAYERS, "head");
    expect(matched.map((item) => item.label)).toEqual(["Headline", "Headline Shadow"]);
  });

  it("matches nothing for a needle no label contains", () => {
    expect(filterMentionItems(LAYERS, "zzz")).toEqual([]);
  });
});

describe("insertMention", () => {
  it("replaces the typed segment with @label + trailing space", () => {
    expect(insertMention("restyle @Head now", 13, HEADLINE)).toEqual({
      value: "restyle @Headline  now",
      caret: 18,
    });
  });

  it("inserts at a bare trigger", () => {
    expect(insertMention("pick @", 6, MAIN_COMP)).toEqual({
      value: "pick @Main ",
      caret: 11,
    });
  });

  it("handles labels containing spaces", () => {
    expect(insertMention("@Head", 5, HEADLINE_SHADOW)).toEqual({
      value: "@Headline Shadow ",
      caret: 17,
    });
  });

  it("keeps text after the caret intact", () => {
    expect(insertMention("@He and more", 3, HEADLINE)).toEqual({
      value: "@Headline  and more",
      caret: 10,
    });
  });
});
