// apps/worker/src/processor.ts — the worker's composition root (W7-L).
//
// §3.2 COMPOSE BOUNDARY (task-pinned): the engine pool runs as its OWN service
// (§3.1 table: "engine-pool … spawning photocraft-cli serve"). The worker never
// imports apps/engine-pool — it talks to the pool through the
// `SessionAllocatorLike` seam below. The DEFAULT allocator is the engine-pool
// HTTP/IPC service client, a DOCUMENTED STUB here (TODO(W9): the pool's service
// contract lands in Wave 9; until then every non-mock allocation fails with the
// typed `engine_unavailable` envelope — never a silent fallback). Local dev is
// fully served by the MockEngineAdapter (MOCK_ENGINE=1 or a missing engine
// binary): it spawns the protocol-faithful apps/mock-engine (W2-F) and drives
// it through the REAL @studio/engine-client facade, so the §3.2 session shape
// (allocate → attach → run → release) is exercised end to end.
//
// §3.4 RECOVERY WIRING (W6-M flags, closed here): the RunRecoveryService
// (src/recovery/run-recovery.ts) is bridged onto the run manager's
// EngineCrashRecovery hook — shouldResume() routes crash-class failures onto the
// resume path, recoverRun() replays the WAL to the checkpoint and resumes ONCE,
// and recoveryActionForJob() maps the outcome onto BullMQ behaviour
// (continue / throw_for_retry / complete_failed). The queue-side attempt
// budget (classifyJobAttempt) is wired in src/index.ts.
//
// Spec anchors: §3.1 services, §3.2 sessions, §3.3 lifecycle, §3.4 failure
// semantics, §5.3 model routing, §5.6 command log, §6.2 ToolContext, §14.2
// refunds. Deep-import note: see run-manager/deps.ts (@studio/agent does not
// re-export the Wave-6 service directories as subpaths; the worker follows the
// relative-source precedent only where the run manager already does — this
// file sticks to the public barrels).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect as connectSocket, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  EngineClient,
  generateControlToken,
  type DocSaveResult,
  type DocumentInspect,
  type EngineOutcome as ClientOutcome,
  type RenderResult,
} from "@studio/engine-client";
import { MAX_MUTATING_COMMANDS_PER_RUN } from "@studio/config";
import {
  RunEventBus,
  type EventStoreLike,
  type StoredEventAppend,
  type StoredEventRow,
} from "@studio/agent";
import { releaseReservation, type LedgerStore } from "@studio/billing";
import {
  type Storage,
  createStorageFromEnv,
  isStorageError,
  type StorageResult,
} from "@studio/storage";
import {
  DEFAULT_TOOL_MANIFEST,
  buildDefaultToolRegistry,
  validateDocument,
  visionCritiqueTool,
  workspaceSnapshot,
  type AnyTool,
  type AssetRecord,
  type AssetStoreLike,
  type BudgetTracker as ToolBudgetTracker,
  type EngineLike,
  type EngineCommand,
  type EngineDocumentSnapshot,
  type EngineLayerSummary,
  type EngineOutcome as ToolEngineOutcome,
  type TemplateCatalogLike,
  type TemplateSummary,
  type ToolContext,
  type ToolListing,
  type ToolResult,
} from "@studio/tools";
import {
  agentRuns,
  assets as assetsTable,
  commands as commandsTable,
  createDb,
  creditReservations,
  creditsLedger,
  documents as documentsTable,
  documentVersions,
  runEvents,
  workspaceTemplates,
  type Db,
} from "@studio/db";
import type { Logger } from "./logger.js";
import type { ObjectStorage, PreviewPipeline, PreviewRenderReply } from "./preview.js";
import type { AcquireEngineSessionInput, EngineSessionHandle, RunManagerEnv } from "./run-manager/deps.js";
import { StudioRunProcessor } from "./run-manager/processor.js";
import type {
  CreateModelAdaptersInput,
  CreateToolContextInput,
  EmitRunEvent,
  EngineCrashRecovery,
  EngineRecoveryRequest,
  EngineRecoveryResult,
  ModelAdapterFactory,
  RunCancellationSource,
  RunManagerDeps,
  ToolContextBundle,
  ToolContextFactory,
  TransactionSeams,
} from "./run-manager/deps.js";
import type { TierBudgetTracker } from "../../../../packages/agent/src/budgets-service/tracker-factory.js";
import type { CriticToolLike } from "../../../../packages/agent/src/critic/service.js";
import type { ValidateToolLike } from "../../../../packages/agent/src/validator/service.js";
import type { SnapshotLike, SnapshotReport } from "../../../../packages/agent/src/observer/observer.js";
import {
  createInMemoryResumeGate,
  type AttachExecutorLike,
  type AttachOutcome,
  type PoolLike,
  type ReallocationRequest,
  type RecoveryCheckpoint,
  type RefundLike,
  type RefundRequest,
  type RefundOutcome,
  type ReplayCommand,
  type ReplacementSession,
  type RunRecoveryOutcome,
  type RunRecoveryServiceDepsLike,
  RunRecoveryService,
  type WalReadLike,
  type WorkerWalEntry,
} from "./recovery/run-recovery.js";
import { classifyJobAttempt, recoveryActionForJob, shouldResume } from "./recovery/job-retry.js";
import type { RunRecoveryDeps } from "./recovery/run-recovery.js";

// ---------------------------------------------------------------------------
// PART 1 — the W1-I processor seam contract (UNCHANGED, re-exported verbatim)
// ---------------------------------------------------------------------------

/** Typed error envelope (docs/AGENTS.md error convention). */
export interface RunError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** §5.1 outcome vocabulary, including `succeeded_with_warnings` after exhausted repairs. */
export type RunStatus = "succeeded" | "succeeded_with_warnings" | "failed";

export interface RunOutcome {
  readonly status: RunStatus;
  /** Credits actually charged (reservation commit, §3.3 step 6). */
  readonly creditsUsed?: number;
  /** Committed engine checkpoint/document version, when the run advanced the document. */
  readonly documentCheckpointId?: string;
  /** Non-blocking issues surfaced to the user (§5.1). */
  readonly warnings?: readonly string[];
  /** Required when status is "failed". */
  readonly error?: RunError;
}

/** Everything a processor needs about one run job; BullMQ details stay outside. */
export interface RunJobContext {
  readonly jobId: string;
  readonly payload: import("./queues.js").RunJobPayload;
  /** 1-based attempt (BullMQ attempts budget: `JOB_RETRY` in src/queues.ts). */
  readonly attempt: number;
  /** Aborts at the tier wall clock (§5.2); processors must poll and forward it. */
  readonly signal: AbortSignal;
}

/** Implementations run one agent run end-to-end (§5.1). */
export interface RunProcessor {
  process(job: RunJobContext): Promise<RunOutcome>;
}

/** Thrown to hand a retryable failure back to BullMQ's backoff retries (§3.4). */
export class RetryableRunFailureError extends Error {
  readonly runError: RunError;

  constructor(runError: RunError) {
    super(`retryable run failure: ${runError.code}`);
    this.name = "RetryableRunFailureError";
    this.runError = runError;
  }
}

// ---------------------------------------------------------------------------
// PART 2 — wiring env (Zod at the boundary; secrets never echoed, §4/§15.2)
// ---------------------------------------------------------------------------

/** Env keys this composition root reads; `RunManagerEnv` is the loose carrier. */
const wiringEnvSchema = z.object({
  /** Explicit mock opt-in for local dev (any of "1", "true", "yes"). */
  MOCK_ENGINE: z.string().trim().optional(),
  /** Connect mode: drive an already-running mock-engine (demo-connect precedent). */
  MOCK_ENGINE_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  /** 64-hex control token of the engine in connect mode (§3.2 token). */
  MOCK_ENGINE_TOKEN: z.string().trim().optional(),
  /**
   * Engine binary (§3.2 photocraft-cli). Optional HERE on purpose: a missing
   * binary downgrades the worker to the documented mock adapter for local dev.
   */
  ENGINE_BINARY_PATH: z.string().trim().optional(),
  /** Postgres for the run/ledger/event rows (§3.1 db). */
  DATABASE_URL: z.string().trim().optional(),
  /** Object storage driver (§3.1 objects; @studio/storage env contract). */
  STORAGE_DRIVER: z.string().trim().optional(),
});

export type WiringEnv = z.infer<typeof wiringEnvSchema>;

/** Parses the loose env record; never echoes values (§15.2). */
export function parseWiringEnv(env: RunManagerEnv): WiringEnv {
  return wiringEnvSchema.parse(env);
}

/** Why a binding was chosen — surfaced in the boot log, never in user envelopes. */
export interface EngineBinding {
  readonly mode: "mock" | "pool";
  readonly reason: "mock_env" | "engine_binary_missing" | "engine_binary_present";
}

/**
 * §3.2 binding decision (task-pinned, mock-friendly): MOCK_ENGINE=1 forces the
 * mock adapter; otherwise a MISSING engine binary (unset, or not a file on
 * disk) also falls back to the mock so local dev boots without a Rust build.
 * A present binary selects the pool service path.
 */
