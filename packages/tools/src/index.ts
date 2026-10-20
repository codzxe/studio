// @studio/tools — public surface for the agent runtime (executor, planner) and
// Wave 5 tool authors. §6: tools wrap engine commands; raw command ids never
// reach the model.
//
// Assembled by W5-R. Re-exports the kit, the contract types, the registry,
// the default registry assembly, and EVERY export of every tool file — the
// one place downstream waves import from. Symbols exported by two sibling
// files each ride under prefixed aliases so nothing is silently dropped by a
// star-export collision:
//   - ENGINE_PATCH_HINT  → TEMPLATE_APPLY_ENGINE_PATCH_HINT / LAYOUT_APPLY_ENGINE_PATCH_HINT
//   - MAX_QUERY_CHARS    → ASSET_SEARCH_MAX_QUERY_CHARS / TEMPLATE_LIST_MAX_QUERY_CHARS
//                          / COMPONENT_LIST_MAX_QUERY_CHARS
//   - MAX_LIST_CARDS / MAX_LIST_TAGS / MAX_SHOWN_PINS / MAX_TAG_CHARS
//                       → TEMPLATE_LIST_* / COMPONENT_LIST_* variants
//   - ResolvedTarget     → ResolvedTarget (asset_place, the shared mechanics)
//                          + ImageGenerateResolvedTarget (image_generate)
//   - ComponentVarKind / ComponentVarValue / ComponentVariableSpec / VarsValidation
//                       → unaliased from component_set_vars (the §6 row 13 vars
//                          owner) + ComponentPlaceVarKind/VarValue/VarSpec/
//                          VarsValidation aliases from component_place
//
// Context-seam note (no types-ext.ts, deliberately): the seams missing from
// `ToolContext` (types.ts, owned by W1-O) are declared LOCALLY where they are
// needed — `ImageGenerateContext extends ToolContext` with `CreditSpender`,
// `ImageProviderLike`, `GeneratedImageSinkLike` in tools/image-generate.ts;
// `RenderPreviewContext` + `PreviewSinkLike` (render-preview.ts);
// `VisionCritiqueContext` + `CriticModelLike` (vision-critique.ts);
// `ExportToolContext` + `ExportJobsLike`/`ExportEventsLike` (export-document.ts);
// `ComponentSetVarsContext` + `ComponentRegistryLike` (component-set-vars.ts)
// — following the package's minimal-seam policy. component_place and
// variant_create should do the same when they land.

import type { AnyTool } from "./types.js";

export * from "./kit.js";
export * from "./registry-defaults.js";
export * from "./registry.js";
export * from "./types.js";

export { echoTool, type EchoArgs } from "./example/echo.js";

// ask_user — §6 model-orchestrated row: a client-side affordance, not an
// engine tool. See its header for the run-pause + ask_user SSE contract the
// worker/run manager implements.
export {
  ASK_USER_EVENT_TYPE,
  AskUserArgs,
  AskUserPauseEvent,
  AskUserSummary,
  MAX_OPTIONS,
  MAX_OPTION_CHARS,
  MAX_QUESTION_CHARS,
  MIN_OPTIONS,
  askUserArgsSchema,
  askUserPauseEvent,
  askUserTool,
  parseAskUserSummary,
  summarizeAskUser,
} from "./tools/ask-user.js";

export {
  AssetPlaceArgs,
  Bounds,
  FitInput,
  FitMode,
  FitPlan,
  MAX_CANVAS_PX,
  ResolvedTarget,
  UPSCALE_ERR_FACTOR,
  UPSCALE_WARN_FACTOR,
  assetPlaceArgs,
  assetPlaceTool,
  computeFit,
  isPlaceableAssetPath,
  zBounds,
} from "./tools/asset-place.js";

export {
  AssetRow,
  AssetSearchArgs,
  DEFAULT_RESULTS,
  MAX_NAME_CHARS,
  MAX_QUERY_CHARS as ASSET_SEARCH_MAX_QUERY_CHARS,
  MAX_RESULTS,
  assetKind,
  assetSearchArgs,
  assetSearchTool,
  compactAssetTable,
  toAssetRow,
} from "./tools/asset-search.js";

