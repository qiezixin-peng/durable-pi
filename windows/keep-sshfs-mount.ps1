[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$HostAlias,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z_][A-Za-z0-9._-]*$')]
  [string]$RemoteUser,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z]$')]
  [string]$DriveLetter,

  [Parameter(Mandatory = $true)]
  [ValidateLength(1, 32)]
  [string]$VolumeName
)

$ErrorActionPreference = 'Continue'
$launcher = 'C:\Program Files\SSHFS-Win\bin\sshfs-win.exe'
if (-not (Test-Path -LiteralPath $launcher)) { throw 'SSHFS-Win is not installed.' }

$drive = $DriveLetter.ToUpperInvariant() + ':'
$prefix = "\sshfs.k\${RemoteUser}@${HostAlias}"
$localUser = "$env:USERDOMAIN+$env:USERNAME"

while ($true) {
  if (-not (Test-Path -LiteralPath ($drive + '\'))) {
    & $launcher svc $prefix $drive $localUser `
      '-o' 'ro' `
      '-o' 'reconnect' `
      '-o' 'ServerAliveInterval=15' `
      '-o' 'ServerAliveCountMax=3' `
      '-o' "volname=$VolumeName"
  }
  Start-Sleep -Seconds 10
}
