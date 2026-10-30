// @studio/contracts — curated agent tool surface (PRODUCT_ARCHITECTURE.md §8.4).
//
// The model never sees `engine.execute` or the raw command registry; it sees
// these curated tools only. Each tool carries a Zod args schema, a read/write
// flag, a risk level and (by convention) a credit estimate in the plan.
//
// Doc note: §8.4 says "~12 curated tools" and then lists exactly 13 rows —
// all 13 are implemented (first, byte-compatible); the doc's "~" is the
// wiggle room. ROUND 12 ("Tool catalog v3", docs/research/round12-design.md)
// appends EIGHT tools after them: three writes (engine_commands, run_script,
// add_asset — auto-registered from write-tools.ts) and five client-executed
// reads/generative tools (list_commands, describe_command, web_search,
// render_audio, generate_image). Generative tools are kind "read": they
// mutate NO canvas state — audio renders to an asset, images come back as
// asset references, search hits return data.
//
// Write tools are PROPOSAL-ONLY (§8.4 rules 1-5, BUILD_PLAN §M5.1): each
// returns a proposed batch (write-tools.ts WRITE_TOOL_RESULT_SCHEMA), the
// client shows the plan/approval card, and on Apply the bridge calls
// `engine.batch` with `atomic: true` and label `"Agent: <summary>"`. No write
// tool ever executes anything by itself. The write-tool contracts
// (curated STRICT args, dunder-safe, layers BY NAME) live in ./write-tools.ts
// (M5-SEAMS seam) and are registered here as `studio.<id>` entries.
//
// Descriptions are model-facing: precise, no raw command ids (§8.4, §12.2 —
// "the model sees curated tools, never raw commands").

import { z } from "zod";

import type { PlanRisk } from "./edit-plan.js";
import { WRITE_TOOLS, isDunderKey, studioWriteToolId } from "./write-tools.js";

// ---------------------------------------------------------------------------
// Tool identity
// ---------------------------------------------------------------------------

export const TOOL_IDS = [
  "studio.get_context",
  "studio.list_layers",
  "studio.get_properties",
  "studio.plan_edit",
  "studio.render_preview",
  "studio.create_composition",
  "studio.create_text",
  "studio.set_properties",
  "studio.add_effect",
  "studio.set_keyframes",
  "studio.apply_preset",
  "studio.undo_run",
  "studio.save_version",
  // Round-12 "Tool catalog v3" (appended — the 13 spec tools above stay
  // byte-compatible, same order): writes first (they ride WRITE_TOOL_DEFS),
  // then the client-executed reads/generative tools.
  "studio.engine_commands",
  "studio.run_script",
  "studio.add_asset",
  "studio.list_commands",
  "studio.describe_command",
  "studio.web_search",
  "studio.render_audio",
  "studio.generate_image",
] as const satisfies readonly string[];

export type ToolId = (typeof TOOL_IDS)[number];

export const TOOL_ID_SCHEMA = z.enum(TOOL_IDS);

export type ToolKind = "read" | "write";

/** What a tool call yields: read tools return data; write tools return a
 * proposed `engine.batch` payload (never an execution). */
export type ToolReturns = "data" | "proposed-batch";

export interface ToolDefinition {
  readonly id: ToolId;
  readonly kind: ToolKind;
  readonly risk: PlanRisk;
  /** Model-facing description. No command ids, no engine internals. */
  readonly description: string;
  /** Args schema (Zod) the gateway validates before the tool runs. */
  readonly args: z.ZodType<unknown>;
  readonly returns: ToolReturns;
}

// ---------------------------------------------------------------------------
// Args schemas (§8.3 budgets: depth-2 layer trees, ≤12 properties, 1200 px frames)
// ---------------------------------------------------------------------------

/**
 * Dunder keys are never legitimate identifiers (M4-N F-1: a model-chosen
 * `__proto__` layer id could otherwise reach object-key accumulators —
 * rejected at the boundary, §12.2 defense-in-depth).
 */
const DUNDER_ID_SCHEMA = z
  .string()
  .min(1)
  .refine((v) => v !== "__proto__" && v !== "prototype" && v !== "constructor", {
    message: "dunder keys are not valid identifiers",
  });

