// @studio/agent — §5.7 tool-call gate. Owner: W6-K (src/guards/**).
//
// Spec anchors:
//   §5.7  "Treat every model-proposed tool name and argument as untrusted
//          input: validate against the schema, reject unknown tools, cap
//          string lengths and array sizes, and cap total mutating commands
//          per run." Tools are an allowlist — no shell, no network fetch, no
//          arbitrary file read, no code execution.
//   §15.3 "Engine commands are the only side effects, and they are allowlisted
//          per plan and per tool. Reject model tool calls containing absolute
//          paths, URLs in file parameters, or ids outside the workspace; cap
//          all strings; strip control characters."
//   §5.2   the per-tier "Tool calls" column is the mutating-command cap used
//          here (quick 6, standard 12, complex 24, image tiers 1).
//   §6/§6.1 names come from the registry; raw args are parsed with the kit's
//          `parseToolArgs` (strict Zod schemas) at the boundary.
//
// Executor integration (executor.ts is owned by W6-B — seam contract only):
//   const gate = new ToolCallGate({
//     tools,                    // the executor's dispatch map (§6 registry)
//     manifest,                 // the run-start manifest (fixed at run start)
//     mutatingCommandCap: mutatingCommandCapFromTier(tier), // §5.2
//   });
//   const verdict = gate.validateModelToolCall({ name: call.name, args: call.args });
//   if (!verdict.ok) { feed verdict.rejection back to the model; log a §5.5
//                      deviation; do NOT execute and do NOT charge §5.2 }
//   else              { execute verdict.tool with verdict.args (already parsed) }
//
// Budget semantics: a SUCCESSFUL validation of a mutating tool RESERVES one
// mutating-command slot immediately (validation is the budget checkpoint).
// The reservation never unwinds — a command that fails mid-flight may still
// have mutated the engine session, so the count is a conservative §5.7 cap,
// not a §5.2 usage meter (the BudgetTracker owns that).

import { type RunTierId, resolveTierConfig } from "@studio/config";
import {
  type AnyTool,
  MAX_ARG_ARRAY_ITEMS,
  MAX_ARG_STRING_CHARS,
  type ToolErr,
  type ToolListing,
  err as buildToolErr,
  isToolName,
  parseToolArgs,
} from "@studio/tools";
import { z } from "zod";

// ---------------------------------------------------------------------------
// §5.7 argument caps (gate defaults; per-tool schemas stay authoritative)
// ---------------------------------------------------------------------------

/** Strings ≤ 2000 chars — the kit's §6.2 ceiling, as the gate default. */
export const GATE_MAX_ARG_STRING_CHARS = MAX_ARG_STRING_CHARS;
/** Arrays ≤ 50 items (§5.7 gate default; kit schemas may be tighter). */
export const GATE_MAX_ARG_ARRAY_ITEMS = 50;
/** Object/record arguments ≤ 50 entries (§5.7 "array sizes" family). */
export const GATE_MAX_ARG_RECORD_ENTRIES = 50;
/** Nesting ≤ 8 levels — model JSON args are shallow; deeper is hostile. */
export const GATE_MAX_ARG_DEPTH = 8;

export interface GateArgCaps {
  readonly maxStringChars: number;
  readonly maxArrayItems: number;
  readonly maxRecordEntries: number;
  readonly maxDepth: number;
}

/** Resolved (frozen) caps; defaults above, overridable via options.caps. */
export const GATE_DEFAULT_ARG_CAPS: GateArgCaps = Object.freeze({
  maxStringChars: GATE_MAX_ARG_STRING_CHARS,
  maxArrayItems: GATE_MAX_ARG_ARRAY_ITEMS,
  maxRecordEntries: GATE_MAX_ARG_RECORD_ENTRIES,
  maxDepth: GATE_MAX_ARG_DEPTH,
});

const GATE_ARG_CAPS_SCHEMA = z
  .strictObject({
    maxStringChars: z.number().int().min(1).max(MAX_ARG_STRING_CHARS),
    maxArrayItems: z.number().int().min(1).max(MAX_ARG_ARRAY_ITEMS),
    maxRecordEntries: z.number().int().min(1).max(MAX_ARG_ARRAY_ITEMS),
    maxDepth: z.number().int().min(1).max(32),
  })
  .partial();

const GATE_MUTATING_COMMAND_CAP_SCHEMA = z.number().int().min(0);

// ---------------------------------------------------------------------------
// The mutating tool set (§6 table: which rows issue engine side effects)
// ---------------------------------------------------------------------------

