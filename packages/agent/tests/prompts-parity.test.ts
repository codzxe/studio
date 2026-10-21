// W6-L — prompt-library parity: packages/agent/prompts/** is the canonical, versioned
// store of the §23 prompts. This test pins the three-legged contract (§23: prompts are
// versioned, every change runs the eval suite — see v1/CHANGELOG.md for the §21
// evals-coupling note):
//
//   (1) library ↔ spec   — each v1/*.md fenced block equals the docs/BUILD_PROMPT.md
//                          §23.x block (byte-for-byte, LF-normalized; §23.1 modulo the
//                          per-line leading-whitespace artifact recorded in
//                          v1/CHANGELOG.md — the raw block hanging-indents 8 wrapped
//                          rule lines that the shipped W6-B template dedents).
//   (2) builder ↔ library — buildExecutorSystemPrompt / buildPlannerPrompt /
//                          buildRepairPrompt outputs equal the library templates with
//                          their documented slots substituted. The builders live in
//                          src/{executor,planner,repair}/prompt.ts and mirror these
//                          files; if one diverges structurally, the per-section
//                          comparisons below localize the drift (§23 section
//                          substrings — coarse but effective).
//   (3) frontmatter        — id matches the file name, version pinned, changelog entry
//                          present.
//
// Loading contract (see prompts/README.md): a loader extracts the fenced block exactly
// like `extractPromptBlock` below and substitutes slots with plain string replacement
// — no template engine, `${var}` never appears inside v1 prompt text.
//
// Deterministic, offline, <1s: the only I/O is reading repo files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXECUTOR_SYSTEM_PROMPT_TEMPLATE,
  TOOLS_BLOCK_HEADER,
  buildExecutorSystemPrompt,
} from "../src/executor/prompt.js";
import { type PlannerSections, buildPlannerPrompt } from "../src/planner/prompt.js";
import {
  REPAIR_CONTEXT_HEADER,
  REPAIR_FIXES_HEADER,
  REPAIR_INTRO_LINE,
  REPAIR_RULES_TEXT,
  type RepairContext,
  type RepairFix,
  buildRepairPrompt,
} from "../src/repair/prompt.js";

// --- file locations -------------------------------------------------------------

const LIB_DIR = fileURLToPath(new URL("../prompts/v1/", import.meta.url));
const SPEC_PATH = fileURLToPath(new URL("../../../docs/BUILD_PROMPT.md", import.meta.url));

/** The library: file name, frontmatter id, and the spec §23 heading it is extracted from. */
const LIBRARY = [
  { file: "system-executor.md", id: "system-executor", heading: "23.1 System prompt (executor)" },
  { file: "planner.md", id: "planner", heading: "23.2 Planner prompt" },
  { file: "critic.md", id: "critic", heading: "23.3 Critic prompt (vision)" },
  { file: "repair.md", id: "repair", heading: "23.4 Repair prompt" },
  {
    file: "chat-edit-classifier.md",
    id: "chat-edit-classifier",
    heading: "23.5 Chat-edit classifier (quick tier)",
  },
] as const;

function readLibrary(name: string): string {
  return readFileSync(`${LIB_DIR}${name}`, "utf8");
}

/**
 * Extracts a fenced ```text block (the prompt itself) and canonicalizes to LF.
 * This is the loading contract from prompts/README.md — a runtime loader reads the
 * exact same bytes.
 */
function extractPromptBlock(file: string): string {
  const open = file.indexOf("```text");
  const start = open + "```text".length;
  const end = file.indexOf("```", start);
  if (open < 0 || end < 0) {
    throw new Error(
      "prompt-library file has no ```text fenced prompt block — the `## Prompt` section is the prompt; see prompts/README.md",
    );
  }
  return file
    .slice(start, end)
    .replaceAll("\r\n", "\n")
    .replace(/^\n/, "")
    .replace(/\n$/, "");
}

/** The spec §23.x fenced block, LF-normalized (the pasted spec doc is CRLF-encoded). */
function specSection(heading: string): string {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const at = spec.indexOf(`### ${heading}`);
  if (at < 0) {
    throw new Error(
      `docs/BUILD_PROMPT.md no longer has a "### ${heading}" heading — if the spec moved, update SPEC_PATH in tests/prompts-parity.test.ts and the v1/CHANGELOG.md source refs`,
    );
  }
  const start = spec.indexOf("```text", at) + "```text".length;
  const end = spec.indexOf("```", start);
  return spec
    .slice(start, end)
    .replaceAll("\r\n", "\n")
    .replace(/^\n/, "")
    .replace(/\n$/, "");
}

