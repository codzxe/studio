// component-tools.test.ts — component_list + component_place (§6 row 12, §8).
//
// Deterministic, pure: the engine seam is a recording fake (tests/fakes.ts +
// stubEngine), the manifest fixture is the REAL eval component
// (evals/components/offer-badge — the §8.2 shape verbatim), and the engine
// reply shapes mirror engine-patches/component_cmds (§8.3): component.list
// rows carry variable NAMES, component.place replies {instance, vars, warnings}.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  COMPONENT_LIST_COMMAND,
  MAX_LIST_CARDS,
  componentListTool,
  readComponentList,
} from "../src/tools/component-list.js";
import {
  ANCHOR_FRACTIONS,
  COMPONENT_ANCHORS,
  COMPONENT_INSPECT_COMMAND,
  COMPONENT_PLACE_COMMAND,
  MAX_PLACE_VARS,
  UNKNOWN_COMPONENT_CODE,
  UNKNOWN_COMPONENT_VARS_CODE,
  anchorAdjustedBounds,
  componentPlaceTool,
  parseComponentRef,
  readComponentVarSchema,
  readPlacedInstance,
  validateComponentVars,
} from "../src/tools/component-place.js";
import type { ComponentAnchor } from "../src/tools/component-place.js";
import type {
  BudgetTracker,
  EngineCommand,
  EngineCommandReport,
  EngineLike,
  EngineOutcome,
  ToolContext,
  ToolResult,
} from "../src/types.js";
import { abortedSignal, freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures — the real §8.2 manifest + a §8.3 component.list library
// ---------------------------------------------------------------------------

// (Three segments up: tests/ → tools/ → packages/ → studio root.)
const REAL_MANIFEST_URL = new URL(
  "../../../evals/components/offer-badge/component.json",
  import.meta.url,
);
const offerBadge = JSON.parse(readFileSync(REAL_MANIFEST_URL, "utf8")) as unknown;
const OFFER_BADGE_VARS = ["label", "bg", "textColor", "showRibbon"]; // manifest order

/** Engine list rows (component_cmds.rs list_core): variables are NAME arrays. */
const LIBRARY_ROWS: unknown[] = [
  {
    id: "button-cta",
    name: "Button CTA",
    version: 1,
    tags: ["button", "cta", "ui"],
    defaultSize: { width: 240, height: 64 },
    license: "public",
    variables: ["label", "bg", "textColor", "rounded"],
    comps: ["default", "light", "dark"],
  },
  {
    id: "offer-badge",
    name: "Offer Badge",
    version: 2,
    tags: ["badge", "promo"],
    defaultSize: { width: 180, height: 180 },
    license: "public",
    variables: OFFER_BADGE_VARS,
    comps: ["default", "light", "dark"],
  },
  {
    id: "star-rating",
    name: "Star Rating",
    version: 1,
    tags: ["rating", "social-proof"],
    defaultSize: { width: 240, height: 48 },
    license: "public",
    variables: ["stars", "color"],
    comps: ["default", "light", "dark"],
  },
];

// ---------------------------------------------------------------------------
// Fakes — recording engine + budget meter
// ---------------------------------------------------------------------------

type Execute = (cmd: EngineCommand) => Promise<EngineOutcome<EngineCommandReport>>;

function stubEngine(execute: Execute): { engine: EngineLike; commands: EngineCommand[] } {
  const commands: EngineCommand[] = [];
  const engine: EngineLike = {
    batch: async () => ({ ok: true, value: { revision: 1, outcomes: [] } }),
    execute: async (cmd) => {
      commands.push(cmd);
      return execute(cmd);
    },
    render: async () => ({ ok: true, value: { image: new Uint8Array(), widthPx: 8, heightPx: 8 } }),
    inspect: async () => ({
      ok: true,
      value: { revision: 1, widthPx: 1080, heightPx: 1080, layers: [] },
    }),
    listLayers: async () => ({ ok: true, value: [] }),
  };
  return { engine, commands };
}

type ListReport = EngineCommandReport & { components?: unknown; problems?: unknown };
type InspectReport = EngineCommandReport & {
  manifest?: unknown;
  version?: unknown;
  master?: unknown;
};
type PlaceReport = EngineCommandReport & {
  instance?: unknown;
  component?: unknown;
  version?: unknown;
  bounds?: unknown;
  anchor?: unknown;
  vars?: unknown;
  warnings?: unknown;
};

function listReport(
  components: unknown = LIBRARY_ROWS,
  problems: unknown = [],
): EngineCommandReport {
  const report: ListReport = { revision: 1, components, problems };
  return report;
}

function inspectReport(manifest: unknown = offerBadge): EngineCommandReport {
  const report: InspectReport = {
    revision: 1,
    manifest,
    version: 2,
    master: { size: { width: 180, height: 180 }, layers: [], variables: [] },
  };
  return report;
}

function placeReport(
  fields: { instance?: unknown; warnings?: unknown } = {},
  revision = 9,
): EngineCommandReport {
  const report: PlaceReport = {
    revision,
    instance: 14,
    component: "offer-badge",
    version: 2,
    bounds: [720, 72, 180, 180],
    anchor: [1, 0],
    vars: {},
    warnings: [],
    ...fields,
  };
  return report;
}

interface RouterOptions {
  list?: EngineOutcome<EngineCommandReport>;
  inspect?: EngineOutcome<EngineCommandReport>;
  place?: EngineOutcome<EngineCommandReport>;
}

/** The happy router: real manifest on inspect, engine-faithful place reply. */
function componentsRouter(overrides: RouterOptions = {}): Execute {
  return (cmd) => {
    switch (cmd.id) {
      case COMPONENT_LIST_COMMAND:
        return Promise.resolve(overrides.list ?? { ok: true, value: listReport() });
      case COMPONENT_INSPECT_COMMAND:
        return Promise.resolve(overrides.inspect ?? { ok: true, value: inspectReport() });
      case COMPONENT_PLACE_COMMAND:
        return Promise.resolve(overrides.place ?? { ok: true, value: placeReport() });
      default:
        return Promise.resolve({ ok: true, value: { revision: 1 } });
    }
  };
}

function contextWith(
  execute: Execute,
  options: { budgetAllow?: boolean } = {},
): { ctx: ToolContext; commands: EngineCommand[]; charges: unknown[] } {
  const stub = stubEngine(execute);
  const charges: { commands?: number; renderPx?: number }[] = [];
  const tracker: BudgetTracker = {
    remaining: () => ({ msRemaining: 5000, commandsRemaining: 64 }),
    charge: (usage) => {
      charges.push(usage);
      return options.budgetAllow ?? true;
    },
  };
  const ctx = makeFakeContext({ engine: stub.engine, budgets: tracker });
  return { ctx, commands: stub.commands, charges };
}

/** Narrow a ToolResult to the ok envelope after asserting it. */
function expectOk(result: ToolResult): Extract<ToolResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (result.ok) return result;
  throw new Error("expected an ok result");
}