/**
 * The §6 rows whose engine commands mutate the document or run outputs —
 * everything the "cap total mutating commands per run" (§5.7) budget must
 * count. Read-only rows (workspace_snapshot, template_list/inspect,
 * asset_search, component_list, render_preview, validate_document,
 * vision_critique, ask_user, brief_to_plan) never touch it. Add-only.
 */
export const DEFAULT_MUTATING_TOOLS: readonly string[] = Object.freeze([
  "asset_place",
  "component_place",
  "component_set_vars",
  "export_document",
  "image_generate",
  "layer_ops",
  "layout_apply",
  "style_apply",
  "template_apply",
  "template_fill",
  "text_set",
  "variant_create",
]);

/** §5.2 "Tool calls" column of the tier table → the run's mutating cap. */
export function mutatingCommandCapFromTier(tier: RunTierId): number {
  return resolveTierConfig(tier).toolCallCap;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type GateRejectionKind = "unknown_tool" | "args_cap" | "invalid_args" | "mutating_budget";

/** One model-proposed call; every field is UNTRUSTED (§5.7). */
export interface ModelToolCall {
  readonly name: unknown;
  readonly args: unknown;
}

export type ToolGateVerdict =
  | {
      readonly ok: true;
      readonly tool: AnyTool;
      /** The parseToolArgs-parsed arguments — execute with THESE, not the raw. */
      readonly args: unknown;
      /** True when the tool is in the mutating set and a slot was reserved. */
      readonly mutating: boolean;
    }
  | {
      readonly ok: false;
      readonly kind: GateRejectionKind;
      /** §6.1 failure envelope, ready to feed back to the model. */
      readonly rejection: ToolErr;
      /** Present for unknown_tool: the allowlist the model was offered. */
      readonly allowedTools?: readonly string[];
    };

// ---------------------------------------------------------------------------
// Raw-args structural scan (cheap §5.7 caps before the schema parse)
// ---------------------------------------------------------------------------

type ArgCapProblem =
  | "string_too_long"
  | "array_too_long"
  | "record_too_many_entries"
  | "too_deep"
  | "unsupported_value";

interface ArgCapFinding {
  readonly path: string;
  readonly problem: ArgCapProblem;
  readonly limit: number | null;
}

function describeFinding(finding: ArgCapFinding): string {
  switch (finding.problem) {
    case "string_too_long":
      return `a string longer than ${finding.limit} chars`;
    case "array_too_long":
      return `an array with more than ${finding.limit} items`;
    case "record_too_many_entries":
      return `an object with more than ${finding.limit} entries`;
    case "too_deep":
      return `nesting deeper than ${finding.limit} levels`;
    case "unsupported_value":
      return "a value that is not JSON (function, symbol, undefined, bigint or non-finite number)";
  }
}

const ROOT_PATH = "(root)";

function joinPath(parent: string, segment: string): string {
  return parent === ROOT_PATH ? segment : `${parent}.${segment}`;
}

/**
 * Walks raw model args and returns the FIRST §5.7 cap violation: strings,
 * array sizes, record entry counts, depth, JSON-ness. Values are never
 * collected, echoed or logged — only the path and the cap (§6.1/§15.3).
 */
function scanArgCaps(
  value: unknown,
  caps: GateArgCaps,
  path: string,
  depth: number,
): ArgCapFinding | null {
  if (depth > caps.maxDepth) {
    return { path, problem: "too_deep", limit: caps.maxDepth };
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.length > caps.maxStringChars
      ? { path, problem: "string_too_long", limit: caps.maxStringChars }
      : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : { path, problem: "unsupported_value", limit: null };
  }
  if (typeof value === "boolean") {
    return null;
  }
  if (typeof value !== "object") {
    return { path, problem: "unsupported_value", limit: null };
  }
  if (Array.isArray(value)) {
    if (value.length > caps.maxArrayItems) {
      return { path, problem: "array_too_long", limit: caps.maxArrayItems };
    }
    let index = 0;
    for (const item of value) {
      const childPath = path === ROOT_PATH ? `[${index}]` : `${path}[${index}]`;
      const finding = scanArgCaps(item, caps, childPath, depth + 1);
      if (finding !== null) {
        return finding;
      }
      index += 1;
    }
    return null;
  }
  // Plain objects only — model args arrive as JSON (§5.7); class instances,
  // Map/Set/Date shapes are rejected as non-JSON instead of trusted.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { path, problem: "unsupported_value", limit: null };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const entries = Object.entries(record);
  if (entries.length > caps.maxRecordEntries) {
    return { path, problem: "record_too_many_entries", limit: caps.maxRecordEntries };
  }
  for (const [key, child] of entries) {
    const finding = scanArgCaps(child, caps, joinPath(path, key), depth + 1);
    if (finding !== null) {
      return finding;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ToolCallGate
// ---------------------------------------------------------------------------

export interface ToolGateOptions {
  /** Dispatch map (name → tool); the executor's registry (§6). */
  readonly tools: Readonly<Record<string, AnyTool>>;
  /**
   * The model-visible manifest, FIXED AT RUN START (§5.4/§6.1): tool names
   * outside it are rejected even if the registry could dispatch them — the
   * model may not invent new tools mid-run (§5.7).
   */
  readonly manifest: readonly ToolListing[];
  /** Total mutating commands allowed this run (§5.7) — tier tool cap (§5.2). */
  readonly mutatingCommandCap: number;
  /** Overrides the §5.7 arg caps (strings 2000 / arrays 50 / records 50 / depth 8). */
  readonly caps?: Partial<GateArgCaps>;
  /** The mutating name set; defaults to DEFAULT_MUTATING_TOOLS (§6 table). */
  readonly mutatingTools?: readonly string[];
}

export class ToolCallGate {
  private readonly tools: Readonly<Record<string, AnyTool>>;
  private readonly manifestNames: readonly string[];
  private readonly allowedSorted: readonly string[];
  private readonly mutating: ReadonlySet<string>;
  private readonly caps: GateArgCaps;
  private readonly mutatingCommandCap: number;
  private usedMutatingCommands = 0;

  constructor(options: ToolGateOptions) {
    if (options == null || typeof options !== "object") {
      throw new Error("[agent/guards/tool-gate] options are required");
    }
    const tools = options.tools;
    if (
      tools == null ||
      typeof tools !== "object" ||
      Object.keys(tools).length === 0 ||
      Object.entries(tools).some(
        ([name, tool]) =>
          !isToolName(name) || tool?.args == null || typeof tool?.run !== "function",
      )
    ) {
      throw new Error(
        "[agent/guards/tool-gate] options.tools must be a non-empty name→tool map (§6 registry)",
      );
    }
    if (
      !Array.isArray(options.manifest) ||
      options.manifest.length === 0 ||
      options.manifest.some(
        (tool) => typeof tool?.name !== "string" || typeof tool?.description !== "string",
      )
    ) {
      throw new Error(
        "[agent/guards/tool-gate] options.manifest must be non-empty name+description listings (§6.1)",
      );
    }
    const manifestNames = options.manifest.map((tool) => tool.name);
    if (manifestNames.some((name) => !isToolName(name))) {
      throw new Error("[agent/guards/tool-gate] manifest names must be snake_case (§6)");
    }
    const missingFromRegistry = manifestNames.filter((name) => !Object.hasOwn(tools, name));
    if (missingFromRegistry.length > 0) {
      throw new Error(
        `[agent/guards/tool-gate] manifest tools missing from the registry (wiring bug): ${missingFromRegistry.join(", ")}`,
      );
    }
    const parsedCap = GATE_MUTATING_COMMAND_CAP_SCHEMA.safeParse(options.mutatingCommandCap);
    if (!parsedCap.success) {
      throw new Error(
        "[agent/guards/tool-gate] mutatingCommandCap must be a non-negative integer (§5.2 tier tool cap)",
      );
    }
    const parsedCaps = GATE_ARG_CAPS_SCHEMA.safeParse(options.caps ?? {});
    if (!parsedCaps.success) {
      throw new Error("[agent/guards/tool-gate] caps must be integers within the §5.7 ceilings");
    }
    const mutatingList = options.mutatingTools ?? DEFAULT_MUTATING_TOOLS;
    if (
      !Array.isArray(mutatingList) ||
      mutatingList.some((name) => typeof name !== "string" || !isToolName(name))
    ) {
      throw new Error(
        "[agent/guards/tool-gate] mutatingTools must be an array of snake_case tool names (§6)",
      );
    }

    this.tools = Object.freeze({ ...tools });
    this.manifestNames = Object.freeze([...manifestNames]);
    this.allowedSorted = Object.freeze([...manifestNames].sort());
    this.mutating = new Set(mutatingList);
    // Partial spread over a full object widens to `| undefined`; resolve each
    // cap explicitly so the frozen shape is exactly GateArgCaps.
    const caps = parsedCaps.data;
    this.caps = Object.freeze({
      maxStringChars: caps.maxStringChars ?? GATE_DEFAULT_ARG_CAPS.maxStringChars,
      maxArrayItems: caps.maxArrayItems ?? GATE_DEFAULT_ARG_CAPS.maxArrayItems,
      maxRecordEntries: caps.maxRecordEntries ?? GATE_DEFAULT_ARG_CAPS.maxRecordEntries,
      maxDepth: caps.maxDepth ?? GATE_DEFAULT_ARG_CAPS.maxDepth,
    });
    this.mutatingCommandCap = parsedCap.data;
  }

  /** The allowlist the model was offered — the manifest, frozen at run start. */
  allowedToolNames(): readonly string[] {
    return this.allowedSorted;
  }

  isMutating(name: string): boolean {
    return this.mutating.has(name);
  }

  mutatingCommandsUsed(): number {
    return this.usedMutatingCommands;
  }

  mutatingCommandsRemaining(): number {
    return Math.max(0, this.mutatingCommandCap - this.usedMutatingCommands);
  }

  /**
   * Validates one untrusted model-proposed tool call (§5.7). Order:
   *   1. name ∈ manifest (fixed at run start) and ∈ registry — else unknown_tool
   *      with the allowlist attached;
   *   2. raw args pass the §5.7 structural caps (strings 2000 / arrays 50 /
   *      records 50 / depth 8 / JSON-only) — else an args_cap rejection;
   *   3. args parse via the kit's parseToolArgs against the tool's strict
   *      schema — else the invalid_args envelope passes through;
   *   4. mutating tools must fit the run's mutating-command budget — else a
   *      budget_exceeded rejection. A passing mutating call RESERVES its slot.
   *
   * Rejections are §6.1 ToolErr values (never throws); they carry no argument
   * values, stack traces, paths or internal ids.
   */
  validateModelToolCall(call: ModelToolCall): ToolGateVerdict {
    const rawName = typeof call?.name === "string" ? call.name : "";
    const rawArgs = call?.args;

    // 1. §5.7 unknown-tool gate: the manifest was fixed at run start, so a
    //    name outside it is rejected even when the registry could dispatch it.
    if (rawName === "" || !this.manifestNames.includes(rawName)) {
      return this.rejectUnknown(rawName, this.allowedSorted);
    }
    const tool = Object.hasOwn(this.tools, rawName) ? this.tools[rawName] : undefined;
    if (tool === undefined) {
      // Unreachable post-constructor (manifest ⊆ registry); kept defensive.
      return this.rejectUnknown(rawName, Object.keys(this.tools).sort());
    }

    // 2. §5.7 structural caps — cheap scan before the schema parse. Tool
    //    schemas stay the authoritative per-argument contract (§6.1); the gate
    //    is the coarse untrusted-input backstop against oversized payloads.
    const finding = scanArgCaps(rawArgs, this.caps, ROOT_PATH, 1);
    if (finding !== null) {
      return {
        ok: false,
        kind: "args_cap",
        rejection: buildToolErr(
          "invalid_args",
          `Arguments exceed the §5.7 caps at "${finding.path}": ${describeFinding(finding)}`,
          {
            hint: "Resend the call with smaller JSON arguments; values are never echoed back.",
            retryable: false,
          },
        ),
      };
    }

    // 3. §6.1 schema boundary: the kit parses raw args against the tool's
    //    strict schema and builds an actionable invalid_args envelope.
    const parsed = parseToolArgs(tool, rawArgs);
    if (!parsed.ok) {
      return { ok: false, kind: "invalid_args", rejection: parsed };
    }

    // 4. §5.7 mutating-command budget: validation is the checkpoint, and the
    //    reservation never unwinds (see the file header).
    const mutating = this.mutating.has(rawName);
    if (mutating) {
      if (this.usedMutatingCommands >= this.mutatingCommandCap) {
        return {
          ok: false,
          kind: "mutating_budget",
          rejection: buildToolErr(
            "budget_exceeded",
            `The run's mutating command budget is exhausted (${this.usedMutatingCommands} of ${this.mutatingCommandCap} used, §5.2/§5.7)`,
            {
              hint: "No further mutating tool calls are allowed in this run; continue with read-only tools or finish.",
              retryable: false,
            },
          ),
        };
      }
      this.usedMutatingCommands += 1;
    }

    return Object.freeze({ ok: true, tool, args: parsed.args, mutating });
  }

  private rejectUnknown(rawName: string, allowed: readonly string[]): ToolGateVerdict {
    return {
      ok: false,
      kind: "unknown_tool",
      rejection: buildToolErr("unknown_tool", `Unknown tool "${truncate(rawName, 64)}"`, {
        hint: `Available tools: ${allowed.join(", ")}`,
        retryable: false,
      }),
      allowedTools: Object.freeze([...allowed]),
    };
  }
}

/** Small echo-guard for model-proposed strings (§6.1: never echo walls of text). */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
