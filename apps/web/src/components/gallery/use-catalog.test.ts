/**
 * Pure-logic tests for the catalog layer (W8-J): wire-param building, tag
 * chip ranking, aspect labels, the compose handoff and the wire mirrors
 * against REAL manifest fixtures (evals/templates + evals/components data,
 * byte-for-byte). No network, no DOM — hooks are never called here.
 */
import { describe, expect, it } from "vitest";
import {
  aspectLabel,
  buildCatalogSearchParams,
  collectTagCounts,
  COMPOSE_ROUTE,
  composeHref,
  componentCardsSchema,
  componentManifestSchema,
  templateCardsSchema,
  templateManifestSchema,
} from "./use-catalog";

// ---------------------------------------------------------------------------
// Fixtures — real catalog data (§7.2 instagram-post@3, business-card@1 and
// §8.2 offer-badge@2, copied from evals/templates + evals/components).
// ---------------------------------------------------------------------------

const INSTAGRAM_POST_V3 = {
  id: "instagram-post",
  version: 3,
  name: "Instagram Post — Promo",
  description: "A bold product or offer post with a photo, headline, subhead and optional logo.",
  tags: ["social", "promo", "square"],
  canvas: { width: 1080, height: 1080, background: "#F4E7D3" },
  slots: {
    photo: {
      kind: "image",
      layer: "Photo",
      bounds: [0, 0, 1080, 700],
      fit: "cover",
      minPixels: [1080, 700],
      optional: false,
    },
    headline: {
      kind: "text",
      layer: "Headline",
      bounds: [72, 732, 936, 176],
      font: "display",
      weight: "bold",
      size: 96,
      lineHeight: 1.05,
      maxLines: 2,
      maxChars: 42,
      align: "left",
      color: "#3B2A20",
      autoFit: { minSize: 56, maxSize: 110 },
    },
    subhead: {
      kind: "text",
      layer: "Subhead",
      bounds: [72, 924, 936, 56],
      font: "sans",
      size: 36,
      maxLines: 1,
      maxChars: 60,
      color: "#6B5748",
    },
    badge: {
      kind: "component",
      component: "offer-badge@2",
      layer: "Badge",
      bounds: [828, 72, 180, 180],
      optional: true,
      vars: { label: "20% OFF" },
    },
    logo: {
      kind: "image",
      layer: "Logo",
      bounds: [888, 984, 120, 40],
      fit: "contain",
      optional: true,
    },
  },
  rules: {
    safeArea: 48,
    minContrast: 4.5,
    mustLayers: ["Background", "Photo", "Headline"],
    maxTextLayers: 6,
    palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  },
  layerMap: {
    Background: { role: "background", fill: "#F4E7D3" },
    Photo: { role: "image", mask: "rounded", maskRadius: 0 },
    Headline: { role: "headline" },
    Subhead: { role: "supporting-text" },
    Badge: { role: "component", component: "offer-badge@2" },
    Logo: { role: "logo" },
  },
  thumbnail: "thumbnails/instagram-post@3.png",
  license: "public",
  author: "studio",
} as const;

const BUSINESS_CARD_V1_SLOTS = {
  name: {
    kind: "text",
    layer: "Headline",
    bounds: [178, 170, 700, 96],
    font: "display",
    weight: "bold",
    size: 84,
    lineHeight: 1.1,
    maxLines: 1,
    maxChars: 24,
    align: "left",
    color: "#3B2A20",
    autoFit: { minSize: 56, maxSize: 90 },
  },
  accent: {
    kind: "color",
    layer: "Accent Band",
    color: "#D96C3B",
    optional: true,
  },
} as const;

const OFFER_BADGE_V2 = {
  id: "offer-badge",
  version: 2,
  name: "Offer Badge",
  author: "studio",
  description:
    "Circular promo badge with a short label and an optional ribbon strip. Spec §7.2/§8.2 verbatim.",
  tags: ["badge", "promo"],
  defaultSize: { width: 180, height: 180 },
  variables: {
    label: { kind: "text", default: "SALE", maxChars: 12 },
    bg: { kind: "color", default: "#D96C3B" },
    textColor: { kind: "color", default: "#FFF7EE" },
    showRibbon: { kind: "visibility", default: false },
  },
  anchors: { center: [0.5, 0.5], topRight: [1, 0], bottomLeft: [0, 1] },
  comps: ["default", "light", "dark"],
  license: "public",
} as const;

// ---------------------------------------------------------------------------
// buildCatalogSearchParams
// ---------------------------------------------------------------------------

describe("buildCatalogSearchParams", () => {
  it("omits every parameter for an empty filter", () => {
    expect(buildCatalogSearchParams()).toBe("");
    expect(buildCatalogSearchParams(null)).toBe("");
    expect(buildCatalogSearchParams({})).toBe("");
    expect(buildCatalogSearchParams({ tags: [], query: "" })).toBe("");
    expect(buildCatalogSearchParams({ tags: ["  "], query: "   " })).toBe("");
  });

  it("joins tags with commas (AND semantics on the gateway, §7.4)", () => {
    expect(buildCatalogSearchParams({ tags: ["social"] })).toBe("tags=social");
    expect(buildCatalogSearchParams({ tags: ["social", "promo"] })).toBe(
      "tags=social%2Cpromo",
    );
  });

  it("trims tags and drops blank entries", () => {
    expect(buildCatalogSearchParams({ tags: [" social ", "", "promo"] })).toBe(
      "tags=social%2Cpromo",
    );
  });

  it("passes the query through URLSearchParams encoding", () => {
    expect(buildCatalogSearchParams({ query: "promo" })).toBe("query=promo");
    expect(buildCatalogSearchParams({ query: "hello world" })).toBe("query=hello+world");
  });

  it("combines tags and query in a stable order", () => {
    expect(buildCatalogSearchParams({ tags: ["a"], query: "b" })).toBe("tags=a&query=b");
  });
});

