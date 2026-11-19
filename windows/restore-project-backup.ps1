[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupName,
  [string]$DpiDirectory = (Join-Path $env:USERPROFILE '.dpi')
)

$ErrorActionPreference = 'Stop'
if ($BackupName -notmatch '^projects-[0-9TZ.-]+-[a-z0-9-]+\.sqlite$') {
  throw 'BackupName must be a filename returned by the Hub backup list.'
}

$dpiDir = [IO.Path]::GetFullPath($DpiDirectory)
$backupDir = Join-Path $dpiDir 'backups'
$target = Join-Path $dpiDir 'projects.sqlite'
$backup = Join-Path $backupDir $BackupName
$verify = Join-Path $PSScriptRoot 'verify-sqlite.mjs'
$restoreArtifacts = Join-Path $PSScriptRoot 'restore-backup-artifacts.mjs'

$liveDpiDir = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.dpi'))
if ($dpiDir -eq $liveDpiDir) {
  foreach ($url in @('http://127.0.0.1:4780/healthz', 'http://127.0.0.1:4781/api/network')) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 | Out-Null
      throw 'Stop the local platform before restoring: .\windows\stop-local.ps1'
    } catch {
      if ($_.Exception.Message -like 'Stop the local platform*') { throw }
    }
  }
}

if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Backup not found: $BackupName" }
$resolvedDir = (Resolve-Path -LiteralPath $backupDir).Path
$resolvedBackup = (Resolve-Path -LiteralPath $backup).Path
if ([IO.Path]::GetDirectoryName($resolvedBackup) -ne $resolvedDir) { throw 'Backup escaped the backup directory.' }
if ((Get-Item -LiteralPath $resolvedDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup directory must not be a reparse point.' }
if ((Get-Item -LiteralPath $resolvedBackup -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup file must not be a reparse point.' }

& node $verify $resolvedBackup | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Selected backup failed SQLite verification.' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$safety = Join-Path $resolvedDir "projects-before-restore-$stamp.sqlite"
if (Test-Path -LiteralPath $target -PathType Leaf) {
  Copy-Item -LiteralPath $target -Destination $safety
  & node $verify $safety | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Safety copy failed SQLite verification.' }
}

$temporary = Join-Path $dpiDir 'projects.sqlite.restore.tmp'
Copy-Item -LiteralPath $resolvedBackup -Destination $temporary -Force
Move-Item -LiteralPath $temporary -Destination $target -Force
foreach ($sidecar in @("$target-wal", "$target-shm")) {
  if (Test-Path -LiteralPath $sidecar -PathType Leaf) { Remove-Item -LiteralPath $sidecar -Force }
}
& node $verify $target | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Restored database failed SQLite verification.' }

$artifactBundle = "$resolvedBackup.files"
$artifactSafety = Join-Path $resolvedDir "artifacts-before-restore-$stamp"
try {
  $artifactResult = & node $restoreArtifacts $target $artifactBundle $dpiDir $artifactSafety
  if ($LASTEXITCODE -ne 0) { throw 'Artifact restore failed.' }
} catch {
  if (Test-Path -LiteralPath $safety -PathType Leaf) {
    Copy-Item -LiteralPath $safety -Destination $target -Force
    & node $verify $target | Out-Null
  }
  throw
}

Write-Host "Restored: $BackupName" -ForegroundColor Green
if ($artifactResult) { Write-Host "Artifacts: $artifactResult" }
if (Test-Path -LiteralPath $safety) { Write-Host "Previous database preserved as: $safety" }
Write-Host 'Start the platform with .\windows\start-local.ps1'
