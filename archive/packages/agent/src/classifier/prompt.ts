// @studio/agent — the §23.5 chat-edit classifier prompt. Owner: W6-O (AGENTS.md).
//
// Spec anchors:
//   §23.5  the closing instruction block below is VERBATIM spec text (the fenced
//          block pinned byte-for-byte by packages/agent/prompts/v1/chat-edit-
//          classifier.md; the spec file is CRLF, prompts are LF — W6-A
//          precedent). Do not reword, reflow or reorder it. The three labeled
//          `Inputs:` lines carry the worker-assembled context as compact JSON
//          blocks (plain `${}` interpolation of JSON.stringify'd values, no
//          template engine).
//   §24.2  the worked example this classifier exists to reproduce: "Make the
//          subhead smaller and add a 20% OFF badge." → restyle + add_component,
//          quick tier, 1 credit.
//   §5.3   the rendered prompt is byte-stable for equal inputs (prompt-cache
//          prefix anchor).
//   §5.4   context assembly decides WHAT rides in each section; this builder
//          only labels + stringifies.
//   §6.1   the classifier sees tool/component NAMES only — argument schemas
//          never enter prompts. `@studio/tools` DEFAULT_TOOL_MANIFEST satisfies
//          `catalog.tools` structurally; this package keeps a dependency-free
//          seam (planner/prompt.ts precedent).
//
// Composite-action convention (NOT spec text — worker-side parse contract for
// the §24.2 output "restyle + add_component"): atoms join with "+" inside the
// single §23.5 `action` field, and each atom's payload scopes under `args`
// keyed by the atom name. It rides BEFORE the verbatim block so the spec text
// still closes the prompt.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Sizes (§5.7 "cap string lengths and array sizes")
// ---------------------------------------------------------------------------

/** One layer-summary row (workspace_snapshot compaction): `name` is required. */
export const CHAT_EDIT_MAX_LAYER_ROWS = 200;

/** Bounded identifier string (layer/component/template/asset ids are §5.7 input). */
const idField = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// Input sections (worker wiring; zod at every boundary)
// ---------------------------------------------------------------------------

/** §5.4 USER REQUEST — the chat message classifying an edit on a live document. */
export const chatEditUserRequestSchema = z.string().min(1).max(20_000);
export type ChatEditUserRequest = z.infer<typeof chatEditUserRequestSchema>;

/**
 * One layer-summary row. `name` is the §23.5 `target_layers` cross-check
 * source; kind/text/bounds ride through untouched (§5.4 fidelity).
 */
export const chatEditLayerRowSchema = z.object({ name: idField }).passthrough();
export type ChatEditLayerRow = z.infer<typeof chatEditLayerRowSchema>;

/**
 * LAYER SUMMARY — the compact layer tree of the document being edited. Empty
 * when the worker could not snapshot (cross-checks degrade to warnings).
 */
export const chatEditLayerSummarySchema = z
  .array(chatEditLayerRowSchema)
  .max(CHAT_EDIT_MAX_LAYER_ROWS);
export type ChatEditLayerSummary = z.infer<typeof chatEditLayerSummarySchema>;

/** §6.1 tool manifest row — name + description only (structural seam). */
export const chatEditToolEntrySchema = z
  .object({ name: z.string().min(1).max(100), description: z.string().max(2000) })
  .passthrough();
export type ChatEditToolEntry = z.infer<typeof chatEditToolEntrySchema>;

/**
 * One catalog component (§8.2): `id` is what the add_component cross-check
 * verifies; `offer-badge@2` style ids carry the version inline.
 */
