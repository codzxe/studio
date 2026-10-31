# Self-hosted CI — run CI on your own machine, not GitHub's

- **Policy (2026-10-31):** every job in `.github/workflows/ci.yml` runs on
  `self-hosted` runners only. No GitHub-hosted (billed) machines — zero
  Actions minutes are consumed on any push/PR.
- **Owner:** repo maintainers · **Applies to:** all CI jobs (`web`, `gateway`,
  `worker`, `packages`, `gateway-bundle-drift`, `licence-gate`, `editor-cargo`,
  opt-in `e2e`).

## Why

The repo is private; GitHub-hosted runners bill Actions minutes
(the audit trail in `ci.yml` records the free 2000/mo allowance burning in
four days). A self-hosted runner is free, reuses warm pnpm/cargo caches, and
is typically 2–5× faster than a cold hosted box.

## Option A — register your machine as a runner (CI runs on push/PR)

1. On the runner machine (Linux/macOS/WSL both fine):

   ```bash
   # one-time prerequisites
   node -v              # need >= 22
   corepack enable      # pnpm 9.15.9 comes from package.json's pin
   docker --version     # ONLY needed for the gateway/e2e postgres service jobs
   cargo --version      # ONLY needed for the editor-cargo job (rustup)

   # register the runner (repo → Settings → Actions → Runners → New self-hosted runner;
   # GitHub prints the exact commands — they look like this):
   mkdir actions-runner && cd actions-runner
   curl -o actions-runner-linux-x64-<ver>.tar.gz -L https://github.com/actions/runner/releases/download/v<ver>/actions-runner-linux-x64-<ver>.tar.gz
   tar xzf actions-runner-linux-x64-<ver>.tar.gz
   ./config.sh --url https://github.com/codzxe/studio --token <REGISTRATION_TOKEN>
   ./run.sh                      # foreground; install as a service with ./svc.sh install && ./svc.sh start
   ```

2. Push to `main` (code paths only — docs-only pushes still skip CI via
   `paths-ignore`). The `runner-preflight` job prints the machine's tool
   versions first; it never blocks the run.

3. The `gateway` and `e2e` jobs use `services: postgres:` containers — the
   runner user must be able to talk to the Docker socket (`usermod -aG docker <runner-user>`
   then re-login). Without Docker those two jobs fail at startup; everything
   else still runs.

Notes:

- The runner checks out the repo and runs the same commands as
  `scripts/ci-local.sh` — nothing mutates your working copy.
- `Swatinem/rust-cache` and `actions/setup-node`'s pnpm cache store under the
  runner's `_work` dir; they warm up after the first run.
- Runners are per-repo and must be online when you push. The old weekly e2e
  `schedule:` was removed for exactly this reason — e2e is now
  `workflow_dispatch` (Actions tab → CI → Run workflow) or `ci-local.sh --e2e`.

## Option B — no runner at all: run the gates directly

```bash
bash scripts/ci-local.sh             # web, gateway, worker, packages, bundle-drift, licences, editor-cargo
bash scripts/ci-local.sh --e2e       # …plus the full-stack Playwright suite
bash scripts/ci-local.sh --only web,gateway
bash scripts/ci-local.sh --list      # gate names
```

- No GitHub involved — identical commands and env to the workflow jobs.
- The `gateway` gate prefers Postgres in this order: an exported
  `DATABASE_URL` → the repo's `scripts/dev-postgres.sh` → a throwaway
  `postgres:16` docker container → the sqlite twin (the 89 pg-only suites
  self-skip with a notice, the documented CI behavior).
- `editor-cargo` SKIPs with a notice when no rust toolchain is present.
- Exit code 0 iff every non-skipped gate passed.

## Security notes for self-hosted runners

- Self-hosted runners on private repos are fine; never register one on a
  public repo (PRs from forks could run arbitrary workflow code on your box).
- The runner runs the workflow steps in this repo — same trust level as any
  maintainer running the test suite locally.
- If the machine is shared, use a dedicated user account for the runner
  service.
