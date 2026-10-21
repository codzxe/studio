# infra/systemd — native one-box units (§14.2: "managed by systemd")

The Caddy + systemd path runs the TypeScript services directly on the box
(no Docker). If you prefer containers, use ../compose instead — not both.

## Layout

| Unit                   | Service                                  | Status                       |
| ---------------------- | ---------------------------------------- | ---------------------------- |
| `studio-web.service`   | Next.js SaaS shell (:3000)               | Template — app wave wires it |
| `studio-gateway.service` | Hono gateway (:8787)                  | Template — gateway wave wires it |
| `studio-worker.service` | render/agent worker (Valkey queues)    | Template — render wave wires it |

All three share the same contract:

- `EnvironmentFile=/etc/studio/.env` — the 34-var app contract (see the
  repo-root `.env.example`). `chmod 600 root:studio`.
- `Restart=always` + `Type=exec`.
- Hardening: `NoNewPrivileges`, `ProtectSystem=strict` with
  `ReadWritePaths=/opt/studio/.local` (the only writable app tree),
  `PrivateTmp`, plus kernel/hostname/clock/SUID filters. Node/V8 needs
  writable+executable JIT pages, so `MemoryDenyWriteExecute` stays OFF for
  Node services (kept as an explicit comment in each unit).

## Install (root, one-time)

```bash
# 1. user + tree
sudo useradd --system --home /opt/studio --shell /usr/sbin/nologin studio
sudo git clone https://github.com/codzxe/studio /opt/studio
cd /opt/studio && sudo -u studio corepack enable && sudo -u studio pnpm install && sudo -u studio pnpm build

# 2. env file (never in the repo)
sudo mkdir -p /etc/studio
sudo cp .env.example /etc/studio/.env && sudo chmod 600 /etc/studio/.env
sudo $EDITOR /etc/studio/.env    # real secrets, APP_ENV=production, APP_URL=https://…

# 3. units
sudo cp infra/systemd/studio-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now studio-web studio-gateway studio-worker   # app wave onward

# 4. front it with Caddy (TLS + /editor/* + COOP/COEP — same Caddyfile)
sudo apt install caddy    # or the custom brotli build, see ../caddy/Dockerfile
sudo cp infra/caddy/Caddyfile /etc/caddy/Caddyfile
# edit: SITE_ADDR/ACME_EMAIL or set them in the caddy unit; in the native
# layout the upstreams are 127.0.0.1:3000 / 127.0.0.1:8787 — edit the two
# reverse_proxy targets accordingly.
sudo systemctl reload caddy
```

## Native data services

The box still needs Postgres 17 + Valkey 8 (+ MinIO or S3/R2):

```bash
sudo apt install postgresql-17 valkey    # Debian 13; Debian 12: postgresql from apt.postgresql.org
# Postgres: create role+db matching DATABASE_URL, then `pnpm db:migrate && pnpm db:seed`
```

`scripts/dev-postgres.sh` / `scripts/dev-valkey.sh` are for ROOTLESS dev
machines, not for the production box (use distro packages + systemd there).

## Operations

- Logs: `journalctl -u studio-web -f` (structured JSON per LOG_LEVEL).
- Env changes: `sudo systemctl restart studio-web studio-gateway studio-worker`.
- Backups/upgrades/rollback: see ../README.md (§ pg_dump daily + WAL,
  forward-only migrations, docs/BUILD_PLAN.md §8.4).
