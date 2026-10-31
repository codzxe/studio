#!/usr/bin/env bash
# Start the local render worker against the SQLite dev DB (companion to
# scripts/dev-stack.sh, which boots only gateway + web). The worker drains
# the render queue, hydrates the pinned version, drives studio-cli (built
# from apps/editor: cargo build --release -p studio-cli →
# apps/editor/target/release/studio-cli, auto-detected via repo-build), and
# uploads the mp4 to the shared STORAGE_FS_ROOT.
# Usage: scripts/start-render-worker.sh   (log: .local/worker-dev.log)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export APP_ENV=local
export APP_URL=http://localhost:3000
export DATABASE_URL="file:$REPO/.local/studio-dev.db"
export STORAGE_FS_ROOT="${STORAGE_FS_ROOT:-$REPO/.local/storage}"
export AUTH_SECRET="${AUTH_SECRET:-dev-local-secret-0123456789abcdef0123456789abcdef}"
export AUTH_GOOGLE_ID=replace-me AUTH_GOOGLE_SECRET=replace-me AUTH_GITHUB_ID=replace-me AUTH_GITHUB_SECRET=replace-me
export STRIPE_WEBHOOK_SECRET=whsec_replace_me STRIPE_PRICE_IDS='{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}'
export LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://localhost:4000}" LITELLM_API_KEY="${LITELLM_API_KEY:-sk-litellm-replace-me}"
export ASSET_MAX_BYTES=524288000 PROJECT_MAX_BYTES=262144000 CHAT_MAX_STEPS=50
cd "$REPO/services/worker"
exec corepack pnpm dev
