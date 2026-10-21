// W6-C — §5.4 context assembly: canonical stringify determinism, section
// order, THE §5.4 cache assertion (prefix stability under revision change),
// and the 12-layer ≤4k-token compaction table.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AssembledContext,
  type AssembledSection,
  type BriefChatTurnInput,
  CACHED_SECTION_IDS,
  CHARS_PER_TOKEN,
  CONTEXT_SECTION_IDS,
  ContextAssembler,
  type ContextInput,
  type ContextSectionId,
  DEFAULT_SECTION_CHAR_BUDGETS,
  DOC_SUMMARY_CHAR_BUDGET,
  DOC_SUMMARY_TOKEN_BUDGET,
  type DocumentSummaryInput,
  MAX_LAYERS_IN_CONTEXT,
  type StyleGuideInput,
  type TemplateManifestInput,
  type ValidatorReportInput,
  canonicalStringify,
  capText,
  defaultContextAssembler,
  estimateTokens,
  finalizeWarnings,
  hashCachePrefix,
} from "../src/observer/context.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM = "You are a senior design agent operating a layered editor through tools.";

const STYLE_GUIDE: StyleGuideInput = {
  palette: { cream: "#F4E7D3", ink: "#3B2A20", ember: "#D96C3B" },
  fonts: ["display-serif", "grotesk-sans"],
  tone: "Warm, confident, editorial.",
};

const MANIFEST: TemplateManifestInput = {
  ref: "instagram-post@3",
  title: "Instagram post",
  slots: [
    { name: "headline", kind: "text", required: true },
    { name: "photo", kind: "image", required: true },
    { name: "subhead", kind: "text" },
  ],
};

const CANVAS = { widthPx: 1080, heightPx: 1350 };

/** A 12-layer document row, §5.4-style (extra fields = poison probes). */
function layerRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    layerId: id,
    name: `layer ${id}`,
    kind: "text",
    visible: id !== "3",
    bounds: { x: 12, y: 34 * Number(id), width: 800, height: 120 },
    ...extra,
  };
}

function twelveLayers(): readonly Record<string, unknown>[] {
  return ["10", "9", "2", "21", "100", "1", "5", "7", "8", "11", "4", "6"].map((id) =>
    layerRow(id),
  );
}

const POISON: Record<string, unknown> = {
  pixels: "data:image/png;base64,AAAAB3NzaC1yc2E",
  sourcePath: "/abs/secret/path.png",
  internalId: "node-42",
  smartContents: { uuid: "urn:internal:9af1" },
  effects: { gaussianBlur: { radius: 8, expensiveNoise: "x".repeat(500) } },
};

const BASE_INPUT: ContextInput = {
  system: SYSTEM,
  styleGuide: STYLE_GUIDE,
  templateManifest: MANIFEST,
  documentSummary: { revision: 3, canvas: CANVAS, layers: twelveLayers() },
  brief: {
    prompt: "Fresh roasted, every morning.",
    attachments: [{ name: "logo.png", description: "brand logo" }],
    priorChat: [{ role: "user", content: "make it pop" }],
    exportDimensions: { width: 1080, height: 1350 },
  },
  priorValidatorReport: {
    ok: true,
    issueCounts: { blocker: 0, major: 0, minor: 1 },
    issues: [{ severity: "minor", code: "contrast_low", layer: "2" }],
    truncated: false,
  },
};

function assembler(): ContextAssembler {
  return new ContextAssembler();
}

function sectionOf(assembled: AssembledContext, id: ContextSectionId): AssembledSection {
  const section = assembled.sections.find((candidate) => candidate.id === id);
  if (section === undefined) throw new Error(`missing section ${id}`);
  return section;
}

/** §22 check helper: warnings are counts/codes, never payload content. */
function warningText(assembled: AssembledContext): string {
  return assembled.warnings.join(" | ");
}

// ---------------------------------------------------------------------------
// canonicalStringify — determinism (§5.4 "stable ordering")
// ---------------------------------------------------------------------------

