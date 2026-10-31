/**
 * `createAutosaveController` — the M3.4 autosave/versioning engine
 * (BUILD_PLAN §M3 task 4, DECISIONS.md D-6):
 *
 * - save on explicit `Cmd/Ctrl+S` — the page calls `saveNow("manual")`;
 * - every 30 s while dirty — the tick below polls `project.summary` (the
 *   EditorState-ish dirty flag the engine reads; `editor.state` has no dirty
 *   field upstream or in the fake) and saves when the editor or the page
 *   (via `markDirty`) reports changes;
 * - after an agent apply — `saveNow("agent-apply")`;
 * - before close — `saveNow("before-close")`.
 *
 * Save path: `saveToBrowser(path)` → `readFile(path)` → SHA-256 →
 * `client.uploadVersion(projectId, { bytes, baseVersionId, sha256, label })`.
 * On success the internal current version advances (autosave chain) and
 * `hooks.onSaved` fires.
 *
 * 409 PROJECT_VERSION_CONFLICT is NEVER silently overwritten: the controller
 * parks (no further uploads, `saveNow` keeps returning
 * `{ saved: false, conflict: true }`), `hooks.onConflict` fires once, and
 * recovery is a reload with the server version (a new controller).
 *
 * Transient failures retry with backoff (up to `immediateRetries` immediate
 * retries, then the next tick); after `maxConsecutiveErrors` consecutive
 * failed attempts autosave parks (surfaced via `onError`) until an explicit
 * `saveNow` succeeds again.
 *
 * Timers use the global `setTimeout`/`clearTimeout` — `vi.useFakeTimers()`
 * makes the cadence deterministic in tests. No DOM polling, no sub-second
 * loops.
 */

import { SAVE_REASON_LABELS, labelForSaveReason, readProjectSummary, safeNotify } from "./internal";
import { sha256Hex } from "./sha256";
import {
  type AutosaveController,
  type AutosaveHooks,
  type CreateAutosaveControllerOptions,
  EditorSessionError,
  type SaveOutcome,
  type VersionRef,
  parseUploadResult,
  parseVersionRef,
} from "./types";

export const DEFAULT_AUTOSAVE_INTERVAL_MS = 30_000; // DECISIONS.md D-6
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
export const DEFAULT_IMMEDIATE_RETRIES = 2;

type Timer = ReturnType<typeof setTimeout>;

function validateOptions(
  opts: CreateAutosaveControllerOptions,
): Required<
  Pick<CreateAutosaveControllerOptions, "intervalMs" | "maxConsecutiveErrors" | "immediateRetries">
> &
  CreateAutosaveControllerOptions {
  const { bridge, client, projectId, baseVersion } = opts ?? {};
  if (!bridge || typeof bridge !== "object") {
    throw new EditorSessionError("bad-args", "createAutosaveController: `bridge` is required");
  }
  if (!client || typeof client !== "object") {
    throw new EditorSessionError("bad-args", "createAutosaveController: `client` is required");
  }
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new EditorSessionError(
      "bad-args",
      "createAutosaveController: `projectId` must be a non-empty string",
    );
  }
  // `null` baseVersion = a fresh project (start-from-scratch): the chain
  // head starts empty and the FIRST save uploads with baseVersionId null
  // (the gateway's root-upload path) and advances the head from there.
  if (baseVersion !== null) {
    parseVersionRef(baseVersion, "baseVersion");
  }
  if (
    opts.defaultSaveName !== undefined &&
    (typeof opts.defaultSaveName !== "string" || opts.defaultSaveName.length === 0)
  ) {
    throw new EditorSessionError(
      "bad-args",
      "createAutosaveController: `defaultSaveName` must be a non-empty string",
    );
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new EditorSessionError(
      "bad-args",
      "createAutosaveController: `intervalMs` must be a positive number",
    );
  }
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  if (!Number.isSafeInteger(maxConsecutiveErrors) || maxConsecutiveErrors < 1) {
    throw new EditorSessionError(
      "bad-args",
      "createAutosaveController: `maxConsecutiveErrors` must be an integer ≥ 1",
    );
  }
  const immediateRetries = opts.immediateRetries ?? DEFAULT_IMMEDIATE_RETRIES;
  if (!Number.isSafeInteger(immediateRetries) || immediateRetries < 0 || immediateRetries > 10) {
    throw new EditorSessionError(
      "bad-args",
      "createAutosaveController: `immediateRetries` must be an integer 0..10",
    );
  }
  return { ...opts, intervalMs, maxConsecutiveErrors, immediateRetries };
}