// component_list — §6 row 12 (list half).
export {
  COMPONENT_LIST_COMMAND,
  ComponentCardView,
  ComponentListArgs,
  ComponentListReply,
  ComponentListRow,
  MAX_LIST_CARDS as COMPONENT_LIST_MAX_LIST_CARDS,
  MAX_LIST_TAGS as COMPONENT_LIST_MAX_LIST_TAGS,
  MAX_QUERY_CHARS as COMPONENT_LIST_MAX_QUERY_CHARS,
  MAX_SHOWN_PINS as COMPONENT_LIST_MAX_SHOWN_PINS,
  MAX_TAG_CHARS as COMPONENT_LIST_MAX_TAG_CHARS,
  candidatePins,
  componentListTool,
  engineFailureErr,
  readComponentList,
} from "./tools/component-list.js";

// component_place — §6 row 12 (place half). Its ComponentVar* / VarsValidation
// shapes collide with component-set-vars' and ride as ComponentPlace* aliases.
export {
  ANCHOR_FRACTIONS,
  COMPONENT_ANCHORS,
  COMPONENT_INSPECT_COMMAND,
  COMPONENT_PLACE_COMMAND,
  ComponentAnchor,
  ComponentPlaceArgs,
  ComponentVarKind as ComponentPlaceVarKind,
  ComponentVarSchema,
  ComponentVarValue as ComponentPlaceVarValue,
  ComponentVariableSpec as ComponentPlaceVarSpec,
  VarsValidation as ComponentPlaceVarsValidation,
  MAX_COMPONENT_ID_CHARS,
  MAX_COMPONENT_VERSION,
  MAX_ORIGIN_PX,
  MAX_PLACE_VARS,
  MAX_TARGET_PIXELS,
  MAX_TARGET_SIDE,
  PlaceBounds,
  PlacedInstance,
  UNKNOWN_COMPONENT_CODE,
  UNKNOWN_COMPONENT_VARS_CODE,
  anchorAdjustedBounds,
  componentPlaceTool,
  parseComponentRef,
  readComponentVarSchema,
  readInspectedManifest,
  readPlacedInstance,
  unknownComponentErr,
  unknownComponentVarsErr,
  validateComponentVars,
  zComponentRef,
  zPlaceBounds,
} from "./tools/component-place.js";

// component_set_vars — the worker must assemble ComponentSetVarsContext
// (componentRegistry + engine instance bookkeeping) for this tool to run.
export {
  COMPONENT_SET_VARS_COMMAND,
  COMPONENT_UPDATE_INSTANCE_COMMAND,
  ComponentInstanceRecord,
  ComponentManifestLike,
  ComponentRegistryLike,
  ComponentSetVarsArgs,
  ComponentSetVarsContext,
  ComponentVarKind,
  ComponentVarValue,
  ComponentVariableSpec,
  MAX_COMPONENT_VARS,
  SetVarsReport,
  UpdateInstanceReport,
  VarsValidation,
  componentSetVarsArgsSchema,
  componentSetVarsTool,
  engineInstanceRef,
  readSetVarsReport,
  readUpdateInstanceReport,
  renderComponentWarning,
  renderUserChange,
  summarizeSetVars,
  validateVarsAgainstManifest,
} from "./tools/component-set-vars.js";

// export_document — the worker must assemble ExportToolContext (exportJobs +
// exportEvents seams, §13 exports endpoint) for this tool to run.
export {
  AwaitExportDeps,
  AwaitExportOptions,
  AwaitedExport,
  EXPORT_FAILED_CODE,
  EXPORT_FORMAT_SCHEMA,
  EXPORT_WAIT_BUDGET_MS,
  ExportCallOptions,
  ExportDocumentArgs,
  ExportEventsLike,
  ExportFormat,
  ExportJobHandle,
  ExportJobRecord,
  ExportJobStatus,
  ExportJobsLike,
  ExportSubmission,
  ExportSummaryParts,
  ExportToolContext,
  MAX_EXPORT_URL_CHARS,
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  PSD_EXPERIMENTAL_WARNING,
  PSD_NOT_OFFERED_HINT,
  buildExportSummary,
  deriveExportIdempotencyKey,
  exportDocumentArgsSchema,
  exportDocumentTool,
  exportPipelineErr,
  isSafeExportUrl,
  isTerminalExportStatus,
  sleepUntilResolved,
} from "./tools/export-document.js";

