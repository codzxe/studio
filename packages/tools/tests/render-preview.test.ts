// render-preview.test.ts — W5-M. Table-driven, deterministic, no network:
// clamp table (256/512/1024/2048-reject), PNG validation, sink-contract
// enforcement (§6.1: file:// and / paths never pass), timeout abort, revision
// propagation, strict schema, registry pinning, pure predicate tables.

import { ENGINE_PNG_MAX_BYTES } from "@studio/config";
import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  AGENT_PREVIEW_CEILING_PX,
  ENGINE_HARD_PREVIEW_CEILING_PX,
  PREVIEW_RENDER_TIMEOUT_MS,
  PREVIEW_WIDTHS,
  type PreviewPutMeta,
  type PreviewSinkLike,
  type PreviewSinkPut,
  type RenderPreviewArgs,
  type RenderPreviewContext,
  buildPreviewSummary,
  clampRenderWidth,
  isEngineWriteRootPath,
  isSafePreviewUrlValue,
  renderPreviewTool,
} from "../src/tools/render-preview.js";
import type {
  EngineFailure,
  EngineLike,
  EngineOutcome,
  EngineRenderOptions,
  EngineRenderReport,
  ToolErr,
  ToolResult,
} from "../src/types.js";
import { abortedSignal, freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNED_URL = "https://cdn.example.com/previews/p-1024-r7.png?sig=abc123";
const STORAGE_KEY = "renders/organizations/org_1/documents/doc_1/preview-1024-r7.png";

/** Minimal PNG: signature + IHDR length + "IHDR" + BE dimensions (offsets ≤ 24). */
function pngBytes(widthPx: number, heightPx: number, pad = 0): Uint8Array {
  const bytes = new Uint8Array(24 + pad);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, widthPx, false);
  new DataView(bytes.buffer).setUint32(20, heightPx, false);
  return bytes;
}

interface RecordedRender {
  readonly options: EngineRenderOptions;
}

interface EngineScript {
  readonly report?: EngineRenderReport;
  readonly failWith?: EngineFailure;
  readonly throwWith?: Error;
  /** Hook fired inside render() — used to abort the run signal mid-flight. */
  readonly onRender?: (options: EngineRenderOptions) => void;
}

function makeEngine(script: EngineScript = {}) {
  const renders: RecordedRender[] = [];
  const report: EngineRenderReport = script.report ?? {
    image: pngBytes(1024, 512),
    widthPx: 1024,
    heightPx: 512,
    revision: 7,
  };
  const engine: EngineLike = {
    batch: async () => ({ ok: true, value: { revision: 1, outcomes: [] } }),
    execute: async () => ({ ok: true, value: { revision: 1 } }),
    async render(options) {
      renders.push({ options });
      script.onRender?.(options);
      if (script.throwWith !== undefined) {
        throw script.throwWith;
      }
      if (script.failWith !== undefined) {
        return script.failWith;
      }
      return { ok: true, value: report };
    },
    inspect: async () => ({
      ok: true,
      value: { revision: 1, widthPx: 800, heightPx: 600, layers: [] },
    }),
    listLayers: async () => ({ ok: true, value: [] }),
  };
  return { engine, renders };
}

interface RecordedPut {
  readonly mode: "bytes" | "enginePath";
  readonly payload: Uint8Array | string;
  readonly meta: PreviewPutMeta;
}

interface SinkScript {
  readonly url?: string;
  readonly key?: string;
  readonly failWith?: EngineFailure;
  readonly throwWith?: Error;
  /** When set, putEnginePath is omitted from the sink entirely. */
  readonly omitEnginePath?: boolean;
}

function makeSink(script: SinkScript = {}) {
  const puts: RecordedPut[] = [];
  const url = script.url ?? SIGNED_URL;
  const key = script.key ?? STORAGE_KEY;
  const success = (): EngineOutcome<PreviewSinkPut> => ({
    ok: true,
    value: { previewUrl: url, storageKey: key },
  });
  const outcome = (): EngineOutcome<PreviewSinkPut> => {
    if (script.throwWith !== undefined) {
      throw script.throwWith;
    }
    if (script.failWith !== undefined) {
      return script.failWith;
    }
    return success();
  };
  const previews: PreviewSinkLike = {
    async put(bytes, meta) {
      puts.push({ mode: "bytes", payload: bytes, meta });
      return outcome();
    },
    ...(script.omitEnginePath === true
      ? {}
      : {
          async putEnginePath(path: string, meta: PreviewPutMeta) {
            puts.push({ mode: "enginePath", payload: path, meta });
            return outcome();
          },
        }),
  };
  return { previews, puts };
}

