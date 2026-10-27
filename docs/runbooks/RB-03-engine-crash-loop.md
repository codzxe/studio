# RB-03 — Engine crash loop

> **HISTORICAL (pre-pivot, 2026-10):** this document describes a PREVIOUS
> architecture and is retained for reference only. It is written against the
> PhotoCraft engine pool (`photocraft-cli serve`, `.pcraft` files) — no engine
> pool exists. The current pipeline spawns the vendored `effectcraft-cli` per
> render job (`services/worker/src/pipeline.ts`) with heartbeat-stale reclaim
> (RENDER_HEARTBEAT_STALE_SECONDS) and requeue sweeps. Do not execute as-is;
> see `docs/phases/m8-cli-spike.md` for the shipped CLI contract and
> `docs/DECISIONS.md` for rulings.

- **Alert (§22):** engine restarts > 3 per hour (metric: engine pool restarts /
  sessions active/idle).
- **Owner:** on-call engineer · **Severity:** high · **Spec:** §22 alerts, §3.2 sessions, §17.4 engine pool crash, §3.4 crash recovery

## Symptom

The engine-pool watchdog reports > 3 engine (`photocraft-cli serve`) process restarts in
an hour, or the §22 engine pool utilisation graph shows a sawtooth of spawn→crash.
Users see "recovered" events — or a failed run with refund if recovery could not resume.

## Impact

Crashed sessions do not consume plan caps (W1-J), but each mid-run crash costs the
worker a checkpoint replay (§3.2: the command log is the WAL) and risks the run failing
with refund (§3.4: resume once, then fail cleanly). A crash *loop* means no tenant on
the box can finish long runs; CPU spent on replays compounds the load.

## Diagnosis

1. Grab the crash log for the failing session id from the pool supervisor (registry
   keeps crashed sessions until released, W1-J). Correlate with the pino chain
   `workspace_id → run_id → step_seq` (§22) — which command or document was active?
2. Panic vs OOM vs watchdog kill: Rust panic (bug — collect `panic_hunt` repro, §21),
   memory/CPU breach (watchdog kill by design, §3.2) or box-level memory pressure
   (see RB-05).
3. One document or many? A single `.pcraft` reproducing a crash is a corrupt/edge-case
   document → quarantine it; many tenants = systemic (engine binary, fonts mount,
   deploy).
4. Did the pinned engine commit change recently? ADR-0001 requires deliberate re-pins
   — a bump that skipped upstream gates is suspect #1.
5. Check §22 tool error rate and validator blocker rate for the same window: a crash
   storm often follows a pathological tool sequence.

## Fix

- **Watchdog is doing its job (≤ 3/h):** crashed runs resume once from checkpoint
  (§3.2/§3.4); verify the user saw the "recovered" event — no action beyond a log scan.
- **OOM pattern:** tighten per-process CPU/RAM limits (§17.2 engine-pool resource
  limits; env-tunable per ADR-0002) so the watchdog kills earlier and Postgres is never
  starved (§17.4 order: engine pool dies first).
- **Single-document poison:** move the document to quarantine (assets quarantine
  pattern, §15.2), fail its runs with refund (§14.2 r5: our bug → full refund), and
  file an upstream repro against the pinned commit (ADR-0001 — engine fixes go
  upstream, never in-place vendor edits).
- **Systemic loop:** pin the worker's run queues to drain (§17.4: runs queue, never
  fail the user's prompt forever), restart the engine-pool service, and if a recent
  engine re-pin is implicated, roll the pin back per ADR-0001.

## Verification

- Restart rate < 3/h for two consecutive hours (§22 metric).
- A canary run end-to-end completes without a restart; a resumed run emits
  "recovered" and finishes within its §5.2 wall clock.
- Affected runs: exactly one resume attempt each (§3.4), refunds/releases idempotent
  (§14.2 r6).

## Postmortem

Within 48 h: crash signature, session/tenant list, upstream issue link (engine fixes
upstream per §16.1/ADR-0001), watchdog behaviour review (did the pool die before
Postgres starved, §17.4). Add the repro to `panic_hunt` coverage (§21) and update
`docs/devlog.md`.
