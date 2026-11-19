[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^relay-plan-[a-f0-9]{40}$')][string]$PlanId,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')][string]$ProjectId,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$')][string]$HandoffId,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')][string]$SourceId,
  [Parameter(Mandatory)][string]$Repository,
  [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9._-]{0,63}$')][string]$ProjectSlug,
  [Parameter(Mandatory)][ValidateLength(1, 120)][string]$Title,
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
if (-not [string]::IsNullOrWhiteSpace((& git -C $repositoryRoot status --porcelain))) {
  throw 'Repository has uncommitted changes; commit or stash them before relay.'
}
$revision = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($revision -notmatch '^[a-f0-9]{40,64}$') { throw 'Repository HEAD is invalid.' }
$branch = (& git -C $repositoryRoot branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) { throw 'Repository must be on a named branch before relay.' }
& git -C $repositoryRoot check-ref-format --branch $branch | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Repository branch name is invalid.' }

$api = $HubUrl.TrimEnd('/')
$plan = Invoke-RestMethod -Method Get -Uri "$api/api/projects/$ProjectId/relays/plans/$PlanId"
if (-not $plan -or $plan.status -notin @('PLANNED', 'READY')) { throw "Relay plan $PlanId is not executable." }
if ([string]$plan.handoffId -ne $HandoffId -or [string]$plan.sourceId -ne $SourceId -or
    [IO.Path]::GetFullPath([string]$plan.repository) -ne [IO.Path]::GetFullPath($repositoryRoot) -or
    [string]$plan.projectSlug -ne $ProjectSlug -or [string]$plan.title -ne $Title) {
  throw 'Relay command parameters do not match the frozen plan.'
}
$handoffs = @((Invoke-RestMethod -Method Get -Uri "$api/api/projects/$ProjectId/handoffs").handoffs)
$handoff = $handoffs | Where-Object id -eq $HandoffId | Select-Object -First 1
if (-not $handoff) { throw "Handoff $HandoffId was not found in project $ProjectId." }
$validation = Invoke-RestMethod -Method Post -Uri "$api/api/projects/$ProjectId/handoffs/$HandoffId/validate" -ContentType 'application/json' -Body '{}'
if (-not $validation.valid) { throw 'Handoff validation failed.' }
$gitCheck = Invoke-RestMethod -Method Post -Uri "$api/api/projects/$ProjectId/handoffs/$HandoffId/check-git" -ContentType 'application/json' -Body (@{ workspace = $repositoryRoot } | ConvertTo-Json)
if (-not $gitCheck.safeToApply -or $gitCheck.status -ne 'SAME') {
  throw 'Handoff Git baseline does not match the repository HEAD.'
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

$stagingRoot = Join-Path $env:USERPROFILE '.dpi\relay-staging'
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
$bundleName = ('relay-' + [guid]::NewGuid().ToString('N'))
$bundlePath = Join-Path $stagingRoot "$bundleName.bundle"
try {
  & git -C $repositoryRoot bundle create $bundlePath HEAD "refs/heads/$branch"
  if ($LASTEXITCODE -ne 0) { throw 'Git bundle creation failed.' }
  $bundleSha256 = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $remoteInbox = ([string]$source.remoteRoot).TrimEnd('/') + '/.dpi/relay-inbox'
  $remoteBundle = "$remoteInbox/$bundleName.bundle"
  $receiver = Join-Path $repoRoot 'unix\receive-project-relay.py'
  $register = Join-Path $repoRoot 'unix\register-t3-project.sh'
  $quotedInbox = "'$remoteInbox'"
  & ssh -o BatchMode=yes -o ConnectTimeout=10 ([string]$source.sshHost) "mkdir -p $quotedInbox && chmod 700 $quotedInbox"
  if ($LASTEXITCODE -ne 0) { throw 'Remote relay inbox creation failed.' }
  & scp -q -o BatchMode=yes -o ConnectTimeout=10 -- $bundlePath (([string]$source.sshHost) + ':' + $remoteBundle)
  if ($LASTEXITCODE -ne 0) { throw 'Git bundle upload failed.' }
  & scp -q -o BatchMode=yes -o ConnectTimeout=10 -- $receiver (([string]$source.sshHost) + ':' + "$remoteInbox/receive-project-relay.py")
  if ($LASTEXITCODE -ne 0) { throw 'Relay helper upload failed.' }
  & scp -q -o BatchMode=yes -o ConnectTimeout=10 -- $register (([string]$source.sshHost) + ':' + "$remoteInbox/register-t3-project.sh")
  if ($LASTEXITCODE -ne 0) { throw 'T3 registration helper upload failed.' }
  $payloadJson = @{ slug = $ProjectSlug; title = $Title; bundleName = $bundleName; bundleSha256 = $bundleSha256; revision = $revision; branch = $branch } | ConvertTo-Json -Compress
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $remoteHelper = "$remoteInbox/receive-project-relay.py"
  $output = & ssh -o BatchMode=yes -o ConnectTimeout=10 ([string]$source.sshHost) python3 $remoteHelper $payload
  if ($LASTEXITCODE -ne 0) { throw 'Remote relay or T3 registration failed.' }
  $result = $output | Select-Object -Last 1 | ConvertFrom-Json
  $receiptBody = @{
    planId = $PlanId
    handoffId = $HandoffId
    sourceId = $SourceId
    environmentId = [string]$source.environmentId
    target = [string]$result.target
    revision = [string]$result.revision
    branch = [string]$result.branch
    bundleSha256 = [string]$result.bundleSha256
    targetCreated = [bool]$result.created
  } | ConvertTo-Json -Compress
  $receipt = Invoke-RestMethod -Method Post -Uri "$api/api/projects/$ProjectId/relays/receipt" -ContentType 'application/json' -Body $receiptBody
  [pscustomobject]@{
    ProjectId = $ProjectId
    PlanId = $PlanId
    HandoffId = $HandoffId
    SourceId = $SourceId
    EnvironmentId = [string]$source.environmentId
    Target = $result.target
    Revision = $result.revision
    Branch = $result.branch
    Created = [bool]$result.created
    BundleSha256 = $result.bundleSha256
    RelayReceiptId = $receipt.id
  } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $bundlePath) { Remove-Item -LiteralPath $bundlePath -Force }
}
