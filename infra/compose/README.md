# infra/compose — Studio full stack (docker compose)

Production-shaped bring-up on one box (PRODUCT_ARCHITECTURE §14.2). Two
profiles so the data plane works today while app images land wave-by-wave:

| Profile   | Services                                    | Status                                    |
| --------- | ------------------------------------------- | ----------------------------------------- |
| default   | `db`, `valkey`, `minio`, `minio-init`, `litellm` | Usable now                          |
| `apps`    | `web`, `gateway`, `worker`, `caddy`          | Placeholder build contexts until the app/render waves ship their Dockerfiles |

## Prerequisites

- Docker Engine + docker compose v2 plugin
- The repo's `.env` (copy from `.env.example`, see the repo root header).
  **Two env mechanisms are used — both need the file:**
  - `env_file: ../../.env` → the 34 app vars go INTO app containers.
  - `--env-file ../../.env` → powers `${VAR}` interpolation in this compose
    file (compose-only knobs: `POSTGRES_PASSWORD`, `SITE_ADDR`, `ACME_EMAIL`,
    `LITELLM_DATABASE_URL`, plus `S3_*`/`LITELLM_API_KEY` reused for MinIO and
    LiteLLM). They are deployment knobs, NOT part of the app env contract.

## Bring-up order

```bash
cd infra/compose
cp .env.example .env && chmod 600 .env   # from the repo ROOT; edit real values first

# 1. data plane (db, valkey, minio + bucket, litellm)
docker compose --env-file ../../.env up -d
docker compose --env-file ../../.env ps        # wait for db/minio/valkey healthy

# 2. migrate + seed (from the repo root; uses DATABASE_URL=…127.0.0.1:5432)
pnpm install
pnpm db:migrate
pnpm db:seed

# 3. editor dist → caddy build context (see ../caddy/Dockerfile header)
(cd ../../editor && cargo xtask web)
mkdir -p ../caddy/editor-dist && cp -r ../../apps/editor/target/web/dist/. ../caddy/editor-dist/

# 4. app plane (once apps/web + services/gateway + services/worker Dockerfiles exist)
docker compose --env-file ../../.env --profile apps up -d --build
```

In-network overrides: the `.env` uses `127.0.0.1` hosts for native dev; the
compose `environment:` blocks override `DATABASE_URL`, `VALKEY_URL`,
`S3_ENDPOINT`, `LITELLM_BASE_URL` to the service names (`db`, `valkey`,
`minio`, `litellm`) — no edits to `.env` needed for the containerized path.

## Migration & seed

Migrations are **forward-only** (BUILD_PLAN §8.4). Both run from the host
against the published `127.0.0.1:5432` port:

```bash
pnpm db:migrate   # drizzle migrate (@studio/db)
pnpm db:seed      # synthetic/demo data — local/staging only (§14.3)
```

## Backup

Daily base backup via `pg_dump` (cron the line below; see ../README.md for
the WAL-archiving follow-up and the monthly restore drill):

```bash
cd infra/compose
docker compose --env-file ../../.env exec -T db \
  pg_dump -U studio -d studio -Fc > backups/studio-$(date +%F).dump
```

Object storage (MinIO) is versioned on-disk via the `minio-data` volume; copy
old renders off-box with `mc mirror` (§14.2: versioned bucket + lifecycle).

## Restore

```bash
# DANGER: destroys the current database — rehearse on a staging box, never ad-hoc in prod.
docker compose --env-file ../../.env exec -T db \
  psql -U studio -d postgres -c 'DROP DATABASE studio;' \
  -c 'CREATE DATABASE studio;'
docker compose --env-file ../../.env exec -T db \
  pg_restore -U studio -d studio --no-owner < backups/studio-<date>.dump
```

Restore drill (monthly) and rollback policy: see ../README.md and
docs/BUILD_PLAN.md §8.4 (app: previous image, schema-compatible only; billing:
compensating adjustments, never roll back ledger rows).

## Notes

- `docker compose down` keeps named volumes (`pg-data`, `minio-data`, …);
  `down -v` destroys data — staging only.
- LiteLLM's budget/spend tables live in the separate `litellm` database,
  created on first boot by `db-init/01-litellm.sql`.
- Caddy needs `editor-dist/` staged before `--profile apps` builds (step 3);
  the directory is gitignored inside `infra/caddy/`.
- FLEET NOTE (app wave): the `apps`-profile services build with context =
  repo root. The current root `.dockerignore` predates the Studio pivot and
  does NOT exclude `editor/` (incl. `apps/editor/target`, multi-GB) or `.local/`
  (portable dev binaries) — extend it when wiring the app Dockerfiles, or
  contexts will upload gigabytes.
