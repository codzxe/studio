# ci-staged — parked GitHub Actions workflows (NOT active CI)

**These files do nothing while they live here.** GitHub only runs workflows from
`.github/workflows/*` at the repo root; `infra/ci-staged/` is a holding area.

## Why they are parked

The classic Personal Access Token embedded in the fleet's `origin` remote lacks
the **`workflow`** scope, so GitHub rejects any push whose diff adds or changes
files under `.github/workflows/*`:

> "refusing to allow a Personal Access Token to create or update workflow
> without `workflow` scope"

Mid-Wave-1 (W1-M) that rejection broke `scripts/git-sync.sh` for every agent —
the workflow files were pulled out of the repo and parked in
`/home/z/my-project/ci-staging/` (W1-ORCH). W2-Q staged that park into the repo
so it is versioned with everything else.

## What is here

| File | Purpose |
| --- | --- |
| `ci.yml` | PR/main gate: pnpm + Node 22, `turbo lint typecheck test build --concurrency=1`, postgres:16 + valkey:8 services (§17.3, §21) |
| `license-check.yml` | Weekly + manifest-path runs of `scripts/check-licenses.mjs` (§16 gate) |
| `engine-patches.yml` | Overlay engine-patches/ onto the pinned vendor clone, `cargo check` + panic_hunt (§2.3, §16.1) |

## How to enable (HUMAN ACTION REQUIRED)

1. Add the **`workflow`** scope to the classic PAT used by `origin`
   (GitHub → Settings → Developer settings → Tokens), **or** replace it with a
   fine-grained PAT that has **Actions: write** on this repository.
2. From the repo root:

   ```sh
   cp infra/ci-staged/*.yml .github/workflows/
   ./scripts/git-sync.sh "enable CI workflows"
   ```

3. Verify: the Actions tab shows the three workflows, and the next push runs
   `CI` on `main`.

Do not copy the files back into `.github/workflows/` before the token has the
scope — every fleet `git-sync` will fail again (same failure W1-M hit).