describe("context: canonicalStringify determinism", () => {
  it("sorts keys recursively regardless of insertion order", () => {
    const left = canonicalStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
    const right = canonicalStringify({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
    expect(left).toBe(right);
    expect(left).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  it("keeps array order (chat turns, layer rows) while sorting each row", () => {
    const rows = [
      { id: "2", name: "b" },
      { id: "1", name: "a" },
    ];
    expect(canonicalStringify(rows)).toBe('[{"id":"2","name":"b"},{"id":"1","name":"a"}]');
  });

  it("mirrors JSON.stringify semantics for undefined/NaN (and never throws)", () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalStringify([undefined])).toBe(JSON.stringify([undefined])); // "[null]"
    expect(canonicalStringify(Number.NaN)).toBe("null");
    expect(canonicalStringify(Number.POSITIVE_INFINITY)).toBe("null");
    expect(canonicalStringify(10n)).toBe('"10"'); // bigint never throws here
    expect(canonicalStringify(undefined)).toBe("null");
  });

  it("round-trips through JSON.parse identically to JSON.stringify", () => {
    const value = { ...BASE_INPUT, extra: [1, "two", null, true, { nested: { deep: 4.5 } }] };
    expect(JSON.parse(canonicalStringify(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it("is byte-stable across repeated calls", () => {
    const first = canonicalStringify(BASE_INPUT);
    for (let i = 0; i < 5; i += 1) {
      expect(canonicalStringify(BASE_INPUT)).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// §5.4 section order + ids
// ---------------------------------------------------------------------------

describe("context: §5.4 section order and ids", () => {
  it("emits sections in §5.4 order under stable ids, all system role", () => {
    const assembled = assembler().assembleContext(BASE_INPUT);
    expect(assembled.sections.map((section) => section.id)).toEqual([...CONTEXT_SECTION_IDS]);
    expect(assembled.messages.map((message) => message.role)).toEqual(
      Array.from({ length: 6 }, () => "system"),
    );
    expect(assembled.messages.map((message) => message.content)).toEqual(
      assembled.sections.map((section) => section.content),
    );
    for (const message of assembled.messages) {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      expect(typeof parsed.section).toBe("string");
    }
  });

  it("flags exactly §5.4 items 1-3 as cached", () => {
    const assembled = assembler().assembleContext(BASE_INPUT);
    expect(
      assembled.sections.filter((section) => section.cached).map((section) => section.id),
    ).toEqual([...CACHED_SECTION_IDS]);
  });

  it("omits absent optional sections without warnings", () => {
    const assembled = assembler().assembleContext({ system: SYSTEM });
    expect(assembled.sections.map((section) => section.id)).toEqual(["system_prompt"]);
    expect(assembled.warnings).toEqual([]);
    const parsed = JSON.parse(assembled.messages[0]?.content ?? "{}") as Record<string, unknown>;
    expect(parsed.section).toBe("system_prompt");
    expect(parsed.text).toBe(SYSTEM);
  });

  it("drops a non-string system prompt with a warning", () => {
    const assembled = assembler().assembleContext({
      system: undefined as unknown as string,
    });
    expect(assembled.messages).toEqual([]);
    expect(warningText(assembled)).toContain("system prompt missing");
  });
});

// ---------------------------------------------------------------------------
// THE §5.4 cache assertion — prefix stability under revision change
// ---------------------------------------------------------------------------

describe("context: cacheablePrefix (§5.4 items 1-3 only)", () => {
  it("THE assertion: a revision change never alters the prefix", () => {
    const ctx = assembler();
    const before = ctx.assembleContext(BASE_INPUT);
    const after = ctx.assembleContext({
      ...BASE_INPUT,
      documentSummary: { revision: 4, canvas: CANVAS, layers: twelveLayers() },
    });
    expect(after.cacheablePrefix).toBe(before.cacheablePrefix);
    expect(after.messages.slice(0, 3)).toEqual(before.messages.slice(0, 3));
    // Section 4 DID change (the model must see the new revision)…
    expect(after.sections[3]?.content).not.toBe(before.sections[3]?.content);
    expect(
      (JSON.parse(after.sections[3]?.content ?? "{}") as Record<string, unknown>).revision,
    ).toBe(4);
  });

  it("also holds for the compact (pre-compacted string) arm", () => {
    const ctx = assembler();
    const summary = JSON.stringify({ canvas: CANVAS, layers: twelveLayers() });
    const before = ctx.assembleContext({
      ...BASE_INPUT,
      documentSummary: { summary, revision: 10 },
    });
    const after = ctx.assembleContext({
      ...BASE_INPUT,
      documentSummary: { summary, revision: 99 },
    });
    expect(after.cacheablePrefix).toBe(before.cacheablePrefix);
    expect(after.messages.slice(0, 3)).toEqual(before.messages.slice(0, 3));
    expect(after.sections[3]?.content).not.toBe(before.sections[3]?.content);
  });

  it("equals sha256 over exactly the first three message contents (length-framed)", () => {
    const assembled = assembler().assembleContext(BASE_INPUT);
    const contents = assembled.messages.slice(0, 3).map((message) => message.content);
    const digest = createHash("sha256");
    for (const content of contents) {
      digest.update(`${content.length}:`);
      digest.update(content);
      digest.update("\n");
    }
    expect(assembled.cacheablePrefix).toBe(`sha256:${digest.digest("hex")}`);
    expect(assembled.cacheablePrefix).toBe(hashCachePrefix(contents));
  });

  it("changes when a cached section changes, not when later sections do", () => {
    const ctx = assembler();
    const base = ctx.assembleContext(BASE_INPUT).cacheablePrefix;

    // Sections 4-6 are outside the prefix.
    expect(
      ctx.assembleContext({ ...BASE_INPUT, brief: { prompt: "different" } }).cacheablePrefix,
    ).toBe(base);
    expect(
      ctx.assembleContext({
        ...BASE_INPUT,
        priorValidatorReport: { ok: false, issueCounts: { blocker: 2, major: 0, minor: 0 } },
      }).cacheablePrefix,
    ).toBe(base);

    // Sections 1-3 are inside the prefix.
    expect(
      ctx.assembleContext({ ...BASE_INPUT, system: "different prompt" }).cacheablePrefix,
    ).not.toBe(base);
    expect(
      ctx.assembleContext({
        ...BASE_INPUT,
        styleGuide: { palette: { ink: "#111111" } },
      }).cacheablePrefix,
    ).not.toBe(base);
    expect(
      ctx.assembleContext({
        ...BASE_INPUT,
        templateManifest: { ref: "youtube-thumbnail@1" },
      }).cacheablePrefix,
    ).not.toBe(base);
  });

  it("presence is part of the cached bytes (omitting style_guide shifts the prefix)", () => {
    const ctx = assembler();
    const base = ctx.assembleContext(BASE_INPUT).cacheablePrefix;
    expect(ctx.assembleContext({ ...BASE_INPUT, styleGuide: undefined }).cacheablePrefix).not.toBe(
      base,
    );
  });

  it("is deterministic across instances and key insertion order", () => {
    const left = assembler().assembleContext(BASE_INPUT);
    const right = new ContextAssembler().assembleContext({
      brief: BASE_INPUT.brief,
      priorValidatorReport: BASE_INPUT.priorValidatorReport,
      documentSummary: BASE_INPUT.documentSummary,
      templateManifest: MANIFEST,
      styleGuide: {
        tone: "Warm, confident, editorial.",
        fonts: ["grotesk-sans", "display-serif"],
        palette: { ember: "#D96C3B", ink: "#3B2A20", cream: "#F4E7D3" },
      },
      system: SYSTEM,
    });
    expect(right.cacheablePrefix).toBe(left.cacheablePrefix);
    expect(right.messages).toEqual(left.messages);
  });

  it("survives a shrunk document-summary budget (truncation is post-prefix)", () => {
    const ctx = new ContextAssembler({ budgets: { document_summary: 400 } });
    const before = ctx.assembleContext(BASE_INPUT);
    const after = ctx.assembleContext({
      ...BASE_INPUT,
      documentSummary: { revision: 999, canvas: CANVAS, layers: twelveLayers() },
    });
    expect(after.cacheablePrefix).toBe(before.cacheablePrefix);
  });
});

// ---------------------------------------------------------------------------
// §5.4 (4): the 12-layer ≤4k-token compaction table
// ---------------------------------------------------------------------------

describe("context: 12-layer compaction table (§5.4 ≤4k tokens)", () => {
  const ids = ["10", "9", "2", "21", "100", "1", "5", "7", "8", "11", "4", "6"];

  const cases: readonly { readonly name: string; readonly layers: readonly unknown[] }[] = [
    {
      name: "minimal rows (id only)",
      layers: ids.map((id) => ({ id })),
    },
    {
      name: "verbose rows (every whitelisted field)",
      layers: ids.map((id) => ({
        layerId: id,
        name: `hero headline ${id}`,
        kind: "text",
        visible: id !== "3",
        opacity: 0.85,
        bounds: { x: 10, y: 20, width: 1080, height: 192 },
        childCount: 2,
      })),
    },
    {
      name: "80-char names",
      layers: ids.map((id) => ({
        layerId: id,
        name: `L${id}-${"n".repeat(80)}`,
        kind: "group",
        visible: true,
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      })),
    },
    {
      name: "poisoned rows (§5.4 never a full dump)",
      layers: ids.map((id) => layerRow(id, POISON)),
    },
  ];

  it.each(cases)("12 layers, case '$name': ≤4k tokens, no truncation", ({ layers }) => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: { revision: 7, canvas: CANVAS, layers },
    });
    const summary = sectionOf(assembled, "document_summary");
    expect(summary.chars).toBeLessThanOrEqual(DOC_SUMMARY_CHAR_BUDGET);
    expect(estimateTokens(summary.chars)).toBeLessThanOrEqual(DOC_SUMMARY_TOKEN_BUDGET);
    expect(summary.truncated).toBe(false);
    expect(assembled.warnings).toEqual([]); // no caps fired for a 12-layer doc
  });

  it("poisoned fields never reach the model (pixel data, paths, internal ids)", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: {
        revision: 7,
        canvas: CANVAS,
        layers: ids.map((id) => layerRow(id, POISON)),
      },
    });
    const content = sectionOf(assembled, "document_summary").content;
    expect(content).not.toContain("base64");
    expect(content).not.toContain("/abs/secret");
    expect(content).not.toContain("internalId");
    expect(content).not.toContain("smartContents");
    expect(content).not.toContain("expensiveNoise");
    const parsed = JSON.parse(content) as { layers: { id: string; name: string }[] };
    expect(parsed.layers).toHaveLength(12);
    // Whitelisted fields DID survive.
    expect(parsed.layers[0]).toMatchObject({ id: "1", kind: "text", visible: true });
  });

  it("sorts rows numerically by id (§5.4 stable ordering)", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: { revision: 7, canvas: CANVAS, layers: twelveLayers() },
    });
    const parsed = JSON.parse(sectionOf(assembled, "document_summary").content) as {
      layers: { id: string }[];
    };
    expect(parsed.layers.map((row) => row.id)).toEqual([
      "1",
      "2",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "21",
      "100",
    ]);
  });

  it("compact arm: parses the tool's summary JSON and embeds it unescaped", () => {
    const toolSummary = JSON.stringify({
      canvas: CANVAS,
      layers: twelveLayers(),
      palette: { ink: "#3B2A20" },
      variables: { defs: [{ name: "headline", layer: "2" }], dataSets: [] },
    });
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: { summary: toolSummary, revision: 12 },
    });
    const content = sectionOf(assembled, "document_summary").content;
    expect(content).toContain('"layers":['); // embedded, not double-escaped
    expect(content).not.toContain('\\"layers\\"');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.revision).toBe(12);
    expect((parsed.layers as unknown[]).length).toBe(12);
  });

  it("compact arm: a delta summary object passes through with its delta key", () => {
    const deltaSummary = canonicalStringify({
      revision: 8,
      canvas: CANVAS,
      delta: {
        added: [],
        changed: [{ id: "2", name: "renamed" }],
        removed: [],
        unchanged: 11,
        total: 12,
      },
    });
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: { summary: deltaSummary },
    });
    const parsed = JSON.parse(sectionOf(assembled, "document_summary").content) as {
      delta: { changed: unknown[] };
    };
    expect(parsed.delta.changed).toHaveLength(1);
  });

  it("caps a 600-row document at 60 id-sorted rows with a warning", () => {
    const rows = Array.from({ length: 600 }, (_, index) => layerRow(String(index + 1)));
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: { revision: 7, canvas: CANVAS, layers: rows },
    });
    const parsed = JSON.parse(sectionOf(assembled, "document_summary").content) as {
      layers: unknown[];
    };
    expect(parsed.layers).toHaveLength(MAX_LAYERS_IN_CONTEXT);
    expect(warningText(assembled)).toContain("limited to first 60 of 600 rows");
  });

  it("budget fit: shrinks to the largest layer prefix that fits + warning", () => {
    const ctx = new ContextAssembler({ budgets: { document_summary: 400 } });
    const assembled = ctx.assembleContext({
      system: SYSTEM,
      documentSummary: { revision: 7, canvas: CANVAS, layers: twelveLayers() },
    });
    const summary = sectionOf(assembled, "document_summary");
    expect(summary.chars).toBeLessThanOrEqual(400);
    // The row-prefix fit rebuilt the payload within budget — no byte clamp
    // needed, so `truncated` (the hard-clamp flag) stays false; the warning
    // is the canonical "what was cut" signal.
    expect(summary.truncated).toBe(false);
    expect(warningText(assembled)).toMatch(/truncated to \d+ of 12 rows/);
    // Fitted content stays valid JSON (row-prefix truncation, not a byte slice).
    expect(() => JSON.parse(summary.content)).not.toThrow();
  });

  it("skips id-less rows with a warning, never guesses", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: {
        revision: 7,
        canvas: CANVAS,
        layers: [layerRow("1"), { name: "no id here" }, layerRow("2")],
      },
    });
    expect(warningText(assembled)).toContain("1 layer row(s) skipped");
    const parsed = JSON.parse(sectionOf(assembled, "document_summary").content) as {
      layers: { id: string }[];
    };
    expect(parsed.layers.map((row) => row.id)).toEqual(["1", "2"]);
  });

  it("ignores a malformed document summary (neither string nor layers)", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      documentSummary: { nonsense: true } as unknown as DocumentSummaryInput,
    });
    expect(assembled.sections.map((section) => section.id)).toEqual(["system_prompt"]);
    expect(warningText(assembled)).toContain("document summary ignored");
  });
});

