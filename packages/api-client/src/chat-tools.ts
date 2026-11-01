// @studio/api-client — agent chat-tool validation (M4-SEAMS.md seam 6).
//
// The ONE runtime entry for the curated tool surface outside the gateway: the
// browser's client tool executor (apps/web/src/lib/chat/tool-executor.ts)
// validates model-issued tool calls HERE, because apps/web may only
// `import type` from @studio/contracts (docs/AGENTS.md hard rule 5 — the model
// sees curated tools; runtime Zod validation lives in this package, the
// wire-validation layer that already runtime-imports contracts).
//
// Everything here is pure + synchronous: lookup + Zod safeParse against the
// TOOL_LIST schemas from contracts (PRODUCT_ARCHITECTURE.md §8.4 — never
// hand-rolled copies).

import {
  type EditPlan,
  type PlanIntent,
  TOOL_LIST,
  TURN_CANVAS_SCHEMA,
  type ToolDefinition,
  type TurnCanvas,
  type TurnToolCall,
  isAgentCommand,
  mergeEditPlans,
} from "@studio/contracts";
import type { ZodError } from "zod";

// F-6 (M5-R): the compiled-batch allowlist gate rides the same seam. The
// client apply engine (apps/web/src/lib/chat/apply.ts) checks every
// `engine.batch` step id against the SAME curated registry the gateway plan
// compiler compiled with, BEFORE the batch reaches the editor — re-exported
// here so no apps/web product module needs a runtime contracts import.
export { isAgentCommand };

// Round 12 (TURN WIRE CONTRACT): the client-driven loop merges accumulated
// write-tool proposals into ONE EditPlan (contracts `mergeEditPlans` — pure).
// Re-exported on the sanctioned seam so the browser's chat-controller never
// runtime-imports @studio/contracts (apps/web hard rule 5).
export { mergeEditPlans };

/**
 * The 4 editor-read tools that execute CLIENT-side against the live bridge
 * (M4-SEAMS.md architecture table). `studio.plan_edit` is SERVER-side (the
 * runner's structured-output call); write tools never register in M4.
 */
export const CLIENT_TOOL_IDS = [
  "studio.get_context",
  "studio.list_layers",
  "studio.get_properties",
  "studio.render_preview",
] as const satisfies readonly string[];

export type ClientToolId = (typeof CLIENT_TOOL_IDS)[number];

const CLIENT_TOOL_ID_SET: ReadonlySet<string> = new Set<string>(CLIENT_TOOL_IDS);

/** `true` when `name` is one of the 13 curated §8.4 tools. */
export function isKnownTool(name: string): boolean {
  return TOOL_LIST.some((tool) => tool.id === name);
}

/** The §8.4 definition for `name`, or `null` for unknown tools (never falls back). */
export function toolDefinition(name: string): ToolDefinition | null {
  return TOOL_LIST.find((tool) => tool.id === name) ?? null;
}

/** `true` for the 4 client-side editor-read tools (the ones this executor runs). */
export function isClientTool(name: string): boolean {
  return CLIENT_TOOL_ID_SET.has(name);
}

/**
 * `true` for proposal-only write tools (§8.4 rule 1: write tools return
 * proposed batches, never executions). M4 registers none; executors assert
 * defensively (M4.6). Unknown tools are not write tools.
 */
export function isWriteTool(name: string): boolean {
  const definition = toolDefinition(name);
  return definition !== null && definition.kind === "write";
}

/** Result of validating tool args against the tool's contracts Zod schema. */
export type ToolArgsValidation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/**
 * Runtime arg validation for a tool call. Zod `.safeParse` — the parsed value
 * carries schema defaults (e.g. `studio.list_layers` gains `depth: 2`,
 * `studio.render_preview` gains `maxWidth: 1200`); unknown object keys are
 * stripped by the (non-strict) schemas. On failure `error` is the first
 * Zod issue as a `<path>: <message>` string — short and repairable by the
 * model (the runner gives it one repair turn).
 */
