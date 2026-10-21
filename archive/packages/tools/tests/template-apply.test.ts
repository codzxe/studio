// template-apply.test.ts — §6 row 4 tool: strict schema, apply flow, engine error
// mapping, asGroup passthrough, idempotency warning. Pure fakes only, no engine.

import { describe, expect, it } from "vitest";
import { parseToolArgs } from "../src/kit.js";
import {
  ENGINE_PATCH_HINT,
  TEMPLATE_APPLY_COMMAND_ID,
  type TemplateApplyReport,
  mapApplyEngineFailure,
  parseApplyReport,
  templateApplyArgsSchema,
  templateApplyTool,
} from "../src/tools/template-apply.js";
import type {
  EngineCallOptions,
  EngineCommand,
  EngineCommandReport,
  EngineFailure,
  EngineLayerSummary,
  EngineOutcome,
  TemplateManifest,
  TemplateSummary,
  ToolContext,
  ToolErrorCode,
} from "../src/types.js";
import { abortedSignal, freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures (§7.2 shape; ids mirror the engine patch's test templates)
// ---------------------------------------------------------------------------

const PIN = "instagram-post@3";

/** Parsed args at the default (§7.4: asGroup defaults true on this surface). */
const APPLY: { readonly template: string; readonly asGroup: boolean } = {
  template: PIN,
  asGroup: true,
};

const MANIFEST: TemplateManifest = {
  id: "instagram-post",
  version: "3",
  slots: { headline: { kind: "text" }, photo: { kind: "image" } },
  layerMap: { headline: "Headline", photo: "Photo" },
};

const SUMMARIES: readonly TemplateSummary[] = [
  {
    id: "instagram-post",
    version: "3",
    title: "Instagram Post — Promo",
    tags: ["social"],
    slotCount: 2,
  },
  {
    id: "youtube-thumbnail",
    version: "1",
    title: "YouTube Thumbnail",
    tags: ["social"],
    slotCount: 3,
  },
];

const CANVAS_WARNING = "the manifest's canvas is 1080x1080 but the document is 800x600";

/** The §7.4 reply the engine patch returns, plus the seam's own `revision`. */
function applyReply(extra: Record<string, unknown> = {}): EngineCommandReport {
  return {
    revision: 41,
    document_revision: 41,
    group_id: 12,
    slots: { headline: 7, photo: 9 },
    missing: [],
    warnings: [CANVAS_WARNING],
    ...extra,
  } as EngineCommandReport;
}

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

// ---------------------------------------------------------------------------
// Fake context with an engine probe
// ---------------------------------------------------------------------------

type ExecuteFn = (
  cmd: EngineCommand,
  options?: EngineCallOptions,
) => Promise<EngineOutcome<EngineCommandReport>>;

interface ContextOverride {
  readonly execute?: ExecuteFn;
  readonly layers?: readonly EngineLayerSummary[];
  readonly manifest?: TemplateManifest | undefined;
  readonly summaries?: readonly TemplateSummary[];
}

interface Probe {
  readonly commands: EngineCommand[];
  readonly options: (EngineCallOptions | undefined)[];
}

function makeContext(overrides: ContextOverride = {}): { ctx: ToolContext; probe: Probe } {
  const probe: Probe = { commands: [], options: [] };
  const base = makeFakeContext();
  const inner: ExecuteFn =
    overrides.execute ??
    (async (): Promise<EngineOutcome<EngineCommandReport>> => ({ ok: true, value: applyReply() }));
  const manifest: TemplateManifest | undefined =
    "manifest" in overrides ? overrides.manifest : MANIFEST;
  const ctx = makeFakeContext({
    engine: {
      ...base.engine,
      execute: async (cmd, options) => {
        probe.commands.push(cmd);
        probe.options.push(options);
        return inner(cmd, options);
      },
      listLayers: async () => ({ ok: true, value: overrides.layers ?? [] }),
    },
    templates: {
      get: async (ref) => (ref === PIN ? manifest : undefined),
      list: async () => overrides.summaries ?? SUMMARIES,
    },
  });
  return { ctx, probe };
}

function groupLayer(layerId: string, name: string): EngineLayerSummary {
  return { layerId, name, kind: "Group", visible: true };
}

// ---------------------------------------------------------------------------
// §6.1 strict schema table
// ---------------------------------------------------------------------------

describe("template_apply argument schema (§6.1 strict)", () => {
  const rows: readonly {
    label: string;
    raw: Record<string, unknown>;
    accepts: boolean;
  }[] = [
    { label: "accepts the minimal pin a@1", raw: { template: "a@1" }, accepts: true },
    {
      label: "accepts a 64-char id at the engine cap",
      raw: { template: `${"t".repeat(64)}@1` },
      accepts: true,
    },
    {
      label: "rejects a 65-char id",
      raw: { template: `${"t".repeat(65)}@1` },
      accepts: false,
    },
    { label: "rejects an unpinned id", raw: { template: "instagram-post" }, accepts: false },
    { label: "rejects an empty version", raw: { template: "instagram-post@" }, accepts: false },
    {
      label: "rejects version 0 (versions start at 1)",
      raw: { template: "instagram-post@0" },
      accepts: false,
    },
    {
      label: "rejects a leading-zero version",
      raw: { template: "instagram-post@03" },
      accepts: false,
    },
    {
      label: "rejects an 11-digit version",
      raw: { template: "instagram-post@12345678901" },
      accepts: false,
    },
    {
      label: "rejects semver-style versions (engine pins are whole numbers)",
      raw: { template: "instagram-post@1.0.0" },
      accepts: false,
    },
    { label: "rejects uppercase ids", raw: { template: "Instagram-Post@3" }, accepts: false },
    { label: "rejects ids starting with a dash", raw: { template: "-post@3" }, accepts: false },
    {
      label: "accepts a 120-char name at the cap",
      raw: { template: PIN, name: "x".repeat(120) },
      accepts: true,
    },
    {
      label: "rejects a 121-char name",
      raw: { template: PIN, name: "x".repeat(121) },
      accepts: false,
    },
    { label: "rejects a blank name", raw: { template: PIN, name: "   " }, accepts: false },
    { label: "rejects an empty name", raw: { template: PIN, name: "" }, accepts: false },
    {
      label: "rejects a non-boolean asGroup",
      raw: { template: PIN, asGroup: "yes" },
      accepts: false,
    },
    {
      label: "rejects unknown keys (additionalProperties: false)",
      raw: { template: PIN, extra: true },
      accepts: false,
    },
  ];
  for (const { label, raw, accepts } of rows) {
    it(label, () => {
      expect(templateApplyArgsSchema.safeParse(raw).success).toBe(accepts);
    });
  }

  it("defaults asGroup to true (the studio surface groups applied layers)", () => {
    const parsed = templateApplyArgsSchema.safeParse({ template: PIN });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.asGroup).toBe(true);
    }
  });

  it("keeps an explicit asGroup: false", () => {
    const parsed = templateApplyArgsSchema.safeParse({ template: PIN, asGroup: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.asGroup).toBe(false);
    }
  });

  it("parseToolArgs turns schema failures into invalid_args envelopes (§6.1)", () => {
    const parsed = parseToolArgs(templateApplyTool, { template: "nope" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toContain("template");
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("template_apply run — happy path", () => {
  it("folds the engine slots map into a structured summary", async () => {
    const signal = freshSignal();
    const { ctx, probe } = makeContext();
    const res = await templateApplyTool.run(ctx, APPLY, signal);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.summary).toBe(
      JSON.stringify({
        applied: PIN,
        documentRevision: 41,
        groupId: "12",
        slots: { headline: "7", photo: "9" },
      }),
    );
    expect(res.documentRevision).toBe(41);
    expect(res.warnings).toEqual([CANVAS_WARNING]);

    expect(probe.commands).toHaveLength(1);
    expect(probe.commands[0]?.id).toBe(TEMPLATE_APPLY_COMMAND_ID);
    expect(probe.commands[0]?.params).toEqual({ id: PIN, asGroup: true });
    expect(probe.options[0]?.signal).toBe(signal);
  });

  it("surfaces the engine's missing-slot list as a warning", async () => {
    const { ctx } = makeContext({
      execute: async () => ({ ok: true, value: applyReply({ missing: ["logo"] }) }),
    });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.warnings?.some((warning) => warning.includes("logo"))).toBe(true);
  });

  it("falls back to the manifest layer map when the adapter drops the payload", async () => {
    const { ctx } = makeContext({
      execute: async () => ({ ok: true, value: { revision: 7 } }),
    });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    const summary = JSON.parse(res.summary) as TemplateApplyReport;
    expect(summary.documentRevision).toBe(7);
    expect(summary.groupId).toBeNull();
    expect(summary.slots).toEqual({ headline: "Headline", photo: "Photo" });
    expect(res.warnings?.some((warning) => warning.includes("best-effort"))).toBe(true);
  });

  it("passes asGroup and name to the engine verbatim", async () => {
    const { ctx, probe } = makeContext();
    const res = await templateApplyTool.run(
      ctx,
      { template: PIN, name: "Promo", asGroup: false },
      freshSignal(),
    );
    expect(res.ok).toBe(true);
    expect(probe.commands[0]?.params).toEqual({ id: PIN, name: "Promo", asGroup: false });

    const second = makeContext();
    await templateApplyTool.run(second.ctx, APPLY, freshSignal());
    expect(second.probe.commands[0]?.params).toEqual({ id: PIN, asGroup: true });
  });
});

// ---------------------------------------------------------------------------
// Unknown template
// ---------------------------------------------------------------------------

describe("template_apply run — unknown template", () => {
  it("fails not_found with catalog candidates (§6.1)", async () => {
    const { ctx } = makeContext({ manifest: undefined });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("not_found");
    expect(res.message).toContain(PIN);
    expect(res.hint).toContain("instagram-post@3");
    expect(res.hint).toContain("youtube-thumbnail@1");
    expect(res.retryable).toBe(false);
  });

  it("says so when the catalog is empty", async () => {
    const { ctx } = makeContext({ manifest: undefined, summaries: [] });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("not_found");
    expect(res.hint).toContain("no templates");
  });
});

// ---------------------------------------------------------------------------
// Engine error mapping
// ---------------------------------------------------------------------------

describe("template_apply run — engine error mapping", () => {
  it(
    "missing_required_commands → engine_unavailable with the patch hint, not retryable",
    async () => {
      const { ctx } = makeContext({
        execute: async () =>
          failure("missing_required_commands", "the engine registry is missing 1 command(s)"),
      });
      const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
      expect(res.ok).toBe(false);
      if (res.ok) {
        throw new Error("expected a failure envelope");
      }
      expect(res.code).toBe("engine_unavailable");
      expect(res.hint).toBe(ENGINE_PATCH_HINT);
      expect(res.retryable).toBe(false);
    },
  );

  it("unknown_command (older engine build) maps the same way", async () => {
    const { ctx } = makeContext({
      execute: async () => failure("unknown_command", "the engine does not know this command"),
    });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("engine_unavailable");
    expect(res.hint).toBe(ENGINE_PATCH_HINT);
    expect(res.retryable).toBe(false);
  });

  it("catalog failures pass through with message and retryable kept", async () => {
    const { ctx } = makeContext({
      execute: async () =>
        failure("engine_crashed", "an established engine connection died", { retryable: true }),
    });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("engine_crashed");
    expect(res.message).toBe("an established engine connection died");
    expect(res.retryable).toBe(true);
  });
});

describe("mapApplyEngineFailure — facade codes nearest §13.3 code", () => {
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
      const res = mapApplyEngineFailure(failure(code, "engine said no"));
      expect(res.code).toBe(expected);
      expect(res.message).toBe("engine said no");
    });
  }

  it("keeps the engine's hint and retryable flag", () => {
    const res = mapApplyEngineFailure(
      failure("engine_timeout", "the tool ran out of time", {
        hint: "retry smaller",
        retryable: true,
      }),
    );
    expect(res.hint).toBe("retry smaller");
    expect(res.retryable).toBe(true);
  });

  it("clips oversized engine messages and hints (§6.1 caps)", () => {
    const res = mapApplyEngineFailure(
      failure("engine_crashed", "x".repeat(1500), { hint: "y".repeat(600) }),
    );
    expect(res.message.length).toBeLessThanOrEqual(1000);
    expect(res.hint?.length).toBeLessThanOrEqual(500);
  });

  it("maps the engine's own unknown-template text to not_found (catalog drift)", () => {
    const res = mapApplyEngineFailure(
      failure(
        "engine_command_failed",
        "no template `instagram-post` in the catalog; have menu-a4@1",
      ),
    );
    expect(res.code).toBe("not_found");
    expect(res.message).toContain("menu-a4@1");
  });

  it("detects missing commands by text when the code is a generic one", () => {
    const res = mapApplyEngineFailure(
      failure("engine_command_failed", "unknown command: template.apply"),
    );
    expect(res.code).toBe("engine_unavailable");
    expect(res.hint).toBe(ENGINE_PATCH_HINT);
    expect(res.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — repeated apply warns, never errors
// ---------------------------------------------------------------------------

describe("template_apply run — repeated apply", () => {
  it("warns when a same-named group is already in the tree", async () => {
    const { ctx } = makeContext({
      layers: [groupLayer("3", "Instagram Post — Promo")],
    });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.warnings).toContain("template applied more than once");
  });

  it("matches the prior group by an explicit name", async () => {
    const { ctx } = makeContext({ layers: [groupLayer("3", "Promo")] });
    const res = await templateApplyTool.run(
      ctx,
      { template: PIN, name: "Promo", asGroup: true },
      freshSignal(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.warnings).toContain("template applied more than once");
  });

  it("a same-named non-group layer is not a prior apply", async () => {
    const { ctx } = makeContext({
      layers: [{ layerId: "3", name: "Instagram Post — Promo", kind: "Pixel", visible: true }],
    });
    const res = await templateApplyTool.run(ctx, APPLY, freshSignal());
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected a success envelope");
    }
    expect(res.warnings?.includes("template applied more than once")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseApplyReport — the two seam channels
// ---------------------------------------------------------------------------

describe("parseApplyReport (seam payload channels)", () => {
  it("reads the reply object directly", () => {
    const report = parseApplyReport(applyReply());
    expect(report?.documentRevision).toBe(41);
    expect(report?.groupId).toBe("12");
    expect(report?.slots).toEqual({ headline: "7", photo: "9" });
    expect(report?.warnings).toEqual([CANVAS_WARNING]);
  });

  it("reads a JSON payload folded into message", () => {
    const message = JSON.stringify({
      document_revision: 41,
      group_id: 12,
      slots: { headline: 7 },
      missing: [],
      warnings: [],
    });
    const report = parseApplyReport({ revision: 41, message });
    expect(report?.slots).toEqual({ headline: "7" });
    expect(report?.groupId).toBe("12");
  });

  it("returns undefined when neither channel carries the payload", () => {
    expect(parseApplyReport({ revision: 5 })).toBeUndefined();
    expect(parseApplyReport({ revision: 5, message: "Applied." })).toBeUndefined();
  });

  it("accepts string layer ids from a stringifying adapter", () => {
    const report = parseApplyReport(applyReply({ slots: { headline: "7", photo: "9" } }));
    expect(report?.slots).toEqual({ headline: "7", photo: "9" });
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — the §3.4 deadline through the seam
// ---------------------------------------------------------------------------

describe("template_apply run — signal", () => {
  it("a pre-aborted signal stops before any engine call", async () => {
    const { ctx, probe } = makeContext();
    const res = await templateApplyTool.run(ctx, APPLY, abortedSignal());
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected a failure envelope");
    }
    expect(res.code).toBe("engine_timeout");
    expect(probe.commands).toHaveLength(0);
  });
});
