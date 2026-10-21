// @studio/agent — §23.4 repair prompt, VERBATIM. Owner: W6-F (docs/AGENTS.md).
//
// Spec anchors:
//   §23.4  the repair prompt is reproduced EXACTLY here: intro line, `FIXES:`
//          (json array of critic/validator issues with layer, fix), `CONTEXT:`
//          (current layer tree, template manifest, palette, validator report)
//          and the four rules. The two placeholders are the ONLY things this
//          builder substitutes; the wording is data-blind by design so the
//          eval suite can pin the prompt byte-for-byte.
//   §5.1   "Repair narrowly" — the worker may call this at most
//          MAX_REPAIR_CYCLES (2, @studio/config) times per run; counting cycles
//          is the run manager's job, not the prompt's.
//   §11.2/§23.3 only blocker/major issues and at most 5 of them may appear in
//          a repair plan. planner.ts enforces that BEFORE this builder runs;
//          the builder re-checks the cap (≤ MAX_REPAIR_FIXES) as a belt-and-
//          braces guard so no caller can smuggle a 12-fix prompt through.
//   §15.3  every string that enters a model prompt is stripped of control
//          characters (zero-width + bidi included — Trojan Source defence);
//          buildRepairPrompt is the single choke point for repair prompts.
//
// Rule 3's reply contract ("applied":[{…,"result":"ok|failed"}]) describes the
// APPLYING phase; the PLANNING phase (planner.ts) appends its own reply
// contract after this prompt — this file stays the one source of §23.4 text
// so the executor phase (W6-B) can reuse it unmodified.
import { z } from "zod";

// --- §15.3 control-character stripping (model-facing strings only) --------------

// Biome-clean charCode table (no control-char regexes, W5 fleet convention):
// C0 minus tab/newline, C1, zero-width + bidi marks, BOM.
const STRIPPED_CODE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], // C0 control chars except \t (0x09)
  [0x0b, 0x0c], // vertical tab / form feed (\n = 0x0a is kept)
  [0x0e, 0x1f], // rest of C0
  [0x7f, 0x9f], // DEL + C1
  [0x200b, 0x200f], // zero width + LRM/RLM marks
  [0x202a, 0x202e], // bidi embedding overrides (Trojan Source)
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function isStrippableCode(code: number): boolean {
  for (const [low, high] of STRIPPED_CODE_RANGES) {
    if (code >= low && code <= high) {
      return true;
    }
  }
  return false;
}

/** §15.3: strip control characters (keep newlines/tabs), normalise CRLF→LF. */
export function stripControlChars(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    if (ch === "\r") {
      // CRLF → LF; a lone CR is a newline too (normalise instead of strip).
      if (raw[i + 1] === "\n") {
        continue; // drop the CR, the next iteration keeps the LF
      }
      out += "\n";
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (!isStrippableCode(code)) {
      out += ch;
    }
  }
  return out.trim();
}

// --- FIXES payload (§23.4: "issues with layer, fix") -------------------------------

/**
 * §23.3/§11.2: at most 5 issues per repair cycle. Also the critic's own cap
 * ("Maximum 5 issues"), so a compliant critique can never exceed it.
 */
export const MAX_REPAIR_FIXES = 5;

/**
 * One FIXES entry. §23.4's placeholder says "issues with layer, fix"; the code
 * rides along because rule 3's reply echoes `"issue":"code"` — without the code
 * in FIXES the model could not name the issue it fixed. Severity/observation
 * are deliberately NOT duplicated: the fix field is the actionable instruction
 * and the ≤5 list is already blocker/major-filtered, blockers first (planner).
 */
export const repairFixSchema = z.strictObject({
  code: z.string().min(1).max(100),
  layer: z.string().min(1).max(200).optional(),
  fix: z.string().min(1).max(500),
});

export type RepairFix = z.infer<typeof repairFixSchema>;

// --- CONTEXT payload (§23.4: layer tree, manifest, palette, validator report) -----

/** Caps mirror the critic input caps (§23.3 seam): summaries, never dumps. */
export const MAX_REPAIR_LAYER_TREE_CHARS = 4000;
export const MAX_REPAIR_MANIFEST_CHARS = 4000;
export const MAX_REPAIR_VALIDATOR_REPORT_CHARS = 2000;
export const MAX_REPAIR_PALETTE_ENTRIES = 10;

