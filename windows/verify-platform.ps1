[CmdletBinding()]
param(
  [switch]$Live,
  [switch]$Extended
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $repo '..\..\..'))
$temporaryRoot = Join-Path $workspaceRoot '临时文件'
$runDirectory = Join-Path $temporaryRoot ("durable-pi-verify-{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8)))

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Action
  )
  Write-Host "[$Name]" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
try {
  Push-Location $repo
  try {
    Invoke-Checked 'diff-check' { git diff --check }
    Invoke-Checked 'sdk-check' { Push-Location 'apps\dpi-sdk'; try { npm run check } finally { Pop-Location } }
    Invoke-Checked 'sdk-tests' { Push-Location 'apps\dpi-sdk'; try { npm test } finally { Pop-Location } }
    Invoke-Checked 'backend-check' { Push-Location 'apps\dpi-backend'; try { npm run check } finally { Pop-Location } }
    Invoke-Checked 'backend-tests' { Push-Location 'apps\dpi-backend'; try { npm test } finally { Pop-Location } }
    Invoke-Checked 'playground-build' { Push-Location 'apps\dpi-playground'; try { npm run build } finally { Pop-Location } }
    Invoke-Checked 'playground-tests' { Push-Location 'apps\dpi-playground'; try { npm test } finally { Pop-Location } }
    Invoke-Checked 'sbom' { node 'scripts\generate-sbom.mjs' }
    Invoke-Checked 'production-audit' { node 'scripts\audit-production-dependencies.mjs' }

    if ($Live) {
      foreach ($endpoint in @(
        @{ Name = 'backend'; Url = 'http://127.0.0.1:4780/healthz' },
        @{ Name = 'hub'; Url = 'http://127.0.0.1:4781/api/network' }
      )) {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $endpoint.Url -TimeoutSec 5
        if ($response.StatusCode -ne 200) { throw "$($endpoint.Name) returned HTTP $($response.StatusCode)" }
      }
      $projectDb = Join-Path $env:USERPROFILE '.dpi\projects.sqlite'
      if (-not (Test-Path -LiteralPath $projectDb -PathType Leaf)) { throw "Live project database is missing: $projectDb" }
      Invoke-Checked 'live-database-integrity' { node 'windows\verify-sqlite.mjs' $projectDb }
      $models = Invoke-RestMethod -Uri 'http://127.0.0.1:4781/api/codex/models' -TimeoutSec 15
      $defaultModel = @($models.data) | Where-Object { $_.id -eq 'gpt-6.2-sol' } | Select-Object -First 1
      if (-not $defaultModel -or $defaultModel.capabilities.dynamicTools -ne 'supported') {
        throw 'The default gpt-6.2-sol model is unavailable or lacks platform-verified Dynamic Tools.'
      }
      $autostartTask = Get-ScheduledTask -TaskName 'DurablePi-Local-Platform' -ErrorAction SilentlyContinue
      $ensureScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'ensure-local.ps1'))
      if (-not $autostartTask -or $autostartTask.State -eq 'Disabled' -or
          -not (@($autostartTask.Actions) | Where-Object { $_.Arguments -like "*$ensureScript*" })) {
        throw 'DurablePi-Local-Platform is missing, disabled, or points at the wrong recovery script.'
      }
    }

    if ($Extended) {
      $env:DPI_TEST_TEMP = $runDirectory
      Invoke-Checked 'scheduler-stress' {
        Push-Location 'apps\dpi-playground'
        try { npx tsx 'scripts\verify-scheduler-stress.ts' } finally { Pop-Location }
      }
      if ($Live) {
        Invoke-Checked 'backup-restore-drill' {
          & 'windows\test-backup-restore.ps1' -ScratchRoot $runDirectory
        }
      }
    }

    [pscustomobject]@{
      Ok = $true
      Live = [bool]$Live
      Extended = [bool]$Extended
      VerifiedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:DPI_TEST_TEMP -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $runDirectory) {
    $resolvedRun = [IO.Path]::GetFullPath($runDirectory)
    $resolvedTemp = [IO.Path]::GetFullPath($temporaryRoot)
    if ([IO.Path]::GetDirectoryName($resolvedRun) -ne $resolvedTemp) { throw 'Refusing unsafe verification cleanup.' }
    if ((Get-Item -LiteralPath $resolvedRun -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Refusing to clean a reparse-point verification directory.'
    }
    Remove-Item -LiteralPath $resolvedRun -Recurse -Force
  }
}
