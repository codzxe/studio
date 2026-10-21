// @studio/agent/brand/tokens — the workspace brand-token contract. Owner: W7-F
// (docs/AGENTS.md): this directory is the ONLY surface this task owns.
//
// Spec anchors:
//   §7.5 (last rule)  "palette and fonts come from workspace brand tokens with
//                      template defaults as fallback" — DEFAULT_BRAND is that
//                      fallback; a workspace never needs brand tokens to run.
//   §5.4 (2)          the style guide is "workspace brand tokens (palette,
//                      fonts, tone), cached per workspace" — so the token
//                      shape must normalize to canonical, byte-stable values
//                      (normalized hex, trimmed names) or the §5.3 provider
//                      cache prefix would shift mid-run.
//   §10.2             "workspace palette tokens; the agent picks from the
//                      palette unless the user asks otherwise. Fonts:
//                      workspace font set only; a missing font is an error
//                      with an install hint" — the caps/limits here are the
//                      deterministic half of that rule (service.ts owns the
//                      missing_font gate).
//   §6.1              colour formats `#RGB`/`#RRGGBB` — brand palette tokens
//                      are hex per this task's contract (rgb()/hsl() are tool-
//                      argument formats, not storage formats).
//
// Zod at the boundary (AGENTS.md): brandTokensSchema is the CANONICAL output
// contract — service.ts validates untrusted org metadata per-field through the
// granular schemas (drop-with-warning per §7.5, never a hard failure) and then
// runs the merged result through this schema as a final invariant gate.
// Consumers may also parse any BrandTokens-shaped JSON they receive.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Roles, limits (all deterministic; palette/tone caps are task contract)
// ---------------------------------------------------------------------------

/** §5.5 typography roles — the only font slots a brand set defines. */
export const FONT_ROLES = ["display", "sans", "serif", "mono"] as const;

export type FontRole = (typeof FONT_ROLES)[number];

/** Task contract: palette is hex[] with at most 10 tokens. */
export const MAX_PALETTE_TOKENS = 10;

/** Task contract: toneWords is string[] with at most 8 words. */
export const MAX_TONE_WORDS = 8;

/**
 * Font-name cap. Mirrors observer/context.ts `readFonts`' 64-char clip so a
 * canonical BrandTokens round-trips through the §5.4 style-guide projection
 * byte-identically (§5.4 cache stability).
 */
export const MAX_FONT_NAME_CHARS = 64;

/** One tone word, capped (joined tone string is clipped again at 1 000 §5.4). */
export const MAX_TONE_WORD_CHARS = 64;

/** Asset ids are echoed nowhere (§6.1); the cap only bounds seam traffic. */
export const MAX_LOGO_ASSET_ID_CHARS = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fonts by §5.5 role — concrete family NAMES in the workspace font registry
 * (never files, never absolute paths; §7.5 "use the workspace's font registry").
 */
export interface BrandFontSet {
  readonly display?: string;
  readonly sans?: string;
  readonly serif?: string;
  readonly mono?: string;
}

/**
 * The workspace brand kit (§7.5/§10.2): palette, role fonts, logo, tone.
 * `palette` entries are canonical `#RRGGBB` (uppercase) — equal brands must
 * serialize to equal bytes for the §5.4 cached style guide.
 */
export interface BrandTokens {
  /** Canonical hex colours, org order preserved, ≤ MAX_PALETTE_TOKENS. */
  readonly palette: readonly string[];
  /** Role → registry font name; unbound roles are omitted. */
  readonly fonts: BrandFontSet;
  /** Workspace asset id for the logo (verified through the asset seam). */
  readonly logoAssetId?: string;
  /** Brand tone words (≤ MAX_TONE_WORDS), feeding the §5.4 style-guide tone. */
  readonly toneWords?: readonly string[];
}

// ---------------------------------------------------------------------------
// Hex normalization (canonical form → cache-stable §5.4 bytes)
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * `#RGB`/`#RRGGBB` → uppercase `#RRGGBB` (3-digit expanded); anything else →
 * undefined. Pure + total: never throws, never guesses (fleet reader style).
 */
export function normalizeHex(value: string): string | undefined {
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) return undefined;
  const digits = trimmed.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => `${d}${d}`).join("") : digits;
  return `#${full.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Zod schemas (granular fields + the canonical contract)
// ---------------------------------------------------------------------------

/**
 * Hex colour, parsed to its canonical `#RRGGBB` form. Typed like the tools
 * kit's zColor (ZodEffects annotated as ZodType<Output, Def, Input> — the
 * repo-proven idiom); the refine guard makes the transform's cast sound.
 */
export const hexColorSchema: z.ZodType<string, z.ZodTypeDef, string> = z
  .string()
  .refine((value) => normalizeHex(value) !== undefined, {
    message: "palette colour must be #RGB or #RRGGBB hex",
  })
  .transform((value) => normalizeHex(value) as string);

/** Registry font name (trimmed, non-empty). */
export const brandFontNameSchema = z.string().trim().min(1).max(MAX_FONT_NAME_CHARS);

/** One tone word (trimmed, non-empty). */
export const toneWordSchema = z.string().trim().min(1).max(MAX_TONE_WORD_CHARS);

/** Workspace asset id for the logo (trimmed, non-empty). */
export const logoAssetIdSchema = z.string().trim().min(1).max(MAX_LOGO_ASSET_ID_CHARS);

/** Role-keyed font set — strict: unknown roles are a contract violation. */
export const brandFontSetSchema = z.strictObject({
  display: brandFontNameSchema.optional(),
  sans: brandFontNameSchema.optional(),
  serif: brandFontNameSchema.optional(),
  mono: brandFontNameSchema.optional(),
});

/**
 * The canonical BrandTokens contract (§7.5/§10.2): strict object, canonical hex
 * palette (1..10), role-keyed fonts, optional logo + tone words (≤8). Parsed
 * output is structurally a `BrandTokens` (zod arrays are mutable, which feeds
 * the readonly surface — keep this schema and the interface in lockstep).
 */
export const brandTokensSchema = z.strictObject({
  palette: z.array(hexColorSchema).min(1).max(MAX_PALETTE_TOKENS),
  fonts: brandFontSetSchema,
  logoAssetId: logoAssetIdSchema.optional(),
  toneWords: z.array(toneWordSchema).max(MAX_TONE_WORDS).optional(),
});

// ---------------------------------------------------------------------------
// DEFAULT_BRAND — the §7.5 template-default fallback
// ---------------------------------------------------------------------------

/**
 * Neutral brand kit used when a workspace has no (usable) brand tokens —
 * §7.5: "palette and fonts come from workspace brand tokens with template
 * defaults as fallback". Deliberately hue-free: a grayscale ramp can never
 * fight a brand, and §11.1 `color_out_of_palette` stays meaningful. Fonts are
 * generic CSS family names so the fallback never requires an install (§7.5:
 * "no template that requires external fonts not present at runtime"). No logo
 * (a default logo is meaningless); a neutral tone for the §5.4 style guide.
 */
export const DEFAULT_BRAND: BrandTokens = {
  palette: ["#111111", "#333333", "#666666", "#999999", "#CCCCCC", "#FFFFFF"],
  fonts: { display: "sans-serif", sans: "sans-serif", serif: "serif", mono: "monospace" },
  toneWords: ["clean", "modern", "neutral"],
};
