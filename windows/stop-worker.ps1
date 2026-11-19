[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidFile = Join-Path $env:USERPROFILE '.dpi\run\dpi-worker.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'Worker is not running.'; exit 0 }
$workerPid = [int]([IO.File]::ReadAllText($pidFile).Trim())
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" -ErrorAction SilentlyContinue
if (-not $process) { Write-Host 'Worker is not running.'; exit 0 }
if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains($repoRoot)) {
  throw "PID $workerPid is not this checkout's worker; refusing to stop it."
}
Stop-Process -Id $workerPid
Write-Host "Worker stopped (PID $workerPid)." -ForegroundColor Green
