// @studio/agent/brand/service — BrandTokensService over injected seams.
// Owner: W7-F (docs/AGENTS.md): this directory is the ONLY surface owned.
//
// Spec anchors:
//   §7.5 (last rule)  "palette and fonts come from workspace brand tokens with
//                      template defaults as fallback" — get() merges
//                      org.metadata.brandTokens over DEFAULT_BRAND (org wins
//                      per field; fonts win per §5.5 role). Invalid input is
//                      DROPPED WITH A WARNING, never a hard failure: brand
//                      tokens can never block a run.
//   §5.4 (2)          the style guide section — "workspace brand tokens
//                      (palette, fonts, tone), cached per workspace".
//                      toStyleGuide() renders THE section-2 text block with
//                      observer/context.ts's canonicalStringify and in the
//                      exact shape its buildStyleGuide() projects, so the
//                      block is byte-identical to the assembled §5.4 section
//                      and the §5.3 provider cache prefix stays stable.
//   §10.2             "Fonts: workspace font set only; a missing font is an
//                      error with an install hint, never a silent
//                      substitution" — validateFontUse() is that gate
//                      (code `missing_font`, the §11.1 blocker).
//   §22 / AGENTS.md   typed result envelopes `{ ok:false, code, message,
//                      hint, retryable }`; never throw strings; warnings and
//                      messages never leak internal ids, stack traces or
//                      absolute paths.
//
// Seams (minimal on purpose, fleet policy — cf. validator/service.ts):
//   - orgLookup(organizationId) → the organization row's `metadata` (a TEXT
//     column of JSON, packages/db/src/schema/auth.ts — Better Auth keeps
//     plan/branding extras there) or null when the org is unknown.
//   - assetLookup(assetId) → the asset row (existence check for logoAssetId)
//     or null. The worker wires the real db; tests wire fakes.
//
// The service is stateless by design: the worker/run caches the resolution
// (§5.4 "cached per workspace") and the style-guide block rides the provider
// cache prefix; a memo here would hide mid-session brand edits.

import {
  type ContextSectionId,
  type Rec,
  type StyleGuideInput,
  asRecord,
  canonicalStringify,
  clip,
  finalizeWarnings,
} from "../observer/context.js";
import {
  type BrandFontSet,
  type BrandTokens,
  type FontRole,
  DEFAULT_BRAND,
  FONT_ROLES,
  MAX_FONT_NAME_CHARS,
  MAX_PALETTE_TOKENS,
  MAX_TONE_WORDS,
  brandFontNameSchema,
  brandTokensSchema,
  hexColorSchema,
  logoAssetIdSchema,
  toneWordSchema,
} from "./tokens.js";

// ---------------------------------------------------------------------------
// Error catalog (§11.1 blocker code; errors.ts is W1-P's, add-only — kept
// local like transactions/manager.ts, flagged for adoption in the barrel)
// ---------------------------------------------------------------------------

/** Stable brand-module error codes. Add-only: never rename or reuse. */
export const BRAND_ERROR_CODES = ["missing_font"] as const satisfies readonly string[];

export type BrandErrorCode = (typeof BRAND_ERROR_CODES)[number];

/** AGENTS.md failure envelope shape (local twin of errors.ts AgentFailure). */
export interface BrandFailure {
  readonly ok: false;
  readonly code: BrandErrorCode;
  readonly message: string;
  readonly hint: string;
  readonly retryable: false;
}

/** A font use that resolved to an installed workspace font. */
export interface BrandFontResolution {
  readonly ok: true;
  /** Canonical registry casing of the resolved font name. */
  readonly font: string;
  /** "brand_role" — a §5.5 role reference resolved through tokens.fonts;
   *  "registry" — a concrete name found in the workspace font set. */
  readonly via: "brand_role" | "registry";
  /** The §5.5 role when `via` is "brand_role". */
  readonly role?: FontRole;
}

export type BrandFontCheck = BrandFontResolution | BrandFailure;

// ---------------------------------------------------------------------------
// Seams + resolution contracts
// ---------------------------------------------------------------------------

/** Minimal seams over packages/db (organization row, asset existence). */
export interface BrandSeams {
  /** The organization (workspace) row's metadata TEXT column, or null. */
  orgLookup(organizationId: string): Promise<{ readonly metadata: string | null | undefined } | null>;
  /** The workspace asset row (logo existence check), or null. */
  assetLookup(assetId: string): Promise<{ readonly id: string } | null>;
}

