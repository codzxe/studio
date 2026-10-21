// layout-apply.test.ts — §6 row 11 `layout_apply`: the §9.2 node-schema table
// (all kinds valid/invalid), tool caps (depth 32 / 256 nodes), the §9.5 finite
// law, absolute-coordinate refusal, moved-summary compaction and the engine
// mapping (forwarding, both reply channels, failure table). Pure fakes only.

import { describe, expect, it } from "vitest";
import { parseToolArgs } from "../src/kit.js";
import {
  ENGINE_PATCH_HINT,
  LAYOUT_APPLY_COMMAND_ID,
  LAYOUT_MAX_DEPTH,
  LAYOUT_MAX_NODES,
  MISSING_MOVE_REPORT_WARNING,
  type LayoutMovedLayer,
  compactLayoutApplyReply,
  findLayoutTreeCapsViolation,
  layoutApplyArgsSchema,
  layoutApplyTool,
  mapLayoutEngineFailure,
  parseLayoutApplyReport,
} from "../src/tools/layout-apply.js";
import type {
  EngineCallOptions,
  EngineCommand,
  EngineCommandReport,
  EngineFailure,
  EngineOutcome,
  ToolErrorCode,
  ToolResult,
} from "../src/types.js";
import { abortedSignal, freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const KEY = "w5j-layout-key-01";
const REVISION = 7;
const SIGNAL = freshSignal();

type ExecuteFn = (
  cmd: EngineCommand,
  options?: EngineCallOptions,
) => Promise<EngineOutcome<EngineCommandReport>>;

interface Probe {
  readonly commands: EngineCommand[];
  readonly options: (EngineCallOptions | undefined)[];
}

const success = <T>(value: T): EngineOutcome<T> => ({ ok: true, value });

/** Seam failures may carry facade codes beyond the tool catalog; cast for the test. */
function failure(
  code: string,
  message: string,
  extra: { hint?: string; retryable?: boolean } = {},
): EngineFailure {
  return {
    ok: false,
    code: code as ToolErrorCode,
    message,
    hint: extra.hint,
    retryable: extra.retryable,
  };
}

/** The §9.4 reply: { moved, warnings } — JSON-folded into `message`. */
function replyWithMessage(payload: unknown, revision = REVISION): EngineCommandReport {
  return { revision, message: JSON.stringify(payload) };
}

/** The same reply spread onto the report (the seam's structural channel). */
function replySpread(
  moved: readonly LayoutMovedLayer[],
  warnings: readonly string[],
  revision = REVISION,
): EngineCommandReport {
  return { revision, moved, warnings } as EngineCommandReport;
}

/** parseToolArgs + run: the executor's exact boundary sequence (§6.2). */
async function call(
  raw: Record<string, unknown>,
  execute: ExecuteFn = async () => success(replyWithMessage(EMPTY_RESULT)),
): Promise<{ res: ToolResult; probe: Probe }> {
  const parsed = parseToolArgs(layoutApplyTool, raw);
  const probe: Probe = { commands: [], options: [] };
  if (!parsed.ok) {
    return { res: parsed, probe };
  }
  const base = makeFakeContext();
  const ctx = makeFakeContext({
    engine: {
      ...base.engine,
      execute: async (cmd, options) => {
        probe.commands.push(cmd);
        probe.options.push(options);
        return execute(cmd, options);
      },
    },
  });
  const res = await layoutApplyTool.run(ctx, parsed.args, SIGNAL);
  return { res, probe };
}

const rawArgs = (
  root: unknown,
  options?: Record<string, unknown>,
): Record<string, unknown> => ({
  idempotencyKey: KEY,
  root,
  ...(options === undefined ? {} : { options }),
});

/** The §9.2 example tree, verbatim in structure. */
const SPEC_TREE = {
  type: "stack",
  direction: "vertical",
  gap: 24,
  padding: [72, 72, 72, 72],
  align: "start",
  within: { layer: "ContentGroup" },
  children: [
    { type: "text", layer: "Headline", grow: 1 },
    {
      type: "row",
      gap: 16,
      align: "center",
      children: [
        { type: "component", layer: "Badge" },
        { type: "text", layer: "Subhead", grow: 1 },
      ],
    },
    { type: "spacer", size: 24 },
    { type: "image", layer: "Photo", fit: "cover", aspect: 1.5 },
  ],
};

const MOVED: readonly LayoutMovedLayer[] = [
  { layer: 3, from: [72, 64, 936, 96], to: [72, 120, 936, 804] },
  { layer: 7, from: [80, 200, 180, 180], to: [72, 948, 180, 180] },
  { layer: 12, from: [0, 0, 100, 50], to: [96, 64, 808, 96] },
  { layer: 15, from: [10, 10, 8, 8], to: [20, 20, 8, 8] },
  { layer: 16, from: [30, 40, 8, 8], to: [40, 60, 8, 8] },
];

const ENGINE_WARNINGS = ["layer 21's slot is outside the safe area; left untouched"];

const EMPTY_RESULT = { moved: [], warnings: [] };

/** A straight stack chain `totalNodes` deep (leaf last). */
function deepChain(totalNodes: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "spacer", size: 1 };
  for (let i = 1; i < totalNodes; i += 1) {
    node = { type: "stack", children: [node] };
  }
  return node;
}

