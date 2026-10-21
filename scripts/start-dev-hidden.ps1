param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('user', 'admin')]
  [string]$Edition,
  [switch]$NoDialogs
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $repoRoot '.test-data\launcher'
$stamp = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$PID"
$launchLog = Join-Path $logRoot "$Edition-$stamp.log"
$stderrLog = $launchLog
$preparationLock = $null
$progressWindow = $null
$cancelStartup = $false
$closingProgress = $false
$stage = '准备启动'
$stageHint = ''
$stageStarted = Get-Date
$lastHeartbeat = Get-Date
$startupStarted = Get-Date
$startupPhase = 1
$displayedPhase = 0

function New-StartupLabel([string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [float]$Size = 9, [bool]$Bold = $false) {
  $label = New-Object System.Windows.Forms.Label
  $label.SetBounds($X, $Y, $Width, $Height)
  $label.Text = $Text
  $label.UseMnemonic = $false
  $label.BackColor = [System.Drawing.Color]::Transparent
  $label.ForeColor = $script:startupColors.Ink
  $style = if ($Bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', $Size, $style)
  return $label
}

function Show-StartupProgress {
  if ($NoDialogs) { return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $script:startupColors = @{
    Background = [System.Drawing.ColorTranslator]::FromHtml('#F5F7F5')
    Ink = [System.Drawing.ColorTranslator]::FromHtml('#243C30')
    Muted = [System.Drawing.ColorTranslator]::FromHtml('#5B6F61')
    Accent = [System.Drawing.ColorTranslator]::FromHtml('#287554')
    Active = [System.Drawing.ColorTranslator]::FromHtml('#E4F0E8')
    Border = [System.Drawing.ColorTranslator]::FromHtml('#DCE5DE')
    Pending = [System.Drawing.ColorTranslator]::FromHtml('#EBEFEC')
  }
  $script:progressWindow = New-Object System.Windows.Forms.Form
  $progressWindow.SuspendLayout()
  $progressWindow.Text = $(if ($Edition -eq 'user') { '启动团队工作台 · 用户端' } else { '启动团队工作台 · 管理端' })
  $progressWindow.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
  $progressWindow.AutoScaleMode = 'Dpi'
  $progressWindow.ClientSize = New-Object System.Drawing.Size(612, 390)
  $progressWindow.FormBorderStyle = 'FixedDialog'
  $progressWindow.StartPosition = 'CenterScreen'
  $progressWindow.MaximizeBox = $false
  $progressWindow.MinimizeBox = $false
  $progressWindow.ShowIcon = $false
  $progressWindow.BackColor = $startupColors.Background
  $progressWindow.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $heading = New-StartupLabel '正在启动工作台' 32 26 408 34 18 $true
  $subtitle = New-StartupLabel '准备好后，将自动进入工作空间。' 34 67 420 24 9
  $subtitle.ForeColor = $startupColors.Muted
  $editionBadge = New-StartupLabel $(if ($Edition -eq 'user') { '用户端' } else { '管理端' }) 490 34 90 28 9 $true
  $editionBadge.TextAlign = 'MiddleCenter'
  $editionBadge.BackColor = $startupColors.Active
  $editionBadge.ForeColor = $startupColors.Accent

  # Three real phases, not an estimated percentage. Optional installs stay in phase 1.
  $script:phaseLabels = @()
  $phaseNames = @('检查环境', '构建工作台', '打开应用')
  for ($index = 0; $index -lt $phaseNames.Count; $index++) {
    $label = New-StartupLabel '' (32 + 188 * $index) 110 172 40 10 $true
    $label.Tag = $phaseNames[$index]
    $label.TextAlign = 'MiddleCenter'
    $script:phaseLabels += $label
    $progressWindow.Controls.Add($label)
  }

  $card = New-Object System.Windows.Forms.Panel
  $card.SetBounds(32, 172, 548, 132)
  $card.BackColor = [System.Drawing.Color]::White
  $accent = New-Object System.Windows.Forms.Panel
  $accent.SetBounds(0, 0, 3, 132)
  $accent.BackColor = $startupColors.Accent
  $script:stageLabel = New-StartupLabel '' 22 18 390 30 13 $true
  $stageLabel.AutoEllipsis = $true
  $script:elapsedLabel = New-StartupLabel '' 412 22 112 22 9
  $elapsedLabel.TextAlign = 'TopRight'
  $elapsedLabel.ForeColor = $startupColors.Muted
  $script:hintLabel = New-StartupLabel '' 22 57 502 47 9
  $hintLabel.ForeColor = $startupColors.Muted
  $hintLabel.AutoEllipsis = $true
  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.SetBounds(22, 112, 502, 4)
  $bar.Style = 'Marquee'
  $bar.MarqueeAnimationSpeed = 25
  $bar.AccessibleName = '当前步骤正在进行'
  $card.Controls.AddRange(@($accent, $stageLabel, $elapsedLabel, $hintLabel, $bar))

  $script:totalElapsedLabel = New-StartupLabel '' 34 334 235 24 9
  $totalElapsedLabel.ForeColor = $startupColors.Muted
  $logsButton = New-Object System.Windows.Forms.Button
  $logsButton.Text = '查看日志'
  $logsButton.SetBounds(366, 327, 98, 36)
  $logsButton.FlatStyle = 'Flat'
  $logsButton.UseVisualStyleBackColor = $false
  $logsButton.FlatAppearance.BorderSize = 0
  $logsButton.FlatAppearance.MouseOverBackColor = $startupColors.Active
  $logsButton.FlatAppearance.MouseDownBackColor = $startupColors.Border
  $logsButton.BackColor = $startupColors.Background
  $logsButton.ForeColor = $startupColors.Accent
  $logsButton.Cursor = [System.Windows.Forms.Cursors]::Hand
  $logsButton.TabIndex = 0
  $logsButton.Add_Click({ Start-Process -FilePath "$env:SystemRoot\System32\notepad.exe" -ArgumentList @('"' + $launchLog + '"') })
  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Text = '取消启动'
  $cancelButton.SetBounds(476, 327, 104, 36)
  $cancelButton.FlatStyle = 'Flat'
  $cancelButton.UseVisualStyleBackColor = $false
  $cancelButton.FlatAppearance.BorderColor = $startupColors.Border
  $cancelButton.FlatAppearance.MouseOverBackColor = $startupColors.Pending
  $cancelButton.FlatAppearance.MouseDownBackColor = $startupColors.Border
  $cancelButton.BackColor = [System.Drawing.Color]::White
  $cancelButton.ForeColor = $startupColors.Ink
  $cancelButton.Cursor = [System.Windows.Forms.Cursors]::Hand
  $cancelButton.TabIndex = 1
  $cancelButton.Add_Click({ $script:cancelStartup = $true })
  $progressWindow.CancelButton = $cancelButton
  $progressWindow.Add_FormClosing({ param($sender, $eventArgs) if (-not $script:closingProgress) { $script:cancelStartup = $true; $eventArgs.Cancel = $true } })
  $progressWindow.Controls.AddRange(@($heading, $subtitle, $editionBadge, $card, $totalElapsedLabel, $logsButton, $cancelButton))
  $progressWindow.ResumeLayout($true)
  Update-StartupProgress
  $progressWindow.Show()
}

function Close-StartupProgress {
  if ($progressWindow) { $script:closingProgress = $true; $progressWindow.Close(); $progressWindow.Dispose(); $script:progressWindow = $null }
}

function Update-StartupProgress {
  if ($progressWindow) {
    $stageLabel.Text = $stage
    $hintLabel.Text = $stageHint
    $elapsedLabel.Text = '本步 ' + [int]((Get-Date) - $stageStarted).TotalSeconds + ' 秒'
    $elapsed = (Get-Date) - $startupStarted
    $totalElapsedLabel.Text = '启动用时  {0:00}:{1:00}' -f [int][Math]::Floor($elapsed.TotalMinutes), $elapsed.Seconds
    if ($displayedPhase -ne $startupPhase) {
      for ($index = 0; $index -lt $phaseLabels.Count; $index++) {
        $label = $phaseLabels[$index]
        if (($index + 1) -lt $startupPhase) {
          $label.Text = [char]0x2713 + '  ' + $label.Tag
          $label.BackColor = $startupColors.Background
          $label.ForeColor = $startupColors.Accent
          $label.AccessibleName = $label.Tag + '：已完成'
        } elseif (($index + 1) -eq $startupPhase) {
          $label.Text = ($index + 1).ToString('00') + '  ' + $label.Tag
          $label.BackColor = $startupColors.Active
          $label.ForeColor = $startupColors.Accent
          $label.AccessibleName = $label.Tag + '：进行中'
        } else {
          $label.Text = ($index + 1).ToString('00') + '  ' + $label.Tag
          $label.BackColor = $startupColors.Pending
          $label.ForeColor = $startupColors.Muted
          $label.AccessibleName = $label.Tag + '：待进行'
        }
      }
      $script:displayedPhase = $startupPhase
    }
    [System.Windows.Forms.Application]::DoEvents()
  }
  if ($cancelStartup) { throw [System.OperationCanceledException]::new('已取消启动') }
  if (((Get-Date) - $lastHeartbeat).TotalSeconds -ge 15) {
    Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Waiting: $stage / $([int]((Get-Date) - $stageStarted).TotalSeconds)s"
    $script:lastHeartbeat = Get-Date
  }
}

function Set-StartupStage([string]$Name, [string]$Hint, [int]$Phase = 1) {
  $script:stage = $Name; $script:stageHint = $Hint; $script:stageStarted = Get-Date; $script:lastHeartbeat = Get-Date
  $script:startupPhase = $Phase
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Step: $Name / $Hint"
  if ($NoDialogs) { [Console]::Out.WriteLine($Name + '：' + $Hint) }
  Update-StartupProgress
}


function Invoke-NpmStep([string]$Step, [string[]]$Arguments) {
  $stdoutLog = Join-Path $logRoot "$Edition-$stamp-$Step.log"
  $script:stderrLog = Join-Path $logRoot "$Edition-$stamp-$Step-error.log"
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "npm $($Arguments -join ' ')"
  if ($Step -eq 'install') {
    Set-StartupStage '正在安装依赖' ($script:dependencyReason + ' 优先使用 npm 缓存；最多等待 10 分钟，可随时取消。')
  } else {
    Set-StartupStage '正在构建工作台' '正在准备当前版本，通常几十秒内完成。' 2
  }
  $limit = if ($Step -eq 'install') { 600 } else { 180 }
  $code = Invoke-StartupProcess -File $npm -Arguments $Arguments -Directory $repoRoot -Output $stdoutLog -Errors $script:stderrLog -TimeoutSeconds $limit -TimeoutMessage ($stage + '超时，请检查详细日志后重试。') -Pulse { Update-StartupProgress }
  if ($code -ne 0) {
    if ($Step -eq 'install') {
      $details = Get-Content -LiteralPath $script:stderrLog -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($details -match '\b(EPERM|EBUSY|EACCES)\b') {
        throw '依赖安装失败：文件被其他进程占用或没有写入权限。请保留正在运行的任务，并根据详细日志处理。'
      }
      throw '依赖安装失败。请根据详细日志检查下载、磁盘空间或文件权限，然后重新双击启动入口。'
    }
    throw '当前代码构建失败，未启动旧版本。请将启动日志交给项目维护者处理。'
  }
}

function Invoke-RuntimeProbe([string]$File, [string[]]$Arguments, [string]$Id) {
  $output = Join-Path $logRoot "$Edition-$stamp-probe-$Id.out"
  $errors = Join-Path $logRoot "$Edition-$stamp-probe-$Id.err"
  $code = Invoke-StartupProcess -File $File -Arguments $Arguments -Directory $repoRoot -Output $output -Errors $errors -TimeoutSeconds 10 -TimeoutMessage '运行时自检超时' -Pulse { Update-StartupProgress }
  if ($code -ne 0) { throw '运行时自检失败' }
  return (Get-Content -LiteralPath $output -Raw)
}

function Test-ElectronRuntime {
  $packageRoot = Join-Path $repoRoot 'node_modules\electron'
  try {
    $package = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json
    return (Test-Path -LiteralPath (Join-Path $packageRoot 'dist\electron.exe') -PathType Leaf) -and
      ((Get-Content -LiteralPath (Join-Path $packageRoot 'path.txt') -Raw).Trim() -eq 'electron.exe') -and
      ((Get-Content -LiteralPath (Join-Path $packageRoot 'dist\version') -Raw).Trim().TrimStart('v') -eq $package.version)
  } catch { return $false }
}

function Invoke-ElectronCacheStep([string]$Action) {
  $output = Join-Path $logRoot "$Edition-$stamp-electron-cache-$Action.out"
  $errors = Join-Path $logRoot "$Edition-$stamp-electron-cache-$Action.err"
  try {
    $code = Invoke-StartupProcess -File $nodePath -Arguments @('"scripts\electron-runtime-cache.mjs"', $Action) -Directory $repoRoot -Output $output -Errors $errors -TimeoutSeconds 180 -TimeoutMessage 'Electron 本地缓存处理超时' -Pulse { Update-StartupProgress }
    if ($code -ne 0) { throw '缓存处理未完成' }
    $result = Get-Content -LiteralPath $output -Raw -Encoding UTF8 | ConvertFrom-Json
    Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Electron cache $Action`: $($result.status) / $($result.version)"
    return $result.status -eq 'restored'
  } catch {
    Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Electron cache $Action failed: $($_.Exception.Message)"
    return $false
  }
}

function Install-ElectronRuntime {
  if (Test-ElectronRuntime) {
    Set-StartupStage '正在保留桌面运行环境' '首次建立本地缓存后，重新安装依赖也可复用。'
    [void](Invoke-ElectronCacheStep 'save')
    return
  }
  Set-StartupStage '正在复用桌面运行环境' '先查找本机已保存的 Electron 运行文件。'
  if ((Invoke-ElectronCacheStep 'restore') -and (Test-ElectronRuntime)) { return }
  $stdoutLog = Join-Path $logRoot "$Edition-$stamp-electron.log"
  $script:stderrLog = Join-Path $logRoot "$Edition-$stamp-electron-error.log"
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value 'Preparing Electron binary: node node_modules/electron/install.js'
  # Electron 44 downloads on first use, not during npm ci. Use the installed package's
  # own installer so its pinned version, checksum verification and cache are retained.
  $installArguments = @()
  if ($runtime.systemCa) { $installArguments += '--use-system-ca' }
  $installArguments += '"node_modules\electron\install.js"'
  Set-StartupStage '正在下载桌面运行环境' '需要访问 Electron 下载源；最多等待 10 分钟，可随时取消。'
  $originalMirror = $env:ELECTRON_MIRROR
  if (-not $originalMirror) {
    # Electron's documented China mirror serves the official versioned ZIP;
    # install.js still verifies it against the checksums bundled with Electron.
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Electron mirror: $env:ELECTRON_MIRROR"
  }
  try {
    $code = Invoke-StartupProcess -File $nodePath -Arguments $installArguments -Directory $repoRoot -Output $stdoutLog -Errors $script:stderrLog -TimeoutSeconds 600 -TimeoutMessage 'Electron 下载超时，请检查本机下载网络或代理配置。' -Pulse { Update-StartupProgress }
  } finally {
    if (-not $originalMirror) { Remove-Item Env:ELECTRON_MIRROR -ErrorAction SilentlyContinue }
  }
  if ($code -ne 0 -or -not (Test-ElectronRuntime)) {
    throw 'Electron 运行文件准备失败。请查看详细日志，检查下载网络或文件权限后重新启动；已安装的 npm 依赖会保留。'
  }
  Set-StartupStage '正在保留桌面运行环境' '缓存当前版本，供后续依赖重装时复用。'
  [void](Invoke-ElectronCacheStep 'save')
}

try {
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Set-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Edition: $Edition`r`nRepository: $repoRoot"
  . (Join-Path $PSScriptRoot 'startup-process.ps1')
  Show-StartupProgress
  Set-StartupStage '正在检查 Node.js 和 npm' '复用已安装的运行环境；每个候选最多检测 10 秒。'
  $originalPath = $env:PATH
  $candidates = @()
  $portableRoot = Join-Path $repoRoot '.tools'
  if (Test-Path -LiteralPath $portableRoot) {
    $candidates += @(Get-ChildItem -LiteralPath $portableRoot -Directory -Filter 'node-v*-win-x64' |
      Where-Object { $_.Name -match '^node-v(\d+\.\d+\.\d+)-win-x64$' } |
      Sort-Object { [version]($_.Name -replace '^node-v|\-win-x64$', '') } -Descending |
      ForEach-Object { @{ Node = (Join-Path $_.FullName 'node.exe'); Npm = (Join-Path $_.FullName 'npm.cmd') } })
  }
  $systemNpm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  foreach ($nodeCommand in @(Get-Command 'node.exe' -All -ErrorAction SilentlyContinue)) {
    $adjacentNpm = Join-Path (Split-Path -Parent $nodeCommand.Source) 'npm.cmd'
    $candidates += @{ Node = $nodeCommand.Source; Npm = $(if ($systemNpm) { $systemNpm.Source } elseif (Test-Path -LiteralPath $adjacentNpm) { $adjacentNpm } else { '' }) }
  }
  $pathConfig = Join-Path $repoRoot '.tools/node-path.txt'
  $customDirectory = $env:WORKBENCH_NODE_DIR
  if (-not $customDirectory -and (Test-Path -LiteralPath $pathConfig)) { $customDirectory = (Get-Content -LiteralPath $pathConfig -Raw).Trim() }
  if ($customDirectory) { $candidates += @{ Node = (Join-Path $customDirectory 'node.exe'); Npm = (Join-Path $customDirectory 'npm.cmd') } }
  $selected = $false
  $probeNumber = 0
  while (-not $selected) {
    foreach ($candidate in $candidates) {
      $probeNumber++
      try {
        if (-not $candidate.Npm -or -not (Test-Path -LiteralPath $candidate.Node -PathType Leaf) -or -not (Test-Path -LiteralPath $candidate.Npm -PathType Leaf)) { throw 'node.exe 或 npm.cmd 不完整' }
        $env:PATH = (Split-Path -Parent $candidate.Node) + ';' + $originalPath
        $info = Invoke-RuntimeProbe $candidate.Node @('-p', 'JSON.stringify({major:parseInt(process.versions.node),version:process.versions.node,arch:process.arch,systemCa:process.allowedNodeEnvironmentFlags.has(\"--use-system-ca\")})') "$probeNumber-node"
        $runtime = $info | ConvertFrom-Json
        if ([version]$runtime.version -lt [version]'22.12.0' -or $runtime.arch -ne 'x64') { throw '需要 x64 Node.js 22.12.0 或更高版本' }
        $npmVersion = Invoke-RuntimeProbe $candidate.Npm @('--version') "$probeNumber-npm"
        if ($npmVersion.Trim() -notmatch '^\d+\.\d+\.\d+') { throw 'npm 无法正常运行' }
        $nodePath = $candidate.Node; $npm = $candidate.Npm; $selected = $true
        Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Node: $nodePath`r`nNode version: $($runtime.version) / $($runtime.arch)`r`nNpm: $npm"
        break
      } catch [System.OperationCanceledException] { throw } catch {
        Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Skipped: $($candidate.Node) / $($_.Exception.Message)"
        $env:PATH = $originalPath
      }
    }
    if ($selected) { break }
    if ($NoDialogs) { throw '请先安装 64 位 Node.js 22.12.0 或更高版本，或配置包含 node.exe 和 npm.cmd 的便携目录。所有候选均不可用，详见启动日志。' }
    Add-Type -AssemblyName System.Windows.Forms
    $choice = [System.Windows.Forms.MessageBox]::Show('未找到可运行的 Node.js 和 npm。是否选择已安装或已解压的离线 Node 目录？需要 x64 Node.js 22.12.0 或更高版本。', '准备启动环境', 'YesNo', 'Question')
    if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { throw '尚未配置可用的 Node.js 和 npm。' }
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = '选择同时包含 node.exe 和 npm.cmd 的目录'
    try {
      if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw '已取消选择运行环境。' }
      $customDirectory = $picker.SelectedPath
    } finally { $picker.Dispose() }
    New-Item -ItemType Directory -Force -Path $portableRoot | Out-Null
    Set-Content -LiteralPath $pathConfig -Encoding UTF8 -Value $customDirectory
    $candidates = @(@{ Node = (Join-Path $customDirectory 'node.exe'); Npm = (Join-Path $customDirectory 'npm.cmd') })
  }

  # Both editions share node_modules and dist; serialize preparation, not application lifetimes.
  Set-StartupStage '正在等待启动准备' '其他入口正在安装或构建时会排队；可取消后稍后重试。'
  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  while (-not $preparationLock) {
    Update-StartupProgress
    try {
      $preparationLock = [System.IO.File]::Open((Join-Path $logRoot 'prepare.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { throw '另一个启动入口仍在准备环境，请稍后重试。' }
      Start-Sleep -Milliseconds 200
    }
  }

  $dependencyStamp = Join-Path $logRoot 'dependencies.txt'
  Set-StartupStage '正在检查项目依赖' '核对依赖版本和安装记录；已安装的依赖可以直接复用。'
  $dependencyOutput = Join-Path $logRoot "$Edition-$stamp-dependencies.out"
  $script:stderrLog = Join-Path $logRoot "$Edition-$stamp-dependencies-error.log"
  $code = Invoke-StartupProcess -File $nodePath -Arguments @('"scripts\startup-dependencies.mjs"') -Directory $repoRoot -Output $dependencyOutput -Errors $script:stderrLog -TimeoutSeconds 30 -TimeoutMessage '依赖检查超时，请检查详细日志。' -Pulse { Update-StartupProgress }
  if ($code -ne 0) { throw '依赖检查失败，请查看详细日志并确认源码文件完整。' }
  $dependencyCheck = Get-Content -LiteralPath $dependencyOutput -Raw -Encoding UTF8 | ConvertFrom-Json
  $script:dependencyReason = $dependencyCheck.reason
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value ("Dependencies: " + $dependencyCheck.reason)
  $electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
  if ($dependencyCheck.install) {
    if (Test-ElectronRuntime) {
      Set-StartupStage '正在保留桌面运行环境' '依赖重装前保存已安装的 Electron 运行文件。'
      [void](Invoke-ElectronCacheStep 'save')
    }
    # Leave a retry marker if npm fails or startup is cancelled partway through.
    Set-Content -LiteralPath $dependencyStamp -Encoding ASCII -Value '{"pending":true}'
    # npm install honors the existing lockfile while preserving matching packages.
    # npm ci clears node_modules first and can unlink DLLs used by another window
    # or a detached Codex backend, damaging an otherwise usable installation.
    Invoke-NpmStep 'install' @('install', '--include=dev', '--include=optional', '--no-audit', '--no-fund')
  }
  Set-Content -LiteralPath $dependencyStamp -Encoding ASCII -Value $dependencyCheck.stamp

  Set-StartupStage '正在检查桌面运行环境' '已有完整运行文件时会直接复用。'
  Install-ElectronRuntime
  Invoke-NpmStep 'build' @('run', 'build')

  $entry = Join-Path $repoRoot "dist\$Edition"
  if (-not (Test-Path -LiteralPath (Join-Path $entry 'main.cjs'))) {
    throw '构建未生成所选版本的运行文件，请检查启动日志。'
  }

  Set-StartupStage '正在打开工作台' '一切就绪，马上进入工作空间。' 3
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Entry: $entry"
  $desktopOutput = Join-Path $logRoot "$Edition-$stamp-open.log"
  $script:stderrLog = Join-Path $logRoot "$Edition-$stamp-open-error.log"
  # Detach Electron and disconnect inherited console handles before this launcher exits.
  $code = Invoke-StartupProcess -File $nodePath -Arguments @('"scripts\launch-desktop.mjs"', $Edition) -Directory $repoRoot -Output $desktopOutput -Errors $script:stderrLog -TimeoutSeconds 15 -TimeoutMessage '打开工作台超时，请查看启动日志。' -Pulse { Update-StartupProgress }
  if ($code -ne 0) { throw '无法打开工作台，请查看详细日志。' }
  Get-Content -LiteralPath $desktopOutput -Encoding UTF8 | Add-Content -LiteralPath $launchLog -Encoding UTF8
} catch {
  Close-StartupProgress
  if ($_.Exception -is [System.OperationCanceledException]) {
    Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value 'Cancelled by user.'
    exit 2
  }
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value ("Failed: $stage / " + $_.Exception.Message) -ErrorAction SilentlyContinue
  # An error dialog may stay open indefinitely; it must not hold the other edition's lock.
  if ($preparationLock) { $preparationLock.Dispose(); $preparationLock = $null }
  $message = "工作台未能启动。`r`n阶段：$stage`r`n$($_.Exception.Message)`r`n`r`n启动日志：$launchLog`r`n详细日志：$stderrLog"
  if ($NoDialogs) {
    [Console]::Error.WriteLine($message)
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $message,
      '团队工作台',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  }
  exit 1
} finally {
  Close-StartupProgress
  if ($preparationLock) { $preparationLock.Dispose() }
}
