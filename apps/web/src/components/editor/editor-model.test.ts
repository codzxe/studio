/**
 * Pure-logic tests for the editor model (W8-F): §13.1 wire schemas against
 * the exact shapes the gateway waves ship (W4-F/W4-G/W4-K/W4-L), layer-tree
 * helpers, presentation formatting and the chat-edit message builders
 * (§23.5/§24.2). Deterministic, no DOM, no network, <5 s.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  countLayers,
  documentPayloadSchema,
  errorText,
  extractRunError,
  findLayer,
  fitScale,
  flattenLayerTree,
  formatBounds,
  formatOpacity,
  isTerminalRunStatus,
  layerTreeSchema,
  makeNoticeMessage,
  makeRunMessage,
  makeTextMessage,
  normalizeLayerKind,
  previewPath,
  previewReplySchema,
  commandReplySchema,
  runCreatedReplySchema,
  runDetailSchema,
  setLayerVisible,
  updateRunMessage,
  visibilityCommand,
  type ChatMessage,
  type LayerNode,
} from "./editor-model";

// ---------------------------------------------------------------------------
// Wire fixtures — byte-mirrors of the gateway DTOs (files cited in the model)
// ---------------------------------------------------------------------------

const documentDto = {
  id: "d_123",
  name: "Coffee promo",
  width_px: 1080,
  height_px: 1350,
  current_revision: 46,
  template_id: "instagram-post@3",
  created_by: "user_1",
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:05:00.000Z",
  archived_at: null,
  latest_version: {
    id: "v_46",
    revision: 46,
    label: "First draft",
    created_by: "user_1",
    created_at: "2026-10-01T10:05:00.000Z",
  },
};

/** §10.1's canonical tree (Background → Photo → Content/Headline… → Brand/Badge). */
const layerTreeFixture = [
  { id: "l-bg", name: "Background", kind: "fill", visible: true, locked: true, bounds: [0, 0, 1080, 1350] },
  { id: "l-photo", name: "Photo — Latte", kind: "smart object", visible: true, opacity: 1, bounds: [0, 120, 1080, 900] },
  {
    id: "l-content",
    name: "Content",
    kind: "group",
    visible: true,
    expanded: true,
    children: [
      { id: "l-hl", name: "Headline", kind: "type", visible: true, bounds: [96, 1000, 888, 180] },
      { id: "l-sub", name: "Subhead", kind: "type", visible: true, opacity: 0.8, bounds: [96, 1200, 888, 90] },
    ],
  },
  { id: "l-badge", name: "Offer Badge — 20%", kind: "component instance", visible: true, bounds: [812, 64, 200, 200] },
] as unknown as readonly LayerNode[];

describe("documentPayloadSchema (W4-F toDocumentDto)", () => {
  it("parses the shipped DTO and keeps extras via passthrough", () => {
    const parsed = documentPayloadSchema.parse(documentDto);
    expect(parsed.id).toBe("d_123");
    expect(parsed.current_revision).toBe(46);
    expect(parsed.latest_version?.label).toBe("First draft");
  });

  it("tolerates a missing latest_version and unknown additive fields", () => {
    const parsed = documentPayloadSchema.parse({
      id: "d_1",
      name: "Doc",
      width_px: 100,
      height_px: 100,
      current_revision: 0,
      preview_url: "https://cdn.test/p.png", // §13.1 future field
    });
    expect(parsed.latest_version).toBeUndefined();
  });

  it("rejects a non-positive canvas", () => {
    expect(() =>
      documentPayloadSchema.parse({ ...documentDto, width_px: 0 }),
    ).toThrowError();
  });
});

