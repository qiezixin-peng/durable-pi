[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$DeviceId,
  [Parameter(Mandatory)]
  [string]$HubUrl,
  [Alias('HubToken')]
  [ValidateLength(32, 512)]
  [string]$LegacyHubToken,
  [string]$StartDirectory = (Join-Path $env:USERPROFILE 'dpi-work'),
  [ValidateSet('faux', 'openrouter')]
  [string]$Provider = 'faux',
  [ValidateRange(1, 65535)]
  [int]$Port = 4780,
  [string]$ListenHost = '0.0.0.0',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dpiRoot = Join-Path $env:USERPROFILE '.dpi'
$backendEnv = Join-Path $dpiRoot 'backend.env'

function New-DpiToken {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) }
  finally { $generator.Dispose() }
  return 'dpi_' + [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line.StartsWith("$Name=")) { return $line.Substring($Name.Length + 1) }
  }
  return $null
}

$nodeMajor = (& node --version).TrimStart('v').Split('.')[0]
if ([int]$nodeMajor -lt 22) { throw 'Node.js 22.19 or newer is required.' }
$parsedHub = [Uri]$HubUrl
if ($parsedHub.Scheme -notin @('http', 'https')) { throw 'HubUrl must use http or https.' }

New-Item -ItemType Directory -Path $dpiRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dpiRoot 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dpiRoot 'run') -Force | Out-Null
New-Item -ItemType Directory -Path $StartDirectory -Force | Out-Null

$deviceToken = Read-EnvValue $backendEnv 'DPI_TOKEN'
if (-not $deviceToken) { $deviceToken = New-DpiToken }
$startPath = [IO.Path]::GetFullPath($StartDirectory)
$envLines = @(
  "DPI_TOKEN=$deviceToken",
  "DPI_DEVICE_NAME=$DeviceId",
  "DPI_PORT=$Port",
  "DPI_HOST=$ListenHost",
  "DPI_START_DIRS=$startPath",
  "DPI_PROVIDER=$Provider",
  "DPI_HUB_URL=$($HubUrl.TrimEnd('/'))",
  "DPI_HUB_DEVICE_TOKEN=$deviceToken",
  "DPI_NETWORK_DEVICE_ID=$DeviceId"
)
if ($LegacyHubToken) { $envLines += "DPI_HUB_TOKEN=$LegacyHubToken" }
if ($Provider -eq 'openrouter') {
  $openRouterKey = $env:OPENROUTER_API_KEY
  if (-not $openRouterKey) { $openRouterKey = Read-EnvValue $backendEnv 'OPENROUTER_API_KEY' }
  if (-not $openRouterKey) { throw 'Set OPENROUTER_API_KEY before configuring the openrouter provider.' }
  $envLines += "OPENROUTER_API_KEY=$openRouterKey"
}
[IO.File]::WriteAllLines($backendEnv, $envLines, [Text.UTF8Encoding]::new($false))

if (-not $SkipInstall) {
  foreach ($relative in @('apps\dpi-sdk', 'apps\dpi-backend')) {
    Push-Location (Join-Path $repoRoot $relative)
    try {
      & npm ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $relative" }
    } finally { Pop-Location }
  }
}

Write-Host 'Windows worker setup complete.' -ForegroundColor Green
Write-Host "Device id: $DeviceId"
Write-Host "Workspace root: $startPath"
Write-Host "Hub: $($HubUrl.TrimEnd('/'))"
Write-Host 'Start with: .\windows\start-worker.ps1'
Write-Host 'Then run show-worker-registration.ps1 with this machine''s reachable URL.' -ForegroundColor Yellow
