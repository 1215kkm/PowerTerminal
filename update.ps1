# PowerTerminal git-less self-update: pulls the latest release ZIP and overlays
# tracked files. Untracked files (config.json, sessions.json, node_modules, ...)
# are NOT in the ZIP, so your data/token are left untouched.
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot

try { $loc = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
catch { $loc = '0' }

try {
  $b = (Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/1215kkm/PowerTerminal/main/banner.json').Content | ConvertFrom-Json
  $latest = $b.latestVersion
} catch {
  Write-Host '   (offline - keeping current version)'
  return
}

if (-not $latest -or $latest -eq $loc) { Write-Host "   Up to date (v$loc)."; return }

Write-Host "   Updating v$loc -> v$latest ..."
$t = Join-Path $env:TEMP 'ptupd'
Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $t -Force | Out-Null
$z = Join-Path $t 'pt.zip'
try {
  Invoke-WebRequest -UseBasicParsing 'https://github.com/1215kkm/PowerTerminal/releases/latest/download/PowerTerminal.zip' -OutFile $z
  Expand-Archive $z $t -Force
  Copy-Item (Join-Path $t 'PowerTerminal\*') -Destination $root -Recurse -Force
  Write-Host "   Updated to v$latest."
} catch {
  Write-Host '   Update download failed - keeping current version.'
}
