[CmdletBinding()]
param(
  [string]$InstanceId = 'antigravity',
  [string]$CredentialTarget = 'gemini:antigravity',
  [string]$AntigravityExecutable = "$env:LOCALAPPDATA\agy\bin\agy.exe",
  [string]$T3StateDirectory = "$env:USERPROFILE\.t3\userdata"
)

$ErrorActionPreference = 'Stop'

# T3 intentionally keeps provider profiles separate from the interactive CLI.
# Copy only the minimum refresh material required by T3's read-only usage probe;
# never change or delete the source Windows Credential Manager entry.
$credentialInterop = @'
using System;
using System.Runtime.InteropServices;
public static class DurablePiCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@
if (-not ('DurablePiCredentialReader' -as [type])) { Add-Type -TypeDefinition $credentialInterop }

function Read-AntigravityCredential {
  $pointer = [IntPtr]::Zero
  if (-not [DurablePiCredentialReader]::CredRead($CredentialTarget, 1, 0, [ref]$pointer)) {
    throw "Antigravity credential is unavailable in Windows Credential Manager: $CredentialTarget"
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $pointer,
      [type][DurablePiCredentialReader+Credential]
    )
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    return ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
  } finally {
    [DurablePiCredentialReader]::CredFree($pointer)
  }
}

function Get-OAuthClientId([string]$AccessToken) {
  try {
    $info = Invoke-RestMethod -Method Get -Uri 'https://www.googleapis.com/oauth2/v1/tokeninfo' `
      -Headers @{ Authorization = "Bearer $AccessToken" } -TimeoutSec 15
    if ($info.issued_to -match '^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$') {
      return [string]$info.issued_to
    }
  } catch {}
  return $null
}

function Test-OAuthClient([string]$ClientId, [string]$ClientSecret, [string]$RefreshToken) {
  try {
    $null = Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' `
      -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 15 -Body @{
        client_id = $ClientId
        client_secret = $ClientSecret
        refresh_token = $RefreshToken
        grant_type = 'refresh_token'
      }
    return $true
  } catch {
    return $false
  }
}

if ($InstanceId -notmatch '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$') { throw 'Invalid Antigravity provider instance id.' }
if (-not (Test-Path -LiteralPath $AntigravityExecutable -PathType Leaf)) {
  throw "Antigravity executable does not exist: $AntigravityExecutable"
}

$source = Read-AntigravityCredential
$refreshToken = [string]$source.token.refresh_token
$accessToken = [string]$source.token.access_token
if ([string]::IsNullOrWhiteSpace($refreshToken)) { throw 'Antigravity credential has no refresh token.' }

$clientId = Get-OAuthClientId $accessToken
if ([string]::IsNullOrWhiteSpace($clientId)) {
  # A read-only model listing asks the official CLI to refresh its own access
  # token. It does not run login/logout or modify the T3 provider profile.
  & $AntigravityExecutable --app_data_dir=antigravity-cli-isolated models *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Antigravity CLI could not refresh its existing credential.' }
  $source = Read-AntigravityCredential
  $refreshToken = [string]$source.token.refresh_token
  $clientId = Get-OAuthClientId ([string]$source.token.access_token)
}
if ([string]::IsNullOrWhiteSpace($clientId)) { throw 'Could not identify the existing Antigravity OAuth client.' }

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $instanceHash = -join ($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($InstanceId)) |
    ForEach-Object { $_.ToString('x2') })
} finally {
  $sha256.Dispose()
}
$profileDirectory = Join-Path $T3StateDirectory "providers\antigravity\$instanceHash\antigravity-acp"
$tokenPath = Join-Path $profileDirectory 'acp_token.json'
$clientSecret = $null

if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
  try {
    $existing = Get-Content -LiteralPath $tokenPath -Raw | ConvertFrom-Json
    if ([string]$existing.client_id -eq $clientId -and
        (Test-OAuthClient $clientId ([string]$existing.client_secret) $refreshToken)) {
      $clientSecret = [string]$existing.client_secret
    }
  } catch {}
}

if ([string]::IsNullOrWhiteSpace($clientSecret)) {
  $binaryText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($AntigravityExecutable))
  $secretCandidates = [regex]::Matches($binaryText, 'GOCSPX-[A-Za-z0-9_-]{28}') |
    ForEach-Object { $_.Value } | Select-Object -Unique
  foreach ($candidate in $secretCandidates) {
    if (Test-OAuthClient $clientId $candidate $refreshToken) {
      $clientSecret = $candidate
      break
    }
  }
}
if ([string]::IsNullOrWhiteSpace($clientSecret)) { throw 'Could not match the installed Antigravity OAuth client.' }

New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
$payload = [ordered]@{
  client_id = $clientId
  client_secret = $clientSecret
  refresh_token = $refreshToken
}
$tempPath = Join-Path $profileDirectory ('.acp_token.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  [IO.File]::WriteAllText(
    $tempPath,
    (($payload | ConvertTo-Json -Compress) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
  Move-Item -LiteralPath $tempPath -Destination $tokenPath -Force
  $fileSecurity = New-Object Security.AccessControl.FileSecurity
  $fileSecurity.SetAccessRuleProtection($true, $false)
  $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  foreach ($sid in @($currentUserSid, $systemSid)) {
    $fileSecurity.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )))
  }
  Set-Acl -LiteralPath $tokenPath -AclObject $fileSecurity
} finally {
  if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
}

Write-Output ([pscustomobject]@{
  synced = $true
  instanceId = $InstanceId
  tokenPath = $tokenPath
})