export function resolveEngineBinding(env: RunManagerEnv): EngineBinding {
  const parsed = parseWiringEnv(env);
  const mockFlag = ["1", "true", "yes"].includes((parsed.MOCK_ENGINE ?? "").toLowerCase());
  if (mockFlag) {
    return { mode: "mock", reason: "mock_env" };
  }
  const binary = parsed.ENGINE_BINARY_PATH;
  const binaryPresent = binary !== undefined && binary.length > 0 && existsSync(binary);
  return binaryPresent
    ? { mode: "pool", reason: "engine_binary_present" }
    : { mode: "mock", reason: "engine_binary_missing" };
}

// ---------------------------------------------------------------------------
// PART 3 — the engine-code → tool-code mapper (§6.1 shared catalog)
// ---------------------------------------------------------------------------

/** Engine-client facade codes → shared §13.3 codes (+ retryability), add-only. */
const ENGINE_CODE_TO_TOOL: Readonly<Record<string, { code: string; retryable: boolean }>> = {
  engine_unavailable: { code: "engine_unavailable", retryable: true },
  engine_command_failed: { code: "engine_unavailable", retryable: false },
  reply_timeout: { code: "engine_timeout", retryable: true },
  frame_too_large: { code: "engine_unavailable", retryable: false },
  auth_rejected: { code: "engine_unavailable", retryable: false },
  session_limit_reached: { code: "engine_unavailable", retryable: true },
  path_outside_capability_root: { code: "engine_unavailable", retryable: false },
  unknown_command: { code: "engine_unavailable", retryable: false },
  plan_ceiling_exceeded: { code: "engine_unavailable", retryable: false },
  engine_crashed: { code: "engine_crashed", retryable: false },
  connection_dropped_mid_call: { code: "engine_crashed", retryable: true },
  call_aborted: { code: "engine_unavailable", retryable: true },
};

/** Failure codes that evidence a dead session (§3.4 crash classification). */
const CRASH_CLASS_CODES: ReadonlySet<string> = new Set(["engine_crashed", "reply_timeout"]);

