/**
 * The editor session engine (M3.3 load sequence + M3.4 autosave/versioning).
 *
 * Pure client-side TypeScript — no React, no DOM polling, no network of its
 * own. The editor host page (M3-A) uses:
 *
 *   const outcome = await loadProjectSession({ bridge, client, projectId });
 *   const autosave = createAutosaveController({
 *     bridge, client, projectId, baseVersion: manifest.currentVersion, hooks,
 *   });
 *   // Cmd/Ctrl+S → autosave.saveNow("manual"); agent apply → saveNow("agent-apply");
 *   // before close → saveNow("before-close"); before unload → autosave.dispose().
 *
 * `EditorSessionClient` is implemented by the page on top of
 * `@studio/api-client` (gateway §7.2 manifest, signed URLs, §9.2/§9.3
 * immutable versions). `EditorBridge` is the typed `window.effectcraft`
 * surface from `@studio/editor-bridge` (real editor; `attachFake` in tests).
 */

export { loadProjectSession } from "./load";

export {
  createAutosaveController,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  DEFAULT_IMMEDIATE_RETRIES,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  SAVE_REASON_LABELS,
} from "./autosave";

export { sha256Hex, sha256HexFallback } from "./sha256";

export {
  EditorSessionError,
  parseManifest,
  parseUploadResult,
  parseVersionRef,
} from "./types";
export type {
  AutosaveController,
  AutosaveHooks,
  CreateAutosaveControllerOptions,
  EditorSessionClient,
  EditorSessionErrorCode,
  LoadOutcome,
  LoadProjectSessionOptions,
  ManifestAssetInfo,
  MissingAsset,
  SaveOutcome,
  UploadVersionResult,
  VersionRef,
} from "./types";

// M7 read-only client enforcement (BUILD_PLAN §M7 task 3, DECISIONS.md D-23).
export {
  LEASE_HELD_ERROR_CODE,
  RAW_ENGINE_MUTATION_IDS,
  ReadOnlyLeaseError,
  createReadOnlyGate,
  isMutatingBridgeExecute,
  isMutatingBridgeRequestMethod,
  isReadOnlyLeaseError,
  wrapReadOnlyBridge,
} from "./read-only";
export type { ReadOnlyGate, ReadOnlyGateHandle } from "./read-only";

// Test support (createFakeEditorSessionClient + the fake .ecproj bytes) lives
// in ./testing and is deliberately NOT re-exported here: this barrel sits in
// the production module graph of every "@/lib/editor-session" import, and
// test fakes must never ride it (W2-B1 purge). Tests import
// "@/lib/editor-session/testing" directly.
