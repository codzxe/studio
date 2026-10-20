// @studio/tools — the default registry assembly (owner: W5-R).
//
// `buildDefaultToolRegistry()` registers every tool this package ships, in §6
// table order, on a `ToolRegistry` pinned to the §6 surface (`TOOLS`), with
// duplicate-name detection active: a registration that fails at assembly time
// is a developer bug and throws `ToolError` (fail fast — never a model error).
//
// The `echo` reference tool (src/example/echo.ts — "not a product tool" per its
// header and the package README) is included by default so dev/test contexts
// and the §6.2 reference stay exercisable through the same registry path;
// production run managers pass `{ includeEcho: false }` to pin the registry to
// exactly the §6 surface.
//
// §6 rows whose Wave-5 tool files had NOT landed at assembly time (checked by
// ls before this file was written): `component_list`, `component_place`,
// `render_preview`, `variant_create`, `export_document`, plus `brief_to_plan`
// (model-orchestrated; the planner wave owns its implementation). When a tool
// file lands, add ONE import + ONE `defaultTools()` entry here and extend the
// pinned name list in tests/registry-defaults.test.ts — `allowedNames` already
// accepts every §6 name, so no other change is required.
//
// Seam reconciliation note (task W5-R): `types.ts` (owned by W1-O) keeps
// `ToolContext` minimal on purpose. The seams flagged by siblings are all
// declared LOCALLY in the tool files that need them — `ImageGenerateContext`
// (credits / imageProvider / generatedImages, tools/image-generate.ts),
// `ComponentSetVarsContext` + `ComponentRegistryLike` (component-set-vars.ts),
// `VisionCritiqueContext` + `CriticModelLike` (vision-critique.ts) — so NO
// types-ext.ts augmentation is needed; render_preview/export_document and
// friends should follow the same local-seam pattern until a wave widens
// `ToolContext`.

import { echoTool } from "./example/echo.js";
import { ToolError } from "./kit.js";
import { TOOLS, ToolRegistry, type ToolListing } from "./registry.js";
import { askUserTool } from "./tools/ask-user.js";
import { assetPlaceTool } from "./tools/asset-place.js";
import { assetSearchTool } from "./tools/asset-search.js";
import { componentSetVarsTool } from "./tools/component-set-vars.js";
import { imageGenerateTool } from "./tools/image-generate.js";
import { layerOpsTool } from "./tools/layer-ops.js";
import { layoutApplyTool } from "./tools/layout-apply.js";
import { styleApplyTool } from "./tools/style-apply.js";
import { templateApplyTool } from "./tools/template-apply.js";
import { templateFillTool } from "./tools/template-fill.js";
import { templateInspect } from "./tools/template-inspect.js";
import { templateList } from "./tools/template-list.js";
import { textSet } from "./tools/text-set.js";
import { validateDocument } from "./tools/validate-document.js";
import { visionCritiqueTool } from "./tools/vision-critique.js";
import { workspaceSnapshot } from "./tools/workspace-snapshot.js";
import type { AnyTool } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DefaultToolRegistryOptions {
  /**
   * Register the `echo` reference tool (default: true). Pass `false` in
   * production run managers to pin the registry to exactly the §6 surface —
   * echo is the annotated §6.2 example, never a product tool.
   */
  readonly includeEcho?: boolean;
}

// ---------------------------------------------------------------------------
// The ordered default tool list (§6 table order; echo last)
// ---------------------------------------------------------------------------

/**
 * Every tool this package ships, in §6 row order, then `ask_user`
 * (model-orchestrated row), then the `echo` reference tool. Single source of
 * truth for the registry, the TOOLS_DEFAULT map, and the planner manifest.
 */
function defaultTools(includeEcho: boolean): readonly AnyTool[] {
  const tools: readonly AnyTool[] = [
    workspaceSnapshot, // §6 row 1
    templateList, // §6 row 2
    templateInspect, // §6 row 3
    templateApplyTool, // §6 row 4
    templateFillTool, // §6 row 5
    assetSearchTool, // §6 row 6 (search half)
    assetPlaceTool, // §6 row 6 (place half)
    imageGenerateTool, // §6 row 7
    textSet, // §6 row 8
    layerOpsTool, // §6 row 9
    styleApplyTool, // §6 row 10
    layoutApplyTool, // §6 row 11
    componentSetVarsTool, // §6 row 13
    validateDocument, // §6 row 15
    visionCritiqueTool, // §6 row 16
    askUserTool, // §6 model-orchestrated row (client-side affordance)
  ];
  return includeEcho ? [...tools, echoTool] : tools;
}

// ---------------------------------------------------------------------------
// buildDefaultToolRegistry
// ---------------------------------------------------------------------------

/**
 * Assembles the default registry: §6-pinned names (plus `echo` while
 * `includeEcho`, the default, holds), every shipped tool registered in §6
 * order, duplicate-name detection ACTIVE — a rejected registration throws
 * `ToolError` instead of shipping a half-built registry.
 */
export function buildDefaultToolRegistry(
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const includeEcho = options.includeEcho ?? true;
  const registry = new ToolRegistry({
    allowedNames: includeEcho ? [...Object.values(TOOLS), echoTool.name] : Object.values(TOOLS),
  });
  for (const tool of defaultTools(includeEcho)) {
    const outcome = registry.register(tool);
    if (!outcome.ok) {
      // Assembly-time bug (duplicate name / off-surface name / broken tool):
      // fail fast and loud — this is wiring, not a model-facing error.
      throw new ToolError(
        "internal_error",
        `buildDefaultToolRegistry: registering "${tool.name}" failed` +
          ` (${outcome.code}): ${outcome.message}`,
        { hint: outcome.hint },
      );
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// TOOLS_DEFAULT + the planner manifest (module-level, derived once)
// ---------------------------------------------------------------------------

const defaultRegistry = buildDefaultToolRegistry();

/** Every default tool by name, in §6 order — the executor's dispatch map. */
export const DEFAULT_TOOL_NAMES: readonly string[] = defaultRegistry.names();

/**
 * Every registered tool by name (`{ [name]: tool }`), the shape the executor
 * consumes to dispatch parsed calls (see `ToolMap` in src/index.ts). Frozen —
 * registries are append-at-assembly, never mutated per run.
 */
export const TOOLS_DEFAULT: Readonly<Record<string, AnyTool>> = Object.freeze(
  Object.fromEntries(
    DEFAULT_TOOL_NAMES.map((name) => {
      const lookup = defaultRegistry.get(name);
      if (!lookup.ok) {
        // Unreachable: every name above registered ok before names() returned.
        throw new ToolError(
          "internal_error",
          `buildDefaultToolRegistry: default registry is missing "${name}"`,
          { hint: "Registry assembly is append-only; re-run from a clean module state." },
        );
      }
      return [name, lookup.tool] as const;
    }),
  ),
);

/**
 * Planner context manifest (§6.1): name + description ONLY — argument schemas
 * never enter prompts; the executor parses raw args with `parseToolArgs`.
 */
export const DEFAULT_TOOL_MANIFEST: readonly ToolListing[] = defaultRegistry.list();
