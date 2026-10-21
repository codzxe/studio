import { describe, expect, it } from "vitest";
import { Brand, assertBrandSafe, brandViolations } from "../src/index.js";

describe("brand: tokens", () => {
  it("codename is Studio and the tagline family comes from UI DS §8.1", () => {
    expect(Brand.codename).toBe("Studio");
    expect(Brand.productName).toBe("Studio");
    expect(Brand.tagline).toBe("Motion, directed by you");
    expect(Brand.titleTag).toBe("Studio — Motion, directed by you");
    expect(Brand.heroSubline).toContain("composition editor");
  });

  it("forbiddenNames matches the ADR-0006 brand rule exactly", () => {
    expect(Brand.forbiddenNames).toEqual([
      "EffectCraft",
      "ArtCraft",
      "PhotoCraft",
      "Photoshop",
      "Cursor",
    ]);
  });

  it("domains/contact/social tokens are present and never mention upstream names", () => {
    expect(Brand.domains.app).toBeTruthy();
    expect(Brand.contact.support).toContain("@");
    expect(Brand.social.x).toMatch(/^https:\/\//);
    // User-facing tokens only — the tokens themselves must be brand-safe
    // (Brand.forbiddenNames intentionally lists the banned names).
    const userFacing = [
      Brand.productName,
      Brand.titleTag,
      Brand.tagline,
      Brand.heroSubline,
      ...Object.values(Brand.domains),
      ...Object.values(Brand.contact),
      ...Object.values(Brand.social),
    ].join(" ");
    expect(assertBrandSafe(userFacing)).toBe(true);
  });
});

describe("brand: assertBrandSafe", () => {
  it("accepts ordinary Studio copy", () => {
    expect(assertBrandSafe("Welcome to Studio")).toBe(true);
    expect(assertBrandSafe("Motion, directed by you")).toBe(true);
    expect(
      assertBrandSafe(
        "A composition editor with an agent that understands layers, keyframes and taste.",
      ),
    ).toBe(true);
  });

  it("flags every forbidden upstream/tool name", () => {
    for (const name of Brand.forbiddenNames) {
      expect(assertBrandSafe(`Built on ${name}`)).toBe(false);
    }
  });

  it("is case-insensitive for the craft/editor marks", () => {
    expect(assertBrandSafe("powered by effectcraft")).toBe(false);
    expect(brandViolations("powered by effectcraft")).toEqual(["EffectCraft"]);
    expect(assertBrandSafe("photocraft inside")).toBe(false);
    expect(assertBrandSafe("better than PHOTOSHOP")).toBe(false);
    expect(brandViolations("better than PHOTOSHOP")).toEqual(["Photoshop"]);
  });

  it("does not flag the common noun 'cursor'", () => {
    // Editor copy legitimately says "cursor position" (lowercase common noun).
    expect(assertBrandSafe("Move the cursor to the playhead.")).toBe(true);
  });

  it("flags the product 'Cursor' and 'CURSOR' (case-sensitive exceptions)", () => {
    expect(assertBrandSafe("An editor like Cursor for motion.")).toBe(false);
    expect(assertBrandSafe("CURSOR FOR MOTION")).toBe(false);
    expect(brandViolations("An editor like Cursor for motion.")).toEqual(["Cursor"]);
  });

  it("requires word boundaries (no false positives on substrings)", () => {
    expect(assertBrandSafe("artcrafted banners")).toBe(true);
    expect(assertBrandSafe("effectcrafted")).toBe(true);
  });

  it("reports all matches at once", () => {
    const found = brandViolations("EffectCraft meets Photoshop");
    expect(found).toEqual(["EffectCraft", "Photoshop"]);
  });
});
