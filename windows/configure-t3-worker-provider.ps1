[CmdletBinding()]
param(
  [string]$WorkerInstanceId = 'codex',
  [string]$CoordinatorInstanceId = 'codex_durable_coordinator',
  [string]$PiWorkerInstanceId = 'pi_durable_worker',
  [switch]$EnablePiWorker,
  [string]$DefaultModel = 'gpt-5.6-sol',
  [string]$ReasoningEffort = 'medium',
  [string]$ServiceTier = 'fast',
  [string]$SubagentModel = 'gpt-5.6-sol',
  [string]$SubagentReasoningEffort = 'medium',
  [string]$WorkspaceBaseDirectory = '',
  [string]$AntigravityInstanceId = 'antigravity',
  [string]$AntigravityBinaryPath = '',
  [string]$SettingsPath = ''
)

$ErrorActionPreference = 'Stop'
foreach ($instanceId in @($WorkerInstanceId, $CoordinatorInstanceId, $PiWorkerInstanceId, $AntigravityInstanceId)) {
  if ($instanceId -notmatch '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$') {
    throw 'T3 Durable Pi provider instance id is invalid.'
  }
}

function Remove-ProviderInstance([string]$InstanceId) {
  $existing = $settings.providerInstances.PSObject.Properties[$InstanceId]
  if (-not $existing) { return $false }
  $settings.providerInstances.PSObject.Properties.Remove($InstanceId)
  return $true
}
foreach ($value in @($DefaultModel, $ReasoningEffort, $ServiceTier, $SubagentModel, $SubagentReasoningEffort)) {
  if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch '^[a-zA-Z0-9._-]{1,160}$') {
    throw 'T3 Durable Pi model, reasoning and service-tier values must be simple identifiers.'
  }
}

$settingsPath = if ([string]::IsNullOrWhiteSpace($SettingsPath)) {
  Join-Path $env:USERPROFILE '.t3\userdata\settings.json'
} else {
  $SettingsPath
}
$settingsDir = Split-Path -Parent $settingsPath
New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null

$settings = if (Test-Path -LiteralPath $settingsPath) {
  $raw = [IO.File]::ReadAllText($settingsPath)
  if ([string]::IsNullOrWhiteSpace($raw)) { [pscustomobject]@{} }
  else { $raw | ConvertFrom-Json }
} else {
  [pscustomobject]@{}
}
if (-not $settings.providerInstances) {
  $settings | Add-Member -NotePropertyName providerInstances -NotePropertyValue ([pscustomobject]@{})
}

function Set-ProviderInstance([string]$InstanceId, [string]$DisplayName, [string]$LaunchArgs, [string]$Driver = 'codex') {
  $desired = [ordered]@{
    driver = $Driver
    displayName = $DisplayName
    enabled = $true
    config = if ([string]::IsNullOrWhiteSpace($LaunchArgs)) { [ordered]@{} } else { [ordered]@{ launchArgs = $LaunchArgs } }
  }
  $existing = $settings.providerInstances.PSObject.Properties[$InstanceId]
  $desiredJson = $desired | ConvertTo-Json -Depth 20 -Compress
  $existingJson = if ($existing) { $existing.Value | ConvertTo-Json -Depth 20 -Compress } else { '' }
  if ($existingJson -eq $desiredJson) { return $false }
  if ($existing) { $settings.providerInstances.PSObject.Properties.Remove($InstanceId) }
  $settings.providerInstances | Add-Member -NotePropertyName $InstanceId -NotePropertyValue ([pscustomobject]$desired)
  return $true
}

