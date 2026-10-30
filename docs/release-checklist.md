# Release Checklist — v0.1.0-beta.0

THE gate for tagging `v0.1.0-beta.0`. Every item must be green **on the exact commit
being tagged**. Any SKIP, red job, or gate below threshold = NO-GO. Companion docs:
`CHANGELOG.md` (what's in the cut), `docs/phases/acceptance-matrix.md` *(historical —
pre-pivot PhotoCraft era)* (live-command evidence per §20 criterion),
`infra/environments.md` (env matrix + secrets — *deleted with the pivot; the
canonical env matrix is now `.env.example` via `scripts/gen-env.ts`, secrets per
`docs/secrets-policy.md`*), `docs/phases/phase-exit-audit.md` *(historical —
pre-pivot PhotoCraft era)*.

## 2026-10-24 walk (W2-E, doc-consistency sweep)

This checklist predates the EffectCraft pivot; several items still name the
deleted pre-pivot surface (vendor pin `872748fb`, `engine-patches`,
`packages/evals`, `packages/tools`, `infra/scripts/`, `infra/ci-staged/`,
`infra/environments.md`, `demo:coffee`) — each is annotated inline below.
On-box state as of 2026-10-24 (wave-1 landing commit `9f3dcc2`; evidence:
worklog W1-B / W1-D / W1-E / W1-C / W1-int-remediation):

- **Editor dist built + committed + boot-proven** — re-tuned 2026-10-24 to a
  49,353,339-byte wasm (49.4 MB; profile-true cg1 + `wasm-opt` 125, brotli q8
  12.8 MiB), committed at `apps/web/public/editor/` (3a766a3), de-brand
  verified (W1-C).
- **Visual baselines minted** — the m5-readonly editor-unchanged baseline was
  re-minted on the new dist 2026-10-24 (pixelmatch(0.2) = 0% — the residual
  byte-diff is a sub-threshold cg1-vs-cg16 raster shift, UI structure
  identical; W1-E forensic).
- **Local gate equivalents green** — biome 707 files / 0 errors; typecheck
  10/10; all unit suites green (web 1533, gateway 807+9 skips, worker 57+7,
  contracts 213, api-client 166, db 140+71 skips, editor-bridge 71, ui 127,
  config 151, storage 167); `next build` exit 0; `pnpm check:licenses` PASS
  (40 declared, 0 font binaries, 0 `.env`) after the `@axe-core/playwright`
  MPL-2.0 manifest row.
- **Still open, deliberately:** the CI runs on the tag commit (only
  `.github/workflows/ci.yml` exists so far — W2-B7; no weekly licence
  workflow, and the e2e CI job is `continue-on-error` pending its first
  runner-green), every staging item (**no Docker on the build box**), and
  every deploy/live-box item below. No checkbox is ticked by this walk — the
  file's own law ("green on the exact commit being tagged") still governs.

## 0. Preconditions

- [ ] Node 22+ with corepack-enabled pnpm; Docker + compose; Rust stable toolchain
      (for the engine-patches job); `exiftool` + `curl` for live smoke checks.
      *2026-10-24 build-box probe:* node 24 + pnpm 9.15.9 + curl + ffmpeg ✓; Rust
      stable 1.99.1 + `wasm32-unknown-unknown` + `wasm-bindgen-cli` 0.2.129 +
      `wasm-opt` 125 ✓ (W1-C); **no Docker** here — the compose/staging items
      belong to the release box; `exiftool` absent on this box.
- [ ] `.env` provisioned per `infra/environments.md`, mode `0600`, box-only — secrets
      never in the repo; CI/GitHub holds only SSH + GHCR credentials.
- [ ] Engine pin verified: vendor clone at `872748fb` (ADR-0001);
      `engine-patches/scripts/apply-engine-patches.sh --check` exits clean.
      *Superseded by the pivot (ADR-0006):* the engine is the vendored
      EffectCraft editor at `apps/editor/` (pin `9db7f3b2`, v0.13.0); its wasm dist
      is built + committed at `apps/web/public/editor/` (re-tuned + de-brand
      verified 2026-10-24 — W1-C). No external vendor clone or patch job
      exists; the in-tree patch is `apps/editor/patches/0001` (de-brand).
- [ ] `pnpm install` (lockfile is generated on first install — known limitation;
      do not commit a lockfile as part of this gate).
      *Stale — flipped 2026-10-24:* `pnpm-lock.yaml` IS committed and canonical
      (synced in 3a766a3 with the `@axe-core/playwright` devDep); CI installs
      run `corepack pnpm install --frozen-lockfile` (`.github/workflows/ci.yml`).

## 1. CI must pass (enable workflows first)

**HUMAN ACTION**: the PAT needs `workflow` scope, then copy
`infra/ci-staged/{ci.yml,license-check.yml,engine-patches.yml}` → `.github/workflows/`.

*2026-10-24:* `infra/ci-staged/` was deleted with the pivot; a real
`.github/workflows/ci.yml` already exists (W2-B7, wave-2 commit f371287 — 7
jobs: web / gateway with a postgres:16 service / worker / packages
typecheck / licence gate / editor `cargo check` / e2e `continue-on-error`).
`license-check.yml` and `engine-patches.yml` do not exist yet.

