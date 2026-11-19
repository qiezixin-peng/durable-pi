[CmdletBinding()]
param(
  [string]$StartDirectory,
  [ValidateSet('faux', 'openrouter')]
  [string]$Provider,
  [ValidateSet('127.0.0.1', '0.0.0.0')]
  [string]$HubHost,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'config.ps1')
Import-DurablePiConfig -RepoRoot $repoRoot
if (-not $StartDirectory) { $StartDirectory = if ($env:DPI_WORKSPACE_ROOT) { $env:DPI_WORKSPACE_ROOT } else { Join-Path $env:USERPROFILE 'dpi-work' } }
if (-not $Provider) { $Provider = if ($env:DPI_PROVIDER) { $env:DPI_PROVIDER } else { 'faux' } }
if (-not $HubHost) { $HubHost = if ($env:DPI_HUB_HOST) { $env:DPI_HUB_HOST } else { '127.0.0.1' } }
$dpiRoot = if ($env:DPI_HOME) { [Environment]::ExpandEnvironmentVariables($env:DPI_HOME) } else { Join-Path $env:USERPROFILE '.dpi' }
$backendEnv = Join-Path $dpiRoot 'backend.env'
$networkFile = if ($env:DPI_NETWORK_FILE) { [Environment]::ExpandEnvironmentVariables($env:DPI_NETWORK_FILE) } else { Join-Path $repoRoot 'dpi-network.yaml' }
$backendHost = if ($env:DPI_HOST) { $env:DPI_HOST } else { '127.0.0.1' }
$backendPort = if ($env:DPI_PORT) { [int]$env:DPI_PORT } else { 4780 }
$hubPort = if ($env:DPI_HUB_PORT) { [int]$env:DPI_HUB_PORT } else { 4781 }
$t3Runtime = if ($env:DPI_T3_RUNTIME) { $env:DPI_T3_RUNTIME } else { '1' }
$workerProvider = if ($env:DPI_T3_WORKER_PROVIDER_INSTANCE) { $env:DPI_T3_WORKER_PROVIDER_INSTANCE } else { 'codex_durable_worker' }
$coordinatorProvider = if ($env:DPI_T3_COORDINATOR_PROVIDER_INSTANCE) { $env:DPI_T3_COORDINATOR_PROVIDER_INSTANCE } else { 'codex_durable_coordinator' }

function New-DpiToken {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) }
  finally { $generator.Dispose() }
  $encoded = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  return "dpi_$encoded"
}

function Read-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line.StartsWith("$Name=")) { return $line.Substring($Name.Length + 1) }
  }
  return $null
}

$nodeVersion = (& node --version).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 22) { throw 'Node.js 22.19 or newer is required.' }

New-Item -ItemType Directory -Path $dpiRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dpiRoot 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dpiRoot 'run') -Force | Out-Null
New-Item -ItemType Directory -Path $StartDirectory -Force | Out-Null

$token = Read-EnvValue $backendEnv 'DPI_TOKEN'
if (-not $token) { $token = New-DpiToken }
$hubToken = Read-EnvValue $backendEnv 'DPI_HUB_TOKEN'
if (-not $hubToken) { $hubToken = New-DpiToken }
$deviceName = if ($env:DPI_DEVICE_NAME) { $env:DPI_DEVICE_NAME } else { $env:COMPUTERNAME.ToLowerInvariant() }
$startPath = [IO.Path]::GetFullPath($StartDirectory)
$envLines = @(
  "DPI_TOKEN=$token",
  "DPI_HUB_DEVICE_TOKEN=$token",
  "DPI_DEVICE_NAME=$deviceName",
  "DPI_PORT=$backendPort",
  "DPI_HOST=$backendHost",
  "DPI_HUB_HOST=$HubHost",
  "DPI_HUB_PORT=$hubPort",
  "DPI_START_DIRS=$startPath",
  "DPI_PROVIDER=$Provider",
  "DPI_HUB_URL=http://127.0.0.1:$hubPort",
  "DPI_HUB_TOKEN=$hubToken",
  "DPI_T3_RUNTIME=$t3Runtime",
  "DPI_T3_WORKSPACE_BASE=$startPath",
  "DPI_T3_WORKER_PROVIDER_INSTANCE=$workerProvider",
  "DPI_T3_COORDINATOR_PROVIDER_INSTANCE=$coordinatorProvider",
  "DPI_NETWORK_DEVICE_ID=$(if ($env:DPI_NETWORK_DEVICE_ID) { $env:DPI_NETWORK_DEVICE_ID } else { 'local' })"
)
foreach ($name in @('DPI_DATA_ROOT_MAPPINGS_JSON','DPI_T3_WAITING_INTERVAL_MS','DPI_T3_PROJECT_INTERVAL_MS','DPI_T3_ENVIRONMENT_INTERVAL_MS')) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($value) { $envLines += "$name=$value" }
}
if ($Provider -eq 'openrouter') {
  $openRouterKey = $env:OPENROUTER_API_KEY
  if (-not $openRouterKey) { $openRouterKey = Read-EnvValue $backendEnv 'OPENROUTER_API_KEY' }
  if (-not $openRouterKey) { throw 'Set OPENROUTER_API_KEY before configuring the openrouter provider.' }
  $envLines += "OPENROUTER_API_KEY=$openRouterKey"
}
[IO.File]::WriteAllLines($backendEnv, $envLines, [Text.UTF8Encoding]::new($false))

$yamlPath = $startPath.Replace('\', '/')
$yaml = @"
defaults:
  port: $backendPort
  start_dirs: ['$yamlPath']

devices:
  local:
    name: $deviceName
    kind: local
    token_env: DPI_LOCAL_TOKEN
"@
[IO.File]::WriteAllText($networkFile, $yaml, [Text.UTF8Encoding]::new($false))

if (-not $SkipInstall) {
  foreach ($relative in @('apps\dpi-sdk', 'apps\dpi-backend', 'apps\dpi-playground')) {
    Push-Location (Join-Path $repoRoot $relative)
    try { & npm ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $relative" } }
    finally { Pop-Location }
  }
}

Push-Location (Join-Path $repoRoot 'apps\dpi-playground')
try { & npm run build; if ($LASTEXITCODE -ne 0) { throw 'Web hub build failed.' } }
finally { Pop-Location }

& (Join-Path $PSScriptRoot 'configure-codex-durable-mcp.ps1') -RuntimeRoot $repoRoot | Out-Null

& (Join-Path $PSScriptRoot 'install-local-autostart.ps1') | Out-Null

Write-Host ''
Write-Host 'Windows local setup complete.' -ForegroundColor Green
Write-Host "Device: $deviceName"
Write-Host "Workspace root: $startPath"
Write-Host "Provider: $Provider"
Write-Host 'Start with: .\windows\start-local.ps1'
Write-Host 'Automatic startup and five-minute health recovery: DurablePi-Local-Platform'
if ($Provider -eq 'faux') {
  Write-Host 'The faux provider is a safe deterministic test model. Configure OpenRouter before real work.' -ForegroundColor Yellow
}
