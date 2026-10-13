@echo off
setlocal
cd /d "%~dp0"
start "" powershell.exe -NoLogo -NoProfile -STA -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start-cursor-native-beta.ps1" stop
exit /b 0
