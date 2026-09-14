$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $projectRoot "extension"
$outputPath = Join-Path $projectRoot "output"
$archivePath = Join-Path $outputPath "xsoar-incident-assistant-extension.zip"

if (-not (Test-Path -LiteralPath (Join-Path $extensionPath "manifest.json") -PathType Leaf)) {
    throw "The extension manifest was not found."
}

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}
Compress-Archive -Path (Join-Path $extensionPath "*") -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "Created $archivePath"
