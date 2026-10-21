$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = Join-Path $taskRoot '.tools'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$cursorZip = Join-Path $runtimeDir 'cursor-package.zip'
$cursorVersion = '2026.09.10-fd3934a'
$cursorHash = 'CDF0B9B7C2F8892D4C2D2CCBF38226C831A0D56A043E2132D90F1AEFAC90B846'
if (-not (Test-Path -LiteralPath $cursorZip)) {
  & curl.exe --fail --location --output $cursorZip "https://downloads.cursor.com/lab/$cursorVersion/windows/x64/agent-cli-package.zip"
  if ($LASTEXITCODE -ne 0) { throw 'Cursor runtime download failed' }
}
if ((Get-FileHash -LiteralPath $cursorZip -Algorithm SHA256).Hash -ne $cursorHash) { throw 'Cursor runtime checksum mismatch' }
Expand-Archive -LiteralPath $cursorZip -DestinationPath (Join-Path $runtimeDir 'cursor') -Force

# Electron install.js validates the archive against checksums from the locked npm package.
Push-Location $taskRoot
try {
  & node node_modules/electron/install.js
  if ($LASTEXITCODE -ne 0) { throw 'Electron runtime preparation failed' }
} finally { Pop-Location }
Write-Output 'Windows runtimes ready: Cursor and Electron. Codex uses the local user installation.'