// image_generate — the worker must assemble ImageGenerateContext (credits,
// imageProvider, generatedImages) for this tool to run (§5.2, §5.3, §14.2).
export {
  CreditSpender,
  GENERATED_PHOTO_LAYER_NAME,
  GeneratedImageSinkLike,
  IMAGE_CREDIT_COST,
  IMAGE_QUALITY_SCHEMA,
  IMAGE_SIZE_SCHEMA,
  ImageGenerateArgs,
  ImageGenerateContext,
  ImageProviderLike,
  ImageProviderResult,
  ImageQuality,
  ImageSize,
  MAX_PROMPT_CHARS,
  PngCheck,
  ResolvedTarget as ImageGenerateResolvedTarget,
  imageGenerateArgsSchema,
  imageGenerateTool,
  isPlaceableGeneratedPath,
  sanitizePrompt,
  validatePng,
} from "./tools/image-generate.js";

export {
  ALIGN_MODES,
  AlignMode,
  LAYER_OPS_COMMANDS,
  LOOSE_LAYER_LIMIT,
  LayerOpsArgs,
  REORDER_POSITIONS,
  ReorderPosition,
  checkLayerName,
  isAutoLayerName,
  layerOpsTool,
  resolveLayerRef,
  resolveLayerRefs,
} from "./tools/layer-ops.js";

export {
  AbsoluteNode,
  CenterNode,
  CompactedLayoutReply,
  ComponentNode,
  DividerNode,
  ENGINE_PATCH_HINT as LAYOUT_APPLY_ENGINE_PATCH_HINT,
  GridNode,
  ImageNode,
  LAYOUT_APPLY_COMMAND_ID,
  LAYOUT_APPLY_RESULT_SCHEMA,
  LAYOUT_MAX_CHILDREN_PER_NODE,
  LAYOUT_MAX_COLUMNS,
  LAYOUT_MAX_DEPTH,
  LAYOUT_MAX_GAP_PX,
  LAYOUT_MAX_GROW,
  LAYOUT_MAX_NODES,
  LAYOUT_MAX_PX,
  LAYOUT_MAX_SAFE_AREA_PX,
  LAYOUT_MAX_SIDE_PX,
  LayoutAbsoluteChild,
  LayoutAlign,
  LayoutAnchor,
  LayoutApplyArgs,
  LayoutApplyOutcome,
  LayoutApplySummaryReport,
  LayoutCenterChild,
  LayoutDirection,
  LayoutFit,
  LayoutFlowDir,
  LayoutLayerRef,
  LayoutMovedLayer,
  LayoutNode,
  LayoutNodeKind,
  LayoutSides,
  LayoutSizingFields,
  LayoutWithinRef,
  MAX_MOVED_EXAMPLES,
  MISSING_MOVE_REPORT_WARNING,
  RowNode,
  SpacerNode,
  StackNode,
  TextNode,
  compactLayoutApplyReply,
  findLayoutTreeCapsViolation,
  layoutApplyArgsSchema,
  layoutApplyTool,
  mapLayoutEngineFailure,
  parseLayoutApplyReport,
} from "./tools/layout-apply.js";

