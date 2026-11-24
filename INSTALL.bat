@echo off
rem Claude Crew installer. Double-click this file. It asks a few questions and sets everything up.
title Claude Crew installer
cd /d "%~dp0"
if not exist "%~dp0install.ps1" (
  echo.
  echo The installer can't see its other files.
  echo Please close this window, right-click the downloaded zip, choose "Extract All",
  echo open the new folder and double-click INSTALL.bat there.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
echo (You can close this window now.)
pause >nul
