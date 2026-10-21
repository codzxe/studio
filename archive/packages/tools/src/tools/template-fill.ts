// @studio/tools — template_fill (§6 row 5; the §6.2 worked example; §7 slot rules).
//
// Flow (mirrors §6.2, adapted to the engine-patches `template.fill` command):
//   1. ctx.templates.get(template)        — cached manifest lookup by id@version.
//   2. unknown slot names → err(unknown_slots) listing unknown vs known (§6.2).
//   3. resolve image asset_ids → workspace storageUrls (§6 row 6 seam, §15.1 tenancy).
//   4. compileSlotValues()                — pure: tool slot values → template.fill
//      slot args, kinds checked against the manifest, focal clamped to 0..1.
//   5. ctx.engine.execute(template.fill)  — the engine command does the actual work:
//      it owns the §7.3 slot rules (fitText shrinking, maxChars trimming, upscale
//      warning >125% / error >200%, optional slots staying present but hidden).
//      This tool never re-implements those rules; it maps and reports.
//   6. engine result { applied, warnings, errors } → compact ok() reply
//      (§6.1: summary + warnings + documentRevision), or err on hard failures.
//
// Engine contract (engine-patches/template_cmds/fill.rs, §7.4):
//   template.fill { slots } → { applied: string[], warnings: [{code,slot,message}],
//   errors: [] } — `errors` stays empty in every Ok reply (hard failures are Err),
//   so a non-empty `errors` on an Ok reply is surfaced as a soft error, never dropped.

import { z } from "zod";
import {
  MAX_ARG_RECORD_ENTRIES,
  MAX_ARG_STRING_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNINGS,
  MAX_WARNING_CHARS,
  cappedRecord,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
  zColor,
  zIdempotencyKey,
  zTemplateRef,
} from "../kit.js";
import type {
  EngineCommandReport,
  EngineFailure,
  TemplateManifest,
  Tool,
  ToolContext,
  ToolErr,
  ToolErrorCode,
} from "../types.js";

/** The single engine command underneath (§6 row 5); the model never sees this id. */
export const TEMPLATE_FILL_COMMAND = "template.fill";

/** §6.2: at most 40 slot entries per fill (the kit's record cap). */
const MAX_SLOTS = MAX_ARG_RECORD_ENTRIES;
/** Slot kinds this tool fills; manifests may declare others (e.g. §7.2 `component`). */
const FILLABLE_SLOT_KINDS: ReadonlySet<string> = new Set(["text", "image", "color", "visibility"]);
/**
 * Colour the engine accepts for fills (fill.rs `color_passthrough`): #RRGGBB / #RRGGBBAA.
 * The tool schema accepts the wider §6.1 set (`zColor`); the compiler narrows to the
 * engine's contract with an actionable error instead of a cryptic BadParams.
 */
const ENGINE_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/**
 * The engine's §7.3 upscale refusal (fill.rs):
 * "slot `x`: upscaling the image to N% of its pixels exceeds the 200% limit; …".
 * Matched against the sanitized EngineFailure message (and hint, where adapters may
 * keep the engine's own text) so the tool can return the precise, actionable error.
 */
const IMAGE_UPSCALE_LIMIT_RE = /upscal\w*.{0,120}200\s*%/i;

// ---------------------------------------------------------------------------
// Argument schema (§6.2, strict: additionalProperties: false)
// ---------------------------------------------------------------------------

export interface TextSlotValue {
  readonly kind: "text";
  readonly value: string;
  readonly font?: string;
  readonly size?: number;
  readonly color?: string;
  readonly align?: "left" | "center" | "right" | "justify";
}

export interface ImageSlotValue {
  readonly kind: "image";
  readonly asset_id: string;
  readonly fit: "cover" | "contain" | "fill";
  readonly focal?: { readonly x: number; readonly y: number };
}

export interface ColorSlotValue {
  readonly kind: "color";
  readonly value: string;
}

export interface VisibilitySlotValue {
  readonly kind: "visibility";
  readonly visible: boolean;
}

export type SlotValue = TextSlotValue | ImageSlotValue | ColorSlotValue | VisibilitySlotValue;

