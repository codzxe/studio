# Release Checklist — v0.1.0-beta.0

THE gate for tagging `v0.1.0-beta.0`. Every item must be green **on the exact commit
being tagged**. Any SKIP, red job, or gate below threshold = NO-GO. Companion docs:
`CHANGELOG.md` (what's in the cut), `docs/phases/acceptance-matrix.md` (live-command
evidence per §20 criterion), `infra/environments.md` (env matrix + secrets),
`docs/phases/phase-exit-audit.md`.

## 0. Preconditions

- [ ] Node 22+ with corepack-enabled pnpm; Docker + compose; Rust stable toolchain
      (for the engine-patches job); `exiftool` + `curl` for live smoke checks.
- [ ] `.env` provisioned per `infra/environments.md`, mode `0600`, box-only — secrets
      never in the repo; CI/GitHub holds only SSH + GHCR credentials.
- [ ] Engine pin verified: vendor clone at `872748fb` (ADR-0001);
      `engine-patches/scripts/apply-engine-patches.sh --check` exits clean.
- [ ] `pnpm install` (lockfile is generated on first install — known limitation;
      do not commit a lockfile as part of this gate).

## 1. CI must pass (enable workflows first)

**HUMAN ACTION**: the PAT needs `workflow` scope, then copy
`infra/ci-staged/{ci.yml,license-check.yml,engine-patches.yml}` → `.github/workflows/`.

- [ ] **ci.yml (turbo pipeline)**: `lint`, `typecheck`, `test`, `build` — all green
      (`--concurrency=1`, pg16 + valkey8 services, concurrency-cancel, 30 min budget).
      Local equivalent: `pnpm turbo lint typecheck test build --concurrency=1`.
      Note: typecheck includes the known TS1205 debt in `packages/tools` — it must be
      swept or waived explicitly before this box ticks.
- [ ] **license check (strict)**: `node scripts/check-licenses.mjs --strict` —
      0 denied licenses (§16.5 denylist: no AGPL/SSPL/BUSL/RSALv2/Elastic), 0
      TODO-verify rows, 0 unused manifest rows. Weekly `license-check.yml` covers the
      same gate on main.
- [ ] **Font & secret scan**: 0 font files, 0 `.env`/tokens committed.
- [ ] **engine-patches.yml**: clone pinned `872748fb` → apply patches →
      `cargo check -p photocraft-engine` → `cargo test panic_hunt --ignored` —
      both green (job skips cleanly only when `engine-patches/**` is empty).

## 2. Evals gates (§19 Phase 2)

- [ ] **Full deterministic suite ≥ 0.85**: `pnpm --filter @studio/evals eval:ci`
      (67 cases: templates, components, intent matrix, freeform, injection, budget,
      clarify, quick-edits).
- [ ] **Chat-edits curated gate ≥ 0.90** (≥18/20): dual-gate runner
      `packages/evals/scripts/eval-gate.mjs --suite <json> --suite-threshold 0.85
      --chat <json> --chat-threshold 0.90` → **exit 0 required** (1 = below threshold,
      2 = usage/input error).
- [ ] **Live-model gates**: once staging has real providers (§1.5, no free tiers),
      promptfoo full suite + chat-edits run against the live model; deterministic
      mocks remain the CI gate, live thresholds are recorded in the acceptance matrix.

## 3. Staging checklist

Run in order; each step must pass before the next.

- [ ] **compose up**: `docker compose -f infra/compose/docker-compose.yml up -d`
      (add `--profile obs` to bring up Prometheus/Grafana/alerting; gateway entrypoint
      runs migrations via `MIGRATE=1` → `migrate.sh`).
- [ ] **smoke**: `bash infra/scripts/smoke.sh` — base URL via `SMOKE_BASE_URL`, engine
      leg via the `ENGINE_SMOKE_CMD` contract (session.list + doc round-trip on a
      scratch serve), worker health via `WORKER_HEALTH_URL`/`WORKER_HEALTH_PORT`.
      A loud engine-skip is a **FAIL**, not a pass.
- [ ] **demo:coffee**: `pnpm --filter @studio/worker demo:coffee` (root alias still
      owed) — full §24.1 trace end-to-end; all 4 artifacts produced; determinism
      assert holds.
- [ ] **backup-v2**: `bash infra/scripts/backup-v2.sh` then
      `bash infra/scripts/verify-backup.sh` — backup verified, not just taken.
- [ ] **restore drill**: `bash infra/scripts/drill-restore.sh` — first drill happens
      at this gate; quarterly cadence thereafter (§17.4).

## 4. First deploy checklist (merges W9-J: environments doc + deploy-v2/rollback/migrate/smoke)

- [ ] **Environment target**: staging first — same-box, `COMPOSE_PROJECT_NAME=staging`,
      reverse-proxy site with **internal TLS**; prod only after staging soaks
      (Lightsail 4 GB + R2 + paid providers per §1.5; see `infra/environments.md`
      three-env table).
- [ ] **Env knobs set**: `ENGINE_PIN`, `IMAGE_TAG` (+ per-service `*_IMAGE` vars),
      `WORKER_HEALTH_HOST/PORT`, `WORKER_HEALTH_URL`, `ENGINE_SMOKE_CMD`,
      `SMOKE_BASE_URL` — all documented in `infra/environments.md`.
- [ ] **Tag scheme**: `app:<git-sha>` images; `deploy-v2.sh` writes a deploy-state
      file recording the previous tag (rollback depends on it).
- [ ] **Migrate**: gateway container entrypoint honors `MIGRATE=1` → one-shot
      `migrate.sh` (drizzle-kit, forward-only — never manual prod edits).
- [ ] **Deploy**: `bash infra/scripts/deploy-v2.sh` — preflight tooling gate, build +
      push images, compose pull/up with `IMAGE_TAG` interpolation; engine supplied via
      host bind-mount (`/engine:/engine:ro`, host-compiled pinned binary).
- [ ] **Verify**: `smoke.sh` green against staging; dashboards RB-01..08 alerts quiet;
      uptime-kuma checks up; `/metrics` internal-only (Basic auth, edge 404).
- [ ] **Rollback rehearsed**: `bash infra/scripts/rollback.sh` repins the previous
      docker tag from deploy-state (works regardless of compose interpolation) —
      rehearse once on staging before declaring the deploy done.

## 5. Go / No-Go

| Gate | Requirement | Status |
| --- | --- | --- |
| CI (turbo lint/typecheck/test/build) | all green on tag commit | ☐ |
| License check strict + font/secret scan | 0 denied / 0 TODO / 0 fonts / 0 secrets | ☐ |
| Engine patches | cargo check + `panic_hunt --ignored` green | ☐ |
| Evals | suite ≥ 0.85 AND chat ≥ 0.90 (exit 0) | ☐ |
| Staging | compose → smoke → demo:coffee → backup-v2 → drill all pass | ☐ |
| First deploy | migrate + deploy-v2 + verify + rollback rehearsal done | ☐ |

Automatic NO-GO: any CI job red or skipped-by-excuse, any eval gate below threshold,
license check not strict-clean, smoke engine-skip, backup unverified, or a rollback
path that has never been rehearsed. On GO: tag `v0.1.0-beta.0`, publish
`CHANGELOG.md`, record evidence links in `docs/phases/acceptance-matrix.md`.