describe("layerTreeSchema (layer.list / inspect rows)", () => {
  it("parses the §10.1 tree with groups, defaults and extras", () => {
    const tree = layerTreeSchema.parse(layerTreeFixture);
    expect(tree).toHaveLength(4);
    expect(tree[2]?.children).toHaveLength(2);
    expect(tree[2]?.children?.[0]?.kind).toBe("type");
  });

  it("defaults name/kind/visible for bare layer.list rows", () => {
    const [row] = layerTreeSchema.parse([{ id: "l-1", bounds: null }]);
    expect(row?.name).toBe("(unnamed)");
    expect(row?.kind).toBe("pixel");
    expect(row?.visible).toBe(true);
    expect(row?.bounds).toBeNull();
  });

  it("rejects rows without an id", () => {
    expect(() => layerTreeSchema.parse([{ name: "no id" }])).toThrowError();
    expect(() => layerTreeSchema.parse([null])).toThrowError();
  });
});

describe("preview / command / run wire schemas", () => {
  it("previewReplySchema parses the W4-L JSON body", () => {
    const parsed = previewReplySchema.parse({
      url: "https://cdn.test/signed?sig=abc",
      revision: 46,
      expires_at: "2026-10-01T10:20:00.000Z",
    });
    expect(parsed.revision).toBe(46);
  });

  it("commandReplySchema parses the W4-K toCommandReply body", () => {
    const parsed = commandReplySchema.parse({
      ok: true,
      command: "layer.setProps",
      seq: 12,
      summary: null,
      warnings: null,
      document_revision: 47,
      revision_before: 46,
      revision_after: 47,
      replayed: false,
    });
    expect(parsed.revision_after).toBe(47);
  });

  it("runCreatedReplySchema parses the W4-G 201 body", () => {
    const parsed = runCreatedReplySchema.parse({
      run_id: "run_9",
      status: "queued",
      credits_reserved: 1,
    });
    expect(parsed.credits_reserved).toBe(1);
  });

  it("runDetailSchema parses the W4-G runDetailToApi view", () => {
    const parsed = runDetailSchema.parse({
      run_id: "run_9",
      document_id: "d_123",
      status: "succeeded",
      tier: "quick",
      revision_before: 46,
      revision_after: 47,
      started_at: null,
      finished_at: null,
      error: null,
      plan: null,
      cost: { credits_charged: 1 },
      steps: [],
    });
    expect(parsed.status).toBe("succeeded");
    expect(parsed.revision_after).toBe(47);
  });
});

// ---------------------------------------------------------------------------
// Layer-tree helpers
// ---------------------------------------------------------------------------

describe("flattenLayerTree", () => {
  it("walks depth-first in array order (engine top-down, §10.1)", () => {
    const rows = flattenLayerTree(layerTreeFixture);
    expect(rows.map((row) => row.node.id)).toEqual([
      "l-bg",
      "l-photo",
      "l-content",
      "l-hl",
      "l-sub",
      "l-badge",
    ]);
    expect(rows[3]?.depth).toBe(1);
    expect(rows[2]?.hasChildren).toBe(true);
    expect(rows[0]?.hasChildren).toBe(false);
  });

  it("prunes children of collapsed groups only", () => {
    const rows = flattenLayerTree(layerTreeFixture, (id) => id !== "l-content");
    expect(rows.map((row) => row.node.id)).toEqual([
      "l-bg",
      "l-photo",
      "l-content",
      "l-badge",
    ]);
  });
});

describe("findLayer / countLayers / setLayerVisible", () => {
  it("finds nested nodes and counts the whole tree", () => {
    expect(findLayer(layerTreeFixture, "l-sub")?.name).toBe("Subhead");
    expect(findLayer(layerTreeFixture, "nope")).toBeUndefined();
    expect(countLayers(layerTreeFixture)).toBe(6);
  });

  it("setLayerVisible replaces only the touched path (referential identity)", () => {
    const next = setLayerVisible(layerTreeFixture, "l-sub", false);
    expect(findLayer(next, "l-sub")?.visible).toBe(false);
    // untouched siblings keep their object identity (React re-render skip)
    expect(next[0]).toBe(layerTreeFixture[0]);
    expect(next[2]?.children?.[0]).toBe(layerTreeFixture[2]?.children?.[0]);
    // the input tree is never mutated
    expect(findLayer(layerTreeFixture, "l-sub")?.visible).toBe(true);
  });

  it("setLayerVisible returns the input reference on a miss", () => {
    expect(setLayerVisible(layerTreeFixture, "nope", false)).toBe(layerTreeFixture);
  });
});

