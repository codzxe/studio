// W7-F — brand tokens tests: §7.5 merge precedence + fallback, §10.2 font
// gate, palette caps, and the §5.4 style-guide block's byte stability.
//
// Deterministic (§21): the seams are scripted fakes (no db, no network, no
// timers). The §5.4 parity test runs the REAL ContextAssembler (the
// style-guide consumer) and asserts byte-identical section output.

import { ContextAssembler } from "../../src/observer/context.js";
import {
  BRAND_ERROR_CODES,
  type BrandSeams,
  BrandTokensService,
  buildStyleGuidePayload,
} from "../../src/brand/service.js";
import {
  type BrandTokens,
  type FontRole,
  DEFAULT_BRAND,
  FONT_ROLES,
  MAX_PALETTE_TOKENS,
  MAX_TONE_WORDS,
  brandTokensSchema,
  hexColorSchema,
  normalizeHex,
} from "../../src/brand/tokens.js";
import { describe, expect, it } from "vitest";

const ORG_ID = "org-1";
const LOGO_ASSET = "asset-logo-1";

/** org.metadata TEXT is JSON; this helper keeps fixtures honest. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Scripted seams + one service instance; `calls` records seam traffic. */
function makeService(options: {
  readonly orgs?: Record<string, string | null>;
  readonly assets?: readonly string[];
  readonly failOrgLookup?: boolean;
  readonly failAssetLookup?: boolean;
}): {
  readonly service: BrandTokensService;
  readonly calls: { readonly org: readonly string[]; readonly asset: readonly string[] };
} {
  const orgs = options.orgs ?? {};
  const assets = new Set(options.assets ?? []);
  const org: string[] = [];
  const asset: string[] = [];
  const seams: BrandSeams = {
    async orgLookup(organizationId: string) {
      org.push(organizationId);
      if (options.failOrgLookup === true) throw new Error("seam down");
      if (!(organizationId in orgs)) return null;
      return { metadata: orgs[organizationId] ?? null };
    },
    async assetLookup(assetId: string) {
      asset.push(assetId);
      if (options.failAssetLookup === true) throw new Error("seam down");
      return assets.has(assetId) ? { id: assetId } : null;
    },
  };
  return { service: new BrandTokensService({ seams }), calls: { org, asset } };
}

/** A fully-configured brand kit (mixed-case hex on purpose). */
const ORG_TOKENS = {
  palette: ["#F4E7D3", "#3B2A20", "#d96c3b"],
  fonts: { display: "Bitter", sans: "Inter" },
  logoAssetId: LOGO_ASSET,
  toneWords: ["warm", "artisanal", "inviting"],
};

/** 12 distinct valid hexes ("#000001".."#00000C") — over the 10-token cap. */
const twelveHexes = Array.from(
  { length: 12 },
  (_, i) => `#${(i + 1).toString(16).padStart(6, "0").toUpperCase()}`,
);

const FONT_TOKENS: BrandTokens = {
  palette: ["#111111"],
  fonts: { display: "Bitter", sans: "Inter" },
};
const FONT_REGISTRY = ["Bitter", "Inter", "Lora"];

const STYLE_TOKENS: BrandTokens = {
  palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  fonts: { display: "Bitter", sans: "Inter", serif: "Lora" },
  toneWords: ["warm", "modern"],
};

// ---------------------------------------------------------------------------
// §7.5 merge precedence — org wins per field (fonts per role), defaults fill
// ---------------------------------------------------------------------------