const CONTEXT_BLOCK_SCHEMA = z.enum([
  "projectSummary",
  "activeComp",
  "selection",
  "playhead",
  "focusedPanel",
  "selectedProperties",
  "currentFrame",
  "recentCommands",
  "comments",
]);

// -- round-12 bounds ("Tool catalog v3"; design-doc tool args) ----------------

/** Catalog category filter bound (list_commands `category`). */
export const MAX_COMMAND_CATEGORY_LENGTH = 80;
/** describe_command id bound. */
export const MAX_COMMAND_ID_LENGTH = 200;
/** web_search query bound. */
export const MAX_SEARCH_QUERY_LENGTH = 400;
/** web_search result count bound (1..5, default 5). */
export const MAX_WEB_SEARCH_RESULTS = 5;
/** render_audio code bound (design doc: ≤ 20 000 chars — the sandbox cap). */
export const MAX_AUDIO_CODE_LENGTH = 20_000;
/** render_audio duration bounds, seconds (design doc: 0.1-60). */
export const MIN_AUDIO_DURATION_SECONDS = 0.1;
export const MAX_AUDIO_DURATION_SECONDS = 60;
/** generate_image prompt bound. */
export const MAX_IMAGE_PROMPT_LENGTH = 4000;
/** generate_image sizes (OpenAI-compatible images API shapes). */
export const IMAGE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
] as const satisfies readonly string[];
export const IMAGE_SIZE_SCHEMA = z.enum(IMAGE_SIZES);

// ---------------------------------------------------------------------------
// Catalog (§8.4 table, same order)
// ---------------------------------------------------------------------------

/**
 * The eight write tools (§8.4), registered from their curated contracts in
 * ./write-tools.ts (M5-SEAMS seam): STRICT dunder-safe args, layers BY NAME,
 * proposal-only results. `studioWriteToolId` keeps the ids in lockstep with
 * WRITE_TOOL_IDS so the two registries can never drift.
 */
const WRITE_TOOL_DEFS: readonly ToolDefinition[] = WRITE_TOOLS.map((tool) => ({
  id: studioWriteToolId(tool.id),
  kind: "write" as const,
  risk: tool.risk,
  description: tool.description,
  args: tool.inputSchema,
  returns: "proposed-batch" as const,
}));

