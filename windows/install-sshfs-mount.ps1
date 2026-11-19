[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$HostAlias,
  [Parameter(Mandatory = $true)] [string]$RemoteUser,
  [Parameter(Mandatory = $true)] [ValidatePattern('^[A-Za-z]$')] [string]$DriveLetter,
  [Parameter(Mandatory = $true)] [string]$VolumeName,
  [string]$TaskName = "DurablePi-SSHFS-$($DriveLetter.ToUpperInvariant())"
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'keep-sshfs-mount.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "Mount runner is missing: $runner" }

$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -HostAlias `"$HostAlias`" -RemoteUser `"$RemoteUser`" -DriveLetter `"$DriveLetter`" -VolumeName `"$VolumeName`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
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
  -Description "Keeps the read-only Durable Pi SSHFS drive $($DriveLetter.ToUpperInvariant()): connected." `
  -Force | Out-Null

Write-Output $TaskName
