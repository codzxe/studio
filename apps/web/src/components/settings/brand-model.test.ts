// Table-driven tests for the pure brand-token editor model (W8-L).
// Deterministic, no network, no DOM — mirrors the fleet's model-test pattern
// (document-sizes.test.ts, timeline-state.test.ts).
//
// The mirrors under test MUST stay byte-compatible with the canonical contract
// in packages/agent/src/brand/tokens.ts (see brand-model.ts header) — a
// behaviour change here is a contract break there.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND,
  FONT_ROLES,
  MAX_FONT_NAME_CHARS,
  MAX_LOGO_ASSET_ID_CHARS,
  MAX_PALETTE_TOKENS,
  MAX_TONE_WORDS,
  brandTokensToDraft,
  canonicalBrandDraft,
  coerceBrandTokens,
  isDraftDirty,
  normalizeHex,
  validateBrandDraft,
  type BrandTokensDraft,
} from "./brand-model";

// ---------------------------------------------------------------------------
// normalizeHex — mirror of the agent's canonicalization
// ---------------------------------------------------------------------------

describe("normalizeHex", () => {
  it.each([
    ["#abc", "#AABBCC"],
    ["#ABC", "#AABBCC"],
    ["#a1B2c3", "#A1B2C3"],
    ["  #ffffff  ", "#FFFFFF"],
    ["#000000", "#000000"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });

  it.each([
    ["nope"],
    ["#abcd"],
    ["#12345"],
    ["#gggggg"],
    [""],
    ["#aabbccdd"],
    ["aabbcc"],
    ["##ffffff"],
  ])("%s → undefined (rejected)", (input) => {
    expect(normalizeHex(input)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// coerceBrandTokens — lenient wire → value (§7.5 drop-with-warning)
// ---------------------------------------------------------------------------

describe("coerceBrandTokens", () => {
  it("returns the default brand for absent/foreign values", () => {
    expect(coerceBrandTokens(undefined)).toEqual(DEFAULT_BRAND);
    expect(coerceBrandTokens(null)).toEqual(DEFAULT_BRAND);
    expect(coerceBrandTokens("brandish")).toEqual(DEFAULT_BRAND);
    expect(coerceBrandTokens(42)).toEqual(DEFAULT_BRAND);
  });

  it("keeps valid pieces, drops invalid ones, dedupes, caps", () => {
    const coerced = coerceBrandTokens({
      palette: ["#111111", "#111", "not-hex", "#222222", "#222222", 7],
      fonts: { display: "  Playfair Display  ", sans: "", mono: "x".repeat(MAX_FONT_NAME_CHARS + 1) },
      toneWords: [" bold ", "", "bold", "calm"],
      logoAssetId: "  asset-1  ",
      extraIgnored: true,
    });
    expect(coerced.palette).toEqual(["#111111", "#222222"]);
    expect(coerced.fonts).toEqual({ display: "Playfair Display" });
    expect(coerced.toneWords).toEqual(["bold", "calm"]);
    expect(coerced.logoAssetId).toBe("asset-1");
  });

  it("falls back to the default palette when nothing valid arrives", () => {
    const coerced = coerceBrandTokens({ palette: ["red", "#12345"], fonts: {} });
    expect(coerced.palette).toEqual(DEFAULT_BRAND.palette);
    expect(coerced.fonts).toEqual({});
  });

  it("caps palette and tone words at the contract limits", () => {
    const coerced = coerceBrandTokens({
      palette: Array.from({ length: 30 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`),
      toneWords: Array.from({ length: 30 }, (_, i) => `word-${i}`),
    });
    expect(coerced.palette).toHaveLength(MAX_PALETTE_TOKENS);
    expect(coerced.toneWords).toHaveLength(MAX_TONE_WORDS);
  });

  it("drops over-long logo ids", () => {
    expect(
      coerceBrandTokens({ logoAssetId: `a${"b".repeat(MAX_LOGO_ASSET_ID_CHARS)}` }).logoAssetId,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateBrandDraft + canonicalBrandDraft — the save gate
// ---------------------------------------------------------------------------

const emptyDraft: BrandTokensDraft = {
  palette: ["#123456"],
  fonts: { display: "", sans: "", serif: "", mono: "" },
  logoAssetId: "",
  toneWords: [],
};

describe("validateBrandDraft", () => {
  it("accepts the minimal valid draft", () => {
    expect(validateBrandDraft(emptyDraft).canSave).toBe(true);
  });

  it("flags invalid and duplicate palette rows at their index", () => {
    const validation = validateBrandDraft({
      ...emptyDraft,
      palette: ["#123456", "oops", "#123456"],
    });
    const messages = validation.problems.map((problem) => `${problem.field}:${problem.index}`);
    expect(messages).toContain("palette:1");
    expect(messages).toContain("palette:2");
    expect(validation.canSave).toBe(false);
  });

  it("rejects an empty palette", () => {
    const validation = validateBrandDraft({ ...emptyDraft, palette: [] });
    expect(validation.problems).toHaveLength(1);
    expect(validation.problems[0]?.message).toContain("at least one");
  });

  it("rejects over-long font names per role", () => {
    const validation = validateBrandDraft({
      ...emptyDraft,
      fonts: { display: "d".repeat(MAX_FONT_NAME_CHARS + 1), sans: "OK", serif: "", mono: "" },
    });
    expect(validation.problems).toHaveLength(1);
    expect(validation.problems[0]?.index).toBe("display");
  });

  it("rejects duplicate tone words case-insensitively and over cap", () => {
    expect(
      validateBrandDraft({ ...emptyDraft, toneWords: ["Bold", "bold"] }).canSave,
    ).toBe(false);
    expect(
      validateBrandDraft({
        ...emptyDraft,
        toneWords: Array.from({ length: MAX_TONE_WORDS + 1 }, (_, i) => `w${i}`),
      }).canSave,
    ).toBe(false);
  });

  it("treats empty tone-word rows as dropped, not errors", () => {
    expect(validateBrandDraft({ ...emptyDraft, toneWords: ["", "calm"] }).canSave).toBe(true);
  });
});

describe("canonicalBrandDraft", () => {
  it("normalizes the palette and omits unbound roles/empty optionals", () => {
    const result = canonicalBrandDraft({
      palette: ["#abc", "#123456"],
      fonts: { display: " Display ", sans: "Inter", serif: "", mono: "" },
      logoAssetId: "  ",
      toneWords: [" calm ", ""],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        palette: ["#AABBCC", "#123456"],
        fonts: { display: "Display", sans: "Inter" },
        toneWords: ["calm"],
      },
    });
  });

  it("round-trips through brandTokensToDraft + coerceBrandTokens byte-stably", () => {
    const seeded = coerceBrandTokens({
      palette: ["#111111", "#222222"],
      fonts: { sans: "Inter", mono: "JetBrains Mono" },
      logoAssetId: "logo-asset",
      toneWords: ["clean", "modern"],
    });
    const draft = brandTokensToDraft(seeded);
    const canonical = canonicalBrandDraft(draft);
    expect(canonical.ok).toBe(true);
    expect(canonical.ok && JSON.stringify(canonical.value)).toBe(JSON.stringify(seeded));
    expect(isDraftDirty(draft, seeded)).toBe(false);
  });

  it("refuses invalid drafts and returns the validation", () => {
    const result = canonicalBrandDraft({ ...emptyDraft, palette: ["nope"] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.validation.problems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Draft round-trip + dirty tracking
// ---------------------------------------------------------------------------

describe("isDraftDirty", () => {
  it("is clean for an untouched draft and dirty for edits", () => {
    const seeded = coerceBrandTokens(DEFAULT_BRAND);
    const draft = brandTokensToDraft(seeded);
    expect(isDraftDirty(draft, seeded)).toBe(false);
    expect(
      isDraftDirty({ ...draft, palette: [...draft.palette, "#0f0f0f"] }, seeded),
    ).toBe(true);
    expect(isDraftDirty({ ...draft, fonts: { ...draft.fonts, sans: "Inter" } }, seeded)).toBe(true);
    expect(
      isDraftDirty({ ...draft, fonts: { ...draft.fonts, sans: "Inter " } }, seeded),
    ).toBe(true);
    // Cosmetic edits (extra whitespace) are NOT dirty — canonical compare.
    expect(
      isDraftDirty(
        { ...draft, fonts: { ...draft.fonts, [FONT_ROLES[1]]: " sans-serif " } },
        seeded,
      ),
    ).toBe(false);
  });
});
