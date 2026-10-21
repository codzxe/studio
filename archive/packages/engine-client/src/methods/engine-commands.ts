// @studio/engine-client — engine.execute / engine.commands / batch / jobs builders (W2-C).
//
// Sources (vendor pinned 872748fb — verified, never invented):
//   - rpc.rs `engine.execute {command, params?, wait?}`: `params` must be a JSON object,
//     omitted or null — an array/string/number/boolean is an error naming the command in
//     every transport (control-protocol.md §Methods). `wait: false` starts a job-capable
//     command as a background job: `{job, pending: true}` (rpc.rs `command_start`); a
//     command that finishes at once replies with its OWN result even with `wait: false`.
//   - §Command list replies: `engine.commands {filter?}` replies a BARE array — rows carry
//     exactly {id, label, menu, shortcut, params, enabled, disabledReason, needsDocument}
//     plus an optional `keywords` string (pinned by the rpc.rs test #3684).
//   - §Background jobs #210: poll `jobs.list` ({jobs: [{id, state, progress, …}]}),
//     cancel with `jobs.cancel {job?}`; every request first applies finished jobs.
//   - rpc.rs `batch {steps: [{command, params?, wait?} | {method, params?}],
//     stopOnError? (default true)}` → {completed, failed, results}; ≤ 256 steps; a nested
//     `batch` method step is refused.
//   - Studio §5.6/§2.2 transactional batches: wrap steps in the `agent.begin {name}` /
//     `agent.commit` / `agent.rollback` commands (engine-patches wave registers them; the
//     live registry stays authoritative per §2.2).

import { z } from "zod";
import type { ZodType, ZodTypeDef } from "zod";
import {
  type BuiltMethodCall,
  JOB_METHODS,
  MAX_BATCH_STEPS,
  type MethodBuildFailure,
  PROTOCOL_METHODS,
  REPLY_DEADLINE_MS,
  SERVED_METHODS,
  type WireSender,
  buildCall,
  buildFailure,
  parseEngineReply,
  summarizeIssues,
} from "./protocol.js";

const nonNegativeInt = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// engine.execute — one command by id (waits for the result by default)
// ---------------------------------------------------------------------------

export const ENGINE_EXECUTE_PARAMS = z
  .object({
    command: z.string().min(1),
    /** Command params: a JSON object, omitted or null — never an array/string/number/bool. */
    params: z.record(z.unknown()).nullable().optional(),
    /** Default true. `wait: false` starts a long command as a background job. */
    wait: z.boolean().optional(),
  })
  .strict();

export type EngineExecuteParams = z.infer<typeof ENGINE_EXECUTE_PARAMS>;
export type EngineExecuteInput = EngineExecuteParams;

/**
 * `engine.execute` with the command's own (untyped) result. Pass `resultSchema` to parse a
 * known command reply — e.g. `layer.list` rows — instead of an opaque value.
 */
export function engineExecute<TResult = unknown>(
  input: EngineExecuteInput,
  resultSchema?: ZodType<TResult, ZodTypeDef, unknown>,
): BuiltMethodCall<EngineExecuteParams, TResult> {
  // No schema given: the result stays opaque (`TResult` defaults to `unknown`); the
  // caller may parse the raw value itself. The double cast is only for that default.
  const fallback = z.unknown() as unknown as ZodType<TResult, ZodTypeDef, unknown>;
  return buildCall(
    PROTOCOL_METHODS.engineExecute,
    ENGINE_EXECUTE_PARAMS,
    input,
    resultSchema ?? fallback,
  );
}

// ---------------------------------------------------------------------------
// engine.execute with wait:false — background job start (§Background jobs)
// ---------------------------------------------------------------------------

export const JOB_PENDING_SCHEMA = z
  .object({ job: nonNegativeInt, pending: z.literal(true) })
  .passthrough();

export type JobPending = z.infer<typeof JOB_PENDING_SCHEMA>;

export function isJobPending(value: unknown): value is JobPending {
  const pending = JOB_PENDING_SCHEMA.safeParse(value);
  return pending.success;
}

/**
 * `engine.execute {…, wait: false}`: a job-capable command replies `{job, pending: true}`;
 * one that finishes at once replies with its own result (rpc.rs `command_start`). The
 * result schema accepts both — narrow with `isJobPending` and poll `jobs.list`.
 */
export const BACKGROUND_EXECUTE_RESULT = z.union([JOB_PENDING_SCHEMA, z.unknown()]);

export type BackgroundExecuteResult = unknown;

export function engineExecuteBackground(input: {
  readonly command: string;
  readonly params?: Record<string, unknown> | null;
}): BuiltMethodCall<EngineExecuteParams, BackgroundExecuteResult> {
  return buildCall(
    PROTOCOL_METHODS.engineExecute,
    ENGINE_EXECUTE_PARAMS,
    { ...input, wait: false },
    BACKGROUND_EXECUTE_RESULT,
  );
}

