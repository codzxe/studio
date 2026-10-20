// @studio/engine-pool — storage-adapter.ts (W3-M wiring): the composition
// adapter W2-M flagged ("engine-pool StorageLike (get→undefined, put→void)
// needs a 3-line adapter at its composition root"). It adapts
// @studio/storage's `Storage` interface (packages/storage/src/types.ts) to the
// pool's local `StorageLike` seam (src/checkpoint.ts): `Storage.get` resolves
// `null` for missing objects where the seam resolves `undefined`, and
// `Storage.put` takes required PutOptions (contentType) and resolves the
// object's metadata, which the checkpoint seam discards.
//
// `StudioStorage` mirrors the @studio/storage `Storage` data-plane shape
// (put/get/delete only — `sign`/`list` stay outside the checkpoint seam)
// LOCALLY, because this package's rule is "no imports from sibling packages"
// (checkpoint.ts header) and apps/engine-pool/tsconfig.json keeps an explicit
// rootDir, which sibling-source imports would trip as TS6059 (fleet precedent:
// the no-rootDir notes in worker/gateway/agent tsconfigs). A real `Storage`
// satisfies the mirror structurally, so the composition root passes
// `createStorageFromEnv(...)` straight in; the seam stays injectable either way.

import type { StorageLike } from "./checkpoint.js";

/**
 * Structural mirror of @studio/storage's `Storage` put/get/delete surface.
 * Verified shape-for-shape against packages/storage/src/types.ts: `put` takes
 * required PutOptions and resolves StorageObject (opaque here); `get` resolves
 * `Uint8Array | null`; `delete` is idempotent and resolves void.
 */
export interface StudioStorage {
  put(
    key: string,
    data: Uint8Array,
    options: { readonly contentType: string; readonly contentSha256?: string },
  ): Promise<unknown>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/** Content type stamped on checkpoint `.pcraft` bytes (opaque container). */
const CHECKPOINT_CONTENT_TYPE = "application/octet-stream";

/**
 * Adapt a @studio/storage `Storage` (structurally: `StudioStorage`) to the
 * checkpoint `StorageLike` seam. Rejections propagate — `StorageError` from the
 * driver surfaces at `CheckpointManager.saveCheckpoint`, which already maps any
 * throw to the `storage_write_failed` typed envelope (§4), so no wrapping here.
 */
export const adaptStudioStorage = (storage: StudioStorage): StorageLike => ({
  put: async (key, data) => {
    await storage.put(key, data, { contentType: CHECKPOINT_CONTENT_TYPE });
  },
  get: async (key) => (await storage.get(key)) ?? undefined,
  delete: (key) => storage.delete(key),
});
