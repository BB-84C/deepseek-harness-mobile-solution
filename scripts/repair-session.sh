#!/usr/bin/env sh
# repair-session.sh — cross-platform wrapper for scripts/repair-session.cjs
# Usage: ./repair-session.sh check [path]
#        ./repair-session.sh repair [--dry-run] <session.jsonl.zstd>
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/repair-session.cjs" "$@"
