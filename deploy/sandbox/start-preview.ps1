param(
  [string]$Endpoint = $env:CUA_BROWSER_CDP_URL,
  [string]$BrowserProfile = '/tmp/agentbay_browser',
  [int]$Port = 30150,
  [string]$ListenHost = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
$CuaRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$NodePath = Join-Path $CuaRoot 'runtime/node.exe'
if (-not (Test-Path $NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$env:CUA_BROWSER_CDP_URL = $Endpoint
$env:CUA_BROWSER_PROFILE = $BrowserProfile
$env:CUA_PREVIEW_HOST = $ListenHost
$env:CUA_PREVIEW_PORT = [string]$Port
Set-Location $CuaRoot
& $NodePath (Join-Path $PSScriptRoot 'preview.mjs')
exit $LASTEXITCODE