export const repairContextSchema = z.strictObject({
  /** Compact layer-tree summary (layer.list / workspace_snapshot). */
  layerTree: z.string().min(1).max(MAX_REPAIR_LAYER_TREE_CHARS),
  /** The chosen template's manifest, or absent when the doc is freeform. */
  manifest: z.string().max(MAX_REPAIR_MANIFEST_CHARS).optional(),
  /** Brand palette as hex colours, ≤ 10 entries (§23.3 seam shape). */
  palette: z.array(z.string().min(1).max(32)).max(MAX_REPAIR_PALETTE_ENTRIES).optional(),
  /** The deterministic validator report (§6 row 15); empty when it found nothing. */
  validatorReport: z.string().max(MAX_REPAIR_VALIDATOR_REPORT_CHARS).default(""),
});

export type RepairContext = z.infer<typeof repairContextSchema>;

// --- §23.4 text, verbatim -----------------------------------------------------------

/** §23.4 opening line, verbatim. */
export const REPAIR_INTRO_LINE =
  "A validated render has issues. Apply the minimum fixes; change nothing else.";

/** §23.4 section headers, verbatim. */
export const REPAIR_FIXES_HEADER = "FIXES:";
export const REPAIR_CONTEXT_HEADER = "CONTEXT:";

/** §23.4 "Rules:" block — the four rules, byte-for-byte. */
export const REPAIR_RULES_TEXT = [
  "Rules:",
  "- One fix at a time, smallest tool that works (text_set, layer_ops, style_apply, layout_apply).",
  "- Do not restructure, rename, add or delete layers unless a fix explicitly requires it.",
  "- After applying, call render_preview and validate_document; reply with JSON:",
  '  {"applied":[{"issue":"code","tool":"...","result":"ok|failed","note":"..."}]}',
  "- If a fix is impossible with available tools, say so and propose the closest valid",
  "  alternative; never leave the document in a worse state than before.",
].join("\n");

// --- The builder ---------------------------------------------------------------------

export interface BuildRepairPromptInput {
  readonly fixes: readonly RepairFix[];
  readonly context: RepairContext;
}

const buildRepairPromptInputSchema = z.strictObject({
  fixes: z.array(repairFixSchema).max(MAX_REPAIR_FIXES),
  context: repairContextSchema,
});

/**
 * Renders the §23.4 repair prompt EXACTLY: intro line, `FIXES:` + json array of
 * {code, layer?, fix} issues, `CONTEXT:` + one-line json object with the four
 * context parts, then the four rules verbatim.
 *
 * Purity notes:
 *   - All embedded strings pass §15.3 stripControlChars at this boundary.
 *   - The builder throws a plain `Error` (paths only, never values) on invalid
 *     input: it is a typed-seam programmer error, and every public async entry
 *     point (planner.planRepairs) validates first and returns typed envelopes.
 */
export function buildRepairPrompt(input: BuildRepairPromptInput): string {
  const parsed = buildRepairPromptInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`[agent/repair] buildRepairPrompt input invalid: ${issues.join("; ")}`);
  }
  const fixes = parsed.data.fixes.map((fix) => ({
    code: stripControlChars(fix.code),
    ...(fix.layer === undefined ? {} : { layer: stripControlChars(fix.layer) }),
    fix: stripControlChars(fix.fix),
  }));
  const context = parsed.data.context;
  // §23.4 lists the four context parts; the absent ones render as explicit
  // "none"/[] so the CONTEXT line always carries the same four keys.
  const contextJson = JSON.stringify({
    layerTree: stripControlChars(context.layerTree),
    manifest:
      context.manifest === undefined || context.manifest.length === 0
        ? "none"
        : stripControlChars(context.manifest),
    palette: context.palette === undefined ? [] : context.palette.map(stripControlChars),
    validatorReport: stripControlChars(context.validatorReport),
  });
  return [
    REPAIR_INTRO_LINE,
    "",
    REPAIR_FIXES_HEADER,
    JSON.stringify(fixes),
    "",
    `${REPAIR_CONTEXT_HEADER} ${contextJson}`,
    "",
    REPAIR_RULES_TEXT,
  ].join("\n");
}
