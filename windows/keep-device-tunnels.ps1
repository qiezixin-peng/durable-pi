[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.:-]+$')]
  [string]$RemoteTarget
)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'config.ps1')
Import-DurablePiConfig -RepoRoot $repoRoot
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $ssh)) { throw 'Windows OpenSSH client is not installed.' }

# One authenticated SSH connection carries both services. Keeping them on
# loopback at the remote end prevents LAN exposure while avoiding one process
# tree per forwarded port.
$forwards = @(
  "127.0.0.1:$(if ($env:DPI_TUNNEL_REMOTE_SSH_PORT) { [int]$env:DPI_TUNNEL_REMOTE_SSH_PORT } else { 22022 }):127.0.0.1:22",
  "127.0.0.1:$(if ($env:DPI_TUNNEL_REMOTE_T3_PORT) { [int]$env:DPI_TUNNEL_REMOTE_T3_PORT } else { 13773 }):127.0.0.1:$(if ($env:DPI_T3_LOCAL_PORT) { [int]$env:DPI_T3_LOCAL_PORT } else { 3773 })"
)
while ($true) {
  & $ssh -NT `
    -o BatchMode=yes `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 `
    -o ServerAliveCountMax=3 `
    -R $forwards[0] `
    -R $forwards[1] `
    $RemoteTarget
  Start-Sleep -Seconds 5
}
