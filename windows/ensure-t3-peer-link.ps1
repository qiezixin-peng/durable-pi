[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$RemoteTarget,

  [ValidateRange(1024, 65535)]
  [int]$RemotePort = 13773,

  [ValidateSet('read-only', 'approval-required', 'auto-accept-edits', 'auto', 'full-access')]
  [string]$Access = 'approval-required',

  [ValidateRange(1, 30)]
  [int]$RenewBeforeDays = 7
)

$ErrorActionPreference = 'Stop'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $ssh)) { throw 'Windows OpenSSH client is not installed.' }
if (-not (Get-Command t3 -ErrorAction SilentlyContinue)) { throw 'T3 CLI is not installed.' }

$endpoint = "http://127.0.0.1:$RemotePort"
$sshArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', $RemoteTarget)

function Invoke-RemoteT3([string]$Arguments) {
  $command = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; t3 ' + $Arguments
  $output = & $ssh @sshArgs $command 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Remote T3 command failed on ${RemoteTarget}: $($output -join ' ')" }
  return ($output -join "`n")
}

$local = Invoke-RestMethod -Uri 'http://127.0.0.1:3773/.well-known/t3/environment' -TimeoutSec 5
$linksText = Invoke-RemoteT3 'environment list --json'
$links = @($linksText | ConvertFrom-Json)
$existing = $links | Where-Object environmentId -eq $local.environmentId | Select-Object -First 1
$renewAfter = [DateTimeOffset]::Now.AddDays($RenewBeforeDays)
if ($existing -and $existing.status -eq 'reachable' -and
    [DateTimeOffset]::Parse($existing.expiresAt) -gt $renewAfter) {
  [pscustomobject]@{ changed = $false; remote = $RemoteTarget; environmentId = $local.environmentId; status = 'reachable' }
  exit 0
}

if ($existing) {
  [void](Invoke-RemoteT3 "environment unlink $($local.environmentId)")
}

$pairOutput = & t3 pair --ttl 10m --label "Durable Pi $RemoteTarget" 2>&1
if ($LASTEXITCODE -ne 0) { throw "Failed to create a T3 pairing token: $($pairOutput -join ' ')" }
$pairText = $pairOutput -join "`n"
$match = [regex]::Match($pairText, '(?m)^Token:\s+([A-Z0-9]+)\s*$')
if (-not $match.Success) { throw 'T3 did not return a pairing token in the expected format.' }
$token = $match.Groups[1].Value
try {
  [void](Invoke-RemoteT3 "environment link $endpoint --pairing-code $token --access $Access")
} finally {
  $token = $null
}

$verified = @((Invoke-RemoteT3 'environment list --json') | ConvertFrom-Json) |
  Where-Object environmentId -eq $local.environmentId | Select-Object -First 1
if (-not $verified -or $verified.status -ne 'reachable') {
  throw "T3 peer link was created but is not reachable from $RemoteTarget."
}
[pscustomobject]@{ changed = $true; remote = $RemoteTarget; environmentId = $local.environmentId; status = 'reachable' }