- [ ] **ci.yml (turbo pipeline)**: `lint`, `typecheck`, `test`, `build` — all green
      (`--concurrency=1`, pg16 + valkey8 services, concurrency-cancel, 30 min budget).
      Local equivalent: `pnpm turbo lint typecheck test build --concurrency=1`.
      Note: typecheck includes the known TS1205 debt in `packages/tools` — it must be
      swept or waived explicitly before this box ticks.
      *2026-10-24:* the LOCAL equivalent is green on-box (biome 707 files / 0
      errors, typecheck 10/10, all unit suites, `next build` exit 0 —
      W1-B/W1-D/W1-int-remediation); the CI run on the tag commit is still
      owed. The `packages/tools` TS1205 note is pre-pivot — that package is
      deleted.
- [ ] **license check (strict)**: `node scripts/check-licenses.mjs --strict` —
      0 denied licenses (§16.5 denylist: no AGPL/SSPL/BUSL/RSALv2/Elastic), 0
      TODO-verify rows, 0 unused manifest rows. Weekly `license-check.yml` covers the
      same gate on main.
      *2026-10-24:* `pnpm check:licenses` PASS on-box (40 declared, 0 font
      binaries, 0 `.env`; the `@axe-core/playwright` MPL-2.0 row added by
      W1-int-remediation). The `--strict` re-run on the tag commit + the
      weekly workflow remain owed (the ci.yml licence job runs the non-strict
      form).
- [ ] **Font & secret scan**: 0 font files, 0 `.env`/tokens committed.
      *2026-10-24:* clean on the current tree per the same gate run (0 font
      binaries, 0 `.env` — W1-int-remediation); re-verify on the tag commit.
- [ ] **engine-patches.yml**: clone pinned `872748fb` → apply patches →
      `cargo check -p photocraft-engine` → `cargo test panic_hunt --ignored` —
      both green (job skips cleanly only when `engine-patches/**` is empty).
      *Pre-pivot, superseded:* no engine-patches job exists; the vendored
      editor carries `apps/editor/patches/0001` (de-brand) applied in-tree. The
      beefier-box Rust gates (`cargo test --workspace`, clippy, `cargo xtask
      wasm`) remain owed per `apps/editor/UPSTREAM.md`.

## 2. Evals gates (§19 Phase 2)

*2026-10-24:* pre-pivot references — `packages/evals` (67 cases +
`eval-gate.mjs`) is deleted. The current surface is the root `evals/` corpus
(40 golden prompts + hermetic scoring harness, wave-3 commit 90d74d2;
live-model scoring NOT wired — `evals/README.md`). No post-pivot threshold
gate exists yet: this section stays OPEN until one is defined and run.

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
      *2026-10-24:* the compose file exists (`infra/compose/`); **no Docker on
      the build box** — live-box-owned, stays open.
- [ ] **smoke**: `bash infra/scripts/smoke.sh` — base URL via `SMOKE_BASE_URL`, engine
      leg via the `ENGINE_SMOKE_CMD` contract (session.list + doc round-trip on a
      scratch serve), worker health via `WORKER_HEALTH_URL`/`WORKER_HEALTH_PORT`.
      A loud engine-skip is a **FAIL**, not a pass.
      *Pre-pivot path:* `infra/scripts/` is deleted — no post-pivot smoke
      script exists yet (raw pieces in-tree: gateway `/health`,
      `scripts/e2e-probe-editor.mjs`, the Playwright e2e suites). Stays open.
- [ ] **demo:coffee**: `pnpm --filter @studio/worker demo:coffee` (root alias still
      owed) — full §24.1 trace end-to-end; all 4 artifacts produced; determinism
      assert holds.
      *Pre-pivot:* `demo:coffee` died with PhotoCraft (worker scripts are
      build/dev/lint/start/test/typecheck only). The post-pivot end-to-end
      render proof is the M8 pipeline suite (1080p MP4 golden run,
      `services/worker/tests/integration/render-pipeline.test.ts`); a
      release-box demo-artifact run remains owed.
- [ ] **backup-v2**: `bash infra/scripts/backup-v2.sh` then
      `bash infra/scripts/verify-backup.sh` — backup verified, not just taken.
      *Pre-pivot paths deleted* (`infra/scripts/`); the backup/restore
      procedure now lives in `infra/README.md` — stays open, live-box-owned.
- [ ] **restore drill**: `bash infra/scripts/drill-restore.sh` — first drill happens
      at this gate; quarterly cadence thereafter (§17.4).
      *Pre-pivot path deleted*; the quarterly drill cadence (§17.4) still
      applies once the live box exists — stays open.

## 4. First deploy checklist (merges W9-J: environments doc + deploy-v2/rollback/migrate/smoke)

*2026-10-24:* `deploy-v2.sh` / `rollback.sh` / the `MIGRATE=1` entrypoint
tooling were deleted with the pivot's `infra/scripts/`; the current deploy
surface is `infra/compose/` + `infra/caddy/` (the only host-port publisher)
+ `infra/systemd/` (`docs/repo-map.md`). Every item in this section stays
OPEN — live-box-owned; nothing here is claimed on the build box.

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
`CHANGELOG.md`, record evidence links in `docs/phases/acceptance-matrix.md`
*(historical — pre-pivot PhotoCraft era)*.

*2026-10-24 (W2-E walk):* no gate is ticked — CI-on-tag-commit, staging and
deploy remain open (CI-owned / live-box-owned). The state those runs will
inherit: editor dist built + committed + boot-proven, visual baselines
minted, local gate equivalents green, licence gate PASS (detail in the walk
section at the top of this file).
