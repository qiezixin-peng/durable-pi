[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.:-]+$')]
  [string]$RemoteTarget,

  [string]$TaskName = 'DurablePi-Remote-OpenAI-Tunnel',

  [ValidateRange(1024, 65535)]
  [int]$RemotePort = 17897,

  [ValidateRange(1, 65535)]
  [int]$LocalProxyPort = 7897
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'keep-remote-proxy-tunnel.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "Tunnel runner is missing: $runner" }

$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "--headless `"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -RemoteTarget `"$RemoteTarget`" -RemotePort $RemotePort -LocalProxyPort $LocalProxyPort"
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Keeps an authenticated SSH reverse tunnel from a Durable Pi remote device to a selected local service.' `
  -Force | Out-Null

Write-Output $TaskName
