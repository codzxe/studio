// kit.test.ts — pure-logic contract enforcement: schemas, envelopes, defineTool boundary.

import { z } from "zod";
import { describe, expect, it } from "vitest";
import { echoTool } from "../src/example/echo.js";
import {
  MAX_ARG_RECORD_ENTRIES,
  MAX_ARG_STRING_CHARS,
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  ToolError,
  ambiguousLayerErr,
  cappedArray,
  cappedRecord,
  cappedString,
  defineTool,
  err,
  isToolName,
  isToolResult,
  layerNotFoundErr,
  ok,
  parseToolArgs,
  strictObject,
  toToolErr,
  zColor,
  zIdempotencyKey,
  zLayerRef,
  zTemplateRef,
  type ToolDefinition,
} from "../src/kit.js";
import type { AnyTool, Tool, ToolContext, ToolErr, ToolErrorCode, ToolResult } from "../src/types.js";
import { abortedSignal, freshSignal, makeFakeContext } from "./fakes.js";

const goodDescription = "A tool used only by unit tests to verify the kit contract.";

/** A probe tool: valid by default, breakable piece by piece for contract tests. */
function defineProbe(
  overrides: {
    name?: string;
    description?: string;
    run?: (ctx: ToolContext, args: { value: string }, signal: AbortSignal) => Promise<unknown>;
  } = {},
): Tool<{ value: string }> {
  const fallback = async (): Promise<ToolResult> => ok({ summary: "probed" });
  return defineTool({
    name: overrides.name ?? "probe_tool",
    description: overrides.description ?? goodDescription,
    args: strictObject({ value: cappedString(10) }),
    run: (overrides.run ?? fallback) as ToolDefinition<{ value: string }>["run"],
  });
}

describe("§6.1 schema helpers", () => {
  it("strictObject rejects unknown keys (additionalProperties: false)", () => {
    const schema = strictObject({ a: z.number() });
    expect(schema.safeParse({ a: 1 }).success).toBe(true);
    expect(schema.safeParse({ a: 1, b: 2 }).success).toBe(false);
  });

  it("cappedString enforces min/max, and caps stay ≤ 2000 (§6.2 text cap)", () => {
    expect(cappedString(10).safeParse("abcdefghij").success).toBe(true);
    expect(cappedString(10).safeParse("abcdefghijk").success).toBe(false);
    expect(cappedString(10, 3).safeParse("ab").success).toBe(false);
    expect(() => cappedString(MAX_ARG_STRING_CHARS + 1)).toThrow(ToolError);
  });

  it("cappedArray enforces array caps (§6.1)", () => {
    const schema = cappedArray(3, cappedString(4));
    expect(schema.safeParse(["a", "b", "c"]).success).toBe(true);
    expect(schema.safeParse(["a", "b", "c", "d"]).success).toBe(false);
    expect(() => cappedArray(999, cappedString(4))).toThrow(ToolError);
  });

  it("cappedRecord enforces entry caps like §6.2's 'too many slots'", () => {
    const schema = cappedRecord(2, cappedString(4));
    expect(schema.safeParse({ a: "x", b: "y" }).success).toBe(true);
    expect(schema.safeParse({ a: "x", b: "y", c: "z" }).success).toBe(false);
    expect(() => cappedRecord(MAX_ARG_RECORD_ENTRIES + 1, cappedString(4))).toThrow(ToolError);
  });

  it("zColor accepts exactly the §6.1 colour formats", () => {
    const valid = [
      "#f0a",
      "#FF00AA",
      "rgb(0, 128, 255)",
      "rgba(0, 128, 255, 0.5)",
      "hsl(120, 100%, 50%)",
      "hsla(120, 100%, 50%, 0.5)",
      "rgb( 1 , 2 , 3 )",
      "hsl(0, 0%, 100%)",
      "rgb(255,255,255)",
    ];
    const invalid = [
      "red",
      "#GGG",
      "#12345",
      "rgb(300, 0, 0)",
      "rgb(1, 2)",
      "rgb(12, 34, 56, 2)",
      "hsl(400, 50%, 50%)",
      "hsl(120, 50, 50)",
      "file:///etc/passwd",
      "",
      "#ff00aa ",
      "var(--brand)",
    ];
    for (const value of valid) {
      expect(zColor.safeParse(value).success, value).toBe(true);
    }
    for (const value of invalid) {
      expect(zColor.safeParse(value).success, value).toBe(false);
    }
    expect(zColor.safeParse(42).success).toBe(false);
  });

  it("zLayerRef accepts id OR name, never both, and rejects extras (§6.1)", () => {
    expect(zLayerRef.safeParse({ layerId: "l_1" }).success).toBe(true);
    expect(zLayerRef.safeParse({ layerName: "Background" }).success).toBe(true);
    expect(zLayerRef.safeParse({ layerId: "l_1", layerName: "Background" }).success).toBe(false);
    expect(zLayerRef.safeParse({ layerId: "l_1", extra: 1 }).success).toBe(false);
    expect(zLayerRef.safeParse({ layerId: "" }).success).toBe(false);
  });

  it("zTemplateRef and zIdempotencyKey constrain their atoms", () => {
    expect(zTemplateRef.safeParse("menu-a4@1.0.0").success).toBe(true);
    expect(zTemplateRef.safeParse("menu-a4").success).toBe(false);
    expect(zIdempotencyKey.safeParse("run-42_key-7").success).toBe(true);
    expect(zIdempotencyKey.safeParse("short").success).toBe(false);
    expect(zIdempotencyKey.safeParse("has spaces!!").success).toBe(false);
  });

  it("isToolName mirrors the §6 snake_case rule", () => {
    for (const name of ["template_fill", "xy", "a".repeat(64)]) {
      expect(isToolName(name)).toBe(true);
    }
    for (const bad of ["x", "Template_Fill", "template-fill", "1_tool", "a".repeat(65), 42]) {
      expect(isToolName(bad)).toBe(false);
    }
  });
});

