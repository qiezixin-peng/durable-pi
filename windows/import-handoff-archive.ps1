[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [string]$ChecksumPath,

  [string]$BundleName,

  [string]$TargetProjectId,

  [string]$HubUrl = 'http://127.0.0.1:4781'
)

$ErrorActionPreference = 'Stop'
$archive = [IO.Path]::GetFullPath($ArchivePath)
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Archive is missing: $archive" }
if (-not $archive.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive must be a .zip file.' }

$checksum = if ($ChecksumPath) { [IO.Path]::GetFullPath($ChecksumPath) } else { "$archive.sha256" }
if (-not (Test-Path -LiteralPath $checksum -PathType Leaf)) { throw "Checksum file is missing: $checksum" }
$declaration = (Get-Content -Raw -LiteralPath $checksum).Trim()
$escapedName = [Regex]::Escape([IO.Path]::GetFileName($archive))
$match = [Regex]::Match($declaration, "^([a-fA-F0-9]{64})  $escapedName$")
if (-not $match.Success) { throw 'Checksum file has an invalid format or archive filename.' }
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $match.Groups[1].Value.ToLowerInvariant()) { throw 'Archive SHA-256 mismatch.' }

if (-not $BundleName) { $BundleName = [IO.Path]::GetFileNameWithoutExtension($archive) }
if ($BundleName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$') { throw 'BundleName is invalid.' }
if ($TargetProjectId -and $TargetProjectId -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { throw 'TargetProjectId is invalid.' }

$inbox = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.dpi\handoff-inbox'))
[IO.Directory]::CreateDirectory($inbox) | Out-Null
$target = [IO.Path]::GetFullPath((Join-Path $inbox $BundleName))
if ([IO.Path]::GetDirectoryName($target) -ne $inbox) { throw 'Bundle target escaped the handoff inbox.' }
if (Test-Path -LiteralPath $target) { throw "Inbox bundle already exists: $target" }
$staging = [IO.Path]::GetFullPath((Join-Path $inbox ".$BundleName.importing-$([Guid]::NewGuid().ToString('N'))"))
if ([IO.Path]::GetDirectoryName($staging) -ne $inbox) { throw 'Staging target escaped the handoff inbox.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$totalBytes = [int64]0
$hasManifest = $false
$hasManifestHash = $false
try {
  if ($zip.Entries.Count -gt 10002) { throw 'Archive contains too many entries.' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if (-not $name -or $name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':')) {
      throw "Unsafe ZIP entry: $name"
    }
    $segments = @($name.Split('/') | Where-Object { $_ })
    if ($segments.Count -eq 0 -or $segments -contains '..' -or $segments -contains '.') {
      throw "Unsafe ZIP entry: $name"
    }
    if (-not $seen.Add($name.TrimEnd('/'))) { throw "Duplicate ZIP entry: $name" }
    $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
    if ($unixType -eq 0xA000) { throw "Symbolic links are not allowed in handoff archives: $name" }
    $totalBytes += [int64]$entry.Length
    if ($totalBytes -gt 536870912) { throw 'Expanded archive exceeds the 512 MiB limit.' }
    if ($name -eq 'manifest.json') { $hasManifest = $true }
    if ($name -eq 'manifest.sha256') { $hasManifestHash = $true }
  }
  if (-not $hasManifest -or -not $hasManifestHash) { throw 'Archive is missing root manifest.json or manifest.sha256.' }

  [IO.Directory]::CreateDirectory($staging) | Out-Null
  foreach ($entry in $zip.Entries) {
    $destination = [IO.Path]::GetFullPath((Join-Path $staging $entry.FullName))
    $stagingPrefix = $staging + [IO.Path]::DirectorySeparatorChar
    if (-not $destination.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "ZIP entry escaped staging: $($entry.FullName)"
    }
    if ($entry.FullName.EndsWith('/')) {
      [IO.Directory]::CreateDirectory($destination) | Out-Null
      continue
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
  }
} catch {
  $zip.Dispose()
  if (Test-Path -LiteralPath $staging -PathType Container) {
    [IO.Directory]::Delete($staging, $true)
  }
  throw
} finally {
  $zip.Dispose()
}

[IO.Directory]::Move($staging, $target)
$api = $HubUrl.TrimEnd('/') + '/api/handoffs/import'
$body = @{ bundleName = $BundleName }
if ($TargetProjectId) { $body.targetProjectId = $TargetProjectId }
try {
  $result = Invoke-RestMethod -Method Post -Uri $api -ContentType 'application/json' -Body ($body | ConvertTo-Json)
  [pscustomobject]@{
    BundleName = $BundleName
    InboxDirectory = $target
    ArchiveSha256 = $actualHash
    ExpandedBytes = $totalBytes
    Project = $result.project
    MemoriesImported = $result.memoriesImported
    ArtifactsImported = $result.artifactsImported
    ManifestSha256 = $result.manifestSha256
  }
} catch {
  Write-Warning "The verified bundle remains at $target for inspection or retry."
  throw
}
