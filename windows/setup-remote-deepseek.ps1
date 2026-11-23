[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SshHost,
  [string]$RemoteRepoDir = '',
  [string]$DeepSeekBaseUrl = 'https://api.deepseek.com',
  [switch]$SkipT3Restart
)

$ErrorActionPreference = 'Stop'
if ($SshHost -notmatch '^[A-Za-z0-9._@-]{1,128}$') {
  throw 'SshHost must be a valid SSH alias or user@host.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'config.ps1')
Import-DurablePiConfig -RepoRoot $repoRoot

$apiKey = $env:DEEPSEEK_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  $secure = Read-Host -Prompt 'Enter official DeepSeek API key for remote host (input hidden)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'DeepSeek API key is required.'
}

$uri = $null
if (-not [Uri]::TryCreate($DeepSeekBaseUrl.Trim(), [UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -ne 'https' -and $uri.Scheme -ne 'http')) {
  throw 'DeepSeekBaseUrl must be a valid HTTP(S) URL.'
}
$cleanBase = $DeepSeekBaseUrl.Trim().TrimEnd('/')

$remoteScript = @'
set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

IFS= read -r DEEPSEEK_KEY
if [[ -z $DEEPSEEK_KEY ]]; then
  echo 'Empty DeepSeek API key' >&2
  exit 1
fi
if ! command -v pi >/dev/null 2>&1; then
  echo 'pi CLI is not installed on this remote host. Install Pi first, then rerun.' >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin" "$HOME/.pi/agent"
if [[ -x "$HOME/.pi/agent/bin/pi" && ! -e "$HOME/.local/bin/pi" ]]; then
  ln -sf "$HOME/.pi/agent/bin/pi" "$HOME/.local/bin/pi"
fi

DEEPSEEK_KEY_ENV="$DEEPSEEK_KEY" DEEPSEEK_BASE_ENV="__DEEPSEEK_BASE__" python3 - <<'PY'
import json
import os
import tempfile

agent_dir = os.path.expanduser("~/.pi/agent")
os.makedirs(agent_dir, mode=0o700, exist_ok=True)
auth_path = os.path.join(agent_dir, "auth.json")
auth_data = {}
if os.path.exists(auth_path):
    with open(auth_path, "r", encoding="utf-8") as fh:
        raw = fh.read().strip()
        if raw:
            auth_data = json.loads(raw)
auth_data["deepseek"] = {
    "type": "api_key",
    "key": os.environ["DEEPSEEK_KEY_ENV"],
}
fd, tmp = tempfile.mkstemp(prefix=".auth.dpi.", dir=agent_dir)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(auth_data, fh, indent=2)
        fh.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, auth_path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)

models_path = os.path.join(agent_dir, "models.json")
models_data = {}
if os.path.exists(models_path):
    with open(models_path, "r", encoding="utf-8") as fh:
        raw = fh.read().strip()
        if raw:
            models_data = json.loads(raw)
providers = models_data.setdefault("providers", {})
providers["deepseek"] = {
    "baseUrl": os.environ["DEEPSEEK_BASE_ENV"],
    "api": "openai-completions",
    "apiKey": "$DEEPSEEK_API_KEY",
    "models": [
        {"id": "deepseek-chat", "name": "DeepSeek Chat", "reasoning": False, "input": ["text"], "contextWindow": 128000, "maxTokens": 8192},
        {"id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "reasoning": True, "input": ["text"], "contextWindow": 128000, "maxTokens": 64000},
    ],
}
fd, tmp = tempfile.mkstemp(prefix=".models.dpi.", dir=agent_dir)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(models_data, fh, indent=2)
        fh.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, models_path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)

t3_settings = os.path.join(os.environ.get("T3CODE_HOME", os.path.expanduser("~/.t3")), "userdata", "settings.json")
os.makedirs(os.path.dirname(t3_settings), exist_ok=True)
settings = {}
if os.path.exists(t3_settings):
    try:
        with open(t3_settings, "r", encoding="utf-8") as fh:
            settings = json.load(fh)
    except json.JSONDecodeError:
        settings = {}
t3_providers = settings.setdefault("providerInstances", {})
t3_providers["pi_durable_worker"] = {
    "driver": "pi",
    "displayName": "Pi · Durable Worker (DeepSeek)",
    "enabled": True,
    "config": {"launchArgs": "--no-mcp"},
}
fd, tmp = tempfile.mkstemp(prefix=".settings.dpi.", dir=os.path.dirname(t3_settings))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, t3_settings)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY

if [[ "__SKIP_RESTART__" != "1" ]] && command -v t3 >/dev/null 2>&1; then
  t3 service restart >/dev/null
fi
echo "REMOTE_DEEPSEEK_CONFIGURED_OK"
'@

$payload = $remoteScript.Replace('__DEEPSEEK_BASE__', $cleanBase).Replace('__SKIP_RESTART__', $(if ($SkipT3Restart) { '1' } else { '0' }))
$payload = $payload.Replace("`r`n", "`n")

$ssh = (Get-Command ssh -ErrorAction Stop).Source
$psi = [Diagnostics.ProcessStartInfo]::new($ssh)
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.ArgumentList.Add('-o')
$psi.ArgumentList.Add('BatchMode=yes')
$psi.ArgumentList.Add($SshHost)
$psi.ArgumentList.Add('bash -s')

$proc = [Diagnostics.Process]::Start($psi)
try {
  $proc.StandardInput.Write($apiKey + "`n")
  $proc.StandardInput.Write($payload + "`n")
  $proc.StandardInput.Close()
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    throw "Remote DeepSeek setup on $SshHost failed (exit $($proc.ExitCode)): $stderr"
  }
  Write-Host $stdout.Trim() -ForegroundColor Green
  Write-Host "Next: add `"deepseek/deepseek-chat`" (and/or `"deepseek/deepseek-reasoner`") to $SshHost's verifiedModels in %USERPROFILE%\.dpi\data-sources.json." -ForegroundColor Cyan
} finally {
  $proc.Dispose()
}
