// @studio/worker — the per-job pipeline (BUILD_PLAN §M8 task 1; the heart).
//
// runJob(deps, scopedRender) takes a claimed (already `running`) row through:
//
//   re-read ──cancel_requested──▶ cancelled + refundAll
//      │
//   D-2 gate (mp4|png-seq only) ─▶ failed RENDER_UNSUPPORTED_FORMAT
//      │
//   hydrate (spike §4) ─▶ RENDER_PROJECT_INVALID / RENDER_ASSET_MISSING
//      │                  (never spawns the CLI — it renders placeholders
//      │                   as success, spike §4)
//   spawn studio-cli (spike §2 argv) in the confined workdir
//      │
//   monitor: progress → heartbeat (monotonic, ~1/s) · cancel poll (~2s,
//      │   cooperative: kill → cancelled + refundAll) · hard timeout
//      │   (env.render.jobTimeoutSeconds → kill → failed RENDER_TIMEOUT)
//      │
//   success ─▶ move output to the §9.2 object key (mp4 | zipped png-seq),
//      │       markCompleted({objectKey,sizeBytes,expiresAt = plan
//      │       retention}) ─▶ ledger.settle commits the ACTUAL cost and
//      │       releases the FULL hold (D-20).
//   failure ─▶ markFailed(typed code, sanitized copy) + refundAll.
//
// Idempotency / crash recovery (§M8 exit criteria): the object key is
// deterministic (`row.objectKey ?? renderKey(...)`), so a re-run after a
// crash OVERWRITES the same object — no duplicate outputs; `markCompleted` on
// an already-terminal row is a typed CONFLICT caught here → already-done.
// Every ledger call is idempotency-keyed (`render:settle:<id>` /
// `render:refund:<id>`), so attempt N and attempt N+1 can never double-charge.

import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { type RenderFormatId, entitlementsFor } from "@studio/config";
import { MAX_RENDER_FRAMES, RENDER_SETTINGS_SCHEMA } from "@studio/contracts";
import { isDbError } from "@studio/db";

import {
  type KillReason,
  type ProgressLine,
  type RenderCliHandle,
  buildRenderArgs,
  renderOutputPaths,
  resolveCliPath,
  resolveRenderKnobs,
  spawnRenderCli,
} from "./cli.js";
import { actualCostUc } from "./cost.js";
import type { ScopedRenderRow, WorkerDeps, WorkerLogFields, WorkerLogger } from "./deps.js";
import { type RenderFailureCode, RenderJobError, failureText, isRenderJobError } from "./errors.js";
import { hydrateJob } from "./hydrate.js";
import { defaultRepoRoot, outputObjectKey } from "./storage.js";
import { type ZipEntry, zipStore } from "./zip.js";

/** Cooperative-cancel poll cadence (dispatch: "poll row every ~2s"). */
const CANCEL_POLL_MS = 2_000;
/** Monitor tick — deadline resolution for timeout/cancel checks. */
const MONITOR_TICK_MS = 250;
const DAY_MS = 86_400_000;

