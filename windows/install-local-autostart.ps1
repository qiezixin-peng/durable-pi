[CmdletBinding()]
param(
  [string]$TaskName = 'DurablePi-Local-Platform',
  [ValidateRange(1, 60)] [int]$CheckIntervalMinutes = 5
)

$ErrorActionPreference = 'Stop'
$runner = (Resolve-Path (Join-Path $PSScriptRoot 'ensure-local.ps1')).Path
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "--headless `"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$healthTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ([DateTime]::Now.AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes $CheckIntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($logonTrigger, $healthTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Description 'Starts and health-checks the local Durable Pi backend and T3 project hub.' `
  -Force `
  -ErrorAction Stop | Out-Null

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  throw "Scheduled task $TaskName was not registered."
}

Write-Output $TaskName
