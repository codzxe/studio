# syntax=docker/dockerfile:1
# infra/caddy/Dockerfile — Studio edge image (Caddy + frozen EffectCraft editor).
#
# Build (context = infra/caddy):
#   docker build infra/caddy
#   # via compose: docker compose --env-file ../../.env build caddy
#
# EDITOR DIST IS A PREBUILT INPUT (§6.1): editor/target is gitignored and the
# Rust/wasm toolchain is not part of this image. Build it outside Docker and
# stage it into the build context before `docker build`:
#   cd editor && cargo xtask web                      # → editor/target/web/dist
#   mkdir -p infra/caddy/editor-dist
#   cp -r editor/target/web/dist/. infra/caddy/editor-dist/
# editor-dist/ is gitignored (infra/caddy/.gitignore) — the ~17MB wasm never
# belongs in git. Optional: precompress for the best first-paint (Caddy's
# `encode` serves sidecar files automatically):
#   brotli -q 11 infra/caddy/editor-dist/studio_web_bg.wasm

ARG CADDY_VERSION=2.11

# The stock Caddy build registers gzip+zstd only; we rebuild with the pure-Go
# brotli module (github.com/ueffel/caddy-brotli) because the ~17MB-gzip editor
# wasm compresses to ~10MB with brotli (§15 wasm budget: 18MB compressed).
FROM caddy:${CADDY_VERSION}-builder AS builder
RUN xcaddy build \
      --with github.com/ueffel/caddy-brotli@v1.7.0

FROM caddy:${CADDY_VERSION}-alpine
# Custom caddy binary with brotli; CADDY_ENCODERS feeds the Caddyfile's
# `encode` placeholder (stock binaries must use "zstd gzip").
ENV CADDY_ENCODERS="brotli zstd gzip"
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
# URL /editor/* maps to /srv/editor (handle_path strips the prefix).
COPY editor-dist/ /srv/editor/
EXPOSE 80 443
