# Contributing to studio

The working rules in `docs/AGENTS.md` were written for a parallel build fleet; this
file is the same law, distilled for humans. Where this file and `AGENTS.md` or the
spec (`docs/BUILD_PROMPT.md`) disagree, **the spec wins**, then `AGENTS.md`.

## The one rule behind all the others

Editability is the product (§25): agents edit real layered documents via engine
commands — no LLM pixel painting, no flattening, no baking. And the product code
never uses the names PhotoCraft / ArtCraft / Photoshop / Cursor (§1.5); `studio` is
an internal codename, never user-facing.

## Setup

Node 22+ (`.nvmrc`), pnpm 9, Docker. See the root `README.md` 5-minute quickstart:
`pnpm install`, copy `.env.example` → `.env` (chmod 0600; compose uses service
hostnames, host dev uses `localhost`), bring up `db` + `valkey` from
`infra/compose/`, then `pnpm dev`. Useful scripts: `pnpm db:seed`,
`pnpm --filter @studio/worker demo:coffee`, `pnpm test`, `pnpm lint`,
`pnpm typecheck`, `pnpm format` (Biome), `pnpm check:licenses`.

## Git flow

- **On the build box:** push ONLY via `scripts/git-sync.sh "<W-ID>: what you did>"`.
  It stages, commits, pulls `--rebase` (GitHub wins), and pushes — serialized with
  a global lock across the fleet. Sync early after large intermediate milestones;
  keep waves small. NEVER hand-roll commit/push, never force-push, never rewrite
  history.
- **External contributors:** small PRs, one concern each, against `main`. Never
  force-push to shared branches; rebase your work before review.
- Never commit secrets, tokens, or font files. `.env` stays out of the tree;
  the pinned fonts live in an external clone (`CRAFT_FONTS_DIR`).

## Ownership protocol

Touch only the paths your task (or your issue/PR) claims. Shared/registry files —
root configs, `package.json` indexes, lockfiles, `.github/` — are changed only with
explicit scope. Need a change in a file you don't own? Propose it in your PR
description or an issue; do not edit it "while you're in there". Never edit
anything under `vendor/*` — engine changes are authored as upstreamable new
modules in `engine-patches/` (§2.3, §16.1). No mass reformatting of others' files.

## Style gates (what CI runs)

Currently staged in `infra/ci-staged/` (workflows activate once the repo PAT gains
`workflow` scope — see that README) and enforced locally by the same commands:

1. **Lint** — Biome (`pnpm lint`); `pnpm format` to fix.
2. **Typecheck** — `tsc --noEmit`, TypeScript strict, ESM (`"type": "module"`).
3. **Unit tests** — Vitest: deterministic, < 5 s units, no network, table-driven
   for pure logic (`pnpm test`).
4. **Build** — Turborepo, all workspaces (`pnpm build`).
5. **License gate** — `scripts/check-licenses.mjs` (`pnpm check:licenses`), plus a
   weekly scheduled run.
6. **Rust gate (engine-patches only)** — `cargo check` + `cargo test` + `clippy` +
   `panic_hunt` against the pinned vendor clone overlaid with the patches.

Code style the gates can't check but review will: no `any` in exported APIs;
errors are typed result envelopes `{ ok: false, code, message, hint, retryable? }`
— never throw strings, never leak stack traces, absolute paths or internal ids;
Zod at every boundary (HTTP input, tool args, engine params, env vars, manifests);
env parsed once via `packages/config` — a missing secret must refuse to start;
idempotency keys on every money/credit path; ledger entries are append-only;
forward-only Drizzle SQL migrations; no `console.log` in shipped paths.

## Cite the spec (§-refs rule)

`docs/BUILD_PROMPT.md` is the source of truth and beats instincts. Wherever the
"why" matters — in code comments (`// §5.2 tier budgets`), in commit messages, and
in every PR (the template has a mandatory *Spec references* section) — cite the
section you implement or are constrained by. If you're picking a library,
architecture or protocol decision, record an ADR in `docs/adr/` first.

## License checklist (before you add any dependency)

Permissive licenses only (§16.5). The denylist: **AGPL, SSPL, BUSL, RSALv2, and
Elastic-license** anything. That's why the queue is Valkey (BSD), not Redis 7.4+,
and the dashboards are Perses (Apache-2.0), not Grafana. For each new dependency:

- [ ] Add a row to `ATTRIBUTION.md` and the license text under `LICENSES/`.
- [ ] `pnpm check:licenses` is green (declare justified exceptions in
      `licenses.overrides.json`, never silently).
- [ ] No customer data flows through free LLM tiers (§1.5); no OpenRouter in
      production.

## PR template

Use `.github/pull_request_template.md` — Summary (one paragraph), **Spec
references** (required), and the checklist: tests added, ADR recorded where a
decision was made, attribution + license gate green, no secrets/fonts, vendor
untouched. Anything non-obvious goes in *Notes for reviewers*.

## Where things are

New here? `README.md` is the front door, `docs/repo-map.md` maps every directory,
`docs/AGENTS.md` is the full rulebook, `docs/adr/` holds the decisions, and
`docs/runbooks/` is what you read at 3 a.m.