// ---------------------------------------------------------------------------
// engine.commands — the live registry (§Command list replies: a bare array)
// ---------------------------------------------------------------------------

export const COMMAND_ENTRY_SCHEMA = z
  .object({
    id: z.string(),
    label: z.string(),
    menu: z.array(z.string()),
    shortcut: z.string().nullable(),
    /** Human-readable parameter doc — NOT a JSON schema. */
    params: z.string(),
    enabled: z.boolean(),
    /** null exactly when enabled (pinned by the rpc.rs test). */
    disabledReason: z.string().nullable(),
    needsDocument: z.boolean(),
    keywords: z.string().optional(),
  })
  .passthrough();

export type CommandEntry = z.infer<typeof COMMAND_ENTRY_SCHEMA>;

/** A bare JSON array of command rows — no `{"commands": …}` wrapper (rpc.rs #3684). */
export const COMMAND_LIST_RESULT = z.array(COMMAND_ENTRY_SCHEMA);
export type CommandListResult = z.infer<typeof COMMAND_LIST_RESULT>;

const ENGINE_COMMANDS_PARAMS = z.object({ filter: z.string().optional() }).strict();
export type EngineCommandsParams = z.infer<typeof ENGINE_COMMANDS_PARAMS>;

export function engineCommands(
  input: { readonly filter?: string } = {},
): BuiltMethodCall<EngineCommandsParams, CommandListResult> {
  return buildCall(
    PROTOCOL_METHODS.engineCommands,
    ENGINE_COMMANDS_PARAMS,
    input,
    COMMAND_LIST_RESULT,
  );
}

// ---------------------------------------------------------------------------
// methods — the served method list (rpc.rs replies its `METHODS` array)
// ---------------------------------------------------------------------------

export const METHODS_RESULT = z.array(z.string());

export function methodsCall(): BuiltMethodCall<Record<string, never>, string[]> {
  return buildCall(PROTOCOL_METHODS.methods, z.object({}).strict(), {}, METHODS_RESULT);
}

// ---------------------------------------------------------------------------
// jobs.list / jobs.cancel (§Background jobs #210)
// ---------------------------------------------------------------------------

export const JOB_INFO_SCHEMA = z
  .object({
    id: nonNegativeInt,
    command: z.string(),
    label: z.string(),
    /** The document the job edits (and locks), if any. */
    document: nonNegativeInt.nullable(),
    state: z.enum(["running", "done", "failed", "cancelled"]),
    /** 0..1. */
    progress: z.number(),
    message: z.string(),
    elapsedMs: z.number(),
    /** The command's result (done) or the error (failed); absent while running. */
    result: z.unknown(),
    error: z.string().optional(),
  })
  .passthrough();

export type JobInfo = z.infer<typeof JOB_INFO_SCHEMA>;
export type TerminalJobState = "done" | "failed" | "cancelled";
export type TerminalJobInfo = JobInfo & { state: TerminalJobState };

export function isTerminalJob(job: JobInfo): job is TerminalJobInfo {
  return job.state !== "running";
}

export const JOBS_LIST_RESULT = z.object({ jobs: z.array(JOB_INFO_SCHEMA) }).passthrough();
export type JobsListResult = z.infer<typeof JOBS_LIST_RESULT>;

export function jobsList(): BuiltMethodCall<Record<string, never>, JobsListResult> {
  return buildCall(JOB_METHODS.jobsList, z.object({}).strict(), {}, JOBS_LIST_RESULT);
}

const JOBS_CANCEL_PARAMS = z.object({ job: nonNegativeInt.optional() }).strict();
export type JobsCancelParams = z.infer<typeof JOBS_CANCEL_PARAMS>;

export const JOBS_CANCEL_RESULT = z.object({ cancelled: nonNegativeInt }).passthrough();
export type JobsCancelResult = z.infer<typeof JOBS_CANCEL_RESULT>;

/** Omit `job` to cancel every running job (rpc.rs forwards params to `jobs.cancel`). */
export function jobsCancel(
  input: { readonly job?: number } = {},
): BuiltMethodCall<JobsCancelParams, JobsCancelResult> {
  return buildCall(JOB_METHODS.jobsCancel, JOBS_CANCEL_PARAMS, input, JOBS_CANCEL_RESULT);
}

// ---------------------------------------------------------------------------
// batch — ordered steps, stop-on-error by default (rpc.rs `batch`)
// ---------------------------------------------------------------------------

export const COMMAND_STEP_SCHEMA = z
  .object({
    command: z.string().min(1),
    params: z.record(z.unknown()).nullable().optional(),
    wait: z.boolean().optional(),
  })
  .strict();

