#!/usr/bin/env bash
# scripts/ci-local.sh — the ENTIRE CI pipeline on your own machine, zero
# GitHub involvement (the self-hosted companion to .github/workflows/ci.yml;
# runner policy 2026-10-31: no billed GitHub-hosted machines, ever).
#
# Mirrors the workflow jobs 1:1 (same commands, same env, same gates):
#   web            next typegen → tsc → biome lint → vitest → next build
#   gateway        tsc → vitest (Postgres when available, else sqlite twin —
#                  the 89 pg-only suites self-skip with a notice, same as CI)
#   worker         tsc → vitest (render integration self-skips: no PG/CLI)
#   packages       tsc --noEmit for all packages/*
#   bundle-drift   rebuild api/gateway.mjs + git diff gate + sqlite smoke
#                  (the SEC-01 recurrence gate)
#   licences       check:licenses
#   editor-cargo   cargo check --release -p studio-cli (SKIP with notice if
#                  no rust toolchain; fonts provisioned sha256-verified)
#   e2e            full-stack Playwright chromium — OPT-IN via --e2e
#
# Usage:
#   bash scripts/ci-local.sh                # all blocking gates
#   bash scripts/ci-local.sh --e2e          # also the e2e suite
#   bash scripts/ci-local.sh --only web     # one gate (comma-list ok)
#   bash scripts/ci-local.sh --list         # gate names, exit 0
#   bash scripts/ci-local.sh --no-install   # trust node_modules as-is
#
# Exit code: 0 iff every non-skipped gate passed; 2 if usage error.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

GATES_ORDER=(web gateway worker packages bundle-drift licences editor-cargo e2e)
RUN_E2E=false
ONLY=""
NO_INSTALL=false

say()  { printf '%s\n' "$*"; }
hdr()  { printf '\n\033[1;36m── %s ──────────────────────────────────────────\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
bad()  { printf '\033[1;31m✘ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --e2e) RUN_E2E=true ;;
    --list) printf '%s\n' "${GATES_ORDER[@]}"; exit 0 ;;
    --only) shift; [ $# -gt 0 ] || { say "--only needs a gate name"; exit 2; }; ONLY="$1" ;;
    --no-install) NO_INSTALL=true ;;
    *) say "unknown flag: $1 (see header)"; exit 2 ;;
  esac
  shift
done

# ── common prelude ───────────────────────────────────────────────────────────
PNPM() { corepack pnpm "$@"; }

hdr "install (frozen lockfile)"
if [ "$NO_INSTALL" = true ]; then
  warn "skipped (--no-install) — trusting node_modules as-is"
else
  PNPM install --frozen-lockfile || { bad "install failed"; exit 1; }
fi

hdr "web fonts (next/font/local binaries — sha256-pinned fetch)"
if PNPM fonts:web; then ok "fonts ready"; else bad "fonts:web failed (next build cannot compile layout.tsx without them)"; exit 1; fi

# ── gate: web ────────────────────────────────────────────────────────────────
gate_web() {
  hdr "gate: web — typegen · tsc · lint · test · build"
  export APP_ENV=local
  PNPM --filter @studio/web exec next typegen || return 1
  PNPM --filter @studio/web typecheck || return 1
  PNPM --filter @studio/web lint || return 1
  PNPM --filter @studio/web test || return 1
  PNPM --filter @studio/web build || return 1
}