/** TrimStart every line — the §23.1 comparison mode (hanging-indent artifact). */
function trimLeading(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
}

/** Plain string substitution — the same split/join the builders use (no regex pitfalls). */
function substitute(template: string, values: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

// --- (3) frontmatter invariants --------------------------------------------------

describe("prompt library v1 — frontmatter", () => {
  for (const { file, id } of LIBRARY) {
    it(`${file}: id/version/changelog pinned (§23 versioned prompts)`, () => {
      const raw = readLibrary(file);
      expect(raw.startsWith("---\n"), "file must open with YAML-ish frontmatter").toBe(true);
      const end = raw.indexOf("\n---\n", 3);
      expect(end, "frontmatter must be closed by a second --- line").toBeGreaterThan(0);
      const frontmatter = raw.slice(0, end);
      expect(frontmatter).toContain(`id: ${id}`);
      expect(frontmatter).toContain("version: 1");
      expect(frontmatter).toContain("changelog:");
      expect(frontmatter).toContain("§23");
      // Loading-contract hygiene (README): no template-engine syntax in v1 prompt text.
      expect(extractPromptBlock(raw)).not.toContain("${");
    });
  }
});

// --- (1) library ↔ spec §23 ------------------------------------------------------

describe("prompt library v1 — spec §23 parity", () => {
  for (const { file, heading } of LIBRARY) {
    const isExecutor = file === "system-executor.md";
    it(`${file} === spec §${heading}${isExecutor ? " (modulo per-line indents)" : " byte-for-byte"}`, () => {
      const lib = extractPromptBlock(readLibrary(file));
      const spec = specSection(heading);
      if (isExecutor) {
        // v1/CHANGELOG.md: the raw §23.1 block hanging-indents 8 wrapped rule lines
        // (3–4 spaces); the shipped W6-B template — and the library — dedent them.
        expect(trimLeading(lib)).toBe(trimLeading(spec));
      } else {
        expect(lib).toBe(spec);
      }
    });
  }
});

// --- (2a) executor builder ↔ library ----------------------------------------------

describe("prompt library v1 — executor builder parity (§23.1)", () => {
  const libraryTemplate = extractPromptBlock(readLibrary("system-executor.md"));
  const budget = { max_tool_calls: "12", max_revisions: "2", max_tokens: "80000" };
  /** The §23.1 rule-6 slots substituted into the LIBRARY text. */
  const bodyFromLibrary = substitute(libraryTemplate, budget);
  const input = {
    maxToolCalls: 12,
    maxRevisions: 2,
    maxTokens: 80_000,
  } as const;

  it("EXECUTOR_SYSTEM_PROMPT_TEMPLATE mirrors the library file byte-for-byte", () => {
    expect(EXECUTOR_SYSTEM_PROMPT_TEMPLATE).toBe(libraryTemplate);
  });

  it("buildExecutorSystemPrompt output equals the library template with slots substituted", () => {
    expect(buildExecutorSystemPrompt({ ...input, toolsManifest: [] })).toBe(bodyFromLibrary);
  });

  it("the tools manifest rides AFTER the library body, never inside it (§6.1)", () => {
    const tools = [{ name: "text_set", description: "Set editable text on a layer." }];
    const built = buildExecutorSystemPrompt({ ...input, toolsManifest: tools });
    expect(built).toBe(
      `${bodyFromLibrary}\n\n${TOOLS_BLOCK_HEADER}\n- text_set — Set editable text on a layer.`,
    );
    // The manifest block is runtime data: it must not leak into the cached template.
    expect(EXECUTOR_SYSTEM_PROMPT_TEMPLATE).not.toContain("text_set —");
  });
});

// --- (2b) planner builder ↔ library -----------------------------------------------

describe("prompt library v1 — planner builder parity (§23.2)", () => {
  const libraryTemplate = extractPromptBlock(readLibrary("planner.md"));

  const sections: PlannerSections = {
    brief: { prompt: "Coffee-shop promo post for Instagram, warm brand feel" },
    snapshot: { canvas: { widthPx: 1080, heightPx: 1080 }, palette: ["#F4E7D3", "#3B2A20"] },
    catalog: { tools: [{ name: "text_set", description: "Set editable text on a layer." }] },
    budget: { tier: "standard", toolCallCap: 12, revisions: 2 },
    rules: { checks: ["in_bounds", "contrast>=4.5"] },
  };

  /**
   * Renders the LIBRARY template per its documented slot contract: each
   * `- LABEL: {descriptor}` Inputs line carries the section's compact JSON block
   * (the descriptor itself is replaced — §23.2's braces describe the payload).
   */
  function renderFromLibrary(): string {
    const values: Record<string, unknown> = {
      BRIEF: sections.brief,
      SNAPSHOT: sections.snapshot,
      CATALOG: sections.catalog,
      BUDGET: sections.budget,
      RULES: sections.rules,
    };
    return libraryTemplate
      .split("\n")
      .map((line) => {
        const match = /^- (BRIEF|SNAPSHOT|CATALOG|BUDGET|RULES): /.exec(line);
        return match
          ? `- ${match[1]}: ${JSON.stringify(values[match[1]]) ?? "null"}`
          : line;
      })
      .join("\n");
  }

  it("carries exactly one labeled slot line per §23.2 Inputs section", () => {
    for (const label of ["BRIEF", "SNAPSHOT", "CATALOG", "BUDGET", "RULES"]) {
      // Plain split/join counting (no regex pitfalls, no off-line matches: the
      // slot tables live outside the fenced block we extracted).
      const occurrences = libraryTemplate.split(`- ${label}: `).length - 1;
      expect(occurrences, `expected exactly one "- ${label}: " slot line`).toBe(1);
    }
  });

  it("buildPlannerPrompt output equals the library template with the five sections interpolated", () => {
    expect(buildPlannerPrompt(sections)).toBe(renderFromLibrary());
  });
});

// --- (2c) repair builder ↔ library -------------------------------------------------

describe("prompt library v1 — repair builder parity (§23.4)", () => {
  const libraryLines = extractPromptBlock(readLibrary("repair.md")).split("\n");

  // Fixed sections lifted from the LIBRARY file (not from the builder constants —
  // the library is the source; the constants must mirror it). Loud guards so a
  // restructured §23.4 block fails with a message, not a confusing diff.
  const intro = libraryLines[0] ?? "";
  const fixesHeaderIndex = libraryLines.indexOf(REPAIR_FIXES_HEADER);
  const fixesHeaderLine = libraryLines[fixesHeaderIndex] ?? "";
  const fixesSlotLine = libraryLines[fixesHeaderIndex + 1] ?? "";
  const contextLine = libraryLines.find((line) => line.startsWith("CONTEXT: ")) ?? "";
  const rulesIndex = libraryLines.indexOf("Rules:");
  const rules = libraryLines.slice(Math.max(rulesIndex, 0)).join("\n");

  const fixes: RepairFix[] = [
    { code: "contrast_body", layer: "Subhead", fix: "text_set Subhead #3B2A20" },
  ];
  const context: RepairContext = {
    layerTree: "Background / Headline / Subhead",
    manifest: "instagram-post@3",
    palette: ["#3B2A20"],
    validatorReport: "",
  };

  it("§23.4 fixed sections: intro, FIXES:, CONTEXT:, and the four rules mirror the library", () => {
    expect(intro).toBe(REPAIR_INTRO_LINE);
    expect(fixesHeaderIndex, "library repair block lost its FIXES: header line").toBeGreaterThan(-1);
    expect(rulesIndex, "library repair block lost its Rules: block").toBeGreaterThan(-1);
    expect(rules).toBe(REPAIR_RULES_TEXT);
    expect(contextLine.startsWith(`${REPAIR_CONTEXT_HEADER} {`)).toBe(true);
    // The two slot markers survived verbatim (they are the interpolation contract).
    expect(fixesSlotLine).toBe("{json array of critic/validator issues with layer, fix}");
    expect(contextLine).toBe(
      "CONTEXT: {current layer tree, template manifest, palette, validator report}",
    );
  });

  it("buildRepairPrompt output equals the library template with its two slots substituted", () => {
    expect(fixesHeaderIndex).toBeGreaterThan(-1);
    expect(rulesIndex).toBeGreaterThan(-1);
    const built = buildRepairPrompt({ fixes, context });
    // Same context normalization the builder applies (§15.3-stripped clean strings are
    // identity): absent manifest→"none", absent palette→[], keys always in this order.
    const contextJson = JSON.stringify({
      layerTree: context.layerTree,
      manifest:
        context.manifest === undefined || context.manifest.length === 0
          ? "none"
          : context.manifest,
      palette: context.palette === undefined ? [] : context.palette,
      validatorReport: context.validatorReport,
    });
    const expected = [
      intro,
      "",
      fixesHeaderLine,
      JSON.stringify(fixes),
      "",
      `${REPAIR_CONTEXT_HEADER} ${contextJson}`,
      "",
      rules,
    ].join("\n");
    expect(built).toBe(expected);
  });
});