// render_preview — the worker must assemble RenderPreviewContext (previewSink
// seam: persist the PNG, return a signed/root-relative URL) for this to run.
export {
  AGENT_PREVIEW_CEILING_PX,
  ClampedRenderWidth,
  ENGINE_HARD_PREVIEW_CEILING_PX,
  PREVIEW_RENDER_TIMEOUT_MS,
  PREVIEW_WIDTHS,
  PngFailureReason,
  PreviewPutMeta,
  PreviewSinkLike,
  PreviewSinkPut,
  PreviewWidth,
  RenderPreviewArgs,
  RenderPreviewContext,
  buildPreviewSummary,
  clampRenderWidth,
  isEngineWriteRootPath,
  isSafePreviewUrlValue,
  renderPreviewArgsSchema,
  renderPreviewTool,
} from "./tools/render-preview.js";

export {
  LayerStyleSpec,
  MAX_ADJ_PARAM_KEYS,
  MAX_TARGET_LAYERS,
  NormalizedColor,
  StyleApplyArgs,
  StyleCommandPlan,
  StyleSpec,
  describeLayerRef,
  normalizeColor,
  planStyleCommands,
  styleApplyArgsSchema,
  styleApplyTool,
} from "./tools/style-apply.js";

export {
  ENGINE_PATCH_HINT as TEMPLATE_APPLY_ENGINE_PATCH_HINT,
  TEMPLATE_APPLY_COMMAND_ID,
  TEMPLATE_PIN_RE,
  TemplateApplyArgs,
  TemplateApplyReport,
  mapApplyEngineFailure,
  parseApplyReport,
  templateApplyArgsSchema,
  templateApplyTool,
} from "./tools/template-apply.js";

export {
  ColorSlotValue,
  CompileOutcome,
  CompiledSlots,
  EngineSlotValue,
  FillReport,
  ImageSlotValue,
  SlotValue,
  TEMPLATE_FILL_COMMAND,
  TemplateFillArgs,
  TextSlotValue,
  VisibilitySlotValue,
  compileSlotValues,
  imageUpscaleLimitErr,
  readFillReport,
  summarizeFill,
  templateFillTool,
  unknownSlotsErr,
} from "./tools/template-fill.js";

export {
  MAX_MANIFEST_SLOTS,
  TemplateInspectArgs,
  TemplatePin,
  parseTemplatePin,
  templateInspect,
} from "./tools/template-inspect.js";

export {
  CanvasSize,
  MAX_LIST_CARDS as TEMPLATE_LIST_MAX_LIST_CARDS,
  MAX_LIST_TAGS as TEMPLATE_LIST_MAX_LIST_TAGS,
  MAX_QUERY_CHARS as TEMPLATE_LIST_MAX_QUERY_CHARS,
  MAX_SHOWN_PINS as TEMPLATE_LIST_MAX_SHOWN_PINS,
  MAX_TAG_CHARS as TEMPLATE_LIST_MAX_TAG_CHARS,
  TemplateCardView,
  TemplateListArgs,
  byIdThenVersion,
  capText,
  compareVersions,
  fieldOf,
  pinOf,
  probeCanvasSize,
  probeFields,
  templateList,
} from "./tools/template-list.js";

export {
  TextSetArgs,
  isMachineLayerName,
  isRoleLayerName,
  textSet,
  textSetArgs,
  toEngineColor,
} from "./tools/text-set.js";

// validate_document — deterministic §6 row 15 lint over inspect + render data.
export {
  BODY_CONTRAST,
  DEFAULT_MAX_TEXT_LAYERS,
  DEFAULT_SAFE_AREA_PX,
  EngineValidateReply,
  GENERIC_RULES,
  LARGE_CONTRAST,
  LARGE_TEXT_PT,
  MAX_ISSUES,
  RuleId,
  RuleInput,
  TEMPLATE_ARM_SUPPLEMENT_RULES,
  TEMPLATE_VALIDATE_COMMAND,
  ValidateDocumentArgs,
  ValidationIssue,
  ValidationReport,
  buildReport,
  capIssues,
  collectIssues,
  contrastRatio,
  contrastThresholdFor,
  countIssues,
  effectiveBackground,
  fitsIn,
  flattenRows,
  hexToRgb,
  intersectsCanvas,
  isMachineName,
  readValidateReport,
  relativeLuminance,
  renderSummary,
  sortIssues,
  validateDocument,
  withinSafeArea,
} from "./tools/validate-document.js";

