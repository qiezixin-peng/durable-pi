[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'config.ps1')
Import-DurablePiConfig -RepoRoot $repoRoot
$dpiRoot = if ($env:DPI_HOME) { [Environment]::ExpandEnvironmentVariables($env:DPI_HOME) } else { Join-Path $env:USERPROFILE '.dpi' }
$backendEnv = Join-Path $dpiRoot 'backend.env'
Import-DurablePiEnvFile -Path $backendEnv -Override
$backendPort = if ($env:DPI_PORT) { [int]$env:DPI_PORT } else { 4780 }
$hubPort = if ($env:DPI_HUB_PORT) { [int]$env:DPI_HUB_PORT } else { 4781 }
$backendHealth = "http://127.0.0.1:$backendPort/healthz"
$hubHealth = "http://127.0.0.1:$hubPort/api/network"
$logDir = Join-Path $dpiRoot 'logs'
$ensureLog = Join-Path $logDir 'dpi-ensure.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Write-EnsureLog([string]$Message) {
  $line = '{0:o} {1}' -f [DateTimeOffset]::Now, $Message
  Add-Content -LiteralPath $ensureLog -Value $line -Encoding utf8
}

function Test-DpiEndpoint([string]$Url) {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$backendHealthy = Test-DpiEndpoint $backendHealth
$hubHealthy = Test-DpiEndpoint $hubHealth
if ($backendHealthy -and $hubHealthy) { exit 0 }

Write-EnsureLog "Recovery started (backend=$backendHealthy hub=$hubHealthy)."
try {
  & (Join-Path $PSScriptRoot 'stop-local.ps1') *>> $ensureLog
  & (Join-Path $PSScriptRoot 'start-local.ps1') -NoOpen *>> $ensureLog
  if (-not (Test-DpiEndpoint $backendHealth) -or -not (Test-DpiEndpoint $hubHealth)) {
    throw 'Durable Pi services are still unhealthy after restart.'
  }
  Write-EnsureLog 'Recovery completed.'
} catch {
  Write-EnsureLog "Recovery failed: $($_.Exception.Message)"
  throw
}