function makeContext(parts: {
  engine: ReturnType<typeof makeEngine>;
  sink: ReturnType<typeof makeSink>;
}): RenderPreviewContext {
  return {
    ...makeFakeContext(),
    engine: parts.engine.engine,
    previews: parts.sink.previews,
  };
}

function parsedArgs(raw: Record<string, unknown> = {}): RenderPreviewArgs {
  const parsed = parseToolArgs(renderPreviewTool, raw);
  if (!parsed.ok) {
    throw new Error(`fixture args failed schema: ${parsed.hint ?? ""}`);
  }
  return parsed.args;
}

async function run(
  ctx: RenderPreviewContext,
  raw: Record<string, unknown> = {},
  signal: AbortSignal = freshSignal(),
): Promise<ToolResult> {
  return renderPreviewTool.run(ctx, parsedArgs(raw), signal);
}

function asErr(result: ToolResult): ToolErr {
  if (result.ok) {
    throw new Error("expected an error result");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Strict schema + clamp table (256/512/1024 pass, 2048 rejected)
// ---------------------------------------------------------------------------

describe("render_preview argument schema (§6.1)", () => {
  it("defaults width to 1024", () => {
    expect(parsedArgs()).toEqual({ width: 1024 });
  });

  it.each(PREVIEW_WIDTHS)("accepts width %i px", (width) => {
    expect(parsedArgs({ width })).toEqual({ width });
  });

  it.each([2048, 4096, 0, -256, 512.5, "512", "1024", null, Number.NaN])(
    "rejects width %p (agent ceiling 1024, §5.1)",
    (width) => {
      const parsed = parseToolArgs(renderPreviewTool, { width });
      expect(parsed.ok).toBe(false);
      expect(asErr(parsed as ToolResult).code).toBe("invalid_args");
    },
  );

  it("rejects unknown properties (strict, §6.1)", () => {
    const parsed = parseToolArgs(renderPreviewTool, { width: 512, revision: 7 });
    expect(parsed.ok).toBe(false);
  });

  it("rejects non-object roots", () => {
    for (const raw of [null, [], 42, "wide"]) {
      expect(parseToolArgs(renderPreviewTool, raw).ok).toBe(false);
    }
  });

  it("invalid_args envelopes carry issue paths, never echoed values", () => {
    const parsed = parseToolArgs(renderPreviewTool, { width: 2048 });
    expect(parsed.ok).toBe(false);
    const failure = asErr(parsed as ToolResult);
    expect(failure.code).toBe("invalid_args");
    expect(failure.retryable).toBe(false);
    expect(failure.hint).toContain("width");
  });
});

describe("clampRenderWidth (budgets seam mirror, §5.1 ≤1024 / §2.2 2048 hard)", () => {
  it.each([
    [256, 256, false],
    [512, 512, false],
    [1024, 1024, false],
  ])("passes the allowed scale: %i px", (requested, width, clamped) => {
    const result = clampRenderWidth(requested);
    expect(result).toEqual({ ok: true, value: { width, clamped } });
  });

  it.each([
    [2048, 1024],
    [4096, 1024],
    [1025, 1024],
  ])(
    "clamps %i px down to the 1024 agent ceiling (2048 hard cap never binds)",
    (requested, width) => {
      const result = clampRenderWidth(requested);
      expect(result).toEqual({ ok: true, value: { width, clamped: true } });
    },
  );

  it.each([0, 0.5, 0.9])("treats %p as no explicit size → ceiling 1024", (requested) => {
    const result = clampRenderWidth(requested);
    expect(result).toEqual({ ok: true, value: { width: 1024, clamped: true } });
  });

  it("floors fractional requests below the ceiling", () => {
    expect(clampRenderWidth(100.9)).toEqual({ ok: true, value: { width: 100, clamped: true } });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects %p as invalid_args",
    (requested) => {
      const result = clampRenderWidth(requested);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid_args");
        expect(result.retryable).toBe(false);
      }
    },
  );

  it("pins the policy constants", () => {
    expect(AGENT_PREVIEW_CEILING_PX).toBe(1024);
    expect(ENGINE_HARD_PREVIEW_CEILING_PX).toBe(2048);
    expect(PREVIEW_RENDER_TIMEOUT_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Happy path — inline-bytes arm (§6 row 14: doc.render ≤1024 → sink → URL)
// ---------------------------------------------------------------------------

describe("render_preview happy path", () => {
  it("renders, persists and returns the preview URL with width + revision", async () => {
    const engine = makeEngine();
    const sink = makeSink();
    const signal = freshSignal();
    const result = await run(makeContext({ engine, sink }), {}, signal);

    expect(result.ok).toBe(true);
    expect(result).toEqual({
      ok: true,
      summary: `{"previewUrl":"${SIGNED_URL}","width":1024,"revision":7}`,
      documentRevision: 7,
      previewUrl: SIGNED_URL,
    });
    expect(isToolResult(result)).toBe(true);

    // Engine seam: clamped edge + the executor's §3.4 signal, verbatim.
    expect(engine.renders).toEqual([{ options: { maxEdgePx: 1024, signal } }]);

    // Sink: bytes arm, §13.1 cache identity parts in meta.
    expect(sink.puts).toEqual([
      {
        mode: "bytes",
        payload: pngBytes(1024, 512),
        meta: { width: 1024, revision: 7, byteLength: 24 },
      },
    ]);
  });

  it("honours width 256: clamped edge, summary width and key identity", async () => {
    const engine = makeEngine();
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }), { width: 256 });
    expect(result.ok).toBe(true);
    expect(engine.renders[0]?.options.maxEdgePx).toBe(256);
    expect(JSON.parse(result.ok === true ? result.summary : "{}")).toEqual({
      previewUrl: SIGNED_URL,
      width: 256,
      revision: 7,
    });
    expect(sink.puts[0]?.meta.width).toBe(256);
  });

  it("carries storage-key URLs in the summary only (not fetchable for the envelope)", async () => {
    const sink = makeSink({ url: STORAGE_KEY });
    const result = await run(makeContext({ engine: makeEngine(), sink }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.summary)).toEqual({
        previewUrl: STORAGE_KEY,
        width: 1024,
        revision: 7,
      });
      expect(result.previewUrl).toBeUndefined();
    }
    expect(isToolResult(result)).toBe(true);
  });

  it("propagates revision 0 as a valid document revision", async () => {
    const engine = makeEngine({
      report: { image: pngBytes(64, 64), widthPx: 64, heightPx: 64, revision: 0 },
    });
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }));
    expect(result).toMatchObject({ ok: true, documentRevision: 0 });
    expect(JSON.parse(result.ok === true ? result.summary : "{}").revision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Revision propagation + warnings
// ---------------------------------------------------------------------------

describe("render_preview revision propagation", () => {
  it("omits revision + warns when the reply carries none", async () => {
    const engine = makeEngine({ report: { image: pngBytes(64, 64), widthPx: 64, heightPx: 64 } });
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const summary = JSON.parse(result.summary);
      expect(summary).toEqual({ previewUrl: SIGNED_URL, width: 1024 });
      expect(summary.revision).toBeUndefined();
      expect(result.documentRevision).toBeUndefined();
      expect(result.warnings).toEqual(["the render reply did not carry a document revision"]);
    }
    expect(sink.puts[0]?.meta.revision).toBeUndefined();
  });

  it("treats a malformed revision as absent + warns (defensive read)", async () => {
    const engine = makeEngine({
      report: {
        image: pngBytes(64, 64),
        widthPx: 64,
        heightPx: 64,
        revision: -3 as number,
      },
    });
    const result = await run(makeContext({ engine, sink: makeSink() }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.documentRevision).toBeUndefined();
      expect(result.warnings).toEqual(["the render reply did not carry a document revision"]);
    }
  });

  it("warns when the rendered PNG is wider than the requested cap", async () => {
    const engine = makeEngine({
      report: { image: pngBytes(2048, 1024), widthPx: 2048, heightPx: 1024, revision: 7 },
    });
    const result = await run(makeContext({ engine, sink: makeSink() }), { width: 256 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContain(
        "rendered preview is 2048 px wide, above the requested 256 px cap",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// PNG validation (§6 row 14 magic check; §2.2 size budget re-check)
// ---------------------------------------------------------------------------

describe("render_preview PNG validation", () => {
  const notPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  it.each([
    ["jpeg magic", notPng],
    ["truncated", pngBytes(64, 64).subarray(0, 6)],
    [
      "bad IHDR",
      (() => {
        const bytes = pngBytes(64, 64);
        bytes.set([0x4a, 0x55, 0x4e, 0x4b], 12); // "JUNK"
        return bytes;
      })(),
    ],
  ])("rejects a payload with %s before reaching the sink", async (_label, image) => {
    const engine = makeEngine({ report: { image, widthPx: 64, heightPx: 64, revision: 7 } });
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }));

    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("not a valid PNG");
    expect(failure.retryable).toBe(false);
    expect(sink.puts).toEqual([]);
  });

  it("rejects a PNG above the 5 MiB engine budget (§2.2)", async () => {
    const engine = makeEngine({
      report: {
        image: pngBytes(64, 64, ENGINE_PNG_MAX_BYTES - 23),
        widthPx: 64,
        heightPx: 64,
        revision: 7,
      },
    });
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }));

    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.hint).toContain("5 MiB");
    expect(sink.puts).toEqual([]);
  });

  it("rejects a reply with neither bytes nor a write-root path", async () => {
    const engine = makeEngine({
      report: {
        image: new Uint8Array(0),
        widthPx: 0,
        heightPx: 0,
        revision: 7,
      },
    });
    const result = await run(makeContext({ engine, sink: makeSink() }));
    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("neither PNG bytes nor a write-root path");
  });
});

// ---------------------------------------------------------------------------
// Engine file arm — the engine's write-root path goes to the SAME sink
// ---------------------------------------------------------------------------

describe("render_preview engine-path arm (§3.2 capability roots)", () => {
  const PATH_REPORT: EngineRenderReport = {
    image: new Uint8Array(0),
    widthPx: 1024,
    heightPx: 512,
    revision: 9,
    path: "renders/preview-1024-r9.png",
  } as EngineRenderReport;

  it("ingests a write-root path through putEnginePath", async () => {
    const engine = makeEngine({ report: PATH_REPORT });
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.summary)).toEqual({
        previewUrl: SIGNED_URL,
        width: 1024,
        revision: 9,
      });
      expect(result.documentRevision).toBe(9);
    }
    expect(sink.puts).toEqual([
      {
        mode: "enginePath",
        payload: "renders/preview-1024-r9.png",
        meta: { width: 1024, revision: 9 },
      },
    ]);
  });

  it.each([
    ["absolute path", "/etc/passwd"],
    ["file:// scheme", "file:///tmp/preview.png"],
    ["traversal", "renders/../../etc/preview.png"],
    ["backslash", "renders\\preview.png"],
    ["trailing slash", "renders/"],
    ["double slash", "renders//preview.png"],
  ])("refuses %s outside the write root before calling the sink", (_label, path) => {
    expect(isEngineWriteRootPath(path)).toBe(false);
  });

  it("rejects an out-of-root path without touching the sink", async () => {
    const engine = makeEngine({
      report: { ...PATH_REPORT, path: "/etc/passwd" } as EngineRenderReport,
    });
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }));

    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("outside its write root");
    expect(sink.puts).toEqual([]);
  });

  it("fails with a wiring hint when the sink lacks putEnginePath", async () => {
    const engine = makeEngine({ report: PATH_REPORT });
    const sink = makeSink({ omitEnginePath: true });
    const result = await run(makeContext({ engine, sink }));

    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("cannot ingest engine write-root paths");
    expect(failure.hint).toContain("putEnginePath");
    expect(sink.puts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sink-contract enforcement (§6.1: previewUrl NEVER a filesystem path)
// ---------------------------------------------------------------------------

describe("render_preview sink contract", () => {
  it.each([
    ["a file:// URL", "file:///var/lib/studio/preview.png"],
    ["an absolute filesystem path", "/var/lib/studio/preview.png"],
    ["a drive-letter path", "C:\\Users\\studio\\preview.png"],
    ["a non-http scheme", "ftp://example.com/preview.png"],
    ["an uppercase scheme", "HTTP://cdn.example.com/preview.png"],
    ["traversal", "renders/../../etc/preview.png"],
    ["an empty string", ""],
  ])("rejects %s as a previewUrl", async (_label, url) => {
    const sink = makeSink({ url });
    const result = await run(makeContext({ engine: makeEngine(), sink }));

    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("unsafe preview URL");
    expect(failure.hint).toContain("§6.1");
    // §6.1: the offending value is never echoed (empty strings vacuously match).
    if (url.length > 0) {
      expect(failure.message.includes(url)).toBe(false);
    }
  });

  it("rejects an oversized previewUrl outright", async () => {
    const sink = makeSink({ url: `https://${"a".repeat(2041)}.png` });
    const result = await run(makeContext({ engine: makeEngine(), sink }));
    expect(asErr(result).code).toBe("internal_error");
  });

  it("fails cleanly when the URL cannot fit the compact reply (§6.1)", async () => {
    const url = `https://${"a".repeat(1982)}.png`; // 1990 chars: legal URL, bloated summary
    const sink = makeSink({ url });
    const result = await run(makeContext({ engine: makeEngine(), sink }));

    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("too long to fit the compact reply");
  });

  it("accepts a long-but-fitting signed URL", async () => {
    const url = `https://${"a".repeat(1900 - 8)}.png`;
    const sink = makeSink({ url });
    const result = await run(makeContext({ engine: makeEngine(), sink }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["an empty storage key", ""],
    ["an absolute storage key", "/renders/preview.png"],
    ["a traversal storage key", "renders/../secret.png"],
  ])("rejects %s", async (_label, key) => {
    const sink = makeSink({ key });
    const result = await run(makeContext({ engine: makeEngine(), sink }));
    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("invalid storage key");
    if (key.length > 0) {
      expect(failure.message.includes(key)).toBe(false);
    }
  });

  it("mirrors a sink EngineFailure envelope", async () => {
    const sink = makeSink({
      failWith: {
        ok: false,
        code: "storage_error",
        message: "object storage rejected the put",
        hint: "check the bucket policy",
        retryable: true,
      },
    });
    const result = await run(makeContext({ engine: makeEngine(), sink }));
    expect(result).toEqual({
      ok: false,
      code: "storage_error",
      message: "object storage rejected the put",
      hint: "check the bucket policy",
      retryable: true,
    });
  });

  it("maps a throwing sink to storage_error (retryable, no leak)", async () => {
    const sink = makeSink({ throwWith: new Error("ECONNREFUSED 127.0.0.1:6379 /run/secrets") });
    const result = await run(makeContext({ engine: makeEngine(), sink }));

    const failure = asErr(result);
    expect(failure.code).toBe("storage_error");
    expect(failure.retryable).toBe(true);
    expect(failure.message).not.toContain("ECONNREFUSED");
    expect(failure.hint ?? "").toContain("§14.2");
  });

  it("fails with a wiring hint when ctx.previews is missing", async () => {
    const result = await renderPreviewTool.run(makeFakeContext(), parsedArgs(), freshSignal());
    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toContain("preview-sink seam");
    expect(failure.hint).toContain("ctx.previews");
  });
});

// ---------------------------------------------------------------------------
// Timeout abort (§3.4: 30 s render; AbortSignal via the executor)
// ---------------------------------------------------------------------------

describe("render_preview timeout semantics (§3.4)", () => {
  it("never starts on a pre-aborted signal", async () => {
    const engine = makeEngine();
    const result = await run(makeContext({ engine, sink: makeSink() }), {}, abortedSignal());

    const failure = asErr(result);
    expect(failure.code).toBe("engine_timeout");
    expect(failure.retryable).toBe(false);
    expect(engine.renders).toEqual([]);
  });

  it("converts a mid-flight AbortError into engine_timeout (retryable)", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const engine = makeEngine({ throwWith: abortError });
    const result = await run(makeContext({ engine, sink: makeSink() }));

    const failure = asErr(result);
    expect(failure.code).toBe("engine_timeout");
    expect(failure.retryable).toBe(true);
  });

  it("refuses to persist when the deadline hit during the render", async () => {
    const controller = new AbortController();
    const engine = makeEngine({ onRender: () => controller.abort() });
    const sink = makeSink();
    const result = await run(makeContext({ engine, sink }), {}, controller.signal);

    const failure = asErr(result);
    expect(failure.code).toBe("engine_timeout");
    expect(failure.message).toContain("after the tool deadline");
    expect(sink.puts).toEqual([]);
  });

  it("passes the executor's signal to the engine seam verbatim (identity)", async () => {
    const engine = makeEngine();
    const signal = freshSignal();
    await run(makeContext({ engine, sink: makeSink() }), {}, signal);
    expect(engine.renders[0]?.options.signal).toBe(signal);
  });

  it("mirrors an engine_timeout failure from the seam", async () => {
    const engine = makeEngine({
      failWith: {
        ok: false,
        code: "engine_timeout",
        message: "doc.render exceeded 30 s",
        retryable: true,
      },
    });
    const result = await run(makeContext({ engine, sink: makeSink() }));
    expect(result).toMatchObject({ ok: false, code: "engine_timeout", retryable: true });
  });
});

// ---------------------------------------------------------------------------
// Engine failure passthrough (§6.1: sanitized, actionable)
// ---------------------------------------------------------------------------

describe("render_preview engine failures", () => {
  it("mirrors an EngineFailure envelope with hint + retryable", async () => {
    const engine = makeEngine({
      failWith: {
        ok: false,
        code: "engine_unavailable",
        message: "No engine session can serve this document",
        hint: "Retry after the pool drains an idle session",
        retryable: true,
      },
    });
    const result = await run(makeContext({ engine, sink: makeSink() }));
    expect(result).toEqual({
      ok: false,
      code: "engine_unavailable",
      message: "No engine session can serve this document",
      hint: "Retry after the pool drains an idle session",
      retryable: true,
    });
  });

  it("maps a transport throw to internal_error without leaking paths", async () => {
    const engine = makeEngine({ throwWith: new Error("ECONNRESET /var/run/engine.sock") });
    const result = await run(makeContext({ engine, sink: makeSink() }));

    const failure = asErr(result);
    expect(failure.code).toBe("internal_error");
    expect(failure.message).toBe("The tool failed unexpectedly");
    expect(failure.message.includes("/var/run")).toBe(false);
    expect(failure.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure reply builders + predicates
// ---------------------------------------------------------------------------

describe("buildPreviewSummary (§6.1 compact JSON)", () => {
  it("embeds revision when known", () => {
    expect(buildPreviewSummary(SIGNED_URL, 512, 7)).toBe(
      `{"previewUrl":"${SIGNED_URL}","width":512,"revision":7}`,
    );
  });

  it("omits revision when unknown", () => {
    expect(JSON.parse(buildPreviewSummary(STORAGE_KEY, 256, undefined))).toEqual({
      previewUrl: STORAGE_KEY,
      width: 256,
    });
  });
});

describe("isSafePreviewUrlValue (§6.1)", () => {
  it.each([
    ["https signed URL", `${SIGNED_URL}?X-Amz-Signature=abc&X-Amz-Expires=900`, true],
    ["plain http URL", "http://localhost:3000/v1/documents/doc_1/preview?w=1024", true],
    ["object-storage key", STORAGE_KEY, true],
    ["flat key", "previews/preview.png", true],
    ["file URL", "file:///tmp/preview.png", false],
    ["absolute path", "/var/lib/preview.png", false],
    ["root-relative route", "/v1/documents/doc_1/preview", false],
    ["drive letter", "C:/Users/preview.png", false],
    ["traversal", "renders/../../x.png", false],
    ["backslash", "renders\\preview.png", false],
    ["double slash", "renders//preview.png", false],
    ["trailing slash", "renders/preview.png/", false],
    ["spaces", "renders/preview name.png", false],
    ["empty", "", false],
    ["oversized", `https://${"a".repeat(2041)}.png`, false],
  ])("classifies %s", (_label, url, expected) => {
    expect(isSafePreviewUrlValue(url)).toBe(expected);
  });
});

describe("isEngineWriteRootPath (§3.2 capability roots)", () => {
  it.each([
    ["session render path", "renders/preview-1024-r7.png", true],
    ["nested path", "sessions/s1/renders/preview.png", true],
    ["bare filename", "preview.png", true],
    ["dotted filename", "preview.v2.png", true],
    ["absolute path", "/etc/passwd", false],
    ["file scheme", "file:///tmp/preview.png", false],
    ["traversal", "renders/../x.png", false],
    ["backslash", "renders\\preview.png", false],
    ["trailing slash", "renders/", false],
    ["double slash", "renders//p.png", false],
    ["empty", "", false],
    ["oversized", `${"a".repeat(513)}.png`, false],
  ])("classifies %s", (_label, path, expected) => {
    expect(isEngineWriteRootPath(path)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Registry pinning (§6 surface)
// ---------------------------------------------------------------------------

describe("render_preview registration", () => {
  it("registers on the pinned §6 surface under TOOLS.render_preview", () => {
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(renderPreviewTool)).toEqual({ ok: true });
    const lookup = registry.get(TOOLS.render_preview);
    expect(lookup.ok).toBe(true);
    const listing = registry.list().find((entry) => entry.name === "render_preview");
    expect(listing?.description).toContain("preview");
  });
});
