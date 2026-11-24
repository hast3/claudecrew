@echo off
rem Starts the Crew tray icon (which starts Crew if it isn't running) and opens Crew in your browser.
rem No console window stays open; look for the Crew icon in the system tray.
start "" conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0crew-tray.ps1" -Open
