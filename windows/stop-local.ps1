[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runDir = Join-Path (Join-Path $env:USERPROFILE '.dpi') 'run'

foreach ($name in @('dpi-hub', 'dpi-backend')) {
  $pidFile = Join-Path $runDir "$name.pid"
  if (-not (Test-Path -LiteralPath $pidFile)) { continue }
  $processId = [int]([IO.File]::ReadAllText($pidFile).Trim())
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -and $process.CommandLine.Contains($repoRoot)) {
    Stop-Process -Id $processId
    Write-Host "Stopped $name (PID $processId)."
  } elseif ($process) {
    Write-Warning "PID $processId no longer belongs to this checkout; it was not stopped."
  }
  Remove-Item -LiteralPath $pidFile -Force
}
