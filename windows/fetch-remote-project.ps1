[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^return-plan-[a-f0-9]{40}$')][string]$PlanId,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')][string]$ProjectId,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')][string]$SourceId,
  [Parameter(Mandatory)][string]$Repository,
  [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9._-]{0,63}$')][string]$ProjectSlug,
  [string]$HubUrl = 'http://127.0.0.1:4781'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (Resolve-Path -LiteralPath $Repository).Path
if ((Get-Item -LiteralPath $repositoryRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Repository must not be a reparse point.'
}
$gitRoot = (& git -C $repositoryRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($repositoryRoot)) {
  throw 'Repository must be the Git top-level directory.'
}

$api = $HubUrl.TrimEnd('/')
$plan = Invoke-RestMethod -Method Get -Uri "$api/api/projects/$ProjectId/returns/plans/$PlanId"
if (-not $plan -or $plan.status -notin @('PLANNED', 'READY')) { throw "Return plan $PlanId is not executable." }
if ([string]$plan.sourceId -ne $SourceId -or
    [IO.Path]::GetFullPath([string]$plan.repository) -ne [IO.Path]::GetFullPath($repositoryRoot) -or
    [string]$plan.projectSlug -ne $ProjectSlug) {
  throw 'Return command parameters do not match the frozen plan.'
}

$catalogPath = Join-Path $env:USERPROFILE '.dpi\data-sources.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$source = $catalog.sources | Where-Object id -eq $SourceId | Select-Object -First 1
if (-not $source -or -not $source.sshHost -or -not $source.remoteRoot -or -not $source.environmentId) {
  throw "Data source $SourceId is not a remote T3 execution target."
}
if ($source.projectIds -notcontains $ProjectId) { throw "Data source $SourceId is not bound to project $ProjectId." }
if ([string]$source.sshHost -notmatch '^[A-Za-z0-9._-]+$') { throw 'SSH host alias is unsafe.' }
if ([string]$source.remoteRoot -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'Remote root contains unsupported characters.' }
$expectedTarget = ([string]$source.remoteRoot).TrimEnd('/') + "/DurablePiProjects/$ProjectSlug"
if ([string]$plan.remoteTarget -ne $expectedTarget) { throw 'Return plan target does not match the bound data source.' }

$stagingRoot = Join-Path $env:USERPROFILE '.dpi\return-staging'
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
$bundleName = 'return-' + [guid]::NewGuid().ToString('N') + '.bundle'
$bundlePath = Join-Path $stagingRoot $bundleName
$tempRef = 'refs/dpi/inbox/' + $PlanId.Substring('return-plan-'.Length)
$finalRef = "refs/dpi/remotes/$SourceId/$ProjectSlug"
$remoteInbox = ([string]$source.remoteRoot).TrimEnd('/') + '/.dpi/relay-inbox'
$remoteHelper = "$remoteInbox/create-project-return.py"
$remoteBundle = "$remoteInbox/$bundleName"
try {
  $helper = Join-Path $repoRoot 'unix\create-project-return.py'
  & ssh -o BatchMode=yes -o ConnectTimeout=10 ([string]$source.sshHost) "mkdir -p '$remoteInbox' && chmod 700 '$remoteInbox'"
  if ($LASTEXITCODE -ne 0) { throw 'Remote return inbox creation failed.' }
  & scp -q -o BatchMode=yes -o ConnectTimeout=10 -- $helper (([string]$source.sshHost) + ':' + $remoteHelper)
  if ($LASTEXITCODE -ne 0) { throw 'Return helper upload failed.' }
  $payloadJson = @{ root = [string]$source.remoteRoot; slug = $ProjectSlug; bundleName = $bundleName } | ConvertTo-Json -Compress
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $output = & ssh -o BatchMode=yes -o ConnectTimeout=10 ([string]$source.sshHost) python3 $remoteHelper $payload
  if ($LASTEXITCODE -ne 0) { throw 'Remote return bundle creation failed.' }
  $remote = $output | Select-Object -Last 1 | ConvertFrom-Json
  if ([string]$remote.target -ne $expectedTarget) { throw 'Remote helper returned an unexpected target.' }
  & scp -q -o BatchMode=yes -o ConnectTimeout=10 -- (([string]$source.sshHost) + ':' + $remoteBundle) $bundlePath
  if ($LASTEXITCODE -ne 0) { throw 'Return bundle download failed.' }
  $bundleSha256 = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($bundleSha256 -ne [string]$remote.bundleSha256) { throw 'Return bundle checksum mismatch.' }
  & git -C $repositoryRoot bundle verify $bundlePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Return Git bundle verification failed.' }
  $branch = [string]$remote.branch
  & git -C $repositoryRoot check-ref-format --branch $branch | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Remote branch name is invalid.' }
  & git -C $repositoryRoot fetch --no-tags $bundlePath "refs/heads/${branch}:$tempRef" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Return bundle fetch failed.' }
  $revision = (& git -C $repositoryRoot rev-parse $tempRef).Trim()
  if ($revision -ne [string]$remote.revision) { throw 'Fetched return revision does not match the remote result.' }
  $oldOutput = & git -C $repositoryRoot rev-parse --verify $finalRef 2>$null
  $oldExitCode = $LASTEXITCODE
  $oldRevision = if ($oldOutput) { ([string]$oldOutput).Trim() } else { '' }
  if ($oldExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($oldRevision) -and $oldRevision -ne $revision) {
    & git -C $repositoryRoot merge-base --is-ancestor $oldRevision $revision
    if ($LASTEXITCODE -ne 0) { throw 'Remote return history diverged or moved backwards; the managed ref was not updated.' }
    & git -C $repositoryRoot update-ref $finalRef $revision $oldRevision
  } elseif ($oldRevision -eq $revision) {
    # Idempotent replay: the managed ref already names this exact revision.
  } else {
    $objectFormat = (& git -C $repositoryRoot rev-parse --show-object-format).Trim()
    $zero = if ($objectFormat -eq 'sha256') { '0' * 64 } else { '0' * 40 }
    & git -C $repositoryRoot update-ref $finalRef $revision $zero
  }
  if ($LASTEXITCODE -ne 0) { throw 'Managed return ref update failed.' }
  $receiptBody = @{
    planId = $PlanId
    sourceId = $SourceId
    environmentId = [string]$source.environmentId
    remoteTarget = [string]$remote.target
    localRef = $finalRef
    revision = $revision
    branch = $branch
    bundleSha256 = $bundleSha256
  } | ConvertTo-Json -Compress
  $receipt = Invoke-RestMethod -Method Post -Uri "$api/api/projects/$ProjectId/returns/receipt" -ContentType 'application/json' -Body $receiptBody
  & ssh -o BatchMode=yes -o ConnectTimeout=10 ([string]$source.sshHost) "rm -f -- '$remoteBundle'" | Out-Null
  [pscustomobject]@{
    ProjectId = $ProjectId
    PlanId = $PlanId
    SourceId = $SourceId
    EnvironmentId = [string]$source.environmentId
    RemoteTarget = $remote.target
    LocalRef = $finalRef
    Revision = $revision
    Branch = $branch
    BundleSha256 = $bundleSha256
    ReturnReceiptId = $receipt.id
  } | ConvertTo-Json -Compress
} finally {
  & git -C $repositoryRoot update-ref -d $tempRef 2>$null
  if (Test-Path -LiteralPath $bundlePath) { Remove-Item -LiteralPath $bundlePath -Force }
}
