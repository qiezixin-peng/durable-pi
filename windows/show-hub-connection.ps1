[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$PublicUrl,
  [switch]$IncludeLegacyToken
)

$connection = [ordered]@{
  hubUrl = $PublicUrl.TrimEnd('/')
  authentication = 'registered-device-token'
}
if ($IncludeLegacyToken) {
  $backendEnv = Join-Path $env:USERPROFILE '.dpi\backend.env'
  if (-not (Test-Path -LiteralPath $backendEnv)) { throw 'Run setup.ps1 on the central computer first.' }
  $hubTokenLine = [IO.File]::ReadAllLines($backendEnv) | Where-Object { $_.StartsWith('DPI_HUB_TOKEN=') } | Select-Object -First 1
  if (-not $hubTokenLine) { throw 'DPI_HUB_TOKEN is missing. Run setup.ps1 again.' }
  $connection.legacyHubToken = $hubTokenLine.Substring('DPI_HUB_TOKEN='.Length)
  Write-Warning 'Legacy shared-token mode is disabled unless DPI_ALLOW_LEGACY_HUB_TOKEN=1 is set on the Hub.'
}
$connection | ConvertTo-Json
