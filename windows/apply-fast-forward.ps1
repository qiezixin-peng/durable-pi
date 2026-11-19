[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^integration-plan-[a-f0-9]{40}$')][string]$PlanId,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')][string]$ProjectId,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')][string]$SourceId,
  [Parameter(Mandatory)][string]$Repository,
  [string]$HubUrl = 'http://127.0.0.1:4781'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath $Repository).Path
if ((Get-Item -LiteralPath $repositoryRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Repository must not be a reparse point.'
}
$gitRoot = (& git -C $repositoryRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($repositoryRoot)) {
  throw 'Repository must be the Git top-level directory.'
}

$api = $HubUrl.TrimEnd('/')
$plan = Invoke-RestMethod -Method Get -Uri "$api/api/projects/$ProjectId/integrations/plans/$PlanId"
if (-not $plan -or $plan.status -notin @('PLANNED', 'APPLIED')) { throw "Integration plan $PlanId is not executable." }
if ([string]$plan.sourceId -ne $SourceId -or
    [IO.Path]::GetFullPath([string]$plan.repository) -ne [IO.Path]::GetFullPath($repositoryRoot)) {
  throw 'Integration command parameters do not match the frozen plan.'
}

$branch = (& git -C $repositoryRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne [string]$plan.targetBranch) {
  throw 'The current branch no longer matches the frozen integration plan.'
}
if (-not [string]::IsNullOrWhiteSpace((& git -C $repositoryRoot status --porcelain))) {
  throw 'The Windows worktree must be clean before fast-forward integration.'
}
$managedRevision = (& git -C $repositoryRoot rev-parse --verify ([string]$plan.managedRef)).Trim()
if ($LASTEXITCODE -ne 0 -or $managedRevision -ne [string]$plan.remoteRevision) {
  throw 'The managed remote ref no longer matches the frozen integration plan.'
}
$currentRevision = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($currentRevision -eq [string]$plan.baseRevision) {
  & git -C $repositoryRoot merge-base --is-ancestor $currentRevision $managedRevision
  if ($LASTEXITCODE -ne 0) { throw 'The remote revision is no longer a fast-forward of the frozen base.' }
  $emptyHooks = Join-Path $env:USERPROFILE '.dpi\empty-git-hooks'
  New-Item -ItemType Directory -Path $emptyHooks -Force | Out-Null
  & git -C $repositoryRoot -c "core.hooksPath=$emptyHooks" merge --ff-only --no-edit ([string]$plan.managedRef)
  if ($LASTEXITCODE -ne 0) { throw 'Fast-forward integration failed.' }
} elseif ($currentRevision -ne [string]$plan.remoteRevision) {
  throw 'Windows HEAD changed after the integration plan was created.'
}

$appliedRevision = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($appliedRevision -ne [string]$plan.remoteRevision) { throw 'Fast-forward did not reach the planned revision.' }
if (-not [string]::IsNullOrWhiteSpace((& git -C $repositoryRoot status --porcelain))) {
  throw 'Fast-forward integration left an unexpected dirty worktree.'
}
$receiptBody = @{
  planId = $PlanId
  sourceId = $SourceId
  targetBranch = $branch
  previousRevision = [string]$plan.baseRevision
  appliedRevision = $appliedRevision
} | ConvertTo-Json -Compress
$receipt = Invoke-RestMethod -Method Post -Uri "$api/api/projects/$ProjectId/integrations/receipt" -ContentType 'application/json' -Body $receiptBody
[pscustomobject]@{
  ProjectId = $ProjectId
  PlanId = $PlanId
  SourceId = $SourceId
  TargetBranch = $branch
  PreviousRevision = [string]$plan.baseRevision
  AppliedRevision = $appliedRevision
  IntegrationReceiptId = $receipt.id
} | ConvertTo-Json -Compress
