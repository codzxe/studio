# infra/tests — §21 load & chaos drills

Scripted, **opt-in** drills for spec §21 (BUILD_PROMPT.md): load (preview
burst, run burst, upload throughput — find the box's knee, document scaling
triggers) and chaos (kill engine mid-run, kill worker mid-run, disk fill,
provider key revocation — each with a scripted drill and an expected outcome).

These are **not CI-blocking**. Nothing under `infra/tests/` is wired into the
Turbo build or the unit-test globes; an operator (or a scheduled, explicitly
opted-in CI job) runs them against a deployed stack. They fail loudly and
print an actionable report; exit codes are documented per script below.

- **Zero dependencies.** §21 suggests k6/autocannon; these drills are the
  zero-install equivalent (plain Node 22+, `node:` builtins only), so any
  operator can run them on a bare box and CI never gains new packages.
- **Targets.** Load drills talk to the **gateway** (`--base`, §13.1 REST + SSE).
  For the run spine the gateway should be backed by the zero-dep
  `apps/mock-engine` (protocol-faithful engine fake — see its README for the
  `MOCK_ENGINE_PORT` / `MOCK_ENGINE_TOKEN` / `MOCK_FAULT` contract), which
  makes 10-concurrent-run bursts cheap and deterministic. The chaos drills
  spawn the mock engine (and their own worker/queue simulation) themselves and
  need nothing else running.

## Layout

```
infra/tests/
├── README.md                this file
├── load/
│   ├── preview-burst.mjs    100 preview GETs/min sustained ×N, knee detection
│   ├── runs-burst.mjs       10 concurrent POST /v1/runs + SSE to terminal,
│   │                        per-tier durations vs §5.2 wall clocks
│   ├── upload-throughput.mjs multipart 5 MiB synthetic PNG uploads, concurrency 4
│   └── lib/common.mjs       shared zero-dep helpers (stats, SSE, multipart, PNG)
└── chaos/
    ├── kill-engine-midrun.mjs  engine hard-kill at run step 3 → §3.4 fail-clean
    │                           + refund + pre-run document state (spine check)
    ├── kill-worker.mjs         worker SIGKILL mid-job → retry visible, job
    │                           re-picked, no double-charge; ×3 backoff dead-letter
    ├── disk-fill.md            MANUAL drill — disk exhaustion (RB-05)
    ├── provider-revoke.md      MANUAL drill — provider key revoked mid-run (RB-04)
    └── lib/                    drill harness (ledger, mock-engine client, report)
```

## Auth

The gateway requires auth (§13): pass session cookie or API key headers with
repeatable `--header`, e.g. `--header "Authorization: Bearer $STUDIO_API_KEY"`
or `--header "Cookie: $SESSION_COOKIE"`. Drills never embed credentials.

## Load drills

### `load/preview-burst.mjs` — §21 "100 preview requests/min, find the knee"

```sh
node infra/tests/load/preview-burst.mjs \
  --url "$BASE/v1/documents/$DOC_ID/preview?w=1024" \
  --rate 100 --minutes 5 --concurrency 10 \
  --header "Authorization: Bearer $KEY"
```

- Fixed-rate open-loop pacer (100 req/min default) with a concurrency cap;
  requests that have to wait for a slot are counted as *backpressure*.
- Reports p50/p95/p99, error rate (budget 5% per §22), achieved RPS and bytes/s.
- **Knee** = first latency bucket where p50 ≥ 2× the baseline bucket's p50
  (latency doubling point), printed with the offered rate at that moment and a
  SCALING TRIGGER note (§3.1: scale the stateless gateway horizontally, then
  the engine pool).
- `--ramp` doubles the offered rate each `--phase-seconds` until `--max-rate`
  to actively hunt the knee instead of watching for drift at a fixed rate.
- Exit codes: `0` report produced · `1` usage error / zero samples (target
  down) · `2` with `--strict` when the knee was found or the error budget was
  breached (use this in an opt-in scheduled CI job).

### `load/runs-burst.mjs` — §21 "10 concurrent runs"

```sh
node infra/tests/load/runs-burst.mjs \
  --base "$BASE" --document "$DOC_ID" \
  --count 10 --concurrency 10 \
  --mix quick=4,standard=4,complex=1,premium=1 \
  --header "Authorization: Bearer $KEY"
```

- One `POST /v1/documents/:id/runs` (§13.1) per run, **Idempotency-Key unique
  per burst** (`w9l-<burst>-run-<i>`), so a retried burst never double-creates.
- Follows each run's SSE stream (§13.2) to a terminal event
  (`run.succeeded|failed|cancelled`), resuming with `Last-Event-ID` if the
  stream drops. `--cancel-on-hang` posts `/v1/runs/:id/cancel` if a run
  overshoots its §5.2 wall clock (+`--grace-ms`).
- Prints per-tier duration p50/p95/max **vs the §5.2 budget table**
  (quick 2 · standard 5 · complex 10 · premium 10 · max 15 · image 1 ·
  image_hd 2 min) with a breach column, plus create-error and hung-run lists.
- Exit codes: `0` · `1` no run created at all · `2` with `--strict` on any
  failure/hang/breach.

### `load/upload-throughput.mjs` — §21 "upload throughput"

