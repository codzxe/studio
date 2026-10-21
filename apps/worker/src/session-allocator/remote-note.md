# remote-note — the compose-boundary evolution of the session allocator

Owner: W10-M. Companion to `local-allocator.ts` (the SINGLE-BOX §3.2 session
allocator). This note is the contract-keeping document for §3.2's split:
**when the engine-pool runs as its own service, this allocator becomes a
client of the pool's future HTTP/IPC interface — and nothing else changes.**

## 1. Why this file exists (§3.2 + §17.1)

§3.1 puts `engine-pool` in the service table ("Supervisor spawning
`photocraft-cli serve`; one engine process per active document/session; own
256-bit token and capability roots per tenant; idle timeout; crash restart;
graceful drain"), but §17.1 settles the FIRST deployment on one box: gateway +
worker + engine pool + db + valkey on a single Lightsail instance. §3.1's own
closing line: *"Start single-box with Docker Compose; split out the worker /
engine pool only when load demands it."*

So today the worker supervises engine processes DIRECTLY
(`LocalSessionAllocator`, this directory). The run-manager's session seams —
`EngineSessionFactory` / `EngineSessionHandle` in
`apps/worker/src/run-manager/deps.ts` (W6-N) and `SessionAllocatorLike` in
`apps/worker/src/processor.ts` PART 5 (the TODO(W9) pool-service stub) — were
deliberately shaped so the implementation behind them can be swapped.

## 2. The stable interface (what must NOT drift)

The public surface `LocalSessionAllocator` implements today is the exact
surface the pool-service client will implement tomorrow:

| Surface | Shape | Spec |
| --- | --- | --- |
| Allocate | `allocate(documentId, organizationId) → { sessionId, endpoint, port, token, capabilities }` | §3.2 allocate + attach |
| Keep-warm release | `allocation.release()` → session goes idle, starts its idle clock | §3.2 idle keep-warm |
| Idle recycle | sweep past the per-session idle timeout: `save checkpoint → recycle` | §3.2 / §3.4 (15 min) |
| Per-org caps | injected `SessionLimitsProvider` (billing limits service, §14.1 ladder 1/3/6) | §3.2 plan limit |
| Typed errors | `SessionAllocatorError` envelopes: `session_limit_reached` (retryable), `session_not_found`, `spawn_failed`, `engine_unavailable`, `validation_failed` | §4 / §13.3 vocabulary |
| Tenant isolation | tenant-scoped lookups; a foreign org gets the same `session_not_found`/`undefined` as an unknown id; fresh 256-bit token per process; capability roots under `organizations/<org>/sessions/<session>` | §3.2 / §15.1 |

Over the wire (HTTP or IPC — decided when the pool service lands) these
become: `POST /sessions` (allocate/attach), `POST /sessions/:id/release`,
`POST /sessions/:id/touch`, plus the pool's own watchdog. The response body is
the allocation descriptor; the token stays on the internal network
(§3.2: only gateway/worker ever see it, never the browser).

## 3. One file swap

The swap is mechanical:

1. Add `@studio/engine-pool` (or a new `@studio/pool-client`) to
   `apps/worker/package.json` — the manifest edge that today forces the mirrors
   in `local-allocator.ts` (serve-config argv, error envelopes, binding
   decision; see the mirror notes in that file's header).
2. Implement `RemoteSessionAllocator` with the same public surface, whose
   `spawner.launch` equivalent is a fetch/IPC call instead of
   `child_process.spawn`. Both `serve-config.ts` and `errors.ts` are already
   exported from the pool's barrel (`apps/engine-pool/src/index.ts`), so the
   client side imports the CANONICAL contracts instead of mirroring them.
3. Change ONE wiring line where the composition root picks the allocator
   (today: `createLocalSessionAllocator`; tomorrow:
   `createRemoteSessionAllocator`). The run-manager (`deps.ts`
   `EngineSessionFactory`, processor.ts `SessionAllocatorLike`), the recovery
   service (`apps/worker/src/recovery/run-recovery.ts`), and every test fake
   are untouched — that is the whole point of the seam.

## 4. What moves into the pool service (and what stays)

Moves to the pool service:

- Process supervision: spawn/stop, SIGTERM→SIGKILL escalation, readiness
  (the `serving on 127.0.0.1:<port>` line), the token file (0600), crash
  detection (`EngineSessionState: "crashed"`), the watchdog sweep.
- FLEET-WIDE per-org caps: a pool service sees every replica's sessions, so
  the §14.1 cap becomes exact again (see caveat below).
- Idle recycling TIMING; the client keeps only the `release`/`touch`
  bookkeeping.

Stays in the worker:

- The engine-session adapters over `@studio/engine-client` (endpoint + token →
  `EngineClient` → `EngineSessionHandle`: `tx`, `commands`, `previewEngine`) —
  those live in processor.ts / engine-session land, not here.
- The §3.4 recovery orchestration (`run-recovery.ts`): the replacement session
  is just another `allocate()` (or pool call); the WAL replay + resume-once
  budget are worker concerns.
- The §3.2 checkpoint is requested by whoever recycles the session; locally the
  allocator's `IdleCheckpointSeam` does `doc.save` via `@studio/engine-client`
  before stopping the process. Remotely the pool does the same or the worker
  receives a `session_evicted` event and checkpoints first — the event payload
  already carries everything needed.

## 5. Honest caveats for the single-box present

- **Replica under-count:** `docker-compose.yml` runs TWO worker replicas. Each
  replica's `LocalSessionAllocator` enforces the §14.1 cap against ITS OWN
  sessions, so two replicas can hold up to `2 × cap` processes per org. This is
  acceptable at §17.1 scale (first ~10–20 users) and is exactly the first
  reason to split the pool out; a stopgap is a shared `countSessions` seam
  (Valkey) behind `billingSessionLimits` if the org nears its cap.
- **Crash restart:** the local allocator stops and forgets processes; §3.4
  crash classification + resume-once recovery live in
  `apps/worker/src/recovery/` and are driven by the engine-client's crash
  envelopes (`engine_crashed`, `reply_timeout`), not by process watchers here.
  The pool service adds process-level crash detection on top.
- **stdio transport:** the mirrored spawn contract covers the TCP leg only
  (`--port 0` → kernel-ephemeral loopback). engine-pool's `serve-config.ts`
  also supports the stdio JSON-lines transport; the worker never uses it.

## 6. Wiring checklist (for the composition-root owner)

- Construct once per worker process: `createLocalSessionAllocator({ env, lookup })`
  with a `SubscriptionLookup` backed by the billing tables (or pass a
  `SessionLimitsProvider` adapted from `PlanLimitsService`).
- Feed `allocator.inFlightCount(orgId)` to the billing `countSessions` seam so
  the gateway's own gates agree with the allocator's.
- Call `allocator.drain()` on worker shutdown (graceful stop of every engine
  process; the sweeper timer is `unref`'d and never holds the loop).
- Route `onSessionEvent` into the §22 observability sink (metric names mirror
  engine-pool's `PoolEvent` vocabulary).
