#!/usr/bin/env bash
# apply-engine-patches.sh — the ONLY sanctioned way to put engine-patches/ into the
# local pinned vendor clone. Never hand-edit vendor/** — this script's whole point is
# that every vendor-side change is mechanical, visible in `git status`, and revertible.
#
# What it does:
#   1. Verifies the vendor clone is a git checkout pinned at the ADR-0001 commit
#      (refuses on mismatch — a re-pin requires refreshing the patches first).
#   2. Pre-flights the authored tree against the patch series (NOTHING is copied before
#      every check passes — the vendor tree is never left half-mutated):
#        - every module's main file (engine-patches/<m>/<m>.rs) exists with `pub fn specs()`
#        - every sibling .rs file in a module dir is DECLARED by its parent (a `mod <sib>;`
#          line or a #[path] attribute naming the file) — an undeclared file would sit in
#          the copy as dead code and its commands would be silently unregistered
#        - every sibling that has its own `pub fn specs()` is REGISTERED exactly one of the
#          two sanctioned ways (commands-registry.patch.md § "Submodule specs merges"):
#          chained inside the parent's specs(), or carried as a `v.extend(crate::<m>::<sib>::specs());`
#          line in registration/commands-registry.patch.txt — registration may call e.g.
#          template_cmds::specs() concatenated with fill_specs::specs() (fill/validate,
#          W3-B) and agent_cmds::specs() with document_diff::specs() (W3-G)
#        - every specs() the patch registers exists in the authored tree (the patch never
#          runs ahead of the wave's files)
#        - `git apply --check` (or --check --reverse: already applied) passes at the pin
#   3. Copies every authored file into place (NEW files only):
#        engine-patches/<m>/<m>.rs   -> crates/engine/src/<m>.rs
#        engine-patches/<m>/<sib>.rs  -> crates/engine/src/<m>/<sib>.rs   (Rust 2018 layout)
#   4. Applies the ONE existing-file edit (registry registration) via `git apply`:
#        engine-patches/registration/commands-registry.patch.txt
#   5. Prints the next steps (cargo check + panic_hunt + parity) — it NEVER builds
#      anything itself (dev boxes are starved; CI owns builds).
#
# Usage:
#   engine-patches/scripts/apply-engine-patches.sh [--check]
#     --check   dry run: verify pin + tree/patch coherence + `git apply --check`, change
#               nothing (useful while a parallel wave is still landing files).
#   Env overrides: PHOTOCRAFT_VENDOR_DIR (default: /home/z/my-project/vendor/photocraft)
#
# NOTE: this lives under engine-patches/scripts/ because the repo-level scripts/ dir is
# orchestrator-owned (see engine-patches/README.md).
#
# Undo everything this script did, in the vendor clone:
#   git -C "$PHOTOCRAFT_VENDOR_DIR" apply --reverse <this repo>/engine-patches/registration/commands-registry.patch.txt
#   git -C "$PHOTOCRAFT_VENDOR_DIR" checkout -- crates/engine/src/lib.rs crates/engine/src/commands.rs
#   rm -f  "$PHOTOCRAFT_VENDOR_DIR"/crates/engine/src/{template,component,layout,agent}_cmds.rs
#   rm -rf "$PHOTOCRAFT_VENDOR_DIR"/crates/engine/src/{template,component,layout,agent}_cmds/

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

# The ADR names the pin too; both must agree (a re-pin always touches the two together).
# Missing ADR file = only the built-in pin check applies (still refuses on mismatch).
ADR_PIN=""
if [ -f "$ADR_PIN_FILE" ]; then
  ADR_PIN="$(sed -n 's/.*\([0-9a-f]\{40\}\).*/\1/p' "$ADR_PIN_FILE" | head -n 1 || true)"
fi
if [ -n "$ADR_PIN" ] && [ "$ADR_PIN" != "$EXPECTED_PIN" ]; then
  die "built-in pin $EXPECTED_PIN disagrees with $ADR_PIN_FILE ($ADR_PIN) — update them in the same change"
