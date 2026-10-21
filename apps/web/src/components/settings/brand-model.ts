// apps/web — pure brand-token editor model (W8-L).
//
// MIRROR NOTICE: this module mirrors the CANONICAL BrandTokens contract in
// packages/agent/src/brand/tokens.ts (owner W7-F) — the same §7.5/§10.2 caps
// (palette ≤ 10 canonical `#RRGGBB`, four §5.5 font roles, optional logo asset
// id, ≤ 8 tone words). It is duplicated rather than imported because apps/web
// only bundles @studio/config through transpilePackages (W8-A decision) and
// @studio/agent is server-side TS source. TODO(sync, contract wave): import
// the schemas from the agent package once it is compiled into the browser
// bundle — until then keep both sides in lockstep, byte-for-byte on limits.
//
// Editor-state model (distinct from the wire value):
//  - `BrandTokensDraft` keeps RAW text inputs (untrimmed, possibly invalid)
//    so typing "#aabb" mid-edit is never "corrected" under the user's cursor;
//  - `validateBrandDraft` computes per-field problems (rendered inline);
//  - `canonicalBrandDraft` is the save gate: it only runs on a valid draft
//    and emits exactly the canonical shape the agent consumes (§5.4 cache
//    stability: equal brands serialize to equal bytes).

// ---------------------------------------------------------------------------
// Contract mirrors (packages/agent/src/brand/tokens.ts)
// ---------------------------------------------------------------------------

/** §5.5 typography roles — the only font slots a brand set defines. */
export const FONT_ROLES = ["display", "sans", "serif", "mono"] as const;

export type FontRole = (typeof FONT_ROLES)[number];

/** Task contract: palette is hex[] with at most 10 tokens. */
export const MAX_PALETTE_TOKENS = 10;

/** Task contract: toneWords is string[] with at most 8 words. */
export const MAX_TONE_WORDS = 8;

/** Font-name cap (mirrors the observer's 64-char clip; §5.4 stability). */
export const MAX_FONT_NAME_CHARS = 64;

/** One tone word cap. */
export const MAX_TONE_WORD_CHARS = 64;

/** Asset id cap (bounds seam traffic only; §6.1 ids are echoed nowhere). */
export const MAX_LOGO_ASSET_ID_CHARS = 64;

/** Fonts by §5.5 role — registry family NAMES (never files or paths). */
export interface BrandFontSet {
  readonly display?: string;
  readonly sans?: string;
  readonly serif?: string;
  readonly mono?: string;
}

/** The workspace brand kit (§7.5/§10.2) — canonical wire value. */
export interface BrandTokens {
  readonly palette: readonly string[];
  readonly fonts: BrandFontSet;
  readonly logoAssetId?: string;
  readonly toneWords?: readonly string[];
}

/**
 * §7.5 template-default fallback — used when a workspace has no (usable)
 * brand tokens. Hue-free grayscale + generic CSS families so the fallback
 * never requires a font install (byte-mirror of DEFAULT_BRAND upstream).
 */
export const DEFAULT_BRAND: BrandTokens = {
  palette: ["#111111", "#333333", "#666666", "#999999", "#CCCCCC", "#FFFFFF"],
  fonts: { display: "sans-serif", sans: "sans-serif", serif: "serif", mono: "monospace" },
  toneWords: ["clean", "modern", "neutral"],
};

// ---------------------------------------------------------------------------
// Hex normalization (canonical form → cache-stable §5.4 bytes)
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * `#RGB`/`#RRGGBB` → uppercase `#RRGGBB` (3-digit expanded); anything else →
 * undefined. Pure + total: never throws, never guesses (mirror of the agent's
 * normalizeHex — byte-identical behaviour).
 */