export const METHOD_STEP_SCHEMA = z
  .object({
    method: z.string().min(1),
    params: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export const BATCH_STEP_SCHEMA = z.union([COMMAND_STEP_SCHEMA, METHOD_STEP_SCHEMA]);

export type CommandStep = z.infer<typeof COMMAND_STEP_SCHEMA>;
export type MethodStep = z.infer<typeof METHOD_STEP_SCHEMA>;
export type BatchStep = CommandStep | MethodStep;
export type BatchStepInput = CommandStep | MethodStep;

export const BATCH_PARAMS = z
  .object({
    steps: z.array(BATCH_STEP_SCHEMA),
    stopOnError: z.boolean().optional(),
  })
  .strict();

export type BatchParams = z.infer<typeof BATCH_PARAMS>;
export interface BatchInput {
  readonly steps: readonly BatchStepInput[];
  readonly stopOnError?: boolean;
}

export const BATCH_STEP_OUTCOME = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type BatchStepOutcome = z.infer<typeof BATCH_STEP_OUTCOME>;

export const BATCH_RESULT = z
  .object({
    completed: nonNegativeInt,
    failed: nonNegativeInt,
    results: z.array(BATCH_STEP_OUTCOME),
  })
  .passthrough();

export type BatchResult = z.infer<typeof BATCH_RESULT>;

type CheckedSteps = { readonly ok: true; readonly steps: BatchStep[] } | MethodBuildFailure;

/** Fail-fast step checks mirroring rpc.rs: step count, command-vs-method, nested batch,
 *  served-method names. */
function checkBatchSteps(raw: readonly unknown[], limit: number): CheckedSteps {
  if (!Array.isArray(raw)) {
    return buildFailure("invalid_params", "`steps` must be an array");
  }
  if (raw.length > limit) {
    return buildFailure(
      "engine_limit",
      `batch contains ${raw.length} steps; maximum is ${MAX_BATCH_STEPS}`,
      "split the work across several batch calls",
    );
  }
  const steps: BatchStep[] = [];
  for (const [i, step] of raw.entries()) {
    if (typeof step !== "object" || step === null) {
      return buildFailure("invalid_params", `step ${i} must be an object`);
    }
    const record = step as Record<string, unknown>;
    const hasCommand = record.command !== undefined;
    const hasMethod = record.method !== undefined;
    if (hasCommand && hasMethod) {
      return buildFailure("invalid_params", `step ${i}: pass \`command\` or \`method\`, not both`);
    }
    if (!hasCommand && !hasMethod) {
      return buildFailure("invalid_params", `step ${i} needs \`command\` or \`method\``);
    }
    if (hasMethod) {
      const method = record.method;
      if (method === PROTOCOL_METHODS.batch) {
        return buildFailure(
          "invalid_params",
          `step ${i}: the engine refuses a nested \`batch\` step`,
          "split the steps into two batch calls",
        );
      }
      if (typeof method !== "string" || !(SERVED_METHODS as readonly string[]).includes(method)) {
        return buildFailure(
          "invalid_params",
          `step ${i}: unknown method \`${String(method)}\` (try \`methods\`)`,
        );
      }
    }
    const parsed = (hasCommand ? COMMAND_STEP_SCHEMA : METHOD_STEP_SCHEMA).safeParse(step);
    if (!parsed.success) {
      return buildFailure("invalid_params", `step ${i}: ${summarizeIssues(parsed.error)}`);
    }
    steps.push(parsed.data);
  }
  return { ok: true, steps };
}

export function batch(input: BatchInput): BuiltMethodCall<BatchParams, BatchResult> {
  const checked = checkBatchSteps(input.steps, MAX_BATCH_STEPS);
  if (!checked.ok) {
    return checked;
  }
  return buildCall(
    PROTOCOL_METHODS.batch,
    BATCH_PARAMS,
    { steps: checked.steps, stopOnError: input.stopOnError },
    BATCH_RESULT,
  );
}

// ---------------------------------------------------------------------------
// §5.6 transactional batches — agent.begin {name} … agent.commit / agent.rollback
// ---------------------------------------------------------------------------

export interface TransactionalBatchInput {
  /** Checkpoint name for `agent.begin` (§5.6: a stable id for one undoable run). */
  readonly name: string;
  readonly steps: readonly BatchStepInput[];
  /** Only `true` (or omitted) is accepted: a failed transactional batch stops BEFORE
   *  `agent.commit` and the caller rolls back with `agent.rollback`. */
  readonly stopOnError?: boolean;
}

export function agentBegin(name: string): BuiltMethodCall<EngineExecuteParams, unknown> {
  return engineExecute({ command: "agent.begin", params: { name } });
}

export function agentCommit(): BuiltMethodCall<EngineExecuteParams, unknown> {
  return engineExecute({ command: "agent.commit" });
}

export function agentRollback(): BuiltMethodCall<EngineExecuteParams, unknown> {
  return engineExecute({ command: "agent.rollback" });
}

/**
 * A §5.6 run transaction: `agent.begin {name}`, the steps, then `agent.commit`, with
 * stopOnError forced (rpc.rs default) so a failed step stops the batch before the commit
 * step runs. On `failed > 0` the caller MUST send `agent.rollback` (helper above) — earlier
 * steps are never rolled back by the batch itself (§Transport limits). `agent.*` commands
 * come from the studio engine-patches wave (§2.3); §2.2 keeps the live registry
 * authoritative, so worker startup must verify them via `engine.commands`.
 */
export function transactionalBatch(
  input: TransactionalBatchInput,
): BuiltMethodCall<BatchParams, BatchResult> {
  if (input.stopOnError === false) {
    return buildFailure(
      "invalid_params",
      "a transactional batch must stop before `agent.commit` when a step fails; roll back with `agent.rollback`",
    );
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return buildFailure("invalid_params", "`name` for agent.begin must be a non-empty string");
  }
  // begin + commit occupy two of the 256 step slots.
  const checked = checkBatchSteps(input.steps, MAX_BATCH_STEPS - 2);
  if (!checked.ok) {
    return checked;
  }
  const steps: BatchStep[] = [
    { command: "agent.begin", params: { name: input.name } },
    ...checked.steps,
    { command: "agent.commit" },
  ];
  return buildCall(PROTOCOL_METHODS.batch, BATCH_PARAMS, { steps }, BATCH_RESULT);
}

// ---------------------------------------------------------------------------
// waitForJob — jobs.list polling for `wait: false` long operations (§Background jobs)
// ---------------------------------------------------------------------------

export type JobWaitFailureCode =
  | "invalid_params"
  | "engine_error"
  | "job_timeout"
  | "job_lost"
  | "aborted";

export type JobWaitOutcome =
  | { readonly ok: true; readonly job: TerminalJobInfo }
  | {
      readonly ok: false;
      readonly code: JobWaitFailureCode;
      readonly message: string;
      readonly hint?: string;
      readonly retryable?: boolean;
    };

export interface WaitForJobOptions {
  /** Poll interval; default 50 ms. */
  readonly intervalMs?: number;
  /** Overall wait; default 60 s (the engine reply deadline). Raise for long jobs. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Poll `jobs.list` until job `jobId` reaches a terminal state (done/failed/cancelled).
 * Every jobs.list call first applies finished jobs (rpc.rs `sync_jobs`), so the returned
 * job's `result` (done) or `error` (failed) reflects the applied document. A job missing
 * for three consecutive polls never existed or ended and was evicted from the 16-slot
 * recent list — reported as `job_lost`, never as success. Reply parsing never throws;
 * a rejecting `send` (transport failure) still rejects to its caller.
 */
export async function waitForJob(
  send: WireSender,
  jobId: number,
  options: WaitForJobOptions = {},
): Promise<JobWaitOutcome> {
  if (!Number.isSafeInteger(jobId) || jobId < 0) {
    return { ok: false, code: "invalid_params", message: "`jobId` must be a non-negative integer" };
  }
  const intervalMs = options.intervalMs ?? 50;
  const timeoutMs = options.timeoutMs ?? REPLY_DEADLINE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    return {
      ok: false,
      code: "invalid_params",
      message: "intervalMs and timeoutMs must be non-negative",
    };
  }
  const startedAt = now();
  let misses = 0;
  for (;;) {
    if (options.signal?.aborted) {
      return { ok: false, code: "aborted", message: "job wait aborted by the caller" };
    }
    const reply = await send({ method: JOB_METHODS.jobsList, params: {} });
    const outcome = parseEngineReply(reply, JOBS_LIST_RESULT, JOB_METHODS.jobsList);
    if (!outcome.ok) {
      return { ok: false, code: "engine_error", message: outcome.error, retryable: false };
    }
    const job = outcome.result.jobs.find((entry) => entry.id === jobId);
    if (job !== undefined) {
      if (isTerminalJob(job)) {
        return { ok: true, job };
      }
      misses = 0;
    } else {
      misses += 1;
      if (misses >= 3) {
        return {
          ok: false,
          code: "job_lost",
          message: `job ${jobId} is not in jobs.list`,
          hint: "the id never existed, or the job ended and was evicted from the 16-slot recent list",
          retryable: false,
        };
      }
    }
    if (now() - startedAt >= timeoutMs) {
      return {
        ok: false,
        code: "job_timeout",
        message: `job ${jobId} did not finish within ${timeoutMs} ms`,
        hint: "raise timeoutMs or cancel the job with jobs.cancel",
        retryable: true,
      };
    }
    await sleep(intervalMs);
  }
}
