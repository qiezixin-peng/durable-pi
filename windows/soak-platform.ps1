[CmdletBinding()]
param(
  [ValidateRange(10, 604800)][int]$DurationSeconds = 3600,
  [ValidateRange(2, 60)][int]$IntervalSeconds = 15,
  [switch]$RequireRemoteLinks
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$database = Join-Path $env:USERPROFILE '.dpi\projects.sqlite'
$startedAt = [DateTimeOffset]::UtcNow
$deadline = $startedAt.AddSeconds($DurationSeconds)
$samples = 0
$maxLatencyMs = 0.0
$reachableLinkMinimum = [int]::MaxValue
$projectMinimum = [int]::MaxValue

function Invoke-Probe([string]$Url) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $result = Invoke-RestMethod -Uri $Url -TimeoutSec 10
  $watch.Stop()
  $script:maxLatencyMs = [Math]::Max($script:maxLatencyMs, $watch.Elapsed.TotalMilliseconds)
  return $result
}

if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
  throw "Live project database is missing: $database"
}
Push-Location $repo
try {
  & node 'windows\verify-sqlite.mjs' $database | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Initial SQLite integrity check failed' }
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $backend = Invoke-Probe 'http://127.0.0.1:4780/healthz'
    $network = Invoke-Probe 'http://127.0.0.1:4781/api/network'
    $projects = Invoke-Probe 'http://127.0.0.1:4781/api/projects'
    $environments = Invoke-Probe 'http://127.0.0.1:4781/api/t3/environments'
    if ($backend.ok -ne $true) { throw 'Backend health response is not ok' }
    if ($null -eq $network.devices) { throw 'Hub network response is malformed' }
    if ($null -eq $projects.projects) { throw 'Hub projects response is malformed' }
    if ($environments.available -ne $true -or $environments.linksEnabled -ne $true) {
      throw 'T3 environment discovery is unavailable'
    }
    $reachable = @($environments.links | Where-Object { $_.status -eq 'reachable' }).Count
    if ($RequireRemoteLinks -and $reachable -lt 2) { throw "Only $reachable remote T3 link(s) are reachable" }
    $reachableLinkMinimum = [Math]::Min($reachableLinkMinimum, $reachable)
    $projectMinimum = [Math]::Min($projectMinimum, @($projects.projects).Count)
    $samples += 1
    $remaining = ($deadline - [DateTimeOffset]::UtcNow).TotalSeconds
    if ($remaining -gt 0) { Start-Sleep -Seconds ([Math]::Min($IntervalSeconds, [Math]::Ceiling($remaining))) }
  }
  & node 'windows\verify-sqlite.mjs' $database | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Final SQLite integrity check failed' }
  [pscustomobject]@{
    Ok = $true
    StartedAt = $startedAt.ToString('o')
    CompletedAt = [DateTimeOffset]::UtcNow.ToString('o')
    DurationSeconds = $DurationSeconds
    Samples = $samples
    MaxHttpLatencyMs = [Math]::Round($maxLatencyMs, 2)
    MinimumReachableRemoteLinks = if ($reachableLinkMinimum -eq [int]::MaxValue) { 0 } else { $reachableLinkMinimum }
    MinimumProjectCount = if ($projectMinimum -eq [int]::MaxValue) { 0 } else { $projectMinimum }
  } | ConvertTo-Json -Compress
} finally {
  Pop-Location
}
