# infra/environments.md — local / staging / production (spec §17.5)

Three instantiations of ONE compose file (`infra/compose/docker-compose.yml`).
Rule zero (§17.5): **never test migrations on production first** — every
Drizzle migration runs local → staging → prod, in that order, via
`infra/scripts/migrate.sh` (forward-only, §4). Staging gets the SAME webhook
endpoints with Stripe TEST keys (§17.5).

| | `local` | `staging` | `production` |
|---|---|---|---|
| **Where** | dev machine, Docker Compose | SAME Lightsail box as prod, SEPARATE Compose project | AWS Lightsail 4 GB, Ubuntu 24.04, Docker Compose (§17.1) |
| **Compose project** | default | `COMPOSE_PROJECT_NAME=staging` — own volumes, own networks, own ports | default |
| **Env file** | repo `.env` (git-ignored, `0600`) | separate box file, e.g. `/srv/studio-staging.env` | box `.env` at the clone root, `0600` (ADR-0002) |
| **Engine** | MOCK engine (compose defaults; no Rust toolchain, no binary) | mock engine (or a staged binary under test) | real engine binary baked in the image (`ENGINE_CLI_PATH`) |
| **Web entry** | `http://localhost` (override file adds ports) | `staging.<domain>` via the box Caddy with **`tls internal`** — one public IP per box, so no public ACME for staging | `<domain>`, Caddy automatic ACME TLS (DNS A record BEFORE first `up` — infra/README step 3) |
| **Database** | container volume; reset freely (`down -v`) | separate staging DB (project-scoped volumes) | own `pgdata` + daily `pg_dump` via `backup.sh` (RPO ≤ 24 h) |
| **Object storage** | local disk, disposable | staging prefix, test creds | **Cloudflare R2** (§17.1: removes egress fees at scale); backups → versioned S3 bucket |
| **LLM providers** | test keys; free tiers fine for dev data | test keys | **paid providers only** — no free LLM tiers for customer data (§1.5) |
| **Stripe** | test keys | TEST keys, same webhook endpoints (§17.5) | live keys |
| **Deploy path** | `infra/scripts/deploy-v2.sh --build` (on-box build is the local/bootstrap path) | `COMPOSE_PROJECT_NAME=staging ENV_FILE=/srv/studio-staging.env infra/scripts/deploy-v2.sh` | CI on main → GHCR `app:<sha>` → SSH → `infra/scripts/deploy-v2.sh` (§17.3) |
| **Backups** | none (disposable) | ad-hoc dump before risky migrations | daily `backup.sh` + MONTHLY `restore.sh` drill (RB-06; RTO ≤ 4 h) |
| **Smoke** | `infra/scripts/smoke.sh` (mock engine on → engine smoke once `ENGINE_SMOKE_CMD` is wired) | same, against the staging base URL | `smoke.sh` is the §17.3 health gate of every deploy |

## Staging on the same box — exact knobs

```bash
# from a clone on the box — the PROJECT name is the hard boundary:
# every volume/network is project-scoped (staging_pgdata vs the prod one),
# so staging physically cannot touch prod data.
COMPOSE_PROJECT_NAME=staging \
ENV_FILE=/srv/studio-staging.env \
  infra/scripts/deploy-v2.sh                      # migrate → up → smoke, staging scope

COMPOSE_PROJECT_NAME=staging ENV_FILE=/srv/studio-staging.env \
  docker compose -f infra/compose/docker-compose.yml ps   # never mix the two projects
```

- **Caddy internal TLS (staging):** the box owns ONE public IP; the prod Caddy
  holds 80/443 and ACME. Staging must NOT bind 80/443 — its Caddy site uses
  `tls internal` (internal CA) on `staging.<domain>`, reachable as an extra
  site block in `infra/caddy/Caddyfile` reverse-proxying to the staging
  gateway, or via SSH tunnel (`ssh -L 8443:localhost:8443 …`).
  *(site block owned by `infra/caddy` — flagged in the worklog for its owner)*
- **Stripe:** configure the TEST-mode webhook endpoints with the same paths as
  prod (§17.5), pointing at the staging host; never mix test and live keys in
  one env file.

## Secret provisioning (never in the repo)

