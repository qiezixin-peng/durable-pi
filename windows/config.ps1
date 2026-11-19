function Import-DurablePiEnvFile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [switch]$Override
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  foreach ($raw in [IO.File]::ReadAllLines($Path)) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $split = $line.IndexOf('=')
    if ($split -lt 1) { throw "Invalid config line in ${Path}: $raw" }
    $name = $line.Substring(0, $split).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid config key in ${Path}: $name" }
    $value = $line.Substring($split + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ($Override -or [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

function Import-DurablePiConfig {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [string]$RepoRoot,
    [string]$RuntimeEnv = ''
  )

  Import-DurablePiEnvFile -Path (Join-Path $RepoRoot '.env')
  if ($RuntimeEnv) { Import-DurablePiEnvFile -Path $RuntimeEnv -Override }
}
