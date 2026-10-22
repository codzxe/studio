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

import { TOOL_LIST, type ToolDefinition, isAgentCommand } from "@studio/contracts";
import type { ZodError } from "zod";

// F-6 (M5-R): the compiled-batch allowlist gate rides the same seam. The
// client apply engine (apps/web/src/lib/chat/apply.ts) checks every
// `engine.batch` step id against the SAME curated registry the gateway plan
// compiler compiled with, BEFORE the batch reaches the editor — re-exported
// here so no apps/web product module needs a runtime contracts import.
export { isAgentCommand };

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