export function normalizeHex(value: string): string | undefined {
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) {
    return undefined;
  }
  const digits = trimmed.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => `${d}${d}`).join("") : digits;
  return `#${full.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Draft (editor state) + validation
// ---------------------------------------------------------------------------

/** Mutable editor state — raw text inputs, validated by `validateBrandDraft`. */
export interface BrandTokensDraft {
  /** Raw palette rows as typed (order preserved). */
  readonly palette: readonly string[];
  /** Raw font names per role; "" leaves the role unbound. */
  readonly fonts: Readonly<Record<FontRole, string>>;
  /** Raw logo asset id; "" clears the logo. */
  readonly logoAssetId: string;
  /** Raw tone words as typed (trimmed into wire form on save). */
  readonly toneWords: readonly string[];
}

/** One inline validation problem, bound to the field (and row) that caused it. */
export interface BrandProblem {
  /** Draft field the problem belongs to. */
  readonly field: "palette" | "fonts" | "logoAssetId" | "toneWords";
  /** Row index for palette/toneWords problems; role for fonts problems. */
  readonly index: number | FontRole;
  readonly message: string;
}

export interface BrandDraftValidation {
  /** Every problem found — render these inline; empty means the draft saves. */
  readonly problems: readonly BrandProblem[];
  /** True when `canonicalBrandDraft` would succeed (no problems at all). */
  readonly canSave: boolean;
}

function hexProblem(index: number, value: string): BrandProblem {
  const trimmed = value.trim();
  return {
    field: "palette",
    index,
    message:
      trimmed === ""
        ? "Enter a colour as #RGB or #RRGGBB hex."
        : `"${trimmed.slice(0, 24)}" is not a #RGB or #RRGGBB hex colour.`,
  };
}

/**
 * Validate a draft against the mirrored contract:
 *  - palette: 1..10 rows, every row valid hex, no duplicates after
 *    normalization (duplicates waste palette slots and blur §11.1's
 *    color_out_of_palette signal — surfaced as a problem, not silently fixed);
 *  - fonts: every non-empty role 1..64 chars after trim (empty = unbound);
 *  - logoAssetId: empty or 1..64 chars after trim;
 *  - toneWords: ≤ 8 rows, each 1..64 chars after trim, no duplicates.
 */
export function validateBrandDraft(draft: BrandTokensDraft): BrandDraftValidation {
  const problems: BrandProblem[] = [];

  if (draft.palette.length === 0) {
    problems.push({ field: "palette", index: 0, message: "Keep at least one palette colour." });
  }
  const seen = new Set<string>();
  draft.palette.forEach((value, index) => {
    const canonical = normalizeHex(value);
    if (canonical === undefined) {
      problems.push(hexProblem(index, value));
      return;
    }
    if (seen.has(canonical)) {
      problems.push({
        field: "palette",
        index,
        message: "Duplicate colour — remove it to keep the palette tight.",
      });
      return;
    }
    seen.add(canonical);
  });
  if (draft.palette.length > MAX_PALETTE_TOKENS) {
    problems.push({
      field: "palette",
      index: draft.palette.length - 1,
      message: `At most ${MAX_PALETTE_TOKENS} palette colours.`,
    });
  }

  for (const role of FONT_ROLES) {
    const value = draft.fonts[role].trim();
    if (value !== "" && value.length > MAX_FONT_NAME_CHARS) {
      problems.push({
        field: "fonts",
        index: role,
        message: `Font names are at most ${MAX_FONT_NAME_CHARS} characters.`,
      });
    }
  }

  const logoId = draft.logoAssetId.trim();
  if (logoId !== "" && logoId.length > MAX_LOGO_ASSET_ID_CHARS) {
    problems.push({
      field: "logoAssetId",
      index: 0,
      message: `Logo asset ids are at most ${MAX_LOGO_ASSET_ID_CHARS} characters.`,
    });
  }

  if (draft.toneWords.length > MAX_TONE_WORDS) {
    problems.push({
      field: "toneWords",
      index: draft.toneWords.length - 1,
      message: `At most ${MAX_TONE_WORDS} tone words.`,
    });
  }
  const seenTone = new Set<string>();
  draft.toneWords.forEach((value, index) => {
    const word = value.trim();
    if (word === "") {
      return; // empty rows are dropped at canonicalization, not an error
    }
    if (word.length > MAX_TONE_WORD_CHARS) {
      problems.push({
        field: "toneWords",
        index,
        message: `Tone words are at most ${MAX_TONE_WORD_CHARS} characters.`,
      });
      return;
    }
    const key = word.toLowerCase();
    if (seenTone.has(key)) {
      problems.push({ field: "toneWords", index, message: "Duplicate tone word." });
      return;
    }
    seenTone.add(key);
  });

  return { problems, canSave: problems.length === 0 };
}

export type CanonicalBrandDraftResult =
  | { readonly ok: true; readonly value: BrandTokens }
  | { readonly ok: false; readonly validation: BrandDraftValidation };

/**
 * Save gate: canonicalize a VALID draft into the exact BrandTokens wire shape
 * (palette normalized to uppercase #RRGGBB, unbound roles omitted, empty
 * logoAssetId/toneWords omitted). Invalid drafts return the validation.
 */
