/**
 * @studio/editor-bridge — the typed `window.effectcraft` bridge
 * (PRODUCT_ARCHITECTURE §6.2) for the frozen EffectCraft editor iframe.
 *
 * Production entry: `import { attachEditorBridge, forwardShortcut } from "@studio/editor-bridge"`.
 * Tests / E2E fixtures: `import { createFakeEditor, attachFakeBridge } from "@studio/editor-bridge/fake"`.
 */

export {
  attachEditorBridge,
  editorLoadState,
  forwardShortcut,
  sameOrigin,
  sanitizeAssetName,
  type AttachOptions,
  type EditorLoadState,
  type EditorLoadStatus,
  type EditorShortcutEvent,
  type EditorShortcutHandler,
  type EditorShortcutName,
  type ShortcutHandlers,
} from "./bridge";

export {
  AgentBatchInputSchema,
  AgentBatchSchema,
  AgentBatchStepSchema,
  MAX_BATCH_PAYLOAD_BYTES,
  MAX_BATCH_STEPS,
  MAX_BATCH_TIMEOUT_MS,
  normalizeAgentBatch,
  validateAgentBatch,
  type AgentBatch,
  type AgentBatchInput,
  type AgentBatchStep,
} from "./batch";

export {
  BridgeError,
  isBridgeError,
  isBridgeErrorCode,
  messageOf,
  type BridgeErrorCode,
} from "./errors";

export {
  AppCapabilitiesSchema,
  BatchResultSchema,
  CommandInfoSchema,
  CommandSchemaSchema,
  EditorInfoSchema,
  EffectcraftLoadInfoSchema,
  LayerNodeSchema,
  ProjectItemSummarySchema,
  ProjectSummarySchema,
  PropKeyframeInfoSchema,
  PropNodeSchema,
  RenderFrameResultSchema,
  SaveResultSchema,
  ScreenshotResultSchema,
  UiInspectSchema,
  type AppCapabilities,
  type BatchResult,
  type CloudAsset,
  type CommandInfo,
  type CommandSchema,
  type EditorBridge,
  type EditorEventName,
  type EditorEventHandler,
  type EditorInfo,
  type EffectcraftGlobal,
  type EffectcraftLoad,
  type EffectcraftWindow,
  type FileEntry,
  type LayerNode,
  type ProjectItemSummary,
  type ProjectSummary,
  type PropKeyframeInfo,
  type PropNode,
  type PropValue,
  type RenderFrameParams,
  type RenderFrameResult,
  type SaveResult,
  type ScreenshotParams,
  type ScreenshotResult,
  type UiInspect,
} from "./types";
