[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'config.ps1')
Import-DurablePiConfig -RepoRoot $repoRoot
$dpiRoot = if ($env:DPI_HOME) { [Environment]::ExpandEnvironmentVariables($env:DPI_HOME) } else { Join-Path $env:USERPROFILE '.dpi' }
Import-DurablePiEnvFile -Path (Join-Path $dpiRoot 'backend.env') -Override
$backendPort = if ($env:DPI_PORT) { [int]$env:DPI_PORT } else { 4780 }
$hubPort = if ($env:DPI_HUB_PORT) { [int]$env:DPI_HUB_PORT } else { 4781 }

$services = @(
  @{ Name = 'Backend'; Url = "http://127.0.0.1:$backendPort/healthz" },
  @{ Name = 'Project hub'; Url = "http://127.0.0.1:$hubPort/api/network" }
)
foreach ($service in $services) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $service.Url -TimeoutSec 2
    Write-Host "$($service.Name): online ($($response.StatusCode))" -ForegroundColor Green
  } catch {
    Write-Host "$($service.Name): offline" -ForegroundColor Yellow
  }
}
