[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$PublicUrl,
  [string]$Name
)

$backendEnv = Join-Path $env:USERPROFILE '.dpi\backend.env'
if (-not (Test-Path -LiteralPath $backendEnv)) { throw 'Worker backend.env was not found.' }
$values = @{}
foreach ($line in [IO.File]::ReadAllLines($backendEnv)) {
  $split = $line.IndexOf('=')
  if ($split -gt 0) { $values[$line.Substring(0, $split)] = $line.Substring($split + 1) }
}
$registration = [ordered]@{
  id = $values.DPI_NETWORK_DEVICE_ID
  name = $(if ($Name) { $Name } else { $values.DPI_DEVICE_NAME })
  url = $PublicUrl.TrimEnd('/')
  token = $values.DPI_TOKEN
}
$registration | ConvertTo-Json
Write-Warning 'This registration contains the worker secret. Transfer it only to the central computer and do not commit it.'
