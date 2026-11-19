[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.:-]+$')]
  [string]$RemoteTarget,

  [ValidateRange(1024, 65535)]
  [int]$RemotePort = 17897,

  [ValidatePattern('^[A-Za-z0-9.:-]+$')]
  [string]$LocalProxyHost = '127.0.0.1',

  [ValidateRange(1, 65535)]
  [int]$LocalProxyPort = 7897
)

$ErrorActionPreference = 'Continue'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $ssh)) { throw 'Windows OpenSSH client is not installed.' }

$forward = "127.0.0.1:${RemotePort}:${LocalProxyHost}:${LocalProxyPort}"
while ($true) {
  & $ssh -NT `
    -o BatchMode=yes `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 `
    -o ServerAliveCountMax=3 `
    -R $forward `
    $RemoteTarget
  Start-Sleep -Seconds 5
}
