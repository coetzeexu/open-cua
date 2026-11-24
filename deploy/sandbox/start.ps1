param(
  [string]$Endpoint = $env:CUA_BROWSER_CDP_URL,
  [string]$BrowserProfile = '/tmp/agentbay_browser',
  [string]$Config = $env:CUA_CONFIG
)
$ErrorActionPreference = 'Stop'
$CuaRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$NodePath = Join-Path $CuaRoot 'runtime/node.exe'
if (-not (Test-Path $NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$env:CUA_BROWSER_CDP_URL = $Endpoint
$env:CUA_BROWSER_PROFILE = $BrowserProfile
$env:CUA_CONFIG = $Config
Set-Location $CuaRoot
& $NodePath (Join-Path $PSScriptRoot 'start.mjs')
exit $LASTEXITCODE
