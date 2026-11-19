[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')]
  [string]$ProjectId,

  [string]$HandoffId,

  [Parameter(Mandatory = $true)]
  [string]$DestinationDirectory,

  [string]$HubUrl = 'http://127.0.0.1:4781'
)

$ErrorActionPreference = 'Stop'
$api = $HubUrl.TrimEnd('/') + '/api'
$handoffs = @( (Invoke-RestMethod -Method Get -Uri "$api/projects/$ProjectId/handoffs").handoffs )
if (-not $handoffs.Count) { throw "Project $ProjectId has no handoff bundles." }

if ($HandoffId) {
  $handoff = $handoffs | Where-Object id -eq $HandoffId | Select-Object -First 1
  if (-not $handoff) { throw "Handoff $HandoffId was not found in project $ProjectId." }
} else {
  $handoff = $handoffs | Sort-Object createdAt -Descending | Select-Object -First 1
}

$validation = Invoke-RestMethod -Method Post -Uri "$api/projects/$ProjectId/handoffs/$($handoff.id)/validate" -ContentType 'application/json' -Body '{}'
if (-not $validation.valid) { throw "Handoff $($handoff.id) did not pass validation." }

$source = [IO.Path]::GetFullPath([string]$handoff.directory)
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Handoff directory is missing: $source" }
$destination = [IO.Path]::GetFullPath($DestinationDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null

$archiveName = "$ProjectId-$($handoff.id).zip"
$archivePath = Join-Path $destination $archiveName
$checksumPath = "$archivePath.sha256"
$partialPath = "$archivePath.partial.zip"
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $checksumPath)) {
  throw "Export already exists: $archivePath"
}

$archiveCreated = $false
try {
  Compress-Archive -Path (Join-Path $source '*') -DestinationPath $partialPath -CompressionLevel Optimal
  Move-Item -LiteralPath $partialPath -Destination $archivePath
  $archiveCreated = $true
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumBytes = [Text.Encoding]::ASCII.GetBytes("$hash  $archiveName")
  $checksumStream = [IO.File]::Open($checksumPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $checksumStream.Write($checksumBytes, 0, $checksumBytes.Length) } finally { $checksumStream.Dispose() }
  [pscustomobject]@{
    ProjectId = $ProjectId
    HandoffId = $handoff.id
    Archive = $archivePath
    Checksum = $checksumPath
    Sha256 = $hash
    Bytes = (Get-Item -LiteralPath $archivePath).Length
    ManifestSha256 = $validation.manifestSha256
    ArtifactCount = $validation.artifactCount
  }
} catch {
  if (Test-Path -LiteralPath $partialPath -PathType Leaf) { Remove-Item -LiteralPath $partialPath -Force }
  if (Test-Path -LiteralPath $checksumPath -PathType Leaf) { Remove-Item -LiteralPath $checksumPath -Force }
  if ($archiveCreated -and (Test-Path -LiteralPath $archivePath -PathType Leaf)) { Remove-Item -LiteralPath $archivePath -Force }
  throw
}
