# infra/ — single-box deployment (spec §17)

Everything needed to run the SaaS on **one AWS Lightsail 4 GB instance** with
Docker Compose, Caddy TLS and real backup/restore paths. This is the
"cheap, boring, reliable" hosting decision of §17.1 — settled, do not relitigate
without an ADR.

## What lives where

```
infra/
├── compose/
│   ├── docker-compose.yml                   # the single-node stack (§17.2)
│   └── docker-compose.override.yml.example  # dev-only ports + engine bind-mount
├── caddy/
│   └── Caddyfile                            # TLS, headers, body limit, proxying
├── scripts/
│   ├── backup.sh                            # pg_dump → gzip → S3 (§17.1/§17.4)
│   ├── restore.sh                           # the restore DRILL (§17.4)
│   └── deploy.sh                            # pull → migrate → rolling up (§17.3)
└── tofu/                                    # (future) OpenTofu for DNS/buckets
```

- **Compose file** defines: `caddy` (the only published ports: 80/443),
  `gateway`, `worker` (×2), `engine-pool` (capped 2 CPU / 2 GB), `web`,
  `db` (postgres:16-alpine), `valkey` (BSD-3 — **not** Redis ≥ 7.4, §16.3/§16.5),
  and a `--profile obs` group: `uptime-kuma`, `glitchtip` (own DB, never the app DB).
- **Canonical env file** is the repo root `.env` (ADR-0002). Invoke compose as
  `docker compose --env-file ../../.env -f docker-compose.yml …` so variable
  interpolation and container `env_file` read the SAME file. Keep `.env` `0600` (§17.2).
- App Dockerfiles are referenced but **land in Wave 9** — until then
  `compose build` fails for gateway/worker/engine-pool/web (expected).

## Box sizing (§17.1)

| Stage | Hosting | Cost |
|---|---|---|
| Gateway + worker + engine pool + Postgres + Valkey + Caddy | **AWS Lightsail 4 GB** (Ubuntu 24.04, Docker Compose) | $24/mo |
| Web app + wasm editor | Cloudflare Pages free tier | $0 |
| Object storage | AWS S3 (versioned backup bucket) | ~$1–5/mo |
| Error/uptime obs | GlitchTip + Uptime Kuma (`--profile obs`) | $0 |

Fits the first **10–20 active users**. Caveats from §17.1: confirm AWS credit
plan (Free-tier credits expire at 6 months — switch to Paid before the deadline)
and that Lightsail/Bedrock are credit-eligible; fallback documented: Hetzner
CX22 (~€4/mo). Rejected at this size: Render/Railway/Vercel/Supabase Pro,
Kubernetes, managed Redis/Postgres. Scale trigger (§17.4): sustained >60%
CPU/RAM or >30 concurrent runs → move **Postgres to its own box first**, then a
second engine box behind the gateway.

## First-boot runbook (outline)

Full runbooks live in `docs/` per §17.4; this is the boot order that makes
Caddy's automatic TLS work:

1. **Provision** Lightsail 4 GB, Ubuntu 24.04, static IP; open 80 + 443 (TCP)
   and 22 (restricted) in the Lightsail firewall. Install Docker Engine +
   compose plugin; clone the repo to e.g. `/srv/studio`.
2. **Env**: `cp .env.example .env && chmod 0600 .env`, then set the BOX values:
   `DATABASE_URL=postgres://studio:<pw>@db:5432/studio` and
   `VALKEY_URL=redis://valkey:6379` (**service hostnames, not localhost** —
   containers talk over the compose bridge), `POSTGRES_PASSWORD` (must match
   `DATABASE_URL`), `APP_DOMAIN`, Stripe/provider/LLM keys per ADR-0002,
   `ENGINE_CLI_PATH` = the *in-image* engine path (Wave 9 bakes the binary).
3. **DNS**: A/AAAA record `APP_DOMAIN` → static IP **before** starting Caddy —
   ACME issuance fails without it. Caddy then gets TLS automatically on first
   `compose up` (no cert manager to babysit, §16.3).
4. **Infra first**: `docker compose --env-file ../../.env up -d db valkey`,
   wait `pg_isready` healthy.
5. **Migrate**: Drizzle migrations, forward-only (§4/§12) — via `deploy.sh`
   once the one-off `migrate` service exists (Wave 9), before any app restart.
6. **Seed**: `packages/db` seed script (`db:seed`) — first workspace, plans.
7. **Stack up**: `infra/scripts/deploy.sh` (pull → migrate → rolling restart →
   health gate). Enable obs when wanted:
   `docker compose --env-file ../../.env --profile obs up -d`.
8. **Smoke**: `curl https://$APP_DOMAIN/v1/health` (liveness) →
   `/v1/health/deep` (db/valkey/engine-pool/providers all 200, §13) → web `/` →
   sign up, create workspace, invite a member (§20 acceptance #1).
9. **Protect**: cron `backup.sh` daily (RPO ≤ 24 h) and schedule the MONTHLY
   `restore.sh` drill (§17.4: real, timed, RTO ≤ 4 h — record the number).
10. **Staging** (§17.5): same box, separate Compose project —
   `COMPOSE_PROJECT_NAME=staging`, its own `.env` (subdomain + separate DB,
   Stripe TEST keys). Never test migrations on production first.

## Env additions this infra needs (owned by ADR-0002, not infra/)

`.env.example` currently lacks: `POSTGRES_PASSWORD`, `POSTGRES_USER`/`POSTGRES_DB`
(optional, default `studio`), `APP_DOMAIN`, `ACME_EMAIL` (optional),
`GATEWAY_INTERNAL`/`WEB_INTERNAL` (optional, default `gateway:8787`/`web:3000`),
`GLITCHTIP_SECRET_KEY`/`GLITCHTIP_DATABASE_URL` (obs profile only).
Tracked in the worklog for the `.env.example` owner.