export type BrandTokensSource = "organization" | "default";

/** get()'s outcome: canonical tokens, §22-safe warnings, where they came from. */
export interface BrandTokensResolution {
  readonly tokens: BrandTokens;
  readonly warnings: readonly string[];
  /** "organization" when ≥1 org-supplied field was usable; else the defaults. */
  readonly source: BrandTokensSource;
}

export interface BrandTokensServiceOptions {
  readonly seams: BrandSeams;
}

// ---------------------------------------------------------------------------
// Style-guide payload (§5.4 item 2) — byte-parity with observer/context.ts
// ---------------------------------------------------------------------------

/** The §5.4 section id this module renders ("style_guide"). */
export const STYLE_GUIDE_SECTION_ID: ContextSectionId = "style_guide";

/** context.ts clips the style-guide tone at 1 000 chars (§5.4 compactness). */
const MAX_TONE_CHARS = 1_000;

/** Font examples listed in the §10.2 install hint. */
const MAX_INSTALL_HINT_EXAMPLES = 3;

/**
 * Bytewise comparator — mirrors context.ts's private `compareStrings` so the
 * fonts list keeps the same relative order in both surfaces (§5.4 stability).
 */
function compareBytewise(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The §5.4 style-guide input for `tokens`: palette as stable token names
 * (`color1..colorN` — positional, since org palettes carry no semantics),
 * fonts as the deduped, bytewise-sorted role values, tone as the joined
 * tone words. Field order is irrelevant — the section bytes are canonical.
 */
export function buildStyleGuidePayload(tokens: BrandTokens): StyleGuideInput {
  const palette: Record<string, string> = {};
  let index = 0;
  for (const hex of tokens.palette) {
    if (index >= MAX_PALETTE_TOKENS) break;
    index += 1;
    palette[`color${index}`] = hex;
  }
  const fontSet = new Set<string>();
  for (const role of FONT_ROLES) {
    const name = tokens.fonts[role];
    if (name !== undefined && name.trim().length > 0) {
      fontSet.add(clip(name.trim(), MAX_FONT_NAME_CHARS));
    }
  }
  const fonts = [...fontSet].sort(compareBytewise);
  const toneWords = tokens.toneWords ?? [];
  const payload: { palette?: Record<string, string>; fonts?: string[]; tone?: string } = {};
  if (Object.keys(palette).length > 0) payload.palette = palette;
  if (fonts.length > 0) payload.fonts = fonts;
  if (toneWords.length > 0) {
    payload.tone = clip(
      toneWords.map((word) => word.trim()).join(", "),
      MAX_TONE_CHARS,
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Org metadata projection (defensive readers: never throw, never guess)
// ---------------------------------------------------------------------------

/** What survived validation of org.metadata.brandTokens (all optional). */
interface ProjectedOrgTokens {
  readonly palette?: readonly string[];
  readonly fonts?: BrandFontSet;
  readonly logoAssetId?: string;
  readonly toneWords?: readonly string[];
}

/** metadata TEXT → parsed record; absent/empty metadata is normal (no warning). */
function parseMetadataRecord(
  value: string | null | undefined,
  warnings: string[],
): Rec | undefined {
  if (value === null || value === undefined || value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    warnings.push("brand tokens: organization metadata is not valid JSON; defaults applied");
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    warnings.push("brand tokens: organization metadata is not an object; defaults applied");
    return undefined;
  }
  return record;
}

/**
 * Per-field projection of org.metadata.brandTokens through the granular zod
 * schemas: bad entries are DROPPED WITH WARNINGS (§7.5 fallback posture),
 * duplicates removed, palette capped at the first MAX_PALETTE_TOKENS valid
 * entries. Returns undefined when the org supplied nothing usable.
 */
function projectOrgBrandTokens(raw: Rec, warnings: string[]): ProjectedOrgTokens | undefined {
  const record = asRecord(raw.brandTokens);
  if (record === undefined) {
    if (raw.brandTokens !== undefined) {
      warnings.push("brand tokens: metadata.brandTokens is not an object; defaults applied");
    }
    return undefined;
  }
  let usable = false;
  const projected: {
    palette?: readonly string[];
    fonts?: BrandFontSet;
    logoAssetId?: string;
    toneWords?: readonly string[];
  } = {};

  // Palette: validate → dedupe → cap (order matters; the cap counts survivors).
  const rawPalette = record.palette;
  if (rawPalette !== undefined) {
    if (Array.isArray(rawPalette)) {
      const valid: string[] = [];
      const seen = new Set<string>();
      let invalid = 0;
      let duplicates = 0;
      for (const entry of rawPalette) {
        const parsed = hexColorSchema.safeParse(entry);
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        if (seen.has(parsed.data)) {
          duplicates += 1;
          continue;
        }
        seen.add(parsed.data);
        valid.push(parsed.data);
      }
      if (invalid > 0) {
        warnings.push(
          `brand tokens: palette dropped ${invalid} invalid hex ${invalid === 1 ? "entry" : "entries"}`,
        );
      }
      if (duplicates > 0) {
        warnings.push(
          `brand tokens: palette dropped ${duplicates} duplicate ${duplicates === 1 ? "entry" : "entries"}`,
        );
      }
      if (valid.length > MAX_PALETTE_TOKENS) {
        warnings.push(
          `brand tokens: palette limited to first ${MAX_PALETTE_TOKENS} of ${valid.length} entries`,
        );
      }
      const kept = valid.slice(0, MAX_PALETTE_TOKENS);
      if (kept.length > 0) {
        projected.palette = kept;
        usable = true;
      }
    } else {
      warnings.push("brand tokens: palette is not an array; default palette applied");
    }
  }

  // Fonts: per-§5.5-role; unknown roles ignored (strict contract).
  const rawFonts = record.fonts;
  if (rawFonts !== undefined) {
    const fontsRecord = asRecord(rawFonts);
    if (fontsRecord === undefined) {
      warnings.push("brand tokens: fonts is not an object; default fonts applied");
    } else {
      const fonts: {
        display?: string;
        sans?: string;
        serif?: string;
        mono?: string;
      } = {};
      let dropped = 0;
      for (const role of FONT_ROLES) {
        const value = fontsRecord[role];
        if (value === undefined) continue;
        const parsed = brandFontNameSchema.safeParse(value);
        if (!parsed.success) {
          dropped += 1;
          continue;
        }
        fonts[role] = parsed.data;
      }
      let unknownRoles = 0;
      for (const key of Object.keys(fontsRecord)) {
        if (!(FONT_ROLES as readonly string[]).includes(key)) unknownRoles += 1;
      }
      if (dropped > 0) {
        warnings.push(
          `brand tokens: fonts dropped ${dropped} unreadable role ${dropped === 1 ? "value" : "values"}`,
        );
      }
      if (unknownRoles > 0) {
        warnings.push(
          `brand tokens: fonts ignored ${unknownRoles} unknown role ${unknownRoles === 1 ? "key" : "keys"}`,
        );
      }
      if (Object.keys(fonts).length > 0) {
        projected.fonts = fonts;
        usable = true;
      }
    }
  }

  // Logo: must parse; existence verified through the asset seam in get().
  const rawLogo = record.logoAssetId;
  if (rawLogo !== undefined) {
    const parsed = logoAssetIdSchema.safeParse(rawLogo);
    if (parsed.success) {
      projected.logoAssetId = parsed.data;
      usable = true;
    } else {
      warnings.push("brand tokens: logoAssetId unreadable; dropped");
    }
  }

  // Tone words: validate → dedupe → cap, mirroring the palette pipeline.
  const rawTone = record.toneWords;
  if (rawTone !== undefined) {
    if (Array.isArray(rawTone)) {
      const words: string[] = [];
      const seen = new Set<string>();
      let invalid = 0;
      let duplicates = 0;
      for (const entry of rawTone) {
        const parsed = toneWordSchema.safeParse(entry);
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        if (seen.has(parsed.data)) {
          duplicates += 1;
          continue;
        }
        seen.add(parsed.data);
        words.push(parsed.data);
      }
      if (invalid > 0) {
        warnings.push(
          `brand tokens: toneWords dropped ${invalid} invalid ${invalid === 1 ? "word" : "words"}`,
        );
      }
      if (duplicates > 0) {
        warnings.push(
          `brand tokens: toneWords dropped ${duplicates} duplicate ${duplicates === 1 ? "word" : "words"}`,
        );
      }
      if (words.length > MAX_TONE_WORDS) {
        warnings.push(
          `brand tokens: toneWords limited to first ${MAX_TONE_WORDS} of ${words.length} words`,
        );
      }
      const kept = words.slice(0, MAX_TONE_WORDS);
      if (kept.length > 0) {
        projected.toneWords = kept;
        usable = true;
      }
    } else {
      warnings.push("brand tokens: toneWords is not an array; default tone applied");
    }
  }

  return usable ? projected : undefined;
}

/** §7.5 merge: org wins per field; fonts win per §5.5 role; arrays never mix. */
function mergeTokens(org: ProjectedOrgTokens, logoAssetId: string | undefined): BrandTokens {
  return {
    palette: org.palette !== undefined ? org.palette : DEFAULT_BRAND.palette,
    fonts: { ...DEFAULT_BRAND.fonts, ...org.fonts },
    ...(logoAssetId !== undefined ? { logoAssetId } : {}),
    toneWords: org.toneWords !== undefined ? org.toneWords : DEFAULT_BRAND.toneWords,
  };
}

// ---------------------------------------------------------------------------
// Font-registry matching (§10.2)
// ---------------------------------------------------------------------------

/** Case-insensitive exact match; returns the registry's canonical casing. */
function matchRegistryFont(name: string, registry: readonly string[]): string | undefined {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  for (const entry of registry) {
    if (entry.trim().toLowerCase() === needle) return entry;
  }
  return undefined;
}

/** `install "X" in the workspace fonts, or pick an installed font (e.g. …)` —
 *  mirrors the tools validator's §10.2 hint; names only, never paths. */
function installHint(font: string, registry: readonly string[]): string {
  const shown = clip(font.trim(), MAX_FONT_NAME_CHARS);
  const examples = registry
    .filter((entry) => entry.trim().length > 0)
    .slice(0, MAX_INSTALL_HINT_EXAMPLES)
    .map((entry) => `"${clip(entry.trim(), 32)}"`)
    .join(", ");
  const tail = examples.length > 0 ? ` (e.g. ${examples})` : "";
  return `install "${shown}" in the workspace fonts, or pick an installed font${tail}`;
}

function missingFontFailure(font: string, registry: readonly string[]): BrandFailure {
  const shown = clip(font.trim(), MAX_FONT_NAME_CHARS);
  return {
    ok: false,
    code: "missing_font",
    message: `font "${shown}" is not in the workspace font set`,
    hint: installHint(shown, registry),
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// BrandTokensService
// ---------------------------------------------------------------------------

/**
 * The workspace brand service: resolve tokens for an organization (§7.5),
 * gate font uses against the workspace font set (§10.2), and render the §5.4
 * section-2 style-guide block. Pure/deterministic apart from the two read
 * seams; never throws for bad brand data — it degrades to DEFAULT_BRAND with
 * warnings.
 */
export class BrandTokensService {
  private readonly seams: BrandSeams;

  constructor(options: BrandTokensServiceOptions) {
    const seams = options?.seams;
    if (
      typeof seams !== "object" ||
      seams === null ||
      typeof seams.orgLookup !== "function" ||
      typeof seams.assetLookup !== "function"
    ) {
      // Fail fast on hand-built deps (fleet precedent: RunValidator ctor).
      throw new TypeError("BrandTokensService: seams.orgLookup/assetLookup must be functions");
    }
    this.seams = seams;
  }

  /**
   * Resolve the workspace brand tokens (§7.5): merge org.metadata.brandTokens
   * over DEFAULT_BRAND — org wins per field (fonts per role); bad hex dropped
   * with a warning; palette capped at the first 10 valid entries; a stale
   * logoAssetId (asset seam miss) dropped. Never fails: any problem degrades
   * to DEFAULT_BRAND with §22-safe warnings.
   */
  async get(organizationId: string): Promise<BrandTokensResolution> {
    const warnings: string[] = [];
    const metadata = await this.lookupOrganization(organizationId, warnings);
    const orgTokens =
      metadata === undefined ? undefined : projectOrgBrandTokens(metadata, warnings);
    if (orgTokens === undefined) {
      return { tokens: DEFAULT_BRAND, warnings: finalizeWarnings(warnings), source: "default" };
    }
    let logoAssetId = orgTokens.logoAssetId;
    if (logoAssetId !== undefined) {
      logoAssetId = await this.verifyLogoAsset(logoAssetId, warnings);
    }
    const merged = mergeTokens(orgTokens, logoAssetId);
    // Invariant gate (defense in depth — the merge cannot produce invalid
    // tokens; if it ever does, §7.5 still guarantees a runnable fallback).
    const parsed = brandTokensSchema.safeParse(merged);
    if (!parsed.success) {
      warnings.push("brand tokens: merged tokens failed the canonical schema; defaults applied");
      return { tokens: DEFAULT_BRAND, warnings: finalizeWarnings(warnings), source: "default" };
    }
    return {
      tokens: parsed.data,
      warnings: finalizeWarnings(warnings),
      source: "organization",
    };
  }

  /**
   * §10.2 font gate: a proposed font use must resolve inside the workspace
   * font set — either a concrete name present in the registry, or a §5.5 role
   * reference ("display"…) bound through tokens.fonts to a registry name.
   * Anything else is `{ ok:false, code:"missing_font" }` with an install hint
   * — never a silent substitution.
   */
  validateFontUse(font: string, tokens: BrandTokens, registry: readonly string[]): BrandFontCheck {
    const proposed = typeof font === "string" ? font.trim() : "";
    if (proposed.length === 0 || proposed.length > MAX_FONT_NAME_CHARS) {
      return missingFontFailure(proposed, registry);
    }
    const lowered = proposed.toLowerCase();
    const role = FONT_ROLES.find((candidate) => candidate === lowered);
    if (role !== undefined) {
      const brandFont = tokens.fonts[role];
      if (brandFont === undefined) {
        const examples = registry
          .slice(0, MAX_INSTALL_HINT_EXAMPLES)
          .map((entry) => `"${clip(entry.trim(), 32)}"`)
          .join(", ");
        const tail = examples.length > 0 ? ` (e.g. ${examples})` : "";
        return {
          ok: false,
          code: "missing_font",
          message: `brand font role "${role}" has no font in the workspace brand tokens`,
          hint: `bind a workspace font to brand role "${role}" in workspace brand settings, or pick an installed font${tail}`,
          retryable: false,
        };
      }
      const resolved = matchRegistryFont(brandFont, registry);
      if (resolved === undefined) {
        return {
          ok: false,
          code: "missing_font",
          message: `brand font "${clip(brandFont, MAX_FONT_NAME_CHARS)}" (role "${role}") is not in the workspace font set`,
          hint: installHint(brandFont, registry),
          retryable: false,
        };
      }
      return { ok: true, font: resolved, via: "brand_role", role };
    }
    const resolved = matchRegistryFont(proposed, registry);
    if (resolved === undefined) {
      return missingFontFailure(proposed, registry);
    }
    return { ok: true, font: resolved, via: "registry" };
  }

  /**
   * The §5.4 section-2 text block for these tokens: canonical JSON (sorted
   * keys) of the style-guide payload + section id — byte-identical to what
   * ContextAssembler emits for the equivalent StyleGuideInput, so the block
   * (and the provider cache prefix hashing it) is stable per workspace.
   */
  toStyleGuide(tokens: BrandTokens): string {
    return canonicalStringify({
      ...buildStyleGuidePayload(tokens),
      section: STYLE_GUIDE_SECTION_ID,
    });
  }

  // -------------------------------------------------------------------------
  // Seam helpers (§22-safe warnings: no ids, no raw payload echoes)
  // -------------------------------------------------------------------------

  private async lookupOrganization(
    organizationId: string,
    warnings: string[],
  ): Promise<Rec | undefined> {
    if (typeof organizationId !== "string" || organizationId.trim().length === 0) {
      warnings.push("brand tokens: invalid organization id; defaults applied");
      return undefined;
    }
    let row: { readonly metadata: string | null | undefined } | null;
    try {
      row = await this.seams.orgLookup(organizationId);
    } catch {
      warnings.push("brand tokens: organization lookup failed; defaults applied");
      return undefined;
    }
    if (row === null) {
      warnings.push("brand tokens: organization not found; defaults applied");
      return undefined;
    }
    return parseMetadataRecord(row.metadata, warnings);
  }

  private async verifyLogoAsset(
    assetId: string,
    warnings: string[],
  ): Promise<string | undefined> {
    let asset: { readonly id: string } | null;
    try {
      asset = await this.seams.assetLookup(assetId);
    } catch {
      warnings.push("brand tokens: logo asset lookup failed; logoAssetId dropped");
      return undefined;
    }
    if (asset === null) {
      warnings.push("brand tokens: logo asset not found; logoAssetId dropped");
      return undefined;
    }
    return assetId;
  }
}