describe("visibilityCommand (§13.1 manual commands)", () => {
  it("sends layer.setProps with the engine's layer/visible params", () => {
    expect(visibilityCommand("l-sub", false)).toEqual({
      command: "layer.setProps",
      params: { layer: "l-sub", visible: false },
    });
  });
});

describe("previewPath", () => {
  it("builds the §13.1 preview path with the default 1024 width", () => {
    expect(previewPath("d_1")).toBe("/documents/d_1/preview?w=1024");
    expect(previewPath("d/2", 512)).toBe("/documents/d%2F2/preview?w=512");
  });
});

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

describe("normalizeLayerKind", () => {
  it.each([
    ["group", "group"],
    ["Group", "group"],
    ["type", "text"],
    ["text", "text"],
    ["smart object", "photo"],
    ["photo", "photo"],
    ["adjustment", "adjustment"],
    ["component instance", "component"],
    ["vector", "vector"],
    ["shape layer", "vector"],
    ["solid color fill", "fill"],
    ["gradient", "fill"],
    ["pixel", "pixel"],
    ["martian-unknown", "pixel"],
  ] as const)("maps %s → %s", (kind, expected) => {
    expect(normalizeLayerKind(kind)).toBe(expected);
  });
});

describe("formatBounds / formatOpacity", () => {
  it.each([
    [[0, 0, 1080, 1350], "0, 0 · 1080×1350"],
    [[12.4, -0.6, 888.25, 90], "12.4, -0.6 · 888.25×90"],
  ] as const)("formats bounds %j", (bounds, expected) => {
    expect(formatBounds(bounds)).toBe(expected);
  });

  it("bounds: null/undefined answers null", () => {
    expect(formatBounds(null)).toBeNull();
    expect(formatBounds(undefined)).toBeNull();
  });

  it.each([
    [undefined, "100%"],
    [null, "100%"],
    [1, "100%"],
    [0.8, "80%"],
    [0.075, "8%"],
  ] as const)("opacity %s reads as %s", (opacity, expected) => {
    expect(formatOpacity(opacity)).toBe(expected);
  });
});