1. **Secrets live only in env files on the box** — `0600`, created by ops from
   `.env.example` + box values. NEVER committed, never in issues/logs/CI
   (AGENTS.md forbidden list; `scripts/git-sync.sh` stages the whole tree, so
   secret files stay out of the repo, period).
2. Each env file carries: `DATABASE_URL` + `POSTGRES_PASSWORD` (must match),
   Stripe `STRIPE_SECRET_KEY` + webhook secret, LLM provider API keys, R2/S3
   keys, `APP_DOMAIN`, `ENGINE_CLI_PATH`, plus the rest of the parsed env
   schema (ADR-0002 / `packages/config`).
3. **Deploy secrets note:** CI holds exactly two secrets — the SSH key to the
   box and the GHCR token. The box pulls images with its own GHCR credentials
   and reads app secrets only from its env file. CI never sees app secrets;
   the box never sees CI credentials. All deploy scripts refuse to start
   without a readable env file (`deploy-v2.sh` pre-flight) — fail fast (§4).
4. **Rotation:** change the value in the box env file →
   `docker compose --env-file .env up -d <svc>` → verify with `smoke.sh`.
   For a compromise follow the security-incident runbook (§17.4): rotate
   tokens, revoke API keys, preserve the audit log.
5. Deploy bookkeeping (image tags, timestamps) lives in `STATE_DIR`
   (`/var/lib/studio-deploy` on the box, fallback `~/.cache/studio-deploy`) —
   tags only, never secrets.

### Env knobs these scripts add (for the `.env.example` / ADR-0002 owner)

| var | used by | meaning |
|---|---|---|
| `IMAGE_TAG` | deploy-v2 / rollback | app image tag of the `app:<git-sha>` scheme (default: git HEAD of the box clone) |
| `ENGINE_PIN` | deploy-v2 pre-flight | engine commit the image must carry (ADR-0001: `872748fb…`) |
| `WORKER_HEALTH_URL` / `WORKER_HEALTH_PORT` | smoke | worker health endpoint (owner: apps/worker/src/health.ts) |
| `ENGINE_SMOKE_CMD` | smoke | optional scratch-serve `session.list` probe — see smoke.sh header |
| `SMOKE_BASE_URL` | smoke | override target (else `https://$APP_DOMAIN`) |
| `PREV_IMAGE_TAG`, `ALLOW_LATEST`, `MIN_FREE_MB`, `STATE_DIR`, `BUILD_ON_BOX`, `ROLLBACK_YES`, `HEALTH_TIMEOUT` | deploy-v2 / rollback | run-time knobs, documented in the script headers |

Also flagged (worklog): `infra/compose` app services should interpolate
`${IMAGE_TAG}` in their `image:` fields so CI-built `app:<sha>` tags flow end
to end. `rollback.sh` works either way (`docker tag` repinning), but
interpolation is the clean path; if pins are hardcoded, keep `IMAGE_TAG` in
the env file in sync with what CI deployed.

## §17.4 operations runbooks (cross-links)

| Runbook (docs/runbooks/) | Incident | Scripts involved |
|---|---|---|
| RB-01-run-failure-spike | run failure spike | `smoke.sh`, gateway logs |
| RB-02-queue-backlog | queue backlog | `smoke.sh` (queue check), worker health |
| RB-03-engine-crash-loop | engine pool crashes | `smoke.sh` (engine smoke), engine-pool watchdog |
| RB-04-provider-outage | LLM provider outage | `smoke.sh` (deep health providers), circuit breakers |
| RB-05-disk-usage | disk full / memory pressure | `deploy-v2.sh` pre-flight disk gate |
| RB-06-restore-drill | backup restore (monthly, timed) | `backup.sh`, `restore.sh`, `migrate.sh` |
| RB-07-stripe-webhook-failures | Stripe webhook failures | staging webhook config (above) |
| RB-08-cost-guardrail-breach | cost guardrail breach | provider budgets, §22 cost dashboards |

Deploy-time pointers (§17.3/§17.4): after every deploy, watch engine crash
rate, provider breakers and the queue for an hour; on a failed health gate
roll back with `infra/scripts/rollback.sh` (the previous TWO `app:<sha>` tags
are kept on the box). The DB is never auto-rolled-back (forward-only
migrations, §4) — manual psql/restore pointers live in `rollback.sh`.
