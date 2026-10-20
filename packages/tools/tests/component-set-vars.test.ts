// component-set-vars.test.ts — the §6 row 13 / §8.4 table for component_set_vars.
//
// Deterministic, pure: engine and component-registry seams are fakes (tests/
// fakes.ts + local recorders), reply shapes mirror engine-patches/component_cmds
// (set_vars_core: merges into the instance state; updateInstance: from/to/
// userChanges/warnings) and the §8.2 offer-badge manifest from the spec.

import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  COMPONENT_SET_VARS_COMMAND,
  COMPONENT_UPDATE_INSTANCE_COMMAND,
  MAX_COMPONENT_VARS,
  componentSetVarsTool,
  engineInstanceRef,
  readSetVarsReport,
  readUpdateInstanceReport,
  renderComponentWarning,
  renderUserChange,
  summarizeSetVars,
  validateVarsAgainstManifest,
  type ComponentInstanceRecord,
  type ComponentManifestLike,
  type ComponentRegistryLike,
  type ComponentVarValue,
} from "../src/tools/component-set-vars.js";
import type {
  BudgetTracker,
  EngineCommand,
  EngineCommandReport,
  EngineFailure,
  EngineLayerSummary,
  EngineLike,
  EngineOutcome,
  ToolContext,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

const success = <T>(value: T): EngineOutcome<T> => ({ ok: true, value });
const failure = (code: EngineFailure["code"], message: string, extra: Partial<EngineFailure> = {}): EngineFailure => ({
  ok: false,
  code,
  message,
  retryable: false,
  ...extra,
});

// ---------------------------------------------------------------------------
// Fixtures — the §8.2 offer-badge manifest, engine-shaped layers and replies
// ---------------------------------------------------------------------------

const OFFER_BADGE: ComponentManifestLike = {
  id: "offer-badge",
  version: 2,
  variables: {
    label: { kind: "text", default: "SALE", maxChars: 12 },
    bg: { kind: "color", default: "#D96C3B" },
    textColor: { kind: "color", default: "#FFF7EE" },
    showRibbon: { kind: "visibility", default: false },
  },
};

const STAR_RATING: ComponentManifestLike = {
  id: "star-rating",
  version: 1,
  variables: {
    count: { kind: "text", default: "4.5" }, // no maxChars → engine default (component_manifest.rs)
    tint: { kind: "color", default: "#FFB300" },
    showCount: { kind: "visibility", default: true },
  },
};

const MANY_COMPONENT: ComponentManifestLike = {
  id: "many-vars",
  version: 1,
  variables: Object.fromEntries(
    Array.from({ length: 20 }, (_, index): [string, { kind: "text"; default: string }] => [
      `v${String(index).padStart(2, "0")}`,
      { kind: "text", default: "x" },
    ]),
  ),
};

const INSTANCES: readonly ComponentInstanceRecord[] = [
  { layerId: "14", component: "offer-badge", version: 2 },
  { layerId: "22", component: "star-rating", version: 1 },
];

const LAYERS: readonly EngineLayerSummary[] = [
  { layerId: "14", name: "Offer Badge", kind: "group", visible: true, childCount: 3 },
  { layerId: "22", name: "Star Rating", kind: "group", visible: true, childCount: 2 },
  { layerId: "7", name: "Background", kind: "group", visible: true },
  { layerId: "30", name: "Badge", kind: "group", visible: true },
  { layerId: "31", name: "Badge", kind: "group", visible: true },
  { layerId: "40", name: "Many Vars", kind: "group", visible: true },
];

// ---------------------------------------------------------------------------
// Fakes — recording engine, budget meter, component registry
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly id: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly options?: { readonly signal?: AbortSignal };
}

interface EnginePlan {
  readonly layers?: EngineOutcome<readonly EngineLayerSummary[]>;
  readonly setVars?: EngineOutcome<EngineCommandReport>;
  readonly update?: EngineOutcome<EngineCommandReport>;
  readonly throwOnExecute?: Error;
}