describe("§6.1 ok()/err() constructors", () => {
  it("ok() builds the compact success envelope and omits unset fields", () => {
    const result = ok({ summary: "Filled 3 slots" });
    expect(result).toEqual({ ok: true, summary: "Filled 3 slots" });
    expect("documentRevision" in result).toBe(false);
    expect("warnings" in result).toBe(false);
    expect("previewUrl" in result).toBe(false);
  });

  it("ok() carries revision, warnings and safe preview urls", () => {
    const result = ok({
      summary: "Placed the hero image",
      documentRevision: 7,
      warnings: ["Image scaled down 20%"],
      previewUrl: "/assets/renders/preview-1.png",
    });
    expect(result).toEqual({
      ok: true,
      summary: "Placed the hero image",
      documentRevision: 7,
      warnings: ["Image scaled down 20%"],
      previewUrl: "/assets/renders/preview-1.png",
    });
  });

  it("ok() enforces the small-reply rule: summary and warning caps (§6.1)", () => {
    expect(() => ok({ summary: "   " })).toThrow(ToolError);
    expect(() => ok({ summary: "x".repeat(MAX_SUMMARY_CHARS + 1) })).toThrow(ToolError);
    expect(() => ok({ summary: "x", warnings: Array.from({ length: 21 }, () => "w") })).toThrow(
      ToolError,
    );
    expect(() => ok({ summary: "x", warnings: ["w".repeat(501)] })).toThrow(ToolError);
    expect(() => ok({ summary: "x", documentRevision: -1 })).toThrow(ToolError);
    expect(() => ok({ summary: "x", documentRevision: 1.5 })).toThrow(ToolError);
  });

  it("ok() rejects unsafe preview urls — no file paths, no traversal (§6.1)", () => {
    for (const url of ["/ok.png", "https://cdn.example.test/r.png", "http://cdn.example.test/r.png"]) {
      expect(ok({ summary: "s", previewUrl: url }).previewUrl).toBe(url);
    }
    for (const url of ["file:///etc/passwd", "../escape.png", "ftp://x/y", "relative/path", "C:\\x"]) {
      expect(() => ok({ summary: "s", previewUrl: url })).toThrow(ToolError);
    }
  });

  it("err() builds the actionable failure envelope and omits unset fields", () => {
    const failure = err("text_overflow", "Headline does not fit its box");
    expect(failure).toEqual({
      ok: false,
      code: "text_overflow",
      message: "Headline does not fit its box",
    });
    expect("hint" in failure).toBe(false);
    expect("retryable" in failure).toBe(false);
  });

  it("err() keeps hint and retryable when provided", () => {
    const failure = err("text_overflow", "Headline does not fit", {
      hint: "shorten to 40 chars or reduce size to 72pt",
      retryable: false,
    });
    expect(failure.code).toBe("text_overflow");
    expect(failure.hint).toBe("shorten to 40 chars or reduce size to 72pt");
    expect(failure.retryable).toBe(false);
  });

  it("err() throws ToolError on contract misuse (unknown code, bad message/hint)", () => {
    expect(() => err("bogus_code" as unknown as ToolErrorCode, "m")).toThrow(ToolError);
    expect(() => err("text_overflow", "")).toThrow(ToolError);
    expect(() => err("text_overflow", "x".repeat(1001))).toThrow(ToolError);
    expect(() => err("text_overflow", "m", { hint: "" })).toThrow(ToolError);
    expect(() => err("text_overflow", "m", { hint: "h".repeat(501) })).toThrow(ToolError);
  });

  it("layer error helpers list candidates / the ref that missed (§6.1)", () => {
    const ambiguous = ambiguousLayerErr("Background", ["l_1", "l_2", "l_3"]);
    expect(ambiguous.code).toBe("ambiguous_layer");
    expect(ambiguous.message).toContain("matches 3 layers");
    expect(ambiguous.hint).toContain("layer_id");
    expect(ambiguous.hint).toContain("l_1, l_2, l_3");

    const many = ambiguousLayerErr("Bg", Array.from({ length: 12 }, (_, i) => `l_${i}`));
    expect(many.hint).toContain("(+2 more)");
    expect((many.hint ?? "").length).toBeLessThanOrEqual(MAX_HINT_CHARS);

    const missing = layerNotFoundErr("l_ghost");
    expect(missing.code).toBe("layer_not_found");
    expect(missing.hint).toContain("l_ghost");
  });
});