// ---------------------------------------------------------------------------
// Sections 2, 3, 5, 6 — projections + caps
// ---------------------------------------------------------------------------

describe("context: style guide / manifest / brief / validator projections", () => {
  it("style guide: palette is embedded, fonts deduped+sorted, tone kept", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      styleGuide: { fonts: ["b", "a", "b"], palette: { ink: "#3B2A20" }, tone: "warm" },
    });
    const parsed = JSON.parse(sectionOf(assembled, "style_guide").content) as {
      palette: Record<string, string>;
      fonts: string[];
      tone: string;
    };
    expect(parsed.palette).toEqual({ ink: "#3B2A20" });
    expect(parsed.fonts).toEqual(["a", "b"]);
    expect(parsed.tone).toBe("warm");
  });

  it("template manifest: chosen ref + name-sorted slots; missing ref is ignored", () => {
    const withRef = assembler().assembleContext({
      system: SYSTEM,
      templateManifest: {
        ref: "instagram-post@3",
        slots: [{ name: "z" }, { name: "a", kind: "image", required: true }],
      },
    });
    const parsed = JSON.parse(sectionOf(withRef, "template_manifest").content) as {
      ref: string;
      slots: { name: string }[];
    };
    expect(parsed.ref).toBe("instagram-post@3");
    expect(parsed.slots.map((slot) => slot.name)).toEqual(["a", "z"]);

    const noRef = assembler().assembleContext({
      system: SYSTEM,
      templateManifest: { title: "no ref" } as TemplateManifestInput,
    });
    expect(noRef.sections.map((section) => section.id)).toEqual(["system_prompt"]);
    expect(warningText(noRef)).toContain("no template ref");
  });

  it("brief: file:// thumbnails dropped, 20 attachments → 16 kept (§6.1)", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      brief: {
        prompt: "go",
        attachments: [
          { name: "bad", previewUrl: "file:///etc/passwd" },
          ...Array.from({ length: 19 }, (_, i) => ({
            name: `a${i}`,
            previewUrl: "https://cdn.example/a.png",
          })),
        ],
      },
    });
    const parsed = JSON.parse(sectionOf(assembled, "brief").content) as {
      attachments: { name?: string; previewUrl?: string }[];
    };
    expect(parsed.attachments).toHaveLength(16); // 20 rows capped at 16
    expect(parsed.attachments[0]).toEqual({ name: "bad" }); // §6.1 drop, name kept
    expect(parsed.attachments.slice(1).every((row) => row.previewUrl !== undefined)).toBe(true);
    expect(warningText(assembled)).toContain("attachments limited to first 16 of 20");
    expect(warningText(assembled)).toContain("1 attachment thumbnail url(s) dropped");
  });

  it("brief: prior chat stays chronological, 35 turns → 30, odd roles read as user", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      brief: {
        prompt: "go",
        priorChat: Array.from({ length: 35 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : i === 1 ? "system" : "assistant", // "system" is odd on purpose
          content: `turn ${i}`,
        })) as unknown as BriefChatTurnInput[],
      },
    });
    const parsed = JSON.parse(sectionOf(assembled, "brief").content) as {
      priorChat: { role: string; content: string }[];
    };
    expect(parsed.priorChat).toHaveLength(30);
    expect(parsed.priorChat[1]).toEqual({ role: "user", content: "turn 1" }); // odd role
    expect(parsed.priorChat[0]?.content).toBe("turn 0"); // order kept
    expect(warningText(assembled)).toContain("prior chat limited to first 30 of 35");
  });

  it("brief: export dimensions ride along; zero-width dims are dropped", () => {
    const withDims = assembler().assembleContext({
      system: SYSTEM,
      brief: { prompt: "go", exportDimensions: { width: 1080, height: 1350 } },
    });
    const parsed = JSON.parse(sectionOf(withDims, "brief").content) as {
      exportDimensions: { width: number; height: number };
    };
    expect(parsed.exportDimensions).toEqual({ width: 1080, height: 1350 });

    const zero = assembler().assembleContext({
      system: SYSTEM,
      brief: { prompt: "go", exportDimensions: { width: 0, height: 100 } },
    });
    expect(JSON.parse(sectionOf(zero, "brief").content)).not.toHaveProperty("exportDimensions");
  });

  it("validator report: object arm caps issues at 25; missing verdict is ignored", () => {
    const assembled = assembler().assembleContext({
      system: SYSTEM,
      priorValidatorReport: {
        ok: false,
        issueCounts: { blocker: 1, major: 0, minor: 0 },
        issues: Array.from({ length: 30 }, (_, i) => ({ code: `issue_${i}` })),
        truncated: true,
      },
    });
    const parsed = JSON.parse(sectionOf(assembled, "validator_report").content) as {
      report: { issues: unknown[]; issueCounts: Record<string, number> };
    };
    expect(parsed.report.issues).toHaveLength(25);
    expect(parsed.report.issueCounts.blocker).toBe(1);
    expect(warningText(assembled)).toContain("issues limited to first 25 of 30");

    const noVerdict = assembler().assembleContext({
      system: SYSTEM,
      priorValidatorReport: {
        issueCounts: { blocker: 0, major: 0, minor: 0 },
      } as unknown as ValidatorReportInput,
    });
    expect(noVerdict.sections.map((section) => section.id)).toEqual(["system_prompt"]);
    expect(warningText(noVerdict)).toContain("no ok verdict");
  });

  it("validator report: string arm parses the tool's compact JSON, raw otherwise", () => {
    const compact = JSON.stringify({
      ok: false,
      issueCounts: { blocker: 2, major: 1, minor: 3 },
      issues: [],
      truncated: false,
    });
    const parsedArm = assembler().assembleContext({
      system: SYSTEM,
      priorValidatorReport: compact,
    });
    const parsed = JSON.parse(sectionOf(parsedArm, "validator_report").content) as {
      report: { ok: boolean };
    };
    expect(parsed.report.ok).toBe(false);

    const rawArm = assembler().assembleContext({
      system: SYSTEM,
      priorValidatorReport: "validator says no",
    });
    const raw = JSON.parse(sectionOf(rawArm, "validator_report").content) as {
      report: string;
    };
    expect(raw.report).toBe("validator says no");
  });
});

