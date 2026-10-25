#!/usr/bin/env bash
# git-sync.sh — the ONLY sanctioned way to commit/push in this repo.
# Serializes all git mutations with a global flock so dozens of concurrent agents
# never collide on the index. Pulls (--rebase) ALWAYS before pushing so GitHub wins.
# Usage: scripts/git-sync.sh "W1-A: what you did"
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
MSG="${1:-sync}"
BRANCH=main
LOCK="$PWD/.studio-git.lock"

exec 9>"$LOCK"
if ! flock -w 900 9; then
  echo "git-sync: timed out waiting for the global git lock"
  exit 1
fi

# Stage + commit if there is anything to commit
if ! ( git diff --quiet && git diff --cached --quiet \
       && [ -z "$(git ls-files --others --exclude-standard)" ] ); then
  git add -A
  git commit -m "$MSG" >/dev/null 2>&1 || true
fi

# Always reconcile with remote, then push (with retries + jitter)
for i in 1 2 3 4 5 6; do
  if git pull --rebase origin "$BRANCH" >/dev/null 2>&1; then
    if git push origin "$BRANCH" >/dev/null 2>&1; then
      echo "git-sync: OK"
      exit 0
    fi
  else
    git rebase --abort >/dev/null 2>&1 || true
  fi
  sleep $(( (RANDOM % 8) + 2 ))
done

echo "git-sync: FAILED after retries (your commit is safe locally — report it)"
exit 1
