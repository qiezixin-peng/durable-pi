[CmdletBinding()]
param(
  [string]$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string[]]$CodexHomes = @((Join-Path $env:USERPROFILE '.codex'), (Join-Path $env:USERPROFILE '.codex-leader')),
  [string]$CoordinatorModel = ''
)

$ErrorActionPreference = 'Stop'
$entry = Join-Path $RuntimeRoot 'apps\dpi-playground\dist\mcp\main.mjs'
$dataEntry = Join-Path $RuntimeRoot 'apps\dpi-playground\dist\mcp\data-main.mjs'
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
foreach ($path in @($entry, $dataEntry)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing built MCP runtime: $path" }
}
if ($CoordinatorModel -and ($CoordinatorModel.Length -gt 160 -or $CoordinatorModel -match "[`r`n`0']")) {
  throw 'Invalid Coordinator model.'
}

function Toml-Literal([string]$Value) { "'" + $Value.Replace("'", "''") + "'" }
$begin = '# BEGIN DURABLE PI MANAGED MCP'
$end = '# END DURABLE PI MANAGED MCP'
$modelManual = if ($CoordinatorModel) { "`nDPI_COORDINATOR_MODEL = $(Toml-Literal $CoordinatorModel)" } else { '' }
$modelAuto = if ($CoordinatorModel) { "`nDPI_COORDINATOR_MODEL = $(Toml-Literal $CoordinatorModel)" } else { '' }
$block = @"
$begin
[mcp_servers.durable-pi]
command = $(Toml-Literal $nodeCommand)
args = [$(Toml-Literal $entry)]

[mcp_servers.durable-pi.env]
NODE_OPTIONS = '--disable-warning=ExperimentalWarning'$modelManual

[mcp_servers.durable-pi-auto]
command = $(Toml-Literal $nodeCommand)
args = [$(Toml-Literal $entry)]
enabled = false

[mcp_servers.durable-pi-auto.env]
DPI_AUTO_INITIALIZE = '1'
NODE_OPTIONS = '--disable-warning=ExperimentalWarning'$modelAuto

[mcp_servers.durable-data]
command = $(Toml-Literal $nodeCommand)
args = [$(Toml-Literal $dataEntry)]

[mcp_servers.durable-data.env]
NODE_OPTIONS = '--disable-warning=ExperimentalWarning'
$end
"@

foreach ($codexHome in $CodexHomes | Select-Object -Unique) {
  New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
  $config = Join-Path $codexHome 'config.toml'
  $old = if (Test-Path -LiteralPath $config) { [IO.File]::ReadAllText($config) } else { '' }
  $next = [regex]::Replace($old, "(?ms)^$([regex]::Escape($begin))\r?\n.*?^$([regex]::Escape($end))\r?\n?", '').TrimEnd()
  foreach ($name in @('durable-pi-auto\.env', 'durable-pi-auto', 'durable-pi\.env', 'durable-pi', 'durable-data')) {
    $next = [regex]::Replace($next, "(?ms)^\[mcp_servers\.$name\]\r?\n.*?(?=^\[|\z)", '').TrimEnd()
  }
  $next = if ($next) { "$next`r`n`r`n$block" } else { $block }
  $temporary = Join-Path $codexHome ('.config.durable-pi-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temporary, $next.TrimEnd() + "`r`n", [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $config -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
  Write-Output $config
}
