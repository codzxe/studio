/**
 * `loadProjectSession` — the M3.3 load sequence (BUILD_PLAN §M3 task 3):
 *
 *   fetch manifest → register assets by virtual path → download `.ecproj`
 *   → open → restore active comp (best-effort) → outcome
 *
 * Verified against the real editor surface (v0.13.0):
 * - `bridge.addAsset` fetches nothing itself in tests; the engine downloads
 *   via the client seam and hands the bridge `bytes` (§6.3), then keeps the
 *   path the editor ASSIGNED (upstream `addFile` keeps only the last path
 *   segment — editor/apps/effectcraft-web/src/files.rs `path_for`).
 * - Opening is `engine.execute("file.open", { path })` (editor/crates/engine/
 *   src/commands/file.rs:729); it reads the file table, replaces the project
 *   and restores the saved view (active comp/playhead/selection).
 * - The deterministic fake editor has no `file.open` command — it auto-opens
 *   `.ecproj` files inside `addFile` and restores `state` from the file — so
 *   an "unknown command" rejection there is tolerated and the open verified
 *   through `project.summary` instead.
 * - A missing asset NEVER blocks the project from opening (exit criteria):
 *   per-asset failures land in `missingAssets` with a reason.
 */

import type { EditorBridge } from "@studio/editor-bridge";

import {
  isUnknownCommandError,
  messageOf,
  readProjectSummary,
  runWithConcurrency,
  safeFileStem,
  withTimeout,
} from "./internal";
import {
  type EditorSessionClient,
  EditorSessionError,
  type LoadOutcome,
  type LoadProjectSessionOptions,
  type MissingAsset,
  parseManifest,
} from "./types";

const DEFAULT_ASSET_CONCURRENCY = 3;
const DEFAULT_ASSET_TIMEOUT_MS = 30_000;
const DEFAULT_PROJECT_FILE_TIMEOUT_MS = 60_000;

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== "function") {
    throw new EditorSessionError(
      "bad-args",
      `loadProjectSession: \`${label}\` must be an object with the editor-session client methods`,
    );
  }
}

function validateOptions(
  opts: LoadProjectSessionOptions,
): Required<
  Pick<LoadProjectSessionOptions, "assetConcurrency" | "assetTimeoutMs" | "projectFileTimeoutMs">
> &
  LoadProjectSessionOptions {
  const { bridge, client, projectId } = opts ?? {};
  if (!bridge || typeof bridge !== "object") {
    throw new EditorSessionError("bad-args", "loadProjectSession: `bridge` is required");
  }
  if (!client || typeof client !== "object") {
    throw new EditorSessionError("bad-args", "loadProjectSession: `client` is required");
  }
  for (const method of [
    "getManifest",
    "downloadProjectFile",
    "downloadAsset",
    "uploadVersion",
  ] as const) {
    requireFunction((client as unknown as Record<string, unknown>)[method], `client.${method}`);
  }
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new EditorSessionError(
      "bad-args",
      "loadProjectSession: `projectId` must be a non-empty string",
    );
  }
  const assetConcurrency = opts.assetConcurrency ?? DEFAULT_ASSET_CONCURRENCY;
  if (!Number.isSafeInteger(assetConcurrency) || assetConcurrency < 1 || assetConcurrency > 8) {
    throw new EditorSessionError(
      "bad-args",
      "loadProjectSession: `assetConcurrency` must be an integer 1..8",
    );
  }
  const assetTimeoutMs = opts.assetTimeoutMs ?? DEFAULT_ASSET_TIMEOUT_MS;
  if (!Number.isFinite(assetTimeoutMs) || assetTimeoutMs <= 0) {
    throw new EditorSessionError(
      "bad-args",
      "loadProjectSession: `assetTimeoutMs` must be a positive number",
    );
  }
  const projectFileTimeoutMs = opts.projectFileTimeoutMs ?? DEFAULT_PROJECT_FILE_TIMEOUT_MS;
  if (!Number.isFinite(projectFileTimeoutMs) || projectFileTimeoutMs <= 0) {
    throw new EditorSessionError(
      "bad-args",
      "loadProjectSession: `projectFileTimeoutMs` must be a positive number",
    );
  }
  return { ...opts, assetConcurrency, assetTimeoutMs, projectFileTimeoutMs };
}

/** Register one manifest asset into the editor's file table; resolves with the assigned path or rejects. */
async function registerAsset(
  bridge: EditorBridge,
  client: EditorSessionClient,
  asset: { id: string; name: string; downloadUrl: string },
  timeoutMs: number,
): Promise<string> {
  const blob = await withTimeout(
    `asset ${asset.id}: download`,
    timeoutMs,
    client.downloadAsset(asset.downloadUrl),
  );
  // §6.3: the bridge derives the stable virtual path from assetId+name and
  // resolves with the path the editor assigned — that return value is
  // authoritative, not the requested virtual path.
  return await bridge.addAsset({ assetId: asset.id, name: asset.name, bytes: blob });
}

