# studio — Agent Onboarding (READ THIS FIRST)

You are one agent in a large **parallel** build of the studio SaaS. This file is the law.
The full product spec lives at `docs/BUILD_PROMPT.md` — it is authoritative and beats your
instincts wherever they disagree. Read the sections your task cites.

## Quick facts

- Monorepo: pnpm workspaces + Turborepo, TypeScript strict, ESM, Node 22+.
- Engine: shallow clone of the open-source Rust editor at
  `/home/z/my-project/vendor/photocraft` (pin `872748fb…`). Read it freely; NEVER edit it
  in place. Engine additions are authored as upstreamable new modules under
  `engine-patches/` in THIS repo (§16.1 policy).
- Protocol truth: `vendor/photocraft/docs/control-protocol.md`, and
  `vendor/photocraft/crates/automation/src/rpc.rs` (control methods), `crates/engine/src/commands.rs`
  (command registry). Verify command ids against these files — never invent them.
- Reference apps: `/home/z/my-project/vendor/next-saas-stripe-starter` (Better Auth +
  Drizzle + Stripe patterns), `/home/z/my-project/vendor/magicui`, `/home/z/my-project/vendor/astrowind`.
- This box has 2 CPUs and many agents run in parallel: DO NOT run `pnpm install`,
  `cargo build`, or dev servers. Write code + tests; GitHub Actions CI verifies.
- Product code must NEVER use the names PhotoCraft / ArtCraft / Photoshop / Cursor
  (spec §1.5). The codename `studio` is internal-only, never user-facing.

## Git workflow (MANDATORY — every agent, every wave)

After finishing (and after any large intermediate milestone), run:

    scripts/git-sync.sh "W<Wave>-<ID>: <what you did>"

- It stages, commits, pulls `--rebase` (GitHub wins), and pushes. It is serialized with a
  global lock for the whole agent fleet.
- NEVER hand-roll git commit/push, never force-push, never rewrite history.
- Do an intermediate sync early if your task creates many files (cheap, keeps waves small).

## Worklog (MANDATORY)

- Before starting: `tail -n 120 /home/z/my-project/worklog.md`
- After finishing, append (never overwrite):

```bash
cat >> /home/z/my-project/worklog.md << 'EOF'
---
Task ID: <your id, e.g. W1-C>
Agent: <your subagent name>
Task: <one line>
Work Log:
- <step>
- <step>
Stage Summary:
- <files created / key decisions / blockers>
EOF
```

## Ownership

- You own ONLY the paths listed in your task. Never create or modify files outside them.
- Shared/registry files (root configs, package indexes) may be touched ONLY if your task
  explicitly lists them.
- Need a change in a file you don't own? Write it into your report + worklog; do not do it.

## Code style (CI-enforced)

- TypeScript strict mode, ESM (`"type": "module"`), no `any` in exported APIs.
- Errors: typed result envelopes `{ ok:false, code, message, hint, retryable? }`.
  Never throw strings; never leak stack traces, absolute paths, or internal ids.
- Zod at every boundary: HTTP input, tool args, engine params, env vars, manifests.
- Env: parse via `packages/config`; a missing secret must refuse to start (fail fast).
- Money/credit paths: idempotency keys everywhere; ledger entries are append-only.
- Cite spec sections in comments where the reason matters (e.g. `// §5.2 tier budgets`).
- Tests: Vitest, deterministic, <5 s units, table-driven for pure logic, no network.
- Migrations: forward-only Drizzle SQL, no manual prod edits.

## Forbidden

- No secrets or tokens in code/docs. No font files committed, ever (`CRAFT_FONTS_DIR`).
- No AGPL/SSPL/BUSL/RSALv2/Elastic-license dependencies (§16.5). Valkey, not Redis 7.4+.
- No LLM pixel painting, no flattening/baking — editability is the product (§25).
- No vendored-code edits, no mass reformat of others' files, no `console.log` in shipped paths.
- No free LLM tiers for customer data (§1.5 constraint 6). No OpenRouter in production.
