# apps/worker

BullMQ worker for the studio SaaS. Consumes run, export and image jobs from
Valkey, executes the agent loop against the engine pool, and commits results
(spec §3.1: worker = agent loop, tools, critic, exports).

**Wave 1 status: skeleton.** Queue topology, payload contracts, injectable
processors, health endpoint and graceful shutdown are wired; the real
agent-loop processor arrives in Wave 6 (`packages/agent`).

## Queues (`src/queues.ts`)

One queue per model tier (§3.1) so each tier gets isolated concurrency and
priority (§5.2):

| Queue          | Payload (Zod)                                                                 | Notes                                          |
| -------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `runs:quick`   | `runId, organizationId, tier`                                                  | 2-min wall clock                               |
| `runs:standard`| `runId, organizationId, tier`                                                  | 5-min wall clock                               |
| `runs:complex` | `runId, organizationId, tier`                                                  | 10-min wall clock                              |
| `runs:premium` | `runId, organizationId, tier`                                                  | 10-min wall clock                              |
| `runs:max`     | `runId, organizationId, tier`                                                  | 15-min wall clock                              |
| `exports`      | `documentId, format: pcraft\|png\|jpg\|psd, width?, height?, quality?, idempotencyKey` | producers set BullMQ jobId = idempotencyKey |
| `images`       | `prompt, sizeClass, runId`                                                     | §5.2 image gen, billed per 1024²               |

- Payload schemas live in `src/queues.ts` (Zod at every boundary). Invalid
  payloads throw `InvalidJobPayloadError` and the job fails after the retry
  budget (`JOB_RETRY`, §3.4) — a schema violation can never succeed on retry.
- `QUEUE_NAMES`, `RUN_QUEUE_BY_TIER` and `runQueueName(tier)` are the shared
  vocabulary for the gateway enqueue side (later waves).
- Timeouts: `TIMEOUTS_MS` (§3.4: tool 5 s, render 30 s, run 10 min, session
  idle 15 min) and `TIER_WALL_CLOCK_MS` (§5.2 tier wall clocks). The per-run
  `AbortSignal` deadline is wired in `src/index.ts`; tool/render caps are
  enforced by the Wave-6 loop.

## Environment

Parsed once at boot by `src/env.ts` (Zod; missing/invalid vars refuse to
start — no defaulted secrets):

| Var                  | Default     | Meaning                                   |
| -------------------- | ----------- | ----------------------------------------- |
| `VALKEY_URL`         | — (required)| `redis://` connection string for BullMQ     |
| `WORKER_CONCURRENCY`  | `8`         | total across all queues, split per worker  |
| `WORKER_HEALTH_PORT` | `9876`      | internal health endpoint port             |
| `WORKER_HEALTH_HOST` | `127.0.0.1` | bind address (keep loopback)              |
| `LOG_LEVEL`          | `info`      | pino level                                |
| `NODE_ENV`           | `development` | standard                                 |

> TODO: move env parsing to `packages/config` once that package lands (owned
> by another wave); this local schema mirrors its contract.

## Health

`GET /health` (plain `node:http`, `src/health.ts`) on
`WORKER_HEALTH_HOST:PORT` returns
`{ ok, service, uptimeSeconds, queues: [{ queue, waiting, active, delayed, completed, failed }] }`.
Depths come from an injected `QueueStatsSource`, so the endpoint is testable
without Valkey. Internal ops only — do not proxy it.

## Processor seam (how Wave 6 plugs in)

`src/processor.ts` defines:

- `RunProcessor` — `{ process(job: RunJobContext): Promise<RunOutcome> }`
- `RunOutcome` — `status: succeeded | succeeded_with_warnings | failed`
  (§5.1) plus credits/checkpoint/warnings and a typed `RunError` envelope
  `{ ok: false, code, message, hint?, retryable? }`
- `StubRunProcessor` — the current implementation: logs a TODO and succeeds.

`src/index.ts` constructs the processor in exactly one place:

```ts
const runProcessor: RunProcessor = new StubRunProcessor(logger); // ← Wave 6: real agent loop
```

Swap that line; queue wiring, retry semantics and shutdown stay untouched. A
failed outcome with `error.retryable: true` is re-thrown so BullMQ retries
with backoff (§3.4); non-retryable failures complete and are recorded.
`RunJobContext.signal` aborts at the tier wall clock (§5.2).

Exports and images currently run stub handlers (`makeStubJobHandler`) — also
Wave 6+ work.

## Shutdown

`SIGTERM`/`SIGINT` → close workers (draining in-flight jobs) → close queues →
close health server → drop the Valkey connection → exit. `uncaughtException`/
`unhandledRejection` log and trigger the same drain, then exit 1.

## Tests

`pnpm --filter @studio/worker test` — pure schema/mapping tests
(`tests/queues.test.ts`); no Redis, no network, deterministic.

## Notes for Wave 6

- BullMQ renews job locks for in-process processors, but long runs (10–15 min)
  may warrant raising `lockDuration` on the runs workers.
- The enqueue side (gateway) must pass `jobId` = `runId` (runs) /
  `idempotencyKey` (exports) for §3.4 idempotency.
- Failed-run state sync (`agent_runs` rows, refunds, SSE events) belongs to
  the Wave-6 processor; the stub intentionally leaves that untouched.
