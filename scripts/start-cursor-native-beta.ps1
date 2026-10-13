param(
  [ValidateSet('launch', 'stop', 'check')][string]$Mode = 'launch',
  [switch]$NoDialogs
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$progressWindow = $null
$stageLabel = $null
$launchLog = $null
$failed = $false

function Set-BetaStage([string]$Text) {
  if ($launchLog) { Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value $Text }
  if ($progressWindow) {
    $stageLabel.Text = $Text
    [System.Windows.Forms.Application]::DoEvents()
  } elseif ($NoDialogs) { [Console]::Out.WriteLine($Text) }
}

function Invoke-BetaNode([string]$Script, [string[]]$Arguments) {
  # Read stderr as process output, not as PowerShell errors. Node's SQLite
  # warning must not turn a successful check into a launch failure in PS 5.1.
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = (Get-Command node.exe -ErrorAction Stop).Source
  $info.Arguments = '"' + $Script + '"'
  foreach ($argument in $Arguments) { $info.Arguments += ' "' + $argument + '"' }
  $info.WorkingDirectory = $repoRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw '启动程序未能运行。' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    while (-not $process.WaitForExit(100)) {
      if ($progressWindow) { [System.Windows.Forms.Application]::DoEvents() }
    }
    $output = $stdout.GetAwaiter().GetResult()
    $errorOutput = $stderr.GetAwaiter().GetResult()
    if ($launchLog) {
      Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value $output
      Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value $errorOutput
    }
    if ($process.ExitCode -ne 0) {
      $message = $errorOutput -replace '(?m)^\(node:\d+\) ExperimentalWarning:.*\r?\n?', '' -replace '(?m)^\(Use .*\r?\n?', ''
      if (-not $message.Trim()) { $message = $output }
      if (-not $message.Trim()) { $message = '启动失败，请查看启动日志。' }
      throw $message.Trim()
    }
    if ($NoDialogs -and $output.Trim()) { [Console]::Out.WriteLine($output.Trim()) }
  } finally { $process.Dispose() }
}

try {
  Set-Location -LiteralPath $repoRoot
  $logRoot = Join-Path $repoRoot '.test-data\cursor-native-beta\logs'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $launchLog = Join-Path $logRoot ("$Mode-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$PID.log")
  if (-not $NoDialogs -and $Mode -eq 'launch') {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $progressWindow = New-Object System.Windows.Forms.Form
    $progressWindow.Text = '启动 Cursor 原生同步 Beta'
    $progressWindow.StartPosition = 'CenterScreen'
    $progressWindow.ClientSize = New-Object System.Drawing.Size(420, 130)
    $progressWindow.FormBorderStyle = 'FixedDialog'
    $progressWindow.ControlBox = $false
    $progressWindow.ShowIcon = $false
    $stageLabel = New-Object System.Windows.Forms.Label
    $stageLabel.Text = '正在准备启动…'
    $stageLabel.SetBounds(24, 24, 372, 44)
    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.SetBounds(24, 82, 372, 12)
    $bar.Style = 'Marquee'
    $progressWindow.Controls.AddRange(@($stageLabel, $bar))
    $progressWindow.Show()
    [System.Windows.Forms.Application]::DoEvents()
  }
  $bundle = Join-Path $repoRoot '.test-data\cursor-native-beta\launcher.cjs'
  Set-BetaStage '正在检查联调启动入口…'
  if ($Mode -eq 'launch') {
    Set-BetaStage '正在构建工作台界面…'
    Invoke-BetaNode (Join-Path $PSScriptRoot 'build.mjs') @()
  }
  Invoke-BetaNode (Join-Path $PSScriptRoot 'build-cursor-native-beta.mjs') @()
  Set-BetaStage $(if ($Mode -eq 'launch') { '正在准备并打开两个窗口，可能需要几十秒…' } elseif ($Mode -eq 'stop') { '正在停止联调后台…' } else { '正在检查桌面版…' })
  Invoke-BetaNode $bundle @($Mode, $repoRoot)
} catch {
  $failed = $true
  if ($launchLog) { Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value $_.Exception.Message }
  if ($progressWindow) { $progressWindow.Close(); $progressWindow.Dispose(); $progressWindow = $null }
  if ($NoDialogs) { [Console]::Error.WriteLine($_.Exception.Message) } else {
    Add-Type -AssemblyName System.Windows.Forms
    $message = $_.Exception.Message
    if ($launchLog) { $message += "`n`n启动日志：$launchLog" }
    [System.Windows.Forms.MessageBox]::Show($message, 'Cursor 原生同步 Beta', 'OK', 'Information') | Out-Null
  }
} finally {
  if ($progressWindow) { $progressWindow.Close(); $progressWindow.Dispose() }
}
if ($failed) { exit 1 }