```sh
node infra/tests/load/upload-throughput.mjs \
  --base "$BASE" --count 8 --concurrency 4 --header "Authorization: Bearer $KEY"
```

- Multipart POST of a **synthetic ~5 MiB PNG generated in code**
  (deterministic noise, §21 test-data rule: synthetic only) at concurrency 4,
  one warm-up upload excluded from stats.
- Per-upload latency + MB/s table, aggregate MiB/s, p50/p95/p99, and an error
  table grouped by failure class (http_413/http_422/conn_reset/timeout…).
- Exit codes: `0` · `1` no successful upload · `2` with `--strict` on any
  error or aggregate throughput below `--min-mbps` (default 10).

### Reading a load report

- **Knee found** → capacity ceiling of this box for that path; capture the
  rate at the knee, then scale (§3.1/§17: gateway replicas → engine-pool
  sessions) and re-run to confirm the knee moved.
- **Backpressure with flat latency** → concurrency cap saturated: raise
  `--concurrency` or scale out; latency itself is still healthy.
- **Error rate over 5%** → treat as the §22 run-failure alert band: stop,
  check queue age and engine restarts (§22 alerts) before scaling anything.

## Chaos drills

### `chaos/kill-engine-midrun.mjs` — engine hard-kill mid-run (§21, §3.4)

```sh
node infra/tests/chaos/kill-engine-midrun.mjs              # fault-based kill (default)
node infra/tests/chaos/kill-engine-midrun.mjs --kill sigkill   # literal SIGKILL
node infra/tests/chaos/kill-engine-midrun.mjs --resume clean     # clean-resume variant
```

Self-contained: spawns `apps/mock-engine`, drives a run through the control
protocol, and kills the engine child at **run step 3** (via
`MOCK_FAULT=crash-on-command`, the mock's documented `process.exit(86)` hook —
or a literal `SIGKILL` with `--kill sigkill`). Then it exercises the §3.4
recovery spine — restart, replay to checkpoint, **resume once** — and asserts
the expected outcome:

| §3.4 expected outcome | Asserted by |
|---|---|
| run cancelled/failed **clean** | child exit code 86 / SIGKILL reaped; resume attempt made exactly once; drill run-state marked `failed`; no orphan processes or sockets left |
| refund lands in the ledger | append-only JSONL ledger (stand-in for the credits ledger, §14 / `GET /v1/credits`): one reserve, one refund, same idempotency key; a duplicate refund apply is refused |
| document at pre-run state | command-log replay from the last checkpoint (§5.6) on a fresh engine: `doc.inspect` matches the pre-run snapshot and contains none of the run's layers |

`--resume clean` instead proves the *successful* §3.4 path (replay + one
resume completes; reservation commits as a charge, no refund). Exit `0` all
assertions pass, `1` any failure (printed PASS/FAIL transcript).

### `chaos/kill-worker.mjs` — worker hard-kill mid-job (§21, §3.4)

```sh
node infra/tests/chaos/kill-worker.mjs
```

Self-contained queue drill (no Valkey needed): a JSONL event-log queue
(BullMQ-shaped semantics) and real child "worker" processes driven over IPC.
The drill SIGKILLs a worker mid-job and asserts:

- the queue shows a **retry scheduled** with backoff (§3.4 "retried with
  backoff ×3") for the interrupted job,
- a replacement worker **re-picks** it and carries it to a terminal state,
- the ledger is charged **exactly once** per idempotency key (no
  double-charge despite two processing attempts),
- a poisoned job dead-letters after exactly 3 attempts and is **refunded**.

Exit `0`/`1` as above. On a live compose stack the equivalent drill is
documented in the script header (`docker compose kill -s SIGKILL worker` +
watch queue age / retries via §22 metrics); the simulation keeps the drill
runnable on a bare box.

### Manual drills (documented, deliberately not automated)

- `chaos/disk-fill.md` — exhaust the engine/object-store volume; expected:
  clean `engine_unavailable`-style failures, refunds for failed runs, the §22
  disk >80% alert firing, no checkpoint corruption. Cross-linked runbook:
  `docs/runbooks/RB-05-disk-usage.md`.
- `chaos/provider-revoke.md` — revoke an LLM provider key mid-flight;
  expected: circuit breaker opens, §5.3 failover to a second same-class
  provider, clean failure + refund when no failover, §22 provider-error alert.
  Cross-linked runbooks: `docs/runbooks/RB-04-provider-outage.md`,
  `RB-01`, `RB-08`.

Both manual drills are **staging-only** and self-contained in their write-ups
(preconditions, exact commands, expected observable outcomes, teardown,
evidence to capture).

## CI wiring (opt-in only)

These drills must not gate merges. If the owner wants them scheduled
nightly against staging, add a separate GitHub Actions workflow that runs
the three load scripts with `--strict` and the two self-contained chaos
scripts, and fails that (non-required) job only. `--json` prints one
machine-readable `SUMMARY_JSON` line per drill for reporting tooling.

## Safety

- All self-contained drills spawn/kill processes only inside a temp dir they
  create, and clean up on exit (children reaped, sockets closed, tmp removed;
  `--keep-tmp` to inspect evidence).
- Load drills only issue reads/creates against the target they're pointed
  at; run them against staging or a dedicated drill workspace, not customer
  data. `--cancel-on-hang` is the only mutating request beyond the documented
  §13 endpoints.