describe("W7-F brand tokens: merge precedence (§7.5 org wins)", () => {
  it("uses every org-supplied field and normalizes hex to canonical form", async () => {
    const { service, calls } = makeService({
      orgs: { [ORG_ID]: json({ brandTokens: ORG_TOKENS }) },
      assets: [LOGO_ASSET],
    });
    const resolved = await service.get(ORG_ID);
    expect(resolved.source).toBe("organization");
    expect(resolved.warnings).toEqual([]);
    expect(resolved.tokens).toEqual({
      palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
      fonts: { display: "Bitter", sans: "Inter", serif: "serif", mono: "monospace" },
      logoAssetId: LOGO_ASSET,
      toneWords: ["warm", "artisanal", "inviting"],
    });
    // one org lookup per get(); exactly one logo verification
    expect(calls.org).toEqual([ORG_ID]);
    expect(calls.asset).toEqual([LOGO_ASSET]);
  });

  it("replaces (never mixes) the default palette when the org supplies one", async () => {
    const { service } = makeService({ orgs: { [ORG_ID]: json({ brandTokens: { palette: ["#d96c3b"] } }) } });
    const resolved = await service.get(ORG_ID);
    expect(resolved.source).toBe("organization");
    expect(resolved.tokens.palette).toEqual(["#D96C3B"]);
    expect(resolved.tokens.toneWords).toEqual(DEFAULT_BRAND.toneWords);
  });

  it("merges fonts per §5.5 role: org roles win, unbound roles fall back", async () => {
    const { service } = makeService({ orgs: { [ORG_ID]: json({ brandTokens: { fonts: { sans: "Inter" } } }) } });
    const resolved = await service.get(ORG_ID);
    expect(resolved.tokens.fonts).toEqual({
      display: "sans-serif",
      sans: "Inter",
      serif: "serif",
      mono: "monospace",
    });
  });

  it("falls back per field when an org field validates to empty", async () => {
    const { service } = makeService({ orgs: { [ORG_ID]: json({ brandTokens: { palette: [] } }) } });
    const resolved = await service.get(ORG_ID);
    expect(resolved.source).toBe("default");
    expect(resolved.tokens.palette).toEqual(DEFAULT_BRAND.palette);
  });
});

// ---------------------------------------------------------------------------
// §7.5 fallback on missing/invalid — never a hard failure, always a warning
// ---------------------------------------------------------------------------

