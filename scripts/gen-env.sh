#!/usr/bin/env bash
# scripts/gen-env.sh — regenerate the repo-root .env.example from @studio/config
# (single source of truth: packages/config/src/env.ts). Runs scripts/gen-env.ts
# with tsx; downloads tsx on demand via pnpm dlx when it is not installed.
#
# Usage: pnpm dev:env        (from the repo root)
#        bash scripts/gen-env.sh [target-path]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$ROOT/.env.example}"

cd "$ROOT"

# Prefer a locally installed tsx; fall back to a one-shot pnpm dlx download.
if pnpm --silent exec tsx --version >/dev/null 2>&1; then
  pnpm exec tsx scripts/gen-env.ts "$TARGET"
else
  pnpm dlx tsx scripts/gen-env.ts "$TARGET"
fi