export function canonicalBrandDraft(draft: BrandTokensDraft): CanonicalBrandDraftResult {
  const validation = validateBrandDraft(draft);
  if (!validation.canSave) {
    return { ok: false, validation };
  }

  const boundFonts: BrandFontSet = {};
  for (const role of FONT_ROLES) {
    const name = draft.fonts[role].trim();
    if (name !== "") {
      boundFonts[role] = name;
    }
  }

  const toneWords = draft.toneWords.map((word) => word.trim()).filter((word) => word !== "");
  const logoAssetId = draft.logoAssetId.trim();

  return {
    ok: true,
    value: {
      palette: draft.palette.map((value) => normalizeHex(value) as string),
      fonts: boundFonts,
      ...(logoAssetId !== "" ? { logoAssetId } : {}),
      ...(toneWords.length > 0 ? { toneWords } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Wire → draft seeding
// ---------------------------------------------------------------------------

/**
 * Leniently coerce the opaque `brand_tokens` record the gateway stores into a
 * usable BrandTokens value (§7.5 drop-with-warning semantics, client side):
 * valid pieces are kept, invalid pieces are dropped, and missing pieces fall
 * back to DEFAULT_BRAND pieces. Never throws — a broken record seeds the
 * editor with sane defaults instead of a dead page.
 */
export function coerceBrandTokens(raw: unknown): BrandTokens {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_BRAND;
  }
  const source = raw as Record<string, unknown>;

  const palette: string[] = [];
  if (Array.isArray(source.palette)) {
    for (const entry of source.palette) {
      const canonical = typeof entry === "string" ? normalizeHex(entry) : undefined;
      if (canonical !== undefined && !palette.includes(canonical)) {
        palette.push(canonical);
      }
      if (palette.length === MAX_PALETTE_TOKENS) {
        break;
      }
    }
  }

  const fonts: BrandFontSet = {};
  if (typeof source.fonts === "object" && source.fonts !== null) {
    const fontsRaw = source.fonts as Record<string, unknown>;
    for (const role of FONT_ROLES) {
      const value = fontsRaw[role];
      if (typeof value !== "string") {
        continue;
      }
      const name = value.trim();
      if (name !== "" && name.length <= MAX_FONT_NAME_CHARS) {
        fonts[role] = name;
      }
    }
  }

  const toneWords: string[] = [];
  if (Array.isArray(source.toneWords)) {
    for (const entry of source.toneWords) {
      if (typeof entry !== "string") {
        continue;
      }
      const word = entry.trim();
      if (word !== "" && word.length <= MAX_TONE_WORD_CHARS && !toneWords.includes(word)) {
        toneWords.push(word);
      }
      if (toneWords.length === MAX_TONE_WORDS) {
        break;
      }
    }
  }

  const logoRaw = typeof source.logoAssetId === "string" ? source.logoAssetId.trim() : "";
  const logoAssetId =
    logoRaw !== "" && logoRaw.length <= MAX_LOGO_ASSET_ID_CHARS ? logoRaw : undefined;

  return {
    palette: palette.length > 0 ? palette : DEFAULT_BRAND.palette,
    fonts,
    ...(logoAssetId !== undefined ? { logoAssetId } : {}),
    ...(toneWords.length > 0 ? { toneWords } : {}),
  };
}

/** Seed an editable draft from a (possibly absent) wire value. */
export function brandTokensToDraft(tokens: BrandTokens): BrandTokensDraft {
  return {
    palette: [...tokens.palette],
    fonts: {
      display: tokens.fonts.display ?? "",
      sans: tokens.fonts.sans ?? "",
      serif: tokens.fonts.serif ?? "",
      mono: tokens.fonts.mono ?? "",
    },
    logoAssetId: tokens.logoAssetId ?? "",
    toneWords: [...(tokens.toneWords ?? [])],
  };
}

/**
 * Dirty check against the CURRENT canonical value: a draft is dirty when its
 * canonicalization differs from the seeded tokens. Invalid drafts count as
 * dirty (something was typed) — the save button is gated by validity instead.
 */
export function isDraftDirty(draft: BrandTokensDraft, tokens: BrandTokens): boolean {
  const canonical = canonicalBrandDraft(draft);
  const value = canonical.ok ? canonical.value : null;
  const current: BrandTokens = {
    palette: tokens.palette,
    fonts: tokens.fonts,
    ...(tokens.logoAssetId !== undefined ? { logoAssetId: tokens.logoAssetId } : {}),
    ...(tokens.toneWords !== undefined ? { toneWords: tokens.toneWords } : {}),
  };
  return value === null || JSON.stringify(value) !== JSON.stringify(current);
}
