// @studio/config — brand tokens.
//
// `Studio` is the codename. The final product name is a single token swap in this
// file (docs/UI_DESIGN_SYSTEM.md §2.1): no component, page or copy string may
// hardcode it. ADR-0006: the upstream names (EffectCraft, ArtCraft, PhotoCraft,
// Photoshop, Cursor) never appear in the commercial UI, domain, installers or
// marketing — attribution lives in ATTRIBUTION.md and the licences page.
/** Single swap point for the product name and every brand token. */
export const Brand = {
    codename: "Studio",
    productName: "Studio",
    titleTag: "Studio — Motion, directed by you",
    tagline: "Motion, directed by you",
    heroSubline: "A composition editor with an agent that understands layers, keyframes and taste.",
    forbiddenNames: ["EffectCraft", "ArtCraft", "PhotoCraft", "Photoshop", "Cursor"],
    domains: {
        marketing: "studio.example.com",
        app: "app.studio.example.com",
        docs: "docs.studio.example.com",
        status: "status.studio.example.com",
    },
    contact: {
        email: "hello@studio.example.com",
        support: "support@studio.example.com",
        security: "security@studio.example.com",
    },
    social: {
        x: "https://x.com/studio",
        github: "https://github.com/studio",
        youtube: "https://youtube.com/@studio",
    },
};
/**
 * Forbidden-name matchers.
 *
 * The four upstream/tool marks are matched case-insensitively on word boundaries.
 * "Cursor" is matched case-sensitively (exact `Cursor` or `CURSOR`): lowercase
 * "cursor" is a legitimate common noun in editor copy (text cursor, cursor
 * position) and must not trip the lint.
 */
const FORBIDDEN_MATCHERS = [
    { name: "EffectCraft", pattern: /\beffectcraft\b/i },
    { name: "ArtCraft", pattern: /\bartcraft\b/i },
    { name: "PhotoCraft", pattern: /\bphotocraft\b/i },
    { name: "Photoshop", pattern: /\bphotoshop\b/i },
    { name: "Cursor", pattern: /\bCursor\b|\bCURSOR\b/ },
];
/**
 * Forbidden brand names found in `text` (matched names, e.g. `["Photoshop"]`).
 * Intended for commercial UI copy only — attribution files and licences pages
 * legitimately mention the upstream marks and are not run through this check.
 */
export function brandViolations(text) {
    const found = [];
    for (const matcher of FORBIDDEN_MATCHERS) {
        if (matcher.pattern.test(text)) {
            found.push(matcher.name);
        }
    }
    return found;
}
/**
 * Brand-safety gate for CI lint: `true` when `text` is free of the forbidden
 * upstream/tool names (ADR-0006). See {@link brandViolations} for match rules.
 */
export function assertBrandSafe(text) {
    return brandViolations(text).length === 0;
}
//# sourceMappingURL=brand.js.map