/** A root stack with two child stacks whose leaves total `totalNodes - 3`. */
function wideTree(totalNodes: number): Record<string, unknown> {
  const leafCount = totalNodes - 3;
  const first = Math.ceil(leafCount / 2);
  const second = leafCount - first;
  const leaves = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, () => ({ type: "spacer", size: 1 }));
  return {
    type: "stack",
    children: [
      { type: "stack", children: leaves(first) },
      { type: "stack", children: leaves(second) },
    ],
  };
}

function expectSummary(res: ToolResult, expected: Record<string, unknown>): void {
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error("expected a success envelope");
  }
  expect(res.summary).toBe(JSON.stringify(expected));
}

// ---------------------------------------------------------------------------
// Tool identity (§6: pinned name, planner-facing description)
// ---------------------------------------------------------------------------

describe("layout_apply tool identity", () => {
  it("is named layout_apply and carries a one-sentence description (§6)", () => {
    expect(layoutApplyTool.name).toBe("layout_apply");
    expect(layoutApplyTool.description.length).toBeGreaterThanOrEqual(10);
    expect(layoutApplyTool.description.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Node schema — every §9.2 kind, valid table (mirrors layout_apply.rs serde)
// ---------------------------------------------------------------------------

describe("layout_apply argument schema — valid §9.2 nodes", () => {
  const rows: readonly { label: string; root: unknown }[] = [
    {
      label: "stack: minimal",
      root: { type: "stack", children: [{ type: "text", layer: "Headline" }] },
    },
    { label: "stack: the §9.2 example tree", root: SPEC_TREE },
    {
      label: "row: gap, align, padding, dir, within-rect",
      root: {
        type: "row",
        gap: 16,
        align: "center",
        padding: [72, 72, 72, 72],
        dir: "rtl",
        within: [0, 0, 1080, 700],
        children: [
          { type: "component", layer: "Badge" },
          { type: "text", layer: "Subhead" },
        ],
      },
    },
    {
      label: "grid: columns 4 with mixed children",
      root: {
        type: "grid",
        columns: 4,
        gap: 12,
        children: [
          { type: "image", layer: "Photo 1", fit: "contain" },
          { type: "image", layer: "Photo 2", fit: "cover" },
          { type: "image", layer: "Photo 3", fit: "fill" },
          { type: "spacer", size: 8 },
        ],
      },
    },
    { label: "grid: columns at the 24 boundary", root: { type: "grid", columns: 24, children: [{ type: "spacer", size: 1 }] } },
    {
      label: "absolute: children carry required x/y (the only place coordinates exist)",
      root: { type: "absolute", children: [{ type: "text", layer: "Badge", x: 828, y: 72 }] },
    },
    {
      label: "absolute: a positioned container child with flow children",
      root: {
        type: "absolute",
        children: [
          {
            type: "row",
            x: -72,
            y: 0,
            children: [{ type: "text", layer: "Footer" }],
          },
        ],
      },
    },
    {
      label: "center: children with and without dx/dy offsets",
      root: {
        type: "center",
        children: [
          { type: "text", layer: "Logo", dx: 10, dy: -10 },
          { type: "component", layer: "Badge" },
        ],
      },
    },
    { label: "spacer: size at the top of the px range", root: { type: "spacer", size: 1_048_576 } },
    {
      label: "text: every sizing key, anchor baseline, numeric layer id",
      root: {
        type: "text",
        layer: 12,
        grow: true,
        hug: true,
        percent: 50,
        aspect: 1.5,
        width: 936,
        height: 96,
        minWidth: 100,
        maxWidth: 1000,
        minHeight: 10,
        maxHeight: 200,
        anchor: "baseline",
      },
    },
    { label: "image: fit cover, aspect 1.5 (§9.2 example leaf)", root: { type: "image", layer: "Photo", fit: "cover", aspect: 1.5 } },
    { label: "component: named layer", root: { type: "component", layer: "Badge" } },
    { label: "divider: default thickness", root: { type: "divider", layer: "Rule" } },
    { label: "divider: explicit size 2, anchor center", root: { type: "divider", layer: "Rule", size: 2, anchor: "center" } },
    { label: "a container may name its own layer", root: { type: "stack", layer: "Content", children: [{ type: "spacer", size: 4 }] } },
  ];
  for (const { label, root } of rows) {
    it(label, () => {
      expect(layoutApplyArgsSchema.safeParse(rawArgs(root)).success).toBe(true);
    });
  }

  it("accepts options (coordinateSpace + safeArea)", () => {
    const parsed = layoutApplyArgsSchema.safeParse(
      rawArgs({ type: "spacer", size: 1 }, { coordinateSpace: "parent", safeArea: 48 }),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts safeArea at the 512 tool cap", () => {
    const parsed = layoutApplyArgsSchema.safeParse(
      rawArgs({ type: "spacer", size: 1 }, { safeArea: 512 }),
    );
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Node schema — invalid table (strict mirror; every engine rejection is ours)
// ---------------------------------------------------------------------------

describe("layout_apply argument schema — invalid nodes", () => {
  const rows: readonly { label: string; root: unknown }[] = [
    { label: "unknown node type", root: { type: "flow", children: [] } },
    { label: "missing type", root: { children: [{ type: "spacer", size: 1 }] } },
    { label: "node is not an object", root: "stack" },
    { label: "stack without children", root: { type: "stack" } },
    { label: "stack with empty children (engine: at least one child)", root: { type: "stack", children: [] } },
    { label: "text without layer", root: { type: "text" } },
    { label: "image without layer", root: { type: "image", fit: "cover" } },
    { label: "component without layer", root: { type: "component" } },
    { label: "grid without columns", root: { type: "grid", children: [{ type: "spacer", size: 1 }] } },
    { label: "grid columns 0", root: { type: "grid", columns: 0, children: [{ type: "spacer", size: 1 }] } },
    { label: "grid columns 25 (§9.5 cap 24)", root: { type: "grid", columns: 25, children: [{ type: "spacer", size: 1 }] } },
    { label: "grid columns 2.5 (whole numbers only)", root: { type: "grid", columns: 2.5, children: [{ type: "spacer", size: 1 }] } },
    { label: "grid columns NaN", root: { type: "grid", columns: Number.NaN, children: [{ type: "spacer", size: 1 }] } },
    { label: "gap below 0", root: { type: "row", gap: -0.5, children: [{ type: "spacer", size: 1 }] } },
    { label: "gap above 256 (§9.5)", root: { type: "row", gap: 257, children: [{ type: "spacer", size: 1 }] } },
    { label: "padding above 2048", root: { type: "stack", padding: 2049, children: [{ type: "spacer", size: 1 }] } },
    { label: "padding of 3 sides (1, 2 or 4 only)", root: { type: "stack", padding: [1, 2, 3], children: [{ type: "spacer", size: 1 }] } },
    { label: "padding of 5 sides", root: { type: "stack", padding: [1, 2, 3, 4, 5], children: [{ type: "spacer", size: 1 }] } },
    { label: "spacer without size", root: { type: "spacer" } },
    { label: "spacer size below 0", root: { type: "spacer", size: -5 } },
    { label: "spacer size above the px cap", root: { type: "spacer", size: 2_000_000 } },
    { label: "align left (§9.5: logical start/end only)", root: { type: "row", align: "left", children: [{ type: "spacer", size: 1 }] } },
    { label: "direction diagonal", root: { type: "stack", direction: "diagonal", children: [{ type: "spacer", size: 1 }] } },
    { label: "anchor is not a 9-point/baseline name", root: { type: "divider", layer: "Rule", anchor: "bottom-centre" } },
    { label: "fit stretch (contain/cover/fill only)", root: { type: "image", layer: "Photo", fit: "stretch" } },
    { label: "grow below 0", root: { type: "text", layer: "H", grow: -1 } },
    { label: "grow absurdly large", root: { type: "text", layer: "H", grow: 1_000_001 } },
    { label: "percent 0", root: { type: "text", layer: "H", percent: 0 } },
    { label: "percent above 100", root: { type: "text", layer: "H", percent: 101 } },
    { label: "aspect 0", root: { type: "image", layer: "Photo", aspect: 0 } },
    { label: "aspect negative", root: { type: "image", layer: "Photo", aspect: -1.5 } },
    { label: "width below 0", root: { type: "text", layer: "H", width: -3 } },
    { label: "width above the px cap", root: { type: "text", layer: "H", width: 2_000_000 } },
    { label: "within with an extra key", root: { type: "stack", within: { layer: "G", extra: 1 }, children: [{ type: "spacer", size: 1 }] } },
    { label: "within rect with 3 numbers", root: { type: "stack", within: [1, 2, 3], children: [{ type: "spacer", size: 1 }] } },
    { label: "within rect with negative width", root: { type: "stack", within: [0, 0, -5, 4], children: [{ type: "spacer", size: 1 }] } },
    { label: "within as a bare layer name", root: { type: "stack", within: "ContentGroup", children: [{ type: "spacer", size: 1 }] } },
    { label: "dir typo", root: { type: "stack", dir: "rtl!", children: [{ type: "spacer", size: 1 }] } },
    { label: "unknown key on a text node (gap is container-only)", root: { type: "text", layer: "H", gap: 8 } },
    { label: "unknown key on a spacer (layer is not a spacer key)", root: { type: "spacer", size: 1, layer: "Gap" } },
    { label: "x/y on the root (root is a flow context)", root: { type: "spacer", size: 1, x: 0, y: 0 } },
    { label: "absolute child without y", root: { type: "absolute", children: [{ type: "text", layer: "H", x: 1 }] } },
    { label: "absolute child with NaN x", root: { type: "absolute", children: [{ type: "text", layer: "H", x: Number.NaN, y: 0 }] } },
    { label: "absolute child coordinate beyond ±1048576", root: { type: "absolute", children: [{ type: "text", layer: "H", x: 2_000_000, y: 0 }] } },
  ];
  for (const { label, root } of rows) {
    it(label, () => {
      expect(layoutApplyArgsSchema.safeParse(rawArgs(root)).success).toBe(false);
    });
  }

  it("rejects unknown options keys", () => {
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({ type: "spacer", size: 1 }, { safeMargin: 48 }),
      ).success,
    ).toBe(false);
  });

  it("rejects safeArea above the 512 tool cap", () => {
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({ type: "spacer", size: 1 }, { safeArea: 513 }),
      ).success,
    ).toBe(false);
  });

  it("rejects a bad coordinateSpace", () => {
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({ type: "spacer", size: 1 }, { coordinateSpace: "canvas" }),
      ).success,
    ).toBe(false);
  });

  it("rejects missing / malformed idempotency keys (mutating tool, kit README)", () => {
    expect(layoutApplyArgsSchema.safeParse({ root: { type: "spacer", size: 1 } }).success).toBe(false);
    expect(
      layoutApplyArgsSchema.safeParse({ idempotencyKey: "short", root: { type: "spacer", size: 1 } })
        .success,
    ).toBe(false);
    expect(
      layoutApplyArgsSchema.safeParse({ idempotencyKey: "not a key!", root: { type: "spacer", size: 1 } })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Raw coordinates exist only inside `absolute` (§9.2 — the model never emits them)
// ---------------------------------------------------------------------------

describe("layout_apply — absolute-coordinate refusal", () => {
  it("rejects x/y on a stack child", () => {
    const parsed = parseToolArgs(
      layoutApplyTool,
      rawArgs({
        type: "stack",
        children: [{ type: "text", layer: "Headline", x: 0, y: 0 }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toContain("children");
    }
  });

  it("rejects x/y on a center child (center children take dx/dy)", () => {
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({
          type: "center",
          children: [{ type: "text", layer: "Logo", x: 1, y: 1 }],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects dx/dy outside a center node", () => {
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({
          type: "row",
          children: [{ type: "text", layer: "Subhead", dx: 4, dy: 4 }],
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts dx/dy and x/y in their own contexts (positive control)", () => {
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({
          type: "center",
          children: [{ type: "text", layer: "Logo", dx: 4, dy: 4 }],
        }),
      ).success,
    ).toBe(true);
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({
          type: "absolute",
          children: [{ type: "text", layer: "Logo", x: 4, y: 4 }],
        }),
      ).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool caps: depth ≤ 32, ≤ 256 nodes ("layout too complex")
// ---------------------------------------------------------------------------

describe("layout_apply — depth and node-count caps", () => {
  it("accepts a tree exactly 32 levels deep", () => {
    expect(layoutApplyArgsSchema.safeParse(rawArgs(deepChain(32))).success).toBe(true);
  });

  it("rejects 33 levels as layout too complex (invalid_args + cap in the hint)", () => {
    const parsed = parseToolArgs(layoutApplyTool, rawArgs(deepChain(33)));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toContain("layout too complex");
      expect(parsed.hint).toContain(`deeper than ${LAYOUT_MAX_DEPTH}`);
      expect(parsed.hint).toContain("root");
    }
  });

  it("accepts a tree of exactly 256 nodes", () => {
    expect(layoutApplyArgsSchema.safeParse(rawArgs(wideTree(256))).success).toBe(true);
  });

  it("rejects 257 nodes as layout too complex", () => {
    const parsed = parseToolArgs(layoutApplyTool, rawArgs(wideTree(257)));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toContain(`more than ${LAYOUT_MAX_NODES} nodes`);
    }
  });

  it("rejects a container with 201 children (kit §6.1 array ceiling)", () => {
    const children = Array.from({ length: 201 }, () => ({ type: "spacer", size: 1 }));
    expect(layoutApplyArgsSchema.safeParse(rawArgs({ type: "row", children })).success).toBe(false);
  });

  it("the walker is pure and tolerant of non-node input", () => {
    expect(findLayoutTreeCapsViolation({})).toBeUndefined();
    expect(findLayoutTreeCapsViolation("stack")).toBeUndefined();
    expect(findLayoutTreeCapsViolation(deepChain(32))).toBeUndefined();
    expect(findLayoutTreeCapsViolation(deepChain(33))).toContain("deeper than 32");
    expect(findLayoutTreeCapsViolation(wideTree(257))).toContain("more than 256 nodes");
  });
});

// ---------------------------------------------------------------------------
// §9.5 finite law — NaN and ±Infinity never reach the engine
// ---------------------------------------------------------------------------

describe("layout_apply — NaN and Infinity rejection (§9.5)", () => {
  const rows: readonly { label: string; root: unknown }[] = [
    { label: "gap NaN", root: { type: "row", gap: Number.NaN, children: [{ type: "spacer", size: 1 }] } },
    { label: "gap +Infinity (JSON 1e999)", root: JSON.parse('{"type":"row","gap":1e999,"children":[{"type":"spacer","size":1}]}') },
    { label: "gap -Infinity (JSON -1e999)", root: JSON.parse('{"type":"row","gap":-1e999,"children":[{"type":"spacer","size":1}]}') },
    { label: "width NaN", root: { type: "text", layer: "H", width: Number.NaN } },
    { label: "height Infinity", root: { type: "text", layer: "H", height: Number.POSITIVE_INFINITY } },
    { label: "spacer size NaN", root: { type: "spacer", size: Number.NaN } },
    { label: "absolute child y NaN", root: { type: "absolute", children: [{ type: "spacer", size: 1, x: 0, y: Number.NaN }] } },
  ];
  for (const { label, root } of rows) {
    it(label, () => {
      expect(layoutApplyArgsSchema.safeParse(rawArgs(root)).success).toBe(false);
    });
  }

  it("safeArea NaN is rejected", () => {
    expect(
      layoutApplyArgsSchema.safeParse(
        rawArgs({ type: "spacer", size: 1 }, { safeArea: Number.NaN }),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine mapping — forwarding, both reply channels, missing-report warning
// ---------------------------------------------------------------------------

describe("layout_apply run — forwarding to layout.apply", () => {
  it("forwards { root, options } verbatim with the deadline signal (§6.2)", async () => {
    const { res, probe } = await call(
      rawArgs(SPEC_TREE, { coordinateSpace: "document", safeArea: 48 }),
      async () => success(replyWithMessage(EMPTY_RESULT)),
    );
    expect(res.ok).toBe(true);
    expect(probe.commands).toHaveLength(1);
    expect(probe.commands[0]?.id).toBe(LAYOUT_APPLY_COMMAND_ID);
    expect(probe.commands[0]?.params).toEqual({
      root: SPEC_TREE,
      options: { coordinateSpace: "document", safeArea: 48 },
    });
    expect(probe.options[0]?.signal).toBe(SIGNAL);
  });

  it("forwards an empty options object when none was given (engine defaults)", async () => {
    const { probe } = await call(rawArgs({ type: "spacer", size: 1 }));
    expect(probe.commands[0]?.params).toEqual({
      root: { type: "spacer", size: 1 },
      options: {},
    });
  });

  it("a pre-aborted signal stops before any engine call (§3.4)", async () => {
    const parsed = parseToolArgs(layoutApplyTool, rawArgs({ type: "spacer", size: 1 }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected parsed args");
    }
    const res = await layoutApplyTool.run(makeFakeContext(), parsed.args, abortedSignal());
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("engine_timeout");
  });
});

describe("layout_apply run — the two reply channels", () => {
  it("message channel: moved count, top-3 examples, warnings, documentRevision", async () => {
    const { res } = await call(
      rawArgs(SPEC_TREE),
      async () => success(replyWithMessage({ moved: MOVED, warnings: ENGINE_WARNINGS })),
    );
    expectSummary(res, {
      moved: 5,
      examples: [
        "layer 3 → [72, 120, 936, 804]",
        "layer 7 → [72, 948, 180, 180]",
        "layer 12 → [96, 64, 808, 96]",
      ],
      moreMoved: 2,
      warnings: 1,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.documentRevision).toBe(REVISION);
      expect(res.warnings).toEqual(ENGINE_WARNINGS);
    }
  });

  it("structural channel: the payload spread onto the report", async () => {
    const { res } = await call(
      rawArgs({ type: "spacer", size: 1 }),
      async () => success(replySpread([MOVED[0] as LayoutMovedLayer], [])),
    );
    expectSummary(res, {
      moved: 1,
      examples: ["layer 3 → [72, 120, 936, 804]"],
      warnings: 0,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings).toBeUndefined();
    }
  });

  it("zero moved: everything was already in place", async () => {
    const { res } = await call(rawArgs(SPEC_TREE));
    expectSummary(res, { moved: 0, examples: [], warnings: 0 });
  });

  it("no readable payload: ok with a verify warning, never a failure", async () => {
    const { res } = await call(rawArgs(SPEC_TREE), async () => success({ revision: 9 }));
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.summary).toBe(
      JSON.stringify({ moved: 0, examples: [], warnings: 1 }),
    );
    expect(res.warnings).toEqual([MISSING_MOVE_REPORT_WARNING]);
    expect(res.documentRevision).toBe(9);
  });

  it("a human-readable message is not a payload (journal text, not JSON)", async () => {
    const { res } = await call(
      rawArgs(SPEC_TREE),
      async () => success({ revision: 9, message: "Apply Layout" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.warnings).toEqual([MISSING_MOVE_REPORT_WARNING]);
  });

  it("JSON of the wrong shape is not a payload", async () => {
    const { res } = await call(
      rawArgs(SPEC_TREE),
      async () => success({ revision: 9, message: '{"hello": 1}' }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.warnings).toEqual([MISSING_MOVE_REPORT_WARNING]);
  });
});

// ---------------------------------------------------------------------------
// moved-summary compaction (pure)
// ---------------------------------------------------------------------------

describe("compactLayoutApplyReply — compaction (§6.1 small replies)", () => {
  it("keeps the top-3 examples and counts the rest in moreMoved", () => {
    const reply = compactLayoutApplyReply(MOVED, ENGINE_WARNINGS);
    expect(reply.summary).toBe(
      JSON.stringify({
        moved: 5,
        examples: [
          "layer 3 → [72, 120, 936, 804]",
          "layer 7 → [72, 948, 180, 180]",
          "layer 12 → [96, 64, 808, 96]",
        ],
        moreMoved: 2,
        warnings: 1,
      }),
    );
    expect(reply.warnings).toEqual(ENGINE_WARNINGS);
  });

  it("three moves: no moreMoved key", () => {
    const reply = compactLayoutApplyReply(MOVED.slice(0, 3), []);
    expect(JSON.parse(reply.summary)).toEqual({
      moved: 3,
      examples: [
        "layer 3 → [72, 120, 936, 804]",
        "layer 7 → [72, 948, 180, 180]",
        "layer 12 → [96, 64, 808, 96]",
      ],
      warnings: 0,
    });
    expect(reply.warnings).toBeUndefined();
  });

  it("zero moves: empty examples, deterministic summary", () => {
    const reply = compactLayoutApplyReply([], []);
    expect(reply.summary).toBe(JSON.stringify({ moved: 0, examples: [], warnings: 0 }));
    expect(reply.warnings).toBeUndefined();
  });

  it("clips the warnings to the kit caps (20 × 500) and keeps the full count", () => {
    const many = Array.from({ length: 25 }, (_, i) => `warning ${i}`);
    const reply = compactLayoutApplyReply([], many);
    expect(reply.warnings).toHaveLength(20);
    expect(reply.warnings?.[0]).toBe("warning 0");
    expect(JSON.parse(reply.summary)).toEqual({
      moved: 0,
      examples: [],
      warnings: 25,
    });
  });

  it("truncates a single oversized warning to 500 chars", () => {
    const reply = compactLayoutApplyReply([], ["w".repeat(700)]);
    expect(reply.warnings?.[0]?.length).toBe(500);
    expect(reply.warnings?.[0]?.endsWith("...")).toBe(true);
  });

  it("keeps summary length inside the §6.1 budget", () => {
    const big: LayoutMovedLayer[] = Array.from({ length: 40 }, (_, i) => ({
      layer: i,
      from: [0, 0, 1, 1],
      to: [1, 2, 3, 4],
    }));
    const reply = compactLayoutApplyReply(big, ["a warning"]);
    expect(reply.summary.length).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// parseLayoutApplyReport — the seam channels (pure)
// ---------------------------------------------------------------------------

describe("parseLayoutApplyReport — seam payload channels", () => {
  it("reads the payload spread onto the report", () => {
    const parsed = parseLayoutApplyReport(replySpread(MOVED, ENGINE_WARNINGS));
    expect(parsed?.moved).toHaveLength(5);
    expect(parsed?.warnings).toEqual(ENGINE_WARNINGS);
  });

  it("reads a JSON payload folded into message", () => {
    const parsed = parseLayoutApplyReport(
      replyWithMessage({ moved: MOVED.slice(0, 1), warnings: [] }),
    );
    expect(parsed?.moved[0]?.layer).toBe(3);
    expect(parsed?.warnings).toEqual([]);
  });

  it("returns undefined when neither channel carries the payload", () => {
    expect(parseLayoutApplyReport({ revision: 5 })).toBeUndefined();
    expect(parseLayoutApplyReport({ revision: 5, message: "Apply Layout" })).toBeUndefined();
    expect(
      parseLayoutApplyReport({ revision: 5, message: JSON.stringify({ hello: 1 }) }),
    ).toBeUndefined();
  });

  it("refuses non-finite boxes from a mangled adapter", () => {
    const parsed = parseLayoutApplyReport({
      revision: 5,
      moved: [{ layer: 1, from: [0, 0, Number.POSITIVE_INFINITY, 1], to: [1, 1, 1, 1] }],
      warnings: [],
    } as EngineCommandReport);
    expect(parsed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Engine failures — missing commands get the engine-patch hint; the rest map
// ---------------------------------------------------------------------------

describe("layout_apply run — missing commands", () => {
  it("missing_required_commands → engine_unavailable with the patch hint", async () => {
    const { res } = await call(
      rawArgs(SPEC_TREE),
      async () =>
        failure("missing_required_commands", "the engine registry is missing 1 command(s)"),
    );
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("engine_unavailable");
    expect(res.hint).toBe(ENGINE_PATCH_HINT);
    expect(res.retryable).toBe(false);
  });

  it("unknown_command (older build) maps the same way", async () => {
    const { res } = await call(
      rawArgs(SPEC_TREE),
      async () => failure("unknown_command", "the engine does not know this command"),
    );
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("engine_unavailable");
    expect(res.hint).toBe(ENGINE_PATCH_HINT);
  });

  it("detects the missing command by text when the code is generic", () => {
    const res = mapLayoutEngineFailure(
      failure("engine_command_failed", "unknown command: layout.apply"),
    );
    expect(res.code).toBe("engine_unavailable");
    expect(res.hint).toBe(ENGINE_PATCH_HINT);
    expect(res.retryable).toBe(false);
  });
});

describe("mapLayoutEngineFailure — facade codes nearest §13.3 code", () => {
  const rows: readonly [code: string, expected: ToolErrorCode][] = [
    ["engine_command_failed", "internal_error"],
    ["reply_timeout", "engine_timeout"],
    ["call_aborted", "engine_timeout"],
    ["frame_too_large", "internal_error"],
    ["auth_rejected", "unauthorized"],
    ["session_limit_reached", "engine_unavailable"],
    ["path_outside_capability_root", "forbidden"],
    ["plan_ceiling_exceeded", "plan_limit"],
    ["connection_dropped_mid_call", "engine_crashed"],
    ["something_unmapped", "internal_error"],
  ];
  for (const [code, expected] of rows) {
    it(`${code} → ${expected} (engine message preserved)`, () => {
      const res = mapLayoutEngineFailure(failure(code, "engine said no"));
      expect(res.code).toBe(expected);
      expect(res.message).toBe("engine said no");
    });
  }

  it("keeps a catalog code, hint and retryable flag untouched", async () => {
    const { res } = await call(
      rawArgs(SPEC_TREE),
      async () =>
        failure("engine_timeout", "the tool ran out of time", {
          hint: "retry smaller",
          retryable: true,
        }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("engine_timeout");
    expect(res.message).toBe("the tool ran out of time");
    expect(res.hint).toBe("retry smaller");
    expect(res.retryable).toBe(true);
  });

  it("clips oversized engine messages and hints (§6.1 caps)", () => {
    const res = mapLayoutEngineFailure(
      failure("engine_crashed", "x".repeat(1500), { hint: "y".repeat(600) }),
    );
    expect(res.message.length).toBeLessThanOrEqual(1000);
    expect(res.hint?.length).toBeLessThanOrEqual(500);
  });
});
