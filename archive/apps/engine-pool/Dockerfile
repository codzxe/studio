# syntax=docker/dockerfile:1
# =============================================================================
# apps/engine-pool/Dockerfile — @studio/engine-pool production image (§17.2)
# Wave W9-I. Multi-stage, workspace-aware pnpm build. Supervisor that spawns
# one `photocraft-cli serve` process per active tenant session (§3.2, §15.1);
# engine processes bind loopback INSIDE this container — the browser never
# reaches them. Capped at 2 GB / 2 CPU by compose (§17.4 pressure rule).
#
# BUILD CONTEXT = REPO ROOT:
#     docker build -f apps/engine-pool/Dockerfile .
# CI (§17.3) builds from the root context and pushes to GHCR.
# TODO(W9-I → W1-L, infra owner): infra/compose/docker-compose.yml sets
# `build.context: ../../apps/engine-pool` — flip to `context: ../..` +
# `dockerfile: apps/engine-pool/Dockerfile` for `docker compose build`.
#
# ENGINE BINARY (§3.2): the Rust `photocraft-cli` binary is NOT baked into
# this (or any) image. It is compiled on the host from the pinned vendor
# clone and bind-mounted read-only at:
#     /engine/photocraft-cli      (ENGINE_BINARY_PATH default below)
# Compose owner must add e.g.
#     volumes: ["${ENGINE_BINARY_HOST_PATH:-/opt/studio/photocraft-cli}:/engine/photocraft-cli:ro"]
# and .env must NOT override ENGINE_BINARY_PATH away from the in-container
# path. Per-session capability roots live on the engine_work volume, mounted
# at /work below (§15.1).
#
# Stages: base → fetch → build → runtime (USER node, prod deps only).
# =============================================================================

# --- base: Node 22 LTS (spec: Node 22+), pnpm via corepack, dumb-init for PID 1
FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apk add --no-cache dumb-init \
 && corepack enable \
 && corepack prepare pnpm@9.15.0 --activate  # matches root packageManager pin

# --- fetch: install @studio/engine-pool + its workspace dependency closure ---
FROM base AS fetch
WORKDIR /repo
COPY package.json pnpm-workspace.yaml ./
# All workspace importer manifests (pnpm resolves `workspace:*` edges across
# the whole pnpm-workspace.yaml globs; manifests-only first = cache-friendly).
COPY apps/engine-pool/package.json apps/engine-pool/
COPY apps/gateway/package.json apps/gateway/
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
# `@studio/engine-pool...` = engine-pool + every transitive workspace dep; the
# extra `studio` selector installs the root toolchain (tsc) for the build
# stage.
# TODO(W9-I, lockfile wave): once pnpm-lock.yaml is committed, add
#     COPY pnpm-lock.yaml ./
# above so the install layer re-caches on lockfile changes; the guard below
# then always takes the --frozen-lockfile branch.
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm --filter @studio/engine-pool... --filter studio install --frozen-lockfile; \
    else \
      echo "W9-I WARN: pnpm-lock.yaml absent — fallback --no-frozen-lockfile (TODO: commit lockfile)"; \
      pnpm --filter @studio/engine-pool... --filter studio install --no-frozen-lockfile; \
    fi

# --- build: compile the app + imported workspace sources to dist/ -----------
FROM fetch AS build
COPY tsconfig.base.json ./
COPY apps/engine-pool apps/engine-pool
COPY packages packages
# 1) Turbo-style build for the app closure (turbo.json `build.outputs:
#    dist/**`). `--if-present`: TS packages don't define `build` scripts yet —
#    they are skipped until the build-wiring wave lands, then picked up
#    automatically.
RUN pnpm --filter @studio/engine-pool... run --if-present build
# 2) Direct tsc fallback (works today). Apps import workspace packages via
#    pnpm symlinks whose `main` is ./src/index.ts, so tsc compiles the
#    imported package SOURCES into this app's dist tree (common-root layout):
#      apps/engine-pool/dist/apps/engine-pool/src/index.js  (entry, asserted)
#      apps/engine-pool/dist/packages/<dep>/src/*.js         (compiled deps)
RUN pnpm exec tsc -p apps/engine-pool/tsconfig.json \
 && test -f apps/engine-pool/dist/apps/engine-pool/src/index.js
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
RUN node /tmp/patch-mains.mjs engine-pool && rm -f /tmp/patch-mains.mjs
# Prod-only prune so the runtime stage ships without dev tooling, then clear
# test/fixture junk that rode along with the sources.
RUN pnpm prune --prod && pnpm store prune \
 && rm -rf apps/engine-pool/tests packages/*/tests

# --- runtime: non-root, NODE_ENV=production, prod deps only, healthcheck -----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# §3.2: host-compiled engine binary is bind-mounted at /engine/photocraft-cli
# (see header); /engine is the mount point, owned by node so the mounted
# binary stays executable by the app user (§15.1 capability roots).
ENV ENGINE_BINARY_PATH=/engine/photocraft-cli
RUN apk add --no-cache dumb-init \
 && mkdir -p /engine /work \
 && chown node:node /engine /work
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/engine-pool
# No EXPOSE: the supervisor and every spawned engine process bind loopback
# inside this container only (§3.2) — no ports published, ever.
# §17.2 "every service has a healthcheck". Mirrors the compose stopgap —
# process liveness (PID 1 reachable) — until the supervisor exposes a real
# probe (compose TODO note; gateway's /v1/health/deep already carries an
# engine_pool probe, §22).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "process.kill(1,0)"]
# dumb-init = PID 1 signal hygiene (SIGTERM → watchdog stops engine sessions).
CMD ["dumb-init", "node", "dist/apps/engine-pool/src/index.js"]