describe("W7-F brand tokens: fallback on missing/invalid (§7.5)", () => {
  it("uses DEFAULT_BRAND when the organization is not found", async () => {
    const { service, calls } = makeService({ orgs: {} });
    const resolved = await service.get("ghost");
    expect(resolved.source).toBe("default");
    expect(resolved.tokens).toEqual(DEFAULT_BRAND);
    expect(resolved.warnings).toContain("brand tokens: organization not found; defaults applied");
    expect(calls.asset).toEqual([]); // no logo verification without org tokens
  });

  it("treats absent metadata (null/no brandTokens key) as unconfigured — silently defaults", async () => {
    const a = await makeService({ orgs: { [ORG_ID]: null } }).service.get(ORG_ID);
    expect(a.source).toBe("default");
    expect(a.warnings).toEqual([]);
    expect(a.tokens).toEqual(DEFAULT_BRAND);
    const b = await makeService({ orgs: { [ORG_ID]: json({ plan: "pro" }) } }).service.get(ORG_ID);
    expect(b.source).toBe("default");
    expect(b.warnings).toEqual([]);
  });

  it("defaults with a warning when metadata is malformed", async () => {
    const invalidJson = await makeService({ orgs: { [ORG_ID]: "{oops" } }).service.get(ORG_ID);
    expect(invalidJson.source).toBe("default");
    expect(invalidJson.tokens).toEqual(DEFAULT_BRAND);
    expect(invalidJson.warnings).toContain(
      "brand tokens: organization metadata is not valid JSON; defaults applied",
    );
    const notAnObject = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: "nope" }) },
    }).service.get(ORG_ID);
    expect(notAnObject.warnings).toContain(
      "brand tokens: metadata.brandTokens is not an object; defaults applied",
    );
  });

  it("drops invalid palette entries with a warning; survivors win (no default mixing)", async () => {
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { palette: ["#111111", "red", 12, null, "#222222"] } }) },
    }).service.get(ORG_ID);
    expect(resolved.tokens.palette).toEqual(["#111111", "#222222"]);
    expect(resolved.warnings).toContain("brand tokens: palette dropped 3 invalid hex entries");
  });

  it("falls back to the default palette when every org entry is invalid", async () => {
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { palette: ["red", "blue"] } }) },
    }).service.get(ORG_ID);
    expect(resolved.source).toBe("default");
    expect(resolved.tokens.palette).toEqual(DEFAULT_BRAND.palette);
  });

  it("normalizes 3-digit hex and drops duplicate colours after normalization", async () => {
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { palette: ["#abc", "#ABC", "#AABBCC", "#111111"] } }) },
    }).service.get(ORG_ID);
    expect(resolved.tokens.palette).toEqual(["#AABBCC", "#111111"]);
    expect(resolved.warnings).toContain("brand tokens: palette dropped 2 duplicate entries");
  });

  it("warns and defaults per font field when fonts is not an object", async () => {
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { fonts: ["Inter"] } }) },
    }).service.get(ORG_ID);
    expect(resolved.tokens.fonts).toEqual(DEFAULT_BRAND.fonts);
    expect(resolved.warnings).toContain("brand tokens: fonts is not an object; default fonts applied");
  });

  it("drops unreadable role values, ignores unknown roles (both warned)", async () => {
    const resolved = await makeService({
      orgs: {
        [ORG_ID]: json({ brandTokens: { fonts: { display: 42, headline: "Inter", sans: "Inter" } } }),
      },
    }).service.get(ORG_ID);
    expect(resolved.tokens.fonts).toEqual({
      display: "sans-serif",
      sans: "Inter",
      serif: "serif",
      mono: "monospace",
    });
    expect(resolved.warnings).toContain("brand tokens: fonts dropped 1 unreadable role value");
    expect(resolved.warnings).toContain("brand tokens: fonts ignored 1 unknown role key");
  });

  it("drops logoAssetId when the asset seam cannot find the logo", async () => {
    const missing = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: ORG_TOKENS }) },
      assets: [],
    }).service.get(ORG_ID);
    expect(missing.tokens.logoAssetId).toBeUndefined();
    expect(missing.warnings).toContain("brand tokens: logo asset not found; logoAssetId dropped");
    const failing = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: ORG_TOKENS }) },
      failAssetLookup: true,
    }).service.get(ORG_ID);
    expect(failing.tokens.logoAssetId).toBeUndefined();
    expect(failing.warnings).toContain("brand tokens: logo asset lookup failed; logoAssetId dropped");
  });

  it("drops an unreadable logoAssetId without touching the asset seam", async () => {
    const { service, calls } = makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { logoAssetId: 123 } }) },
    });
    const resolved = await service.get(ORG_ID);
    expect(resolved.tokens.logoAssetId).toBeUndefined();
    expect(resolved.warnings).toContain("brand tokens: logoAssetId unreadable; dropped");
    expect(calls.asset).toEqual([]);
  });

  it("degrades to defaults when the org lookup fails or the id is unusable", async () => {
    const down = await makeService({ failOrgLookup: true }).service.get(ORG_ID);
    expect(down.source).toBe("default");
    expect(down.tokens).toEqual(DEFAULT_BRAND);
    expect(down.warnings).toContain("brand tokens: organization lookup failed; defaults applied");
    const blank = makeService({});
    const resolved = await blank.service.get("   ");
    expect(resolved.source).toBe("default");
    expect(resolved.warnings).toContain("brand tokens: invalid organization id; defaults applied");
    expect(blank.calls.org).toEqual([]); // seam never called with an unusable id
  });

  it("validates tone words like the palette: drop invalid, dedupe, cap, default on empty", async () => {
    const partial = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { toneWords: ["warm", 5, null, "warm"] } }) },
    }).service.get(ORG_ID);
    expect(partial.source).toBe("default"); // nothing usable survived
    expect(partial.tokens.toneWords).toEqual(DEFAULT_BRAND.toneWords);
    expect(partial.warnings).toContain("brand tokens: toneWords dropped 2 invalid words");
    expect(partial.warnings).toContain("brand tokens: toneWords dropped 1 duplicate word");
    const notAnArray = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { toneWords: "warm" } }) },
    }).service.get(ORG_ID);
    expect(notAnArray.warnings).toContain("brand tokens: toneWords is not an array; default tone applied");
  });
});

// ---------------------------------------------------------------------------
// Palette cap — validate → dedupe → cap (the cap counts survivors)
// ---------------------------------------------------------------------------