// variant_create — §6 row 17: layer comps, data sets, size + language variants.
export {
  CompListing,
  CompRow,
  DataSetRow,
  DataSetValueRow,
  FixedVariantName,
  LAYOUT_REPLAY_WARNING,
  MAX_COMP_NAME_CHARS,
  MAX_DATA_SET_NAME_CHARS,
  MAX_DATA_SET_VALUES,
  MAX_LANGUAGES,
  MAX_LANG_CHARS,
  MAX_SIZES,
  MAX_SIZE_PX,
  MAX_SLOTS_PER_LANGUAGE,
  MIN_SIZE_PX,
  VARIANT_COMP_BASE,
  VARIANT_CREATE_COMMANDS,
  VARIANT_SEPARATOR,
  VariableDefRow,
  VariablesListing,
  VariantCreateArgs,
  VariantSummaryFacts,
  buildDataSetValues,
  buildSummary,
  coerceVisibilityValue,
  compNameForLanguage,
  compNameForSize,
  fixVariantName,
  readCompListing,
  readVariablesListing,
  variantCreateTool,
} from "./tools/variant-create.js";

// vision_critique — the worker must assemble VisionCritiqueContext
// (criticModel seam, §23.3) for this tool to run.
export {
  AVG_REVISE_THRESHOLD,
  CRITIC_RUBRIC_KEYS,
  CRITIQUE_PARSE_FAILED_CODE,
  CriticModelLike,
  CriticModelResult,
  CriticRubricKey,
  CriticUsage,
  CritiqueInput,
  CritiqueIssue,
  CritiqueModelOutput,
  CritiqueParseResult,
  EnforcedCritique,
  MAX_BRIEF_CHARS,
  MAX_CRITIC_ISSUES,
  MAX_LAYER_SUMMARY_CHARS,
  MAX_PALETTE_ENTRIES,
  MAX_VALIDATOR_REPORT_CHARS,
  REPAIR_INSTRUCTION,
  SCORE_REVISE_CEILING,
  VisionCritiqueArgs,
  VisionCritiqueContext,
  averageScore,
  buildCritiqueSummary,
  criticIssueSchema,
  critiqueSchema,
  enforceCritiqueRules,
  isHttpPreviewUrl,
  parseCritiqueRaw,
  stripControlChars,
  visionCritiqueArgsSchema,
  visionCritiqueTool,
} from "./tools/vision-critique.js";

export {
  CompactLayers,
  MAX_COMPS,
  MAX_DATA_SET_NAMES,
  MAX_FONTS,
  MAX_LAYERS_IN_SNAPSHOT,
  MAX_PALETTE_TOKENS,
  MAX_RECENT_RUNS,
  MAX_TEMPLATE_ROWS,
  MAX_TEMPLATE_TAGS,
  MAX_VARIABLE_DEFS,
  PaletteEntry,
  SNAPSHOT_SUMMARY_BUDGET_CHARS,
  SnapshotBounds,
  SnapshotComps,
  SnapshotLayer,
  SnapshotRun,
  SnapshotSections,
  SnapshotTemplate,
  SnapshotVariableDef,
  SnapshotVariables,
  WorkspaceSnapshotArgs,
  commandPayload,
  compactComps,
  compactFonts,
  compactLayer,
  compactLayers,
  compactPalette,
  compactRuns,
  compactTemplates,
  compactVariables,
  compareLayerIds,
  scrubSummary,
  summarizeSnapshot,
  workspaceSnapshot,
} from "./tools/workspace-snapshot.js";

/**
 * Every registered tool by name, as assembled by the agent runtime.
 * `{ [TOOLS.template_fill]: templateFillTool, … }` — the executor consumes this
 * shape to dispatch parsed calls. `TOOLS_DEFAULT` (registry-defaults.js) is the
 * shipped instance of this shape.
 */
export type ToolMap = Readonly<Record<string, AnyTool>>;
