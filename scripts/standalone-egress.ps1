param(
  [ValidateSet('Install', 'Run', 'Start', 'Stop', 'Status', 'Uninstall')]
  [string]$Action = 'Status',
  [string]$AdminDataDirectory = ''
)
$ErrorActionPreference = 'Stop'
$taskName = 'TeamAgentStandaloneEgress'
$installRoot = Join-Path $env:ProgramData 'TeamAgentStandaloneEgress'
$taskScript = Join-Path $installRoot 'standalone-egress.ps1'
$stateFile = Join-Path $installRoot 'state.bin'
$statusFile = Join-Path $installRoot 'status.json'
Add-Type -AssemblyName System.Security

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run this script in an elevated PowerShell window (Run as administrator).'
  }
}

function Invoke-CapturedProcess([string]$Executable, [string]$Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Executable; $info.Arguments = $Arguments
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  # Electron must run its export entry, never inherit an unrelated Node mode.
  $info.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $child = [Diagnostics.Process]::Start($info)
  try {
    $output = $child.StandardOutput.ReadToEndAsync()
    $errors = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(60000)) { $child.Kill(); throw 'Setup helper timed out.' }
    if ($child.ExitCode -ne 0) { throw 'Setup helper failed. Close the admin app and use its original Windows account with a configured, enabled relay.' }
    return $output.GetAwaiter().GetResult()
  } finally { $child.Dispose() }
}

function Stop-StandaloneTask {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) { return }
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  if ($task.State -eq 'Running') {
    [IO.File]::WriteAllText((Join-Path $installRoot 'stop.request'), 'stop')
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 250
      $task = Get-ScheduledTask -TaskName $taskName
    } while ($task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
    if ($task.State -eq 'Running') { throw 'Relay did not stop yet. Keep the ownership marker and retry Stop before Uninstall.' }
  }
}

if ($Action -eq 'Run') {
  # SYSTEM task: no desktop, no user login, no files decrypted onto disk.
  $mutex = [Threading.Mutex]::new($false, 'Global\TeamAgentStandaloneEgress')
  $owned = $false; $child = $null
  try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($stateFile), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $installRoot 'node.exe'
    $info.Arguments = '"' + (Join-Path $installRoot 'relay.cjs') + '"'
    $info.WorkingDirectory = $installRoot
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.EnvironmentVariables.Remove('NODE_OPTIONS')
    $info.EnvironmentVariables.Remove('NODE_TLS_REJECT_UNAUTHORIZED')
    $child = [Diagnostics.Process]::Start($info)
    $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $child.StandardInput.Close(); [Array]::Clear($bytes, 0, $bytes.Length)
    $child.WaitForExit(); $code = $child.ExitCode
    exit $code
  } catch {
    @{ running = $false; error = 'Standalone relay failed to start. Check installation and port availability.'; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
    exit 1
  } finally {
    if ($child) { if (-not $child.HasExited) { $child.Kill() }; $child.Dispose() }
    if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose()
  }
}