fi
if [ "$ACTUAL_PIN" != "$EXPECTED_PIN" ]; then
  die "vendor pin mismatch: clone is at $ACTUAL_PIN, patch series targets $EXPECTED_PIN (ADR-0001). Re-pin deliberately (ADR-0001 §4) and refresh the patches — refusing to apply."
fi
info "pin OK: $ACTUAL_PIN (ADR-0001)"

# --- 2. pre-flight: the authored tree vs the patch series (nothing is copied yet) ----------
# Problems are COLLECTED and reported together (--check shows the wave's whole gap, not
# just the first one).
PROBLEMS=()
problem() { PROBLEMS+=("$1"); }

is_module() {
  local m
  for m in "${MODULES[@]}"; do [ "$m" = "$1" ] && return 0; done
  return 1
}

# 2a. every module's main file exists with its specs() — the registration patch
#     references crate::<m>::specs(), so cargo check cannot pass without it.
for m in "${MODULES[@]}"; do
  MAIN="$PATCHES_DIR/$m/$m.rs"
  if [ ! -f "$MAIN" ]; then
    problem "missing engine-patches/$m/$m.rs — the registration patch registers crate::$m::specs(), so the tree cannot compile without it (Wave 3 owns this file)"
  elif ! grep -q "pub fn specs()" "$MAIN"; then
    problem "engine-patches/$m/$m.rs has no \`pub fn specs()\` (§2.3 workspace rule)"
  fi
done

# 2b. sibling files: declared by the parent, and registered if they own commands.
for m in "${MODULES[@]}"; do
  MAIN="$PATCHES_DIR/$m/$m.rs"
  [ -f "$MAIN" ] || continue   # missing main file already reported in 2a
  for f in "$PATCHES_DIR/$m/"*.rs; do
    [ -f "$f" ] || continue    # unmatched glob (no siblings)
    sib="$(basename "$f" .rs)"
    [ "$sib" = "$m" ] && continue
    # declared? plain `mod <sib>;` / `pub mod <sib>;` (Rust 2018 subdirectory) or a
    # #[path] attribute naming the file (component_manifest.rs style).
    if ! grep -Eq "^[[:space:]]*(pub )?mod $sib;" "$MAIN" \
       && ! grep -Eq "#\[path *= *\"[^\"]*/?$sib\.rs\"\]" "$MAIN"; then
      problem "engine-patches/$m/$sib.rs is present but $m.rs never declares it (\`mod $sib;\` or a #[path] attribute) — copied as-is it would be dead code and its commands silently unregistered"
      continue
    fi
    # registered? a sibling with its own specs() must be chained by the parent or
    # carried by the registration patch (added lines only — the patch's comment
    # header mentions the merge lines as documentation).
    if grep -q "^pub fn specs()" "$f" \
       && ! grep -Eq "\b$sib::specs\(\)" "$MAIN" \
       && ! grep -Eq "^\+[[:space:]]*v\.extend\(crate::${m}::${sib}::specs\(\)\);" "$REGISTRATION_PATCH"; then
      problem "engine-patches/$m/$sib.rs has \`pub fn specs()\` but it is registered nowhere: add it to $m.rs's specs() (chain) or as \`v.extend(crate::${m}::${sib}::specs());\` in registration/commands-registry.patch.txt (see commands-registry.patch.md § Submodule specs merges)"
    fi
  done
done

# 2c. the patch never runs ahead of the tree: every added v.extend line must resolve
#     to an authored file (added lines only — ^\+ — not the patch's comment header).
while IFS= read -r owner; do
  case "$owner" in
    *"::"*) mod_name="${owner%%::*}"; sib="${owner##*::}" ;;
    *)      mod_name="$owner";       sib="" ;;
  esac
  if ! is_module "$mod_name"; then
    problem "registration patch registers \`crate::${owner}::specs()\` but '$mod_name' is not one of: ${MODULES[*]}"
    continue
  fi
  if [ ! -f "$PATCHES_DIR/$mod_name/$mod_name.rs" ]; then
    continue   # missing main file already reported in 2a
  fi
  if [ -n "$sib" ] && [ ! -f "$PATCHES_DIR/$mod_name/$sib.rs" ]; then
    problem "registration patch registers \`crate::${mod_name}::${sib}::specs()\` but engine-patches/$mod_name/$sib.rs is missing — the wave that owns that file has not landed yet (commands-registry.patch.md § Submodule specs merges)"
  fi
