[CmdletBinding()]
param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'config.ps1')
Import-DurablePiConfig -RepoRoot $repoRoot
$dpiRoot = if ($env:DPI_HOME) { [Environment]::ExpandEnvironmentVariables($env:DPI_HOME) } else { Join-Path $env:USERPROFILE '.dpi' }
$backendEnv = Join-Path $dpiRoot 'backend.env'
$runDir = Join-Path $dpiRoot 'run'
$logDir = Join-Path $dpiRoot 'logs'

if (-not (Test-Path -LiteralPath $backendEnv)) {
  throw 'Run .\windows\setup.ps1 first.'
}
Import-DurablePiEnvFile -Path $backendEnv -Override
$networkFile = if ($env:DPI_NETWORK_FILE) { [Environment]::ExpandEnvironmentVariables($env:DPI_NETWORK_FILE) } else { Join-Path $repoRoot 'dpi-network.yaml' }

New-Item -ItemType Directory -Path $runDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$globalInstructions = Join-Path $repoRoot 'scripts\configure-codex-global-instructions.mjs'
if (Test-Path -LiteralPath $globalInstructions) {
  & node $globalInstructions *>> (Join-Path $logDir 'codex-global-instructions.log')
}

# T3 currently drops the entire folder listing when one immediate child has a
# whitespace-only/control-character name. Preserve and rename only those
# unrepresentable entries before the local runtime is recovered.
$browseRepair = Join-Path $repoRoot 'scripts\repair-t3-browse-names.mjs'
if (Test-Path -LiteralPath $browseRepair) {
  $repairRoots = @('--repair', '--root', $env:USERPROFILE)
  foreach ($candidate in @((Join-Path $env:USERPROFILE 'DurablePiProjects'), $repoRoot)) {
    if (Test-Path -LiteralPath $candidate -PathType Container) { $repairRoots += @('--root', $candidate) }
  }
  & node $browseRepair @repairRoots *>> (Join-Path $logDir 't3-browse-name-check.log')
  if ($LASTEXITCODE -ne 0) {
    Add-Content -LiteralPath (Join-Path $logDir 't3-browse-name-check.log') -Value 'Browse-name compatibility check failed; platform startup continues.'
  }
}

# The Windows workstation is the control plane. Non-Coordinator write-capable Agents run through
# T3 under a dedicated Codex provider; read-only work stays on the isolated direct Codex path.
if ([string]::IsNullOrWhiteSpace($env:DPI_T3_RUNTIME)) { $env:DPI_T3_RUNTIME = '1' }
if ([string]::IsNullOrWhiteSpace($env:DPI_T3_WORKER_PROVIDER_INSTANCE)) {
  $env:DPI_T3_WORKER_PROVIDER_INSTANCE = 'codex_durable_worker'
}
if ([string]::IsNullOrWhiteSpace($env:DPI_T3_COORDINATOR_PROVIDER_INSTANCE)) {
  $env:DPI_T3_COORDINATOR_PROVIDER_INSTANCE = 'codex_durable_coordinator'
}
if ($env:DPI_T3_RUNTIME -eq '1') {
  $mcpBundle = Join-Path $repoRoot 'apps\dpi-playground\dist\mcp\main.mjs'
  if (Test-Path -LiteralPath $mcpBundle) {
    & (Join-Path $PSScriptRoot 'configure-codex-durable-mcp.ps1') -RuntimeRoot $repoRoot | Out-Null
  }
  if (-not (Get-Command t3 -ErrorAction SilentlyContinue)) {
    throw 'T3 Code CLI is required while DPI_T3_RUNTIME=1.'
  }
  $providerChanged = & (Join-Path $PSScriptRoot 'configure-t3-worker-provider.ps1') `
    -WorkerInstanceId $env:DPI_T3_WORKER_PROVIDER_INSTANCE `
    -CoordinatorInstanceId $env:DPI_T3_COORDINATOR_PROVIDER_INSTANCE `
    -WorkspaceBaseDirectory $(if ($env:DPI_T3_WORKSPACE_BASE) { $env:DPI_T3_WORKSPACE_BASE } else { $env:DPI_START_DIRS })
  if ($providerChanged -eq $true) {
    & t3 service restart | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'T3 service restart failed after configuring the worker Provider.' }
  }
}
$env:DPI_HOME = $dpiRoot
$env:DPI_ENV_FILE = $backendEnv
$env:DPI_NETWORK_FILE = $networkFile
$env:DPI_LOCAL_TOKEN = $env:DPI_TOKEN

function Test-Endpoint([string]$Url, [int]$Attempts = 80) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Start-DpiProcess(
  [string]$Name,
  [string]$WorkingDirectory,
  [string[]]$Arguments,
  [string]$HealthUrl
) {
  $pidFile = Join-Path $runDir "$Name.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $oldPid = [int]([IO.File]::ReadAllText($pidFile).Trim())
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
      if (Test-Endpoint $HealthUrl 2) { return $oldPid }
      throw "$Name has a running process but is not healthy (PID $oldPid)."
    }
  }
  $stdout = Join-Path $logDir "$Name.log"
  $stderr = Join-Path $logDir "$Name-error.log"
  $process = Start-Process -FilePath (Get-Command node).Source -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
    -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($pidFile, [string]$process.Id)
  if (-not (Test-Endpoint $HealthUrl)) {
    $tail = if (Test-Path -LiteralPath $stderr) { [IO.File]::ReadAllText($stderr) } else { '' }
    throw "$Name did not become healthy. $tail"
  }
  return $process.Id
}

$backendDir = Join-Path $repoRoot 'apps\dpi-backend'
$hubDir = Join-Path $repoRoot 'apps\dpi-playground'
$backendEntry = Join-Path $backendDir 'src\main.ts'
$hubEntry = Join-Path $hubDir 'apps\dpi-playground-hub\src\main.ts'
$backendPort = if ($env:DPI_PORT) { [int]$env:DPI_PORT } else { 4780 }
$hubPort = if ($env:DPI_HUB_PORT) { [int]$env:DPI_HUB_PORT } else { 4781 }
$backendUrl = "http://127.0.0.1:$backendPort"
$hubUrl = "http://127.0.0.1:$hubPort"
$backendPid = Start-DpiProcess 'dpi-backend' $backendDir @('--disable-warning=ExperimentalWarning', '--import', 'tsx', ('"{0}"' -f $backendEntry)) "$backendUrl/healthz"
$hubPid = Start-DpiProcess 'dpi-hub' $hubDir @('--disable-warning=ExperimentalWarning', '--import', 'tsx', ('"{0}"' -f $hubEntry)) "$hubUrl/api/network"

Write-Host "Backend ready (PID $backendPid): $backendUrl" -ForegroundColor Green
Write-Host "Project hub ready (PID $hubPid): $hubUrl" -ForegroundColor Green
if (-not $NoOpen) { Start-Process $hubUrl }
