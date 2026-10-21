#!/usr/bin/env bash
# render-goldens.sh — dry-run the §21 render-similarity golden pipeline (STUB).
# Skips gracefully (exit 0) while no render-faithful engine is available —
# see evals/fixtures/generator/README.md ("Golden renders") for the TODO.
#
# Usage: evals/scripts/render-goldens.sh [templates…] [flags]
#        pass-through to render-golden.mjs (e.g. `--engine PATH`, `--write`)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/../fixtures/generator/src/render-golden.mjs" "$@"