function summaryJson(result: Extract<ToolResult, { ok: true }>): Record<string, unknown> {
  return JSON.parse(result.summary) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// component_list — schema (§6.1 strict: caps, no extra props)
// ---------------------------------------------------------------------------

describe("component_list: argument schema", () => {
  it("accepts tags and query within caps", () => {
    const parsed = parseToolArgs(componentListTool, {
      tags: ["badge", "Promo"],
      query: "offer",
    });
    expect(parsed.ok).toBe(true);
  });

  it("accepts empty args (list everything)", () => {
    expect(parseToolArgs(componentListTool, {}).ok).toBe(true);
  });

  it("rejects extra properties and cap violations", () => {
    const cases: unknown[] = [
      { bogus: true },
      { tags: [] },
      { tags: "" },
      { tags: ["badge", "", "promo"] },
      { tags: Array.from({ length: 13 }, (_, i) => `t${i}`) },
      { tags: ["x".repeat(65)] },
      { tags: "badge" },
      { query: "" },
      { query: "x".repeat(121) },
      { query: 42 },
      { tags: ["badge"], query: "offer", extra: 1 },
    ];
    for (const [index, value] of cases.entries()) {
      const parsed = parseToolArgs(componentListTool, value);
      expect(parsed.ok, `case ${index}`).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("invalid_args");
    }
  });
});

// ---------------------------------------------------------------------------
// component_list — cards, filters, problems, budget (§8.3 list semantics)
// ---------------------------------------------------------------------------

describe("component_list: cards and filters", () => {
  it("renders compact cards with variable NAMES only (§6 row 12 card view)", async () => {
    const { ctx } = contextWith(componentsRouter());
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const okResult = expectOk(result);
    const cards = summaryJson(okResult).components as Record<string, unknown>[];
    expect(cards).toHaveLength(3);
    // Sorted by id: button-cta, offer-badge, star-rating.
    expect(cards[1]?.id).toBe("offer-badge");
    expect(cards[1]?.version).toBe(2);
    expect(cards[1]?.name).toBe("Offer Badge");
    expect(cards[1]?.tags).toEqual(["badge", "promo"]);
    expect(cards[1]?.variables).toEqual(OFFER_BADGE_VARS);
    // Card compactness: exactly the five pinned fields — no manifest dump.
    expect(Object.keys(cards[1] ?? {}).sort()).toEqual([
      "id",
      "name",
      "tags",
      "variables",
      "version",
    ]);
    expect(okResult.warnings).toBeUndefined();
    expect(isToolResult(okResult)).toBe(true);
  });

  it("passes tags and query to the engine verbatim (engine owns filtering)", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    await componentListTool.run(ctx, { tags: ["badge"], query: "offer" }, freshSignal());
    expect(commands).toHaveLength(1);
    expect(commands[0]?.id).toBe(COMPONENT_LIST_COMMAND);
    expect(commands[0]?.params).toStrictEqual({ tags: ["badge"], query: "offer" });
  });

  it("sends no filter keys when none were given", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    await componentListTool.run(ctx, {}, freshSignal());
    expect(commands[0]?.params).toStrictEqual({});
  });

  it("renders library problems as warnings (a broken component never fails the list)", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        list: {
          ok: true,
          value: listReport(
            [LIBRARY_ROWS[1]],
            [
              { id: "broken-thing", error: "no readable component.json" },
              { error: "the components root `components` cannot be read" },
            ],
          ),
        },
      }),
    );
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const okResult = expectOk(result);
    expect(okResult.warnings).toContain("component `broken-thing`: no readable component.json");
    expect(okResult.warnings).toContain("the components root `components` cannot be read");
    const cards = summaryJson(okResult).components as unknown[];
    expect(cards).toHaveLength(1);
  });

  it("omits the problem tail beyond the shown cap", async () => {
    const problems = Array.from({ length: 10 }, (_, i) => ({ id: `bad-${i}`, error: "boom" }));
    const { ctx } = contextWith(
      componentsRouter({ list: { ok: true, value: listReport([], problems) } }),
    );
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const okResult = expectOk(result);
    expect(okResult.warnings).toContain("2 more library problems omitted");
  });

  it("skips unreadable rows instead of fabricating cards", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        list: { ok: true, value: listReport([42, "junk", null, LIBRARY_ROWS[1]]) },
      }),
    );
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const okResult = expectOk(result);
    expect(okResult.warnings?.join(" ")).toContain("unreadable and skipped");
    expect(summaryJson(okResult).components).toHaveLength(1);
  });

  it("accepts record-shaped variables (stale doc shape) as names", async () => {
    const row = {
      id: "offer-badge",
      name: "Offer Badge",
      version: 2,
      variables: { label: { kind: "text" } },
    };
    const { ctx } = contextWith(componentsRouter({ list: { ok: true, value: listReport([row]) } }));
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const cards = summaryJson(expectOk(result)).components as Record<string, unknown>[];
    expect(cards[0]?.variables).toEqual(["label"]);
  });

  it("trims cards to the §6.1 budget with a showing-K-of-M warning", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      id: `comp-${i}`,
      name: `Component ${i}`,
      version: 1,
      tags: ["ui"],
      variables: [],
    }));
    const { ctx } = contextWith(
      componentsRouter({ list: { ok: true, value: listReport(twenty) } }),
    );
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const okResult = expectOk(result);
    const cards = summaryJson(okResult).components as unknown[];
    expect(cards).toHaveLength(MAX_LIST_CARDS);
    expect(okResult.warnings).toContain(
      `showing ${MAX_LIST_CARDS} of 20 components; narrow with tags or query`,
    );
  });

  it("keeps the summary under 2000 chars even for wide cards", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      id: `comp-${i}`,
      name: "N".repeat(120),
      version: 1,
      tags: ["ui"],
      variables: Array.from({ length: 12 }, (_, v) => `variable-name-${v}`),
    }));
    const { ctx } = contextWith(
      componentsRouter({ list: { ok: true, value: listReport(twenty) } }),
    );
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const okResult = expectOk(result);
    expect(okResult.summary.length).toBeLessThanOrEqual(2000);
    expect(okResult.warnings?.join(" ")).toMatch(/showing \d+ of 20 components/);
  });

  it("warns differently for an empty library vs an empty filter result", async () => {
    const harness = contextWith(
      componentsRouter({ list: { ok: true, value: listReport([], []) } }),
    );
    const noFilters = await componentListTool.run(harness.ctx, {}, freshSignal());
    expect(expectOk(noFilters).warnings).toContain(
      "the component library is empty — nothing to list",
    );

    const filtered = await componentListTool.run(harness.ctx, { query: "zzz" }, freshSignal());
    const filteredOk = expectOk(filtered);
    expect(filteredOk.warnings).toContain(
      "no component matches these filters; list without tags or query to see every component",
    );
    expect(summaryJson(filteredOk).components).toEqual([]);
  });

  it("passes engine failures through with code and retryable intact", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        list: {
          ok: false,
          code: "engine_unavailable",
          message: "no engine connection",
          hint: "the engine process may be down",
          retryable: true,
        },
      }),
    );
    const result = await componentListTool.run(ctx, {}, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_unavailable");
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("no engine connection");
    }
  });

  it("reads the reply from message-encoded JSON when fields are absent", async () => {
    const message = JSON.stringify({ components: [LIBRARY_ROWS[2]], problems: [] });
    const { ctx } = contextWith(
      componentsRouter({ list: { ok: true, value: { revision: 1, message } } }),
    );
    const result = await componentListTool.run(ctx, {}, freshSignal());
    const cards = summaryJson(expectOk(result)).components as Record<string, unknown>[];
    expect(cards[0]?.id).toBe("star-rating");
  });

  it("refuses to start on a pre-aborted signal (§3.4)", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    const result = await componentListTool.run(ctx, {}, abortedSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("engine_timeout");
    expect(commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// component_place — schema (§6.1 strict: pins, bounds, anchors, vars)
// ---------------------------------------------------------------------------

describe("component_place: argument schema", () => {
  it("accepts the full pinned shape plus an idempotency key", () => {
    const parsed = parseToolArgs(componentPlaceTool, {
      component: "offer-badge@2",
      parent: { layerId: "14" },
      bounds: [900, 72, 180, 180],
      anchor: "topRight",
      vars: { label: "20% OFF", showRibbon: true },
      idempotencyKey: "run-2026-key-1",
    });
    expect(parsed.ok).toBe(true);
  });

  it("accepts the bare minimum and the 64 MP bounds ceiling", () => {
    expect(parseToolArgs(componentPlaceTool, { component: "offer-badge@2" }).ok).toBe(true);
    expect(
      parseToolArgs(componentPlaceTool, {
        component: "offer-badge@2",
        bounds: [0, 0, 16000, 4000], // exactly 64 MP (§2.3)
      }).ok,
    ).toBe(true);
  });

  it("rejects malformed id@version pins", () => {
    const cases: unknown[] = [
      {},
      { component: "offer-badge" },
      { component: "offer-badge@" },
      { component: "offer-badge@0" },
      { component: "offer-badge@02" },
      { component: "offer-badge@2.1" },
      { component: "offer-badge@4294967296" },
      { component: "Offer-Badge@2" },
      { component: "offer badge@2" },
      { component: `${"x".repeat(65)}@2` },
      { component: "@2" },
    ];
    for (const [index, value] of cases.entries()) {
      const parsed = parseToolArgs(componentPlaceTool, value);
      expect(parsed.ok, `case ${index}`).toBe(false);
    }
  });

  it("rejects non-finite and out-of-contract bounds", () => {
    const cases: unknown[] = [
      { component: "offer-badge@2", bounds: [900, 72, 180] },
      { component: "offer-badge@2", bounds: [900, 72, 180, 180, 1] },
      { component: "offer-badge@2", bounds: [Number.NaN, 72, 180, 180] },
      { component: "offer-badge@2", bounds: [Number.POSITIVE_INFINITY, 72, 180, 180] },
      { component: "offer-badge@2", bounds: [900, 72, Number.NaN, 180] },
      { component: "offer-badge@2", bounds: [-5, 72, 180, 180] },
      { component: "offer-badge@2", bounds: [900, -0.5, 180, 180] },
      { component: "offer-badge@2", bounds: [900, 72, 0, 180] },
      { component: "offer-badge@2", bounds: [900, 72, 0.5, 180] },
      { component: "offer-badge@2", bounds: [900, 72, 16385, 180] },
      { component: "offer-badge@2", bounds: [900, 72, 16000, 4001] }, // > 64 MP
      { component: "offer-badge@2", bounds: [300001, 72, 180, 180] },
      { component: "offer-badge@2", bounds: ["900", 72, 180, 180] },
    ];
    for (const [index, value] of cases.entries()) {
      const parsed = parseToolArgs(componentPlaceTool, value);
      expect(parsed.ok, `case ${index}`).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("invalid_args");
    }
  });

  it("rejects unknown anchors, bad parents and bad vars", () => {
    const cases: unknown[] = [
      { component: "offer-badge@2", anchor: "centre" },
      { component: "offer-badge@2", anchor: "top-right" },
      { component: "offer-badge@2", anchor: 1 },
      { component: "offer-badge@2", parent: { layerId: "14", layerName: "Hero" } },
      { component: "offer-badge@2", parent: { layerId: "" } },
      { component: "offer-badge@2", parent: "Hero" },
      { component: "offer-badge@2", vars: { label: 42 } },
      { component: "offer-badge@2", vars: { label: null } },
      { component: "offer-badge@2", vars: { bg: ["#D96C3B"] } },
      { component: "offer-badge@2", vars: "label" },
      { component: "offer-badge@2", bogus: true },
    ];
    for (const [index, value] of cases.entries()) {
      const parsed = parseToolArgs(componentPlaceTool, value);
      expect(parsed.ok, `case ${index}`).toBe(false);
    }
  });

  it("caps vars at 20 entries (§8.4 per-call cap)", () => {
    const twentyOne: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PLACE_VARS + 1; i += 1) twentyOne[`label${i}`] = "x";
    const rejected = parseToolArgs(componentPlaceTool, {
      component: "offer-badge@2",
      vars: twentyOne,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.hint).toContain("max 20");

    const twenty: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PLACE_VARS; i += 1) twenty[`label${i}`] = "x";
    expect(parseToolArgs(componentPlaceTool, { component: "offer-badge@2", vars: twenty }).ok).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure units: pin parsing, anchor math (9-point table), report readers
// ---------------------------------------------------------------------------

describe("component_place: pure units", () => {
  it("parses schema-verified id@version pins", () => {
    expect(parseComponentRef("offer-badge@2")).toStrictEqual({ id: "offer-badge", version: 2 });
    expect(parseComponentRef("a@1")).toStrictEqual({ id: "a", version: 1 });
    expect(parseComponentRef("button-cta@10")).toStrictEqual({ id: "button-cta", version: 10 });
  });

  it("maps every anchor to 0/½/1 fractions (9-point parity)", () => {
    expect(COMPONENT_ANCHORS).toHaveLength(9);
    for (const anchor of COMPONENT_ANCHORS) {
      const [fx, fy] = ANCHOR_FRACTIONS[anchor];
      expect([0, 0.5, 1]).toContain(fx);
      expect([0, 0.5, 1]).toContain(fy);
    }
  });

  it("adjusts bounds so the anchor point lands on the origin (9-point table)", () => {
    // origin (500, 400), size 180×180 — every anchor stays on-canvas.
    const table: readonly [ComponentAnchor, readonly [number, number]][] = [
      ["topLeft", [500, 400]],
      ["topCenter", [410, 400]],
      ["topRight", [320, 400]],
      ["middleLeft", [500, 310]],
      ["center", [410, 310]],
      ["middleRight", [320, 310]],
      ["bottomLeft", [500, 220]],
      ["bottomCenter", [410, 220]],
      ["bottomRight", [320, 220]],
    ];
    for (const [anchor, [expectedX, expectedY]] of table) {
      const [x, y, w, h] = anchorAdjustedBounds(anchor, [500, 400, 180, 180]);
      expect([anchor, x]).toEqual([anchor, expectedX]);
      expect([anchor, y]).toEqual([anchor, expectedY]);
      expect([anchor, w, h]).toEqual([anchor, 180, 180]);
      // Property: the component's anchor point lands exactly on the origin.
      const [fx, fy] = ANCHOR_FRACTIONS[anchor];
      expect(x + fx * w).toBe(500);
      expect(y + fy * h).toBe(400);
    }
  });

  it("reads the variable schema from the real §8.2 manifest", () => {
    const schema = readComponentVarSchema(offerBadge);
    expect(schema?.names).toEqual(OFFER_BADGE_VARS);
    expect(schema?.specs.label).toEqual({ kind: "text", maxChars: 12 });
    expect(schema?.specs.bg).toEqual({ kind: "color" });
    expect(schema?.specs.showRibbon).toEqual({ kind: "visibility" });
  });

  it("keeps unreadable variable specs declared (engine stays the authority)", () => {
    const schema = readComponentVarSchema({
      variables: {
        label: { kind: "textarea", default: "x" },
        showRibbon: { kind: "visibility", default: false },
      },
    });
    expect(schema?.names).toEqual(["label", "showRibbon"]);
    expect(schema?.specs.label).toBeUndefined();
    const checked = validateComponentVars({
      component: "offer-badge@2",
      schema: schema ?? { names: [], specs: {} },
      vars: { label: "anything passes locally" },
    });
    expect(checked.ok).toBe(true);
  });

  it("returns undefined for manifests without a readable variables record", () => {
    expect(readComponentVarSchema(undefined)).toBeUndefined();
    expect(readComponentVarSchema({ variables: "junk" })).toBeUndefined();
    expect(readComponentVarSchema({})).toBeUndefined();
  });

  it("reads placed instances off both reply shapes", () => {
    expect(readPlacedInstance(placeReport()).instanceId).toBe("14");
    const message = JSON.stringify({ instance: 21, warnings: [] });
    expect(readPlacedInstance({ revision: 9, message }).instanceId).toBe("21");
    expect(readPlacedInstance({ revision: 9 }).instanceId).toBeNull();
    const warned = readPlacedInstance(
      placeReport({ warnings: [{ warning: "the component was authored as RGB 8" }] }),
    );
    expect(warned.warnings).toEqual(["the component was authored as RGB 8"]);
  });

  it("reads component lists defensively (junk reports yield no rows)", () => {
    const reply = readComponentList({ revision: 1 });
    expect(reply.rows).toEqual([]);
    expect(reply.problems).toEqual([]);
    expect(reply.unreadableRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// component_place — the flow (§8.3 place semantics, §8.4 validation)
// ---------------------------------------------------------------------------

describe("component_place: flow", () => {
  it("places at anchor-adjusted bounds with validated vars (happy path)", async () => {
    const { ctx, commands, charges } = contextWith(componentsRouter());
    const result = await componentPlaceTool.run(
      ctx,
      {
        component: "offer-badge@2",
        bounds: [900, 72, 180, 180],
        anchor: "topRight",
        vars: { label: "20% OFF", showRibbon: true },
      },
      freshSignal(),
    );
    const okResult = expectOk(result);
    expect(okResult.documentRevision).toBe(9);
    const summary = summaryJson(okResult);
    expect(summary.instanceId).toBe("14");
    expect(summary.component).toBe("offer-badge@2");
    // Manifest order: label before showRibbon.
    expect(summary.variablesApplied).toEqual(["label", "showRibbon"]);

    expect(commands.map((cmd) => cmd.id)).toEqual([
      COMPONENT_INSPECT_COMMAND,
      COMPONENT_PLACE_COMMAND,
    ]);
    expect(commands[0]?.params).toStrictEqual({ id: "offer-badge", version: 2 });
    expect(commands[1]?.params).toStrictEqual({
      id: "offer-badge",
      version: 2,
      bounds: [720, 72, 180, 180], // 900 − 1·180, 72 − 0·180 (anchor baked in)
      vars: { label: "20% OFF", showRibbon: true },
      // no `anchor` key: explicit bounds are the literal frame (§8.3 target_rect)
    });
    expect(charges).toEqual([{ commands: 1 }]);
  });

  it("sends anchor fractions (no bounds) for the engine's default design box", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", anchor: "bottomLeft" },
      freshSignal(),
    );
    const place = commands[1];
    expect(place?.id).toBe(COMPONENT_PLACE_COMMAND);
    expect(place?.params).toStrictEqual({
      id: "offer-badge",
      version: 2,
      anchor: [0, 1], // fractions: the manifest need not declare the name
    });
  });

  it("passes bounds through untouched when no anchor is given", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", bounds: [120, 80, 180, 180] },
      freshSignal(),
    );
    expect(commands[1]?.params).toStrictEqual({
      id: "offer-badge",
      version: 2,
      bounds: [120, 80, 180, 180],
    });
  });

  it("converts parent refs to the engine's layerRef shapes", async () => {
    const byId = contextWith(componentsRouter());
    await componentPlaceTool.run(
      byId.ctx,
      { component: "offer-badge@2", parent: { layerId: "14" } },
      freshSignal(),
    );
    expect((byId.commands[1]?.params as Record<string, unknown>).parent).toBe(14);

    const byName = contextWith(componentsRouter());
    await componentPlaceTool.run(
      byName.ctx,
      { component: "offer-badge@2", parent: { layerName: "Hero Group" } },
      freshSignal(),
    );
    expect((byName.commands[1]?.params as Record<string, unknown>).parent).toBe("Hero Group");
  });

  it("omits the vars key entirely when no variables were set", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    const result = await componentPlaceTool.run(ctx, { component: "offer-badge@2" }, freshSignal());
    const params = commands[1]?.params as Record<string, unknown>;
    expect("vars" in params).toBe(false);
    expect(summaryJson(expectOk(result)).variablesApplied).toEqual([]);
  });

  it("refuses a placement the anchor would push off the canvas", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    const result = await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", bounds: [10, 10, 180, 180], anchor: "bottomRight" },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain("off the canvas");
    }
    // Validation refused before any mutation: only the inspect query ran.
    expect(commands.map((cmd) => cmd.id)).toEqual([COMPONENT_INSPECT_COMMAND]);
  });

  it("lists candidate pins for an unknown component id", async () => {
    const { ctx, commands } = contextWith(
      componentsRouter({
        inspect: {
          ok: false,
          code: "validation_failed",
          message: "invalid parameters for `component.inspect`: unknown component `offer-bage`",
          retryable: false,
        },
      }),
    );
    const result = await componentPlaceTool.run(ctx, { component: "offer-bage@2" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(UNKNOWN_COMPONENT_CODE);
      expect(result.hint).toContain("offer-badge@2");
      expect(result.hint).toContain("button-cta@1");
      expect(result.hint).toContain("star-rating@1");
    }
    expect(commands.map((cmd) => cmd.id)).toEqual([
      COMPONENT_INSPECT_COMMAND,
      COMPONENT_LIST_COMMAND,
    ]);
  });

  it("falls back to a generic hint when the library is empty", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        inspect: {
          ok: false,
          code: "validation_failed",
          message: "invalid parameters for `component.inspect`: unknown component `offer-bage`",
          retryable: false,
        },
        list: { ok: true, value: listReport([], []) },
      }),
    );
    const result = await componentPlaceTool.run(ctx, { component: "offer-bage@2" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(UNKNOWN_COMPONENT_CODE);
      expect(result.hint).toContain("component_list shows this workspace's components.");
    }
  });

  it("names the available version when the pin is stale", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        inspect: {
          ok: false,
          code: "validation_failed",
          message: "no master file for `offer-badge` at version 3",
          retryable: false,
        },
      }),
    );
    const result = await componentPlaceTool.run(ctx, { component: "offer-badge@3" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(UNKNOWN_COMPONENT_CODE);
      expect(result.message).toContain("No version 3");
      expect(result.hint).toContain("Place offer-badge@2");
    }
  });

  it("passes the inspect failure through when the id and version check out", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        inspect: {
          ok: false,
          code: "validation_failed",
          message: "component `offer-badge` has an invalid manifest: tags too long",
          retryable: false,
        },
      }),
    );
    const result = await componentPlaceTool.run(ctx, { component: "offer-badge@2" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain("invalid manifest");
    }
  });

  it("keeps the original failure when the diagnostic list hop also fails", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        inspect: {
          ok: false,
          code: "engine_unavailable",
          message: "could not establish an engine connection",
          retryable: true,
        },
        list: { ok: false, code: "engine_crashed", message: "dead", retryable: true },
      }),
    );
    const result = await componentPlaceTool.run(ctx, { component: "offer-badge@2" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("engine_unavailable");
  });

  it("refuses unknown variables with the §8.4 allowed list", async () => {
    const { ctx, commands } = contextWith(componentsRouter());
    const result = await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", vars: { labl: "20% OFF" } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(UNKNOWN_COMPONENT_VARS_CODE);
      expect(result.message).toContain("labl");
      expect(result.hint).toContain("label, bg, textColor, showRibbon");
    }
    expect(commands.map((cmd) => cmd.id)).toEqual([COMPONENT_INSPECT_COMMAND]);
  });

  it("lists every unknown variable, not just the first", async () => {
    const { ctx } = contextWith(componentsRouter());
    const result = await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", vars: { labl: "X", ribon: "Y" } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("labl");
      expect(result.message).toContain("ribon");
    }
  });

  it("validates variable kinds against the manifest (color hex, text maxChars, visibility)", async () => {
    const colorFails: unknown[] = [
      "rgb(217, 108, 59)",
      "hsl(20, 63%, 54%)",
      "#GGG3B",
      "D96C3B",
      "",
    ];
    for (const [index, value] of colorFails.entries()) {
      const { ctx, commands } = contextWith(componentsRouter());
      const result = await componentPlaceTool.run(
        ctx,
        { component: "offer-badge@2", vars: { bg: value as string } },
        freshSignal(),
      );
      expect(result.ok, `color case ${index}`).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("validation_failed");
        expect(result.message).toContain("hex");
      }
      expect(commands).toHaveLength(1); // inspect only — nothing dispatched
    }

    const tooLong = contextWith(componentsRouter());
    const long = await componentPlaceTool.run(
      tooLong.ctx,
      { component: "offer-badge@2", vars: { label: "SUPER MEGA SALE NOW" } }, // 19 > maxChars 12
      freshSignal(),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.code).toBe("validation_failed");
      expect(long.message).toContain("19 characters");
      expect(long.hint).toContain("at most 12 characters");
    }

    const visibility = contextWith(componentsRouter());
    const badVisibility = await componentPlaceTool.run(
      visibility.ctx,
      { component: "offer-badge@2", vars: { showRibbon: "true" } },
      freshSignal(),
    );
    expect(badVisibility.ok).toBe(false);
    if (!badVisibility.ok) {
      expect(badVisibility.code).toBe("validation_failed");
      expect(badVisibility.message).toContain("showRibbon");
    }
  });

  it("accepts engine-legal values: hex colours, exact maxChars, codepoint counting", async () => {
    const cases: readonly Record<string, string | boolean>[] = [
      { bg: "#D96C3B" },
      { textColor: "#FFF" }, // #rgb (engine parse_hex)
      { bg: "#D96C3BAA" }, // #rrggbbaa
      { label: "TWELVECHARSX" }, // exactly 12
      // 12 emoji = 12 unicode scalars (24 UTF-16 units) — the engine's
      // chars().count() accepts this; UTF-16 length would not.
      { label: "🎉".repeat(12) },
      { showRibbon: false },
    ];
    for (const [index, vars] of cases.entries()) {
      const { ctx, commands } = contextWith(componentsRouter());
      const result = await componentPlaceTool.run(
        ctx,
        { component: "offer-badge@2", vars },
        freshSignal(),
      );
      expect(result.ok, `ok case ${index}`).toBe(true);
      const params = commands[1]?.params as Record<string, unknown>;
      expect(params.vars).toStrictEqual(vars);
      expect(summaryJson(expectOk(result)).variablesApplied).toEqual([Object.keys(vars)[0]]);
    }
  });

  it("rejects 13 codepoints even when UTF-16 length is higher", async () => {
    const { ctx } = contextWith(componentsRouter());
    const result = await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", vars: { label: "🎉".repeat(13) } },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain("caps it at 12");
    }
  });

  it("stops cleanly when the run budget is exhausted (§5.2)", async () => {
    const { ctx, commands, charges } = contextWith(componentsRouter(), { budgetAllow: false });
    const result = await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", bounds: [10, 10, 180, 180] },
      freshSignal(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("budget_exceeded");
      expect(result.hint).toContain("§5.2");
    }
    expect(charges).toEqual([{ commands: 1 }]);
    expect(commands.map((cmd) => cmd.id)).toEqual([COMPONENT_INSPECT_COMMAND]);
  });

  it("passes engine place failures through with retryable intact", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        place: {
          ok: false,
          code: "engine_unavailable",
          message: "could not establish an engine connection",
          hint: "the engine process may be down",
          retryable: true,
        },
      }),
    );
    const result = await componentPlaceTool.run(ctx, { component: "offer-badge@2" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_unavailable");
      expect(result.retryable).toBe(true);
    }
  });

  it("renders engine placement warnings compactly", async () => {
    const { ctx } = contextWith(
      componentsRouter({
        place: {
          ok: true,
          value: placeReport({
            warnings: [
              {
                warning:
                  'the component was authored as "RGB" 8; its layers keep their own mode and depth inside this document',
              },
              {
                variable: "bg",
                warning: "the layer this variable drives is no longer in the instance",
              },
              "a plain string warning",
            ],
          }),
        },
      }),
    );
    const result = await componentPlaceTool.run(ctx, { component: "offer-badge@2" }, freshSignal());
    const okResult = expectOk(result);
    expect(okResult.warnings?.[0]).toContain("authored as");
    expect(okResult.warnings?.[1]).toContain("bg: the layer this variable drives");
    expect(okResult.warnings?.[2]).toBe("a plain string warning");
  });

  it("degrades when the reply carries neither manifest nor instance", async () => {
    const { ctx, commands } = contextWith(
      componentsRouter({
        inspect: { ok: true, value: { revision: 1 } }, // bare report — no manifest
        place: { ok: true, value: { revision: 9 } }, // bare report — no instance
      }),
    );
    const result = await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", vars: { labl: "X" } }, // unknown name — engine's call now
      freshSignal(),
    );
    const okResult = expectOk(result);
    expect(okResult.documentRevision).toBe(9);
    const summary = summaryJson(okResult);
    expect(summary.instanceId).toBeNull();
    expect(summary.variablesApplied).toEqual(["labl"]); // requested order, unvalidated locally
    expect(okResult.warnings?.join(" ")).toContain("variable schema was not readable");
    expect(okResult.warnings?.join(" ")).toContain("did not identify the placed instance");
    // The bad var still travelled to the engine — its §8.4 check is authoritative.
    const params = commands[1]?.params as Record<string, unknown>;
    expect(params.vars).toStrictEqual({ labl: "X" });
  });

  it("forwards unvalidated vars to the engine in degraded mode", async () => {
    const { ctx, commands } = contextWith(
      componentsRouter({
        inspect: { ok: true, value: { revision: 1, message: "not json at all" } },
      }),
    );
    await componentPlaceTool.run(
      ctx,
      { component: "offer-badge@2", vars: { label: "ANYTHING" } },
      freshSignal(),
    );
    const params = commands[1]?.params as Record<string, unknown>;
    expect(params.vars).toStrictEqual({ label: "ANYTHING" });
  });
});

// ---------------------------------------------------------------------------
// Registry pinning (§6 surface)
// ---------------------------------------------------------------------------

describe("component tools: registry", () => {
  it("registers under the pinned §6 names", () => {
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(componentListTool)).toStrictEqual({ ok: true });
    expect(registry.register(componentPlaceTool)).toStrictEqual({ ok: true });
    expect(registry.get(TOOLS.component_list).ok).toBe(true);
    expect(registry.get(TOOLS.component_place).ok).toBe(true);
    expect(registry.names()).toContain("component_list");
    expect(registry.names()).toContain("component_place");
  });
});