describe("W7-F brand tokens: palette cap (≤10)", () => {
  it("keeps the first 10 valid entries of an over-cap palette, with a warning", async () => {
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { palette: twelveHexes } }) },
    }).service.get(ORG_ID);
    expect(resolved.source).toBe("organization");
    expect(resolved.tokens.palette).toEqual(twelveHexes.slice(0, MAX_PALETTE_TOKENS));
    expect(resolved.warnings).toContain("brand tokens: palette limited to first 10 of 12 entries");
  });

  it("accepts exactly 10 entries without truncation", async () => {
    const ten = twelveHexes.slice(0, MAX_PALETTE_TOKENS);
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { palette: ten } }) },
    }).service.get(ORG_ID);
    expect(resolved.tokens.palette).toEqual(ten);
    expect(resolved.warnings).toEqual([]);
  });

  it("caps survivors: 12 entries with 2 invalid ones need no truncation", async () => {
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { palette: [...twelveHexes.slice(0, 10), "bad1", "bad2"] } }) },
    }).service.get(ORG_ID);
    expect(resolved.tokens.palette).toEqual(twelveHexes.slice(0, MAX_PALETTE_TOKENS));
    expect(resolved.warnings).toContain("brand tokens: palette dropped 2 invalid hex entries");
    expect(resolved.warnings.some((warning) => warning.includes("limited"))).toBe(false);
  });

  it("caps tone words at 8 with a warning", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `tone${i}`);
    const resolved = await makeService({
      orgs: { [ORG_ID]: json({ brandTokens: { toneWords: ten } }) },
    }).service.get(ORG_ID);
    expect(resolved.tokens.toneWords).toEqual(ten.slice(0, MAX_TONE_WORDS));
    expect(resolved.warnings).toContain("brand tokens: toneWords limited to first 8 of 10 words");
  });
});

// ---------------------------------------------------------------------------
// §10.2 font validation table — workspace font set only, install hint
// ---------------------------------------------------------------------------

interface FontCase {
  readonly name: string;
  readonly font: string;
  readonly tokens: BrandTokens;
  readonly registry: readonly string[];
  readonly expectOk: boolean;
  readonly resolved?: string;
  readonly via?: "brand_role" | "registry";
  readonly role?: FontRole;
  readonly messageIncludes?: string;
  readonly hintIncludes?: string;
}

const FONT_TABLE: readonly FontCase[] = [
  {
    name: "concrete installed name passes via the registry",
    font: "Inter",
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: true,
    resolved: "Inter",
    via: "registry",
  },
  {
    name: "match is case-insensitive and resolves the registry casing",
    font: "inter",
    tokens: FONT_TOKENS,
    registry: ["Inter"],
    expectOk: true,
    resolved: "Inter",
    via: "registry",
  },
  {
    name: "surrounding whitespace is trimmed before matching",
    font: "  Inter  ",
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: true,
    resolved: "Inter",
    via: "registry",
  },
  {
    name: "a §5.5 role reference resolves through tokens.fonts",
    font: "display",
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: true,
    resolved: "Bitter",
    via: "brand_role",
    role: "display",
  },
  {
    name: "role references are case-insensitive",
    font: "Sans",
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: true,
    resolved: "Inter",
    via: "brand_role",
    role: "sans",
  },
  {
    name: "an unbound role is missing (§10.2 error, role-named message)",
    font: "mono",
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: false,
    messageIncludes: 'role "mono"',
    hintIncludes: "installed",
  },
  {
    name: "a role bound to an uninstalled brand font is missing",
    font: "serif",
    tokens: { palette: ["#111111"], fonts: { serif: "Lora X" } },
    registry: ["Lora"],
    expectOk: false,
    messageIncludes: "Lora X",
    hintIncludes: "install",
  },
  {
    name: "an unknown font is missing with an install hint",
    font: "Comic Sans",
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: false,
    messageIncludes: "not in the workspace font set",
    hintIncludes: "install",
  },
  {
    name: "an empty registry fails closed",
    font: "Inter",
    tokens: FONT_TOKENS,
    registry: [],
    expectOk: false,
    hintIncludes: "install",
  },
  {
    name: "whitespace-only font is missing",
    font: "   ",
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: false,
  },
  {
    name: "oversized font name is missing",
    font: "x".repeat(80),
    tokens: FONT_TOKENS,
    registry: FONT_REGISTRY,
    expectOk: false,
  },
];

