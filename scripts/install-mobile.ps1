# dsh-mobile installer wrapper (Windows PowerShell)
# One-command install of the dsh mobile plugins into the mobile + web profiles.
# Idempotent; safe to re-run after a git pull.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node (>= 22) is required but was not found on PATH."
    exit 1
}

# 1. repo workspace dependencies (commander / dsh-cmdline), so the junction-
#    linked plugin packages can resolve their imports by walking up.
if (-not (Test-Path (Join-Path $RepoRoot "node_modules\commander"))) {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        & pnpm install --dir $RepoRoot
    } else {
        Write-Warning "pnpm not found — install pnpm first (`npm i -g pnpm`) or run `pnpm install` in the repo root manually."
    }
}

# 2. install the plugins into both profiles
& node (Join-Path $RepoRoot "scripts\install-mobile.mjs")
exit $LASTEXITCODE
