# =============================================================================
# apps/mock-engine/Dockerfile — @studio/mock-engine (W9-I)
# Protocol-faithful in-process fake of the headless engine control server
# (JSON lines over loopback TCP) for integration tests and compose dev.
#
# Zero runtime dependencies (Node stdlib only — see package.json), so this is
# a deliberately trivial single-stage runner: no corepack/pnpm/tsc stages.
#
# BUILD CONTEXT = THIS DIRECTORY (app dir):
#     docker build apps/mock-engine
# (No compose service consumes it yet — test/dev stacks only. The engine it
# fakes is a HOST bind-mount per §3.2; this container IS the fake, so nothing
# is baked or mounted here.)
# =============================================================================
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY src ./src
# Loopback-only control server (§3.2): the fake engine never needs host ports
# or an EXPOSE; test harnesses reach it via the compose network.
USER node
CMD ["node", "src/index.mjs"]
