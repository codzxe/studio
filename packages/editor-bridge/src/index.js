/**
 * @studio/editor-bridge — the typed `window.effectcraft` bridge
 * (PRODUCT_ARCHITECTURE §6.2) for the frozen EffectCraft editor iframe.
 *
 * Production entry: `import { attachEditorBridge, forwardShortcut } from "@studio/editor-bridge"`.
 * Tests / E2E fixtures: `import { createFakeEditor, attachFakeBridge } from "@studio/editor-bridge/fake"`.
 */
export { attachEditorBridge, editorLoadState, forwardShortcut, sameOrigin, sanitizeAssetName, } from "./bridge";
export { AgentBatchInputSchema, AgentBatchSchema, AgentBatchStepSchema, MAX_BATCH_PAYLOAD_BYTES, MAX_BATCH_STEPS, MAX_BATCH_TIMEOUT_MS, normalizeAgentBatch, validateAgentBatch, } from "./batch";
export { BridgeError, isBridgeError, isBridgeErrorCode, messageOf, } from "./errors";
export { AppCapabilitiesSchema, BatchResultSchema, CommandInfoSchema, CommandSchemaSchema, EditorInfoSchema, EffectcraftLoadInfoSchema, LayerNodeSchema, ProjectItemSummarySchema, ProjectSummarySchema, PropKeyframeInfoSchema, PropNodeSchema, RenderFrameResultSchema, SaveResultSchema, ScreenshotResultSchema, UiInspectSchema, } from "./types";
//# sourceMappingURL=index.js.map