// @studio/worker — object storage seam (BUILD_PLAN §M8 task 4).
//
// THE WORKER USES THE SAME STORAGE AS THE GATEWAY: same env, same driver, same
// §9.2 key layout (services/gateway/src/storage.ts is the single
// implementation — imported, not duplicated). One StorageChoice is constructed
// per worker process and reused for every job (deps.storage).

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { StudioEnv } from "@studio/config";
import { type StorageChoice, createStorage, renderKey } from "@studio/gateway/storage";

// Re-exported so the worker and its tests never hand-build §9.2 keys.
export { renderKey };

/**
 * The repository root (this file lives at `services/worker/src/storage.ts`;
 * the built copy at `services/worker/dist/storage.js` is the same depth).
 */
export function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../..");
}

/**
 * Construct the worker's single storage choice.
 *
 * `fsRoot` (optional) pins the LocalFS root — tests pass an isolated temp dir
 * so the seeded objects and the worker's reads share one namespace. In `local`
 * runs without an explicit root the default is `<repo>/.local/storage`
 * (repo-anchored, NOT cwd-relative, so the worker finds the gateway's uploads
 * regardless of which package dir each process was started from).
 */
export function createWorkerStorage(env: StudioEnv, fsRoot?: string): StorageChoice {
  if (fsRoot !== undefined) {
    return createStorage(env, fsRoot);
  }
  if (env.app.env === "local") {
    const root = join(defaultRepoRoot(), ".local", "storage");
    return createStorage(env, root);
  }
  return createStorage(env);
}

/**
 * Read one object fully.
 *
 * The LocalFS driver reads straight off disk (authoritative). The S3 driver
 * never buffers (`read()` returns null by design) — in that case fall back to
 * a short-lived signed GET via `fetch`. Returns null when the object is absent
 * (callers map that to their typed RENDER_* codes); never throws for absence.
 */
export async function readObjectBytes(storage: StorageChoice, key: string): Promise<Buffer | null> {
  const direct = await storage.driver.read(key);
  if (direct !== null) return direct;
  if (storage.local !== null) return null; // local driver is authoritative
  const signed = await storage.driver.getSignedUrl(key, 60, { method: "GET" });
  const response = await fetch(signed.url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

/** mp4 outputs land as `output.mp4`; PNG sequences are zipped → `output.zip` (spike §5). */
export function renderOutputExt(format: string): "mp4" | "zip" {
  return format === "png-seq" ? "zip" : "mp4";
}

/**
 * The §9.2 output key for a render: the row's pre-created key when present,
 * else the deterministic `renderKey(...)` (same on every attempt — a re-run
 * after a crash OVERWRITES the same object, never duplicates: §M8 exit
 * criterion).
 */
export function outputObjectKey(
  row: { objectKey: string | null; projectId: string; id: string; format: string },
  workspaceId: string,
): string {
  if (row.objectKey !== null && row.objectKey.length > 0) return row.objectKey;
  return renderKey(workspaceId, row.projectId, row.id, renderOutputExt(row.format));
}

/** Ensure a directory exists (best effort — hydrate's scratch + workdirs). */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
