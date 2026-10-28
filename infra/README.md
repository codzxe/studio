# infra/ — Studio deployment foundation

One-box beta (PRODUCT_ARCHITECTURE §14.2): Caddy + Next.js + gateway + worker
+ Postgres + Valkey + MinIO + LiteLLM on a single Linux box, TLS by Caddy.

## What lives here

| Path                     | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `compose/`               | Docker-based full stack (data plane live today; `apps` profile lands with the app waves) |
| `caddy/`                 | Edge: TLS, `/editor/*` static + COOP/COEP (§6.1), `/v1/*` → gateway (SSE), `/` → web |
| `systemd/`              | Native (no-Docker) service units + install README                  |
| `litellm/`               | EDIT-ME LiteLLM proxy config: `studio-fast/smart/vision` aliases, budgets, spend DB |
| Repo-root `scripts/dev-postgres.sh`, `scripts/dev-valkey.sh` | Rootless portable dev services (no Docker, no sudo) |

## Prerequisites

- **Node 22+** and **pnpm 9** (`corepack enable`)
- **Rust 1.95+** with `wasm32-unknown-unknown` + `wasm-bindgen-cli` 0.2.129
  (only for building the editor; see `editor/docs/web.md`)
- **Docker + compose v2** (container path) **or** native services (native path)
- 2 vCPU / 4 GB RAM is enough for the beta

## Path A — containers (recommended for the box)

```bash
git clone https://github.com/codzxe/studio && cd studio
cp .env.example .env && chmod 600 .env && $EDITOR .env   # real secrets, APP_ENV=production, APP_URL=https://…

cd infra/compose
docker compose --env-file ../../.env up -d               # db, valkey, minio(+bucket), litellm
cd ../.. && pnpm install && pnpm db:migrate && pnpm db:seed
cd editor && cargo xtask web && cd ..                    # → editor/target/web/dist
mkdir -p infra/caddy/editor-dist && cp -r editor/target/web/dist/. infra/caddy/editor-dist/
cd infra/compose && docker compose --env-file ../../.env --profile apps up -d --build
# Set SITE_ADDR + ACME_EMAIL (or DNS + ports 80/443 open) before the last step —
# see compose/README.md for the full bring-up order.
```

## Path B — native, no Docker (also the only path in rootless dev sandboxes)

```bash
cp .env.example .env && $EDITOR .env
pnpm install
pnpm dev:pg                          # portable PostgreSQL 17 @ 127.0.0.1:5432 (scripts/dev-postgres.sh)
bash scripts/dev-valkey.sh start     # portable Valkey 8 @ 127.0.0.1:6379 — OPTIONAL
pnpm db:migrate && pnpm db:seed
pnpm dev                             # web + gateway (turbo); editor in a second terminal:
pnpm editor:serve                    # cargo xtask web --serve 8765 → EDITOR_DEV_SERVER_URL
```

Production on this path runs the `systemd/` units + distro Postgres/Valkey +
Caddy; see `systemd/README.md`.

## Editor serving contract (§6.1 — do not break)

- `/editor/*` is served same-origin by Caddy from the frozen wasm build with
  `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` (SharedArrayBuffer).
- Caching: only content-hashed assets (`snippets/*`) are
  `immutable, max-age=31536000`. The stable-named engine files
  (`studio_web.js`, `studio_web_bg.wasm`, `worker.js`, `audio-worklet.js`)
  are `public, max-age=0, must-revalidate` — the SW's own `fetch()` goes
  through the HTTP cache, so a year-long immutable policy on stable names
  served stale engine bytes across deploys (the M3 boot-fix incident);
  the SW's `cache:"reload"` network fetches rescue already-poisoned caches.
  `index.html` + `sw.js` are `no-cache`; manifest/icons 1h. `.wasm` is
  sent as `application/wasm`.
- The app mounts the editor at `EDITOR_PUBLIC_PATH` (default `/editor`) with
  `?empty` so no stale browser session leaks in (§6.3).

## Backup

- **Daily base backup** (cron, from `infra/compose/`):
  `docker compose exec -T db pg_dump -U studio -d studio -Fc > backups/studio-$(date +%F).dump`
  (native: `sudo -u postgres pg_dump studio -Fc > …`).
- **WAL archiving**: the beta runs one box with `archive_mode` on and WAL
  shipped off-box (pgBackRest or plain `archive_command` to the S3 bucket) —
  enables point-in-time recovery between base backups. Revisit before the
  first real customer; keep base backups ≥ 30 days, WAL ≥ 7 days.
- **Monthly restore drill**: restore the latest dump to a scratch database
  (compose/README.md has the exact commands), run the app against it, record
  the result in the runbook (§14.2: "restore drill monthly").
- Object storage: versioned bucket, lifecycle rule for old renders, off-box
  copy (`mc mirror`) — §14.2.

## Upgrade

1. `git pull` → `pnpm install` → `pnpm build` (or `docker compose build`).
2. `pnpm db:migrate` — **migrations are forward-only**; never write a "down".
3. Rebuild the editor only when the pin changes: `cargo xtask web`, re-stage
   `infra/caddy/editor-dist/`, rebuild the caddy image.
4. Roll services (`systemctl restart studio-*` or `docker compose up -d`);
   zero-downtime is not required at beta (§14.2) — a maintenance window is OK.

## Rollback (policy: docs/BUILD_PLAN.md §8.4)

- **App**: redeploy the previous image/container; DB migrations are
  forward-only — roll back code only if schema-compatible.
- **Editor**: redeploy the previous wasm pin; test opening a project saved by
  the new pin before rolling back (project format is backward-compatible in
  range).
- **Billing**: never roll back ledger rows — issue compensating adjustments.
- Editor pin revert + Caddy re-stage is a single `editor-dist/` copy + image
  rebuild; keep the previous dist directory around for one release.
