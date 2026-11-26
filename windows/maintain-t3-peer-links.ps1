[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'config.ps1')
Import-DurablePiConfig -RepoRoot $repoRoot
$runner = Join-Path $PSScriptRoot 'ensure-t3-peer-link.ps1'
$peerNames = @($env:DPI_T3_PEERS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($peerNames.Count -eq 0) { return }
$remotePort = if ($env:DPI_TUNNEL_REMOTE_T3_PORT) { [int]$env:DPI_TUNNEL_REMOTE_T3_PORT } else { 13773 }
$peerAccess = if ($env:DPI_T3_PEER_ACCESS) { $env:DPI_T3_PEER_ACCESS.Trim() } else { 'auto' }
if ($peerAccess -notin @('read-only', 'approval-required', 'auto-accept-edits', 'auto', 'full-access')) {
  throw "Invalid DPI_T3_PEER_ACCESS: $peerAccess"
}
$peers = @($peerNames | ForEach-Object { @{ RemoteTarget = $_; RemotePort = $remotePort } })
$results = foreach ($peer in $peers) {
  & $runner -RemoteTarget $peer.RemoteTarget -RemotePort $peer.RemotePort -Access $peerAccess
}
$results