describe("fitScale", () => {
  it.each([
    [800, 1000, 1080, 1350, 800 / 1080],
    [1600, 2000, 1080, 1350, 1],
    [540, 675, 1080, 1350, 0.5],
    [1080, 1350, 1080, 1350, 1],
    [0, 100, 1080, 1350, 0],
    [100, 0, 1080, 1350, 0],
    [100, 100, 0, 1350, 0],
  ] as const)("fitScale(%s, %s, %s, %s) = %s", (vw, vh, dw, dh, expected) => {
    expect(fitScale(vw, vh, dw, dh)).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// Run status + error text
// ---------------------------------------------------------------------------

describe("isTerminalRunStatus (§5.1)", () => {
  it.each([
    ["queued", false],
    ["planning", false],
    ["executing", false],
    ["validating", false],
    ["succeeded", true],
    ["succeeded_with_warnings", true],
    ["failed", true],
    ["cancelled", true],
  ] as const)("%s → %s", (status, expected) => {
    expect(isTerminalRunStatus(status)).toBe(expected);
  });
});

describe("extractRunError / errorText", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["engine_timeout", "engine_timeout"],
    [{ code: "image_provider_error", message: "The image service failed." }, "The image service failed."],
    [{ code: "image_provider_error" }, "image provider error"],
    [{ code: 42 }, null],
  ] as const)("extractRunError(%j) = %s", (error, expected) => {
    expect(extractRunError(error)).toBe(expected);
  });

  it("errorText surfaces only typed ApiError messages", () => {
    const apiError = new ApiError({
      code: "quota_exceeded",
      message: "Quota exceeded for this workspace.",
      status: 402,
    });
    expect(errorText(apiError, "fallback")).toBe("Quota exceeded for this workspace.");
    expect(errorText(new Error("raw internal"), "fallback")).toBe("fallback");
    expect(errorText("string", "fallback")).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// Chat-edit message model (§23.5/§24.2)
// ---------------------------------------------------------------------------

describe("chat message builders", () => {
  it("builds text, notice and run messages", () => {
    expect(makeTextMessage("m1", "user", "Make the subhead smaller")).toEqual({
      id: "m1",
      role: "user",
      kind: "text",
      text: "Make the subhead smaller",
    });
    expect(makeNoticeMessage("m2", "Undid the last edit.")).toEqual({
      id: "m2",
      role: "assistant",
      kind: "notice",
      text: "Undid the last edit.",
    });
    const run = makeRunMessage("m3", "Make the subhead smaller", 1);
    expect(run.run).toMatchObject({
      runId: null,
      status: "queued",
      creditsReserved: 1,
      revisionAfter: null,
      error: null,
    });
  });

  it("updateRunMessage claims the newest card with the run id (§24.2 poll loop)", () => {
    const messages: readonly ChatMessage[] = [
      makeTextMessage("m1", "user", "hi"),
      makeRunMessage("m2", "warm it up", 1),
      makeNoticeMessage("m3", "note"),
      makeRunMessage("m4", "add a badge", 1),
    ];
    const claimed = updateRunMessage(messages, { runId: "run_9", status: "queued" });
    expect(claimed[claimed.length - 1]?.run).toMatchObject({
      runId: "run_9",
      status: "queued",
      revisionAfter: null,
    });
    // older cards untouched, input not mutated
    expect(claimed[1]).toBe(messages[1]);
    expect(messages[messages.length - 1]?.run?.runId).toBeNull();
  });

  it("updateRunMessage patches the assigned card, skipping other runs", () => {
    const base: readonly ChatMessage[] = [
      makeRunMessage("m2", "warm it up", 1),
      makeRunMessage("m4", "add a badge", 1),
    ];
    // claims always hit the newest unassigned card (single in-flight invariant)
    const step1 = updateRunMessage(base, { runId: "run_1", status: "failed" });
    expect(step1[1]?.run?.runId).toBe("run_1");
    const step2 = updateRunMessage(step1, { runId: "run_2", status: "succeeded", revisionAfter: 47 });
    expect(step2[0]?.run?.runId).toBe("run_2");
    const patched = updateRunMessage(step2, { runId: "run_1", status: "failed", error: "Provider down." });
    expect(patched[1]?.run?.status).toBe("failed"); // run_1 card updated
    expect(patched[1]?.run?.error).toBe("Provider down.");
    expect(patched[0]?.run?.status).toBe("succeeded"); // newer claim untouched
  });

  it("an unnamed patch always targets the newest run card", () => {
    const messages: readonly ChatMessage[] = [
      makeRunMessage("m2", "warm it up", 1),
      makeRunMessage("m4", "add a badge", 1),
    ];
    const patched = updateRunMessage(messages, { status: "executing" });
    expect(patched[1]?.run?.status).toBe("executing");
    expect(patched[0]?.run?.status).toBe("queued");
  });

  it("a patch naming runs nobody holds changes nothing", () => {
    const assigned: readonly ChatMessage[] = [
      makeRunMessage("m2", "warm it up", 1),
      makeRunMessage("m4", "add a badge", 1),
    ].map((message, index) =>
      message.run === undefined
        ? message
        : { ...message, run: { ...message.run, runId: `run_${index + 1}` } },
    );
    expect(assigned[0]?.run?.runId).toBe("run_1");
    expect(assigned[1]?.run?.runId).toBe("run_2");
    expect(updateRunMessage(assigned, { runId: "ghost", status: "failed" })).toBe(assigned);
  });
});
