# Devlog — studio SaaS

One entry per build phase (§19: "each phase ends with a green CI, a demo-able
artifact, and a short devlog entry"). Entries are append-only; newest at the bottom.
Each entry records: what shipped (with commits), what was decided (with ADRs), what
was learned, and what the next phase depends on. Alert/runbook references use
`docs/runbooks/RB-xx`; architecture decisions use `docs/adr/NNNN`.

---

## Phase 0 — Spike / foundation (Waves 0–1) — 2026-10-20

**Goal (§19 Phase 0):** prove the spine end-to-end (`pnpm demo:coffee`: brief →
template → engine → render → critic → `.pcraft` + PNG + command log) with zero product
polish. Wave 0 + Wave 1 laid the monorepo, schemas and service skeletons that the spike
code builds on; the spike itself (engine-client calls, one template, one LLM path,
critic loop) is the immediate next step.

**Fleet:** Wave 1 ran as ~20 parallel agents (W1-A…W1-T) plus the W0 scaffold agents;
10 of them had landed at the time of this entry. **Repo:** 8 packages (`agent`,
`billing`, `config`, `db`, `engine-client`, `evals`, `tools`, `ui`) + 4 apps
(`gateway`, `worker`, `engine-pool`, `web`) = 12 pnpm workspace projects.

**Shipped (commit → what):**

- ✅ `ffe228f` W0 — repo scaffold: build prompt (`docs/BUILD_PROMPT.md`), agent law
  (`docs/AGENTS.md`), `scripts/git-sync.sh`, ADR-0001 editor pins, `ATTRIBUTION.md`.
- ✅ `82cfcf4` W0b — monorepo shell: pnpm workspaces + Turborepo, TS strict ESM
  NodeNext base, Biome, `turbo.json`, package skeletons.
- ✅ `7fe021f` W1-A — environment matrix + `.env.example` + ADR-0002 (fail-fast env
  parsing contract for the fleet).
- ✅ `e4f2ceb` W1-E — runs schema: `agent_runs`/`agent_steps`/`run_events` with
  idempotency + per-run event `seq`.
- ✅ `8ee9242` W1-F — billing schema: append-only `credit_ledger`, `credit_reservations`,
  `plans`, `subscriptions`, `idempotency_keys`, `rate_limit_buckets` + `audit_log`.
- ✅ `4800ccf` W1-D — content schema: documents, versions, command-log WAL (unique
  `(document_id, seq)`), assets, comments, workspace templates.
- ✅ `de16acb` W1-I — worker skeleton: BullMQ queue topology (`runs:quick|max …`,
  `exports`, `images`), §3.4 timeouts, retry ×3, injectable `RunProcessor` seam.
- ✅ `7133e91` W1-H — gateway skeleton: Hono app factory, request-id + pino logger,
  flat error envelope, `/v1/health` + `/v1/health/deep`, graceful drain.
- ✅ `c57c0c3` W1-J — engine-pool skeleton: session registry, 256-bit token alloc,
  watchdog, tenant-checked lookups, injectable spawner (24 tests, zero real processes).
- ✅ `28c6ecc` W1-G — db client factory (postgres-js + Drizzle), `drizzle.config.ts`,
  idempotent seed script, migration docs.
- ✅ ADR-0003 (Better Auth org/apiKey/admin + RBAC matrix), ADR-0004 (BullMQ on Valkey,
  license rationale), ADR-0005 (pino/OTel/Langfuse/GlitchTip/Uptime Kuma), runbooks
  RB-01…RB-08 (§22 alerts → procedures), API docs index (`docs/api/README.md`).

**Decisions worth remembering:**

- Valkey, not Redis ≥ 7.4 (RSALv2/SSPL, §16.5) — ADR-0004; Better Auth over
  Clerk/NextAuth — ADR-0003; GlitchTip over Sentry self-host (FSL) — ADR-0005.
- Ledger is append-only; queue is transport, never money truth (ADR-0004).
- Cross-tenant lookups are indistinguishable from not-found (W1-J registry rule).

**Known open items (for the next wave):**

- Error envelope reconciliation: gateway ships the flat `{ ok:false, code, message,
  hint }` (AGENTS.md law) while §13.3 sketches nested `{ error: { … } }` — decided in
  the contract wave (see `docs/api/README.md`).
- Text vs uuid id columns across schema files need repository-layer casts (W1-D/W1-F
  notes); `tsconfig.base.json` composite + `tsc --noEmit` risk flagged fleet-wide.
- Phase 0 exit gate not yet met: `pnpm demo:coffee` needs the engine-client wired to
  `photocraft-cli serve`, one template manifest, and one Gemini call path.

**Next:** finish Phase 0 spike, then Phase 1 MVP (§19: auth+workspaces, gateway
endpoints with RBAC, worker+billing live, engine pool live, validator v1, 3 templates).