/**
 * Load a cloud project into the editor. Runs once per editor open, after the
 * bridge reports ready. Throws `EditorSessionError` when the project cannot
 * open (manifest/download/open failures); per-asset failures do NOT throw —
 * they land in `missingAssets`.
 */
export async function loadProjectSession(opts: LoadProjectSessionOptions): Promise<LoadOutcome> {
  const o = validateOptions(opts);
  const { bridge, client, projectId } = o;

  await bridge.ready();

  const manifest = parseManifest(await client.getManifest(projectId));

  // -- assets, bounded concurrency, per-asset timeout, failures never block --
  const missingSlots: MissingAsset[] = new Array<MissingAsset | undefined>(
    manifest.assets.length,
  ).fill(undefined) as MissingAsset[];
  const assetPaths: Record<string, string> = {};
  if (manifest.assets.length > 0) {
    await runWithConcurrency(manifest.assets, o.assetConcurrency, async (asset, index) => {
      try {
        assetPaths[asset.id] = await registerAsset(bridge, client, asset, o.assetTimeoutMs);
      } catch (err) {
        missingSlots[index] = {
          asset,
          reason: `could not register asset: ${messageOf(err)}`,
        };
      }
    });
  }
  const missingAssets: MissingAsset[] = [];
  for (const slot of missingSlots) {
    if (slot !== undefined) missingAssets.push(slot);
  }

  // -- start from scratch (M2 follow-up): no version yet --
  // Nothing to download or open: the editor booted with its own default
  // empty project (`?empty`), which is exactly the state the user wants.
  // The first save creates v1 through the root-upload path (W3-G3).
  if (manifest.currentVersion === null) {
    const summary = await readProjectSummary(bridge).catch((err: unknown) => {
      throw new EditorSessionError(
        "open-failed",
        `the project did not open: ${messageOf(err)}`,
        { cause: err },
      );
    });
    return {
      openedPath: null,
      activeComp: summary.activeComp ?? null,
      missingAssets,
      assetPaths,
    };
  }

  // -- project snapshot → file table → open --
  // (parseManifest enforces the currentVersion/projectFileUrl pair; the
  // guard narrows the type for the download below.)
  if (manifest.projectFileUrl === null) {
    throw new EditorSessionError(
      "manifest-invalid",
      "getManifest: missing `projectFileUrl` for a versioned project",
    );
  }
  const projectBlob = await withTimeout(
    "project file download",
    o.projectFileTimeoutMs,
    client.downloadProjectFile(manifest.projectFileUrl),
  ).catch((err: unknown) => {
    throw new EditorSessionError(
      "project-file-failed",
      `could not download the project file: ${messageOf(err)}`,
      {
        cause: err,
      },
    );
  });

  const fileName = `${safeFileStem(manifest.project.slug || manifest.project.id)}.ecproj`;
  const openedPath = await bridge.addFile(projectBlob, fileName);

  try {
    // real editor: open the table file (restores the saved view with it)
    await bridge.execute("file.open", { path: openedPath });
  } catch (err) {
    if (!isUnknownCommandError(err)) {
      throw new EditorSessionError("open-failed", `file.open failed: ${messageOf(err)}`, {
        cause: err,
      });
    }
    // the deterministic fake editor auto-opens `.ecproj` on addFile instead —
    // verified below via project.summary.
  }

  let summary = await readProjectSummary(bridge).catch((err: unknown) => {
    throw new EditorSessionError("open-failed", `the project did not open: ${messageOf(err)}`, {
      cause: err,
    });
  });
  if (summary.path !== openedPath) {
    throw new EditorSessionError(
      "open-failed",
      `the editor reports an open project at ${JSON.stringify(summary.path)}, expected ${JSON.stringify(openedPath)}`,
    );
  }

  // -- best-effort active-comp restore (never fails the load) --
  if ((summary.activeComp ?? null) === null && summary.items.length > 0) {
    const first = summary.items[0];
    if (first !== undefined) {
      try {
        // upstream already restores the saved view inside `file.open`; this
        // covers projects saved without one (open the first item).
        await bridge.execute("comp.open", { comp: first.id });
        summary = await readProjectSummary(bridge);
      } catch {
        // best-effort only — the project is open either way
      }
    }
  }

  return {
    openedPath,
    activeComp: summary.activeComp ?? null,
    missingAssets,
    assetPaths,
  };
}
