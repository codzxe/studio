// @studio/tools — template_apply (spec §6 row 4; §7.4 apply contract).
//
// Instantiates a template onto the document through the engine-patches command
// `template.apply` (engine-patches/template_cmds/template_cmds.rs): a copy of the
// template's layers lands above the active layer — grouped when `asGroup` holds —
// and the §7.4 reply names the new group id plus the fresh layer id of every slot
// ({ id, version?, name?, asGroup? } → { document_revision, group_id, slots }).
//
// Pins this file obeys:
//   - §6: the model never sees raw command ids; results are §6.1 envelopes.
//   - The task pin asks for a structured summary { applied, documentRevision,
//     groupId, slots }; `ok()` carries `summary` as a capped string (kit.ts), so
//     the structure travels as its JSON encoding — one small line, slot keys
//     sorted for determinism, never an engine dump.
//   - Error codes come from the shared add-only catalog (§13.3) plus the tool
//     surface in types.ts. `unknown_template` and `missing_required_commands`
//     are NOT catalog members yet (W4-J flagged adopting them in @studio/config),
//     so the closest stable codes are used: `not_found` with candidates listed
//     (§6.1 pattern) for an unknown template, and `engine_unavailable` with the
//     engine-patch hint for an engine build without the template commands.

import { z } from "zod";
import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNINGS,
  MAX_WARNING_CHARS,
  TOOL_ERROR_CODE_SCHEMA,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import type {
  EngineCommandReport,
  EngineFailure,
  EngineLayerSummary,
  TemplateManifest,
  TemplateSummary,
  Tool,
  ToolContext,
  ToolErr,
  ToolErrorCode,
} from "../types.js";

// ---------------------------------------------------------------------------
// Engine command id (never surfaced to the model, §6)
// ---------------------------------------------------------------------------

/** The engine-patches command underneath (§7.4); absent from older engine builds. */
export const TEMPLATE_APPLY_COMMAND_ID = "template.apply";

// ---------------------------------------------------------------------------
// Arguments (§6.1 strict schema)
// ---------------------------------------------------------------------------

/**
 * Engine pin grammar (manifest.rs parse_pin): `id@version` where the id is
 * 1..64 chars and the version is a whole number from 1 up. Stricter than the
 * kit's `zTemplateRef` on purpose: its semver-ish tail ("@1.0.0") would reach the
 * engine just to fail with a BadParams error — §6.1 rejects at the boundary.
 */
export const TEMPLATE_PIN_RE = /^[a-z0-9][a-z0-9-]{0,63}@[1-9][0-9]{0,9}$/;

export interface TemplateApplyArgs {
  readonly template: string;
  readonly name?: string;
  readonly asGroup: boolean;
}