# ── gate: gateway ────────────────────────────────────────────────────────────
# Postgres preference order: an exported DATABASE_URL → the repo's native
# dev-postgres.sh → a throwaway docker container → the sqlite twin (pg-only
# suites self-skip, exactly like the CI job without its service container).
gate_gateway() {
  hdr "gate: gateway — tsc · vitest"
  local db_url="" started_docker=""
  if [ -n "${DATABASE_URL:-}" ]; then
    db_url="$DATABASE_URL"
    say "using exported DATABASE_URL"
  elif bash scripts/dev-postgres.sh status >/dev/null 2>&1; then
    db_url="postgres://studio:studio@127.0.0.1:5432/studio"
    say "using the repo dev-postgres (scripts/dev-postgres.sh)"
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    say "starting a throwaway postgres:16 (docker) for this gate"
    if docker run -d --rm --name studio-ci-pg -p 5432:5432 \
        -e POSTGRES_USER=studio -e POSTGRES_PASSWORD=studio -e POSTGRES_DB=studio \
        postgres:16 >/dev/null 2>&1; then
      started_docker=studio-ci-pg
      db_url="postgres://studio:studio@127.0.0.1:5432/studio"
      for _ in $(seq 1 30); do
        docker exec studio-ci-pg pg_isready -U studio >/dev/null 2>&1 && break
        sleep 1
      done
    fi
  fi
  if [ -z "$db_url" ]; then
    db_url="file:$REPO/.local/ci-gateway.db"
    warn "no Postgres found — running on the sqlite twin; the 89 pg-only suites self-skip (documented CI behavior)"
  fi
  DATABASE_URL="$db_url" MOCK_MODEL=true PNPM db:migrate || return 1
  DATABASE_URL="$db_url" MOCK_MODEL=true PNPM --filter @studio/gateway typecheck || return 1
  DATABASE_URL="$db_url" MOCK_MODEL=true PNPM --filter @studio/gateway test
  local rc=$?
  [ -n "$started_docker" ] && docker stop "$started_docker" >/dev/null 2>&1
  return $rc
}

# ── gate: worker ─────────────────────────────────────────────────────────────
gate_worker() {
  hdr "gate: worker — tsc · vitest"
  PNPM --filter @studio/worker typecheck || return 1
  PNPM --filter @studio/worker test || return 1
}

# ── gate: packages ───────────────────────────────────────────────────────────
gate_packages() {
  hdr "gate: packages/* — tsc --noEmit (all 7)"
  PNPM -r --filter './packages/*' exec tsc --noEmit || return 1
}

# ── gate: bundle-drift (SEC-01 recurrence gate) ─────────────────────────────
gate_bundle_drift() {
  hdr "gate: gateway bundle — rebuild == committed (SEC-01 gate)"
  PNPM --filter @studio/web bundle:gateway || return 1
  if ! git diff --exit-code -- apps/web/api/gateway.mjs; then
    bad "apps/web/api/gateway.mjs is STALE — the committed bundle does not match a rebuild of the committed source. Run: corepack pnpm --filter @studio/web bundle:gateway  (then commit the result)."
    return 1
  fi
  APP_URL=http://localhost:3000 \
  APP_ENV=local \
  DATABASE_URL=file:/tmp/ci-gateway-bundle-smoke.db \
  ASSET_MAX_BYTES=10485760 \
  PROJECT_MAX_BYTES=20971520 \
  STRIPE_WEBHOOK_SECRET=whsec_test_not_configured \
  STRIPE_PRICE_IDS='{"starter":"price_test","pro":"price_test","studio":"price_test"}' \
  AUTH_SECRET=test-secret-test-secret-test-secret-32 \
  AUTH_GOOGLE_ID=disabled \
  AUTH_GOOGLE_SECRET=disabled \
  AUTH_GITHUB_ID=disabled \
  AUTH_GITHUB_SECRET=disabled \
  LITELLM_BASE_URL=http://127.0.0.1:4000 \
  LITELLM_API_KEY=sk-test-not-configured \
  CHAT_MAX_STEPS=20 \
    PNPM exec node scripts/gateway-bundle-smoke.mjs || return 1
}

# ── gate: licences ───────────────────────────────────────────────────────────
gate_licences() {
  hdr "gate: licences — check:licenses"
  PNPM check:licenses || return 1
}

