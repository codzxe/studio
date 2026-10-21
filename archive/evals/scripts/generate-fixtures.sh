#!/usr/bin/env bash
# generate-fixtures.sh — regenerate the synthetic eval fixture PNGs.
# Thin wrapper over evals/fixtures/generator (see its README.md for the spec
# convention, provenance rules and the 50 KB commit cap).
#
# Usage: evals/scripts/generate-fixtures.sh [templates…] [flags]
#        pass-through to generate-assets.mjs (e.g. `instagram-post`, `--out DIR`)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/../fixtures/generator/src/generate-assets.mjs" "$@"