/** The §6.2 slot-value union; `fit` defaults to "cover" so parsed args always carry it. */
const slotValueSchema = z.union([
  strictObject({
    kind: z.literal("text"),
    value: cappedString(MAX_ARG_STRING_CHARS), // §6.2: text values cap at 2000 chars
    font: cappedString(200, 1).optional(),
    size: z.number().min(4).max(1200).optional(), // §6.2: 4–1200
    color: zColor.optional(),
    align: z.enum(["left", "center", "right", "justify"]).optional(),
  }),
  strictObject({
    kind: z.literal("image"),
    asset_id: z.string().uuid(),
    fit: z.enum(["cover", "contain", "fill"]).default("cover"),
    focal: strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  }),
  strictObject({ kind: z.literal("color"), value: zColor }),
  strictObject({ kind: z.literal("visibility"), visible: z.boolean() }),
]);

export interface TemplateFillArgs {
  readonly template: string;
  readonly slots: Record<string, SlotValue>;
  /** Accepted for the executor's retry dedupe (§14.2); the engine coalesces internally. */
  readonly idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported pieces are unit-tested; nothing touches the engine)
// ---------------------------------------------------------------------------

/** Clip to `max`, ending in "..." — kit truncation is module-private there. */
function truncateStr(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Join names with ", ", capped to `budget` chars ("(+N more)" tail); ≤80 per name. */
function joinCapped(items: readonly string[], budget: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const item of items) {
    const addition = parts.length === 0 ? truncateStr(item, 80) : `, ${truncateStr(item, 80)}`;
    if (parts.length > 0 && used + addition.length > budget) {
      return `${parts.join("")} (+${items.length - parts.length} more)`;
    }
    parts.push(addition);
    used += addition.length;
  }
  return parts.join("");
}

/** §6.2 exact message: `unknown slots: a, b`; the hint lists the manifest's slots. */
export function unknownSlotsErr(unknown: readonly string[], known: readonly string[]): ToolErr {
  return err("unknown_slots", `unknown slots: ${joinCapped(unknown, 800)}`, {
    hint: `this template's slots: ${joinCapped(known, 400)}`,
    retryable: false,
  });
}

/** Focal components are 0..1 (§7.2); clamp defensively, non-finite falls to centre. */
function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

/** One engine-side soft issue (fill.rs `warning()` shape) as a compact string. */
function renderIssue(entry: unknown): string {
  if (typeof entry === "string") return truncateStr(entry, MAX_WARNING_CHARS);
  if (typeof entry === "object" && entry !== null) {
    const record = entry as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const slot = typeof record.slot === "string" ? record.slot : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    const head = code === undefined ? "" : `[${truncateStr(code, 40)}] `;
    if (message !== undefined && slot !== undefined && !message.includes(slot)) {
      return truncateStr(`${head}slot ${slot}: ${message}`, MAX_WARNING_CHARS);
    }
    if (message !== undefined) return truncateStr(`${head}${message}`, MAX_WARNING_CHARS);
    if (slot !== undefined) return truncateStr(`${head}slot ${slot}`, MAX_WARNING_CHARS);
  }
  const fallback =
    typeof entry === "number" || typeof entry === "boolean" ? String(entry) : undefined;
  return truncateStr(fallback ?? "(unrenderable slot issue)", MAX_WARNING_CHARS);
}