function recordingEngine(plan: EnginePlan = {}) {
  const calls: RecordedCall[] = [];
  const engine: EngineLike = {
    listLayers: async () => plan.layers ?? success(LAYERS),
    execute: async (cmd: EngineCommand, options?: { signal?: AbortSignal }) => {
      calls.push({ id: cmd.id, params: { ...cmd.params }, options });
      if (plan.throwOnExecute !== undefined) {
        throw plan.throwOnExecute;
      }
      if (cmd.id === COMPONENT_SET_VARS_COMMAND) {
        return plan.setVars ?? success({ revision: 42 });
      }
      if (cmd.id === COMPONENT_UPDATE_INSTANCE_COMMAND) {
        return plan.update ?? success({ revision: 43 });
      }
      return failure("invalid_args", `unexpected command ${cmd.id}`);
    },
    batch: async () => success({ revision: 1, outcomes: [] }),
    render: async () => success({ image: new Uint8Array(), widthPx: 64, heightPx: 64 }),
    inspect: async () => success({ revision: 1, widthPx: 800, heightPx: 600, layers: [] }),
  };
  return { engine, calls };
}

interface RegistryOptions {
  readonly instances?: readonly ComponentInstanceRecord[];
  readonly manifests?: readonly ComponentManifestLike[];
}

function componentRegistry(options: RegistryOptions = {}): ComponentRegistryLike {
  const instances = options.instances ?? INSTANCES;
  const manifests = options.manifests ?? [OFFER_BADGE, STAR_RATING];
  return {
    listInstances: async () => instances,
    getManifest: async (componentId) => manifests.find((m) => m.id === componentId),
  };
}

interface Setup {
  readonly ctx: ToolContext;
  readonly calls: readonly RecordedCall[];
  readonly charges: ReadonlyArray<{ commands?: number; renderPx?: number }>;
}

function setup(
  plan: EnginePlan = {},
  options: RegistryOptions & { readonly noComponents?: boolean; readonly allowCharge?: boolean } = {},
): Setup {
  const { engine, calls } = recordingEngine(plan);
  const charges: Array<{ commands?: number; renderPx?: number }> = [];
  const budgets: BudgetTracker = {
    remaining: () => ({ msRemaining: 5000, commandsRemaining: 256 }),
    charge: (usage) => {
      charges.push({ ...usage });
      return options.allowCharge ?? true;
    },
  };
  const extra: Record<string, unknown> = { engine, budgets };
  if (options.noComponents !== true) {
    extra.components = componentRegistry(options);
  }
  return { ctx: makeFakeContext(extra as Partial<ToolContext>), calls, charges };
}

