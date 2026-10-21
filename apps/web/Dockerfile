# syntax=docker/dockerfile:1
# =============================================================================
# apps/web/Dockerfile — @studio/web production image (spec §17.2)
# Wave W9-I. Next.js standalone build (next.config.ts `output: 'standalone'`,
# W1-K): the runner ships ONLY the standalone server with traced prod deps,
# .next/static and public/ — no pnpm, no dev tooling at runtime.
#
# BUILD CONTEXT = REPO ROOT (needs pnpm-workspace.yaml, packages/* sources —
# @studio/ui + @studio/config are workspace deps — and tsconfig.base.json):
#     docker build -f apps/web/Dockerfile .
# CI (§17.3) builds from the root context and pushes to GHCR.
# TODO(W9-I → W1-L, infra owner): infra/compose/docker-compose.yml sets
# `build.context: ../../apps/web` — flip to `context: ../..` +
# `dockerfile: apps/web/Dockerfile` for `docker compose build`.
#
# NOTE (W1-K): workspace deps must be bundled by Next (`transpilePackages`) so
# the standalone server never requires their `./src/index.ts` entrypoints at
# runtime (Node 22 cannot run those under the NodeNext `.js`-specifier
# convention). Verify on the first CI image build.
# =============================================================================

# --- base: Node 22 LTS (spec: Node 22+), pnpm via corepack, dumb-init for PID 1
FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apk add --no-cache dumb-init \
 && corepack enable \
 && corepack prepare pnpm@9.15.0 --activate  # matches root packageManager pin

# --- fetch: install @studio/web + its workspace dependency closure ----------
FROM base AS fetch
WORKDIR /repo
COPY package.json pnpm-workspace.yaml ./
# All workspace importer manifests (pnpm resolves `workspace:*` edges across
# the whole pnpm-workspace.yaml globs; manifests-only first = cache-friendly).
COPY apps/web/package.json apps/web/
COPY apps/engine-pool/package.json apps/engine-pool/
COPY apps/gateway/package.json apps/gateway/
COPY apps/mock-engine/package.json apps/mock-engine/
COPY apps/worker/package.json apps/worker/
COPY packages/agent/package.json packages/agent/
COPY packages/billing/package.json packages/billing/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/engine-client/package.json packages/engine-client/
COPY packages/evals/package.json packages/evals/
COPY packages/storage/package.json packages/storage/
COPY packages/tools/package.json packages/tools/
COPY packages/ui/package.json packages/ui/
# `@studio/web...` = web + every transitive workspace dep; the extra `studio`
# selector installs the root toolchain used by the build stage.
# TODO(W9-I, lockfile wave): once pnpm-lock.yaml is committed, add
#     COPY pnpm-lock.yaml ./
# above so the install layer re-caches on lockfile changes; the guard below
# then always takes the --frozen-lockfile branch.
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm --filter @studio/web... --filter studio install --frozen-lockfile; \
    else \
      echo "W9-I WARN: pnpm-lock.yaml absent — fallback --no-frozen-lockfile (TODO: commit lockfile)"; \
      pnpm --filter @studio/web... --filter studio install --no-frozen-lockfile; \
    fi

# --- build: `next build` → .next/{standalone,static} -------------------------
FROM fetch AS build
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages packages
# Next standalone expects a public/ dir; create it when absent (tracked on
# first CI image build) so the runtime COPY below has a source.
RUN mkdir -p apps/web/public
# web's own `build` script (`next build`) exists; workspace deps' build
# scripts are optional today (`--if-present` skips TS packages without one —
# the build-wiring wave's scripts get picked up automatically later).
RUN pnpm --filter @studio/web... run --if-present build \
 && test -d apps/web/.next/standalone

# --- runtime: standalone server + static + public, non-root, healthcheck -----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apk add --no-cache dumb-init
WORKDIR /app
# Standalone server + traced prod deps. In pnpm monorepos Next nests the app
# under .next/standalone/apps/web/ (node_modules at the standalone root) —
# normalize either layout to a flat /app.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
RUN set -eu; \
    if [ -d apps/web ]; then \
      echo "W9-I: flattening monorepo standalone layout (apps/web/*)"; \
      cp -a apps/web/. ./; \
      rm -rf apps/web; \
    fi
# Static assets + public dir live beside server.js (Next standalone docs).
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./public
USER node
# Documentation-only (compose publishes nothing but Caddy, §17.2): Caddy
# proxies {$APP_DOMAIN} → web:3000 (WEB_INTERNAL default web:3000).
EXPOSE 3000
# §17.2 "every service has a healthcheck". Compose overrides this with its
# own probe (GET / marketing page); this covers plain `docker run`. Keep
# in-container PORT at 3000 (WEB_PORT, if set in .env, must match).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??'3000')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# dumb-init = PID 1 signal hygiene; server.js is the standalone Next server.
CMD ["dumb-init", "node", "server.js"]
