[CmdletBinding()]
param(
  [string]$BackupName,
  [string]$SourceDpiDirectory = (Join-Path $env:USERPROFILE '.dpi'),
  [string]$ScratchRoot,
  [switch]$KeepScratch
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($ScratchRoot)) {
  $workspaceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '..\..\..'))
  $ScratchRoot = Join-Path $workspaceRoot '临时文件'
}
$sourceDpi = [IO.Path]::GetFullPath($SourceDpiDirectory)
$sourceBackups = Join-Path $sourceDpi 'backups'
if (-not (Test-Path -LiteralPath $sourceBackups -PathType Container)) { throw 'Source backup directory does not exist.' }
if ((Get-Item -LiteralPath $sourceBackups -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Source backup directory must not be a reparse point.'
}
if (-not $BackupName) {
  $selected = Get-ChildItem -LiteralPath $sourceBackups -File |
    Where-Object { $_.Name -match '^projects-[0-9TZ.-]+-[a-z0-9-]+\.sqlite$' } |
    Sort-Object @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, @{ Expression = 'Name'; Descending = $true } |
    Select-Object -First 1
  if (-not $selected) { throw 'No project backup is available for a restore drill.' }
  $BackupName = $selected.Name
}
if ($BackupName -notmatch '^projects-[0-9TZ.-]+-[a-z0-9-]+\.sqlite$') { throw 'Invalid backup filename.' }
$sourceBackup = Join-Path $sourceBackups $BackupName
if (-not (Test-Path -LiteralPath $sourceBackup -PathType Leaf)) { throw "Backup not found: $BackupName" }
if ((Get-Item -LiteralPath $sourceBackup -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Source backup must not be a reparse point.'
}

New-Item -ItemType Directory -Path $ScratchRoot -Force | Out-Null
$resolvedScratchRoot = (Resolve-Path -LiteralPath $ScratchRoot).Path
if ((Get-Item -LiteralPath $resolvedScratchRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Scratch root must not be a reparse point.'
}
$scratch = Join-Path $resolvedScratchRoot ("durable-pi-restore-drill-{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($scratch)) -ne $resolvedScratchRoot) { throw 'Scratch directory escaped its root.' }
$targetDpi = Join-Path $scratch 'dpi'
$targetBackups = Join-Path $targetDpi 'backups'
New-Item -ItemType Directory -Path $targetBackups -Force | Out-Null

try {
  Copy-Item -LiteralPath $sourceBackup -Destination (Join-Path $targetBackups $BackupName)
  $sourceFiles = "$sourceBackup.files"
  if (Test-Path -LiteralPath $sourceFiles) {
    if (-not (Test-Path -LiteralPath $sourceFiles -PathType Container)) { throw 'Artifact backup bundle is not a directory.' }
    $unsafe = Get-ChildItem -LiteralPath $sourceFiles -Force -Recurse |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
    if ($unsafe) { throw "Artifact backup bundle contains a reparse point: $($unsafe.FullName)" }
    Copy-Item -LiteralPath $sourceFiles -Destination (Join-Path $targetBackups "$BackupName.files") -Recurse
  }
  & (Join-Path $PSScriptRoot 'restore-project-backup.ps1') -BackupName $BackupName -DpiDirectory $targetDpi | Out-Null
  $verification = & node (Join-Path $PSScriptRoot 'verify-backup-drill.mjs') `
    (Join-Path $targetBackups $BackupName) (Join-Path $targetDpi 'projects.sqlite') (Join-Path $targetDpi 'artifacts')
  if ($LASTEXITCODE -ne 0) { throw 'Restored backup failed logical verification.' }
  $result = $verification | ConvertFrom-Json
  [pscustomobject]@{
    BackupName = $BackupName
    Verified = $result.ok
    Tables = $result.tables
    Rows = $result.rows
    Artifacts = $result.artifacts
    ArtifactBytes = $result.artifactBytes
    Configurations = $result.configurations
    RestoredSha256 = $result.restoredSha256
    ScratchPath = if ($KeepScratch) { $scratch } else { $null }
  } | ConvertTo-Json -Compress
} finally {
  if (-not $KeepScratch -and (Test-Path -LiteralPath $scratch)) {
    $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
    if ([IO.Path]::GetDirectoryName($resolvedScratch) -ne $resolvedScratchRoot) { throw 'Refusing unsafe drill cleanup.' }
    if ((Get-Item -LiteralPath $resolvedScratch -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Refusing to clean a reparse-point drill directory.'
    }
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
  }
}
