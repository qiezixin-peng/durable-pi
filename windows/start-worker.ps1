[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dpiRoot = Join-Path $env:USERPROFILE '.dpi'
$backendEnv = Join-Path $dpiRoot 'backend.env'
$runDir = Join-Path $dpiRoot 'run'
$logDir = Join-Path $dpiRoot 'logs'
$pidFile = Join-Path $runDir 'dpi-worker.pid'

if (-not (Test-Path -LiteralPath $backendEnv)) { throw 'Run setup-worker.ps1 first.' }
foreach ($line in [IO.File]::ReadAllLines($backendEnv)) {
  if (-not $line -or $line.StartsWith('#')) { continue }
  $split = $line.IndexOf('=')
  if ($split -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $split), $line.Substring($split + 1), 'Process') }
}
$env:DPI_HOME = $dpiRoot
$env:DPI_ENV_FILE = $backendEnv

if (Test-Path -LiteralPath $pidFile) {
  $oldPid = [int]([IO.File]::ReadAllText($pidFile).Trim())
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { throw "Worker already running (PID $oldPid)." }
}
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$entry = Join-Path $repoRoot 'apps\dpi-backend\src\main.ts'
$process = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--import', 'tsx', ('"{0}"' -f $entry)) `
  -WorkingDirectory (Join-Path $repoRoot 'apps\dpi-backend') `
  -RedirectStandardOutput (Join-Path $logDir 'dpi-worker.log') `
  -RedirectStandardError (Join-Path $logDir 'dpi-worker-error.log') `
  -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText($pidFile, [string]$process.Id)

for ($attempt = 0; $attempt -lt 80; $attempt++) {
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($env:DPI_PORT)/healthz" -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
      Write-Host "Worker ready (PID $($process.Id), device $($env:DPI_NETWORK_DEVICE_ID))." -ForegroundColor Green
      exit 0
    }
  } catch {}
  Start-Sleep -Milliseconds 250
}
throw "Worker did not become healthy. See $logDir."
