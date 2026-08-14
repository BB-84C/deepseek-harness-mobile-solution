# repair-session.ps1 — cross-platform wrapper for scripts/repair-session.cjs
# Usage: .\repair-session.ps1 check [path]
#        .\repair-session.ps1 repair [--dry-run] <session.jsonl.zstd>
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$core = Join-Path $scriptDir 'repair-session.cjs'
& node $core @Args
exit $LASTEXITCODE
