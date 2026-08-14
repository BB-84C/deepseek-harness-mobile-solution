#!/usr/bin/env sh
# dsh-mobile installer wrapper (macOS / Linux)
# One-command install of the dsh mobile plugins into the mobile + web profiles.
# Idempotent; safe to re-run after a git pull.
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

command -v node >/dev/null 2>&1 || { echo "node (>= 22) is required but was not found on PATH." >&2; exit 1; }

# 1. repo workspace dependencies (commander / dsh-cmdline), so the junction-
#    linked plugin packages can resolve their imports by walking up.
if [ ! -d "$REPO_ROOT/node_modules/commander" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --dir "$REPO_ROOT"
  else
    echo "warning: pnpm not found — install pnpm first or run 'pnpm install' in the repo root manually" >&2
  fi
fi

# 2. install the plugins into both profiles
exec node "$REPO_ROOT/scripts/install-mobile.mjs" "$@"