# ── gate: editor-cargo ───────────────────────────────────────────────────────
# Same font provisioning as the CI job: the vendored pin ships NO font
# binaries (licence gate), but studio-text include_bytes!s them at compile
# time — fetch the exact upstream-pinned bytes, sha256-verified.
gate_editor_cargo() {
  hdr "gate: editor — cargo check --release -p studio-cli"
  if ! command -v cargo >/dev/null 2>&1; then
    warn "SKIP — no rust toolchain on this machine (install via rustup; the CI job runs this gate on a runner that has one)"
    return 3
  fi
  local fonts_dir="apps/editor/assets/fonts"
  if [ ! -f "$fonts_dir/Inter-Regular.ttf" ]; then
    mkdir -p "$fonts_dir" && cd "$fonts_dir"
    local base="https://raw.githubusercontent.com/storytold/effectcraft/9db7f3b21700fd821f215782ed1c82afe077880f/assets/fonts"
    while read -r sum name; do
      printf '%s  %s\n' "$sum" "$name" >> SHA256SUMS
      curl -fsSL --retry 3 --max-time 60 -o "$name" "$base/$name" || { cd "$REPO"; return 1; }
    done <<'FONTS'
40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82  Inter-Regular.ttf
97ad806f526e41546d46365bb3a393145f75b7b1568913db74549ad8b8dba872  Inter-Medium.ttf
78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3  Inter-SemiBold.ttf
288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f  Inter-Bold.ttf
bbc051dd204b5019a1aa0bc0ae2aa8a05ab13e7a3f979fa357631dc7feb6833a  Inter-Italic.ttf
e6fd0d7e91550b3ed2b735d4312474362c4716edc4fc0577a0f61ed782d5aed1  JetBrainsMono-Regular.ttf
a15cfbbc1539d707115111d672d590a3d70d4f74b4c0a315956da20ae19a14e1  NotoSerif-Regular.ttf
FONTS
    sha256sum -c SHA256SUMS || { cd "$REPO"; return 1; }
    cd "$REPO"
  fi
  (cd apps/editor && cargo check --release -p studio-cli)
}

# ── gate: e2e (opt-in) ───────────────────────────────────────────────────────
gate_e2e() {
  hdr "gate: e2e — Playwright chromium (full stack boot)"
  say "this boots postgres + gateway + next dev through the Playwright webServer; see apps/web/e2e/README.md"
  if ! command -v psql >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
    warn "e2e needs PostgreSQL (native or docker) — SKIP"
    return 3
  fi
  if ! bash scripts/dev-postgres.sh status >/dev/null 2>&1; then
    say "starting dev postgres…"
    bash scripts/dev-postgres.sh start || return 1
  fi
  local rc=0
  ( set -a
    [ -f .env ] || cp .env.example .env
    . ./.env
    set +a
    export DATABASE_URL="postgres://studio:studio@127.0.0.1:5432/studio" \
           APP_URL=http://127.0.0.1:3100 \
           NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 \
           APP_ENV=local MOCK_MODEL=true \
           GATEWAY_INTERNAL_URL=http://127.0.0.1:8787 \
           AUTH_SECRET="ci-local-secret-ci-local-secret-ci-local"
    PNPM db:migrate && PNPM db:seed && \
    PNPM --filter @studio/web exec playwright install --with-deps chromium && \
    PNPM --filter @studio/web exec playwright test ) || rc=1
  return $rc
}

# ── dispatch ─────────────────────────────────────────────────────────────────
SELECTED=()
for g in "${GATES_ORDER[@]}"; do
  if [ "$g" = e2e ] && [ "$RUN_E2E" != true ] && [ -z "$ONLY" ]; then continue; fi
  [ -n "$ONLY" ] && case ",$ONLY," in *",$g,"*) ;; *) continue ;; esac
  SELECTED+=("$g")
done

declare -A RESULTS
OVERALL=0
for g in "${SELECTED[@]}"; do
  t0=$SECONDS
  "gate_${g//-/_}"
  rc=$?
  dt=$((SECONDS - t0))
  if [ $rc -eq 0 ]; then RESULTS[$g]="PASS (${dt}s)"; ok "$g PASS (${dt}s)"
  elif [ $rc -eq 3 ]; then RESULTS[$g]="SKIP"; warn "$g SKIP"
  else RESULTS[$g]="FAIL (${dt}s)"; bad "$g FAIL (${dt}s)"; OVERALL=1; fi
done

hdr "summary"
for g in "${SELECTED[@]}"; do printf '  %-13s %s\n' "$g" "${RESULTS[$g]}"; done
if [ $OVERALL -eq 0 ]; then ok "ci-local: all gates green"; else bad "ci-local: failures above"; fi
exit $OVERALL
