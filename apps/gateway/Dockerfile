# syntax=docker/dockerfile:1
# =============================================================================
# apps/gateway/Dockerfile — @studio/gateway production image (spec §17.2)
# Wave W9-I. Multi-stage, workspace-aware pnpm build.
#
# BUILD CONTEXT = REPO ROOT (needs pnpm-workspace.yaml, packages/* sources,
# tsconfig.base.json):
#     docker build -f apps/gateway/Dockerfile .
# CI (§17.3) builds all images from the root context and pushes to GHCR; the
# box only pulls. TODO(W9-I → W1-L, infra owner): infra/compose/docker-compose.yml
# currently sets `build.context: ../../apps/gateway` — flip to
# `context: ../..` + `dockerfile: apps/gateway/Dockerfile` so
# `docker compose build` works (see apps/gateway/.dockerignore header too).
#
# Stages: base (corepack pnpm + dumb-init)
#       → fetch  (filtered workspace install, frozen lockfile when present)
#       → build  (turbo `build` scripts + direct-tsc emit fallback)
#       → runtime (NODE_ENV=production, prod deps only, USER node, healthcheck)
# =============================================================================

# --- base: Node 22 LTS (spec: Node 22+), pnpm via corepack, dumb-init for PID 1
FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apk add --no-cache dumb-init \
 && corepack enable \
 && corepack prepare pnpm@9.15.0 --activate  # matches root packageManager pin

# --- fetch: install @studio/gateway + its workspace dependency closure ------
FROM base AS fetch
WORKDIR /repo
COPY package.json pnpm-workspace.yaml ./
# All workspace importer manifests (pnpm resolves `workspace:*` edges across
# the whole pnpm-workspace.yaml globs; manifests-only first = cache-friendly).
COPY apps/gateway/package.json apps/gateway/
COPY apps/engine-pool/package.json apps/engine-pool/
COPY apps/mock-engine/package.json apps/mock-engine/
COPY apps/web/package.json apps/web/
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
# `@studio/gateway...` = gateway + every transitive workspace dep; the extra
# `studio` selector installs the root toolchain (tsc) used by the build stage.
# TODO(W9-I, lockfile wave): once pnpm-lock.yaml is committed, add
#     COPY pnpm-lock.yaml ./
# above so the install layer re-caches on lockfile changes; the guard below
# then always takes the --frozen-lockfile branch.
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm --filter @studio/gateway... --filter studio install --frozen-lockfile; \
    else \
      echo "W9-I WARN: pnpm-lock.yaml absent — fallback --no-frozen-lockfile (TODO: commit lockfile)"; \
      pnpm --filter @studio/gateway... --filter studio install --no-frozen-lockfile; \
    fi

# --- build: compile the app + imported workspace sources to dist/ -----------
FROM fetch AS build
COPY tsconfig.base.json ./
COPY apps/gateway apps/gateway
COPY packages packages
# 1) Turbo-style build for the app closure (turbo.json `build.outputs:
#    dist/**`). `--if-present`: TS packages don't define `build` scripts yet —
#    they are skipped until the build-wiring wave lands, then picked up
#    automatically.
RUN pnpm --filter @studio/gateway... run --if-present build
# 2) Direct tsc fallback (works today). Apps import workspace packages via
#    pnpm symlinks whose `main` is ./src/index.ts, so tsc compiles the
#    imported package SOURCES into this app's dist tree (common-root layout):
#      apps/gateway/dist/apps/gateway/src/index.js     (entry, asserted below)
#      apps/gateway/dist/packages/<dep>/src/*.js       (compiled deps)
RUN pnpm exec tsc -p apps/gateway/tsconfig.json \
 && test -f apps/gateway/dist/apps/gateway/src/index.js
# Image-local manifest shim: point each dependency package's main/exports at
# the tsc output compiled into THIS app's dist tree. The repo convention
# (`main: ./src/index.ts`) serves dev tooling, but Node 22 cannot execute
# those entrypoints under the NodeNext `.js`-specifier convention (type
# stripping never remaps specifiers). Runs inside the image build only —
# repo files are never touched. TODO(build-wiring wave): once packages grow
# real `build` scripts + dist mains, drop this shim and the tsc fallback.
COPY <<'EOF' /tmp/patch-mains.mjs
// W9-I: rewrite workspace dependency entrypoints to compiled output.
import fs from "node:fs";
const app = process.argv[2];
if (!app) throw new Error("usage: node patch-mains.mjs <app>");
let patched = 0;
for (const ent of fs.readdirSync("packages", { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const pkg = ent.name;
  const pj = "packages/" + pkg + "/package.json";
  if (!fs.existsSync(pj)) continue;
  const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
  let changed = false;
  const toDist = (v) => {
    if (typeof v !== "string" || !v.startsWith("./src/") || !v.endsWith(".ts")) return null;
    const tail = v.replace(/^\.\/src\//, "src/").replace(/\.ts$/, ".js");
    const abs = "apps/" + app + "/dist/packages/" + pkg + "/" + tail;
    return fs.existsSync(abs) ? "../../apps/" + app + "/dist/packages/" + pkg + "/" + tail : null;
  };
  const main = toDist(manifest.main);
  if (main) { manifest.main = main; changed = true; }
  if (manifest.exports && typeof manifest.exports === "object") {
    for (const key of Object.keys(manifest.exports)) {
      const mapped = toDist(manifest.exports[key]);
      if (mapped) { manifest.exports[key] = mapped; changed = true; }
    }
  }
  if (changed) { fs.writeFileSync(pj, JSON.stringify(manifest, null, 2) + "\n"); patched += 1; }
}
console.log("patch-mains: " + patched + " workspace package(s) -> apps/" + app + "/dist compiled output");
EOF
RUN node /tmp/patch-mains.mjs gateway && rm -f /tmp/patch-mains.mjs
# Prod-only prune so the runtime stage ships without dev tooling, then clear
# test/fixture junk that rode along with the sources.
RUN pnpm prune --prod && pnpm store prune \
 && rm -rf apps/gateway/tests packages/*/tests

# --- runtime: non-root, NODE_ENV=production, prod deps only, healthcheck -----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache dumb-init
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/gateway
# Documentation-only (compose publishes nothing but Caddy, §17.2): gateway
# serves HTTP on 8787 in-container (GATEWAY_INTERNAL default gateway:8787).
EXPOSE 8787
# §17.2 "every service has a healthcheck". Mirrors the compose definition —
# `docker compose` overrides this with its own probe (GET /v1/health built by
# src/routes/health.ts); this covers plain `docker run`. Node fetch keeps the
# probe dependency-free on alpine (no curl/wget assumption).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT??'8787')+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# dumb-init = PID 1 signal hygiene (SIGTERM → clean BullMQ/SSE drain).
CMD ["dumb-init", "node", "dist/apps/gateway/src/index.js"]