export const templateApplyArgsSchema = strictObject({
  template: z.string().min(3).max(80).regex(TEMPLATE_PIN_RE, {
    message:
      'must be "id@version" with a whole-number version from 1 up, e.g. "instagram-post@3" (§7)',
  }),
  // Blank names are rejected here; the engine would silently ignore them.
  name: cappedString(120, 1)
    .refine((value) => value.trim().length > 0, { message: "must not be blank" })
    .optional(),
  // §7.4 studio default: applied layers land as one group. The engine's own
  // default (loose layers) never applies — the tool always sends the flag.
  asGroup: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// The §7.4 apply reply, read through the minimal engine seam
// ---------------------------------------------------------------------------

/**
 * `template.apply`'s reply per the engine patch. The minimal engine seam types
 * `execute`'s value as `EngineCommandReport` (`revision` + free-text `message`),
 * so adapters either pass the reply object through or fold the payload into
 * `message` as JSON — both channels are accepted, ids normalised to the string
 * layer ids the rest of the tool surface uses (EngineLayerSummary.layerId).
 */
const APPLY_REPLY_SCHEMA = z
  .object({
    document_revision: z.number().int().nonnegative(),
    // Null when the layers landed loose (asGroup:false) or opened a new document.
    group_id: z.number().int().nonnegative().nullable(),
    // Slot name → fresh layer id; the engine serialises ids as JSON numbers.
    slots: z
      .record(z.string(), z.union([z.number(), z.string()]))
      .refine((slots) => Object.keys(slots).length <= 64, {
        message: "too many slots (the engine cap is 64)",
      }),
    // Slots whose layer the template document lacks (a template-authoring bug).
    missing: z.array(z.string()).default([]),
    // Canvas-mismatch warnings the engine already computed.
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

/** Normalised §7.4 reply: slot keys sorted, ids as strings. */
export interface TemplateApplyReport {
  readonly documentRevision: number;
  readonly groupId: string | null;
  readonly slots: Readonly<Record<string, string>>;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
}

function normalizeApplyReply(parsed: z.infer<typeof APPLY_REPLY_SCHEMA>): TemplateApplyReport {
  const slots: Record<string, string> = {};
  for (const slot of Object.keys(parsed.slots).sort()) {
    slots[slot] = String(parsed.slots[slot] ?? "");
  }
  return {
    documentRevision: parsed.document_revision,
    groupId: parsed.group_id === null ? null : String(parsed.group_id),
    slots,
    missing: [...parsed.missing],
    warnings: [...parsed.warnings],
  };
}

function tryParseJsonReply(message: string): TemplateApplyReport | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    // `message` is free text on this seam; non-JSON is the normal case.
    return undefined;
  }
  const parsed = APPLY_REPLY_SCHEMA.safeParse(raw);
  return parsed.success ? normalizeApplyReply(parsed.data) : undefined;
}

/** Reads the apply reply from either seam channel; undefined when neither carries it. */
export function parseApplyReport(report: EngineCommandReport): TemplateApplyReport | undefined {
  const direct = APPLY_REPLY_SCHEMA.safeParse(report);
  if (direct.success) {
    return normalizeApplyReply(direct.data);
  }
  if (typeof report.message === "string") {
    return tryParseJsonReply(report.message);
  }
  return undefined;
}

/** Reply-shaped fallback when the adapter dropped the payload: ids stay best-effort. */
function fallbackApplyReport(
  report: EngineCommandReport,
  manifest: TemplateManifest,
): TemplateApplyReport {
  const revision = Number.isInteger(report.revision) && report.revision >= 0 ? report.revision : 0;
  const layerMap = manifest.layerMap ?? {};
  const slots: Record<string, string> = {};
  for (const slot of Object.keys(layerMap).sort()) {
    slots[slot] = layerMap[slot] ?? "";
  }
  return { documentRevision: revision, groupId: null, slots, missing: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Engine failure mapping (§6.1 envelopes; codes are catalog-only)
// ---------------------------------------------------------------------------

/** Task pin: the hint for an engine build without the template commands. */
export const ENGINE_PATCH_HINT = "engine patch required (see engine-patches)";

/** Codes meaning "this build never learned the template commands" (§16.1 patches own them). */
const MISSING_TEMPLATE_COMMAND_CODES: ReadonlySet<string> = new Set([
  "unknown_command", // engine-client facade: the engine does not know the command id
  "missing_required_commands", // engine-client commands.ts: the registry check failed
]);

const MISSING_TEMPLATE_COMMANDS_RE =
  /unknown (?:tool|command|method|rpc)|missing[ _-]?required[ _-]?commands?/i;

/** The engine's own unknown-template texts (template_cmds.rs `resolve`) — catalog drift. */
const ENGINE_UNKNOWN_TEMPLATE_RE = /no template `|no version \d+ of template|has no versions/i;

/**
 * Engine-client facade codes (packages/engine-client/src/errors.ts) the shared
 * tool catalog does not carry, mapped to their nearest §13.3 stable code —
 * add-only discipline: nothing is invented here.
 */
const FACADE_CODE_FALLBACK: Readonly<Record<string, ToolErrorCode>> = {
  engine_command_failed: "internal_error",
  reply_timeout: "engine_timeout",
  call_aborted: "engine_timeout",
  frame_too_large: "internal_error",
  auth_rejected: "unauthorized",
  session_limit_reached: "engine_unavailable",
  path_outside_capability_root: "forbidden",
  plan_ceiling_exceeded: "plan_limit",
  connection_dropped_mid_call: "engine_crashed",
};

function isCatalogCode(code: string): code is ToolErrorCode {
  return TOOL_ERROR_CODE_SCHEMA.safeParse(code).success;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * Maps an engine-seam failure from `template.apply` onto a §6.1 envelope.
 * First the two context-specific cases: this tool only ever sends one command,
 * so an unknown-command failure means the engine build lacks the template
 * commands (older builds ship without them — engine-patches adds them) and is
 * reported with the patch hint, never retryable; the engine's own
 * unknown-template errors become `not_found` with the engine's candidate list
 * verbatim. Everything else keeps its catalog code (or falls to the nearest
 * stable one) with the engine's message preserved.
 */
export function mapApplyEngineFailure(failure: EngineFailure): ToolErr {
  const code = typeof failure.code === "string" ? failure.code : "";
  const text = `${failure.message} ${failure.hint ?? ""}`;
  if (MISSING_TEMPLATE_COMMAND_CODES.has(code) || MISSING_TEMPLATE_COMMANDS_RE.test(text)) {
    return err("engine_unavailable", "This engine build does not implement the template commands", {
      hint: ENGINE_PATCH_HINT,
      retryable: false,
    });
  }
  if (ENGINE_UNKNOWN_TEMPLATE_RE.test(failure.message)) {
    return err("not_found", clip(failure.message.trim(), MAX_ERROR_MESSAGE_CHARS), {
      hint: "Pick a pin from template_list; the engine and workspace catalogs may be out of sync",
      retryable: false,
    });
  }
  const message =
    clip(failure.message.trim(), MAX_ERROR_MESSAGE_CHARS) ||
    "The engine rejected the template apply";
  const hint =
    failure.hint === undefined || failure.hint.length === 0
      ? undefined
      : clip(failure.hint, MAX_HINT_CHARS);
  const mapped = isCatalogCode(code) ? code : FACADE_CODE_FALLBACK[code] ?? "internal_error";
  return err(mapped, message, { hint, retryable: failure.retryable });
}

// ---------------------------------------------------------------------------
// Catalog + layer-tree reads around the apply
// ---------------------------------------------------------------------------

/** §6.1: unknown id → candidates listed so the model corrects in one hop. */
function unknownTemplateErr(pin: string, summaries: readonly TemplateSummary[]): ToolErr {
  const candidates = summaries
    .map((summary) => `${summary.id}@${summary.version}`)
    .sort()
    .slice(0, 10);
  const extra =
    summaries.length > candidates.length ? ` (+${summaries.length - candidates.length} more)` : "";
  const hint =
    candidates.length === 0
      ? "The workspace catalog lists no templates yet"
      : `Available templates: ${candidates.join(", ")}${extra}`;
  return err(
    "not_found",
    `Unknown template "${clip(pin, 80)}"; it is not in the workspace catalog`,
    { hint: clip(hint, MAX_HINT_CHARS), retryable: false },
  );
}

/** Best-effort catalog listing: it enriches errors and warnings, never blocks them. */
async function safeListTemplates(ctx: ToolContext): Promise<readonly TemplateSummary[]> {
  try {
    return await ctx.templates.list();
  } catch {
    ctx.logger.debug("template_apply: template listing unavailable; continuing without it");
    return [];
  }
}

/** The name the engine will give the new group (§7.4): the requested name, else the
 * manifest's display name — mirrored on this seam by the catalog summary's `title`.
 * Undefined means the repeat check cannot name-match and is skipped. */
function groupLabelFor(
  args: TemplateApplyArgs,
  manifest: TemplateManifest,
  summaries: readonly TemplateSummary[],
): string | undefined {
  if (args.name !== undefined) {
    return args.name;
  }
  return summaries.find(
    (summary) => summary.id === manifest.id && summary.version === manifest.version,
  )?.title;
}

/** Vendor kind for a group layer ("Group" — doc crate kind_name). */
function isGroupLayer(layer: EngineLayerSummary): boolean {
  return layer.kind.trim().toLowerCase() === "group";
}

/**
 * Engine semantics: every apply lands a NEW group (a fresh copy, never a merge),
 * so a same-named group already in the tree means this template was applied
 * before. Best-effort: the pre-apply layer read is cached per revision (§6.3),
 * and a failed read skips the check rather than blocking the apply.
 */
async function detectPriorApply(ctx: ToolContext, label: string | undefined): Promise<boolean> {
  if (label === undefined) {
    return false;
  }
  const layers = await ctx.engine.listLayers();
  if (!layers.ok) {
    ctx.logger.debug("template_apply: skipping the repeat check; the layer read failed", {
      code: layers.code,
    });
    return false;
  }
  return layers.value.some((layer) => isGroupLayer(layer) && layer.name === label);
}

// ---------------------------------------------------------------------------
// Result assembly (§6.1 compact replies)
// ---------------------------------------------------------------------------

/**
 * The task pin's structured summary { applied, documentRevision, groupId, slots }
 * as one JSON line; if it ever grew past the §6.1 summary cap the slot map
 * degrades to a sentence rather than an engine dump.
 */
function buildApplySummary(template: string, report: TemplateApplyReport): string {
  const payload = JSON.stringify({
    applied: template,
    documentRevision: report.documentRevision,
    groupId: report.groupId,
    slots: report.slots,
  });
  if (payload.length <= MAX_SUMMARY_CHARS) {
    return payload;
  }
  return `Applied ${template} at document revision ${report.documentRevision}; the slot map was` +
    " omitted to respect the reply size cap.";
}

function buildWarnings(
  report: TemplateApplyReport,
  repeated: boolean,
  slotMapFromManifest: boolean,
): readonly string[] {
  const warnings: string[] = [];
  for (const warning of report.warnings) {
    const text = clip(warning.trim(), MAX_WARNING_CHARS);
    if (text.length > 0) {
      warnings.push(text);
    }
  }
  if (report.missing.length > 0) {
    warnings.push(
      clip(
        `the template document has no layer for slots: ${report.missing.join(", ")}`,
        MAX_WARNING_CHARS,
      ),
    );
  }
  if (repeated) {
    warnings.push("template applied more than once");
  }
  if (slotMapFromManifest) {
    warnings.push("engine reply omitted the slot map; slot addresses are best-effort");
  }
  return warnings.slice(0, MAX_WARNINGS);
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const templateApplyTool: Tool<TemplateApplyArgs> = defineTool({
  name: TOOLS.template_apply,
  description:
    "Instantiate a template onto the document: its layers land as one named group and every" +
    " slot maps to a fresh layer id.",
  args: templateApplyArgsSchema,
  async run(ctx, args, signal) {
    // 1. Verify the manifest before any mutation. `ctx.templates.get` is this
    //    seam's template.inspect twin (§6.2); unknown pins fail with candidates.
    const manifest = await ctx.templates.get(args.template);
    if (manifest === undefined) {
      return unknownTemplateErr(args.template, await safeListTemplates(ctx));
    }

    // 2. Repeat detection — engine semantics give every apply a new group, so a
    //    same-named group already in the tree is the "applied more than once" case.
    const summaries = await safeListTemplates(ctx);
    const repeated = await detectPriorApply(ctx, groupLabelFor(args, manifest, summaries));

    // 3. The apply itself — §7.4 params { id, name?, asGroup? }; the engine splits
    //    the id@version pin itself (the version is always explicit per §7.4), and
    //    the §3.4 deadline travels through the engine seam's signal option.
    const params: Record<string, unknown> = { id: args.template, asGroup: args.asGroup };
    if (args.name !== undefined) {
      params.name = args.name;
    }
    const outcome = await ctx.engine.execute(
      { id: TEMPLATE_APPLY_COMMAND_ID, params },
      { signal },
    );
    if (!outcome.ok) {
      return mapApplyEngineFailure(outcome);
    }

    // 4. Fold the reply into the §6.1 envelope; a dropped payload falls back to
    //    the manifest layer map (best-effort slot addresses, warned).
    const parsed = parseApplyReport(outcome.value);
    const report = parsed ?? fallbackApplyReport(outcome.value, manifest);
    const warnings = buildWarnings(report, repeated, parsed === undefined);
    return ok({
      summary: buildApplySummary(args.template, report),
      documentRevision: report.documentRevision,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  },
});