done < <(grep -E '^\+[[:space:]]*v\.extend\(crate::' "$REGISTRATION_PATCH" \
           | sed -E 's/.*crate::([A-Za-z0-9_:]+)::specs\(\).*/\1/')

# 2d. module coverage: the patch must register every module's parent specs().
for m in "${MODULES[@]}"; do
  if ! grep -Eq "^\+[[:space:]]*v\.extend\(crate::${m}::specs\(\)\);" "$REGISTRATION_PATCH"; then
    problem "registration patch does not register crate::${m}::specs() — every module needs its v.extend line (§2.3)"
  fi
done

# 2e. the patch applies at the pin (or is already applied).
PATCH_STATE="pending"
if git -C "$VENDOR_DIR" apply --check "$REGISTRATION_PATCH" 2>/dev/null; then
  PATCH_STATE="pending"
elif git -C "$VENDOR_DIR" apply --check --reverse "$REGISTRATION_PATCH" 2>/dev/null; then
  PATCH_STATE="applied"
else
  problem "registration patch does not apply at pin $EXPECTED_PIN. Either the vendor tree has stray edits (start from a clean clone) or the patch rotted — fix the patch, never the vendor tree by hand."
fi

if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  echo "apply-engine-patches: refusing — the authored tree and the patch series disagree (${#PROBLEMS[@]} problem(s)):" >&2
  for p in "${PROBLEMS[@]}"; do echo "  - $p" >&2; done
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  (--check: nothing was copied or applied; rerun once the listed files land)" >&2
  else
    echo "  (nothing was copied or applied — the vendor tree is untouched)" >&2
  fi
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "dry run: tree coherent with the patch series; registration patch ${PATCH_STATE} at the pin; all module files present."
  info "dry run: nothing was copied or applied. Full run: pin verified -> copy all .rs files -> git apply."
  cat <<'NEXT'

Next steps (run where the patched clone is — CI job infra/ci-staged/engine-patches.yml, never on a starved dev box):
  engine-patches/scripts/apply-engine-patches.sh          # the real run (copy + apply)
  cargo check -p photocraft-engine
  cargo test -p photocraft-engine --test panic_hunt -- --ignored
  cargo xtask parity   # commit the regenerated docs/parity-checklist.md in the upstream PR (§2.3)

Panic-hunt obligations per command (adversarial params tables): engine-patches/tests/README.md
NEXT
  exit 0
fi

# --- 3. copy every authored file (NEW files only) ----------------------------------------
for m in "${MODULES[@]}"; do
  cp "$PATCHES_DIR/$m/$m.rs" "$VENDOR_DIR/crates/engine/src/$m.rs"
  info "copied: crates/engine/src/$m.rs"
  had_sib=0
  for f in "$PATCHES_DIR/$m/"*.rs; do
    [ -f "$f" ] || continue
    sib="$(basename "$f" .rs)"
    [ "$sib" = "$m" ] && continue
    [ "$had_sib" -eq 0 ] && { mkdir -p "$VENDOR_DIR/crates/engine/src/$m"; had_sib=1; }
    cp "$f" "$VENDOR_DIR/crates/engine/src/$m/$sib.rs"
    info "copied: crates/engine/src/$m/$sib.rs"
  done
done

# --- 4. registration patch (the ONE existing-file edit) -----------------------------------
if [ "$PATCH_STATE" = "pending" ]; then
  git -C "$VENDOR_DIR" apply "$REGISTRATION_PATCH"
  info "applied: registration/commands-registry.patch.txt (lib.rs mod lines + commands.rs v.extend lines)"
else
  info "registration patch is already applied — nothing to do"
fi

# --- 5. next steps (NEVER built here — CI owns cargo) --------------------------------------
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
