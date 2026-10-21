// W6-C — ObserverService: §5.1 "observe after act" via injected seams, the
// document-summary DELTA mode, and the cross-module §5.4 prefix assertion.
import { describe, expect, it } from "vitest";
import {
  type ContextInput,
  ContextAssembler,
  canonicalStringify,
} from "../src/observer/context.js";
import {
  type LayerDelta,
  type Observation,
  type PreviewReport,
  type SnapshotReport,
  type SnapshotLike,
  type PreviewLike,
  type ObserverSeams,
  ObserverService,
  buildDeltaSummary,
  diffLayers,
  parseSummary,
} from "../src/observer/observer.js";

// ---------------------------------------------------------------------------
// Fakes (seams are worker-wired in production; tests wire plain objects)
// ---------------------------------------------------------------------------

const CANVAS = { widthPx: 1080, heightPx: 1350 };

function layerRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `layer ${id}`, kind: "text", visible: true, ...extra };
}

function summaryJson(
  layers: readonly unknown[],
  canvas: { widthPx: number; heightPx: number } = CANVAS,
): string {
  return JSON.stringify({ canvas, layers });
}

interface Seams extends ObserverSeams {
  readonly snapshotCalls: string[];
  readonly previewCalls: string[];
}

function makeSeams(
  snapshot: (documentId: string) => string | SnapshotReport,
  preview: (documentId: string) => PreviewReport = () => ({
    previewUrl: "https://cdn.example/preview.png",
    revision: 9,
  }),
): Seams {
  const snapshotCalls: string[] = [];
  const previewCalls: string[] = [];
  const snapshotSeam: SnapshotLike = {
    async compact(documentId: string) {
      snapshotCalls.push(documentId);
      return snapshot(documentId);
    },
  };
  const previewSeam: PreviewLike = {
    async render(documentId: string) {
      previewCalls.push(documentId);
      return preview(documentId);
    },
  };
  return { snapshot: snapshotSeam, preview: previewSeam, snapshotCalls, previewCalls };
}