// ---------------------------------------------------------------------------
// collectTagCounts
// ---------------------------------------------------------------------------

describe("collectTagCounts", () => {
  const items = [
    { tags: ["Social", "promo", "social"] },
    { tags: ["social", "square"] },
    { tags: [] },
  ];

  it("counts tags case-insensitively, once per card", () => {
    expect(collectTagCounts(items)).toEqual([
      { tag: "social", count: 2 },
      { tag: "promo", count: 1 },
      { tag: "square", count: 1 },
    ]);
  });

  it("ranks by frequency then name and honours the limit", () => {
    expect(collectTagCounts(items, { limit: 1 })).toEqual([{ tag: "social", count: 2 }]);
  });

  it("keeps selected tags visible even past the limit", () => {
    expect(collectTagCounts(items, { limit: 1, alwaysInclude: ["square"] })).toEqual([
      { tag: "social", count: 2 },
      { tag: "square", count: 1 },
    ]);
  });

  it("never invents chips the catalog does not carry", () => {
    expect(collectTagCounts([], { alwaysInclude: ["missing"] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aspectLabel
// ---------------------------------------------------------------------------

describe("aspectLabel", () => {
  it("simplifies common canvas ratios", () => {
    expect(aspectLabel(1080, 1080)).toBe("1:1");
    expect(aspectLabel(1920, 1080)).toBe("16:9");
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(1000, 1500)).toBe("2:3");
  });

  it("drops the chip when the ratio does not reduce to small terms", () => {
    expect(aspectLabel(1063, 652)).toBeNull();
    expect(aspectLabel(820, 312)).toBeNull();
  });

  it("refuses non-positive dimensions", () => {
    expect(aspectLabel(0, 100)).toBeNull();
    expect(aspectLabel(-1, 100)).toBeNull();
    expect(aspectLabel(Number.NaN, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// composeHref (W8-D contract)
// ---------------------------------------------------------------------------

describe("composeHref", () => {
  it("targets the compose page with an encoded id@version pin", () => {
    expect(COMPOSE_ROUTE).toBe("/compose");
    expect(composeHref("instagram-post@3")).toBe(
      "/compose?template=instagram-post%403",
    );
  });
});

// ---------------------------------------------------------------------------
// Wire mirrors against real manifests
// ---------------------------------------------------------------------------

describe("catalog wire schemas", () => {
  it("accepts the real §7.2 instagram-post@3 manifest", () => {
    const manifest = templateManifestSchema.parse(INSTAGRAM_POST_V3);
    expect(manifest.name).toBe("Instagram Post — Promo");
    expect(Object.keys(manifest.slots ?? {})).toHaveLength(5);
    expect(manifest.slots?.badge?.kind).toBe("component");
  });

  it("accepts color and visibility slots (all five §7.3 kinds)", () => {
    const manifest = templateManifestSchema.parse({
      id: "x",
      version: 1,
      name: "X",
      canvas: { width: 100, height: 100 },
      slots: {
        ...BUSINESS_CARD_V1_SLOTS,
        ribbon: { kind: "visibility", layer: "Ribbon", default: false, optional: true },
      },
    });
    expect(manifest.slots?.accent?.kind).toBe("color");
    expect(manifest.slots?.ribbon?.kind).toBe("visibility");
  });

  it("accepts the real §8.2 offer-badge@2 manifest", () => {
    const manifest = componentManifestSchema.parse(OFFER_BADGE_V2);
    expect(manifest.variables?.label).toMatchObject({
      kind: "text",
      default: "SALE",
      maxChars: 12,
    });
    expect(manifest.anchors?.center).toEqual([0.5, 0.5]);
  });

  it("accepts the real §7.4 template card wire shape", () => {
    const cards = templateCardsSchema.parse({
      templates: [
        {
          id: "instagram-post",
          version: 3,
          ref: "instagram-post@3",
          name: "Instagram Post — Promo",
          tags: ["social", "promo", "square"],
          canvas: { width: 1080, height: 1080 },
          slots: ["photo", "headline", "subhead", "badge", "logo"],
        },
      ],
    });
    expect(cards.templates).toHaveLength(1);
    expect(cards.templates[0]?.ref).toBe("instagram-post@3");
  });

  it("accepts the real §8.3 component card wire shape", () => {
    const cards = componentCardsSchema.parse({
      components: [
        {
          id: "offer-badge",
          version: 2,
          ref: "offer-badge@2",
          name: "Offer Badge",
          tags: ["badge", "promo"],
          defaultSize: { width: 180, height: 180 },
          license: "public",
          variables: ["label", "bg", "textColor", "showRibbon"],
          comps: ["default", "light", "dark"],
        },
      ],
    });
    expect(cards.components[0]?.variables).toContain("showRibbon");
  });

  it("rejects card payloads missing required wire fields (drift trips loud)", () => {
    expect(templateCardsSchema.safeParse({ templates: [{ id: "x" }] }).success).toBe(false);
    expect(
      componentManifestSchema.safeParse({ id: "x", version: 1, name: "X" }).success,
    ).toBe(false);
  });
});
