#!/usr/bin/env bash
# apply-engine-patches.sh — the ONLY sanctioned way to put engine-patches/ into the
# local pinned vendor clone. Never hand-edit vendor/** — this script's whole point is
# that every vendor-side change is mechanical, visible in `git status`, and revertible.
#
# What it does:
#   1. Verifies the vendor clone is a git checkout pinned at the ADR-0001 commit
#      (refuses on mismatch — a re-pin requires refreshing the patches first).
#   2. Copies each authored module into place (NEW files only):
#        engine-patches/<module>/<module>.rs -> crates/engine/src/<module>.rs
#   3. Applies the ONE existing-file edit (registry registration) via
#      `git apply --check` then `git apply`:
#        engine-patches/registration/commands-registry.patch.txt
#   4. Prints the next steps (cargo check + panic_hunt) — it NEVER builds anything
#      itself (dev boxes are starved; CI owns builds).
#
# Usage:
#   engine-patches/scripts/apply-engine-patches.sh [--check]
#     --check   dry run: verify pin + module files + `git apply --check`, change nothing.
#   Env overrides: PHOTOCRAFT_VENDOR_DIR (default: /home/z/my-project/vendor/photocraft)
#
# NOTE: this lives under engine-patches/scripts/ because the repo-level scripts/ dir is
# orchestrator-owned (see engine-patches/README.md).
#
# Undo everything this script did, in the vendor clone:
#   git -C "$PHOTOCRAFT_VENDOR_DIR" apply --reverse <this repo>/engine-patches/registration/commands-registry.patch.txt
#   git -C "$PHOTOCRAFT_VENDOR_DIR" checkout -- crates/engine/src/lib.rs crates/engine/src/commands.rs
#   rm -f "$PHOTOCRAFT_VENDOR_DIR"/crates/engine/src/{template,component,layout,agent}_cmds.rs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCHES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"                     # engine-patches/
REPO_ROOT="$(cd "$PATCHES_DIR/.." && pwd)"                      # studio repo root
VENDOR_DIR="${PHOTOCRAFT_VENDOR_DIR:-/home/z/my-project/vendor/photocraft}"
ADR_PIN_FILE="$REPO_ROOT/docs/adr/0001-editor-pin.md"
REGISTRATION_PATCH="$PATCHES_DIR/registration/commands-registry.patch.txt"

# The pin this patch series is authored against (ADR-0001). Kept in sync with the ADR;
# the script cross-checks both and refuses if they disagree so a re-pin always touches
# the two together.
EXPECTED_PIN="872748fb5b2a53e09dd4e385e31968d985c0515b"

MODULES=(template_cmds component_cmds layout_cmds agent_cmds)

DRY_RUN=0
[ "${1:-}" = "--check" ] && DRY_RUN=1

die() { echo "apply-engine-patches: ERROR: $*" >&2; exit 1; }
info() { echo "apply-engine-patches: $*"; }

[ -f "$REGISTRATION_PATCH" ] || die "registration patch not found: $REGISTRATION_PATCH"

# --- 1. pin policy (ADR-0001) ------------------------------------------------------------
[ -d "$VENDOR_DIR/.git" ] || [ "$(git -C "$VENDOR_DIR" rev-parse --git-dir 2>/dev/null)" ] \
  || die "$VENDOR_DIR is not a git checkout (§16.1: pinned clone, never a folder snapshot)"

ACTUAL_PIN="$(git -C "$VENDOR_DIR" rev-parse HEAD)" || die "cannot read HEAD of $VENDOR_DIR"

ADR_PIN="$(sed -n 's/.*\([0-9a-f]\{40\}\).*/\1/p' "$ADR_PIN_FILE" | head -n 1 || true)"
if [ -n "$ADR_PIN" ] && [ "$ADR_PIN" != "$EXPECTED_PIN" ]; then
  die "built-in pin $EXPECTED_PIN disagrees with $ADR_PIN_FILE ($ADR_PIN) — update them in the same change"
fi
if [ "$ACTUAL_PIN" != "$EXPECTED_PIN" ]; then
  die "vendor pin mismatch: clone is at $ACTUAL_PIN, patch series targets $EXPECTED_PIN (ADR-0001). Re-pin deliberately (ADR-0001 §4) and refresh the patches — refusing to apply."
fi
info "pin OK: $ACTUAL_PIN (ADR-0001)"

# --- 2. module files exist and copy cleanly (NEW files only) ------------------------------
for m in "${MODULES[@]}"; do
  SRC="$PATCHES_DIR/$m/$m.rs"
  [ -f "$SRC" ] || die "missing engine-patches/$m/$m.rs (Wave 3 owns this file)"
  grep -q "pub fn specs()" "$SRC" || die "engine-patches/$m/$m.rs has no \`pub fn specs()\` (§2.3 workspace rule)"
done
if [ "$DRY_RUN" -eq 1 ]; then
  info "dry run: all module files present, registration patch check follows"
fi

if [ "$DRY_RUN" -eq 0 ]; then
  for m in "${MODULES[@]}"; do
    SRC="$PATCHES_DIR/$m/$m.rs"
    DST="$VENDOR_DIR/crates/engine/src/$m.rs"
    cp "$SRC" "$DST"
    info "copied: crates/engine/src/$m.rs"
  done
fi

# --- 3. registration patch (the ONE existing-file edit) -----------------------------------
if git -C "$VENDOR_DIR" apply --check "$REGISTRATION_PATCH" 2>/dev/null; then
  if [ "$DRY_RUN" -eq 0 ]; then
    git -C "$VENDOR_DIR" apply "$REGISTRATION_PATCH"
    info "applied: registration/commands-registry.patch.txt (lib.rs mod lines + commands.rs v.extend lines)"
  else
    info "dry run: registration patch would apply cleanly"
  fi
elif git -C "$VENDOR_DIR" apply --check --reverse "$REGISTRATION_PATCH" 2>/dev/null; then
  info "registration patch is already applied — nothing to do"
else
  die "registration patch does not apply at pin $EXPECTED_PIN. Either the vendor tree has stray edits (start from a clean clone) or the patch rotted — fix the patch, never the vendor tree by hand."
fi

# --- 4. next steps (NEVER built here — CI owns cargo) --------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  info "dry run complete: pin verified, files in place, patch applies. No changes were made."
  exit 0
fi

info "done. vendor-side diff (git -C $VENDOR_DIR status --porcelain):"
git -C "$VENDOR_DIR" status --porcelain || true

cat <<'NEXT'

Next steps (run where the patched clone is — CI job infra/ci-staged/engine-patches.yml, never on a starved dev box):
  cargo check -p photocraft-engine
  cargo test -p photocraft-engine --test panic_hunt -- --ignored
  cargo xtask parity   # commit the regenerated docs/parity-checklist.md in the upstream PR (§2.3)

Panic-hunt obligations per command (adversarial params tables): engine-patches/tests/README.md
Revert: see the header comment of this script.
NEXT
