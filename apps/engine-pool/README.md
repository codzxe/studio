# engine-pool

Supervisor for the design-engine session pool (spec §3.1, §3.2). It owns **one serve
process per active session**, never shares sessions across tenants, mints a fresh
**256-bit token per process**, enforces per-organization concurrency caps, recycles
idle sessions, and drains gracefully on shutdown.

Wave 1 ships the pure-logic skeleton: every piece of process interaction hides behind
injectable interfaces (`Spawner`, `EngineProcess`), so the whole pool is unit-tested
without ever spawning an engine (see `tests/`). The real spawner that wraps
`photocraft-cli serve` arrives in Wave 2 and implements the same seams.

## Session lifecycle (§3.2)

```
allocate ──► attach ──► run commands ──► idle ──(15 min, no activity)──► save checkpoint ──► recycle
   │           │             │              │
   │           │             │              └─ watchdogTick() stops the process, frees the cap slot
   │           │             └─ touch() refreshes lastActivityAt after every command batch
   │           └─ session bound to exactly one document (rebind refused)
   └─ validates plan cap → mints token → spawner.spawn() → process.start() → registry
```

Session states (`EngineSession.state`):

| State | Meaning |
|---|---|
| `allocated` | Process up, not yet bound to a document. |
| `attached` | Bound to a document, running commands. |
| `idle` | No active run; first candidate for idle eviction. |
| `draining` | Graceful stop in progress (release / eviction / drain). |
| `crashed` | Unexpected exit; the worker must replay from the last checkpoint. |

## Guarantees enforced here

- **One session, one tenant** (§25 rule 4). Lookups are tenant-scoped
  (`pool.get(sessionId, organizationId)`); a cross-tenant probe gets the same
  `session_not_found` as an unknown id — existence is never leaked (§15.1).
- **Fresh 256-bit token per process** (`crypto.randomBytes(32)` hex, 64 chars, §3.2/§15.1).
  Tokens are regenerated on every (re)start and must never be logged or sent to the browser.
- **Capability roots** are supplied per allocation (`readRoot`/`writeRoot`) and scoped to
  the workspace's directory; they are forwarded verbatim to the spawner.
- **Per-organization caps** come from the injected `PlanLimitsProvider` (billing owns the
  real numbers, §14). In-flight allocations count too, so racing `allocate()` calls cannot
  oversubscribe. `draining` and `crashed` sessions never consume a cap slot.
- **Idle timeout** defaults to 15 minutes (§3.4); `watchdogTick()` recycles sessions idle
  past it, most-idle first.
- **Crash marking**: process `exit`/`crash` events flip the session to `crashed`; the
  watchdog reports them each tick. A session that ignores SIGTERM past the grace window is
  marked `crashed` and reported as a `watchdog_timeout` stop failure (Wave 2 escalates to
  SIGKILL).
- **Graceful drain**: `drain()` SIGTERMs everything, forgets all sessions, and flips the
  pool into a shutdown state where `allocate()` fails with `engine_unavailable`.

## Error codes (`src/errors.ts`)

Every failure is an `EnginePoolError` with a stable `code` and a wire-ready envelope
`{ ok: false, code, message, hint, retryable? }` (§4 conventions — no stacks, no paths).

| Code | Raised when |
|---|---|
| `engine_unavailable` | The pool is drained/shutting down; a session is unusable for attach. |
| `session_limit_reached` | The organization is at its plan's concurrent-session cap. |
| `session_not_found` | Unknown id **or** cross-tenant/other-document access (deliberately identical). |
| `spawn_failed` | The spawner threw or the process never became ready. |
| `watchdog_timeout` | A session ignored SIGTERM past the grace window. |

## Replay-from-WAL recovery (§3.4) — how the worker uses this

The engine's command log **is** the WAL. The worker interacts with the pool like this:

1. Before a run: `allocate(spec)` → `attach(sessionId, org, documentId)`; load the
   document via `doc.open` from the last committed checkpoint, or by replaying the
   command log forward from it.
2. During a run: every applied command is appended to the durable command log, and
   `touch(sessionId, org)` refreshes the idle clock (batch the calls per tool-step).
3. On phase boundaries: `agent.begin` marks a checkpoint (§3.4 idempotency), so a retry
   never double-applies.
4. After a crash (session state `crashed`, or the run job failed mid-flight): the queue
   retries with backoff ×3; the worker allocates a **new** session (a crashed one does
   not consume the plan cap), replays the command log from the last checkpoint, and
   resumes once. On the final failure the run is marked failed and the reservation is
   refunded.
5. Between runs: `markIdle(...)`, and `release(sessionId)` once the tenant is done —
   the idle watchdog is the safety net, not the primary cleanup.

`watchdogTick()` is intended to be called by a supervisor interval
(`DEFAULT_WATCHDOG_INTERVAL_MS`); it never starts processes, it only stops/recycles.

## Wave 2 wire-up: the real spawner

`Spawner.spawn(request)` must return an `EngineProcess` wrapping
`photocraft-cli serve` (§2.2):

```
photocraft-cli serve \
  --port <loopback port> \
  --control-token-file <per-session 0600 temp file> \
  --automation-read-root  <request.readRoot> \
  --automation-write-root <request.writeRoot>
```

- Write `request.token` (the pool's 64-hex token) into the token **file**, not the
  command line, so the credential never shows up in `ps` (see the vendor
  `docs/control-protocol.md`). Delete the file when the process recycles.
- `serve` binds loopback only; the browser never reaches the engine (§3.2). With no
  `--port` it speaks JSON lines on stdio — fine for a single supervisor box and simpler
  than TCP; the pool leaves the choice to the spawner via `request.port`.
- `start()` should resolve only after the process is accepting work (TCP: wait for the
  serving line; stdio: first successful `methods` frame). Resolve from the `ready`/`log`
  events through `onEvent`.
- `stop(SIGTERM)` should escalate to SIGKILL after the pool's grace window
  (`drainGraceMs`); sessions killed by the watchdog's stop-failure path are already
  marked `crashed`, so the SIGKILL path just cleans up and the worker replays.
- Kill the child's whole process group and clean the per-session temp dir on exit so a
  wedged engine cannot leak files or processes.
- The engine's own limits (16-connection cap, 30 s socket timeout, reply budgets) are
  the second line of defense (§15.1); this supervisor is the first.

## Layout

| Path | Role |
|---|---|
| `src/types.ts` | Seams: `EngineSession`, `EngineProcess`, `Spawner`, `SpawnRequest`, plan/limits, events. |
| `src/errors.ts` | `EnginePoolError` + the five stable codes + envelope conversion. |
| `src/constants.ts` | 15-min idle timeout, grace windows, token size, active-state set. |
| `src/registry.ts` | `SessionRegistry`: tenant-scoped bookkeeping, cap counting, eviction order. |
| `src/pool.ts` | `EnginePool`: allocate/attach/release, watchdog tick, drain, snapshot. |
| `tests/` | Vitest, `FakeSpawner` + `ManualClock`; no engine process is ever spawned. |
