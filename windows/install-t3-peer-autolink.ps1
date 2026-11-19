[CmdletBinding()]
param(
  [string]$TaskName = 'DurablePi-T3-Peer-AutoLink',
  [ValidateRange(5, 1440)] [int]$CheckIntervalMinutes = 30
)

$ErrorActionPreference = 'Stop'
$maintainer = (Resolve-Path (Join-Path $PSScriptRoot 'maintain-t3-peer-links.ps1')).Path
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "--headless `"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$maintainer`""
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$healthTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes $CheckIntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger, $healthTrigger) `
  -Settings $settings -Principal $principal `
  -Description 'Keeps trusted T3 peer links alive without manual addresses or pairing codes.' -Force | Out-Null
Write-Output $TaskName
