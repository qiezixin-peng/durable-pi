[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'This one-time setup must run in an elevated PowerShell window.'
}

$firewallName = 'DurablePi SSH Mesh'
$rule = Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue
if ($rule) {
  Set-NetFirewallRule -DisplayName $firewallName -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null
  Get-NetFirewallRule -DisplayName $firewallName | Get-NetFirewallAddressFilter |
    Set-NetFirewallAddressFilter -RemoteAddress '100.64.0.0/10' | Out-Null
  Get-NetFirewallRule -DisplayName $firewallName | Get-NetFirewallPortFilter |
    Set-NetFirewallPortFilter -Protocol TCP -LocalPort 22 | Out-Null
} else {
  New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort 22 -RemoteAddress '100.64.0.0/10' -Profile Any | Out-Null
}

$authorizedKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
$keys = @(
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILbjD+X9GKH1IA37e74oVhTDRvpRXaOB7GE0KbyvivEH durable-pi-linux',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG/QkSvYrkaxpqSe+zL93WuK1nYf3R53Sq+7cOOrLPwC durable-pi-macos'
)
$existing = if (Test-Path -LiteralPath $authorizedKeys) { [IO.File]::ReadAllLines($authorizedKeys) } else { @() }
$identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($line in $existing) {
  $parts = $line.Trim() -split '\s+'
  if ($parts.Count -ge 2) { [void]$identities.Add("$($parts[0]) $($parts[1])") }
}
$next = [Collections.Generic.List[string]]::new()
$next.AddRange([string[]]$existing)
foreach ($key in $keys) {
  $parts = $key -split '\s+'
  if ($identities.Add("$($parts[0]) $($parts[1])")) { $next.Add($key) }
}
[IO.File]::WriteAllLines($authorizedKeys, $next, [Text.UTF8Encoding]::new($false))
& icacls.exe $authorizedKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to secure administrators_authorized_keys.' }

Set-Service sshd -StartupType Automatic
Restart-Service sshd
Write-Host 'Durable Pi Tailscale SSH mesh enabled.' -ForegroundColor Green