Assert-Administrator
if ($Action -eq 'Install') {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Already installed. Use Status / Start / Stop, or Uninstall before replacing the configuration.' }
  if (-not $AdminDataDirectory) { $AdminDataDirectory = if ($env:WORKBENCH_ADMIN_DATA_DIR) { $env:WORKBENCH_ADMIN_DATA_DIR } else { Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'TeamAgentAdmin' } }
  $AdminDataDirectory = (Resolve-Path -LiteralPath $AdminDataDirectory).Path
  $marker = Join-Path $AdminDataDirectory 'standalone-egress.json'
  if (Test-Path -LiteralPath $marker) { throw 'Standalone ownership marker already exists. Run Uninstall using its installed script first.' }
  $repository = Split-Path -Parent $PSScriptRoot
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $major = [int](((& $node --version).TrimStart('v') -split '\.')[0])
  if ($major -lt 22) { throw 'Node.js 22 or newer is required for installation.' }
  $bundle = Join-Path $repository 'dist\standalone-egress'
  & $node (Join-Path $repository 'scripts\build-standalone-egress.mjs') $bundle
  if ($LASTEXITCODE -ne 0) { throw 'Standalone relay build failed.' }
  $electron = Join-Path $repository 'node_modules\electron\dist\electron.exe'
  $stateJson = Invoke-CapturedProcess $electron ('"' + (Join-Path $bundle 'export.cjs') + '" --admin-data "' + $AdminDataDirectory + '"')
  try { $state = $stateJson | ConvertFrom-Json } catch { throw 'Could not read exported identity. No access code was changed.' }
  if ($state.version -ne 1 -or -not $state.config.enabled -or -not $state.secret.accessCode) { throw 'No usable existing relay identity. No new access code will be generated.' }
  if (Get-NetTCPConnection -State Listen -LocalPort $state.config.listenPort -ErrorAction SilentlyContinue) { throw 'Relay port is occupied. Close the admin app or existing relay before installation.' }
  if ($state.reverse) {
    $password = Read-Host ('SSH password for ' + $state.reverse.username + '@' + $state.reverse.host + ' (existing reverse tunnel)') -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    try { $state.reverse | Add-Member -NotePropertyName password -NotePropertyValue ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) -Force }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if (-not $state.reverse.password) { throw 'Reverse tunnel password is required; published port will not be changed.' }
  }
  # Protect code and machine-scoped DPAPI data from non-administrator accounts.
  if (Test-Path -LiteralPath $installRoot) {
    if ((Get-Item -LiteralPath $installRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directory must not be a reparse point.' }
  } else { New-Item -ItemType Directory -Path $installRoot | Out-Null }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = [Security.Principal.SecurityIdentifier]::new($sid)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  Set-Acl -LiteralPath $installRoot -AclObject $acl
  foreach ($file in @('relay.cjs', 'standalone-egress.ps1')) { Copy-Item -LiteralPath (Join-Path $bundle $file) -Destination (Join-Path $installRoot $file) -Force }
  Copy-Item -LiteralPath $node -Destination (Join-Path $installRoot 'node.exe') -Force
  $plain = [Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 20 -Compress))
  try { [IO.File]::WriteAllBytes($stateFile, [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)) }
  finally { [Array]::Clear($plain, 0, $plain.Length); $state = $null; $stateJson = $null }
  @{ adminDataDirectory = $AdminDataDirectory; taskName = $taskName } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'installation.json') -Encoding UTF8
  $registered = $false
  try {
    @{ taskName = $taskName; installRoot = $installRoot } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
    $command = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskScript + '" -Action Run') -WorkingDirectory $installRoot
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $command -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $principal -Description 'Team Agent standalone relay; preserves the existing invitation and TLS identity.' | Out-Null
    $registered = $true
    if (Test-Path -LiteralPath (Join-Path $installRoot 'stop.request')) { Remove-Item -LiteralPath (Join-Path $installRoot 'stop.request') -Force }
    Start-ScheduledTask -TaskName $taskName
  } catch {
    if ($registered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    Remove-Item -LiteralPath $marker -Force
    throw
  }
  Write-Output 'Installed and start requested. Existing access code, TLS certificate and ports are unchanged. Use -Action Status to check readiness.'
} elseif ($Action -eq 'Start') {
  if (Test-Path -LiteralPath (Join-Path $installRoot 'stop.request')) { Remove-Item -LiteralPath (Join-Path $installRoot 'stop.request') -Force }
  Enable-ScheduledTask -TaskName $taskName | Out-Null
  Start-ScheduledTask -TaskName $taskName
} elseif ($Action -eq 'Stop') {
  Stop-StandaloneTask
  Write-Output 'Stopped; automatic startup disabled until Start is requested.'
} elseif ($Action -eq 'Status') {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Output 'Not installed.'; exit 0 }
  $task | Select-Object TaskName, State
  Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult
  if (Test-Path -LiteralPath $statusFile) {
    $status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $fresh = $task.State -eq 'Running' -and ([DateTime]::UtcNow - [DateTime]::Parse($status.updatedAt).ToUniversalTime()).TotalSeconds -lt 20
    $status | Add-Member -NotePropertyName stale -NotePropertyValue (-not $fresh) -Force
    if (-not $fresh) { $status.running = $false }
    $status
  }
} elseif ($Action -eq 'Uninstall') {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) { Stop-StandaloneTask; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  $metadata = Get-Content -LiteralPath (Join-Path $installRoot 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $marker = Join-Path $metadata.adminDataDirectory 'standalone-egress.json'
  if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
  # Preserve original admin identity; remove only this installation's encrypted copy.
  if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force }
  Write-Output 'Startup task removed. The admin app can own the original relay again; access code unchanged.'
}