export function validateToolArgs(name: string, args: unknown): ToolArgsValidation {
  const definition = toolDefinition(name);
  if (definition === null) {
    return { ok: false, error: `Unknown tool: ${JSON.stringify(name)}` };
  }
  const parsed = definition.args.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

/** First Zod issue as one deterministic, model-readable line. */
function firstIssueMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "Invalid tool arguments.";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

// ---------------------------------------------------------------------------
// Round 12 — client-driven loop proposal merging (TURN WIRE CONTRACT)
// ---------------------------------------------------------------------------
//
// The browser's chat-controller (apps/web/src/lib/chat/chat-controller.ts)
// accumulates one proposal carrier per SUCCESSFUL write-tool call, then at
// run end merges them into ONE EditPlan and POSTs `/v1/runs/:id/plan` — the
// server re-validates + re-compiles authoritatively and stamps the §7.3
// auto-apply verdict. Carrier reconstruction lives HERE (not in web) because
// it reads wire shapes: the WRITE_TOOL_RESULT `proposedBatch` (the server
// carrier's step batch, verbatim) and the TURN_TOOL_CALL `proposal.compiled`.
//
// PARITY PIN: the intent map below mirrors the gateway's WRITE_TOOL_INTENTS
// (services/gateway/src/litellm/turn-engine.ts) EXACTLY — a drift would flip
// the server's §7.3 intent gate (auto-apply rule 5) for merged plans. Pinned
// by tests in this package; keep both maps in lockstep.

/** Plan intent per write tool (§8.6 vocabulary) — gateway WRITE_TOOL_INTENTS parity. */
export const WRITE_TOOL_PLAN_INTENTS: Readonly<Record<string, PlanIntent>> = {
  "studio.create_composition": "create",
  "studio.create_text": "create",
  "studio.create_solid": "create",
  "studio.create_camera": "create",
  "studio.set_properties": "edit",
  "studio.add_effect": "style",
  "studio.set_keyframes": "animate",
  "studio.apply_preset": "animate",
  "studio.engine_commands": "edit",
  "studio.run_script": "animate",
  "studio.add_asset": "create",
  "studio.undo_run": "organize",
  "studio.save_version": "organize",
};

/** The server carrier's batch-label prefix (turn-engine writeToolCarrierPlan). */
const CARRIER_LABEL_PREFIX = "Agent: ";

/**
 * `true` when the call's tool result is the SUCCESS arm (WRITE_TOOL_RESULT's
 * `proposedBatch` shape) — a validation/compile failure answers with the
 * `{ error, message }` shape instead and its carrier must NOT enter the
 * merged plan (the round-10 rescue merged SUCCESSFUL carriers only; a failed
 * carrier would poison the whole re-compile server-side).
 */
function isProposedBatchResult(resultForModel: unknown): resultForModel is {
  proposedBatch: { label: string; steps: readonly unknown[] };
} {
  if (typeof resultForModel !== "object" || resultForModel === null) return false;
  const record = resultForModel as Record<string, unknown>;
  const batch = record.proposedBatch;
  if (typeof batch !== "object" || batch === null) return false;
  const batchRecord = batch as Record<string, unknown>;
  return (
    typeof batchRecord.label === "string" &&
    batchRecord.label.length > 0 &&
    Array.isArray(batchRecord.steps) &&
    batchRecord.steps.length > 0
  );
}

/** The compact canvas snapshot's runtime gate (web never runs contracts Zod). */
export function isValidTurnCanvas(value: unknown): value is TurnCanvas {
  return TURN_CANVAS_SCHEMA.safeParse(value).success;
}

/**
 * Rebuilds the one-step EditPlan CARRIER for one SUCCESSFUL write-tool call
 * (pure; total — `null` for read/generative tools, failed proposals and
 * malformed payloads, never a throw). The `batch` is the server carrier's
 * step batch verbatim (`resultForModel.proposedBatch`, the model's own view);
 * `risk`/`estimatedCredits` are the SERVER-recomputed values off
 * `proposal.compiled` (D-21 — never the model's self-declared numbers).
 */
export function writeToolCarrierPlan(
  call: Readonly<Pick<TurnToolCall, "tool" | "args" | "resultForModel">> & {
    readonly proposal?: TurnToolCall["proposal"];
  },
): EditPlan | null {
  if (!isWriteTool(call.tool)) return null;
  const proposal = call.proposal;
  if (proposal === undefined || proposal === null) return null;
  if (!isProposedBatchResult(call.resultForModel)) return null;
  const batch = call.resultForModel.proposedBatch;

  // The server labels carrier batches "Agent: <summary>" — recover its
  // summary instead of re-deriving display text client-side.
  const label = typeof batch.label === "string" ? batch.label : "";
  const summary = label.startsWith(CARRIER_LABEL_PREFIX)
    ? label.slice(CARRIER_LABEL_PREFIX.length)
    : label;

  const compiledBatch = proposal.compiled.batch as { label?: unknown };
  return {
    intent: WRITE_TOOL_PLAN_INTENTS[call.tool] ?? "edit",
    summary: summary === "" ? String(compiledBatch.label ?? call.tool) : summary,
    risk: proposal.compiled.risk,
    requiresApproval: false, // the server re-judges; never trust client values
    affectedLayers: [],
    estimatedCredits:
      typeof proposal.compiled.estimatedCredits === "number" &&
      proposal.compiled.estimatedCredits >= 0
        ? proposal.compiled.estimatedCredits
        : 0,
    steps: [
      {
        title: summary === "" ? call.tool : summary,
        tool: call.tool,
        args: call.args,
        batch: {
          label: label === "" ? "Agent proposal" : label,
          steps: [...batch.steps] as EditPlan["steps"][number]["batch"]["steps"],
        },
      },
    ],
  };
}

/**
 * Merges a run's accumulated write-tool proposals into ONE EditPlan via the
 * contracts `mergeEditPlans` (exact `mergedCarrierPlan` semantics: undo_run
 * carriers excluded, §8.6 caps, max risk, recomputed credits). `null` when
 * nothing mergeable remains — the caller then skips the plan POST entirely.
 */
export function mergeTurnProposals(calls: readonly TurnToolCall[]): EditPlan | null {
  const carriers: EditPlan[] = [];
  for (const call of calls) {
    const carrier = writeToolCarrierPlan(call);
    if (carrier !== null) carriers.push(carrier);
  }
  if (carriers.length === 0) return null;
  return mergeEditPlans(carriers);
}
