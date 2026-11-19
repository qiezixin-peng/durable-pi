[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$DeviceId,
  [Parameter(Mandatory)]
  [string]$Url,
  [Parameter(Mandatory)]
  [ValidateLength(32, 512)]
  [string]$Token,
  [string]$Name = $DeviceId,
  [string]$HubUrl = 'http://127.0.0.1:4781'
)

$body = @{ id = $DeviceId; name = $Name; url = $Url.TrimEnd('/'); token = $Token } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "$($HubUrl.TrimEnd('/'))/api/devices" `
  -ContentType 'application/json' -Body $body
$result | Format-List
Write-Host "Device $DeviceId registered. It will now appear in the project hub." -ForegroundColor Green