describe("W7-F brand tokens: font validation (§10.2)", () => {
  const { service } = makeService({});

  it.each(FONT_TABLE)("$name", (row) => {
    const check = service.validateFontUse(row.font, row.tokens, row.registry);
    if (row.expectOk) {
      expect(check.ok).toBe(true);
      if (!check.ok) return;
      expect(check.font).toBe(row.resolved);
      expect(check.via).toBe(row.via);
      if (row.role !== undefined) expect(check.role).toBe(row.role);
    } else {
      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(check.code).toBe("missing_font");
      expect(check.retryable).toBe(false);
      if (row.messageIncludes !== undefined) expect(check.message).toContain(row.messageIncludes);
      if (row.hintIncludes !== undefined) expect(check.hint).toContain(row.hintIncludes);
    }
  });

  it("install hints list installed examples and never leak paths or ids (§22)", () => {
    const check = service.validateFontUse("Comic Sans", FONT_TOKENS, FONT_REGISTRY);
    if (check.ok) throw new Error("expected a failure");
    expect(check.message).not.toContain("/");
    expect(check.hint).not.toContain("/");
    expect(check.hint).toContain('"Bitter"');
    expect(BRAND_ERROR_CODES).toEqual(["missing_font"]);
  });

  it("the error envelope is the AGENTS.md shape", () => {
    const check = service.validateFontUse("Ghost", FONT_TOKENS, []);
    if (check.ok) throw new Error("expected a failure");
    expect(check).toMatchObject({
      ok: false,
      code: "missing_font",
      retryable: false,
    });
    expect(typeof check.message).toBe("string");
    expect(typeof check.hint).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// §5.4 style guide — the section-2 block: canonical, deterministic, cacheable
// ---------------------------------------------------------------------------

describe("W7-F brand tokens: style-guide block (§5.4 item 2)", () => {
  const { service } = makeService({});

  it("is deterministic: equal tokens → byte-identical blocks, whatever the key order", () => {
    const first = service.toStyleGuide(STYLE_TOKENS);
    expect(service.toStyleGuide(STYLE_TOKENS)).toBe(first); // pure across calls
    const reordered: BrandTokens = {
      toneWords: ["warm", "modern"],
      fonts: { serif: "Lora", sans: "Inter", display: "Bitter" },
      palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
    };
    expect(service.toStyleGuide(reordered)).toBe(first);
  });

  it("carries the §5.4 fields: palette tokens, sorted unique fonts, joined tone", () => {
    const block: Record<string, unknown> = JSON.parse(service.toStyleGuide(STYLE_TOKENS));
    expect(block.section).toBe("style_guide");
    expect(block.palette).toEqual({ color1: "#F4E7D3", color2: "#3B2A20", color3: "#D96C3B" });
    expect(block.fonts).toEqual(["Bitter", "Inter", "Lora"]);
    expect(block.tone).toBe("warm, modern");
  });

  it("matches the ContextAssembler style_guide section byte-for-byte (§5.4 cache parity)", () => {
    const assembler = new ContextAssembler();
    const payload = buildStyleGuidePayload(STYLE_TOKENS);
    const assembled = assembler.assembleContext({ system: "", styleGuide: payload });
    const section = assembled.sections.find((candidate) => candidate.id === "style_guide");
    if (section === undefined) throw new Error("style_guide section missing");
    expect(section.content).toBe(service.toStyleGuide(STYLE_TOKENS));
    // cacheable: equal tokens → equal cacheablePrefix across assemblies
    const second = assembler.assembleContext({ system: "", styleGuide: payload });
    expect(second.cacheablePrefix).toBe(assembled.cacheablePrefix);
  });

  it("changes bytes when the tokens change (the prefix actually keys on content)", () => {
    const alt: BrandTokens = { ...STYLE_TOKENS, palette: ["#111111", "#3B2A20", "#D96C3B"] };
    expect(service.toStyleGuide(alt)).not.toBe(service.toStyleGuide(STYLE_TOKENS));
  });

  it("renders DEFAULT_BRAND with deduped generic families and the default tone", () => {
    const block: Record<string, unknown> = JSON.parse(service.toStyleGuide(DEFAULT_BRAND));
    expect(block.fonts).toEqual(["monospace", "sans-serif", "serif"]);
    expect(block.tone).toBe("clean, modern, neutral");
  });
});

// ---------------------------------------------------------------------------
// Zod contracts (tokens.ts)
// ---------------------------------------------------------------------------

describe("W7-F brand tokens: zod contracts", () => {
  it("FONT_ROLES is the §5.5 role set", () => {
    expect(FONT_ROLES).toEqual(["display", "sans", "serif", "mono"]);
  });

  it("hexColorSchema parses to the canonical uppercase 6-digit form", () => {
    const expanded = hexColorSchema.safeParse("#abc");
    expect(expanded.success).toBe(true);
    if (expanded.success) expect(expanded.data).toBe("#AABBCC");
    const trimmed = hexColorSchema.safeParse(" #d96c3b ");
    expect(trimmed.success).toBe(true);
    if (trimmed.success) expect(trimmed.data).toBe("#D96C3B");
  });

  it.each([
    ["5 digits", "#12345"],
    ["no hash", "D96C3B"],
    ["non-hex chars", "#D96C3X"],
    ["rgb() is not a brand-token format", "rgb(1,2,3)"],
    ["not a string", 42],
    ["null", null],
  ])("hexColorSchema rejects %s", (_label, value) => {
    expect(hexColorSchema.safeParse(value).success).toBe(false);
  });

  it("brandTokensSchema normalizes hex and trims names on parse", () => {
    const parsed = brandTokensSchema.parse({
      palette: ["#abc", "#D96C3B"],
      fonts: { display: "  Bitter  " },
      toneWords: [" warm "],
    });
    expect(parsed.palette).toEqual(["#AABBCC", "#D96C3B"]);
    expect(parsed.fonts.display).toBe("Bitter");
    expect(parsed.toneWords).toEqual(["warm"]);
  });

  it.each([
    ["palette over cap", { palette: twelveHexes, fonts: {} }],
    ["palette empty", { palette: [], fonts: {} }],
    ["palette non-hex", { palette: ["red"], fonts: {} }],
    ["palette non-string entry", { palette: [42], fonts: {} }],
    ["unknown font role", { palette: ["#111111"], fonts: { headline: "Inter" } }],
    ["missing fonts field", { palette: ["#111111"] }],
    ["toneWords over cap", { palette: ["#111111"], fonts: {}, toneWords: Array.from({ length: 9 }, (_, i) => `w${i}`) }],
    ["unknown top-level field", { palette: ["#111111"], fonts: {}, extra: 1 }],
  ])("brandTokensSchema rejects %s", (_label, value) => {
    expect(brandTokensSchema.safeParse(value).success).toBe(false);
  });

  it("DEFAULT_BRAND is schema-valid, canonical and neutral (§7.5 fallback)", () => {
    expect(brandTokensSchema.parse(DEFAULT_BRAND)).toEqual(DEFAULT_BRAND);
    expect(DEFAULT_BRAND.palette.length).toBeGreaterThan(0);
    expect(DEFAULT_BRAND.palette.length).toBeLessThanOrEqual(MAX_PALETTE_TOKENS);
    expect((DEFAULT_BRAND.toneWords ?? []).length).toBeLessThanOrEqual(MAX_TONE_WORDS);
    expect(DEFAULT_BRAND.logoAssetId).toBeUndefined();
    for (const hex of DEFAULT_BRAND.palette) {
      expect(normalizeHex(hex)).toBe(hex); // already canonical
      const digits = hex.slice(1);
      expect(digits.slice(0, 2)).toBe(digits.slice(2, 4)); // R === G
      expect(digits.slice(0, 2)).toBe(digits.slice(4, 6)); // R === B — grayscale
    }
  });
});

// ---------------------------------------------------------------------------
// Constructor fail-fast (fleet precedent: hand-built deps throw early)
// ---------------------------------------------------------------------------

describe("W7-F brand tokens: service construction", () => {
  it("throws TypeError on mis-wired seams", () => {
    expect(
      () => new BrandTokensService({ seams: null as unknown as BrandSeams }),
    ).toThrow(TypeError);
    expect(() =>
      new BrandTokensService({ seams: { orgLookup: "nope" } as unknown as BrandSeams }),
    ).toThrow(TypeError);
  });
});