function expectOk(result: Awaited<ReturnType<ObserverService["afterAction"]>>): Observation {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

const DOC_A = "01959d1e-7c2a-7bbb-8d1a-2f6f5c4a0001";

// ---------------------------------------------------------------------------
// Full observations (§5.1 first turn + explicit mode)
// ---------------------------------------------------------------------------

describe("observer: full observations", () => {
  it("first observation (auto) is full: tool bytes verbatim + envelope revision + preview url", async () => {
    const summary = summaryJson([layerRow("1"), layerRow("2")]);
    const seams = makeSeams(() => ({ summary, revision: 7, warnings: [] }));
    const service = new ObserverService(seams);
    const observation = expectOk(await service.afterAction(DOC_A));
    expect(observation.mode).toBe("full");
    expect(observation.compactSummary).toBe(summary); // verbatim tool bytes
    expect(observation.previewUrl).toBe("https://cdn.example/preview.png");
    expect(observation.revision).toBe(7);
    expect(observation.warnings).toEqual([]);
    expect(seams.snapshotCalls).toEqual([DOC_A]);
    expect(seams.previewCalls).toEqual([DOC_A]);
    expect(service.hasObserved(DOC_A)).toBe(true);
  });

  it("the pinned minimal seam (compact(): Promise<string>) works; revision falls back to preview", async () => {
    const summary = summaryJson([layerRow("1")]);
    const seams = makeSeams(() => summary);
    const service = new ObserverService(seams);
    const observation = expectOk(await service.afterAction(DOC_A));
    expect(observation.compactSummary).toBe(summary);
    expect(observation.revision).toBe(9); // from PreviewReport.revision
  });

  it("revision fallback chain ends at the prior observation", async () => {
    const states: (string | SnapshotReport)[] = [
      { summary: summaryJson([layerRow("1")]), revision: 5 },
      "l", // bare string, no preview revision either
    ];
    let call = 0;
    const seams = makeSeams(
      () => states[call] ?? "",
      () => ({ previewUrl: "https://cdn.example/p.png" }), // no revision
    );
    const service = new ObserverService(seams);
    expectOk(await service.afterAction(DOC_A));
    call = 1;
    const second = expectOk(await service.afterAction(DOC_A));
    expect(second.revision).toBe(5); // prior fallback keeps it stable
  });

  it("envelope warnings surface before preview warnings", async () => {
    const seams = makeSeams(
      () => ({ summary: summaryJson([layerRow("1")]), warnings: ["layer tree truncated"] }),
      () => ({ previewUrl: undefined }),
    );
    const service = new ObserverService(seams);
    const observation = expectOk(await service.afterAction(DOC_A));
    expect(observation.warnings[0]).toBe("layer tree truncated");
    expect(observation.warnings.some((w) => w.includes("preview unavailable"))).toBe(true);
  });

  it("explicit mode 'full' stays full even with a prior observation", async () => {
    const summaries = [
      summaryJson([layerRow("1")]),
      summaryJson([layerRow("1"), layerRow("2")]),
    ];
    let call = 0;
    const seams = makeSeams(() => summaries[call] ?? "");
    const service = new ObserverService(seams);
    expectOk(await service.afterAction(DOC_A));
    call = 1;
    const second = expectOk(await service.afterAction(DOC_A, { mode: "full" }));
    expect(second.mode).toBe("full");
    expect(second.compactSummary).toBe(summaries[1]);
  });
});

// ---------------------------------------------------------------------------
// DELTA mode (§5.4 token discipline — cheaper context, stable prefix)
// ---------------------------------------------------------------------------

describe("observer: delta mode", () => {
  function deltaService(summaries: readonly string[], preview?: (id: string) => PreviewReport) {
    let call = 0;
    const seams = makeSeams(() => summaries[call++] ?? "", preview);
    return new ObserverService(seams);
  }

  it("auto: first full, then only changed/added layers + counts", async () => {
    const before = summaryJson([
      layerRow("1", { name: "hero" }),
      layerRow("2", { name: "sub" }),
      layerRow("3", { name: "cta" }),
    ]);
    const after = summaryJson([
      layerRow("1", { name: "hero" }),
      layerRow("2", { name: "renamed sub" }), // changed
      layerRow("4", { name: "new layer" }), // added
      // "3" removed
    ]);
    const service = deltaService([before, after]);
    const first = expectOk(await service.afterAction(DOC_A));
    expect(first.mode).toBe("full");

    const second = expectOk(await service.afterAction(DOC_A));
    expect(second.mode).toBe("delta");
    const parsed = JSON.parse(second.compactSummary) as {
      revision: number;
      canvas: unknown;
      delta: {
        added: { id: string }[];
        changed: { id: string; name: string }[];
        removed: string[];
        unchanged: number;
        total: number;
      };
    };
    expect(parsed.delta.added).toEqual([layerRow("4", { name: "new layer" })]);
    expect(parsed.delta.changed).toEqual([layerRow("2", { name: "renamed sub" })]);
    expect(parsed.delta.removed).toEqual(["3"]);
    expect(parsed.delta.unchanged).toBe(1);
    expect(parsed.delta.total).toBe(3);
    expect(parsed.canvas).toEqual(CANVAS);
    // The untouched row never re-serializes into the delta (cheaper context).
    expect(second.compactSummary).not.toContain('"hero"');
    // Canonical bytes: stable key order round-trips.
    expect(canonicalStringify(JSON.parse(second.compactSummary))).toBe(second.compactSummary);
  });

  it("a no-change turn is an all-empty delta (counts only)", async () => {
    const same = summaryJson([layerRow("1"), layerRow("2")]);
    const service = deltaService([same, same]);
    expectOk(await service.afterAction(DOC_A));
    const second = expectOk(await service.afterAction(DOC_A));
    expect(second.mode).toBe("delta");
    expect(JSON.parse(second.compactSummary)).toEqual({
      revision: 9,
      canvas: CANVAS,
      delta: { added: [], changed: [], removed: [], unchanged: 2, total: 2 },
    });
    expect(second.compactSummary.length).toBeLessThan(same.length); // cheaper
  });

  it("explicit 'delta' without a prior observation degrades to full + warning", async () => {
    const service = deltaService([summaryJson([layerRow("1")])]);
    const observation = expectOk(await service.afterAction(DOC_A, { mode: "delta" }));
    expect(observation.mode).toBe("full");
    expect(observation.warnings.some((w) => w.includes("no prior observation"))).toBe(true);
  });

  it("explicit 'delta' with an unparseable summary degrades to full + warning", async () => {
    const service = deltaService(["<not json at all>", "<still not json>"]);
    expectOk(await service.afterAction(DOC_A));
    const second = expectOk(await service.afterAction(DOC_A, { mode: "delta" }));
    expect(second.mode).toBe("full");
    expect(second.compactSummary).toBe("<still not json>");
    expect(
      second.warnings.some((w) => w.includes("no trackable layer rows")),
    ).toBe(true);
  });

  it("explicit 'delta' with a layers-less summary degrades to full + warning", async () => {
    const service = deltaService(['{"canvas":{"widthPx":1,"heightPx":1}}', '{"ok":true}']);
    expectOk(await service.afterAction(DOC_A));
    const second = expectOk(await service.afterAction(DOC_A, { mode: "delta" }));
    expect(second.mode).toBe("full");
    expect(second.warnings.some((w) => w.includes("no trackable layer rows"))).toBe(true);
  });

  it("id-less rows are untrackable: warning + delta still emitted", async () => {
    const before = summaryJson([layerRow("1"), { name: "ghost" }]);
    const after = summaryJson([layerRow("1")]);
    const service = deltaService([before, after]);
    expectOk(await service.afterAction(DOC_A));
    const second = expectOk(await service.afterAction(DOC_A));
    expect(second.mode).toBe("delta");
    expect(second.warnings.some((w) => w.includes("untrackable"))).toBe(true);
    const parsed = JSON.parse(second.compactSummary) as {
      delta: { unchanged: number; total: number };
    };
    expect(parsed.delta.unchanged).toBe(1);
    expect(parsed.delta.total).toBe(1);
  });

  it("THE §5.4 cross-module assertion: observations never shift the cached prefix", async () => {
    const assembler = new ContextAssembler();
    const staticInput: Omit<ContextInput, "documentSummary"> = {
      system: "You are a senior design agent operating a layered editor through tools.",
      styleGuide: { palette: { ink: "#3B2A20" }, fonts: ["grotesk-sans"] },
      templateManifest: { ref: "instagram-post@3" },
    };
    const before = summaryJson([layerRow("1", { name: "hero" }), layerRow("2")]);
    const after = summaryJson([layerRow("1", { name: "renamed hero" }), layerRow("2")]);
    const service = deltaService([before, after]);

    const first = expectOk(await service.afterAction(DOC_A));
    const second = expectOk(await service.afterAction(DOC_A));

    const contextBefore = assembler.assembleContext({
      ...staticInput,
      documentSummary: { summary: first.compactSummary, revision: first.revision },
    });
    const contextAfter = assembler.assembleContext({
      ...staticInput,
      documentSummary: { summary: second.compactSummary, revision: second.revision },
    });
    expect(contextAfter.cacheablePrefix).toBe(contextBefore.cacheablePrefix);
    expect(contextAfter.messages.slice(0, 3)).toEqual(contextBefore.messages.slice(0, 3));
    expect(contextAfter.sections[3]?.content).not.toBe(contextBefore.sections[3]?.content);
  });

  it("delta mode with a failed turn keeps diffing from the last good observation", async () => {
    const first = summaryJson([layerRow("1"), layerRow("2")]);
    const later = summaryJson([layerRow("1"), layerRow("2"), layerRow("3")]);
    const states: readonly (string | SnapshotReport | Error)[] = [
      first,
      new Error("engine exploded"), // snapshot failure between observations
      later,
    ];
    let call = 0;
    const seams = makeSeams(() => {
      const next = states[call];
      call += 1;
      if (next === undefined) throw new Error("no fixture");
      if (next instanceof Error) throw next;
      return next;
    });
    const service = new ObserverService(seams);
    expectOk(await service.afterAction(DOC_A));
    const failed = await service.afterAction(DOC_A);
    expect(failed.ok).toBe(false);
    const third = expectOk(await service.afterAction(DOC_A));
    expect(third.mode).toBe("delta");
    const parsed = JSON.parse(third.compactSummary) as {
      delta: { added: { id: string }[]; unchanged: number };
    };
    expect(parsed.delta.added.map((row) => row.id)).toEqual(["3"]);
    expect(parsed.delta.unchanged).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Seams: failures + §6.1/§22 discipline
// ---------------------------------------------------------------------------

describe("observer: seam failures and degradation", () => {
  it("snapshot rejection → engine_session_lost (retryable), state untouched", async () => {
    const seams = makeSeams(() => {
      throw new Error("engine exploded");
    });
    const service = new ObserverService(seams);
    const result = await service.afterAction(DOC_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_session_lost");
      expect(result.retryable).toBe(true);
      expect(result.message).not.toContain("engine exploded"); // §22: no internals
    }
    expect(service.hasObserved(DOC_A)).toBe(false); // state not clobbered
  });

  it("malformed snapshot envelope → wiring error, not retryable", async () => {
    const seams = makeSeams(() => ({ nonsense: true } as unknown as SnapshotReport));
    const service = new ObserverService(seams);
    const result = await service.afterAction(DOC_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_session_lost");
      expect(result.retryable).toBe(false);
    }
  });

  it("preview failure degrades to a warning; failure codes only, never messages (§22)", async () => {
    const seams = makeSeams(
      () => summaryJson([layerRow("1")]),
      () => ({
        failure: { code: "engine_timeout", message: "boom /internal/path http://10.0.0.1" },
      }),
    );
    const service = new ObserverService(seams);
    const observation = expectOk(await service.afterAction(DOC_A));
    expect(observation.previewUrl).toBeUndefined();
    const text = observation.warnings.join(" | ");
    expect(text).toContain("engine_timeout");
    expect(text).not.toContain("boom");
    expect(text).not.toContain("/internal/path");
  });

  it("preview throw and unsafe urls degrade (§6.1: never a filesystem path)", async () => {
    const throwing = makeSeams(
      () => summaryJson([layerRow("1")]),
      () => {
        throw new Error("render crashed");
      },
    );
    const thrownObservation = expectOk(await new ObserverService(throwing).afterAction(DOC_A));
    expect(thrownObservation.previewUrl).toBeUndefined();
    expect(thrownObservation.warnings.some((w) => w.includes("render failed"))).toBe(true);

    const unsafe = makeSeams(
      () => summaryJson([layerRow("1")]),
      () => ({ previewUrl: "file:///etc/passwd" }),
    );
    const unsafeObservation = expectOk(await new ObserverService(unsafe).afterAction(DOC_A));
    expect(unsafeObservation.previewUrl).toBeUndefined();
    expect(unsafeObservation.warnings.some((w) => w.includes("§6.1"))).toBe(true);
  });

  it("oversized compact summaries cap at the §5.4 budget with a truncation warning", async () => {
    const huge = `{"pad":"${"x".repeat(40_000)}"}`;
    const seams = makeSeams(() => ({ summary: huge, revision: 2 }));
    const service = new ObserverService(seams);
    const observation = expectOk(await service.afterAction(DOC_A));
    expect(observation.compactSummary.length).toBe(16_000);
    expect(observation.compactSummary.endsWith("…")).toBe(true);
    expect(observation.warnings.some((w) => w.includes("truncated from"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State + pure helpers
// ---------------------------------------------------------------------------

describe("observer: per-document state and reset", () => {
  const DOC_B = "01959d1e-7c2a-7bbb-8d1a-2f6f5c4a0002";

  it("documents are independent; reset() and reset(id) clear memory", async () => {
    const summaries = new Map<string, string>([
      [DOC_A, summaryJson([layerRow("1")])],
      [DOC_B, summaryJson([layerRow("9")])],
    ]);
    const service = new ObserverService(makeSeams((id) => summaries.get(id) ?? ""));
    expectOk(await service.afterAction(DOC_A));
    expectOk(await service.afterAction(DOC_B));

    const secondA = expectOk(await service.afterAction(DOC_A));
    expect(secondA.mode).toBe("delta"); // DOC_A deltas against its own prior

    service.reset(DOC_A);
    expect(service.hasObserved(DOC_A)).toBe(false);
    expect(service.hasObserved(DOC_B)).toBe(true);
    const fullA = expectOk(await service.afterAction(DOC_A));
    expect(fullA.mode).toBe("full"); // memory cleared → full again

    service.reset();
    expect(service.hasObserved(DOC_B)).toBe(false);
  });

  it("two services on identical fixtures produce identical observations", async () => {
    const fixture = summaryJson([layerRow("1"), layerRow("2")]);
    const left = new ObserverService(makeSeams(() => fixture));
    const right = new ObserverService(makeSeams(() => fixture));
    expect(await left.afterAction(DOC_A)).toEqual(await right.afterAction(DOC_A));
  });
});

describe("observer: pure delta helpers", () => {
  it("diffLayers table: added / changed / removed / unchanged / skipped", () => {
    const previous = [
      layerRow("1", { name: "kept" }),
      layerRow("2", { name: "old" }),
      layerRow("3"),
      { name: "id-less ghost" },
    ];
    const current = [
      layerRow("1", { name: "kept" }),
      layerRow("2", { name: "new" }),
      layerRow("10"),
      { nope: true },
    ];
    const delta = diffLayers(previous, current);
    expect(delta.added).toEqual([layerRow("10")]);
    expect(delta.changed).toEqual([layerRow("2", { name: "new" })]);
    expect(delta.removed).toEqual(["3"]);
    expect(delta.unchanged).toBe(1);
    expect(delta.total).toBe(3);
    expect(delta.skipped).toBe(2);
  });

  it("diffLayers with no prior → everything added", () => {
    const delta = diffLayers(undefined, [layerRow("1"), layerRow("2")]);
    expect(delta.added).toHaveLength(2);
    expect(delta.unchanged).toBe(0);
    expect(delta.removed).toEqual([]);
  });

  it("diffLayers: any-field change counts (canonical row bytes)", () => {
    const delta = diffLayers(
      [layerRow("1", { visible: true })],
      [layerRow("1", { visible: false })],
    );
    expect(delta.changed).toHaveLength(1);
    expect(delta.unchanged).toBe(0);
  });

  it("buildDeltaSummary emits canonical bytes with only counts when nothing changed", () => {
    const empty: LayerDelta = {
      added: [],
      changed: [],
      removed: [],
      unchanged: 4,
      total: 4,
      skipped: 0,
    };
    const text = buildDeltaSummary(empty, { revision: 2, canvas: CANVAS });
    expect(text).toBe(
      '{"canvas":{"heightPx":1350,"widthPx":1080},"delta":{"added":[],"changed":[],"removed":[],"total":4,"unchanged":4},"revision":2}',
    );
  });

  it("parseSummary: unparseable → undefined; parseable without layers → no layers", () => {
    expect(parseSummary("nope")).toBeUndefined();
    const parsed = parseSummary('{"canvas":{"widthPx":10,"heightPx":10}}');
    expect(parsed?.layers).toBeUndefined();
    const full = parseSummary(summaryJson([layerRow("1")]));
    expect(full?.layers).toEqual([layerRow("1")]);
    expect(full?.canvas).toEqual(CANVAS);
  });
});