export const chatEditComponentEntrySchema = z
  .object({
    id: idField,
    version: z.union([z.number().int().min(0), z.string().min(1).max(40)]).optional(),
    variables: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .passthrough();
export type ChatEditComponentEntry = z.infer<typeof chatEditComponentEntrySchema>;

/** Template/asset rows: only the id matters to the classifier cross-checks. */
export const chatEditIdEntrySchema = z.object({ id: idField }).passthrough();
export type ChatEditIdEntry = z.infer<typeof chatEditIdEntrySchema>;

/** CATALOG — tools, templates, components, assets visible to this run. */
export const chatEditCatalogSchema = z
  .object({
    tools: z.array(chatEditToolEntrySchema).max(100).optional(),
    templates: z.array(chatEditIdEntrySchema).max(200).optional(),
    components: z.array(chatEditComponentEntrySchema).max(200).optional(),
    assets: z.array(chatEditIdEntrySchema).max(500).optional(),
  })
  .passthrough();
export type ChatEditCatalog = z.infer<typeof chatEditCatalogSchema>;

/**
 * Boundary schema for the whole classifier input (worker wiring). Passthrough
 * so `signal` and future run-loop fields ride along untouched.
 */
export const chatEditInputSchema = z
  .object({
    userRequest: chatEditUserRequestSchema,
    layerSummary: chatEditLayerSummarySchema,
    catalog: chatEditCatalogSchema,
  })
  .passthrough();

export type ChatEditPromptInput = z.infer<typeof chatEditInputSchema>;

// ---------------------------------------------------------------------------
// The §23.5 prompt (VERBATIM closing block — do not reword, reflow or reorder)
// ---------------------------------------------------------------------------

/**
 * JSON-encodes one section block. `JSON.stringify` returns `undefined` only for
 * non-JSON values; `null` is the honest placeholder then (planner precedent).
 */
function block(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/** The §23.5 text, LF-joined exactly as the spec's fenced block reads. */
export const CHAT_EDIT_SPEC_PROMPT = [
  "Classify the user's edit request on an existing document. Return JSON only:",
  '{"action":"set_text|replace_field|restyle|move|resize|add_component|remove_layer|recolor|export|clarify",',
  ' "target_layers":["name"], "args":{...}, "cost_tier":"quick|standard|complex",',
  ' "needs_template_reapply":true|false}',
  "Pick the cheapest action that satisfies the request. If the target is ambiguous, list",
  'candidates and set action "clarify" with one question. Never propose a full regeneration',
  "when a targeted edit works.",
].join("\n");

/** The worker-side parse contract for the §24.2 composite output. */
export const CHAT_EDIT_COMPOSITE_CONVENTIONS = [
  "Output conventions:",
  '- A composite request joins atoms with "+" in "action" (e.g. "restyle+add_component", §24.2);',
  '  scope each atom\'s payload under "args" keyed by the atom name.',
  '- For "clarify", put the candidate targets in args.candidates and the one question in args.question.',
].join("\n");

/**
 * Builds the §23.5 chat-edit classifier prompt: labeled context sections, the
 * composite/clarify output conventions, then the spec text VERBATIM as the
 * closing instruction. Byte-stable for equal inputs (§5.3 cache anchor).
 */
export function buildChatEditPrompt(input: ChatEditPromptInput): string {
  return `You are classifying one chat-edit request on an existing document.

Inputs:
- USER REQUEST: ${block(input.userRequest)}
- LAYER SUMMARY: ${block(input.layerSummary)}
- CATALOG: ${block(input.catalog)}

${CHAT_EDIT_COMPOSITE_CONVENTIONS}

${CHAT_EDIT_SPEC_PROMPT}`;
}

// ---------------------------------------------------------------------------
// Retry attachment (§5.1 one-retry rule; the §23.5 text is never edited)
// ---------------------------------------------------------------------------

/** Issue strings attached to the retry prompt, capped against prompt bloat. */
export const CHAT_EDIT_MAX_ISSUES_ATTACHED = 20;

/**
 * §5.1 (planner precedent): keep the full original prompt and APPEND the
 * validation issues; the model gets exactly one corrected attempt.
 */
export function buildChatEditRetryPrompt(prompt: string, issues: readonly string[]): string {
  const shown = issues.slice(0, CHAT_EDIT_MAX_ISSUES_ATTACHED).map((issue) => `- ${issue}`);
  const elided =
    issues.length > CHAT_EDIT_MAX_ISSUES_ATTACHED
      ? `\n- …and ${issues.length - CHAT_EDIT_MAX_ISSUES_ATTACHED} more issue(s)`
      : "";
  return `${prompt}

Your previous classification was rejected by validation. The issues were:
${shown.join("\n")}${elided}

Return the corrected classification now: the full JSON object only, no fences, no prose.`;
}