export type RenderJobOutcome =
  | {
      readonly renderId: string;
      readonly outcome: "completed";
      readonly objectKey: string;
      readonly sizeBytes: number;
      readonly costUc: number;
      /** True when this attempt found the row already terminal (crash re-run). */
      readonly alreadyDone: boolean;
    }
  | {
      readonly renderId: string;
      readonly outcome: "failed";
      readonly errorCode: RenderFailureCode;
    }
  | { readonly renderId: string; readonly outcome: "cancelled" }
  | { readonly renderId: string; readonly outcome: "lost" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Render-id-scoped logger view (fixed fields, never row payloads). */
function forRender(logger: WorkerLogger, renderId: string): WorkerLogger {
  const withId = (fields?: WorkerLogFields): WorkerLogFields | undefined =>
    fields === undefined ? { renderId } : { ...fields, renderId };
  return {
    debug: (msg, fields) => logger.debug(msg, withId(fields)),
    info: (msg, fields) => logger.info(msg, withId(fields)),
    warn: (msg, fields) => logger.warn(msg, withId(fields)),
    error: (msg, fields) => logger.error(msg, withId(fields)),
  };
}

/**
 * Run ONE claimed render job to a terminal outcome. Never throws — every
 * failure lands the row in a terminal state (or `lost` when the row stopped
 * being ours) and the promise resolves with the typed outcome.
 */
export async function runJob(
  deps: WorkerDeps,
  claimed: ScopedRenderRow,
): Promise<RenderJobOutcome> {
  const log = forRender(deps.logger, claimed.id);
  const ws = claimed.workspaceId;
  const refundKey = `render:refund:${claimed.id}`;
  const refundAll = async (reason: string): Promise<void> => {
    try {
      await deps.ledger.refundAll(ws, {
        renderId: claimed.id,
        idempotencyKey: refundKey,
        metadata: { reason },
      });
      log.info("render_refunded", { reason });
    } catch (error) {
      log.error("render_refund_failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const fail = async (code: RenderFailureCode, raw?: string): Promise<RenderJobOutcome> => {
    if (raw !== undefined) log.warn("render_failed_raw", { code, raw: raw.slice(0, 400) });
    try {
      await deps.repos.renders.markFailed(ws, claimed.id, {
        error: failureText(code),
        errorCode: code,
      });
      await refundAll(code);
      return { renderId: claimed.id, outcome: "failed", errorCode: code };
    } catch (error) {
      // The row stopped being ours mid-transition (sweep/operator) — the
      // failure state is owned elsewhere now; nothing more to do here.
      log.error("render_mark_failed_conflict", {
        code,
        error: error instanceof Error ? error.message : String(error),
      });
      return { renderId: claimed.id, outcome: "lost" };
    }
  };

  let workdir: string | null = null;
  try {
    // Re-read: the claim flipped queued→running, but cancel_requested may
    // have landed before/at claim time — the fresh row is the truth.
    const row = await deps.repos.renders.get(ws, claimed.id);
    if (row.cancelRequested) {
      await deps.repos.renders.markCancelled(ws, claimed.id);
      await refundAll("cancelled_before_start");
      return { renderId: claimed.id, outcome: "cancelled" };
    }

    // D-2: v1 renders mp4 + png-seq only. The API gates this at queue time;
    // a legacy row must never reach the CLI with another format.
    if (row.format !== "mp4" && row.format !== "png-seq") {
      return await fail("RENDER_UNSUPPORTED_FORMAT", `format=${row.format}`);
    }
    const format: RenderFormatId = row.format;

    const settings = RENDER_SETTINGS_SCHEMA.safeParse(row.settingsJson ?? {});
    if (!settings.success) {
      return await fail("RENDER_PROJECT_INVALID", "settings failed schema");
    }

    const version = await deps.repos.versions.getById(ws, row.versionId).catch(() => null);
    if (version === null) {
      return await fail("RENDER_PROJECT_INVALID", "version missing");
    }

    // ── Hydration (spike §4) — fails typed BEFORE any CLI spawn ────────────
    const hydrated = await hydrateJob({
      storage: deps.storage,
      assets: deps.repos.assets,
      repoRoot: defaultRepoRoot(),
      workspaceId: ws,
      row: { id: row.id, projectId: row.projectId, compId: row.compId },
      version: { objectKey: version.objectKey },
    });
    workdir = hydrated.workdir;

    // ── Spawn (spike §2 argv, resolved binary per spike §1) ────────────────
    const repoRoot = defaultRepoRoot();
    const cli = resolveCliPath(deps.env.render.cliPath, repoRoot);
    const knobs = resolveRenderKnobs({ format, settings: settings.data, comp: hydrated.comp });
    // BIL-06/ENG-05 (host-side frame-count guard): the gateway refuses
    // over-ceiling jobs at QUEUE time, but legacy rows queued before that
    // guard (and any path that bypasses the quote) stop HERE — typed, before
    // any CLI spawn, so the hold refunds instead of burning worker CPU.
    if (Math.ceil(knobs.effective.outputSeconds * knobs.effective.fps) > MAX_RENDER_FRAMES) {
      return await fail(
        "RENDER_QUOTA_EXCEEDED",
        `frames>${MAX_RENDER_FRAMES} (seconds=${knobs.effective.outputSeconds}, fps=${knobs.effective.fps})`,
      );
    }
    const paths = renderOutputPaths(format, hydrated.workdir);
    const args = buildRenderArgs({
      projectPath: hydrated.projectPath,
      outPath: paths.outPath,
      compId: row.compId,
      cliFormat: knobs.cliFormat,
      flags: knobs.flags,
    });

    let killReason: KillReason | null = null;
    let heartbeatBusy = false;
    let lostOwnership = false;

    log.info("render_spawn", {
      format,
      cliSource: cli.source,
      assets: hydrated.assetCount,
      longEdgePx: knobs.effective.longEdgePx,
      fps: knobs.effective.fps,
      quality: knobs.effective.quality,
    });
    const handle: RenderCliHandle = spawnRenderCli({
      cliPath: cli.path,
      args,
      cwd: hydrated.workdir,
      onProgress: (progress) => {
        void sendHeartbeat({
          framesDone: progress.framesDone,
          framesTotal: progress.framesTotal,
        });
      },
    });

    async function sendHeartbeat(
      progress?: Pick<ProgressLine, "framesDone" | "framesTotal">,
    ): Promise<void> {
      if (heartbeatBusy || lostOwnership) return;
      heartbeatBusy = true;
      try {
        await deps.repos.renders.heartbeat(ws, claimed.id, progress);
      } catch (error) {
        if (isDbError(error) && error.code === "CONFLICT") {
          // No longer running under our hands (the stale sweep requeued it):
          // stop rendering, transition nothing — the row has a new owner.
          lostOwnership = true;
          killReason = "lost";
          handle.kill("lost");
          log.warn("render_ownership_lost", {});
        } else {
          log.warn("render_heartbeat_error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        heartbeatBusy = false;
      }
    }

    // ── Monitor: progress → heartbeat · cancel poll · hard timeout ─────────
    const deadlineAt = Date.now() + deps.env.render.jobTimeoutSeconds * 1000;
    let lastCancelPoll = 0;
    for (;;) {
      const tick = await Promise.race([
        handle.done,
        sleep(MONITOR_TICK_MS).then(() => "tick" as const),
      ]);
      if (tick !== "tick") break;
      const now = Date.now();
      if (killReason === null && now >= deadlineAt) {
        killReason = "timeout";
        handle.kill("timeout");
        log.warn("render_timeout_kill", { budgetSeconds: deps.env.render.jobTimeoutSeconds });
        continue;
      }
      if (killReason === null && now - lastCancelPoll >= CANCEL_POLL_MS) {
        lastCancelPoll = now;
        try {
          const current = await deps.repos.renders.get(ws, claimed.id);
          if (current.cancelRequested) {
            killReason = "cancel";
            handle.kill("cancel");
            log.info("render_cancel_kill", {});
            continue;
          }
          // Liveness even when the CLI emits no progress lines (a silent
          // renderer must never look stale to the sweep).
          void sendHeartbeat();
        } catch (error) {
          log.warn("render_cancel_poll_error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const result = await handle.done;

    if (result.kind === "killed") {
      if (result.reason === "cancel") {
        try {
          await deps.repos.renders.markCancelled(ws, claimed.id);
          await refundAll("cancelled");
          return { renderId: claimed.id, outcome: "cancelled" };
        } catch (error) {
          log.error("render_mark_cancelled_conflict", {
            error: error instanceof Error ? error.message : String(error),
          });
          return { renderId: claimed.id, outcome: "lost" };
        }
      }
      if (result.reason === "timeout") {
        return await fail("RENDER_TIMEOUT");
      }
      return { renderId: claimed.id, outcome: "lost" };
    }

    if (result.kind === "failure") {
      return await fail(result.code, result.raw);
    }

    // ── Success: move the output, mark completed, settle (D-20) ───────────
    let output: Buffer;
    let contentType: string;
    if (paths.seqDir !== null) {
      const seqDir = paths.seqDir;
      const frames = (await readdir(seqDir).catch(() => []))
        .filter((name) => name.endsWith(".png"))
        .sort();
      if (frames.length === 0) {
        return await fail("RENDER_CLI_FAILED", "no sequence frames written");
      }
      const entries: ZipEntry[] = await Promise.all(
        frames.map(async (name) => ({ name, data: await readFile(join(seqDir, name)) })),
      );
      output = zipStore(entries);
      contentType = "application/zip";
    } else {
      const mp4Path = paths.mp4Path;
      if (mp4Path === null) throw new RenderJobError("RENDER_INTERNAL", { raw: "mp4 path" });
      const file = await readFile(mp4Path).catch(() => null);
      if (file === null) {
        return await fail("RENDER_CLI_FAILED", "no mp4 written");
      }
      output = file;
      contentType = "video/mp4";
    }

    const objectKey = outputObjectKey(row, ws);
    await deps.storage.driver.put(objectKey, output, { contentType });

    // Retention by plan (a missing subscription = trial — dispatch pin).
    const subscription = await deps.repos.subscriptions.getByOrganization(ws);
    const retentionDays = entitlementsFor(subscription?.planId ?? "trial").renderRetentionDays;
    const expiresAt = new Date(Date.now() + retentionDays * DAY_MS);

    let alreadyDone = false;
    try {
      await deps.repos.renders.markCompleted(ws, claimed.id, {
        objectKey,
        sizeBytes: output.length,
        expiresAt,
      });
    } catch (error) {
      if (isDbError(error) && error.code === "CONFLICT") {
        // Crash-recovery double-run: a previous attempt already terminal-
        // transitioned this row (same deterministic key — the put above just
        // overwrote identical bytes). Treat as already-done; the idempotent
        // settle below still runs.
        alreadyDone = true;
        log.info("render_already_terminal", {});
      } else {
        throw error;
      }
    }

    // ACTUAL cost (D-12): observed frames / effective fps, effective long
    // edge, effective quality — the SAME single formula as estimate/reserve.
    const after = await deps.repos.renders.get(ws, claimed.id);
    const cost = actualCostUc({
      format,
      framesTotal: after.framesTotal,
      fps: knobs.effective.fps,
      rangeSeconds: knobs.effective.outputSeconds,
      longEdgePx: knobs.effective.longEdgePx,
      quality: knobs.effective.quality,
    });
    try {
      await deps.ledger.settle(ws, {
        renderId: claimed.id,
        actualCost: cost.totalUc,
        idempotencyKey: `render:settle:${claimed.id}`,
        metadata: {
          format,
          framesTotal: after.framesTotal,
          outputSeconds: cost.outputSeconds,
          longEdgePx: knobs.effective.longEdgePx,
          quality: knobs.effective.quality,
        },
      });
    } catch (error) {
      // The render IS completed (row already terminal) — a settle failure
      // is a bookkeeping outage: logged loudly, never a row rollback.
      log.error("render_settle_failed", {
        actualCostUc: cost.totalUc,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log.info("render_completed", {
      objectKey,
      sizeBytes: output.length,
      costUc: cost.totalUc,
      retentionDays,
      alreadyDone,
    });
    return {
      renderId: claimed.id,
      outcome: "completed",
      objectKey,
      sizeBytes: output.length,
      costUc: cost.totalUc,
      alreadyDone,
    };
  } catch (error) {
    if (isRenderJobError(error)) {
      return await fail(error.code, error.raw);
    }
    return await fail("RENDER_INTERNAL", error instanceof Error ? error.message : String(error));
  } finally {
    if (workdir !== null) {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