function arrayOr(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface FillReport {
  /** Slot names the engine applied (fallback: every requested slot — an Ok fill applies all). */
  readonly applied: readonly string[];
  /** Engine soft warnings, rendered as compact strings (§6.1 reply caps apply upstream). */
  readonly warnings: readonly string[];
  /** Engine `errors` entries on an otherwise-Ok reply (fill.rs keeps these empty; §7.4). */
  readonly softErrors: readonly string[];
}

/**
 * Reads the engine's fill report off the minimal `EngineCommandReport` seam. The
 * reply fields ride along structurally (`{ applied, warnings, errors }`), or arrive
 * JSON-encoded in `message` (adapters may serialize rich replies); when neither is
 * present, a successful fill applied every requested slot and reported no warnings.
 */
export function readFillReport(
  report: EngineCommandReport,
  requested: readonly string[],
): FillReport {
  type ReportWithFields = EngineCommandReport & {
    applied?: unknown;
    warnings?: unknown;
    errors?: unknown;
  };
  const source = report as ReportWithFields;
  let applied = arrayOr(source.applied);
  let warnings = arrayOr(source.warnings);
  let errors = arrayOr(source.errors);
  if (applied === undefined && warnings === undefined && errors === undefined) {
    const parsed = typeof report.message === "string" ? tryParseObject(report.message) : undefined;
    applied = arrayOr(parsed?.applied);
    warnings = arrayOr(parsed?.warnings);
    errors = arrayOr(parsed?.errors);
  }
  const appliedNames =
    applied === undefined
      ? requested
      : applied.filter((name): name is string => typeof name === "string");
  return {
    applied: appliedNames,
    warnings: (warnings ?? []).map(renderIssue),
    softErrors: (errors ?? []).map(renderIssue),
  };
}

/** Compact §6.1 summary: what was filled and what needs attention, never an engine dump. */
export function summarizeFill(input: {
  readonly applied: readonly string[];
  readonly requested: readonly string[];
  readonly warnings: number;
  readonly softErrors: number;
  readonly omitted: number;
}): string {
  const names = input.applied.length === 0 ? "" : ` (${joinCapped(input.applied, 600)})`;
  const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const parts = [plural(input.warnings, "warning")];
  if (input.softErrors > 0) parts.push(plural(input.softErrors, "soft error"));
  if (input.omitted > 0) {
    parts.push(`${plural(input.omitted, "warning")} omitted by the reply cap`);
  }
  const summary = `Filled ${input.applied.length} of ${input.requested.length} slots${names}; `;
  return truncateStr(`${summary}${parts.join(", ")}.`, MAX_SUMMARY_CHARS);
}

// ---------------------------------------------------------------------------
// Compile: tool slot values → template.fill slot args (pure, unit-tested)
// ---------------------------------------------------------------------------

/** What `template.fill` accepts per slot (fill.rs): text {"text"}, image {"path"},
 * colour string, visibility boolean — plus the extras documented per case below. */
export type EngineSlotValue = string | boolean | Readonly<Record<string, unknown>>;

export type CompiledSlots = Readonly<Record<string, EngineSlotValue>>;

export type CompileOutcome = { readonly ok: true; readonly slots: CompiledSlots } | ToolErr;

function engineColorErr(slotName: string): ToolErr {
  return err(
    "invalid_slots",
    `Slot "${truncateStr(slotName, 80)}": colour must be #RRGGBB or #RRGGBBAA`,
    {
      hint: "The template engine reads hex colours only (#3B2A20); rgb()/hsl() pass the tool schema but template.fill needs hex (§7.4).",
      retryable: false,
    },
  );
}

function kindMismatchErr(slotName: string, expected: string, got: string): ToolErr {
  const message = `Slot "${truncateStr(slotName, 80)}" expects kind "${expected}", got "${got}"`;
  return err("invalid_slots", message, {
    hint: "template_inspect lists every slot's kind (§6 row 3); fill each slot with its declared kind.",
    retryable: false,
  });
}

function notFillableErr(slotName: string, kind: string): ToolErr {
  return err(
    "invalid_slots",
    `Slot "${truncateStr(slotName, 80)}" has kind "${kind}", which template_fill does not fill`,
    {
      hint: "Component slots are filled with component_place / component_set_vars (§6 rows 12–13); this tool fills text, image, colour and visibility slots.",
      retryable: false,
    },
  );
}

/**
 * Compiles the parsed slot values into `template.fill`'s slot arguments, walking the
 * manifest's slot order so failures are deterministic (the engine compiles in the same
 * order). Slot RULES stay engine-side (§7.3): the tool checks kinds and shapes only.
 * `assetPaths` maps slot name → engine-visible storageUrl for image slots (§15.1).
 */
export function compileSlotValues(
  manifest: TemplateManifest,
  slots: Record<string, SlotValue>,
  assetPaths: Readonly<Record<string, string>>,
): CompileOutcome {
  const compiled: Record<string, EngineSlotValue> = {};
  for (const name of Object.keys(manifest.slots)) {
    if (!Object.hasOwn(slots, name)) continue;
    const value = slots[name];
    const spec = manifest.slots[name];
    if (value === undefined || spec === undefined) continue;
    const kind = String(spec.kind);
    if (!FILLABLE_SLOT_KINDS.has(kind)) return notFillableErr(name, kind);
    if (value.kind !== kind) return kindMismatchErr(name, kind, value.kind);
    switch (value.kind) {
      case "text": {
        // fill.rs reads "text"; the manifest's style is authoritative (§7.3), so the
        // optional style fields travel for forward-compat but are not applied today.
        if (value.color !== undefined && !ENGINE_HEX_COLOR_RE.test(value.color)) {
          return engineColorErr(name);
        }
        const text: Record<string, unknown> = { text: value.value };
        if (value.font !== undefined) text.font = value.font;
        if (value.size !== undefined) text.size = value.size;
        if (value.color !== undefined) text.color = value.color;
        if (value.align !== undefined) text.align = value.align;
        compiled[name] = text;
        break;
      }
      case "image": {
        const path = assetPaths[name];
        if (path === undefined) {
          const message = `No engine-visible path was resolved for slot "${truncateStr(name, 80)}"`;
          return err("internal_error", message, {
            hint: "Resolve asset_id → storageUrl via the asset store before compiling (§6 row 6 seam).",
            retryable: false,
          });
        }
        const image: Record<string, unknown> = { path, fit: value.fit };
        if (value.focal !== undefined) {
          image.focalPoint = [clamp01(value.focal.x), clamp01(value.focal.y)];
        }
        compiled[name] = image;
        break;
      }
      case "color": {
        if (!ENGINE_HEX_COLOR_RE.test(value.value)) return engineColorErr(name);
        compiled[name] = value.value;
        break;
      }
      case "visibility":
        compiled[name] = value.visible;
        break;
    }
  }
  return { ok: true, slots: compiled };
}

// ---------------------------------------------------------------------------
// Engine failure mapping (§6.1: actionable; §5.7: engine text is data)
// ---------------------------------------------------------------------------

/**
 * §7.3: upscaling past 200% is a hard engine error. The dedicated catalog name
 * `image_upscale_limit` lives in the shared §13.3 catalog (@studio/config
 * ERROR_CODES, adopted via the W7-M swap point) — exported here as the single
 * import point the tests pin (W5-D/W5-Q fleet precedent), and used by the
 * builder below.
 */
export const IMAGE_UPSCALE_LIMIT_CODE: ToolErrorCode = "image_upscale_limit";

export function imageUpscaleLimitErr(engineText: string): ToolErr {
  const trimmed = engineText.trim();
  const message = trimmed.length > 0 ? trimmed : "The image would be upscaled past the 200% limit";
  return err(IMAGE_UPSCALE_LIMIT_CODE, truncateStr(message, MAX_ERROR_MESSAGE_CHARS), {
    hint: "Use a larger image (upscale beyond 125% warns, beyond 200% is refused) or asset_search a higher-resolution one (§7.3).",
    retryable: false,
  });
}

/** EngineFailure → ToolErr: upscale refusals get the precise error, the rest pass through. */
function engineFailureErr(failure: EngineFailure): ToolErr {
  const text = `${failure.message} ${failure.hint ?? ""}`;
  if (IMAGE_UPSCALE_LIMIT_RE.test(text)) return imageUpscaleLimitErr(failure.message);
  const message =
    failure.message.trim().length > 0
      ? truncateStr(failure.message, MAX_ERROR_MESSAGE_CHARS)
      : "template.fill was rejected by the engine";
  return err(failure.code, message, {
    hint: failure.hint === undefined ? undefined : truncateStr(failure.hint, MAX_HINT_CHARS),
    retryable: failure.retryable,
  });
}

async function templateCatalogHint(ctx: ToolContext): Promise<string> {
  try {
    const summaries = await ctx.templates.list({ limit: 10 });
    const refs = summaries.map((template) => `${template.id}@${template.version}`);
    const shown = joinCapped(refs, 400);
    return refs.length > 0
      ? `template_list shows the catalog; candidates: ${shown}`
      : "template_list shows this workspace's templates";
  } catch {
    return "template_list shows this workspace's templates";
  }
}

// ---------------------------------------------------------------------------
// The tool (§6.2)
// ---------------------------------------------------------------------------

export const templateFillTool: Tool<TemplateFillArgs> = defineTool({
  name: "template_fill",
  description:
    "Fill an applied template's slots with text, images, colours and visibility. Slot rules are enforced by the fill; unknown slots are refused and soft issues come back as warnings.",
  args: strictObject({
    template: zTemplateRef, // id@version, must be applied to the document
    slots: cappedRecord(MAX_SLOTS, slotValueSchema), // ≤ 40 entries (§6.2)
    idempotencyKey: zIdempotencyKey.optional(),
  }),
  async run(ctx, args, signal) {
    // 1. Cached manifest lookup (§6.2). A template missing from the catalog is
    //    not_found; a catalogued template that is not APPLIED is refused by the
    //    engine ("run template.apply first") and arrives via the failure path.
    const manifest = await ctx.templates.get(args.template);
    if (manifest === undefined) {
      const message = `No template matches "${truncateStr(args.template, 60)}" in the workspace catalog`;
      return err("not_found", message, {
        hint: await templateCatalogHint(ctx),
        retryable: false,
      });
    }

    // 2. Unknown slot names: §6.2's exact error, listing unknown vs known.
    const known = Object.keys(manifest.slots); // manifest order (§7.2)
    const knownSet = new Set(known);
    const unknown = Object.keys(args.slots).filter((name) => !knownSet.has(name));
    if (unknown.length > 0) return unknownSlotsErr(unknown, known);

    // 3. Resolve image slots to THIS workspace's assets (§6 row 6 seam; §15.1 —
    //    the store is tenant-scoped, and the engine gate re-checks capability roots).
    const assetPaths: Record<string, string> = {};
    for (const [name, value] of Object.entries(args.slots)) {
      if (value.kind !== "image") continue;
      const asset = await ctx.assets.get(value.asset_id);
      if (asset === undefined) {
        const message = `No asset in this workspace matches the asset_id for slot "${truncateStr(name, 80)}"`;
        return err("not_found", message, {
          hint: "asset_search lists this workspace's assets; image slots need an uploaded asset_id (§20).",
          retryable: false,
        });
      }
      assetPaths[name] = asset.storageUrl;
    }

    // 4. Pure compile: kinds vs manifest, focal clamp, engine-ready slot args.
    const requested = known.filter((name) => Object.hasOwn(args.slots, name));
    const compiled = compileSlotValues(manifest, args.slots, assetPaths);
    if (!compiled.ok) return compiled;

    // 5. §5.2: charge the one mutating engine command; stop cleanly at the boundary.
    if (!ctx.budgets.charge({ commands: 1 })) {
      return err(
        "budget_exceeded",
        "The run's command budget ran out before template_fill could dispatch",
        {
          hint: "The executor stops cleanly with a partial charge (§5.2); trim the plan or continue on a fresh run.",
          retryable: false,
        },
      );
    }

    // 6. The engine command does the actual work (§7.3: fitText, maxChars trim,
    //    upscale warn/error, optionals present-but-hidden) as one transaction.
    const result = await ctx.engine.execute(
      { id: TEMPLATE_FILL_COMMAND, params: { slots: compiled.slots } },
      { signal },
    );
    if (!result.ok) return engineFailureErr(result);

    // 7. Map { applied, warnings, errors } → the §6.1 compact reply.
    const report = readFillReport(result.value, requested);
    const merged = [...report.warnings, ...report.softErrors];
    const shown = merged.slice(0, MAX_WARNINGS);
    const omitted = merged.length - shown.length;
    ctx.logger.debug("template_fill applied", {
      template: args.template,
      applied: report.applied.length,
      warnings: report.warnings.length,
      softErrors: report.softErrors.length,
    });
    return ok({
      summary: summarizeFill({
        applied: report.applied,
        requested,
        warnings: report.warnings.length,
        softErrors: report.softErrors.length,
        omitted,
      }),
      documentRevision: result.value.revision,
      warnings: shown.length > 0 ? shown : undefined,
    });
  },
});