$modelArgs = "-c model_reasoning_effort=$ReasoningEffort -c service_tier=$ServiceTier -c agents.default_subagent_model=$SubagentModel -c agents.default_subagent_reasoning_effort=$SubagentReasoningEffort"
$workerArgs = "$modelArgs -c features.multi_agent=false -c features.multi_agent_v2=false -c mcp_servers.anode.enabled=false -c mcp_servers.durable-pi.enabled=false -c mcp_servers.durable-pi-auto.enabled=false -c mcp_servers.rea.enabled=false -c mcp_servers.reaper.enabled=false"
$coordinatorArgs = '-c features.multi_agent=false -c features.multi_agent_v2=false -c mcp_servers.anode.enabled=false -c mcp_servers.durable-pi.enabled=false -c mcp_servers.durable-pi-auto.enabled=true -c mcp_servers.durable-data.enabled=true -c mcp_servers.rea.enabled=false -c mcp_servers.reaper.enabled=false'
$coordinatorArgs = "$modelArgs $coordinatorArgs"
$workerChanged = if ($WorkerInstanceId -eq 'codex') {
  # T3 already exposes its built-in Codex provider. Reuse it for workers and
  # remove the legacy duplicate entry; the Coordinator remains isolated.
  Remove-ProviderInstance 'codex_durable_worker'
} else {
  Set-ProviderInstance $WorkerInstanceId 'Codex · Durable Worker' $workerArgs
}
$coordinatorChanged = Set-ProviderInstance $CoordinatorInstanceId 'Codex · Durable Coordinator' $coordinatorArgs
$antigravityChanged = $false
if (-not [string]::IsNullOrWhiteSpace($AntigravityBinaryPath)) {
  $resolvedAntigravityBinary = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($AntigravityBinaryPath))
  if (-not (Test-Path -LiteralPath $resolvedAntigravityBinary -PathType Leaf)) {
    throw "Antigravity CLI binary or wrapper does not exist: $resolvedAntigravityBinary"
  }
  $desiredAntigravity = [ordered]@{
    driver = 'antigravity'
    displayName = 'Antigravity CLI (Gemini)'
    enabled = $true
    config = [ordered]@{
      authMethod = 'oauth-personal'
      binaryPath = $resolvedAntigravityBinary
    }
  }
  $existingAntigravity = $settings.providerInstances.PSObject.Properties[$AntigravityInstanceId]
  $existingAntigravityJson = if ($existingAntigravity) { $existingAntigravity.Value | ConvertTo-Json -Depth 20 -Compress } else { '' }
  $desiredAntigravityJson = $desiredAntigravity | ConvertTo-Json -Depth 20 -Compress
  $antigravityChanged = $existingAntigravityJson -ne $desiredAntigravityJson
  if ($antigravityChanged) {
    if ($existingAntigravity) { $settings.providerInstances.PSObject.Properties.Remove($AntigravityInstanceId) }
    $settings.providerInstances | Add-Member -NotePropertyName $AntigravityInstanceId -NotePropertyValue ([pscustomobject]$desiredAntigravity)
  }
}
$piWorkerChanged = $false
if ($EnablePiWorker) {
  $piWorkerChanged = Set-ProviderInstance $PiWorkerInstanceId 'Pi · Durable Worker (DeepSeek)' '--no-mcp' 'pi'
}
$existingDefault = $settings.PSObject.Properties['defaultModelSelection']
$selection = [pscustomobject][ordered]@{
  instanceId = $CoordinatorInstanceId
  model = $DefaultModel
  options = @(
    [pscustomobject]@{ id = 'reasoningEffort'; value = $ReasoningEffort },
    [pscustomobject]@{ id = 'serviceTier'; value = $(if ($ServiceTier -eq 'fast') { 'priority' } else { $ServiceTier }) },
    [pscustomobject]@{ id = 'cyberAccessProgram'; value = 'standard' }
  )
}
$existingDefaultJson = if ($existingDefault) { $existingDefault.Value | ConvertTo-Json -Depth 20 -Compress } else { '' }
$defaultChanged = $existingDefaultJson -ne ($selection | ConvertTo-Json -Depth 20 -Compress)
if ($existingDefault) { $settings.PSObject.Properties.Remove('defaultModelSelection') }
$settings | Add-Member -NotePropertyName defaultModelSelection -NotePropertyValue $selection
$workspaceChanged = $false
if (-not [string]::IsNullOrWhiteSpace($WorkspaceBaseDirectory)) {
  $resolvedWorkspace = [IO.Path]::GetFullPath($WorkspaceBaseDirectory)
  if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) {
    throw "T3 workspace base directory does not exist: $resolvedWorkspace"
  }
  $existingWorkspace = $settings.PSObject.Properties['addProjectBaseDirectory']
  $workspaceChanged = -not $existingWorkspace -or [string]$existingWorkspace.Value -ne $resolvedWorkspace
  if ($existingWorkspace) { $settings.PSObject.Properties.Remove('addProjectBaseDirectory') }
  $settings | Add-Member -NotePropertyName addProjectBaseDirectory -NotePropertyValue $resolvedWorkspace
}
$changed = $workerChanged -or $coordinatorChanged -or $antigravityChanged -or $piWorkerChanged -or $defaultChanged -or $workspaceChanged
if (-not $changed) {
  Write-Output $false
  exit 0
}
$tempPath = Join-Path $settingsDir ('.settings.durable-pi.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  [IO.File]::WriteAllText(
    $tempPath,
    (($settings | ConvertTo-Json -Depth 50) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
  Move-Item -LiteralPath $tempPath -Destination $settingsPath -Force
} finally {
  if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
}
Write-Output $true
