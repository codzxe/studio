# ADR 0002 — Environment matrix and root configuration

Date: 2026-10-20 · Status: accepted

## Context

W1 spins up four apps (`gateway`, `worker`, `engine-pool`, `web`) in parallel, every one of
them needing Postgres, Valkey, storage, Stripe and model-provider credentials. Spec §4 fixes
the day-one conventions (Node 22, TypeScript strict, ESM, pnpm, Turborepo, Zod at every
boundary, "missing var = process refuses to start"), §17.5 fixes the environments, and
§1.5 constraint 6 fixes paid-only model access. Without a canonical variable list, parallel
agents invent divergent names (`DATABASE_URL` vs `POSTGRES_URL`, `REDIS_URL` vs `VALKEY_URL`)
that only collide at integration time — and §15.2 requires separate secrets per environment.

## Decision

1. **pnpm workspaces + Turborepo.** (§4) pnpm 9 pinned via `packageManager` + corepack;
   Node ≥ 22 (`.nvmrc`, `engines`). Turborepo owns the task graph (`build`, `typecheck`,
   `lint`, `test` with `^build` dependencies and cached outputs `dist/**`, `.next/**`),
   and CI (§17.3) runs the same tasks, so the local/CI gap stays zero. Discarded: npm/yarn
   workspaces (weaker install controls, no task cache) and Nx (more machinery than this
   repo needs).

2. **Biome, not ESLint + Prettier.** One Rust binary, one config (`biome.json`), one
   entrypoint (`pnpm format` → `biome check --write .`), sub-second runs on this 2-CPU box —
   which is what makes the CI lint step cheap enough for every PR (§17.3). Enforced rules
   today: `noExplicitAny=error`, `noNonNullAssertion=error`, `noConsole=warn`, matching the
   code-style law in `docs/AGENTS.md`. Discarded: ESLint + Prettier (two config systems,
   plugin compat matrix, ~10× slower cold runs).

3. **NodeNext ESM with `.js` import extensions.** `"type": "module"` in every package;
   `module: NodeNext` / `moduleResolution: NodeNext`, `strict`, `verbatimModuleSyntax` in
   `tsconfig.base.json`. All relative imports MUST carry the `.js` extension (NodeNext
   resolves `./foo.js` to `./foo.ts`) so the compiled output runs under plain Node with no
   bundler — gateway/worker/engine-pool are services, not bundler targets.

4. **The environment matrix lives in `.env.example`.** It is the single source of truth for
   every variable, grouped by app (gateway, worker, engine-pool, web) and infra (Postgres,
   Valkey, S3/R2, Stripe, model providers, fonts, observability, email), one comment per
   variable. `packages/config` parses and types it exactly once with Zod; a REQUIRED secret
   that is missing or still `changeme` aborts startup (§4 fail-fast — secrets are never
   silently defaulted, §15.2). `.gitignore` keeps `.env`, `.env.*` out while preserving
   `!.env.example`. Adding a variable means touching `.env.example` AND the
   `packages/config` schema in the same change.

5. **Model providers are paid-only.** (§1.5 constraint 6, §5.3) Vertex (Gemini default),
   Anthropic (Sonnet/Opus), OpenAI (GPT Image finals), DeepSeek (economy), a Flux host
   (image drafts). No free or training tiers for customer data, no OpenRouter in
   production, `store:false` where offered (§15.3), per-provider circuit breakers with
   same-class failover (§17.4).

6. **Environments: `local`, `staging`, `production`** (§17.5), selected by `APP_ENV`.
   Local = `infra/compose`; staging = same box, separate Compose project + subdomain +
   separate DB, Stripe test keys; production = the Lightsail box (§17.1). Migrations are
   never tested on production first.

## Consequences

- Parallel agents copy variable names from `.env.example` verbatim; a rename is an
  ADR-level event because it breaks deployed env files.
- `pnpm dev` is wired through `turbo.json` as a `persistent`, uncached task; apps own
  their dev servers and CI never runs it.
- Engine session caps (idle/lifetime/CPU/RAM) are environment variables, not code
  constants, so staging can tighten them without a deploy.
- Biome upgrades are single-line version bumps; there is no plugin ecosystem to track.
