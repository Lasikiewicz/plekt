$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path ${env:ProgramFiles} "nodejs\node.exe"
$logPath = Join-Path $repoRoot "data\local-server.log"

if (-not (Test-Path -LiteralPath $nodePath)) {
  throw "Node.js was not found at $nodePath"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
Set-Location -LiteralPath $repoRoot

$env:PORT = "5056"
$env:PLEKT_DEV_NO_CACHE_ASSETS = "1"

& $nodePath (Join-Path $repoRoot "scripts\start-local.js") *>> $logPath
exit $LASTEXITCODE