export function createAutosaveController(
  opts: CreateAutosaveControllerOptions,
): AutosaveController {
  const o = validateOptions(opts);
  const hooks: AutosaveHooks = o.hooks ?? {};
  /** File-table name for the FIRST save of a fresh project (no session path). */
  const defaultSaveName = o.defaultSaveName ?? "project.ecproj";

  let disposed = false;
  /** 409 park — terminal: only a new controller (reload) recovers. */
  let parkedConflict = false;
  /** hard-error park — an explicit successful `saveNow` un-parks. */
  let parkedErrors = false;
  let consecutiveErrors = 0;
  /** proactive dirtiness flagged by the page (e.g. an applied agent batch). */
  let proactiveDirty = false;
  /** the editor's own dirty flag as of the last `project.summary` read. */
  let editorDirty = false;
  let currentVersion: VersionRef | null = o.baseVersion;
  let timer: Timer | null = null;
  let inFlight: Promise<SaveOutcome> | null = null;

  function ensureTimer(): void {
    if (disposed || timer !== null) return;
    if (parkedConflict || parkedErrors) return; // parked: no further ticks
    timer = setTimeout(tick, o.intervalMs);
  }

  /** Parked controllers stop ticking entirely — a pending tick is cancelled. */
  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * One save attempt: read the editor state, persist, hash, upload.
   * Conflicts resolve (never throw); every other failure throws for the
   * retry chain. Never uploads when nothing is dirty.
   */
  async function saveOnce(reason: string, agentRunId?: string): Promise<SaveOutcome> {
    const summary = await readProjectSummary(o.bridge);
    editorDirty = summary.dirty === true;
    const path = summary.path;
    // A fresh project has no session path yet (nothing was ever opened) —
    // saveAs under the default name instead of refusing to save. After the
    // first save the editor carries the path and this branch never fires.
    const freshPath =
      typeof path === "string" && path.length > 0
        ? path
        : currentVersion === null
          ? `/${defaultSaveName.replace(/^\/+/, "")}`
          : null;
    if (freshPath === null) {
      throw new EditorSessionError(
        "no-project-open",
        "cannot save: no project is open in the editor",
      );
    }
    if (!summary.dirty && !proactiveDirty) {
      return { saved: false }; // never upload when not dirty
    }

    // Passing the gate makes the cloud OWED this save: the editor may report
    // itself clean mid-flight (upstream `file.save*` calls `mark_saved()`, so
    // `project.summary` flips dirty→clean the moment we persist locally) —
    // retries of a failed upload must never silently no-op on the new state.
    // `proactiveDirty` stays set until the upload lands (or dedupes).
    proactiveDirty = true;

    const saved = await o.bridge.saveToBrowser(freshPath);
    const savePath =
      typeof saved.path === "string" && saved.path.length > 0 ? saved.path : freshPath;
    const bytes = await o.bridge.readFile(savePath);
    const sha256 = await sha256Hex(bytes);

    // The editor's dirty flag may outlive a save upstream (BP M0 risk: "saveToBrowser
    // may not mark the project clean"); identical content never creates a new version
    // (a fresh project has no head to dedup against — the first save always uploads).
    if (currentVersion !== null && sha256 === currentVersion.sha256) {
      proactiveDirty = false;
      safeNotify(hooks.onSaved, currentVersion);
      return { saved: true, version: currentVersion };
    }

    const result = parseUploadResult(
      await o.client.uploadVersion(o.projectId, {
        bytes,
        baseVersionId: currentVersion?.id ?? null,
        sha256,
        label: labelForSaveReason(reason),
        ...(agentRunId !== undefined ? { agentRunId } : {}),
      }),
    );

    if (result.ok) {
      currentVersion = result.version; // the autosave chain advances
      proactiveDirty = false;
      editorDirty = false;
      consecutiveErrors = 0;
      parkedErrors = false; // an explicit save that lands resumes the cadence
      safeNotify(hooks.onSaved, result.version);
      return { saved: true, version: result.version };
    }

    if ("conflict" in result) {
      // NEVER silent overwrite: park, tell the page, stop touching the server.
      parkedConflict = true;
      cancelTimer();
      safeNotify(hooks.onConflict, result.serverVersion ?? null);
      return { saved: false, conflict: true };
    }

    throw result.error;
  }

  /** The save attempt + up to `immediateRetries` immediate retries (backoff = next tick). */
  async function attemptSaveWithRetries(reason: string, agentRunId?: string): Promise<SaveOutcome> {
    let lastError: unknown = undefined;
    for (let attempt = 0; attempt <= o.immediateRetries; attempt++) {
      try {
        return await saveOnce(reason, agentRunId);
      } catch (err) {
        lastError = err;
        safeNotify(hooks.onError, err);
        consecutiveErrors++;
        if (consecutiveErrors >= o.maxConsecutiveErrors) {
          parkedErrors = true;
          cancelTimer();
          const parkError = new EditorSessionError(
            "autosave-parked",
            `autosave parked after ${consecutiveErrors} consecutive failed save attempts; an explicit saveNow can resume it`,
            { cause: err },
          );
          safeNotify(hooks.onError, parkError);
          return { saved: false, error: parkError };
        }
      }
    }
    return { saved: false, error: lastError };
  }

  /**
   * Single-flight entry for both the tick and `saveNow`.
   * Never rejects; conflicts/disposed resolve as outcomes.
   *
   * `explicit` (the saveNow path): when a save is already in flight, do NOT
   * adopt its outcome — the in-flight save read the editor bytes BEFORE the
   * caller's latest edits, so a before-close that dedupes onto it would
   * answer `{ saved: true }` for STALE bytes and the page would close with
   * the newer edits unuploaded (w3-b06). Instead chain a FRESH save behind
   * the in-flight one: the `finally` below nulls `inFlight` before the chain
   * re-enters, so the chained call reads the CURRENT bytes. The tick keeps
   * the plain dedupe — the next tick re-reads the editor anyway.
   */
  function startSave(reason: string, explicit = false, agentRunId?: string): Promise<SaveOutcome> {
    if (inFlight !== null) {
      if (!explicit) return inFlight; // dedup: the tick rides the running save
      return inFlight.then(
        () => startSave(reason, explicit, agentRunId),
        () => startSave(reason, explicit, agentRunId),
      );
    }
    if (parkedConflict) return Promise.resolve({ saved: false, conflict: true });
    if (disposed) {
      return Promise.resolve({
        saved: false,
        error: new EditorSessionError("disposed", "saveNow: the autosave controller was disposed"),
      });
    }
    const outcome = attemptSaveWithRetries(reason, agentRunId).finally(() => {
      inFlight = null;
      ensureTimer(); // keep the cadence (no-op while parked/disposed)
    });
    inFlight = outcome;
    return outcome;
  }

  function tick(): void {
    timer = null;
    if (disposed || parkedConflict || parkedErrors) return;
    if (inFlight !== null) return; // single-flight: the running save reschedules itself
    void startSave("autosave");
  }

  const controller: AutosaveController = {
    get dirty(): boolean {
      return proactiveDirty || editorDirty;
    },

    markDirty(reason?: string): void {
      // `reason` is diagnostic only — save labels come from the save call.
      void reason;
      proactiveDirty = true;
    },

    saveNow(reason: string, options?: { agentRunId?: string }): Promise<SaveOutcome> {
      // Explicit saves (manual/agent-apply/before-close) are allowed while
      // parked on hard errors; a success un-parks. Conflict parks are terminal.
      // Explicit saves never ADOPT an in-flight save's outcome — see
      // startSave (w3-b06): they chain a fresh save that reads current bytes.
      // The agent-apply moment threads `agentRunId` so the uploaded version
      // row carries its owning run (the gateway's apply scope guard, §9.3).
      return startSave(reason, true, options?.agentRunId);
    },

    currentVersion(): VersionRef | null {
      // The honest chain head — the M5 reapply-drift gate reads this.
      if (disposed) return null;
      return currentVersion;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      // the controller attaches no bridge listeners; an in-flight save settles
      // so a `before-close` await still resolves.
    },
  };

  ensureTimer();
  return controller;
}

export { SAVE_REASON_LABELS };

// Re-export the seam types the host page and tests import from this module.
export type { AutosaveController, AutosaveHooks } from "./types";