// ---------------------------------------------------------------------------
// Section budgets + warnings discipline (§5.4 "with truncation warnings")
// ---------------------------------------------------------------------------

describe("context: section budgets and §22-safe warnings", () => {
  it("truncates the system prompt to its budget with a warning", () => {
    const ctx = new ContextAssembler({ budgets: { system_prompt: 40 } });
    const assembled = ctx.assembleContext({ system: `${"s".repeat(200)}` });
    const section = sectionOf(assembled, "system_prompt");
    expect(section.chars).toBe(40);
    expect(section.truncated).toBe(true);
    expect(section.content.endsWith("…")).toBe(true);
    expect(warningText(assembled)).toContain("system_prompt truncated from");
  });

  it("never lets user text leak into warnings (§22)", () => {
    const secret = "SECRET-PROMISE-TOKEN";
    const ctx = new ContextAssembler({ budgets: { brief: 60 } });
    const assembled = ctx.assembleContext({
      system: SYSTEM,
      brief: { prompt: `${secret}-${"p".repeat(400)}` },
    });
    expect(sectionOf(assembled, "brief").truncated).toBe(true);
    expect(warningText(assembled)).not.toContain(secret);
    expect(warningText(assembled)).not.toContain("p".repeat(20));
  });

  it("finalizeWarnings dedupes, clips and caps", () => {
    const warnings = ["a", "a", ...Array.from({ length: 20 }, (_, i) => `w${i}`)];
    const finalized = finalizeWarnings(warnings);
    expect(finalized[0]).toBe("a");
    expect(new Set(finalized).size).toBe(finalized.length);
    expect(finalized.length).toBeLessThanOrEqual(10);
    expect(finalizeWarnings(["x".repeat(500)])[0]?.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Module constants (pin the §5.4 numbers)
// ---------------------------------------------------------------------------

describe("context: §5.4 constants", () => {
  it("pins the 4-chars/token approximation and the doc-summary budgets", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(DOC_SUMMARY_CHAR_BUDGET).toBe(16_000);
    expect(DOC_SUMMARY_TOKEN_BUDGET * CHARS_PER_TOKEN).toBe(DOC_SUMMARY_CHAR_BUDGET);
    expect(DEFAULT_SECTION_CHAR_BUDGETS.document_summary).toBe(DOC_SUMMARY_CHAR_BUDGET);
  });

  it("estimateTokens: 16k chars → 4k tokens; empty → 0", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(16_000)).toBe(4_000);
    expect(estimateTokens(Number.NaN)).toBe(0);
  });

  it("capText: exact-budget text passes untouched", () => {
    const text = "x".repeat(100);
    expect(capText(text, 100)).toEqual({ text, truncated: false, originalChars: 100 });
    expect(capText(text, 99)).toEqual({
      text: `${"x".repeat(98)}…`,
      truncated: true,
      originalChars: 100,
    });
  });

  it("exports a pure default instance", () => {
    const assembled = defaultContextAssembler.assembleContext(BASE_INPUT);
    expect(assembled.sections).toHaveLength(6);
    expect(assembled.cacheablePrefix).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