/** The executor path: parse at the boundary, then run. */
async function run(ctx: ToolContext, args: unknown, signal: AbortSignal = freshSignal()) {
  const parsed = parseToolArgs(componentSetVarsTool, args);
  if (!parsed.ok) {
    return parsed;
  }
  return componentSetVarsTool.run(ctx, parsed.args, signal);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("component_set_vars: happy path", () => {
  it("overrides variables on the instance, by layer id", async () => {
    const signal = freshSignal();
    const { ctx, calls, charges } = setup();
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "SPRING", showRibbon: true } }, signal);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(COMPONENT_SET_VARS_COMMAND);
    // component_cmds.rs layer_ref takes a JSON number for ids, never a string id.
    expect(calls[0]?.params.instance).toBe(14);
    expect(typeof calls[0]?.params.instance).toBe("number");
    expect(calls[0]?.params.vars).toStrictEqual({ label: "SPRING", showRibbon: true });
    expect(calls[0]?.options?.signal).toBe(signal);
    expect(charges).toStrictEqual([{ commands: 1 }]);
    if (result.ok) {
      expect(JSON.parse(result.summary)).toStrictEqual({
        instance: "14",
        updated: ["label", "showRibbon"],
        reapplyApplied: false,
      });
      expect(result.documentRevision).toBe(42);
      expect(result.warnings).toBeUndefined();
      expect(isToolResult(result)).toBe(true);
    }
  });

  it("resolves by exact layer name", async () => {
    const { ctx, calls } = setup();
    const result = await run(ctx, {
      instance: { layerName: "Offer Badge" },
      vars: { label: "MINE" },
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.params.instance).toBe(14);
    if (result.ok) {
      expect(JSON.parse(result.summary).instance).toBe("14");
    }
  });

  it("resolves names case-insensitively, like the engine does", async () => {
    const { ctx, calls } = setup();
    const result = await run(ctx, {
      instance: { layerName: "offer badge" },
      vars: { label: "MINE" },
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.params.instance).toBe(14);
  });

  it("passes hex colours through untouched, including short and 8-digit forms", async () => {
    const { ctx, calls } = setup();
    const result = await run(ctx, {
      instance: { layerId: "14" },
      vars: { bg: "#F60", textColor: "#FFF7EEAA" },
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.params.vars).toStrictEqual({ bg: "#F60", textColor: "#FFF7EEAA" });
  });

  it("renders engine warnings from the setVars reply (structural fields)", async () => {
    const { ctx } = setup({
      setVars: success({
        revision: 42,
        vars: { label: "SPRING" },
        warnings: [
          { variable: "bg", warning: "the layer this variable drives is no longer in the instance" },
          { warning: "variable `old` is dropped: the new version removed it" },
        ],
      } as EngineCommandReport),
    });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "SPRING" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toStrictEqual([
        "variable bg: the layer this variable drives is no longer in the instance",
        "variable `old` is dropped: the new version removed it",
      ]);
    }
  });

  it("reads the setVars reply when the adapter JSON-encodes it in message", async () => {
    const { ctx } = setup({
      setVars: success({
        revision: 42,
        message: JSON.stringify({
          instance: 14,
          vars: { label: "SPRING" },
          warnings: ["recolour skipped: gradient fill refused"],
        }),
      }),
    });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "SPRING" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toStrictEqual(["recolour skipped: gradient fill refused"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Instance resolution (§6.1 refs; §8.3 instance records)
// ---------------------------------------------------------------------------

describe("component_set_vars: instance resolution", () => {
  it("errors with candidates when no layer matches the id", async () => {
    const { ctx, calls } = setup();
    const result = await run(ctx, { instance: { layerId: "999" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("layer_not_found");
      expect(result.hint).toContain("Offer Badge");
    }
    expect(calls).toHaveLength(0);
  });

  it("errors with candidates when no layer matches the name", async () => {
    const { ctx } = setup();
    const result = await run(ctx, { instance: { layerName: "Nope" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("layer_not_found");
      expect(result.message).toContain("No layer matched");
    }
  });

  it("errors on an ambiguous layer name, with the candidate ids", async () => {
    const { ctx } = setup();
    const result = await run(ctx, { instance: { layerName: "Badge" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ambiguous_layer");
      expect(result.hint).toContain("id 30");
      expect(result.hint).toContain("id 31");
    }
  });

  it("errors when the layer exists but is not a component instance, listing instances", async () => {
    const { ctx, calls } = setup();
    const result = await run(ctx, { instance: { layerId: "7" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.message).toContain("is not a component instance");
      expect(result.hint).toContain("id 14 (offer-badge)");
      expect(result.hint).toContain("id 22 (star-rating)");
    }
    expect(calls).toHaveLength(0);
  });

  it("says so when the document has no placed component instances at all", async () => {
    const { ctx } = setup({}, { instances: [] });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.hint).toContain("component_place creates one");
    }
  });

  it("errors when the registry has no manifest for the placed component", async () => {
    const { ctx } = setup({}, { manifests: [] });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.message).toContain("offer-badge");
    }
  });

  it("passes listLayers failures through untouched", async () => {
    const { ctx, calls } = setup({
      layers: failure("engine_unavailable", "no engine session can be served", { retryable: true }),
    });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_unavailable");
      expect(result.message).toBe("no engine session can be served");
      expect(result.retryable).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §8.4 var validation — the unknown/invalid table
// ---------------------------------------------------------------------------

describe("component_set_vars: §8.4 var validation table (pure)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly vars: Record<string, ComponentVarValue>;
    readonly code?: string;
    readonly message?: string;
    readonly hint?: string;
  }> = [
    {
      name: "unknown variable → allowed list attached (§8.4)",
      vars: { nope: true },
      message: "unknown variables: nope",
      hint: "allowed variables: label, bg, textColor, showRibbon",
    },
    {
      name: "several unknown variables are listed together",
      vars: { nope: "x", labl: "y" },
      message: "unknown variables: nope, labl",
    },
    {
      name: "boolean for a text variable",
      vars: { label: false },
      message: 'variable "label" expects a string, got a boolean',
    },
    {
      name: "string for a visibility variable",
      vars: { showRibbon: "yes" },
      message: 'variable "showRibbon" expects true or false, got a string',
    },
    {
      name: "malformed hex colour",
      vars: { bg: "#12" },
      message: 'variable "bg" must be a hex colour (#RGB, #RRGGBB or #RRGGBBAA)',
    },
    {
      name: "rgb() colour → convert hint (valid §6.1, not engine hex)",
      vars: { bg: "rgb(217,108,59)" },
      hint: "convert to #RRGGBB first (§8.4)",
    },
    {
      name: "hsl() colour → convert hint",
      vars: { bg: "hsl(24,100%,59%)" },
      hint: "convert to #RRGGBB first (§8.4)",
    },
    {
      name: "named colour is not a §6.1 colour at all",
      vars: { bg: "red" },
      message: 'variable "bg" must be a hex colour',
    },
    {
      name: "text over maxChars",
      vars: { label: "SPRING SALE NOW!" },
      message: 'variable "label" is 16 chars, over its maxChars (12)',
      hint: "shorten to 12 characters or fewer (§8.4)",
    },
    { name: "exactly maxChars passes", vars: { label: "SPRING SALE—" } },
    { name: "#RRGGBBAA passes", vars: { bg: "#D96C3BAA" } },
    { name: "#RGB passes", vars: { bg: "#F60" } },
    { name: "#RGBA passes", vars: { bg: "#F60C" } },
    { name: "unicode counted in code points, not UTF-16 units", vars: { label: "SPRING 𝕏𝕏𝕏" } },
    {
      name: "text without maxChars passes up to the boundary cap (engine default 4096)",
      vars: { count: "4.5 stars, would buy again" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const manifest = testCase.vars.count !== undefined ? STAR_RATING : OFFER_BADGE;
      const outcome = validateVarsAgainstManifest(manifest, testCase.vars);
      if (testCase.code === undefined && testCase.message === undefined && testCase.hint === undefined) {
        expect(outcome.ok).toBe(true);
      } else {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.code).toBe("validation_failed");
          expect(outcome.message).toContain(testCase.message ?? "");
          expect(outcome.hint).toContain(testCase.hint ?? "");
        }
      }
    });
  }

  it("unknown names win over later kind errors (checked first, like the engine)", () => {
    const outcome = validateVarsAgainstManifest(OFFER_BADGE, { nope: "x", showRibbon: "yes" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("unknown variables: nope");
    }
  });

  it("refuses an unknown manifest kind (seam drift fails loudly)", () => {
    const drifted: ComponentManifestLike = {
      id: "drift",
      version: 1,
      variables: { weird: { kind: "number" as never, default: 1 } },
    };
    const outcome = validateVarsAgainstManifest(drifted, { weird: 1 as never });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("unsupported kind");
    }
  });

  it("lists (none) when the manifest declares no variables", () => {
    const empty: ComponentManifestLike = { id: "empty", version: 1, variables: {} };
    const outcome = validateVarsAgainstManifest(empty, { x: "y" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.hint).toContain("allowed variables: (none)");
    }
  });
});

describe("component_set_vars: §8.4 var validation (integration)", () => {
  it("rejects invalid vars before any mutation or charge", async () => {
    const { ctx, calls, charges } = setup();
    const result = await run(ctx, {
      instance: { layerId: "14" },
      vars: { label: "SPRING SALE NOW!" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.hint).toContain("shorten to 12 characters");
    }
    expect(calls).toHaveLength(0);
    expect(charges).toStrictEqual([]);
  });

  it("rejects a bad hex colour before any mutation", async () => {
    const { ctx, calls } = setup();
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { bg: "#12" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reapply — §8.4 opt-in update pull (default false: NEVER silently restyle)
// ---------------------------------------------------------------------------

describe("component_set_vars: reapply opt-in (§8.4)", () => {
  it("default: never calls component.updateInstance", async () => {
    const { ctx, calls, charges } = setup();
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.id)).toStrictEqual([COMPONENT_SET_VARS_COMMAND]);
    expect(charges).toStrictEqual([{ commands: 1 }]);
    if (result.ok) {
      expect(JSON.parse(result.summary).reapplyApplied).toBe(false);
    }
  });

  it("explicit false also never pulls an update", async () => {
    const { ctx, calls } = setup();
    const result = await run(ctx, {
      instance: { layerId: "14" },
      vars: { label: "MINE" },
      reapply: false,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("reapply=true pulls the latest version after setVars, reporting userChanges", async () => {
    const { ctx, calls, charges } = setup({
      update: success({
        revision: 43,
        updated: true,
        from: 2,
        to: 3,
        userChanges: [
          { layer: "Ribbon", aspect: "name", detail: 'renamed from "Ribbon"' },
          { layer: "Badge", change: "moved outside the declared variables" },
        ],
        warnings: ["variable `ribbonText` is dropped: the new version removed it"],
      } as EngineCommandReport),
    });
    const result = await run(ctx, {
      instance: { layerId: "14" },
      vars: { label: "MINE" },
      reapply: true,
    });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.id)).toStrictEqual([
      COMPONENT_SET_VARS_COMMAND,
      COMPONENT_UPDATE_INSTANCE_COMMAND,
    ]);
    expect(calls[1]?.params).toStrictEqual({ instance: 14 });
    expect(charges).toStrictEqual([{ commands: 2 }]);
    if (result.ok) {
      expect(JSON.parse(result.summary).reapplyApplied).toBe(true);
      expect(result.documentRevision).toBe(43);
      expect(result.warnings).toContain("[reapply] offer-badge: pulled v2→v3");
      expect(result.warnings).toContain('[user change] Ribbon: name: renamed from "Ribbon"');
      expect(result.warnings).toContain(
        "[user change] Badge: moved outside the declared variables",
      );
      expect(result.warnings).toContain("variable `ribbonText` is dropped: the new version removed it");
    }
  });

  it("reapply on an already-current instance succeeds without pulling", async () => {
    const { ctx } = setup({
      update: success({
        revision: 43,
        updated: false,
        from: 2,
        to: 2,
        userChanges: [],
        warnings: [],
      } as EngineCommandReport),
    });
    const result = await run(ctx, {
      instance: { layerId: "14" },
      vars: { label: "MINE" },
      reapply: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.summary).reapplyApplied).toBe(true);
      expect(result.warnings).toContain(
        "[reapply] offer-badge: already on the latest version; nothing was pulled",
      );
    }
  });

  it("reapply failure is a WARNING, never an error — the setVars mutation stands (§8.4)", async () => {
    const { ctx, calls } = setup({
      update: failure("not_found", "component `offer-badge` v2 vanished from the library"),
    });
    const result = await run(ctx, {
      instance: { layerId: "14" },
      vars: { label: "MINE" },
      reapply: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.summary).reapplyApplied).toBe(false);
      expect(result.documentRevision).toBe(42); // the setVars revision, not the failed pull
      expect(result.warnings?.[0]).toContain("[reapply] the component update was not pulled");
      expect(result.warnings?.[0]).toContain("vanished from the library");
    }
    expect(calls.map((call) => call.id)).toHaveLength(2);
  });

  it("caps rendered user changes at two plus a count", async () => {
    const { ctx } = setup({
      update: success({
        revision: 43,
        updated: true,
        from: 2,
        to: 3,
        userChanges: [
          { layer: "A", change: "moved" },
          { layer: "B", change: "moved" },
          { layer: "C", change: "moved" },
          { layer: "D", change: "moved" },
        ],
        warnings: [],
      } as EngineCommandReport),
    });
    const result = await run(ctx, {
      instance: { layerId: "14" },
      vars: { label: "MINE" },
      reapply: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContain("[user change] (+2 more)");
    }
  });
});

// ---------------------------------------------------------------------------
// Entry cap (§6.1) + strict schema
// ---------------------------------------------------------------------------

describe("component_set_vars: entry cap and strict schema", () => {
  const manyVars = (count: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`v${String(index).padStart(2, "0")}`, "x"]));

  it("accepts exactly 20 entries", async () => {
    const { ctx, calls } = setup(
      {},
      {
        instances: [{ layerId: "40", component: "many-vars", version: 1 }],
        manifests: [MANY_COMPONENT],
      },
    );
    const result = await run(ctx, { instance: { layerId: "40" }, vars: manyVars(20) });
    expect(result.ok).toBe(true);
    expect(Object.keys(calls[0]?.params.vars as Record<string, unknown>)).toHaveLength(20);
    if (result.ok) {
      expect(JSON.parse(result.summary).updated).toHaveLength(20);
    }
  });

  it("rejects 21 entries at the boundary", () => {
    const parsed = parseToolArgs(componentSetVarsTool, {
      instance: { layerId: "40" },
      vars: manyVars(21),
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toContain("too many entries");
    }
  });

  it("rejects variable names over 64 chars (manifests name variables 1..64)", () => {
    const parsed = parseToolArgs(componentSetVarsTool, {
      instance: { layerId: "14" },
      vars: { ["x".repeat(65)]: "y" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.hint).toContain("1..64 characters");
    }
  });

  it("accepts a 64-char name at the schema (the manifest decides if it exists)", () => {
    const parsed = parseToolArgs(componentSetVarsTool, {
      instance: { layerId: "14" },
      vars: { ["x".repeat(64)]: "y" },
    });
    expect(parsed.ok).toBe(true);
  });

  const badArgs: ReadonlyArray<[string, unknown]> = [
    ["missing instance", { vars: { label: "MINE" } }],
    ["missing vars", { instance: { layerId: "14" } }],
    ["empty vars", { instance: { layerId: "14" }, vars: {} }],
    ["idempotencyKey is not part of this tool's pinned shape", {
      instance: { layerId: "14" },
      vars: { label: "MINE" },
      idempotencyKey: "key-12345",
    }],
    ["unknown property", { instance: { layerId: "14" }, vars: { label: "MINE" }, extra: 1 }],
    ["instance with both id and name", { instance: { layerId: "14", layerName: "x" }, vars: { label: "MINE" } }],
    ["instance with neither id nor name", { instance: {}, vars: { label: "MINE" } }],
    ["instance as a bare string", { instance: "14", vars: { label: "MINE" } }],
    ["reapply as a string", { instance: { layerId: "14" }, vars: { label: "MINE" }, reapply: "yes" }],
    ["reapply as a number", { instance: { layerId: "14" }, vars: { label: "MINE" }, reapply: 1 }],
    ["numeric var value", { instance: { layerId: "14" }, vars: { label: 12 } }],
    ["null var value", { instance: { layerId: "14" }, vars: { label: null } }],
    ["array var value", { instance: { layerId: "14" }, vars: { label: ["MINE"] } }],
  ];

  for (const [name, args] of badArgs) {
    it(`rejects ${name} as invalid_args`, () => {
      const parsed = parseToolArgs(componentSetVarsTool, args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.code).toBe("invalid_args");
      }
    });
  }

  it("rejects an empty vars record with the engine's own wording", () => {
    const parsed = parseToolArgs(componentSetVarsTool, { instance: { layerId: "14" }, vars: {} });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.hint).toContain("set at least one variable");
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant + compactness (§6.1)
// ---------------------------------------------------------------------------

describe("component_set_vars: tenant and compactness (§6.1)", () => {
  it("sends ONLY the instance and vars to the engine — no tenant ids or tokens", async () => {
    const { ctx, calls } = setup();
    await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE", bg: "#101010" } });
    const params = calls[0]?.params ?? {};
    expect(Object.keys(params).sort()).toStrictEqual(["instance", "vars"]);
    expect(JSON.stringify(params)).not.toContain("org_00000000");
    expect(JSON.stringify(params)).not.toContain("organizationId");
  });

  it("never echoes variable VALUES in the summary — names only", async () => {
    const { ctx } = setup();
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "TopSecret12" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).not.toContain("TopSecret12");
      expect(JSON.parse(result.summary).updated).toStrictEqual(["label"]);
    }
  });

  it("caps warnings at 20 and notes the tail", async () => {
    const { ctx } = setup({
      setVars: success({
        revision: 42,
        warnings: Array.from({ length: 25 }, (_, index) => `soft issue ${index}`),
      } as EngineCommandReport),
    });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(20);
      expect(result.warnings?.at(-1)).toBe("(+6 more warnings omitted)");
      expect(result.warnings?.at(-2)).toBe("soft issue 18");
    }
  });

  it("clips each rendered warning to the kit's 500-char cap", async () => {
    const { ctx } = setup({
      setVars: success({
        revision: 42,
        warnings: [{ warning: "x".repeat(600) }],
      } as EngineCommandReport),
    });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings?.[0]?.length).toBeLessThanOrEqual(500);
      expect(result.warnings?.[0]?.endsWith("...")).toBe(true);
    }
  });

  it("keeps the summary under 2000 chars for 20 maximal variable names", async () => {
    const { ctx } = setup(
      {},
      {
        instances: [{ layerId: "40", component: "many-vars", version: 1 }],
        manifests: [MANY_COMPONENT],
      },
    );
    const longNames = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`${"n".repeat(63)}${index}`, "x"]),
    );
    const result = await run(ctx, { instance: { layerId: "40" }, vars: longNames });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.length).toBeLessThanOrEqual(2000);
      expect(isToolResult(result)).toBe(true);
    }
  });

  it("fails closed with internal_error when the component seam is not wired", async () => {
    const { ctx, calls } = setup({}, { noComponents: true });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal_error");
      expect(result.message).toContain("component registry seam");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses to start on an already-aborted signal (§3.4)", async () => {
    const { ctx, calls } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await componentSetVarsTool.run(
      ctx,
      { instance: { layerId: "14" }, vars: { label: "MINE" } },
      controller.signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_timeout");
    }
    expect(calls).toHaveLength(0);
  });

  it("converts engine transport throws into internal_error without leaking the throw", async () => {
    const { ctx } = setup({ throwOnExecute: new Error("secret path /etc/x") });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal_error");
      expect(result.message).not.toContain("/etc/x");
    }
  });
});

// ---------------------------------------------------------------------------
// Engine failures + budget
// ---------------------------------------------------------------------------

describe("component_set_vars: engine failures and budget", () => {
  it("passes setVars failures through with the engine's own text (§5.7)", async () => {
    const { ctx, calls, charges } = setup({
      setVars: failure(
        "invalid_args",
        "invalid parameters for `component.setVars`: unknown variable `x`; " +
          "allowed variables: label, bg, textColor, showRibbon",
      ),
    });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_args");
      expect(result.message).toContain("unknown variable `x`");
      expect(result.message).toContain("allowed variables: label, bg, textColor, showRibbon");
    }
    expect(calls).toHaveLength(1);
    expect(charges).toStrictEqual([{ commands: 1 }]); // charged for what was dispatched
  });

  it("preserves retryable and hint from the engine failure", async () => {
    const { ctx } = setup({
      setVars: failure("engine_timeout", "the engine timed out", {
        hint: "retry with fewer variables",
        retryable: true,
      }),
    });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.hint).toBe("retry with fewer variables");
    }
  });

  it("stops cleanly at the budget boundary before dispatching anything (§5.2)", async () => {
    const { ctx, calls } = setup({}, { allowCharge: false });
    const result = await run(ctx, { instance: { layerId: "14" }, vars: { label: "MINE" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("budget_exceeded");
      expect(result.hint).toContain("partial charge");
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Registry pinning
// ---------------------------------------------------------------------------

describe("component_set_vars: registry pinning", () => {
  it("is named on the pinned §6 surface and registers cleanly", () => {
    expect(TOOLS.component_set_vars).toBe("component_set_vars");
    expect(componentSetVarsTool.name).toBe("component_set_vars");
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(componentSetVarsTool)).toStrictEqual({ ok: true });
    expect(registry.get(TOOLS.component_set_vars).ok).toBe(true);
    expect(registry.register(componentSetVarsTool).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("component_set_vars: pure helper tables", () => {
  it("engineInstanceRef maps numeric ids to JSON numbers, everything else to names", () => {
    expect(engineInstanceRef("14", "Offer Badge")).toBe(14);
    expect(engineInstanceRef("abc123", "Offer Badge")).toBe("Offer Badge");
    expect(engineInstanceRef("14x", "Offer Badge")).toBe("Offer Badge");
    // u64 ids beyond Number.MAX_SAFE_INTEGER would lose precision — name wins.
    expect(engineInstanceRef("9007199254740993", "Offer Badge")).toBe("Offer Badge");
  });

  it("readSetVarsReport reads structural fields, then message JSON, then degrades", () => {
    expect(readSetVarsReport({ revision: 1, vars: { label: "MINE" }, warnings: ["w"] })).toStrictEqual({
      vars: { label: "MINE" },
      warnings: ["w"],
    });
    expect(
      readSetVarsReport({ revision: 1, message: JSON.stringify({ warnings: ["w"] }) }),
    ).toStrictEqual({ vars: undefined, warnings: ["w"] });
    expect(readSetVarsReport({ revision: 1, message: "plain prose" })).toStrictEqual({
      vars: undefined,
      warnings: [],
    });
  });

  it("readUpdateInstanceReport surfaces updated/from/to/userChanges/warnings", () => {
    const report = readUpdateInstanceReport({
      revision: 43,
      updated: true,
      from: 2,
      to: 3,
      userChanges: [{ layer: "Ribbon", change: "moved" }],
      warnings: ["dropped: old"],
    } as EngineCommandReport);
    expect(report).toStrictEqual({
      updated: true,
      from: 2,
      to: 3,
      userChanges: [{ layer: "Ribbon", change: "moved" }],
      warnings: ["dropped: old"],
    });
    expect(readUpdateInstanceReport({ revision: 1 }).updated).toBeUndefined();
  });

  it("renderComponentWarning handles every engine shape", () => {
    expect(renderComponentWarning("plain")).toBe("plain");
    expect(renderComponentWarning({ warning: "dropped" })).toBe("dropped");
    expect(renderComponentWarning({ variable: "bg", warning: "binding lost" })).toBe(
      "variable bg: binding lost",
    );
    // no double prefix when the message already names the variable
    expect(renderComponentWarning({ variable: "bg", warning: "variable bg is empty" })).toBe(
      "variable bg is empty",
    );
    expect(renderComponentWarning({})).toBe("(unrenderable component warning)");
    expect(renderComponentWarning(7)).toBe("(unrenderable component warning)");
  });

  it("renderUserChange handles both engine shapes and strings", () => {
    expect(renderUserChange({ layer: "Ribbon", aspect: "name", detail: 'renamed from "Ribbon"' })).toBe(
      'Ribbon: name: renamed from "Ribbon"',
    );
    expect(renderUserChange({ layer: "Ribbon", change: "moved outside the declared variables" })).toBe(
      "Ribbon: moved outside the declared variables",
    );
    expect(renderUserChange("moved")).toBe("moved");
    expect(renderUserChange({})).toBe("(unrenderable user change)");
  });

  it("summarizeSetVars emits the pinned JSON and fits the 2000-char budget", () => {
    const small = summarizeSetVars({ instance: "14", updated: ["label", "showRibbon"], reapplyApplied: true });
    expect(JSON.parse(small)).toStrictEqual({
      instance: "14",
      updated: ["label", "showRibbon"],
      reapplyApplied: true,
    });
    const wide = summarizeSetVars({
      instance: "14",
      updated: Array.from({ length: 20 }, (_, index) => "n".repeat(64) + index),
      reapplyApplied: false,
    });
    expect(wide.length).toBeLessThanOrEqual(2000);
    const huge = summarizeSetVars({
      instance: "L".repeat(200),
      updated: Array.from({ length: 100 }, (_, index) => "v".repeat(200) + index),
      reapplyApplied: false,
    });
    expect(huge.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(huge).updated.at(-1)).toContain("(+");
  });
});
