[CmdletBinding()]
param(
  [string]$ModelsPath = '',
  [string]$AuthPath = '',
  [string]$DeepSeekApiKey = '',
  [string]$DeepSeekBaseUrl = ''
)

$ErrorActionPreference = 'Stop'
$piAgentDir = if (-not [string]::IsNullOrWhiteSpace($env:PI_CODING_AGENT_DIR)) {
  [Environment]::ExpandEnvironmentVariables($env:PI_CODING_AGENT_DIR)
} else {
  Join-Path $env:USERPROFILE '.pi\agent'
}
if ([string]::IsNullOrWhiteSpace($ModelsPath)) {
  $ModelsPath = Join-Path $piAgentDir 'models.json'
}
if ([string]::IsNullOrWhiteSpace($AuthPath)) {
  $AuthPath = if (-not [string]::IsNullOrWhiteSpace($env:DPI_AUTH_FILE)) {
    [Environment]::ExpandEnvironmentVariables($env:DPI_AUTH_FILE)
  } else {
    Join-Path $piAgentDir 'auth.json'
  }
}

function Resolve-CleanUrl([string]$Value, [string]$Fallback, [string]$Label) {
  $candidate = if ([string]::IsNullOrWhiteSpace($Value)) { $Fallback } else { $Value.Trim() }
  $uri = $null
  if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -ne 'https' -and $uri.Scheme -ne 'http')) {
    throw "$Label must be a valid HTTP(S) URL."
  }
  return $candidate.TrimEnd('/')
}

$resolvedDeepSeekBase = Resolve-CleanUrl $(if ($DeepSeekBaseUrl) { $DeepSeekBaseUrl } else { $env:DEEPSEEK_BASE_URL }) 'https://api.deepseek.com' 'DEEPSEEK_BASE_URL'
$resolvedDeepSeekKey = if (-not [string]::IsNullOrWhiteSpace($DeepSeekApiKey)) {
  $DeepSeekApiKey.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
  $env:DEEPSEEK_API_KEY.Trim()
} else {
  ''
}

$dir = Split-Path -Parent $ModelsPath
New-Item -ItemType Directory -Path $dir -Force | Out-Null

$doc = if (Test-Path -LiteralPath $ModelsPath) {
  $raw = [IO.File]::ReadAllText($ModelsPath)
  if ([string]::IsNullOrWhiteSpace($raw)) { [pscustomobject]@{} }
  else { $raw | ConvertFrom-Json }
} else {
  [pscustomobject]@{}
}
if (-not $doc.PSObject.Properties['providers']) {
  $doc | Add-Member -NotePropertyName providers -NotePropertyValue ([pscustomobject]@{})
}

$before = $doc | ConvertTo-Json -Depth 30 -Compress

# Register official DeepSeek chat/reasoner models alongside pi's built-in catalog (deepseek-flash, deepseek-v4-pro).
# Never write raw API keys into models.json; Pi resolves credentials from ~/.pi/agent/auth.json or DEEPSEEK_API_KEY.
# Google Gemini intentionally uses Google Account OAuth (T3 Antigravity oauth-personal / @google/gemini-cli) and never uses an API key.
$deepseekProvider = [pscustomobject][ordered]@{
  baseUrl = $resolvedDeepSeekBase
  api = 'openai-completions'
  models = @(
    [pscustomobject][ordered]@{
      id = 'deepseek-chat'
      name = 'DeepSeek Chat'
      reasoning = $false
      input = @('text')
      contextWindow = 128000
      maxTokens = 8192
    },
    [pscustomobject][ordered]@{
      id = 'deepseek-reasoner'
      name = 'DeepSeek Reasoner'
      reasoning = $true
      input = @('text')
      contextWindow = 128000
      maxTokens = 64000
    }
  )
}
if ($doc.providers.PSObject.Properties['deepseek']) {
  $doc.providers.PSObject.Properties.Remove('deepseek')
}
$doc.providers | Add-Member -NotePropertyName deepseek -NotePropertyValue $deepseekProvider

$after = $doc | ConvertTo-Json -Depth 30 -Compress
$modelsChanged = $false
if ($before -ne $after) {
  $tempPath = Join-Path $dir ('.models.durable-pi.' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText(
      $tempPath,
      (($doc | ConvertTo-Json -Depth 30) + [Environment]::NewLine),
      [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $tempPath -Destination $ModelsPath -Force
    $modelsChanged = $true
  } finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
  }
}

$authChanged = $false
if (-not [string]::IsNullOrWhiteSpace($resolvedDeepSeekKey)) {
  $authDir = Split-Path -Parent $AuthPath
  New-Item -ItemType Directory -Path $authDir -Force | Out-Null
  $authDoc = if (Test-Path -LiteralPath $AuthPath) {
    $rawAuth = [IO.File]::ReadAllText($AuthPath)
    if ([string]::IsNullOrWhiteSpace($rawAuth)) { [pscustomobject]@{} }
    else { $rawAuth | ConvertFrom-Json }
  } else {
    [pscustomobject]@{}
  }
  $authBefore = $authDoc | ConvertTo-Json -Depth 20 -Compress
  $entry = [pscustomobject][ordered]@{
    type = 'api_key'
    key  = $resolvedDeepSeekKey
  }
  if ($authDoc.PSObject.Properties['deepseek']) {
    $authDoc.PSObject.Properties.Remove('deepseek')
  }
  $authDoc | Add-Member -NotePropertyName deepseek -NotePropertyValue $entry
  $authAfter = $authDoc | ConvertTo-Json -Depth 20 -Compress
  if ($authBefore -ne $authAfter) {
    $tempAuthPath = Join-Path $authDir ('.auth.durable-pi.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
      [IO.File]::WriteAllText(
        $tempAuthPath,
        (($authDoc | ConvertTo-Json -Depth 20) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
      )
      Move-Item -LiteralPath $tempAuthPath -Destination $AuthPath -Force
      $authChanged = $true
    } finally {
      if (Test-Path -LiteralPath $tempAuthPath) { Remove-Item -LiteralPath $tempAuthPath -Force }
    }
  }
}

Write-Output ($modelsChanged -or $authChanged)
