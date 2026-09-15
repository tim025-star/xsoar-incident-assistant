param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version
)

$ErrorActionPreference = "Stop"
$ollamaCandidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"),
  (Join-Path $env:ProgramFiles "Ollama\ollama.exe")
)
function Find-Ollama {
  $candidate = $ollamaCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($candidate) { return $candidate }
  $ollamaCommand = Get-Command ollama.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($ollamaCommand) { return $ollamaCommand.Source }
  return $null
}
$ollama = Find-Ollama
$installAction = "install"
if ($ollama) {
  $versionOutput = (& $ollama --version 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '(\d+\.\d+\.\d+)') { throw "The installed Ollama version could not be determined." }
  if ([version]$Matches[1] -ge [version]$Version) { $installAction = $null } else { $installAction = "upgrade" }
}
if ($installAction) {
  $winget = Get-Command winget.exe -ErrorAction Stop
  & $winget.Source $installAction --id Ollama.Ollama --exact --version $Version --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "WinGet could not $installAction Ollama $Version." }
  $ollama = Find-Ollama
}
if (-not $ollama) { throw "Ollama was installed but ollama.exe was not found." }
& $ollama pull qwen3.5:9b
if ($LASTEXITCODE -ne 0) { throw "Ollama could not download qwen3.5:9b." }