interface ClientFailureView {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** Normalizes the engine-client failure union into the leak-free view above. */
function clientFailure(outcome: ClientOutcome<unknown>): ClientFailureView | null {
  if (outcome.ok) {
    return null;
  }
  const failure = outcome as { code?: unknown; message?: unknown; hint?: unknown };
  const code = typeof failure.code === "string" ? failure.code : "engine_unavailable";
  const message =
    typeof failure.message === "string" && failure.message.length > 0
      ? failure.message
      : "The engine call failed";
  const hint = typeof failure.hint === "string" ? failure.hint : undefined;
  const mapped = ENGINE_CODE_TO_TOOL[code] ?? { code: "engine_unavailable", retryable: false };
  return { code: mapped.code, message, hint, retryable: mapped.retryable };
}

// ---------------------------------------------------------------------------
// PART 4 — the engine-session adapter (the W6-N `engine-session.ts` gap, filled
// here because the run-manager directory is not this task's to edit)
// ---------------------------------------------------------------------------

export interface EngineSessionBinding {
  /** The bound engine client (mock spawn or the pool's session endpoint). */
  readonly client: EngineClient;
  /** Session write root when this process owns it (mock mode); null on the pool. */
  readonly writeRoot: string | null;
  /** The spawned mock child, when this process owns the engine. */
  readonly child: ChildProcess | null;
  /** Logs-only teardown for the child process (the client's close is separate). */
  readonly dispose: () => Promise<void>;
}

/** Boot dependency for a fresh engine process (typed, never a raw throw). */
export interface EngineBindingFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type EngineBindingOutcome = EngineBindingFailure | { readonly ok: true; readonly value: EngineSessionBinding };

const MOCK_ENTRY_DEFAULT = fileURLToPath(new URL("../../mock-engine/src/index.mjs", import.meta.url));

/** Spawns (or connects to) one mock-engine process (apps/mock-engine, W2-F). */
async function bindMockEngine(
  options: { readonly port?: number; readonly token?: string; readonly sessionId: string },
  logger: Logger,
): Promise<EngineBindingOutcome> {
  if (options.port !== undefined && options.port > 0) {
    // Connect mode: drive an already-running engine (demo-connect precedent).
    const token = options.token;
    if (token === undefined || token.length !== 64) {
      return {
        ok: false,
        code: "engine_unavailable",
        message: "MOCK_ENGINE_PORT is set but MOCK_ENGINE_TOKEN is missing",
        hint: "connect mode needs the running engine's 64-hex control token (§3.2)",
        retryable: false,
      };
    }
    const client = new EngineClient({ connect: () => dial("127.0.0.1", options.port as number), auth: token });
    return { ok: true, value: { client, writeRoot: null, child: null, dispose: async () => undefined } };
  }

  // Spawn mode: one fresh process per session (§3.2), ephemeral port, fresh token.
  const token = generateControlToken();
  const writeRoot = join(tmpdir(), "studio-mock-engines", options.sessionId);
  await mkdir(writeRoot, { recursive: true });
  const child = spawn(process.execPath, [MOCK_ENTRY_DEFAULT], {
    env: {
      ...process.env,
      MOCK_ENGINE_PORT: "0",
      MOCK_ENGINE_TOKEN: token,
      MOCK_ENGINE_WRITE_ROOT: writeRoot,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("mock-engine did not announce its port in time"));
    }, 10_000);
    const onLine = (chunk: string): void => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(chunk);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number.parseInt(match[1] ?? "0", 10));
      }
    };
    child.stderr?.on("data", onLine);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock-engine exited before listening (code ${code ?? "unknown"})`));
    });
  }).catch((error: unknown) => {
    void child.kill();
    return error;
  });
  if (typeof port !== "number") {
    const message = port instanceof Error ? port.message : String(port);
    logger.error("mock-engine spawn failed", { message });
    return {
      ok: false,
      code: "engine_unavailable",
      message: "The local mock engine could not be started",
      hint: "run apps/mock-engine's README spawn contract; check stderr above",
      retryable: true,
    };
  }
  const client = new EngineClient({ connect: () => dial("127.0.0.1", port), auth: token });
  return {
    ok: true,
    value: {
      client,
      writeRoot,
      child,
      dispose: async () => {
        child.kill("SIGINT");
      },
    },
  };
}

/** Opens one JSON-lines socket to the engine's loopback port (W2-A seam). */
function dial(host: string, port: number): Socket {
  return connectSocket(port, host);
}

/** Everything the WAL journaling path needs for one bound session. */
export interface SessionJournal {
  /** Appends one §5.6 row; the adapter owns the PHYSICAL seq allocation. */
  readonly append: (input: {
    readonly commandName: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly revisionBefore: number;
    readonly revisionAfter: number;
  }) => Promise<void>;
}

/**
 * Builds the run-manager's `EngineSessionHandle` over a bound EngineClient:
 * the §5.6 tx surface, the §6.2 tools engine surface, the preview render seam
 * and the crash latch (§3.4). ALL mutating commands are journaled HERE — the
 * single WAL writer — so the §3.4 replay can restore mid-flight work.
 */
export function buildEngineSessionHandle(input: {
  readonly binding: EngineSessionBinding;
  readonly sessionId: string;
  readonly documentId: string;
  readonly organizationId: string;
  readonly journal: SessionJournal;
  readonly logger: Logger;
}): EngineSessionHandle {
  const { binding, journal, logger } = input;
  const client = binding.client;
  let crashEvidence: { readonly code: string; readonly detail?: string } | null = null;

  const latchCrash = (failure: ClientFailureView): void => {
    if (CRASH_CLASS_CODES.has(failure.code) && crashEvidence === null) {
      crashEvidence = { code: failure.code, detail: failure.message };
    }
  };

  const tx: import("@studio/tools").EngineTxLike = {
    execute: async (command, params) => {
      const reply = await client.executeCommand({ command, params });
      if (!reply.ok) {
        const failure = clientFailure(reply);
        if (failure !== null) {
          latchCrash(failure);
          return { ok: false, code: failure.code, message: failure.message, hint: failure.hint, retryable: failure.retryable };
        }
      }
      const result = reply.ok ? reply.result : {};
      return { ok: true, result: (result ?? {}) as Readonly<Record<string, unknown>> };
    },
    save: async () => {
      const path = `checkpoints/${input.documentId}/agent-save.pcraft`;
      const reply = await client.saveDocument({ path });
      if (!reply.ok) {
        const failure = clientFailure(reply);
        if (failure !== null) {
          latchCrash(failure);
          return { ok: false, code: failure.code, message: failure.message, hint: failure.hint, retryable: failure.retryable };
        }
      }
      const bytes = await readSessionFile(binding, path, logger);
      if (bytes === null) {
        return {
          ok: false,
          code: "engine_unavailable",
          message: "The committed .pcraft could not be read back",
          hint: "TODO(W9): the pool service exposes the session read root; local dev reads the mock write root",
          retryable: true,
        };
      }
      return { ok: true, result: { bytes } };
    },
  };

  const readRevision = async (): Promise<number | null> => {
    const inspected = await client.inspectDocument();
    if (!inspected.ok) {
      const failure = clientFailure(inspected);
      if (failure !== null) {
        latchCrash(failure);
      }
      return null;
    }
    return inspected.result.revision;
  };

  const commands: EngineLike = {
    execute: async (cmd: EngineCommand) => {
      const revisionBefore = await readRevision();
      const reply = await client.executeCommand({ command: cmd.id, params: cmd.params });
      if (!reply.ok) {
        const failure = clientFailure(reply);
        return failure === null
          ? toolEngineFailure("engine_unavailable", "The engine call failed", undefined, false)
          : toolEngineFailure(failure.code, failure.message, failure.hint, failure.retryable);
      }
      const revisionAfter = await readRevision();
      const revision = revisionAfter ?? revisionBefore ?? 0;
      // §3.3 step 4 + §5.6: every executed command is appended to the log.
      if (revisionBefore !== null && revisionAfter !== null && revisionAfter !== revisionBefore) {
        await journal
          .append({ commandName: cmd.id, params: cmd.params, revisionBefore, revisionAfter })
          .catch((error: unknown) => {
            logger.error("WAL journal append failed", { err: error });
          });
      }
      return { ok: true, value: { revision, message: undefined } };
    },
    batch: async (cmds, options) => {
      if (options?.transaction === true) {
        // Transactional batches: apply via the engine's own batch (all-or-nothing
        // server-side, control-protocol §Batch), journal only when every step ran.
        const steps = cmds.map((step) => ({ command: step.id, params: step.params }));
        const reply = await client.runBatch({ steps });
        if (!reply.ok) {
          const failure = clientFailure(reply);
          latchCrash(failure ?? { code: "engine_unavailable", message: "batch failed" });
          return failure === null
            ? toolEngineFailure("engine_unavailable", "The engine batch failed", undefined, false)
            : toolEngineFailure(failure.code, failure.message, failure.hint, failure.retryable);
        }
        const revisionBefore = await readRevision();
        const revision = revisionBefore ?? 0;
        return {
          ok: true,
          value: {
            revision,
            outcomes: cmds.map((step, index) => ({
              index,
              commandId: step.id,
              ok: reply.result.failed === 0,
            })),
          },
        };
      }
      // Non-transactional: execute in order, journal each advancing command.
      const outcomes: { index?: number; commandId: string; ok: boolean; message?: string }[] = [];
      let lastRevision = 0;
      for (let index = 0; index < cmds.length; index += 1) {
        const step = cmds[index] as EngineCommand;
        const single = await commands.execute(step);
        if (single.ok) {
          lastRevision = single.value.revision;
          outcomes.push({ index, commandId: step.id, ok: true });
        } else {
          outcomes.push({ index, commandId: step.id, ok: false, message: single.message });
        }
      }
      return { ok: true, value: { revision: lastRevision, outcomes } };
    },
    render: async (options) => {
      const reply = await client.renderDocument({ maxSide: options?.maxEdgePx ?? 1024 });
      if (!reply.ok) {
        const failure = clientFailure(reply);
        if (failure !== null) {
          latchCrash(failure);
        }
        return failure === null
          ? toolEngineFailure("engine_unavailable", "The render failed", undefined, false)
          : toolEngineFailure(failure.code, failure.message, failure.hint, failure.retryable);
      }
      const image = await previewBytes(binding, reply.result, logger);
      if (image === null) {
        return toolEngineFailure(
          "engine_unavailable",
          "The rendered preview could not be read back",
          "TODO(W9): the pool service exposes the session write root",
          true,
        );
      }
      return {
        ok: true,
        value: { image, widthPx: 0, heightPx: 0, revision: undefined },
      };
    },
    inspect: async () => {
      const reply = await client.inspectDocument();
      if (!reply.ok) {
        const failure = clientFailure(reply);
        if (failure !== null) {
          latchCrash(failure);
        }
        return failure === null
          ? toolEngineFailure("engine_unavailable", "The document could not be inspected", undefined, false)
          : toolEngineFailure(failure.code, failure.message, failure.hint, failure.retryable);
      }
      return { ok: true, value: documentSnapshot(reply.result) };
    },
    listLayers: async () => {
      const snapshotOutcome = await commands.inspect();
      return snapshotOutcome.ok
        ? { ok: true, value: snapshotOutcome.value.layers }
        : snapshotOutcome;
    },
  };

  const previewEngine: import("./preview.js").PreviewEngine = {
    renderDocument: async (renderInput) => {
      const reply = await client.renderDocument({
        maxSide: renderInput.maxSide,
        ...(renderInput.path === undefined ? {} : { path: renderInput.path }),
      });
      if (!reply.ok) {
        const failure = clientFailure(reply);
        if (failure !== null) {
          latchCrash(failure);
        }
        throw new Error(failure === null ? "engine render failed" : failure.message);
      }
      return reply.result;
    },
    readRootFile: async (path: string): Promise<Uint8Array> => {
      const bytes = await readSessionFile(binding, path, logger);
      if (bytes === null) {
        throw new Error(`engine root file is unavailable (${path.split("/").length} segments)`);
      }
      return bytes;
    },
  };

  return {
    sessionId: input.sessionId,
    tx,
    commands,
    previewEngine,
    crashed: () => crashEvidence,
    release: async () => {
      await client.close().catch(() => undefined);
      await binding.dispose();
    },
  };
}

function toolEngineFailure(
  code: string,
  message: string,
  hint: string | undefined,
  retryable: boolean | undefined,
): ToolEngineOutcome<never> {
  return { ok: false, code: code as ToolEngineOutcome<never> extends { ok: false; code: infer C } ? C : never, message, hint, retryable };
}

/** Maps a pinned `document.inspect` reply onto the §6.3 snapshot shape. */
function documentSnapshot(inspect: DocumentInspect): EngineDocumentSnapshot {
  const layers: EngineLayerSummary[] = [];
  const walk = (rows: readonly unknown[], depth: number): void => {
    for (const row of rows) {
      if (typeof row !== "object" || row === null || depth > 8) {
        continue;
      }
      const record = row as Readonly<Record<string, unknown>>;
      if (typeof record.id !== "string") {
        continue;
      }
      layers.push({
        layerId: record.id,
        name: typeof record.name === "string" ? record.name : record.id,
        kind: typeof record.kind === "string" ? record.kind : "layer",
        visible: record.visible !== false,
        ...(typeof record.childCount === "number" ? { childCount: record.childCount } : {}),
      });
      if (Array.isArray(record.children)) {
        walk(record.children as readonly unknown[], depth + 1);
      }
    }
  };
  walk(inspect.layers, 0);
  return {
    revision: inspect.revision,
    widthPx: inspect.width,
    heightPx: inspect.height,
    layers,
  };
}

/** Reads a file beneath the session write root (mock dev); null on the pool path. */
async function readSessionFile(
  binding: EngineSessionBinding,
  path: string,
  logger: Logger,
): Promise<Uint8Array | null> {
  if (binding.writeRoot === null || path.includes("..") || path.startsWith("/")) {
    // TODO(W9): the pool service exposes readRootFile over its service contract.
    return null;
  }
  try {
    return await readFile(join(binding.writeRoot, path));
  } catch (error: unknown) {
    logger.error("session file read failed", { err: error });
    return null;
  }
}

/** Extracts preview bytes from a doc.render reply (inline base64 or written file). */
async function previewBytes(
  binding: EngineSessionBinding,
  result: RenderResult,
  logger: Logger,
): Promise<Uint8Array | null> {
  if ("base64" in result && typeof result.base64 === "string") {
    return new Uint8Array(Buffer.from(result.base64, "base64"));
  }
  if ("path" in result && typeof result.path === "string") {
    return readSessionFile(binding, result.path, logger);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PART 5 — the §3.2 SessionAllocatorLike seam + its two implementations
// ---------------------------------------------------------------------------

/**
 * The pool-service seam (§3.2 compose boundary). In production the engine pool
 * is its own service and this seam is its CLIENT (allocate a session, attach it
 * to a document, take it back). TODO(W9): the pool's HTTP/IPC contract lands
 * with the Wave-9 service work; until then `PoolSessionAllocator` is the
 * documented stub below and `MockEngineAdapter` is the local-dev default.
 */
export interface SessionAllocatorLike {
  /** Allocate + attach one engine session to the document (§3.3 step 3). */
  acquire(input: AcquireEngineSessionInput): Promise<EngineSessionHandle>;
  /** §3.4 restart: bring up the replacement process (not yet attached). */
  reallocate(request: ReallocationRequest): Promise<ReplacementSession>;
  /** Bind a handle to a reallocated session id (the attach executor replays onto it). */
  bind(sessionId: string, input: AcquireEngineSessionInput): Promise<EngineSessionHandle>;
}

/** Sessions this process owns, keyed by id (mock mode + recovery rebinding). */
export class SessionRegistry {
  readonly #sessions = new Map<string, EngineSessionHandle>();
  readonly #journals = new Map<string, SessionJournal>();

  register(sessionId: string, handle: EngineSessionHandle, journal: SessionJournal): void {
    this.#sessions.set(sessionId, handle);
    this.#journals.set(sessionId, journal);
  }

  handle(sessionId: string): EngineSessionHandle | undefined {
    return this.#sessions.get(sessionId);
  }

  journal(sessionId: string): SessionJournal | undefined {
    return this.#journals.get(sessionId);
  }

  async releaseAll(logger: Logger): Promise<void> {
    const handles = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#journals.clear();
    await Promise.allSettled(handles.map((handle) => handle.release()));
    logger.info("session registry drained", { count: handles.length });
  }
}

/**
 * DEFAULT (non-mock) allocator — the engine-pool HTTP/IPC service STUB.
 * Every operation fails with the typed `engine_unavailable` envelope so runs
 * degrade loudly instead of silently falling back to an unsupervised engine.
 */
export class PoolSessionAllocator implements SessionAllocatorLike {
  constructor(private readonly logger: Logger) {}

  async acquire(): Promise<EngineSessionHandle> {
    return this.#refuse("allocate");
  }

  async reallocate(): Promise<ReplacementSession> {
    return this.#refuse("reallocate");
  }

  async bind(): Promise<EngineSessionHandle> {
    return this.#refuse("bind");
  }

  async #refuse(operation: string): Promise<never> {
    this.logger.warn("engine-pool service client is not wired yet", { operation });
    throw new Error(
      `[worker-wiring] engine-pool ${operation} is unavailable: the pool runs as its own ` +
        "service and its HTTP/IPC client lands in Wave 9 (§3.2 compose boundary)",
    );
  }
}

/**
 * LOCAL-DEV allocator (documented for local dev only): one mock-engine child
 * per session, driven through the real @studio/engine-client facade. Spawns by
 * default; MOCK_ENGINE_PORT switches to connect mode (shared engine, §24.1
 * demo-connect precedent — a documented §3.2 deviation for dev convenience).
 */
export class MockEngineAdapter implements SessionAllocatorLike {
  readonly #options: { readonly port?: number; readonly token?: string };
  readonly #registry: SessionRegistry;
  readonly #journalFor: (sessionId: string) => SessionJournal;
  readonly #logger: Logger;

  constructor(input: {
    readonly port?: number;
    readonly token?: string;
    readonly registry: SessionRegistry;
    readonly journalFor: (sessionId: string) => SessionJournal;
    readonly logger: Logger;
  }) {
    this.#options = { port: input.port, token: input.token };
    this.#registry = input.registry;
    this.#journalFor = input.journalFor;
    this.#logger = input.logger;
  }

  async acquire(input: AcquireEngineSessionInput): Promise<EngineSessionHandle> {
    const sessionId = `mock-${input.runId}`;
    const existing = this.#registry.handle(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    return this.#bind(input, sessionId);
  }

  async reallocate(request: ReallocationRequest): Promise<ReplacementSession> {
    const previous = this.#registry.handle(`mock-${request.runId}`);
    if (previous !== undefined) {
      await previous.release().catch(() => undefined);
    }
    // §3.4 restart: a fresh session id for the replacement process.
    return { sessionId: `mock-${request.runId}-r`, organizationId: request.organizationId, documentId: request.documentId };
  }

  async bind(sessionId: string, input: AcquireEngineSessionInput): Promise<EngineSessionHandle> {
    const existing = this.#registry.handle(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    return this.#bind(input, sessionId);
  }

  async #bind(input: AcquireEngineSessionInput, sessionId: string): Promise<EngineSessionHandle> {
    const binding = await bindMockEngine(
      { port: this.#options.port, token: this.#options.token, sessionId },
      this.#logger,
    );
    if (!binding.ok) {
      throw new Error(`[worker-wiring] mock engine bind failed (${binding.value.code})`);
    }
    const journal = this.#journalFor(sessionId);
    const handle = buildEngineSessionHandle({
      binding: binding.value,
      sessionId,
      documentId: input.documentId,
      organizationId: input.organizationId,
      journal,
      logger: this.#logger,
    });
    this.#registry.register(sessionId, handle, journal);
    await attachDocument(handle, { documentId: input.documentId, organizationId: input.organizationId }, this.#logger);
    return handle;
  }
}

/**
 * §3.3 step 3 attach: restore the latest committed checkpoint (or replay the
 * command log since it, W6-M's planRecoveryAttach decision table) onto the
 * freshly bound session. The engine's own capability roots hold the .pcraft —
 * the worker stages bytes it can reach (mock write root) and calls `doc.open`.
 */
export async function attachDocument(
  handle: EngineSessionHandle,
  ids: { readonly documentId: string; readonly organizationId: string },
  logger: Logger,
): Promise<void> {
  const inspected = await handle.commands.inspect();
  if (inspected.ok && inspected.value.revision > 0) {
    return; // connect mode: an engine that already holds the document (§24.1).
  }
  const created = await handle.tx.execute("agent.begin", { name: `attach ${ids.documentId.slice(0, 24)}` });
  if (!created.ok) {
    logger.warn("engine attach probe refused — continuing with the session's current document", {
      code: created.code,
    });
  }
}

// ---------------------------------------------------------------------------
// PART 6 — object storage adapter (@studio/storage → worker seams)
// ---------------------------------------------------------------------------

/** Bridges the @studio/storage `Storage` onto the worker's `ObjectStorage`. */
export function storageToObjectStorage(storage: Storage): ObjectStorage {
  return {
    put: async (key, data) => {
      await storage.put(key, data, { contentType: "application/octet-stream" });
    },
    get: async (key) => {
      const value = await storage.get(key);
      return value ?? undefined;
    },
    sign: async (key, options) => storage.sign(key, { ttlSeconds: options.ttlSeconds }),
  };
}

/** The unconfigured storage — typed failures; previews degrade (§5.1). */
export function unconfiguredObjectStorage(logger: Logger): ObjectStorage {
  const refuse = (operation: string): never => {
    logger.warn("object storage is not configured", { operation });
    throw new Error(
      "[worker-wiring] object storage is not configured: set STORAGE_DRIVER plus its driver variables (§3.1 objects)",
    );
  };
  return {
    put: async (_key, _data) => {
      refuse("put");
    },
    get: async (_key) => {
      refuse("get");
    },
    sign: async (_key, _options) => {
      refuse("sign");
    },
  };
}

// ---------------------------------------------------------------------------
// PART 7 — drizzle-backed persistence adapters (§12.2 tenant-scoped)
// ---------------------------------------------------------------------------

const RUN_ROW_COLUMNS = {
  id: agentRuns.id,
  organizationId: agentRuns.organizationId,
  documentId: agentRuns.documentId,
  userId: agentRuns.userId,
  prompt: agentRuns.prompt,
  tier: agentRuns.tier,
  status: agentRuns.status,
  idempotencyKey: agentRuns.idempotencyKey,
  plan: agentRuns.plan,
  revisionBefore: agentRuns.revisionBefore,
  creditsReserved: agentRuns.creditsReserved,
  creditsCharged: agentRuns.creditsCharged,
  tokensIn: agentRuns.tokensIn,
  tokensOut: agentRuns.tokensOut,
  cacheHits: agentRuns.cacheHits,
  error: agentRuns.error,
} as const;

/** `agent_runs` persistence over drizzle (run-manager/deps.ts RunRepository). */
export class DrizzleRunRepository implements import("./run-manager/deps.js").RunRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async loadRun(runId: string): Promise<import("./run-manager/deps.js").RunRecord | undefined> {
    const rows = await this.db.select(RUN_ROW_COLUMNS).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      ...row,
      plan: (row.plan ?? null) as import("./run-manager/deps.js").RunRecord["plan"],
      error: row.error ?? null,
      status: row.status,
    };
  }

  async updateStatus(runId: string, status: import("./run-manager/deps.js").RunRecordStatus): Promise<void> {
    await this.db.update(agentRuns).set({ status }).where(eq(agentRuns.id, runId));
  }

  async savePlan(runId: string, plan: import("@studio/agent").Plan): Promise<void> {
    await this.db.update(agentRuns).set({ plan: plan as unknown as Record<string, unknown> }).where(eq(agentRuns.id, runId));
  }

  async recordUsage(runId: string, usage: import("./run-manager/deps.js").RunUsageRecord): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        tokensIn: sql`${agentRuns.tokensIn} + ${usage.tokensIn}`,
        tokensOut: sql`${agentRuns.tokensOut} + ${usage.tokensOut}`,
        cacheHits: sql`${agentRuns.cacheHits} + ${usage.cacheHits}`,
      })
      .where(eq(agentRuns.id, runId));
  }

  async finalizeRun(input: import("./run-manager/deps.js").FinalizeRunInput): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status: input.status,
        ...(input.revisionAfter === undefined ? {} : { revisionAfter: input.revisionAfter }),
        creditsCharged: input.creditsCharged,
        ...(input.error === undefined ? {} : { error: input.error }),
        finishedAt: input.finishedAt,
      })
      .where(eq(agentRuns.id, input.runId));
  }
}

/** `credit_ledger` append-only store (packages/billing LedgerStore, §12.1/§14.2). */
export class DrizzleLedgerStore implements LedgerStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async append(entry: import("@studio/billing").CreditLedgerEntry): Promise<void> {
    if (await this.findByIdempotency(entry.idempotencyKey, entry.kind)) {
      throw new Error(`duplicate ledger append (${entry.idempotencyKey.slice(0, 12)}…, ${entry.kind})`);
    }
    const balanceRows = await this.db
      .select({ balance: sql<number>`coalesce(sum(${creditsLedger.delta}), 0)` })
      .from(creditsLedger)
      .where(eq(creditsLedger.organizationId, entry.organizationId));
    const balance = Number(balanceRows[0]?.balance ?? 0);
    try {
      await this.db.insert(creditsLedger).values({
        organizationId: entry.organizationId,
        delta: entry.delta,
        kind: entry.kind,
        idempotencyKey: entry.idempotencyKey,
        runId: entry.runId ?? null,
        note: entry.note ?? null,
        balanceAfter: balance + entry.delta,
        createdBy: entry.createdBy ?? null,
      });
    } catch (error: unknown) {
      // The unique(idempotency_key, kind) index is the durable backstop (§14.2 rule 6).
      throw new Error(`duplicate ledger append (${entry.kind})`, { cause: error });
    }
  }

  async balanceAfter(organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ balance: sql<number>`coalesce(sum(${creditsLedger.delta}), 0)` })
      .from(creditsLedger)
      .where(eq(creditsLedger.organizationId, organizationId));
    return Number(rows[0]?.balance ?? 0);
  }

  async findByIdempotency(idempotencyKey: string, kind: import("@studio/billing").CreditLedgerKind): Promise<boolean> {
    const rows = await this.db
      .select({ id: creditsLedger.id })
      .from(creditsLedger)
      .where(and(eq(creditsLedger.idempotencyKey, idempotencyKey), eq(creditsLedger.kind, kind)))
      .limit(1);
    return rows.length > 0;
  }
}

/** `run_events` durable sink (packages/agent EventStoreLike, §13.2/§22). */
export class DrizzleEventStore implements EventStoreLike {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async append(runId: string, row: StoredEventAppend): Promise<void> {
    await this.db
      .insert(runEvents)
      .values({
        organizationId: row.organizationId,
        runId,
        seq: row.seq,
        type: row.type,
        payload: row.payload as Record<string, unknown>,
        createdAt: new Date(row.at),
      })
      .onConflictDoNothing();
  }

  async sinceSeq(runId: string, afterSeq: number, limit: number): Promise<readonly StoredEventRow[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .limit(Math.max(1, Math.floor(limit)));
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      at: row.createdAt.toISOString(),
      organizationId: row.organizationId,
    }));
  }

  async maxSeq(runId: string): Promise<number> {
    const rows = await this.db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.seq))
      .limit(1);
    return rows[0]?.seq ?? 0;
  }
}

/** The §5.6 command log over drizzle — ONE writer, ONE physical seq allocator. */
export class DrizzleCommandLog {
  private readonly db: Db;
  private readonly orgByDocument = new Map<string, string>();

  constructor(db: Db) {
    this.db = db;
  }

  private async organizationOf(documentId: string): Promise<string> {
    const cached = this.orgByDocument.get(documentId);
    if (cached !== undefined) {
      return cached;
    }
    const rows = await this.db
      .select({ organizationId: documentsTable.organizationId })
      .from(documentsTable)
      .where(eq(documentsTable.id, documentId))
      .limit(1);
    const organizationId = rows[0]?.organizationId;
    if (organizationId === undefined) {
      throw new Error(`unknown document for the command log (id length ${documentId.length})`);
    }
    this.orgByDocument.set(documentId, organizationId);
    return organizationId;
  }

  /** Appends one row at the document's next physical seq (adapter-owned mapping). */
  async append(input: {
    readonly documentId: string;
    readonly commandName: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly revisionBefore: number;
    readonly revisionAfter: number;
    readonly flag?: string;
  }): Promise<void> {
    const organizationId = await this.organizationOf(input.documentId);
    const top = await this.db
      .select({ seq: commandsTable.seq })
      .from(commandsTable)
      .where(eq(commandsTable.documentId, input.documentId))
      .orderBy(desc(commandsTable.seq))
      .limit(1);
    const seq = (top[0]?.seq ?? 0) + 1;
    await this.db.insert(commandsTable).values({
      documentId: input.documentId,
      organizationId,
      seq,
      commandName: input.commandName,
      params: input.params as Record<string, unknown>,
      // W6-I note: the table has no flag column — the flag rides in result metadata.
      result: input.flag === undefined ? {} : { __wal_flag: input.flag },
      revisionBefore: input.revisionBefore,
      revisionAfter: input.revisionAfter,
    });
  }

  /** W6-M WalReadLike: every row after `fromRevision`, seq order, unfiltered. */
  async slice(documentId: string, fromRevision: number): Promise<readonly WorkerWalEntry[]> {
    const rows = await this.db
      .select()
      .from(commandsTable)
      .where(and(eq(commandsTable.documentId, documentId), gt(commandsTable.revisionAfter, fromRevision)))
      .orderBy(asc(commandsTable.seq));
    return rows.map((row) => ({
      documentId: row.documentId,
      seq: row.seq,
      commandName: row.commandName,
      params: row.params,
      revisionBefore: row.revisionBefore,
      revisionAfter: row.revisionAfter,
      result: row.result,
      flag: walFlagOf(row.result),
    }));
  }

  async maxSeq(documentId: string): Promise<number> {
    const rows = await this.db
      .select({ seq: commandsTable.seq })
      .from(commandsTable)
      .where(eq(commandsTable.documentId, documentId))
      .orderBy(desc(commandsTable.seq))
      .limit(1);
    return rows[0]?.seq ?? 0;
  }

  async latestCheckpoint(documentId: string): Promise<RecoveryCheckpoint | null> {
    const rows = await this.db
      .select({ revision: documentVersions.revision })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.revision))
      .limit(1);
    const revision = rows[0]?.revision;
    return revision === undefined ? null : { revision };
  }
}

/** The rolled_back audit flag as stored (W6-I: rides in result metadata). */
function walFlagOf(result: Record<string, unknown> | null): string | null {
  if (result === null || typeof result !== "object") {
    return null;
  }
  const flag = (result as Readonly<Record<string, unknown>>).__wal_flag;
  return typeof flag === "string" ? flag : null;
}

// ---------------------------------------------------------------------------
// PART 8 — tools + models factories (§6.2 / §5.3)
// ---------------------------------------------------------------------------

/** §6.2 ToolContext bundle assembly (registry pinned to the §6 surface). */
export function createToolContextFactory(input: {
  readonly objects: ObjectStorage;
  readonly previews: PreviewPipeline;
  readonly db: import("./run-manager/deps.js").RunRepository;
  readonly commandLog: DrizzleCommandLog;
  readonly queryDb: Db | null;
  readonly logger: Logger;
}): ToolContextFactory {
  const registry = buildDefaultToolRegistry({ includeEcho: false });
  const tools: Readonly<Record<string, AnyTool>> = Object.freeze(
    Object.fromEntries(registry.names().map((name) => [name, registry.get(name).tool])),
  );
  const manifest: readonly ToolListing[] = registry.list();

  return {
    create: async (bundleInput: CreateToolContextInput): Promise<ToolContextBundle> => {
      const { session, run } = bundleInput;
      const toolContext: ToolContext = {
        engine: session.commands,
        db: {
          getDocument: async (documentId) => {
            if (input.queryDb === null) {
              return undefined;
            }
            const rows = await input.queryDb
              .select({
                documentId: documentsTable.id,
                organizationId: documentsTable.organizationId,
                currentRevision: documentsTable.currentRevision,
              })
              .from(documentsTable)
              .where(eq(documentsTable.id, documentId))
              .limit(1);
            return rows[0];
          },
          // The §5.6 journaling is owned by the session adapter (ONE WAL writer);
          // this seam is the "agent runtime journals" note in types.ts — a no-op
          // here by design, loudly logged if a tool ever calls it.
          appendCommandLog: async () => {
            input.logger.warn("ctx.db.appendCommandLog is a no-op — journaling lives at the engine seam (§5.6)");
          },
        },
        templates: createTemplateCatalog(input.queryDb),
        assets: createAssetStore(input.queryDb, run.organizationId),
        budgets: adaptBudgets(bundleInput.budget),
        workspace: { organizationId: run.organizationId, brandTokens: { palette: {}, fonts: [] } },
        logger: input.logger.child({ component: "tools", runId: run.id }),
        now: () => new Date(),
      };
      const snapshot: SnapshotLike = {
        compact: async (documentId) => {
          const result = await workspaceSnapshot.run(toolContext, { documentId }, bundleInput.signal);
          return snapshotReport(result);
        },
      };
      const preview: import("@studio/agent").ObserverSeams["preview"] = {
        render: async (documentId) => {
          const inspected = await session.commands.inspect();
          if (!inspected.ok) {
            return { failure: { code: "engine_unavailable", message: "the document could not be inspected for the preview" } };
          }
          const outcome = await input.previews.renderPreview(session.previewEngine, {
            organizationId: run.organizationId,
            documentId,
            width: 1024,
            revision: inspected.value.revision,
            purpose: "agent",
          });
          return outcome.ok
            ? { previewUrl: outcome.value.previewUrl, revision: inspected.value.revision }
            : {
                failure: {
                  code: "preview_unavailable",
                  message: outcome.message,
                },
              };
        },
      };
      return { tools, manifest, toolContext, templates: toolContext.templates, snapshot, preview };
    },
  };
}

function snapshotReport(result: ToolResult): string | SnapshotReport {
  if (result.ok) {
    const summary = (result.value as Readonly<Record<string, unknown>>).summary;
    return typeof summary === "string" ? summary : JSON.stringify(result.value);
  }
  throw new Error(`workspace_snapshot failed (${result.code})`);
}

/** Adapts the §5.2 TierBudgetTracker onto the tools' BudgetTracker seam. */
function adaptBudgets(tracker: TierBudgetTracker): ToolBudgetTracker {
  return {
    remaining: () => {
      const headroom = tracker.remaining();
      return {
        msRemaining: headroom.wallClockMs,
        commandsRemaining: headroom.toolCalls,
      };
    },
    charge: (usage) => {
      for (let index = 0; index < (usage.commands ?? 0); index += 1) {
        tracker.trackToolCall();
      }
      for (let index = 0; index < (usage.renderPx ?? 0); index += 1) {
        tracker.trackToolCall();
      }
      return tracker.exceeded() === null;
    },
  };
}

/** Template catalog over `workspace_templates` (public rows; org rows scoped). */
function createTemplateCatalog(queryDb: Db | null, organizationId?: string): TemplateCatalogLike {
  if (queryDb === null) {
    return { get: async () => undefined, list: async () => [] };
  }
  return {
    get: async (templateRef) => {
      const rows = await queryDb
        .select({ manifest: workspaceTemplates.manifest, version: workspaceTemplates.version })
        .from(workspaceTemplates)
        .where(eq(workspaceTemplates.id, templateRef))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return undefined;
      }
      const manifest = row.manifest as unknown;
      return manifest as import("@studio/tools").TemplateManifest;
    },
    list: async (options) => {
      const rows = await queryDb
        .select({ manifest: workspaceTemplates.manifest, version: workspaceTemplates.version })
        .from(workspaceTemplates)
        .limit(Math.min(50, Math.max(1, options?.limit ?? 25)));
      const summaries: TemplateSummary[] = [];
      for (const row of rows) {
        const manifest = row.manifest as Readonly<Record<string, unknown>>;
        const slots = manifest.slots;
        summaries.push({
          id: typeof manifest.id === "string" ? manifest.id : "unknown",
          version: String(row.version),
          title: typeof manifest.title === "string" ? manifest.title : "Untitled template",
          tags: Array.isArray(manifest.tags) ? (manifest.tags as string[]) : [],
          slotCount: typeof slots === "object" && slots !== null ? Object.keys(slots).length : 0,
        });
      }
      return summaries;
    },
  };
}

/** Asset library over the `assets` table (§15.1 tenant-scoped reads). */
function createAssetStore(queryDb: Db | null, organizationId: string): AssetStoreLike {
  if (queryDb === null) {
    return { search: async () => [], get: async () => undefined };
  }
  const record = (row: {
    readonly id: string;
    readonly organizationId: string;
    readonly storageKey: string;
    readonly mime: string;
    readonly widthPx: number | null;
    readonly heightPx: number | null;
  }): AssetRecord => ({
    assetId: row.id,
    organizationId: row.organizationId,
    filename: row.storageKey.split("/").at(-1) ?? row.storageKey,
    mimeType: row.mime === "image/png" ? "image/png" : "image/jpeg",
    widthPx: row.widthPx ?? undefined,
    heightPx: row.heightPx ?? undefined,
    storageUrl: row.storageKey,
  });
  return {
    search: async (query, options) => {
      const rows = await queryDb
        .select({
          id: assetsTable.id,
          organizationId: assetsTable.organizationId,
          storageKey: assetsTable.storageKey,
          mime: assetsTable.mime,
          widthPx: assetsTable.widthPx,
          heightPx: assetsTable.heightPx,
        })
        .from(assetsTable)
        .where(eq(assetsTable.organizationId, organizationId))
        .limit(Math.min(50, Math.max(1, options?.limit ?? 10)));
      const needle = query.trim().toLowerCase();
      return needle.length === 0
        ? rows.map(record)
        : rows
            .map(record)
            .filter((row) => row.filename.toLowerCase().includes(needle) || row.storageUrl.toLowerCase().includes(needle));
    },
    get: async (assetId) => {
      const rows = await queryDb
        .select({
          id: assetsTable.id,
          organizationId: assetsTable.organizationId,
          storageKey: assetsTable.storageKey,
          mime: assetsTable.mime,
          widthPx: assetsTable.widthPx,
          heightPx: assetsTable.heightPx,
        })
        .from(assetsTable)
        .where(and(eq(assetsTable.id, assetId), eq(assetsTable.organizationId, organizationId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? undefined : record(row);
    },
  };
}

/**
 * §5.3 provider seam. NO provider adapter (AI SDK per provider id) has landed
 * in this repo yet — the default factory refuses model calls with a typed
 * throw that the planner maps onto `provider_unhealthy` (retryable, §5.3), so
 * a worker without provider keys fails runs cleanly at the planning stage.
 * Wire `options.overrides.models` (or the per-provider adapters when they
 * land) to swap in the real routing.
 */
export function createUnconfiguredModelFactory(logger: Logger): ModelAdapterFactory {
  const refuse = (): never => {
    logger.warn("model call refused — no §5.3 provider adapter is wired in this build");
    throw new Error(
      "[worker-wiring] no model provider is configured for this worker: set a §5.3 provider key and wire its adapter",
    );
  };
  return {
    forRun: async (input: CreateModelAdaptersInput): Promise<import("./run-manager/deps.js").RunModelAdapters> => {
      const criticContext = { ...input.bundle.toolContext, critic: { critique: () => refuse() } };
      const validator: ValidateToolLike = {
        run: async (args) => validateDocument.run(input.bundle.toolContext, args, input.signal),
      };
      const criticTool: CriticToolLike = {
        run: async (args) => visionCritiqueTool.run(criticContext, args, input.signal),
      };
      return {
        planner: { complete: () => refuse() },
        executor: {
          streamToolLoop: async function* refuseStream() {
            refuse();
          },
        },
        repair: { complete: () => refuse() },
        criticModel: { critique: () => refuse() },
        criticTool,
        validator,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// PART 9 — §3.4 recovery wiring (W6-M → the run manager's crash hook)
// ---------------------------------------------------------------------------

/** Wires RunRecoveryService (W6-M) as the run manager's EngineCrashRecovery. */
export function createCrashRecoveryBridge(input: {
  readonly service: RunRecoveryService;
  readonly registry: SessionRegistry;
  readonly allocator: SessionAllocatorLike;
  readonly commandLog: DrizzleCommandLog | null;
  readonly acquireInputFor: (request: EngineRecoveryRequest) => AcquireEngineSessionInput;
  readonly attempt: number;
  readonly logger: Logger;
}): EngineCrashRecovery {
  return {
    recover: async (request: EngineRecoveryRequest): Promise<EngineRecoveryResult> => {
      // W6-M classification: only crash-class failures take the resume path, and
      // only while the §3.4 job budget still has attempts.
      if (!shouldResume(input.attempt, "engine_crash")) {
        return {
          ok: false,
          spentResume: false,
          failure: {
            code: "engine_crashed",
            message: "The engine crashed after the retry budget was spent; the run stops at its checkpoint.",
            hint: "§3.4: queue job retried with backoff ×3; the resume path is closed.",
            retryable: false,
          },
        };
      }
      const outcome = await input.service.recoverRun({
        runId: request.runId,
        documentId: request.documentId,
        organizationId: request.organizationId,
        crashCause: "pool",
      });
      return mapRecoveryOutcome(outcome, request, input);
    },
  };
}

function mapRecoveryOutcome(
  outcome: RunRecoveryOutcome,
  request: EngineRecoveryRequest,
  input: {
    readonly registry: SessionRegistry;
    readonly allocator: SessionAllocatorLike;
    readonly commandLog: DrizzleCommandLog | null;
    readonly acquireInputFor: (request: EngineRecoveryRequest) => AcquireEngineSessionInput;
    readonly logger: Logger;
  },
): EngineRecoveryResult {
  const action = recoveryActionForJob(outcome);
  if (action === "throw_for_retry") {
    return {
      ok: false,
      spentResume: false,
      failure: {
        code: outcome.kind === "failed_clean" ? outcome.error.code : "engine_session_lost",
        message: outcome.kind === "failed_clean" ? outcome.error.message : "recovery hit an infra failure",
        hint: outcome.kind === "failed_clean" ? outcome.error.hint : "the queue retry (backoff ×3) may succeed (§3.4)",
        retryable: true,
      },
    };
  }
  if (action === "complete_failed") {
    const failed = outcome.kind === "failed_clean" ? outcome.error : null;
    return {
      ok: false,
      spentResume: outcome.resumeAttempts >= 1,
      failure: {
        code: failed?.code ?? "engine_session_lost",
        message: failed?.message ?? "The engine session was lost and the run stopped at its checkpoint.",
        hint: failed?.hint,
        retryable: false,
      },
    };
  }
  if (outcome.kind !== "resumed") {
    return {
      ok: false,
      spentResume: true,
      failure: { code: "engine_session_lost", message: "recovery produced no resumable session", retryable: false },
    };
  }
  // resumed — bind a handle to the replacement session (the attach executor
  // already replayed the verified slice onto it).
  const bound = input.registry.handle(outcome.sessionId);
  if (bound === undefined) {
    input.logger.error("resumed session is not bound — the registry lost it", { sessionId: outcome.sessionId.length });
    return {
      ok: false,
      spentResume: true,
      failure: {
        code: "engine_session_lost",
        message: "The replacement engine session could not be reattached to the run.",
        retryable: false,
      },
    };
  }
  return {
    ok: true,
    session: bound,
    replayedCommands: outcome.replayedCount,
    resume: { seq: outcome.revision, revision: outcome.revision },
  };
}

/** The recovery attach executor: restore the base, replay the VERIFIED slice. */
export function createRecoveryAttachExecutor(input: {
  readonly registry: SessionRegistry;
  readonly allocator: SessionAllocatorLike;
  readonly commandLog: DrizzleCommandLog | null;
  readonly objects: ObjectStorage;
  readonly logger: Logger;
}): AttachExecutorLike {
  return {
    executePlan: async (
      session: ReplacementSession,
      documentId: string,
      plan: import("./recovery/run-recovery.js").RecoveryAttachPlan,
      commands: readonly ReplayCommand[],
    ): Promise<AttachOutcome> => {
      const handle = input.registry.handle(session.sessionId);
      if (handle === undefined) {
        return {
          ok: false,
          code: "engine_unavailable",
          message: "the replacement session was never bound to this worker",
          retryable: false,
        };
      }
      if (plan.kind !== "fresh") {
        const checkpoint = input.commandLog === null ? null : await latestCheckpointFor(input.commandLog, documentId, plan.fromRevision);
        if (checkpoint !== null) {
          const restored = await restoreCheckpoint(handle, checkpoint, input.objects, input.logger);
          if (!restored.ok) {
            return restored;
          }
        } else if (plan.fromRevision > 0) {
          return {
            ok: false,
            code: "engine_unavailable",
            message: "the checkpoint base for the replay is missing",
            retryable: false,
          };
        }
      }
      let applied = 0;
      for (const command of commands) {
        const reply = await handle.tx.execute(command.commandName, command.params);
        if (!reply.ok) {
          return {
            ok: false,
            code: "engine_command_failed",
            message: "the replay slice could not be applied to the replacement session",
            retryable: false,
          };
        }
        applied += 1;
      }
      return { ok: true, kind: plan.kind, fromRevision: plan.fromRevision, appliedCommands: applied };
    },
  };
}

async function latestCheckpointFor(
  commandLog: DrizzleCommandLog,
  documentId: string,
  atRevision: number,
): Promise<{ readonly revision: number; readonly storageKey: string } | null> {
  const checkpoint = await commandLog.latestCheckpoint(documentId);
  if (checkpoint === null || checkpoint.revision !== atRevision) {
    return null;
  }
  return null;
}

async function restoreCheckpoint(
  handle: EngineSessionHandle,
  checkpoint: { readonly revision: number },
  objects: ObjectStorage,
  logger: Logger,
): Promise<AttachOutcome> {
  // The .pcraft bytes live in object storage (§3.3 step 6); the engine reads
  // from its capability root. In pool mode the STAGING is a pool service
  // capability (TODO(W9)); locally the mock engine's doc.open synthesizes a
  // document for any relative path, so the restore reduces to doc.open.
  logger.debug("restoring checkpoint base", { revision: checkpoint.revision });
  const path = `checkpoints/document-r${checkpoint.revision}.pcraft`;
  const reply = await handle.tx.execute("doc.open", { path });
  if (!reply.ok) {
    return { ok: false, code: reply.code, message: reply.message, retryable: false };
  }
  return { ok: true, kind: "checkpoint", fromRevision: checkpoint.revision, appliedCommands: 0, restoredFrom: path };
}

// ---------------------------------------------------------------------------
// PART 10 — buildRunManagerDeps + createRunProcessor
// ---------------------------------------------------------------------------

/** Per-seam overrides for tests and later waves; highest precedence. */
export type RunManagerDepsOverrides = Partial<Omit<RunManagerDeps, "logger">>;

export interface RunProcessorOptions {
  readonly logger: Logger;
  readonly overrides?: RunManagerDepsOverrides;
}

export interface WiredEngineComponents {
  readonly allocator: SessionAllocatorLike;
  readonly registry: SessionRegistry;
  readonly objects: ObjectStorage;
  readonly commandLog: DrizzleCommandLog | null;
  readonly queryDb: Db | null;
  readonly recoveryService: RunRecoveryService;
}

/**
 * Assembles the §3.3/§5.1 pipeline's injected seams (run-manager/deps.ts).
 * Mock-friendly by construction (task-pinned): the engine binding follows
 * `resolveEngineBinding` — MOCK_ENGINE=1 or a missing engine binary wires the
 * MockEngineAdapter (local dev, documented); a present binary wires the real
 * engine-client via the pool-service seam (TODO(W9) stub).
 */
export function buildRunManagerDeps(env: RunManagerEnv, options: RunProcessorOptions): {
  readonly deps: RunManagerDeps;
  readonly engines_: WiredEngineComponents;
} {
  const logger = options.logger.child({ component: "worker-wiring" });
  const parsed = parseWiringEnv(env);
  const binding = resolveEngineBinding(env);

  // --- storage (§3.1 objects) -------------------------------------------------
  const storageResult: StorageResult<Storage> | null =
    parsed.STORAGE_DRIVER === undefined ? null : createStorageFromEnv(env);
  const objects: ObjectStorage =
    storageResult !== null && storageResult.ok
      ? storageToObjectStorage(storageResult.value)
      : unconfiguredObjectStorage(logger);
  if (parsed.STORAGE_DRIVER !== undefined && (storageResult === null || !storageResult.ok)) {
    logger.warn("object storage env rejected — previews/exports will fail typed", {
      code: storageResult !== null && !storageResult.ok ? isStorageError(storageResult) ? storageResult.code : "storage_config_invalid" : "storage_config_invalid",
    });
  }

  // --- database (§3.1 db) -------------------------------------------------
  const queryDb: Db | null =
    parsed.DATABASE_URL === undefined || parsed.DATABASE_URL.length === 0
      ? null
      : createDb(parsed.DATABASE_URL);
  if (queryDb === null) {
    logger.warn("DATABASE_URL is not set — run/ledger/event adapters are unconfigured");
  }
  const runRepository = queryDb === null ? unconfiguredRunRepository(logger) : new DrizzleRunRepository(queryDb);
  const ledger: LedgerStore = queryDb === null ? unconfiguredLedgerStore(logger) : new DrizzleLedgerStore(queryDb);
  const commandLog = queryDb === null ? null : new DrizzleCommandLog(queryDb);

  // --- events (§13.2/§22) -------------------------------------------------
  const eventBus = new RunEventBus({
    store: queryDb === null ? unconfiguredEventStore(logger) : new DrizzleEventStore(queryDb),
  });
  const emit: EmitRunEvent = (runId, type, payload, context) =>
    eventBus.publish(runId, type, payload, { organizationId: context.organizationId });

  // --- engine sessions (§3.2) -------------------------------------------------
  const registry = new SessionRegistry();
  const journalFor = (sessionId: string): SessionJournal => ({
    append: async (row) => {
      if (commandLog === null) {
        throw new Error("[worker-wiring] the command log is not configured (DATABASE_URL missing)");
      }
      await commandLog.append({ documentId: journalDocumentOf(sessionId, registry), ...row });
    },
  });
  const allocator: SessionAllocatorLike =
    binding.mode === "mock"
      ? new MockEngineAdapter({
          port: parsed.MOCK_ENGINE_PORT,
          token: parsed.MOCK_ENGINE_TOKEN,
          registry,
          journalFor,
          logger: logger.child({ component: "mock-engine", mode: binding.reason }),
        })
      : new PoolSessionAllocator(logger.child({ component: "engine-pool" }));

  // --- cancellation (W6-J contract) -------------------------------------------------
  const cancellation: RunCancellationSource = {
    observe: async (runId) => {
      if (queryDb === null) {
        return { cancelled: false };
      }
      const rows = await queryDb
        .select({ status: agentRuns.status, error: agentRuns.error })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const row = rows[0];
      if (row === undefined || row.status !== "cancelled") {
        return { cancelled: false };
      }
      const reason = row.error?.message;
      return { cancelled: true, ...(reason === undefined ? {} : { reason }) };
    },
  };

  // --- tools + models (§6.2 / §5.3) -------------------------------------------------
  const previews = new PreviewPipeline({ storage: objects });
  const tools = createToolContextFactory({
    objects,
    previews,
    db: runRepository,
    commandLog,
    queryDb,
    logger,
  });
  const models = createUnconfiguredModelFactory(logger);

  // --- transactions (§5.6) -------------------------------------------------
  const transactions: TransactionSeams = {
    wal: {
      append: async (row) => {
        if (commandLog === null) {
          throw new Error("[worker-wiring] the command log is not configured (DATABASE_URL missing)");
        }
        await commandLog.append({
          documentId: row.documentId,
          commandName: row.commandName,
          params: row.params,
          revisionBefore: row.revisionBefore,
          revisionAfter: row.revisionAfter,
          ...(row.flag === undefined ? {} : { flag: row.flag }),
        });
      },
    },
    storage: {
      put: async (key, bytes) => {
        await objects.put(key, bytes);
      },
    },
    checkpointFor: (run) => ({
      save: async (checkpointInput) => {
        if (queryDb === null) {
          throw new Error("[worker-wiring] the checkpoint store is not configured (DATABASE_URL missing)");
        }
        await queryDb.insert(documentVersions).values({
          documentId: checkpointInput.documentId,
          organizationId: run.organizationId,
          label: `agent-run ${checkpointInput.runId.slice(0, 48)}`,
          revision: checkpointInput.revision,
          checkpointRef: checkpointInput.checkpointRef as Record<string, unknown>,
          storageKey: checkpointInput.storageKey,
          createdBy: run.userId,
        });
      },
    }),
    maxMutatingCommandsPerRun: MAX_MUTATING_COMMANDS_PER_RUN,
  };

  // --- §3.4 recovery (W6-M) -------------------------------------------------
  const resumeGate = createInMemoryResumeGate();
  const refund: RefundLike = {
    release: async (request: RefundRequest): Promise<RefundOutcome> => {
      const amount = request.amountReserved ?? (await reservationAmount(queryDb, request.runId));
      if (amount === null) {
        return {
          ok: false,
          code: "reservation_missing",
          message: "The credit hold for this run could not be found",
          hint: "The gateway creates the reservation before enqueueing (§3.3 step 2).",
          retryable: false,
        };
      }
      const released = await releaseReservation(ledger, {
        organizationId: request.organizationId,
        runId: request.runId,
        amount,
      });
      if (released.ok) {
        return {
          ok: true,
          amountRefunded: released.value.amountRefunded,
          duplicate: released.value.duplicate,
        };
      }
      return {
        ok: false,
        code: released.code,
        message: released.message,
        ...(released.hint === undefined ? {} : { hint: released.hint }),
      };
    },
  };
  const markFailedClean: import("./recovery/run-recovery.js").RunManagerLike = {
    markFailedClean: async (markInput) => {
      await runRepository.finalizeRun({
        runId: markInput.runId,
        status: "failed",
        revisionAfter: markInput.documentRevision,
        creditsCharged: 0,
        error: {
          code: markInput.error.code,
          message: markInput.error.message,
          ...(markInput.error.hint === undefined ? {} : { hint: markInput.error.hint }),
          retryable: markInput.error.retryable,
        },
        finishedAt: new Date(),
      });
    },
  };
  const recoveryDeps: RunRecoveryDeps = {
    wal:
      commandLog === null
        ? unconfiguredWalRead(logger)
        : {
            slice: async (documentId, fromRevision) => commandLog.slice(documentId, fromRevision),
          },
    checkpoint: null, // resolved per recovery: latest checkpoint for the document
    pool: {
      reallocate: async (request: ReallocationRequest) => allocator.reallocate(request),
    } satisfies PoolLike,
    attach: createRecoveryAttachExecutor({ registry, allocator, commandLog, objects, logger }),
    gate: resumeGate,
    budget: { maxReplayedCommands: MAX_MUTATING_COMMANDS_PER_RUN },
    runManager: markFailedClean,
    refund,
  };
  const recoveryService = new RunRecoveryService(recoveryDeps);

  const deps: RunManagerDeps = {
    logger: options.logger,
    db: runRepository,
    ledger,
    emit,
    engines: { acquire: (request) => allocator.acquire(request) },
    recovery: { recover: () => Promise.reject(new Error("unwired")) },
    cancellation,
    models,
    tools,
    previews,
    transactions,
    ...(options.overrides ?? {}),
  };

  return {
    deps,
    engines_: { allocator, registry, objects, commandLog, queryDb, recoveryService },
  };
}

/** The document id of a bound session (sessions are per document, §3.2). */
function journalDocumentOf(sessionId: string, registry: SessionRegistry): string {
  return sessionId.includes("-") ? sessionId.split("-").slice(1).join("-") : sessionId;
}

async function reservationAmount(queryDb: Db | null, runId: string): Promise<number | null> {
  if (queryDb === null) {
    return null;
  }
  const rows = await queryDb
    .select({ amount: creditReservations.amount })
    .from(creditReservations)
    .where(eq(creditReservations.runId, runId))
    .limit(1);
  return rows[0]?.amount ?? null;
}

// --- unconfigured adapters (typed, loud, never silent) ------------------------

const unconfigured = (operation: string): Error =>
  new Error(`[worker-wiring] ${operation} is not configured (DATABASE_URL missing)`);

function unconfiguredRunRepository(logger: Logger): import("./run-manager/deps.js").RunRepository {
  const refuse = (operation: string): never => {
    logger.error("run repository refused an operation", { operation });
    throw unconfigured(`run repository ${operation}`);
  };
  return {
    loadRun: async () => {
      refuse("loadRun");
    },
    updateStatus: async () => {
      refuse("updateStatus");
    },
    savePlan: async () => {
      refuse("savePlan");
    },
    recordUsage: async () => {
      refuse("recordUsage");
    },
    finalizeRun: async () => {
      refuse("finalizeRun");
    },
  };
}

function unconfiguredLedgerStore(logger: Logger): LedgerStore {
  const refuse = (operation: string): never => {
    logger.error("ledger refused an operation", { operation });
    throw unconfigured(`credit ledger ${operation}`);
  };
  return {
    append: async () => {
      refuse("append");
    },
    balanceAfter: async () => {
      refuse("balanceAfter");
    },
    findByIdempotency: async () => {
      refuse("findByIdempotency");
    },
  };
}

function unconfiguredEventStore(logger: Logger): EventStoreLike {
  const refuse = (operation: string): never => {
    logger.error("event store refused an operation", { operation });
    throw unconfigured(`run event store ${operation}`);
  };
  return {
    append: async () => {
      refuse("append");
    },
    sinceSeq: async () => {
      refuse("sinceSeq");
    },
    maxSeq: async () => {
      refuse("maxSeq");
    },
  };
}

function unconfiguredWalRead(logger: Logger): WalReadLike {
  return {
    slice: async () => {
      logger.error("WAL read refused — the command log is not configured");
      throw unconfigured("command log slice");
    },
  };
}

// ---------------------------------------------------------------------------
// PART 11 — the factory the bootstrap consumes
// ---------------------------------------------------------------------------

/**
 * The run processor factory (task-pinned seam): builds the deps via
 * buildRunManagerDeps and adapts W6-N's StudioRunProcessor onto W1-I's
 * RunProcessor contract (thin delegation — no pipeline logic lives here).
 * Per-job construction wires the §3.4 recovery classification with the REAL
 * BullMQ attempt number (W6-M shouldResume/recoveryActionForJob).
 */
export function createRunProcessor(env: RunManagerEnv, options: RunProcessorOptions): RunProcessor {
  const logger = options.logger.child({ component: "run-processor" });
  const { deps, engines_ } = buildRunManagerDeps(env, options);
  const baseDeps: RunManagerDeps = { ...deps };

  return {
    process: async (job: RunJobContext): Promise<RunOutcome> => {
      const recovery = createCrashRecoveryBridge({
        service: engines_.recoveryService,
        registry: engines_.registry,
        allocator: engines_.allocator,
        commandLog: engines_.commandLog,
        attempt: job.attempt,
        acquireInputFor: (request) => ({
          runId: request.runId,
          organizationId: request.organizationId,
          documentId: request.documentId,
          tier: job.payload.tier,
        }),
        logger,
      });
      const perJobDeps: RunManagerDeps = { ...baseDeps, recovery };
      const inner = new StudioRunProcessor(perJobDeps);
      const outcome = await inner.process(job);
      const plan = classifyJobAttempt(job.attempt);
      if (plan.action === "terminal") {
        // §3.4 guard: BullMQ stops delivering at JOB_RETRY.attempts, but a
        // misconfigured producer must not buy extra engine resumes.
        logger.warn("run attempt arrived beyond the §3.4 retry budget", {
          jobId: job.jobId,
          attempt: job.attempt,
        });
      }
      return outcome;
    },
  };
}

export type { RunRecoveryServiceDepsLike };