describe("TOOL_RESULT_SCHEMA / isToolResult", () => {
  it("accepts constructor output and rejects malformed envelopes and extras", () => {
    expect(isToolResult(ok({ summary: "s" }))).toBe(true);
    expect(isToolResult(err("not_found", "no such thing"))).toBe(true);
    expect(isToolResult(null)).toBe(false);
    expect(isToolResult({ ok: true })).toBe(false);
    expect(isToolResult({ ok: true, summary: "s", engineDump: { layers: [] } })).toBe(false);
    expect(isToolResult({ ok: false, code: "bogus", message: "m" })).toBe(false);
  });
});

describe("defineTool — compile-time + runtime safety", () => {
  it("validates the definition itself (name, description, args, run)", () => {
    expect(() => defineProbe({ name: "Bad Name" })).toThrow(ToolError);
    expect(() => defineProbe({ name: "x" })).toThrow(ToolError);
    expect(() => defineProbe({ description: "short" })).toThrow(ToolError);
    expect(() =>
      defineTool({
        name: "no_schema",
        description: goodDescription,
        args: { safeParse: () => null } as unknown as ToolDefinition<{ value: string }>["args"],
        run: async () => ok({ summary: "s" }),
      }),
    ).toThrow(ToolError);
  });

  it("returns a Tool with the definition's identity intact", () => {
    const tool = defineProbe();
    expect(tool.name).toBe("probe_tool");
    expect(tool.description).toBe(goodDescription);
    expect(tool.args.safeParse({ value: "abc" }).success).toBe(true);
  });

  it("injects the ctx and signal the executor passed (§6.2 ctx seam)", async () => {
    const ctx = makeFakeContext();
    const signal = freshSignal();
    let seenCtx: ToolContext | undefined;
    let seenSignal: AbortSignal | undefined;
    const tool = defineProbe({
      run: async (c, _args, s) => {
        seenCtx = c;
        seenSignal = s;
        return ok({ summary: "probed" });
      },
    });
    const result = await tool.run(ctx, { value: "v" }, signal);
    expect(result.ok).toBe(true);
    expect(seenCtx).toBe(ctx);
    expect(seenSignal).toBe(signal);
  });

  it("rejects pre-aborted signals without invoking run (§3.4 deadline)", async () => {
    let invoked = false;
    const tool = defineProbe({
      run: async () => {
        invoked = true;
        return ok({ summary: "should not run" });
      },
    });
    const result = await tool.run(makeFakeContext(), { value: "v" }, abortedSignal());
    expect(invoked).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "engine_timeout", retryable: false });
  });

  it("passes ToolError throws through as typed err envelopes", async () => {
    const tool = defineProbe({
      run: async () => {
        throw new ToolError("text_overflow", "boom", { hint: "shrink", retryable: true });
      },
    });
    const result = await tool.run(makeFakeContext(), { value: "v" }, freshSignal());
    const expected: ToolErr = {
      ok: false,
      code: "text_overflow",
      message: "boom",
      hint: "shrink",
      retryable: true,
    };
    expect(result).toEqual(expected);
  });

  it("converts AbortError into retryable engine_timeout (§3.4)", async () => {
    const tool = defineProbe({
      run: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    const result = await tool.run(makeFakeContext(), { value: "v" }, freshSignal());
    expect(result).toEqual({
      ok: false,
      code: "engine_timeout",
      message: "The tool call ran out of time",
      hint: "Check the document for partial effects with workspace_snapshot, then retry smaller.",
      retryable: true,
    });
  });

  it("never leaks unknown throws — internal_error with a generic message (§6.1)", async () => {
    const tool = defineProbe({
      run: async () => {
        throw new Error("secret /home/z/internal-path token=abc");
      },
    });
    const result = await tool.run(makeFakeContext(), { value: "v" }, freshSignal());
    expect(result).toEqual({
      ok: false,
      code: "internal_error",
      message: "The tool failed unexpectedly",
      hint: "Retry once; if it repeats, the run should stop cleanly with a partial refund (§14.2).",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("converts malformed run results into internal_error (schema-checked boundary)", async () => {
    const tool = defineProbe({ run: async () => undefined });
    const result = await tool.run(makeFakeContext(), { value: "v" }, freshSignal());
    expect(result).toEqual({
      ok: false,
      code: "internal_error",
      message: "The tool returned a malformed result",
      hint: "This is a tool bug, not a model error; construct results with ok()/err().",
      retryable: false,
    });
  });

  it("rejects hand-rolled ok envelopes that violate the small-reply rule", async () => {
    const tool = defineProbe({
      run: async () => ({ ok: true, summary: "x".repeat(MAX_SUMMARY_CHARS + 1) }),
    });
    const result = await tool.run(makeFakeContext(), { value: "v" }, freshSignal());
    expect(result).toMatchObject({ ok: false, code: "internal_error" });
  });

  it("toToolErr is reusable outside the boundary", () => {
    expect(toToolErr(new ToolError("not_found", "gone"))).toEqual({
      ok: false,
      code: "not_found",
      message: "gone",
    });
    expect(toToolErr("boom").code).toBe("internal_error");
  });
});

describe("parseToolArgs — the executor's boundary (§6.1 strict schemas)", () => {
  it("parses valid args and returns them typed", () => {
    const parsed = parseToolArgs(echoTool, { message: "hi" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual({ message: "hi", mode: "ok" }); // .default() applied
    }
  });

  it("rejects extra props, bad colours and bad types with invalid_args", () => {
    for (const raw of [
      { message: "hi", surprise: 1 },
      { message: "hi", color: "not-a-color" },
      { message: 42 },
      {},
    ]) {
      const parsed = parseToolArgs(echoTool, raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.code).toBe("invalid_args");
        expect(parsed.retryable).toBe(false);
      }
    }
  });

  it("explains issue paths in the hint, capped, without echoing values", () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      raw[`unknownPropertyNumber${i}`] = 1;
    }
    const parsed = parseToolArgs(echoTool, raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.hint).toContain("message");
      expect((parsed.hint ?? "").length).toBeLessThanOrEqual(MAX_HINT_CHARS);
    }
  });

  it("works for type-erased tools from the registry (AnyTool bivariance)", () => {
    const anyEcho: AnyTool = echoTool;
    const parsed = parseToolArgs(anyEcho, { message: "hi", mode: "ok" });
    expect(parsed.ok).toBe(true);
  });
});

describe("echo — the full-contract reference tool (§6.2)", () => {
  it("succeeds with a compact summary and no warnings for short messages", async () => {
    const result = await echoTool.run(makeFakeContext(), { message: "Hello, studio", mode: "ok" }, freshSignal());
    expect(result).toEqual({ ok: true, summary: "Hello, studio" });
  });

  it("annotates the summary with a validated colour", async () => {
    const result = await echoTool.run(
      makeFakeContext(),
      { message: "Hello", color: "#FF00AA", mode: "ok" },
      freshSignal(),
    );
    expect(result).toEqual({ ok: true, summary: "Hello (#FF00AA)" });
  });

  it("fails with an actionable envelope in fail mode", async () => {
    const result = await echoTool.run(makeFakeContext(), { message: "Hello", mode: "fail" }, freshSignal());
    expect(result).toEqual({
      ok: false,
      code: "validation_failed",
      message: "Echo failed on purpose",
      hint: 'Set mode to "ok" to succeed.',
      retryable: false,
    });
  });

  it("warns near its own message cap — warnings are values, not failures", async () => {
    const result = await echoTool.run(
      makeFakeContext(),
      { message: "a".repeat(101), mode: "ok" },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings?.length).toBe(1);
      expect(result.warnings?.[0]).toContain("§6.1");
    }
  });
});