export const TOOL_LIST: readonly ToolDefinition[] = [
  {
    id: "studio.get_context",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Inspect the current project: summary of compositions, layer counts, effects, assets, " +
      "the active composition, current selection, playhead time and which panel has focus. " +
      "Use this first when you need a compact picture of the project. Optionally pass `include` " +
      "to limit the returned context blocks.",
    args: z.object({
      include: z.array(CONTEXT_BLOCK_SCHEMA).max(9).optional(),
    }),
  },
  {
    id: "studio.list_layers",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "List the layer tree of a composition up to a given depth, with layer ids, names and " +
      "types. Omit `compId` to inspect the active composition.",
    args: z.object({
      compId: z.string().min(1).optional(),
      depth: z.number().int().min(1).max(8).default(2),
    }),
  },
  {
    id: "studio.get_properties",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Read property values (transform, opacity, text, effect parameters) for up to 12 layers " +
      "or property paths. Provide explicit `paths` to read specific properties only.",
    args: z.object({
      layerIds: z.array(DUNDER_ID_SCHEMA).min(1).max(12),
      paths: z.array(DUNDER_ID_SCHEMA).max(12).optional(),
    }),
  },
  {
    id: "studio.plan_edit",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Return a structured EditPlan for a goal WITHOUT changing the project: intent, summary, " +
      "risk, affected layers, estimated credits and ordered steps. Prefer this for any " +
      "multi-step change; never regenerate a whole composition when a targeted edit works.",
    args: z.object({
      goal: z.string().min(1).max(4000),
    }),
  },
  {
    id: "studio.render_preview",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Render a still frame of a composition at a given time (seconds) for visual inspection, " +
      "capped at 1200 px on the long side. Renders cost a small number of credits.",
    args: z.object({
      compId: z.string().min(1).optional(),
      timeSeconds: z.number().nonnegative().optional(),
      maxWidth: z.number().int().min(16).max(1200).default(1200),
    }),
  },
  ...WRITE_TOOL_DEFS,
  // -- round-12 reads + generative tools ("Tool catalog v3") -----------------
  // Client-executed like the M4 read tools; generative tools are kind "read"
  // because they mutate no canvas state (audio → asset, image → asset ref,
  // search → data). Write tools NEVER appear here — the server resolves them.
  {
    id: "studio.list_commands",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Browse the command catalog: the command ids available to the generic proposal tool, " +
      "grouped by category with one-line titles. Optionally pass `category` to narrow the list " +
      "to one group. Use this to discover the right command id, then fetch its full parameter " +
      "documentation before proposing it.",
    args: z.strictObject({
      category: z
        .string()
        .min(1)
        .max(MAX_COMMAND_CATEGORY_LENGTH)
        .refine((v) => !isDunderKey(v), { message: "dunder keys are not valid categories" })
        .optional(),
    }),
  },
  {
    id: "studio.describe_command",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Fetch the full parameter documentation for one command id from the catalog: the parameter " +
      "list with required/optional flags and type hints, a compact JSON shape, and whether the " +
      "command is allowed in proposals. Call this after discovering an id so the exact params " +
      "are right the first time.",
    args: z.strictObject({
      command: z
        .string()
        .min(1)
        .max(MAX_COMMAND_ID_LENGTH)
        .refine((v) => !isDunderKey(v), { message: "dunder keys are not valid ids" }),
    }),
  },
  {
    id: "studio.web_search",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Search the web for up-to-date information the project cannot answer — documentation, " +
      "examples, naming or troubleshooting facts. Pass a short `query` and optionally `maxResults` " +
      "(1-5, default 5). Each result is a title, URL and a short content excerpt, metered at one " +
      "credit per call; when search is unavailable the result says so.",
    args: z.strictObject({
      query: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
      maxResults: z
        .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
        .default(MAX_WEB_SEARCH_RESULTS),
    }),
  },
  {
    id: "studio.render_audio",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Generate an audio clip locally from JavaScript synthesis code (up to 20000 characters) " +
      "with a given `name` and an optional `duration` in seconds (0.1-60). The code renders " +
      "offline into a WAV asset; the result is the asset id, url and duration, ready to drop on " +
      "a layer. Nothing in the composition changes by itself.",
    args: z.strictObject({
      name: z
        .string()
        .min(1)
        .max(120)
        .refine((v) => !isDunderKey(v)),
      code: z.string().min(1).max(MAX_AUDIO_CODE_LENGTH),
      duration: z
        .number()
        .min(MIN_AUDIO_DURATION_SECONDS)
        .max(MAX_AUDIO_DURATION_SECONDS)
        .optional(),
    }),
  },
  {
    id: "studio.generate_image",
    kind: "read",
    risk: "low",
    returns: "data",
    description:
      "Generate an image from a text `prompt` (optionally sized 1024x1024, 1536x1024 or 1024x1536 " +
      "pixels). The result is an asset reference the next steps can place on a layer; when image " +
      "generation is not configured the result says so honestly. This changes nothing in the " +
      "composition by itself.",
    args: z.strictObject({
      prompt: z.string().min(1).max(MAX_IMAGE_PROMPT_LENGTH),
      size: IMAGE_SIZE_SCHEMA.optional(),
    }),
  },
];

export const TOOL_CATALOG: Readonly<Record<ToolId, ToolDefinition>> = Object.fromEntries(
  TOOL_LIST.map((tool) => [tool.id, tool]),
) as Readonly<Record<ToolId, ToolDefinition>>;

/** Look up a tool by id; `undefined` for unknown tools (never fall back). */
export function getTool(id: string): ToolDefinition | undefined {
  return TOOL_CATALOG[id as ToolId];
}

/** `true` for proposal-only tools (§8.4 rule 1: write tools return batches). */
export function isWriteTool(id: ToolId): boolean {
  return TOOL_CATALOG[id].kind === "write";
}

export function isReadTool(id: ToolId): boolean {
  return TOOL_CATALOG[id].kind === "read";
}
