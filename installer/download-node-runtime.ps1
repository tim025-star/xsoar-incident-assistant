param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
$runtimeDirectory = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

Invoke-WebRequest -Uri "https://nodejs.org/dist/v24.14.0/win-x64/node.exe" -OutFile $Destination
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant()
$expectedHash = "63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088"
if ($actualHash -ne $expectedHash) {
  Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
  throw "Downloaded Node.js runtime SHA-256 did not match the pinned release."
}
